import { callLLM, spendSoFar } from './llm.ts';
import { extractJson, countChars } from './json.ts';
import { mapLimit } from './util.ts';
import { isMock } from './mock.ts';
import {
  bookBriefing,
  beatFor,
  actFor,
  castSheet,
  progressBrief,
  promiseBrief,
  factsBrief,
  styleRules,
} from './context.ts';
import { runAllCritics, type Critique, type Defect } from './critics.ts';
import { runColdReaders, tally, type ColdReadResult } from './coldRead.ts';
import {
  appendFacts,
  loadBook,
  saveChapter,
  savePromises,
  type BookHandle,
  type ChapterMeta,
  type Promise_,
  type Fact,
} from '../canon/store.ts';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

interface Scene {
  location: string;
  cast: string[];
  goal: string;
  conflict: string;
  turn: string;
  exit: string;
}

interface ChapterPlan {
  title: string;
  scenes: Scene[];
  openingLine: string;
  plant: string[];
  pay: string[];
  endHook: string;
  wordTarget: number;
  mustNot: string[];
}

export interface ChapterResult {
  n: number;
  title: string;
  body: string;
  plan: ChapterPlan;
  critiques: Critique[];
  coldRead: ColdReadResult[];
  revisions: number;
  costCny: number;
  accepted: boolean;
}

const log = (stage: string, msg: string) => console.log(`  \x1b[2m${stage}\x1b[0m ${msg}`);

// ─────────────────────────────────────────────────────────────
// 阶段 1：规划
// ─────────────────────────────────────────────────────────────

async function planChapter(book: BookHandle, n: number): Promise<ChapterPlan> {
  const beat = beatFor(book, n);

  const system = `你是《${book.slug}》这本书的策划。你不写正文，你只决定这一章要发生什么。

你的判断标准只有一个：这一章读完，读者会不会点下一章。

${bookBriefing(book)}

${styleRules(book)}`;

  const user = [
    actFor(book, n),
    progressBrief(book, n),
    promiseBrief(book, n),
    factsBrief(book, n),
    `## 第 ${n} 章的大纲（必须落实，不许改主线）
标题（暂定）：${beat.title}
这一章存在的理由：${beat.purpose}
必须发生的节拍：
${beat.beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}
预定的章末钩子：${beat.hook}
${beat.plant?.length ? `需要在这一章埋下的伏笔：${beat.plant.join('、')}` : ''}
${beat.pay?.length ? `需要在这一章回收的伏笔：${beat.pay.join('、')}` : ''}`,
    `## 你要输出的东西

把上面的大纲拆成 2–3 个场景。每个场景必须有一个「转折」——不能是信息的平铺。

同时决定：
- openingLine：这一章的第一句。要短，要有物，要让人想读第二句。
- endHook：章末最后一句的意图（不是原句，是意图）。
- mustNot：这一章绝对不能出现的三样东西（防止套路化）。

只输出 JSON：
{
  "title": "章标题，四个字以内最好",
  "scenes": [
    { "location": "...", "cast": ["角色id"], "goal": "...", "conflict": "...", "turn": "...", "exit": "怎么过渡到下一场景" }
  ],
  "openingLine": "...",
  "plant": ["p1"],
  "pay": ["p2"],
  "endHook": "...",
  "wordTarget": 2600,
  "mustNot": ["...", "...", "..."]
}

角色 id 只能用：${book.bible.characters.map((c) => c.id).join('、')}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const res = await callLLM({
    role: 'planner',
    system,
    user,
    json: true,
    maxTokens: 2048,
    label: 'plan',
  });

  const plan = extractJson<ChapterPlan>(res.text);
  if (!plan.scenes?.length) throw new Error('规划阶段没有产出场景，输出异常');
  return plan;
}

// ─────────────────────────────────────────────────────────────
// 阶段 2：候选开场（黄金三章的算力偏心就体现在这里）
// ─────────────────────────────────────────────────────────────

async function chooseOpening(
  book: BookHandle,
  n: number,
  plan: ChapterPlan,
  candidates = 4,
): Promise<{ opening: string; why: string }> {
  const system = `你是中文小说作者，擅长写第一段。你知道读者在手机上只给你两屏的机会。

${styleRules(book)}`;

  const user = [
    `## 这一章的规划`,
    `第一句已经定了：${plan.openingLine}`,
    `第一个场景：${plan.scenes[0]?.location}｜${plan.scenes[0]?.goal}｜冲突：${plan.scenes[0]?.conflict}`,
    `## 任务`,
    `写 ${candidates} 个不同的开场，每个 250–400 字。要求：`,
    `- 第一句必须是规划里那一句`,
    `- 每个开场用完全不同的切入方式（例如：从声音切入 / 从一个动作切入 / 从一段被念出来的文字切入 / 从对话切入）`,
    `- 结尾都停在让人想读下去的地方`,
    `- 每段不超过三行`,
    '',
    `只输出 JSON，不要解释：{"openings": ["开场一", "开场二", ...]}`,
  ].join('\n');

  const gen = await callLLM({
    role: 'opener',
    system,
    user,
    json: true,
    maxTokens: 3000,
    label: `openings:${n}`,
    temperatureOverride: 1.2,
  });

  const { openings } = extractJson<{ openings: string[] }>(gen.text);
  if (!openings?.length) throw new Error('开场生成失败');

  if (openings.length === 1) return { opening: openings[0]!, why: '只有一个候选' };

  const judgeUser = [
    `下面是一章小说的 ${openings.length} 个候选开场。请判断哪一个最能让人读下去。`,
    '',
    openings.map((o, i) => `### 候选 ${i + 1}\n${o}`).join('\n\n'),
    '',
    `判断标准（按重要性排序）：`,
    `1. 前两句能不能让人停住（有没有具体的、意外的东西）`,
    `2. 有没有制造一个信息缺口（读者想知道答案）`,
    `3. 声音是否统一（是不是同一个人在用同一种方式讲话）`,
    `4. 有没有套话、有没有直接命名情绪`,
    '',
    `只输出 JSON：{"winner": 1-N 的整数, "why": "一句话"}`,
  ].join('\n');

  const judge = await callLLM({
    role: 'critic',
    system: '你是极其挑剔的中文小说编辑。你只选一个。',
    user: judgeUser,
    json: true,
    maxTokens: 512,
    label: 'opening-judge',
  });

  const { winner, why } = extractJson<{ winner: number; why: string }>(judge.text);
  const idx = Math.max(0, Math.min(openings.length - 1, (winner ?? 1) - 1));
  log('开场', `从 ${openings.length} 个候选中选第 ${idx + 1} 个`);

  return { opening: openings[idx]!, why: why ?? '' };
}

// ─────────────────────────────────────────────────────────────
// 阶段 3：起草
// ─────────────────────────────────────────────────────────────

async function draft(
  book: BookHandle,
  n: number,
  plan: ChapterPlan,
  opening: string,
  temperature?: number,
): Promise<string> {
  const castIds = [...new Set(plan.scenes.flatMap((s) => s.cast))];

  const system = `你是《藏经阁的最后一页》的作者，正在写第 ${n} 章。

你要写的是**连载网络小说**，不是文学小说。读者在手机上读，一章三分钟。你要让他们读完想点「下一章」。

${bookBriefing(book)}

${styleRules(book)}

## 最重要的三条
1. 每段不超过三行。
2. 不许直接写情绪，只写动作和物件。
3. 章末最后一句必须是钩子。`;

  const user = [
    progressBrief(book, n),
    `## 本章场景表（按顺序写，不要跳）`,
    plan.scenes
      .map(
        (s, i) =>
          `${i + 1}. 【${s.location}】出场：${s.cast.join('、')}\n   目标：${s.goal}\n   冲突：${s.conflict}\n   转折：${s.turn}\n   收束：${s.exit}`,
      )
      .join('\n\n'),
    `## 人物（口吻必须能区分开）`,
    castSheet(book, castIds),
    `## 已经写好的开头（从这里接着写，一字不改地用它）`,
    opening,
    `## 硬要求`,
    `- 全章 ${plan.wordTarget} 字左右（上下浮动 300 字）。`,
    `- 章末最后一句要达成这个意图：${plan.endHook}`,
    `- 这一章绝对不能出现：${plan.mustNot.join('；')}`,
    `- 不要写「第X章」这种标题。不要写任何解释性的话。只输出正文。`,
  ].join('\n\n---\n\n');

  const res = await callLLM({
    role: 'writer',
    system,
    user,
    maxTokens: 8000,
    label: `draft:${n}`,
    ...(temperature !== undefined ? { temperatureOverride: temperature } : {}),
  });

  return res.text.trim();
}

async function expandIfShort(book: BookHandle, n: number, body: string, target: number): Promise<string> {
  const len = countChars(body);
  if (len >= target * 0.7) return body;
  log('起草', `只有 ${len} 字，偏短，补写一次`);

  const res = await callLLM({
    role: 'writer',
    system: `你是《藏经阁的最后一页》的作者。把下面这一章补长到 ${target} 字左右。`,
    user: [
      styleRules(book),
      `## 现有正文（${len} 字）`,
      body,
      `## 任务`,
      `在不动已有情节、不改已有句子的前提下，补写到 ${target} 字左右。`,
      `补的方式：增加具体的动作、物件的细节、角色之间没有说出口的那层意思。不要加新事件。`,
      `只输出补完后的完整正文。`,
    ].join('\n\n---\n\n'),
    maxTokens: 8000,
    label: `expand:${n}`,
  });

  return res.text.trim();
}

// ─────────────────────────────────────────────────────────────
// 阶段 4：修订
// ─────────────────────────────────────────────────────────────

async function revise(
  book: BookHandle,
  n: number,
  body: string,
  critiques: Critique[],
  cold: ColdReadResult[],
): Promise<string> {
  const actionable = critiques
    .flatMap((c) => c.defects.map((d) => ({ ...d, critic: c.critic })))
    .filter((d) => d.severity !== 'minor')
    .slice(0, 14);

  const defectList = actionable
    .map(
      (d, i) =>
        `${i + 1}. [${d.critic}｜${d.severity}] 原文：「${d.quote}」\n   问题：${d.problem}\n   改法：${d.fix}`,
    )
    .join('\n\n');

  const coldNotes = cold
    .map(
      (r) =>
        `- ${r.persona}：${r.willContinue ? '会继续读' : '会划走'}${
          r.dropPoint ? `，划走点：「${r.dropPoint}」` : ''
        }${r.wantNext ? `；想看：${r.wantNext}` : ''}`,
    )
    .join('\n');

  const system = `你是《藏经阁的最后一页》的修订编辑。你不是重写，你是修补。

${styleRules(book)}

铁律：
- 只改被点名的地方。没被点名的地方一个字都不要动。
- 保留原有情节、顺序、长度。不许加新事件。
- 不许把短句改成长句。
- 输出修订后的完整正文。`;

  const user = [
    `## 待修订正文`,
    body,
    `## 需要修的缺陷（按严重程度排）`,
    defectList || '（没有硬伤，只做节奏优化）',
    `## 真实读者的反应`,
    coldNotes,
    `## 任务`,
    `改完这些缺陷，长度保持原样（±5%）。只输出修订后的完整正文，不要说明改了什么。`,
  ].join('\n\n---\n\n');

  const res = await callLLM({
    role: 'reviser',
    system,
    user,
    maxTokens: 8000,
    label: `revise:${n}`,
  });

  return res.text.trim();
}

// ─────────────────────────────────────────────────────────────
// 阶段 5：放行判定
// ─────────────────────────────────────────────────────────────

function blockers(critiques: Critique[]): Defect[] {
  return critiques.flatMap((c) => c.defects.filter((d) => d.severity === 'blocker'));
}

function avgScore(critiques: Critique[]): number {
  if (critiques.length === 0) return 0;
  return critiques.reduce((s, c) => s + c.score, 0) / critiques.length;
}

function gate(
  critiques: Critique[],
  cold: ColdReadResult[],
  minVotes: number,
): { pass: boolean; why: string } {
  const score = avgScore(critiques);
  const hard = blockers(critiques);
  const votes = cold.filter((r) => r.willContinue).length;

  if (hard.length > 0) return { pass: false, why: `有 ${hard.length} 处硬伤（blocker）` };
  if (score < 7.5) return { pass: false, why: `平均分 ${score.toFixed(1)} < 7.5` };
  if (votes < minVotes)
    return { pass: false, why: `冷读 ${votes}/${cold.length} 愿意继续，要求至少 ${minVotes}` };
  return { pass: true, why: `平均分 ${score.toFixed(1)}，冷读 ${votes}/${cold.length}` };
}

// ─────────────────────────────────────────────────────────────
// 阶段 6：把这一章沉淀回圣经
// ─────────────────────────────────────────────────────────────

interface CanonUpdate {
  summary: string;
  newFacts: Array<{ subject: string; fact: string }>;
  promiseUpdates: Array<{ id: string; paidAt: number | null }>;
  newPromises: Array<{ text: string; dueBy: number; importance: 1 | 2 | 3 }>;
}

async function recordCanon(book: BookHandle, n: number, title: string, body: string): Promise<CanonUpdate> {
  const open = book.bible.promises.filter((p) => p.paidAt === null);

  const res = await callLLM({
    role: 'canonRecorder',
    system: `你是这本书的连续性记录员。你的工作是读完一章正文，把里面新确立的信息记下来，供后面几十章使用。

你只记录**已经写进正文的事实**，不许推测、不许补充、不许美化。`,
    user: [
      `## 正文 · 第${n}章《${title}》`,
      body,
      `## 当前未回收的伏笔`,
      open.map((p) => `- [${p.id}] ${p.text}（应在第${p.dueBy}章前还）`).join('\n') || '（无）',
      `## 任务`,
      `1. summary：用 2–3 句话概括这一章发生了什么。只写事件，不评论。`,
      `2. newFacts：这一章新确立的、后面必须遵守的事实（人名、地点、物件、规则、时间）。最多 6 条。`,
      `3. promiseUpdates：这一章还掉了哪些债。只填真的还了的。没还的不要列。`,
      `4. newPromises：这一章新埋的伏笔。最多 2 条，并给出应该在多少章内回收（dueBy，绝对值）。`,
      '',
      `只输出 JSON：
{"summary":"...","newFacts":[{"subject":"...","fact":"..."}],"promiseUpdates":[{"id":"p1","paidAt":${n}}],"newPromises":[{"text":"...","dueBy":${n + 5},"importance":2}]}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 1500,
    label: `canon:${n}`,
  });

  const raw = extractJson<Partial<CanonUpdate>>(res.text);
  return {
    summary: raw.summary ?? '',
    newFacts: raw.newFacts ?? [],
    promiseUpdates: raw.promiseUpdates ?? [],
    newPromises: raw.newPromises ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

export interface RunOptions {
  bookSlug: string;
  n: number;
  maxRevisions?: number;
  /** 只出稿不落盘，供「跑多版挑最好」用 */
  persist?: boolean;
  /** 变体序号：让多次生成之间产生差异 */
  variant?: number;
}

export interface ChapterProfile {
  golden: boolean;
  openings: number;
  maxRevisions: number;
  minColdVotes: number;
}

/**
 * 算力偏心：前三章是一本书的生死线。
 * 第 1 章留不住人，后面写得多好都没人知道——所以前 3 章配 8 个开场候选、3 轮修订、要求 3/3 冷读全票。
 */
export function profileFor(n: number): ChapterProfile {
  const golden = n <= 3;
  return {
    golden,
    openings: golden ? 8 : 4,
    maxRevisions: golden ? 3 : 2,
    minColdVotes: golden ? 3 : 2,
  };
}

export async function runChapter(opts: RunOptions): Promise<ChapterResult> {
  const book = loadBook(opts.bookSlug);
  const n = opts.n;
  const profile = profileFor(n);
  const maxRevisions = opts.maxRevisions ?? profile.maxRevisions;
  const variant = opts.variant ?? 0;
  // 变体之间靠温度拉开差异：0.9 / 0.95 / 1.0 …
  const temperature = 0.9 + variant * 0.05;
  const costAtStart = spendSoFar().totalCny;

  console.log(
    `\n\x1b[1m第 ${n} 章\x1b[0m · ${book.bible.outline.chapters.find((c) => c.n === n)?.title ?? ''}` +
      `${profile.golden ? '\x1b[33m（黄金三章档：开场×' + profile.openings + '，修订×' + maxRevisions + '）\x1b[0m' : ''}` +
      `${variant ? `　变体 ${variant + 1}` : ''}\n`,
  );

  log('规划', '拆场景…');
  const plan = await planChapter(book, n);
  log('规划', `${plan.scenes.length} 个场景｜${plan.scenes.map((s) => s.location).join(' → ')}`);

  log('开场', '生成候选…');
  const { opening, why } = await chooseOpening(book, n, plan, profile.openings);
  log('开场', why);

  log('起草', `目标 ${plan.wordTarget} 字…`);
  let body = await draft(book, n, plan, opening, temperature);
  body = await expandIfShort(book, n, body, plan.wordTarget);
  log('起草', `初稿 ${countChars(body)} 字`);

  let critiques: Critique[] = [];
  let cold: ColdReadResult[] = [];
  let revisions = 0;
  let best = { body, score: 0, critiques: [] as Critique[], cold: [] as ColdReadResult[] };
  let verdict = { pass: false, why: '' };

  for (let round = 0; round <= maxRevisions; round++) {
    log('审稿', round === 0 ? '批评家 + 冷读并行开火…' : `第 ${round} 轮复审…`);

    [critiques, cold] = await Promise.all([
      runAllCritics(book, n, body),
      runColdReaders(book, n, body),
    ]);

    const score = avgScore(critiques);
    if (score > best.score) best = { body, score, critiques, cold };

    verdict = gate(critiques, cold, profile.minColdVotes);
    log(
      '审稿',
      critiques.map((c) => `${c.critic} ${c.score}`).join('｜') +
        `　→　${tally(cold).votes}/${cold.length} 继续`,
    );
    log('放行', verdict.pass ? `\x1b[32m通过\x1b[0m（${verdict.why}）` : `\x1b[33m打回\x1b[0m（${verdict.why}）`);

    if (verdict.pass) break;
    if (round === maxRevisions) break;

    revisions++;
    body = await revise(book, n, body, critiques, cold);
  }

  // 用分数最高的那一版，而不是最后一版——修订有时会改坏
  const final = verdict.pass ? { body, critiques, cold } : best;
  body = final.body;
  critiques = final.critiques;
  cold = final.cold;

  if (opts.persist === false) {
    return {
      n,
      title: plan.title,
      body,
      plan,
      critiques,
      coldRead: cold,
      revisions,
      costCny: Number((spendSoFar().totalCny - costAtStart).toFixed(3)),
      accepted: verdict.pass,
    };
  }

  const result: ChapterResult = {
    n,
    title: plan.title,
    body,
    plan,
    critiques,
    coldRead: cold,
    revisions,
    costCny: Number((spendSoFar().totalCny - costAtStart).toFixed(3)),
    accepted: verdict.pass,
  };

  await finalize(book, result);
  return result;
}

/**
 * 把一章的产物沉淀回这本书：还债、记事实、写摘要、落盘。
 * 独立出来，是因为「跑多版挑最好」需要先比完再落盘。
 */
export async function finalize(book: BookHandle, result: ChapterResult): Promise<ChapterMeta> {
  const { n, body, plan, critiques, coldRead: cold, revisions } = result;
  const costAtStart = spendSoFar().totalCny - result.costCny;

  log('归档', '沉淀设定与伏笔…');
  const update = await recordCanon(book, n, plan.title, body);

  const promises: Promise_[] = book.bible.promises.map((p) => {
    const upd = update.promiseUpdates.find((u) => u.id === p.id);
    return upd && upd.paidAt ? { ...p, paidAt: upd.paidAt } : p;
  });

  let nextId = promises.length + 1;
  for (const np of update.newPromises) {
    promises.push({
      id: `p${nextId++}`,
      text: np.text,
      plantedAt: n,
      dueBy: np.dueBy,
      paidAt: null,
      importance: np.importance,
    });
  }

  const facts: Fact[] = update.newFacts.map((f, i) => ({
    id: `f${n}-${i + 1}`,
    chapter: n,
    subject: f.subject,
    fact: f.fact,
  }));

  const chapterMeta: ChapterMeta = {
    n,
    title: plan.title,
    status: result.accepted ? 'accepted' : 'draft',
    wordCount: countChars(body),
    summary: update.summary,
    coldRead: tally(cold),
    critics: critiques.map((c) => ({
      name: c.critic,
      score: c.score,
      verdict: c.verdict,
      defects: c.defects.length,
    })),
    revisions,
    costCny: Number((spendSoFar().totalCny - costAtStart).toFixed(3)),
    createdAt: new Date().toISOString(),
  };

  // mock 模式默认不写盘，免得占位文本混进书里
  const persist = !isMock() || process.env.SW_MOCK_SAVE === '1';
  if (persist) {
    savePromises(book.slug, promises);
    appendFacts(book.slug, facts);
    saveChapter(book.slug, n, plan.title, body, chapterMeta);
  } else {
    log('归档', 'mock 模式：不写盘（要写盘设 SW_MOCK_SAVE=1）');
  }

  result.costCny = chapterMeta.costCny ?? result.costCny;

  console.log(
    `\n  ${persist ? '存盘' : '演练'}：第${n}章《${plan.title}》　${chapterMeta.wordCount} 字　¥${chapterMeta.costCny}\n`,
  );

  return chapterMeta;
}

/**
 * 同一章跑 k 个变体，挑最好的那个落盘。
 * 第一章值得这么干：第一印象只有一个。
 */
export async function runWithCandidates(
  bookSlug: string,
  n: number,
  k: number,
): Promise<ChapterResult> {
  const book = loadBook(bookSlug);
  const runs: ChapterResult[] = [];

  for (let v = 0; v < k; v++) {
    console.log(`\n\x1b[2m──────── 候选 ${v + 1}/${k} ────────\x1b[0m`);
    // 先全跑完再统一落盘；每版之间靠温度拉开差异
    runs.push(await runChapter({ bookSlug, n, variant: v, persist: false }));
  }

  const scoreOf = (r: ChapterResult): number => {
    const avg = r.critiques.length
      ? r.critiques.reduce((s, c) => s + c.score, 0) / r.critiques.length
      : 0;
    const votes = r.coldRead.filter((c) => c.willContinue).length;
    const hard = r.critiques.flatMap((c) => c.defects).filter((d) => d.severity === 'blocker').length;
    return avg * 10 + votes * 8 - hard * 25 + (r.accepted ? 15 : 0);
  };

  console.log('\n\x1b[1m候选对比\x1b[0m');
  runs.forEach((r, i) => {
    const avg = r.critiques.length
      ? r.critiques.reduce((s, c) => s + c.score, 0) / r.critiques.length
      : 0;
    const votes = r.coldRead.filter((c) => c.willContinue).length;
    console.log(
      `  候选 ${i + 1}  均分 ${avg.toFixed(1)}　冷读 ${votes}/${r.coldRead.length}　` +
        `${r.accepted ? '\x1b[32m过线\x1b[0m' : '\x1b[33m未过线\x1b[0m'}　${r.title}`,
    );
  });

  const ranked = [...runs].sort((a, b) => scoreOf(b) - scoreOf(a));
  const winner = ranked[0]!;
  console.log(`\n  → 选中：第 ${runs.indexOf(winner) + 1} 个候选《${winner.title}》\n`);

  await finalize(book, winner);
  return winner;
}

export async function runMany(bookSlug: string, from: number, to: number): Promise<void> {
  for (let n = from; n <= to; n++) {
    await runChapter({ bookSlug, n });
  }
}

export { mapLimit };
