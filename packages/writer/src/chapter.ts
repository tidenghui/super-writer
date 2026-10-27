import { callLLM, callJson, spendSoFar, resetSpend } from './llm.ts';
import { extractJson, safeJson, countChars } from './json.ts';
import { mapLimit } from './util.ts';
import { isMock } from './mock.ts';
import { applyPatches, type Patch } from './patch.ts';
import {
  lintProse,
  formatViolations,
  chapterShape,
  repetitionWarnings,
  redlineViolations,
  quoteViolations,
  normalizeQuotes,
  proximityViolations,
  repeatedExplaining,
} from './lint.ts';
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
  loadRules,
  saveTraitsForChapter,
  saveAutoRulesForChapter,
  saveEntitiesForChapter,
  loadEntities,
  loadLedger,
  saveLedgerForChapter,
  currentLedger,
  loadTraits,
  patchChapterMeta,
  listChapterMetas,
  type BookHandle,
  type ChapterMeta,
  type ChapterBeat,
  type Promise_,
  type Fact,
} from '../../contract/src/index.ts';

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

/**
 * 时间锚点。
 *
 * 以前只给了策划，写手拿不到——所以它会把「还有三天」写成「还有四天」，
 * 或者把入池日往后挪一天。天数是读者会数的东西，写手必须知道。
 */
function timeAnchor(beat: ChapterBeat): string {
  if (beat.day === undefined) return '';
  const deadline = beat.day < 7 ? 7 : 14;
  const label = beat.day < 7 ? '定名' : '入池';
  return `## 时间锚点\n今天是第 ${beat.day} 天，距${label}还有 ${deadline - beat.day} 天。\n这一章的正文里必须出现一个具体的时间信号（剩余天数、更漏、天色、或者别人提起那个日子），让读者始终感到期限在逼近。\n**天数是硬数字，不许写错，读者会算。**`;
}

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
    timeAnchor(beat),
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

  // 解析失败自动重试：一次坏 JSON 不该让整本书停下来
  for (let i = 0; i < 2; i++) {
    const plan = await callJson<ChapterPlan>({
      role: 'planner',
      system,
      user,
      json: true,
      maxTokens: 12000,
      label: 'plan',
    });
    if (plan.scenes?.length) return plan;
  }
  throw new Error('规划阶段连续两次没有产出场景');
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

  const raw = safeJson<{ ok?: boolean; issues?: string[] }>(res.text, { ok: true, issues: [] });
  return { ok: raw.ok === true, issues: raw.issues ?? [] };
}

/**
 * 本章相关的那一小撮设定。
 *
 * 全量清单给写手是没用的：74 条物件、上百条事实，它读不过来，
 * 于是照样随手造一个「我姐」「第七层」。
 * 只给它**这一章会用到**的东西——按场景表里出现的名字去筛。
 */
function chapterCanon(book: BookHandle, n: number, plan: ChapterPlan): string {
  const sceneText = plan.scenes
    .map((s) => [s.location, s.goal, s.conflict, s.turn, s.exit, s.stake ?? '', ...s.cast].join(' '))
    .join(' ');
  const castIds = new Set(plan.scenes.flatMap((s) => s.cast));

  const ents = loadEntities(book.slug)
    .filter((e) => e.fromChapter < n && sceneText.includes(e.name))
    .slice(0, 12);

  const traits = loadTraits(book.slug).filter(
    (t) => t.fromChapter < n && (castIds.has(t.who) || sceneText.includes(t.who)),
  );

  const rules = loadRules(book.slug)
    .filter((r) => (r.sinceChapter ?? 0) <= n && (castIds.has(r.who) || r.aliases.some((a) => sceneText.includes(a))))
    .slice(0, 4);

  const parts: string[] = [];
  if (ents.length) {
    parts.push(
      `## 本章会用到的东西（这些是书里已经存在的，照它们写，不要另造）\n${ents
        .map((e) => `- ${e.name}（${e.kind}${e.note ? '，' + e.note : ''}）`)
        .join('\n')}`,
    );
  }
  if (traits.length) {
    parts.push(
      `## 本章出场人物的固定特征（写错就是串味）\n${traits.map((t) => `- ${t.who}：${t.trait}`).join('\n')}`,
    );
  }
  const ledger = currentLedger(book.slug, n);
  if (ledger.length) {
    parts.push(
      `## 章末必须对得上的账（读者会算，写错就是硬伤）\n${ledger
        .map((e) => `- ${e.key}：${e.value}${e.unit ?? ''}（第${e.fromChapter}章末）`)
        .join('\n')}\n\n这一章里凡是要用这些数的地方，先在纸上算一遍再写。加减要对，别为了制造绝境随手扣数。`,
    );
  }

  if (rules.length) {
    parts.push(
      `## 本章的禁忌\n${rules
        .map(
          (r) =>
            `- ${r.who}：${r.why}${r.cannotSay.length ? `（不能说：${r.cannotSay.join('、')}）` : ''}${
              r.notNear?.length ? `（不能这样写：${r.notNear.join('、')}）` : ''
            }`,
        )
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
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
    `- 只许出现这些人物：${book.bible.characters.map((c) => c.name).join('、')}。不许编新名字。`,
    `- 每段不超过三行`,
    '',
    `只输出 JSON，不要解释：{"openings": ["开场一", "开场二", ...]}`,
  ].join('\n');

  const { openings } = await callJson<{ openings: string[] }>({
    role: 'opener',
    system,
    user,
    json: true,
    maxTokens: 12000,
    label: `openings:${n}`,
    temperatureOverride: 1.2,
  });
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
  anchor: string,
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
    chapterCanon(book, n, plan),
    // 已写进正文的事实和还没还的债，写手必须看到——
    // 不然它会写出「柳青梧的父亲是杂役」这种和前面矛盾的东西
    factsBrief(book, n),
    promiseBrief(book, n),
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
    `- **新东西第一次出现，必须当场用完整描写引入**（它是什么、在哪、什么样子）。
      不许用「那根麻绳」「那个结」「那张纸」这种口气指一个前文根本没写过的东西。
      凡是你想写「那X」的地方，先问自己：读者见过 X 吗？没见过就写全，别用「那」。`,
    `- 同理，不许让角色随口引用他没听过的信息（谁告诉他的？哪本书上看到的？想清楚再写）。`,
    `- **推理必须有据。** 主角得出的每个结论，依据必须是前文已经写出来的东西。
      不许在给出结论的同一段里第一次抛出证据——「我那时就知道，只是没说」
      「其实我早就注意到了」「这时我才想起」这类句子，一律不许用。
      如果找不到前文已有的依据，就不要让他得出结论。`,
    `- 不允许出现场景表之外的新人物。需要有人在场，就用老周、柳青梧、阿满、玄清这几个已有的。`,
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
  const rules = loadRules(book.slug);
  const all = (b: string) => [
    ...lintProse(b),
    ...redlineViolations(b, rules, n),
    ...quoteViolations(b),
    // 人称检查的误报率过高（实测 4/4 误报），不参与自动修订，
    // 改为在人物卡里写清性别、由「角色一致性」批评家把关。
  ];
  const violations = all(body);
  if (violations.length === 0) return { body, before: 0, fixed: 0 };

  log('体检', `命中 ${violations.length} 处（禁用词/失声/长句/情绪直陈），定点清洗…`);

  const res = await callLLM({
    role: 'reviser',
    system: `你是《${bookTitle(book)}》的文字校对。你只做一件事：把违规的句子改干净。

${styleRules(book)}

铁律：
- 只替换有问题的句子，其余一个字都不要动。
- 标着「越界」的句子，是这个角色**说不出这种话**。改法不是换个委婉说法，而是：
  让他说不出来（卡住、咳嗽、改口）、或者换一个人说、或者改成动作和暗示。
  绝对不能保留原来那层信息。
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
  // 最后一道：引号用代码修，不问模型
  r.body = normalizeQuotes(r.body);
  const after = all(r.body).length;
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
  arbiterNote = '',
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
    arbiterNote
      ? `## 终审意见（优先级最高，先修这个）\n${arbiterNote}\n这条是终审亲自读出来的硬伤，比下面任何一条都重要。`
      : '',
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

/**
 * 终审仲裁。
 *
 * 便宜的流水线经常卡在「读者都说想继续读，但批评家列了五处硬伤」。
 * 这时候让最贵的模型来判：这些硬伤会不会让人出戏？
 * 只在边际情况下调用，不参与常规流程。
 */
async function arbitrate(
  book: BookHandle,
  n: number,
  body: string,
  critiques: Critique[],
  cold: ColdReadResult[],
): Promise<{ publish: boolean; reason: string }> {
  const hard = blockers(critiques).slice(0, 6);
  const votes = cold.filter((r) => r.willContinue).length;

  const res = await callLLM({
    role: 'arbiter',
    system: `你是这本书的终审。你只回答一件事：这一章现在能不能发。

判断标准不是「有没有毛病」——任何一章都有毛病。标准是：
**这些毛病会不会让目标读者出戏、弃书、或者觉得作者在糊弄他。**

如果只是「可以更好」，可以发。如果是「读者会当场觉得不对」，不能发。`,
    user: [
      `## 读者反应`,
      `${votes}/${cold.length} 个读者说会继续读。`,
      cold.map((r) => `- ${r.persona}：${r.verdict}`).join('\n'),
      `## 批评家指出的硬伤`,
      hard.length
        ? hard
            .map((d, i) => `${i + 1}. 「${d.quote.slice(0, 40)}」\n   ${d.problem.slice(0, 120)}`)
            .join('\n\n')
        : '（无）',
      `## 正文`,
      body,
      `## 输出`,
      `只输出 JSON：{"publish": true/false, "reason": "一句话"}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 3000,
    label: `arbiter:${n}`,
  });

  const raw = safeJson<{ publish?: boolean; reason?: string }>(res.text, { publish: false, reason: '仲裁输出无法解析' });
  return { publish: raw.publish === true, reason: raw.reason ?? '' };
}

// ─────────────────────────────────────────────────────────────
// 阶段 6：把这一章沉淀回圣经
// ─────────────────────────────────────────────────────────────

interface CanonUpdate {
  summary: string;
  newFacts: Array<{ subject: string; fact: string }>;
  promiseUpdates: Array<{ id: string; paidAt: number | null }>;
  newPromises: Array<{ text: string; dueBy: number; importance: 1 | 2 | 3 }>;
  /** 本章确立的角色特征：走路姿态、口癖、习惯动作 */
  newTraits?: Array<{ who: string; trait: string }>;
  /** 本章确立的禁忌：谁不能说/不能怎么写 */
  newRules?: Array<{ who: string; aliases: string[]; cannotSay: string[]; notNear?: string[]; why: string }>;
  /** 本章出现、以后可以引用的具体东西：物件、地点、规矩、称谓 */
  newEntities?: Array<{ name: string; kind: '物件' | '地点' | '规矩' | '称谓'; note?: string }>;
  /** 本章结束时的数量状态：剩墨、剩天数、人数。后面的章要按这个算。 */
  ledger?: Array<{ key: string; value: string; unit?: string }>;
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
      `5. newTraits：这一章**明写出来**的角色特征——走路姿态、口癖、习惯动作、说话方式。`,
      `   只记正文里真的写出来的，不推测。who 用角色 id。最多 3 条。`,
      `6. newRules：这一章**明写出来**的禁忌——某人被下了封口令、某人说某类话会出事。`,
      `   没有就留空，不要编。最多 1 条。`,
      `7a. ledger：这一章**结束时**的数量状态。凡是读者会算的数——剩几份墨、还剩几天、在场几个人——`,
      `   都要记下来，写成 key（稳定的名字）+ value（章末的值）。不要记过程，只记结果。`,
      `7. newEntities：这一章出场、以后会被反复引用的**具体东西**——有名有姓的物件、地点、规矩、称谓。`,
      `   比如「渠册」「自举签」「第七块架签」「申时之前回来」。最多 5 条，只记重要的。`,
      `   这张表是给后面的章用的：写手需要一个东西时，会先看这里有没有。`,
      '',
      `只输出 JSON：
{"summary":"...","newFacts":[{"subject":"...","fact":"..."}],"promiseUpdates":[{"id":"p1","paidAt":${n}}],"newPromises":[{"text":"...","dueBy":${n + 5},"importance":2}],"ledger":[{"key":"剩墨","value":"2.5","unit":"份"}],"newEntities":[{"name":"渠册","kind":"物件","note":"老周让他抄的册子"}],"newTraits":[{"who":"liuqingwu","trait":"走路三下一样重"}],"newRules":[{"who":"老周","aliases":["老周"],"cannotSay":["墨池"],"why":"舌上有禁制"}]}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 2500,
    label: `canon:${n}`,
  });

  const raw = safeJson<Partial<CanonUpdate>>(res.text, {});
  return {
    summary: raw.summary ?? '',
    newFacts: raw.newFacts ?? [],
    promiseUpdates: raw.promiseUpdates ?? [],
    newPromises: raw.newPromises ?? [],
    newTraits: raw.newTraits ?? [],
    newRules: raw.newRules ?? [],
    newEntities: raw.newEntities ?? [],
    ledger: raw.ledger ?? [],
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
  /**
   * 续修：不重新起草，直接拿已有的草稿重跑审稿和修订。
   * 夜班没过闸门的章，早上一键救回来，不用重写整章。
   */
  resume?: boolean;
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
  resetSpend(); // 预算是按章算的
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

  const existing = opts.resume ? loadChapter(book.slug, n) : null;
  if (opts.resume && !existing) throw new Error(`没有第 ${n} 章的草稿可续修`);

  log('规划', '拆场景…');
  let plan = existing
    ? ({ title: existing.meta.title, scenes: [], openingLine: '', plant: [], pay: [], endHook: '', wordTarget: 2600, mustNot: [] } as ChapterPlan)
    : await planChapter(book, n);
  if (existing) log('规划', `\x1b[2m续修模式：沿用《${existing.meta.title}》，不重新起草\x1b[0m`);

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

  let body: string;
  if (existing) {
    body = existing.body;
    log('起草', `\x1b[2m续修：现有正文 ${countChars(body)} 字\x1b[0m`);
  } else {
    log('开场', '生成候选…');
    const { opening, why } = await chooseOpening(book, n, plan, profile.openings);
    log('开场', why);
    log('起草', `目标 ${plan.wordTarget} 字…`);
    body = await draft(book, n, plan, opening, timeAnchor(beatFor(book, n)), temperature);
    body = await expandIfShort(book, n, body, plan.wordTarget);
    log('起草', `初稿 ${countChars(body)} 字`);
  }
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
  for (const w of repetitionWarnings(body)) log('章形', `\x1b[33m${w}\x1b[0m`);

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
    let arbiterNote = '';

    // 边际情况：读者想继续读、分数不低，只是硬伤条数压线 → 交给仲裁
    if (
      !verdict.pass &&
      cold.filter((r) => r.willContinue).length >= Math.min(profile.minColdVotes, cold.length) &&
      avgScore(critiques) >= 5.5 &&
      blockers(critiques).length < 11
    ) {
      const a = await arbitrate(book, n, body, critiques, cold);
      log('仲裁', a.publish ? `\x1b[32m放行\x1b[0m：${a.reason}` : `\x1b[33m驳回\x1b[0m：${a.reason}`);
      if (a.publish) verdict = { pass: true, why: `仲裁放行：${a.reason}` };
      else arbiterNote = a.reason;
    }
    log(
      '审稿',
      critiques.map((c) => `${c.critic} ${c.score}`).join('｜') +
        `　→　${tally(cold).votes}/${cold.length} 继续`,
    );
    log('放行', verdict.pass ? `\x1b[32m通过\x1b[0m（${verdict.why}）` : `\x1b[33m打回\x1b[0m（${verdict.why}）`);

    if (verdict.pass) break;
    if (round === maxRevisions) break;

    revisions++;
    const r = await revise(book, n, body, critiques, cold, arbiterNote);
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

  // 过了闸门就是可发布的：不排队、不控节奏。
  // （publishAt 字段保留，将来要控节奏时再用；现在一律不设 = 立即可见）
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
    saveTraitsForChapter(
      book.slug,
      n,
      (update.newTraits ?? []).map((t) => ({ who: t.who, trait: t.trait, fromChapter: n })),
    );
    if ((update.newRules ?? []).length) saveAutoRulesForChapter(book.slug, n, update.newRules ?? []);
    if ((update.newEntities ?? []).length) {
      saveEntitiesForChapter(
        book.slug,
        n,
        (update.newEntities ?? []).map((e) => ({ ...e, fromChapter: n })),
      );
    }
    if ((update.ledger ?? []).length) {
      saveLedgerForChapter(
        book.slug,
        n,
        (update.ledger ?? []).map((e) => ({ ...e, fromChapter: n })),
      );
    }
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

// ─────────────────────────────────────────────────────────────
// 段落级打磨
// ─────────────────────────────────────────────────────────────

interface WeakPara {
  quote: string;
  why: string;
}

/**
 * 只重写最弱的几段。
 *
 * 整章重写一定会改坏（实测过）。段落级不一样：只动一段，上下文不变，
 * 而且候选里包含原稿——裁判可以选「原稿更好」，最坏情况是不变。
 */
export async function polishChapter(
  bookSlug: string,
  n: number,
  count = 3,
): Promise<{ picked: Array<{ why: string; kept: boolean }>; before: number; after: number }> {
  const book = loadBook(bookSlug);
  const ch = loadChapter(bookSlug, n);
  if (!ch) throw new Error(`没有第 ${n} 章`);

  const before = ch.body;
  let body = ch.body;

  const pick = await callLLM({
    role: 'critic',
    system: `你是这本书的责任编辑。你只挑段落，不改写。

你知道什么叫「不往前走的句子」：它只是在描写，没有提供新信息，也没有制造紧张。

${styleRules(book)}`,
    user: [
      `## 正文`,
      body,
      `## 任务`,
      `挑出最弱的 ${count} 个段落。标准：删掉它，读者不会损失任何信息或情绪。`,
      `优先挑「氛围描写多于事件」的段落，不要挑对话。`,
      `只输出 JSON：{"weak":[{"quote":"逐字复制的整段","why":"为什么它不往前走"}]}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 2000,
    label: `polish-pick:${n}`,
  });

  const weak = (extractJson<{ weak?: WeakPara[] }>(pick.text).weak ?? []).filter((w) =>
    body.includes(w.quote.trim()),
  );

  const results: Array<{ why: string; kept: boolean }> = [];

  for (const w of weak) {
    const original = w.quote.trim();

    const alts = await mapLimit([0, 1, 2], 3, async (i) => {
      const r = await callLLM({
        role: 'writer',
        system: `你是《${bookTitle(book)}》的作者，正在打磨一个段落。

${styleRules(book)}`,
        user: [
          `## 上下文（这一段前后的内容）`,
          excerptAround(body, original),
          `## 要重写的段落`,
          original,
          `## 任务`,
          `重写这一段，第 ${i + 1} 个版本，换一种写法。要求：`,
          `- 保留它承担的信息和情绪，一个字都不许丢`,
          `- 长度不得超过原文的 110%。宁可删，不可添。这一段如果删掉一半还成立，就删一半。`,
          `- 让它往前推：增加具体的动作、可数的细节、或一个小的转折`,
          `- 不要加新情节、新人物`,
          `只输出这一段的新写法，不要解释。`,
        ].join('\n\n---\n\n'),
        maxTokens: 1200,
        label: `polish-alt:${n}:${i}`,
        temperatureOverride: 1.0,
      });
      return r.text.trim();
    });

    const judge = await callLLM({
      role: 'critic',
      system: '你是极其挑剔的中文小说编辑。你只做一件事：从几个版本里选最好的那一个。',
      user: [
        `## 上下文`,
        excerptAround(body, original),
        `## 候选`,
        [original, ...alts].map((t, i) => `### 候选 ${i}${i === 0 ? '（原稿）' : ''}\n${t}`).join('\n\n'),
        `## 判断标准`,
        `1. 有没有往前推（新信息或新紧张）`,
        `0. 先看长度：明显比原稿长的，除非它真的提供了新信息，否则扣分。这本书的风格是克制。`,
        `2. 声音是否和上下文一致`,
        `3. 有没有套话、有没有直接命名情绪`,
        `原稿如果是最好的一版，就选 0。`,
        `只输出 JSON：{"winner": 0-${alts.length}, "why":"一句话"}`,
      ].join('\n\n---\n\n'),
      json: true,
      maxTokens: 400,
      label: `polish-judge:${n}`,
    });

    const { winner, why } = extractJson<{ winner: number; why: string }>(judge.text);
    const idx = Math.max(0, Math.min(alts.length, winner ?? 0));

    if (idx === 0) {
      results.push({ why: `原稿更好：${why ?? ''}`, kept: true });
      continue;
    }

    const replacement = alts[idx - 1]!;
    const applied = applyPatches(body, [{ find: original, replace: replacement }]);
    if (applied.applied === 1) {
      body = applied.body;
      results.push({ why: why ?? '', kept: false });
    } else {
      results.push({ why: '替换失败（原文不唯一）', kept: true });
    }
  }

  if (body !== before) {
    saveChapter(bookSlug, n, ch.meta.title, body, { ...ch.meta });
  }

  return { picked: results, before: countChars(before), after: countChars(body) };
}

function excerptAround(body: string, quote: string, span = 260): string {
  const i = body.indexOf(quote);
  if (i === -1) return body.slice(0, span);
  const start = Math.max(0, i - span);
  const end = Math.min(body.length, i + quote.length + span);
  return `${start > 0 ? '……' : ''}${body.slice(start, end)}${end < body.length ? '……' : ''}`;
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
  saveTraitsForChapter(
    bookSlug,
    n,
    (update.newTraits ?? []).map((t) => ({ who: t.who, trait: t.trait, fromChapter: n })),
  );
  if ((update.newRules ?? []).length) saveAutoRulesForChapter(bookSlug, n, update.newRules ?? []);
  if ((update.newEntities ?? []).length) {
    saveEntitiesForChapter(
      bookSlug,
      n,
      (update.newEntities ?? []).map((e) => ({ ...e, fromChapter: n })),
    );
  }
  if ((update.ledger ?? []).length) {
    saveLedgerForChapter(
      bookSlug,
      n,
      (update.ledger ?? []).map((e) => ({ ...e, fromChapter: n })),
    );
  }

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
    const res = await runChapter({ bookSlug, n });
    if (!res.accepted) {
      // 连载不能跳章：这一章没过，后面就不许往下写。
      // 否则读者会看到第 6 章直接跳到第 8 章。
      console.log(
        `\n  \x1b[33m第 ${n} 章没有过线，连更中止。\x1b[0m\n` +
          `  修好它再继续：npm run fix -- --n ${n} --m "..." 或重跑 npm run chapter -- --n ${n}\n`,
      );
      return;
    }
  }
}

export { mapLimit };


/**
 * 攒缓冲。
 *
 * 生产和发布解耦：发布是每天 20:00 一章，生产可以快得多。
 * 手上永远留 N 章待发，某章回炉重写不会让读者断更。
 */
export async function buildBacklog(bookSlug: string, ahead: number): Promise<void> {
  const book = loadBook(bookSlug);

  let guard = 0;
  while (guard++ < 20) {
    const metas = listChapterMetas(bookSlug);
    const pending = metas.filter((m) => m.status === 'accepted' && (m.publishAt ?? '') > new Date().toISOString()).length;
    if (pending >= ahead) {
      console.log(`\n  缓冲够用：${pending} 章待发（目标 ${ahead}）\n`);
      return;
    }

    const next = (metas.filter((m) => m.status === 'accepted').at(-1)?.n ?? 0) + 1;
    const total = book.bible.outline.chapters.length;
    if (next > total) {
      console.log(`\n  全书写完（${total} 章）\n`);
      return;
    }

    console.log(`\n  待发 ${pending} 章，写第 ${next} 章…`);
    const res = await runChapter({ bookSlug, n: next });
    if (!res.accepted) {
      console.log(
        `\n  第 ${next} 章没过闸门，缓冲暂停。修好再继续：\n` +
          `    npm run chapter -- --n ${next} --resume\n`,
      );
      return;
    }
  }
}
