import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { mapLimit } from './util.ts';
import { styleRules } from './context.ts';
import type { BookHandle } from '../canon/store.ts';

export interface ColdReadResult {
  persona: string;
  willContinue: boolean;
  /** 从哪一句开始想划走（必须引原文；如果全篇没划走，填 null） */
  dropPoint: string | null;
  /** 哪一句让他决定继续 */
  hookedBy: string | null;
  wantNext: string;
  verdict: string;
}

interface Persona {
  id: string;
  name: string;
  bio: string;
}

const PERSONAS: Persona[] = [
  {
    id: 'veteran',
    name: '老书虫',
    bio: `三十四岁，看了十五年网文，至少三千本。仙侠、武侠、玄幻全都读过，套路免疫。
他现在最恨三件事：降智、注水、装神弄鬼。一个词用得不对他就出戏。
他不在乎文笔好不好。他在乎「这个作者有没有把我当傻子」。
他不会给面子。不好看就是不好看。`,
  },
  {
    id: 'commuter',
    name: '通勤读者',
    bio: `二十九岁，上班族。每天地铁上读一章，一章大概看三分钟。
手机屏幕小，光线晃。他常常读到一半就切出去看消息，然后就不回来了。
他记不住人名，记不住设定。他只记得「刚才那个地方挺带劲」。
如果前两屏没有抓住他，他会直接退出，连书名都不记得。`,
  },
  {
    id: 'puzzle',
    name: '解谜读者',
    bio: `二十六岁，喜欢悬疑和推理。他为「我想知道答案」而读书，不为打斗。
他极其讨厌无意义的战斗描写，会整段跳过。
他会主动猜下一步，并且因为猜对而得意，因为猜得太容易而失望。
他最烦的是：作者故意藏着不说，但没有任何线索支撑，纯靠拖延。`,
  },
];

const CONTRACT = `输出格式（只输出 JSON）：

{
  "willContinue": true 或 false,
  "dropPoint": "从正文里逐字复制让你想划走的那一句；如果全篇没有，填 null",
  "hookedBy": "从正文里逐字复制让你决定继续读的那一句；如果没有，填 null",
  "wantNext": "读完这章，你最想看下一章发生什么。一句话。",
  "verdict": "像豆瓣短评那样，一句话，不加标点前的礼貌用语"
}

注意：
- 你不知道后面会发生什么。你只读了这一章。
- 不许说「总体来说」「瑕不掩瑜」这类和事佬话。
- willContinue 只有在你真的想看下一章时才填 true。礼貌不算。`;

function system(p: Persona): string {
  return `你就是这个人，不是扮演，是就是。

${p.bio}

现在有人把一章小说推到你面前。你刚读完。

${CONTRACT}`;
}

function user(book: BookHandle, chapterNo: number, body: string): string {
  return [
    `这是一本连载中的仙侠小说，第 ${chapterNo} 章。你之前没读过这本。`,
    '（下面附上作者的文风要求，仅供你参考作者想追求什么，不要拿它来给作者打分。）',
    styleRules(book).slice(0, 900),
    `## 第${chapterNo}章\n\n${body}`,
  ].join('\n\n---\n\n');
}

export async function coldRead(
  book: BookHandle,
  chapterNo: number,
  body: string,
  p: Persona,
): Promise<ColdReadResult> {
  const res = await callLLM({
    role: 'coldReader',
    system: system(p),
    user: user(book, chapterNo, body),
    json: true,
    maxTokens: 1200,
    label: `coldread:${p.id}`,
  });

  const raw = extractJson<Partial<ColdReadResult>>(res.text);
  return {
    persona: p.name,
    willContinue: raw.willContinue === true,
    dropPoint: typeof raw.dropPoint === 'string' ? raw.dropPoint : null,
    hookedBy: typeof raw.hookedBy === 'string' ? raw.hookedBy : null,
    wantNext: raw.wantNext ?? '',
    verdict: raw.verdict ?? '',
  };
}

export interface ColdRun {
  ok: ColdReadResult[];
  failed: Array<{ persona: string; error: string }>;
}

export async function runColdReaders(
  book: BookHandle,
  chapterNo: number,
  body: string,
): Promise<ColdRun> {
  const settled = await mapLimit(PERSONAS, PERSONAS.length, async (p) => {
    try {
      return { p, res: await coldRead(book, chapterNo, body, p) };
    } catch (e) {
      return { p, err: (e as Error).message.split('\n')[0] ?? 'unknown' };
    }
  });

  const ok: ColdReadResult[] = [];
  const failed: Array<{ persona: string; error: string }> = [];
  for (const r of settled) {
    if ('res' in r && r.res) ok.push(r.res);
    else failed.push({ persona: r.p.name, error: ('err' in r && r.err) || 'unknown' });
  }
  return { ok, failed };
}

export function tally(results: ColdReadResult[]): { votes: number; total: number; notes: string[] } {
  return {
    votes: results.filter((r) => r.willContinue).length,
    total: results.length,
    notes: results.map((r) => `${r.persona}：${r.willContinue ? '继续' : '划走'} — ${r.verdict}`),
  };
}
