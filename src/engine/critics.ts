import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { mapLimit } from './util.ts';
import { loadChapter, type BookHandle } from '../canon/store.ts';
import { bookBriefing, factsBrief, premiseOnly, promiseBrief, styleRules } from './context.ts';

export type Severity = 'blocker' | 'major' | 'minor';

export interface Defect {
  /** 必须是从正文里逐字复制的片段——没有这一条，修改就无从下手 */
  quote: string;
  problem: string;
  severity: Severity;
  fix: string;
}

export interface Critique {
  critic: string;
  score: number;
  verdict: 'pass' | 'revise' | 'rewrite';
  defects: Defect[];
  praise: string;
  /** 引文没能在正文里找到的缺陷数（说明这个批评家在编） */
  unverifiable: number;
}

interface CriticDef {
  id: string;
  name: string;
  lens: string;
  needsCanon?: boolean;
}

const OUTPUT_CONTRACT = `输出格式（严格遵守，只输出 JSON）：

{
  "score": 1-10 的整数,
  "verdict": "pass" | "revise" | "rewrite",
  "praise": "一句，说这章做对了什么（不许客套）",
  "defects": [
    {
      "quote": "从正文里逐字复制的片段，不超过 40 字",
      "problem": "具体是什么问题，不要泛泛而谈",
      "severity": "blocker" | "major" | "minor",
      "fix": "具体怎么改，一句话，可执行"
    }
  ]
}

severity 的定义（严格照此使用）：
- blocker：读者会当场出戏或看不懂。只包括——语法错到读不通、前文没有的信息突然出现、
  视角/人称崩了、同一件事两次说法互相矛盾。
- major：明显是毛病，但读者会皱眉继续读。
- minor：锦上添花级别的建议。
- 拿不准的，一律不要用 blocker。

铁律：
- quote 必须逐字出现在正文里。找不到依据的批评，一律不要写。
- 最多 6 条缺陷。挑最能救这章的说。
- 不许为了显得认真而凑数。没有 blocker 就不要写 blocker。
- 不许重写正文，只指出问题。`;

export const CRITICS: CriticDef[] = [
  {
    id: 'continuity',
    name: '连续性编辑',
    lens: `你只关心一件事：前后是否自洽。

检查：
- 与《世界设定》冲突的地方（人名、地点、修为境界、宗门规矩、时间线）
- 与「已经写进正文的事实」冲突的地方
- 物件、称呼、方位、天气前后不一致
- 逾期未还的伏笔有没有被忘记

不关心文笔，不关心好不好看。只抓矛盾。`,
    needsCanon: true,
  },
  {
    id: 'character',
    name: '角色一致性',
    lens: `你只关心一件事：这些人像不像活人。

检查：
- **人称是否与角色性别一致**。柳青梧是女性，全篇只能用「她」；出现「他」就是硬伤。
- 遮住名字，还能分辨出谁在说话吗？如果不能，就是所有人一个腔调，属于 blocker
- 人物的行为是否符合他「想要什么」和「怕什么」
- 有没有为了推进剧情而让人做蠢事（降智）
- 主角的第一人称叙述，声音是否始终是同一个人

特别注意：本书主角是抄书匠，词汇必须来自他的生活（墨、纸、装订、虫蛀、账本）。他一旦说出「气息」「灵气」这类词，就是失声。`,
  },
  {
    id: 'pacing',
    name: '节奏编辑',
    lens: `你只关心一件事：读者会不会在这里划走。

检查：
- 有没有可以整段删掉而不影响剧情的段落
- 每 600 字是否至少有一个信息增量或情绪转折
- 章末钩子够不够硬——读完最后一句，会不会想点下一章
- 开头 100 字有没有把人抓住
- 有没有该压缩的重复描写

如果整章读起来「平」，直接给 low score，不要客气。`,
  },
  {
    id: 'logic',
    name: '逻辑审查',
    lens: `你只关心一件事：有没有说不通的地方。

检查：
- 因果链：这个人为什么这么做？动机撑得住吗
- 信息链：角色知道的事，他是怎么知道的？有没有「读者不知道但角色突然知道」
- 有没有为了让情节成立而强行降智
- 计时、距离、数量这类硬数字是否算得过来

只抓硬伤，不抓风格。`,
  },
  {
    id: 'prose',
    name: '文风审查',
    lens: `你只关心一件事：有没有违反《文风规范》。

逐条对照检查：
- 是否出现了禁用词表里的词（出现任何一个，至少 major）
- 是否直接命名了情绪（「我很害怕」「他心里一惊」）
- 比喻是否来自抄书匠的生活，有没有出现山河星辰雷霆这类套话
- 句子是否过长（超过 25 字且有逗号串联）
- 段落是否超过三行
- 是否用了「……」表示停顿

引用违规的原句，指出违反了哪一条。`,
  },
];

function criticSystem(def: CriticDef): string {
  return `你是一位极其挑剔的中文小说编辑，专长是${def.name}。你的职责不是鼓励作者，是找出这本稿子被读者放弃的理由。

${def.lens}

你面前是一本正在日更的中文网络连载小说，读者用手机读，注意力极短，没有任何耐心。

${OUTPUT_CONTRACT}`;
}

function criticUser(
  book: BookHandle,
  chapterNo: number,
  body: string,
  def: CriticDef,
): string {
  // 连续性编辑必须看到原文，不能只看摘要和事实表——
  // 上一版它就这样漏掉了「同一件东西换了位置」这种跨越两章的矛盾。
  const previous =
    def.id === 'continuity'
      ? [chapterNo - 2, chapterNo - 1]
          .map((n) => (n >= 1 ? loadChapter(book.slug, n) : null))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => `## 第 ${c.meta.n} 章《${c.meta.title}》原文\n\n${c.body}`)
          .join('\n\n---\n\n')
      : '';

  const parts = [
    styleRules(book),
    // 每个批评家都要知道这本书的类型契约，否则会按写实标准把超自然设定"修"掉
    premiseOnly(book),
    def.needsCanon ? bookBriefing(book) : '',
    def.needsCanon ? promiseBrief(book, chapterNo) : '',
    def.needsCanon ? factsBrief(book, chapterNo) : '',
    previous,
    `## 待审正文 · 第${chapterNo}章\n\n${body}`,
  ];
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/** 正文里找不到的引文，一律作废——防止模型编造"问题" */
function verifyQuotes(defects: Defect[], body: string): { kept: Defect[]; dropped: number } {
  const flat = body.replace(/\s+/g, '');
  const kept: Defect[] = [];
  let dropped = 0;

  for (const d of defects) {
    const q = (d.quote ?? '').replace(/\s+/g, '').replace(/^…+|…+$/g, '');
    if (q.length >= 4 && flat.includes(q)) {
      // 模型偶尔会漏掉 severity，不能因此假定它严重，也不能因此崩
      const sev = d.severity === 'blocker' || d.severity === 'major' ? d.severity : 'minor';
      kept.push({ ...d, severity: sev });
    } else dropped++;
  }
  return { kept, dropped };
}

export async function runCritic(
  book: BookHandle,
  chapterNo: number,
  body: string,
  def: CriticDef,
): Promise<Critique> {
  const res = await callLLM({
    role: 'critic',
    system: criticSystem(def),
    user: criticUser(book, chapterNo, body, def),
    json: true,
    maxTokens: 3000,
    label: `critic:${def.id}`,
  });

  const raw = extractJson<{
    score?: number;
    verdict?: Critique['verdict'];
    praise?: string;
    defects?: Defect[];
  }>(res.text);

  const { kept, dropped } = verifyQuotes(raw.defects ?? [], body);

  return {
    critic: def.name,
    score: clamp(raw.score ?? 5),
    verdict: raw.verdict ?? 'revise',
    defects: kept,
    praise: raw.praise ?? '',
    unverifiable: dropped,
  };
}

export interface CriticsRun {
  ok: Critique[];
  failed: Array<{ critic: string; error: string }>;
}

/**
 * 五个批评家并行。单个失败不许拖垮整章——无人值守的夜里，
 * 一个模型抽风就让整本书停更是最蠢的失败方式。
 */
export async function runAllCritics(
  book: BookHandle,
  chapterNo: number,
  body: string,
): Promise<CriticsRun> {
  const settled = await mapLimit(CRITICS, CRITICS.length, async (def) => {
    try {
      return { def, res: await runCritic(book, chapterNo, body, def) };
    } catch (e) {
      return { def, err: (e as Error).message.split('\n')[0] ?? 'unknown' };
    }
  });

  const ok: Critique[] = [];
  const failed: Array<{ critic: string; error: string }> = [];
  for (const r of settled) {
    if ('res' in r && r.res) ok.push(r.res);
    else failed.push({ critic: r.def.name, error: ('err' in r && r.err) || 'unknown' });
  }
  return { ok, failed };
}

function clamp(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}
