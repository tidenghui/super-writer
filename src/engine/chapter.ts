import { callLLM, spendSoFar } from './llm.ts';
import { extractJson, countChars } from './json.ts';
import { mapLimit } from './util.ts';
import { isMock } from './mock.ts';
import { applyPatches, type Patch } from './patch.ts';
import { lintProse, formatViolations, chapterShape } from './lint.ts';
import {
  bookBriefing,
  beatFor,
  actFor,
  castSheet,
  progressBrief,
  promiseBrief,
  factsBrief,
  styleRules,
  bookTitle,
  recentEndings,
} from './context.ts';
import { runAllCritics, type Critique, type Defect } from './critics.ts';
import { runColdReaders, tally, type ColdReadResult } from './coldRead.ts';
import {
  replaceFacts,
  dropGeneratedPromises,
  loadBook,
  loadChapter,
  saveChapter,
  savePromises,
  patchChapterMeta,
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
  /** 这个场景要写多少字。整章只给一个总目标，模型分配不出来，只能写短。 */
  wordTarget?: number;
  /** 他失败会失去什么。没有代价的场景就是流水账。 */
  stake?: string;
  /** 谁或什么在阻止他拿到。必须是外部的、具体的。 */
  obstacle?: string;
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
  /** 本章还不了的债，明确推到期。不许让账本永远红着。 */
  defer?: Array<{ id: string; dueBy: number }>;
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

async function planChapter(book: BookHandle, n: number, fixes?: string[]): Promise<ChapterPlan> {
  const beat = beatFor(book, n);

  const system = `你是《${bookTitle(book)}》这本书的策划。你不写正文，你只决定这一章要发生什么。

你的判断标准只有一个：这一章读完，读者会不会点下一章。

${bookBriefing(book)}

${styleRules(book)}`;

  const user = [
    actFor(book, n),
    progressBrief(book, n),
    promiseBrief(book, n),
    factsBrief(book, n),
    beat.day !== undefined
      ? `## 时间锚点\n今天是第 ${beat.day} 天，距定名还有 ${7 - beat.day} 天。\n这一章的正文里必须出现一个具体的时间信号（剩余天数、更漏、天色、或者别人提起那个日子），让读者始终感到期限在逼近。`
      : '',
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
    { "location": "...", "cast": ["角色id"], "goal": "...", "obstacle": "谁/什么在拦着他", "stake": "失败会失去什么", "conflict": "...", "turn": "...", "exit": "怎么过渡到下一场景", "wordTarget": 850 }
  ],
  "openingLine": "...",
  "plant": ["p1"],
  "pay": ["p2"],
  "endHook": "...",
  "wordTarget": 2600,
  "mustNot": ["...", "...", "..."],
  "defer": [{ "id": "g1-2", "dueBy": 8 }]
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
    maxTokens: 8000,
    label: 'plan',
  });

  const plan = extractJson<ChapterPlan>(res.text);
  if (!plan.scenes?.length) throw new Error('规划阶段没有产出场景，输出异常');
  return plan;
}

/**
 * 规划复审。
 *
 * 在花钱起草之前，先问一句：这三个场景里，有没有哪一个是「他去做了，做成了」的流水账。
 * 场景没有阻力，写手就只能让人物站着说话——实测第四、五章就是这么水掉的。
 */
async function reviewPlan(
  book: BookHandle,
  n: number,
  plan: ChapterPlan,
): Promise<{ ok: boolean; issues: string[] }> {
  const res = await callLLM({
    role: 'showrunner',
    system: `你是这本书的主编。你只审一件事：这份场景表里，有没有哪一场是流水账。

流水账的判定：主角想要什么，去了，就拿到了。中间没有人拦，没有时间压迫，没有失败的可能。

${bookBriefing(book)}`,
    user: [
      `## 第 ${n} 章的场景表`,
      plan.scenes
        .map(
          (s, i) =>
            `${i + 1}. 【${s.location}】目标：${s.goal}\n   阻力：${s.obstacle ?? '（未填）'}\n   代价：${s.stake ?? '（未填）'}\n   转折：${s.turn}`,
        )
        .join('\n\n'),
      `## 输出`,
      `只输出 JSON：{"ok": true 或 false, "issues": ["问题一", "问题二"]}`,
      `ok 为 false 的条件：有任何一个场景缺阻力、缺代价，或者阻力是「他心里犹豫」这种内部状态。`,
      `issues 最多 3 条，直接说哪一场要改、改成什么。`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 1500,
    label: `plan-review:${n}`,
  });

  const raw = extractJson<{ ok?: boolean; issues?: string[] }>(res.text);
  return { ok: raw.ok === true, issues: raw.issues ?? [] };
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
    maxTokens: 6000,
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
    maxTokens: 1000,
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

  const system = `你是《${bookTitle(book)}》的作者，正在写第 ${n} 章。

你要写的是**连载网络小说**，不是文学小说。读者在手机上读，一章三分钟。你要让他们读完想点「下一章」。

${bookBriefing(book)}

${styleRules(book)}

## 最重要的四条
1. 每段不超过三行。
2. 不许直接写情绪，只写动作和物件。
3. 章末最后一句必须是钩子。
4. 用词必须属于沈砚这个人。他是抄书匠，不是修行者。
   禁用：气感、内息、真元、灵脉、神识、神通、法力、灵力、元力。
   他描述修行只会说「那本薄册子」「练」「字浮上来」。
   另外：老周被下了禁言，他**说不出**关于墨池、献祭、最后一页的直白陈述。
   他只能用暗示、反问、指某个地方。写成他说清楚真相，就是错的。`;

  const user = [
    progressBrief(book, n),
    recentEndings(book, n),
    `## 本章场景表（按顺序写，不要跳；括号里是这个场景的字数配额，必须写够）`,
    plan.scenes
      .map(
        (s, i) =>
          `${i + 1}. 【${s.location}】（约 ${s.wordTarget ?? 850} 字）出场：${s.cast.join('、')}\n   目标：${s.goal}\n   阻力：${s.obstacle ?? '（未填）'}\n   代价：${s.stake ?? '（未填）'}\n   冲突：${s.conflict}\n   转折：${s.turn}\n   收束：${s.exit}`,
      )
      .join('\n\n'),
    `## 人物（口吻必须能区分开）`,
    castSheet(book, castIds),
    `## 已经写好的开头（从这里接着写，一字不改地用它）`,
    opening,
    `## 硬要求`,
    `- 全章 ${plan.wordTarget} 字左右（不得少于 ${Math.round(plan.wordTarget * 0.9)} 字）。每个场景按上面给的配额写，写不够就加动作和物件细节，不要加新情节。`,
    `- 章末最后一句要达成这个意图：${plan.endHook}`,
    `- 这一章绝对不能出现：${plan.mustNot.join('；')}`,
    `- 只写场景表里的事件。不要新增情节、人物、物件——包括结尾不要多写一段。`,
    `- 同一段描写不许出现两次。场景之间必须有明确的时间标记（几点、多久之后、天亮了），不许从「坐到天亮」直接跳到「醒了」。`,
    `- 章末的反转不能和前面已经写出来的事实打架。`,
    `- 章末最后一句就停在钩子上，后面不要再写任何东西。`,
    `- 悬念必须来自具体、可数、可验证的异常——时间过了多久、某个东西变了没有、出现了几次。`,
    `- 不许靠人物之间绕圈子说话来制造悬念。一句话能说清的事不许拆成八句。对话段落不要超过全章的一半。`,
    `- 段落不要碎成一地。叙述段落要有 2–4 句连在一起，只在强调、转折、或节奏需要停顿的地方才单独成段。全章平均每段不少于 18 字。`,
    `- 不要写「第X章」这种标题。不要写任何解释性的话。只输出正文。`,
  ].join('\n\n---\n\n');

  const res = await callLLM({
    role: 'writer',
    system,
    user,
    maxTokens: 12000,
    label: `draft:${n}`,
    ...(temperature !== undefined ? { temperatureOverride: temperature } : {}),
  });

  return res.text.trim();
}

async function expandIfShort(book: BookHandle, n: number, body: string, target: number): Promise<string> {
  const len = countChars(body);
  if (len >= target * 0.9) return body;
  log('起草', `只有 ${len} 字，偏短，补写一次`);

  const res = await callLLM({
    role: 'writer',
    system: `你是《${bookTitle(book)}》的作者。把下面这一章补长到 ${target} 字左右。`,
    user: [
      styleRules(book),
      `## 现有正文（${len} 字）`,
      body,
      `## 任务`,
      `在不动已有情节、不改已有句子的前提下，补写到 ${target} 字左右。`,
      `补的方式：增加具体的动作、物件的细节、角色之间没有说出口的那层意思。不要加新事件。`,
      `只输出补完后的完整正文。`,
    ].join('\n\n---\n\n'),
    maxTokens: 12000,
    label: `expand:${n}`,
  });

  return res.text.trim();
}

// ─────────────────────────────────────────────────────────────
// 阶段 3.5：机械体检 + 定点清洗
// ─────────────────────────────────────────────────────────────

/**
 * 禁用词、失声词、长句、情绪直陈——这些能机械查出来，就别花钱让模型找。
 * 查出来之后定点修补，不重写。
 */
async function cleanDraft(
  book: BookHandle,
  n: number,
  body: string,
): Promise<{ body: string; before: number; fixed: number }> {
  const violations = lintProse(body);
  if (violations.length === 0) return { body, before: 0, fixed: 0 };

  log('体检', `命中 ${violations.length} 处（禁用词/失声/长句/情绪直陈），定点清洗…`);

  const res = await callLLM({
    role: 'reviser',
    system: `你是《${bookTitle(book)}》的文字校对。你只做一件事：把违规的句子改干净。

${styleRules(book)}

铁律：
- 只替换有问题的句子，其余一个字都不要动。
- find 必须是原文里逐字存在、且只出现一次的片段。
- replace 保持原意、保持长度量级，不许新增情节。
- 改不掉就跳过。`,
    user: [
      `## 正文`,
      body,
      `## 违规清单`,
      formatViolations(violations.slice(0, 20)),
      `## 输出`,
      `只输出 JSON：{"patches":[{"find":"原句","replace":"改后"}]}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 6000,
    label: `clean:${n}`,
  });

  let patches: Patch[] = [];
  try {
    patches = extractJson<{ patches: Patch[] }>(res.text).patches ?? [];
  } catch {
    patches = [];
  }

  const r = applyPatches(body, patches);
  const after = lintProse(r.body).length;
  log('体检', `修好 ${violations.length - after} 处，剩 ${after} 处`);

  return { body: r.body, before: violations.length, fixed: violations.length - after };
}

// ─────────────────────────────────────────────────────────────
// 阶段 4：修订
// ─────────────────────────────────────────────────────────────

/**
 * 修订 = 打补丁，不是重写。
 *
 * 早期版本让模型重写整章，结果每修一处就带进三处新错误（blocker 数在轮次间震荡）。
 * 现在只允许它输出「原文 → 改文」的替换对，由引擎机械应用：
 * 改不到就跳过，绝不误伤。
 */
async function revise(
  book: BookHandle,
  n: number,
  body: string,
  critiques: Critique[],
  cold: ColdReadResult[],
): Promise<{ body: string; applied: number; skipped: number; fellBack: boolean }> {
  const actionable = critiques
    .flatMap((c) => c.defects.map((d) => ({ ...d, critic: c.critic })))
    .filter((d) => d.severity !== 'minor')
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .slice(0, 12);

  const coldNotes = cold
    .map(
      (r) =>
        `- ${r.persona}：${r.willContinue ? '会继续读' : '会划走'}${
          r.dropPoint ? `，划走点：「${r.dropPoint}」` : ''
        }${r.wantNext ? `；想看：${r.wantNext}` : ''}`,
    )
    .join('\n');

  const system = `你是《${bookTitle(book)}》的修订编辑。你是拿镊子做手术的，不是拿斧子重写的。

${styleRules(book)}

铁律：
- 只输出「替换对」，不改的地方一个字都不要动。
- find 必须是正文里**逐字存在、且只出现一次**的片段（10–60 字）。
- replace 是改后的句子。长度与原文相当。
- 不许新增情节、人物、物件。
- 不许改变事件的顺序。
- 如果某条意见你没法在不改动别处的前提下修掉，就跳过它。`;

  const user = [
    `## 待修订正文`,
    body,
    `## 要修的问题（按严重程度排）`,
    actionable
      .map(
        (d, i) =>
          `${i + 1}. [${d.critic}｜${d.severity}] 原文：「${d.quote}」\n   问题：${d.problem}\n   改法：${d.fix}`,
      )
      .join('\n\n'),
    `## 真实读者的反应`,
    coldNotes,
    `## 输出`,
    `只输出 JSON：{"patches":[{"find":"原文片段","replace":"改后片段"}]}`,
  ].join('\n\n---\n\n');

  const res = await callLLM({
    role: 'reviser',
    system,
    user,
    json: true,
    maxTokens: 8000,
    label: `revise:${n}`,
  });

  let patches: Patch[] = [];
  try {
    patches = extractJson<{ patches: Patch[] }>(res.text).patches ?? [];
  } catch {
    patches = [];
  }

  const { body: patched, applied, skipped } = applyPatches(body, patches);

  // 一个补丁都没打上，说明模型没按格式来；退回到整章重写，但只在有硬伤时
  if (applied === 0 && blockers(critiques).length > 0) {
    const fallback = await callLLM({
      role: 'reviser',
      system: `你是《${bookTitle(book)}》的修订编辑。

${styleRules(book)}

只改被点名的地方，保留情节、顺序、长度。输出修订后的完整正文。`,
      user: [
        `## 待修订正文`,
        body,
        `## 要修的问题`,
        actionable.map((d, i) => `${i + 1}. 「${d.quote}」→ ${d.fix}`).join('\n'),
        `## 输出`,
        `只输出修订后的完整正文。`,
      ].join('\n\n---\n\n'),
      maxTokens: 12000,
      label: `revise-full:${n}`,
    });
    return { body: fallback.text.trim(), applied: 0, skipped, fellBack: true };
  }

  return { body: patched, applied, skipped, fellBack: false };
}

function sevRank(s: string): number {
  return s === 'blocker' ? 3 : s === 'major' ? 2 : 1;
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

function majors(critiques: Critique[]): Defect[] {
  return critiques.flatMap((c) => c.defects.filter((d) => d.severity === 'major'));
}

/**
 * 放行判据。
 *
 * 刻意不看「平均分」——批评家是被要求挑刺的，6 分意味着「合格但有毛病」，
 * 不是「不及格」。把 7.5 当及格线会让每一章都卡死，而真正的判据是：
 * 有没有硬伤、有没有一堆 major、真实读者会不会点下一章。
 */
function gate(
  critiques: Critique[],
  cold: ColdReadResult[],
  minVotes: number,
): { pass: boolean; why: string } {
  const votes = cold.filter((r) => r.willContinue).length;
  const scores = critiques.map((c) => c.score);
  const lowest = Math.min(...scores);
  const weak = critiques.filter((c) => c.score <= 4).length;
  const hard = blockers(critiques).length;

  // 判据的锚是「读者的手会不会往下滑」，不是缺陷条数。
  // 五个批评家每个都会写 5-6 条意见，拿条数当闸门，没有任何一章能过。
  if (votes < minVotes)
    return { pass: false, why: `冷读 ${votes}/${cold.length} 愿意继续，要求至少 ${minVotes}` };
  if (lowest <= 3) return { pass: false, why: `有批评家给了 ${lowest} 分` };
  if (weak >= 2) return { pass: false, why: `${weak} 位批评家打 4 分以下` };
  if (hard >= 5) return { pass: false, why: `${hard} 处硬伤（blocker）` };

  return {
    pass: true,
    why: `冷读 ${votes}/${cold.length}｜最低分 ${lowest}｜均分 ${avgScore(critiques).toFixed(1)}｜${hard} blocker`,
  };
}

/** 比较两版稿子哪个更好：读者票 > 硬伤 > major 数 > 均分 */
function qualityScore(critiques: Critique[], cold: ColdReadResult[]): number {
  const votes = cold.filter((r) => r.willContinue).length;
  return votes * 100 - blockers(critiques).length * 50 - majors(critiques).length * 5 + avgScore(critiques);
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
    maxTokens: 2500,
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
    // 修订的边际收益是负的：实测每多修一轮，评分反而下降。
    // 更好的做法是独立多跑几版再挑（--candidates），所以这里只留一轮兜底。
    maxRevisions: golden ? 1 : 1,
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
  let plan = await planChapter(book, n);

  const review = await reviewPlan(book, n, plan);
  if (!review.ok) {
    log('规划', `\x1b[33m主编打回：${review.issues[0] ?? '有流水账场景'}\x1b[0m`);
    for (const i of review.issues.slice(1)) log('规划', `　　　　${i}`);
    plan = await planChapter(book, n, review.issues);
    log('规划', `重排后：${plan.scenes.length} 个场景`);
  } else {
    log('规划', '主编通过');
  }
  log('规划', `${plan.scenes.length} 个场景｜${plan.scenes.map((s) => s.location).join(' → ')}`);

  log('开场', '生成候选…');
  const { opening, why } = await chooseOpening(book, n, plan, profile.openings);
  log('开场', why);

  log('起草', `目标 ${plan.wordTarget} 字…`);
  let body = await draft(book, n, plan, opening, temperature);
  body = await expandIfShort(book, n, body, plan.wordTarget);
  log('起草', `初稿 ${countChars(body)} 字`);
  ({ body } = await cleanDraft(book, n, body));

  const shape = chapterShape(body);
  log(
    '章形',
    `${shape.paragraphs} 段｜对话 ${Math.round(shape.dialogueRatio * 100)}%｜平均 ${shape.avgParaLen} 字/段`,
  );
  if (shape.dialogueRatio > 0.6) {
    log('章形', '\x1b[33m对话占比过高——这一章主要在靠人物说话推进，而不是靠事件。\x1b[0m');
  }
  if (shape.avgParaLen < 18) {
    log('章形', '\x1b[33m段落过碎——每句话都单独成段，读起来像聊天记录。\x1b[0m');
  }

  let critiques: Critique[] = [];
  let cold: ColdReadResult[] = [];
  let revisions = 0;
  let best = { body, score: -Infinity, critiques: [] as Critique[], cold: [] as ColdReadResult[] };
  let verdict = { pass: false, why: '' };
  let prevQuality = -Infinity;

  for (let round = 0; round <= maxRevisions; round++) {
    log('审稿', round === 0 ? '批评家 + 冷读并行开火…' : `第 ${round} 轮复审…`);

    const [cRun, dRun] = await Promise.all([
      runAllCritics(book, n, body),
      runColdReaders(book, n, body),
    ]);
    critiques = cRun.ok;
    cold = dRun.ok;

    for (const f of cRun.failed) console.log(`  \x1b[33m!\x1b[0m ${f.critic} 审稿失败：${f.error}`);
    for (const f of dRun.failed) console.log(`  \x1b[33m!\x1b[0m ${f.persona} 冷读失败：${f.error}`);

    // 无人值守时宁可这一章不过，也不要靠残废的评审团放行
    if (critiques.length < 3) {
      throw new Error(`审稿失败太多：只有 ${critiques.length}/5 个批评家返回结果，无法判断这一章能不能发`);
    }
    if (cold.length < 2) {
      throw new Error(`冷读失败太多：只有 ${cold.length}/3 个分身返回结果`);
    }

    const score = qualityScore(critiques, cold);
    if (score > best.score) best = { body, score, critiques, cold };

    if (score < prevQuality) {
      log('放行', '\x1b[33m修订之后反而变差，回退到上一版\x1b[0m');
      break;
    }
    prevQuality = score;

    verdict = gate(critiques, cold, Math.min(profile.minColdVotes, cold.length));
    log(
      '审稿',
      critiques.map((c) => `${c.critic} ${c.score}`).join('｜') +
        `　→　${tally(cold).votes}/${cold.length} 继续`,
    );
    log('放行', verdict.pass ? `\x1b[32m通过\x1b[0m（${verdict.why}）` : `\x1b[33m打回\x1b[0m（${verdict.why}）`);

    if (verdict.pass) break;
    if (round === maxRevisions) break;

    revisions++;
    const r = await revise(book, n, body, critiques, cold);
    body = r.body;
    log(
      '修订',
      r.fellBack
        ? '没有可应用的补丁，退回整章重写'
        : `打了 ${r.applied} 个补丁，跳过 ${r.skipped} 个`,
    );
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
  const deferred: string[] = [];

  log('归档', '沉淀设定与伏笔…');
  const update = await recordCanon(book, n, plan.title, body);

  // 重跑这一章时，先把它上一版自动生成的伏笔清掉，保证幂等
  const base = dropGeneratedPromises(book.bible.promises, n);
  const promises: Promise_[] = base.map((p) => {
    const upd = update.promiseUpdates.find((u) => u.id === p.id);
    return upd && upd.paidAt ? { ...p, paidAt: upd.paidAt } : p;
  });

  update.newPromises.forEach((np, i) => {
    promises.push({
      id: `g${n}-${i + 1}`,
      text: np.text,
      plantedAt: n,
      dueBy: np.dueBy,
      paidAt: null,
      importance: np.importance,
    });
  });

  // 规划阶段申报的延期
  for (const d of plan.defer ?? []) {
    const target = promises.find((x) => x.id === d.id);
    if (target && d.dueBy > target.dueBy) {
      target.dueBy = d.dueBy;
      deferred.push(`${d.id} → 第${d.dueBy}章`);
    }
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
    replaceFacts(book.slug, n, facts);
    saveChapter(book.slug, n, plan.title, body, chapterMeta);
  } else {
    log('归档', 'mock 模式：不写盘（要写盘设 SW_MOCK_SAVE=1）');
  }

  if (deferred.length) log('归档', `延期：${deferred.join('、')}`);

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

/**
 * 人工批注修订。
 *
 * 引擎再牛也会有看不出问题的时候。这条通道把「编辑说一句、机器改一处」
 * 变成可复现的操作，而不是只有某个人记得自己手改过。
 */
export async function fixChapter(
  bookSlug: string,
  n: number,
  note: string,
): Promise<{ applied: number; skipped: number; before: number; after: number }> {
  const book = loadBook(bookSlug);
  const ch = loadChapter(bookSlug, n);
  if (!ch) throw new Error(`没有第 ${n} 章`);

  const before = countChars(ch.body);

  const res = await callLLM({
    role: 'reviser',
    system: `你是《${bookTitle(book)}》的修订编辑，正在执行一条人工批注。

${styleRules(book)}

铁律：
- 只改批注指出的地方，其余一个字都不要动。
- find 必须是正文里逐字存在、且只出现一次的片段。
- replace 保持原意和长度量级。
- 如果批注要求的事情做不到（比如会和其他段落冲突），输出空数组。`,
    user: [
      `## 正文 · 第${n}章《${ch.meta.title}》`,
      ch.body,
      `## 人工批注`,
      note,
      `## 输出`,
      `只输出 JSON：{"patches":[{"find":"原文片段","replace":"改后片段"}]}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 8000,
    label: `fix:${n}`,
  });

  const patches = extractJson<{ patches: Patch[] }>(res.text).patches ?? [];
  const r = applyPatches(ch.body, patches);

  if (r.applied > 0) {
    saveChapter(bookSlug, n, ch.meta.title, r.body, {
      ...ch.meta,
      costCny: ch.meta.costCny,
    });
  }

  const after = countChars(r.body);
  return { applied: r.applied, skipped: r.skipped, before, after };
}

/**
 * 只重跑读者，不改正文。
 * 改过正文、或改过读者提示词之后，用它重新测一遍「还有没有人愿意追」。
 */
export async function rereadChapter(bookSlug: string, n: number): Promise<ColdReadResult[]> {
  const book = loadBook(bookSlug);
  const ch = loadChapter(bookSlug, n);
  if (!ch) throw new Error(`没有第 ${n} 章`);

  const run = await runColdReaders(book, n, ch.body);
  if (run.ok.length < 2) throw new Error(`冷读失败太多：${run.failed.map((f) => f.error).join('；')}`);

  patchChapterMeta(bookSlug, n, { coldRead: tally(run.ok) });
  return run.ok;
}

/**
 * 从已定稿的正文重算一章的派生数据（事实、伏笔、摘要）。
 * 用途：账本被脏数据污染之后重新对齐；或者手动改过正文。
 */
export async function recanonChapter(bookSlug: string, n: number): Promise<void> {
  const book = loadBook(bookSlug);
  const ch = loadChapter(bookSlug, n);
  if (!ch) throw new Error(`没有第 ${n} 章`);

  const update = await recordCanon(book, n, ch.meta.title, ch.body);

  const facts: Fact[] = update.newFacts.map((f, i) => ({
    id: `f${n}-${i + 1}`,
    chapter: n,
    subject: f.subject,
    fact: f.fact,
  }));
  replaceFacts(bookSlug, n, facts);

  const promises = dropGeneratedPromises(book.bible.promises, n).map((p) => {
    const upd = update.promiseUpdates.find((u) => u.id === p.id);
    return upd && upd.paidAt ? { ...p, paidAt: upd.paidAt } : p;
  });
  update.newPromises.forEach((np, i) => {
    promises.push({
      id: `g${n}-${i + 1}`,
      text: np.text,
      plantedAt: n,
      dueBy: np.dueBy,
      paidAt: null,
      importance: np.importance,
    });
  });
  savePromises(bookSlug, promises);

  log('recanon', `第 ${n} 章：${facts.length} 条事实，${update.newPromises.length} 条新伏笔`);
  log('recanon', update.summary);
}

export async function runMany(bookSlug: string, from: number, to: number): Promise<void> {
  for (let n = from; n <= to; n++) {
    await runChapter({ bookSlug, n });
  }
}

export { mapLimit };
