import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { mapLimit } from './util.ts';
import { listChapterMetas, summaryIndex } from '../canon/store.ts';
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

/**
 * 读者看到的东西 = 前情提要 + 这一章。
 *
 * 早先这里还会把《文风规范》塞给读者，那是个错误：
 * 读者不知道、也不关心作者想追求什么，塞给他只会让他去检查合规，
 * 而不是回答「我想不想翻下一章」。
 */
function priorFor(book: BookHandle, chapterNo: number): string {
  const prior = summaryIndex(listChapterMetas(book.slug), chapterNo);
  return prior
    ? `## 前情提要（你前几章读过的）\n${prior}`
    : '这是第一章。你刚点开这本书，什么都不知道。';
}

function user(book: BookHandle, chapterNo: number, body: string): string {
  return [
    priorFor(book, chapterNo),
    `## 第${chapterNo}章\n\n${body}`,
    '你刚读完这一章。现在告诉我你真实的想法。',
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

/**
 * 首屏测试。
 *
 * 手机读者看不到「整章好不好」——他在前两屏就决定走不走。
 * 整章冷读测的是「读完之后想不想看下一章」，这个测的是「看不看得下去第一屏」。
 * 两件事，缺一不可。
 */
export interface FirstScreenResult {
  persona: string;
  keepReading: boolean;
  stoppedAt: string | null;
  reason: string;
}

const FIRST_SCREEN_CONTRACT = `输出格式（只输出 JSON）：

{
  "keepReading": true 或 false,
  "stoppedAt": "从这几百字里逐字复制你差点划走的那一句；没有就填 null",
  "reason": "一句话，为什么继续或者为什么不继续。不要客套。"
}

你只看了开头几百字。你不是在评价整章，你是在决定要不要继续往下滑。`;

export async function firstScreen(
  book: BookHandle,
  chapterNo: number,
  opening: string,
  personaIndex: number,
): Promise<FirstScreenResult> {
  const p = PERSONAS[personaIndex % PERSONAS.length]!;
  const res = await callLLM({
    role: 'coldReader',
    system: `你就是这个人，不是扮演，是就是。

${p.bio}

你在手机上点开了一本不认识的连载小说，只读了开头这几百字。

${FIRST_SCREEN_CONTRACT}`,
    user: [
      priorFor(book, chapterNo),
      `## 开头（你只看到这里）\n\n${opening}`,
      '屏幕停在这儿。你往下滑，还是退出？',
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
    json: true,
    maxTokens: 1000,
    label: `firstscreen:${p.id}`,
  });

  const raw = extractJson<Partial<FirstScreenResult>>(res.text);
  return {
    persona: p.name,
    keepReading: raw.keepReading === true,
    stoppedAt: typeof raw.stoppedAt === 'string' ? raw.stoppedAt : null,
    reason: raw.reason ?? '',
  };
}

export function firstScreenAll(
  book: BookHandle,
  chapterNo: number,
  opening: string,
): Promise<FirstScreenResult[]> {
  return mapLimit(PERSONAS, PERSONAS.length, (_, i) => firstScreen(book, chapterNo, opening, i));
}

/**
 * 两两对比。
 *
 * 绝对打分没有区分度——五个 3/3 并列，谁强谁弱说不出来。
 * 逼着选一个，才知道哪一章最该重写。
 * 为了抵消位置偏好，奇数号分身会把 B 放在前面。
 */
export interface PairResult {
  persona: string;
  winner: 'a' | 'b' | 'tie';
  why: string;
}

export async function compareOpenings(
  book: BookHandle,
  a: { n: number; text: string },
  b: { n: number; text: string },
  personaIndex: number,
): Promise<PairResult> {
  const p = PERSONAS[personaIndex % PERSONAS.length]!;
  const swapped = personaIndex % 2 === 1;
  const first = swapped ? b : a;
  const second = swapped ? a : b;

  const res = await callLLM({
    role: 'coldReader',
    system: `你就是这个人，不是扮演，是就是。

${p.bio}

有人把两本书的开头并排放在你面前。你只有时间读一本。
你必须选一个，不许说「都不错」。`,
    user: [
      `## 甲（第${first.n}章开头）\n\n${first.text}`,
      `## 乙（第${second.n}章开头）\n\n${second.text}`,
      '你点开哪个继续读？只输出 JSON：{"pick":"甲" 或 "乙" 或 "都不看","why":"一句话"}',
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 600,
    label: `pair:${a.n}v${b.n}:${p.id}`,
  });

  const raw = extractJson<{ pick?: string; why?: string }>(res.text);
  const pick = raw.pick ?? '';
  let winner: PairResult['winner'] = 'tie';
  if (pick === '甲') winner = swapped ? 'b' : 'a';
  else if (pick === '乙') winner = swapped ? 'a' : 'b';

  return { persona: p.name, winner, why: raw.why ?? '' };
}

export function comparePair(
  book: BookHandle,
  a: { n: number; text: string },
  b: { n: number; text: string },
): Promise<PairResult[]> {
  return mapLimit(PERSONAS, PERSONAS.length, (_, i) => compareOpenings(book, a, b, i));
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
