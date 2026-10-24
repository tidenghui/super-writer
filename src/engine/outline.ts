/**
 * 章纲扩展器。
 *
 * 大纲分两层：
 *   - 卷纲（act）：人写的，讲这一卷要发生什么。这是方向，不该由机器定。
 *   - 章纲（chapter beat）：机器写的。把一句梗概扩成可以直接开写的章纲——
 *     出场人物、场景阻力、天数、要埋要还的债。
 *
 * 为什么必须由机器写：章纲要贴着已经写出来的正文走（事实表、伏笔账本、
 * 上一章结尾的情绪）。人写第二幕的章纲时，脑子里装不下十二万字之前定过的细节；
 * 机器每次都能把全部事实读一遍。
 *
 * 人只负责两件事：定卷纲，和验收成品。
 */
import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { saveOutline, loadRules } from '../canon/store.ts';
import { proximityViolations } from './lint.ts';
import {
  bookBriefing,
  bookTitle,
  styleRules,
} from './context.ts';
import {
  listChapterMetas,
  loadChapter,
  loadFacts,
  loadEntities,
  loadTraits,
  openPromises,
  summaryIndex,
  type BookHandle,
  type ChapterBeat,
} from '../canon/store.ts';

export interface OutlineReport {
  n: number;
  title: string;
  beats: number;
  cast: string[];
  day?: number;
  reviewed: boolean;
  issues: string[];
}

/** 取这本书里允许出现的角色（id + 名字 + 不能违反的设定） */
function castRoster(book: BookHandle): string {
  return book.bible.characters
    .map(
      (c) =>
        `- ${c.id}｜${c.name}｜${c.role === 'protagonist' ? '主角' : c.role === 'antagonist' ? '反派' : '配角'}` +
        `｜想要：${c.wants}｜秘密：${c.secret ?? '无'}`,
    )
    .join('\n');
}

/** 已经写出来的部分，压缩成「不能违反」的清单 */
function establishedFacts(book: BookHandle, upTo: number): string {
  const facts = loadFacts(book.slug).filter((f) => f.chapter < upTo);
  const bySubject = new Map<string, string[]>();
  for (const f of facts) {
    const list = bySubject.get(f.subject) ?? [];
    list.push(f.fact);
    bySubject.set(f.subject, list);
  }
  return [...bySubject.entries()]
    .map(([s, fs]) => `- ${s}：${fs.join('；')}`)
    .join('\n');
}

async function draftBeat(
  book: BookHandle,
  n: number,
  day: number,
  fixes: string[],
  ending = '',
): Promise<ChapterBeat> {
  const metas = listChapterMetas(book.slug);
  const written = metas.filter((m) => m.n < n && m.status === 'accepted');
  const prev = written.at(-1);
  const prevCh = prev ? loadChapter(book.slug, prev.n) : null;

  const open = openPromises(book.bible.promises, n);
  const current = book.bible.outline.chapters.find((c) => c.n === n);

  const res = await callLLM({
    role: 'showrunner',
    system: `你是《${bookTitle(book)}》的策划。你写的是**章纲**，不是正文。

章纲的标准：拿到就能开写，不需要再问任何问题。

## 三条红线（写章纲时就撞，整章就废了）

1. **老周说不出来。** 他舌上有禁制：凡涉及墨池、献祭、最后一页的**直白陈述**，他发不出声。
   他只能暗示、指、写一两个残字、或者说反话。不许让他在章纲里把真相讲清楚。
2. **柳青梧不知道真相。** 她是执法堂，只查书页缺损、门籍、卷宗这些刑律层面的事。
   墨池机制她说不出来（一说就呛血）。她不能替主角把推论讲完。
3. **玄清不交底。** 他知道一切，但不主动说破。他给提示，不给答案。

另外：不许新造人物。不许把核心秘密（沈鹤自己走进墨池、换一人出）提前摊开。

${bookBriefing(book)}

${styleRules(book)}`,
    user: [
      `## 这本书已经写到第 ${Math.max(0, n - 1)} 章`,
      `已写完的章节摘要：\n${summaryIndex(metas, n) || '（还没有）'}`,
      prevCh ? `## 上一章的结尾原文（这一章要接住它的情绪和悬念）\n……${prevCh.body.trim().slice(-400)}` : '',
      `## 已经写进正文、不许违反的事实\n${establishedFacts(book, n) || '（无）'}`,
      `## 还没还的债\n${open.map((p) => `- [${p.id}] ${p.text}（第${p.dueBy}章前）`).join('\n') || '（无）'}`,
      `## 可出场的角色（只能用这些 id，不许新造人）\n${castRoster(book)}`,
      `## 卷的位置\n${book.bible.outline.acts.map((a) => `- ${a.name}（第${a.from}–${a.to}章）${a.gist}`).join('\n')}`,
      ending
        ? `## 全书的结局方向（人定的，不许改）\n${ending}\n你这一章是在为它铺路。只能用书里已经存在的东西铺——前 22 章没写过的规则，一律不许现造。`
        : '',
      `## 这一章现在只有一句梗概\n标题：${current?.title ?? '（未定）'}\n用途：${current?.purpose ?? '（未定）'}\n原节拍：${(current?.beats ?? []).join(' / ') || '（无）'}\n原钩子：${current?.hook ?? '（无）'}`,
      fixes.length ? `## 上一版被打回的原因（必须修掉）\n${fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}` : '',
      `## 你要产出什么`,
      `把这一章扩成可以直接开写的章纲：`,
      `- beats：5–6 条。每一条都是一个**场景级事件**：谁、在哪、想要什么、被什么挡住、结果如何。`,
      `- **每条不超过 70 字。**这个限制是故意的：`,
      `  颜色、气味、具体手势、数字、比喻——一概不要写进章纲。那些细节交给起草，
     因为它手上有事实表可以核对，而你没有。你写得越细，写错的地方就越多，正文会忠实照抄。`,
      `- 每条节拍里如果出现「发现 / 得知 / 拿到」之类的信息推进，必须写清信息**从哪来**（看到的、别人说的、算出来的）。凭空知道是硬伤。
- 你只规定**事件和因果**，不规定**感官细节**。`,
      `- cast：本章出场角色的 id，只能从上面的名单里选。`,
      `- 本章是**第 ${day} 天**，距入池还有 **${14 - day} 天**。这个数字已经定了，不要改，也不要在 beats 里写错。`,
      `- plant / pay：埋哪条债、还哪条债，用债的 id。`,
      `- hook：章末最后一句要达到的效果（写意图，不写原句）。`,
      `- requires：这一章的**情节要成立，依赖哪些书里已经成立的东西**。`,
      `  用短词组写（物件名、人名、已发生的事），每条不超过 10 个字。最多 5 条。`,
      `  只写「书里真的已经有了」的。如果某个前提其实还没埋，**就不要写这一章的情节**，换一个能成立的。`,
      `  这一条是硬约束：引擎会拿它逐条回查，查不到就退回重写。`,
      `只输出 JSON：
{"n":${n},"title":"...","purpose":"...","beats":["...","..."],"hook":"...","cast":["shenyan"],"requires":["渠册","老周的缺指"],"plant":[],"pay":[]}`,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
    json: true,
    maxTokens: 4000,
    label: `outline:${n}`,
  });

  return extractJson<ChapterBeat>(res.text);
}

/**
 * 前置条件回查。
 *
 * 第23章卡了五次，根因是高潮依赖三个前 22 章从没出现过的前提。
 * 这件事在章纲阶段就能查出来——只要有谁去查。
 */
function missingRequirements(book: BookHandle, n: number, beat: ChapterBeat): string[] {
  const reqs = beat.requires ?? [];
  if (!reqs.length) return [];

  const corpus = [
    ...loadEntities(book.slug).filter((e) => e.fromChapter < n).map((e) => `${e.name} ${e.note ?? ''}`),
    ...loadTraits(book.slug).filter((t) => t.fromChapter < n).map((t) => `${t.who} ${t.trait}`),
    ...loadFacts(book.slug).filter((f) => f.chapter < n).map((f) => `${f.subject} ${f.fact}`),
    book.bible.promises.map((p) => `${p.text}`),
    book.bible.characters.map((c) => `${c.name} ${c.id} ${c.role}`),
  ]
    .join('\n')
    .toLowerCase();

  // 「人名/物件名 + 属性」不算缺——玄清声音、阿满按手、沈鹤笔迹，
  // 人都在，只是这种词组不会原样出现在书里。
  const known = [
    ...book.bible.characters.flatMap((c) => [c.name, c.id]),
    ...loadEntities(book.slug).filter((e) => e.fromChapter < n).map((e) => e.name),
  ].filter((x) => x.length >= 2);

  return reqs.filter((r) => {
    const key = r.trim().toLowerCase();
    if (!key) return false;
    if (known.some((k) => key.includes(k.toLowerCase()))) return false;
    if (corpus.includes(key)) return false;

    // 退一步：只要词组里有连续的 3 字片段在书里出现过，就算有这个前提。
    // 2 字的词要求整词出现——太松的话什么都查不出来。
    if ([...key].length <= 2) return true;
    const chars = [...key];
    for (let i = 0; i + 3 <= chars.length; i++) {
      if (corpus.includes(chars.slice(i, i + 3).join(''))) return false;
    }
    return true;
  });
}

/** 主编复核：这份章纲有没有违反已写事实、有没有凭空信息 */
async function reviewBeat(
  book: BookHandle,
  n: number,
  beat: ChapterBeat,
): Promise<{ ok: boolean; issues: string[] }> {
  const res = await callLLM({
    role: 'outlineReview',
    system: `你是这本书的责任编辑，只审章纲，**只拦硬伤**。

硬伤只有三种，其余一律不要提：

1. **与已写事实冲突**——时间线、年岁、物件位置、已经发生过的事被改写。
2. **出现了名单之外的角色**。
3. **情节依赖书里还没有的东西**——这是最要命的一种。
   办法：把这一章的每个关键转折拿出来问「读者凭什么接受这一步？」
   如果答案需要某个前文从没交代过的物件、关系、回忆、规则，那就是硬伤。
   高潮章最容易犯：它默认读者已经知道一堆前面没埋的事。

对话层面的事（谁能不能说某句话）不在这里管——那由起草阶段的机械检查拦，
它比你看得更准，而且不会漏。

天数、信息从哪来、节奏好不好——都不要提。

不要提：信息从哪来、场景够不够紧张、节奏好不好、伏笔埋得巧不巧。
那些是写手的事，章纲阶段管不了，提了也改不好。

${bookBriefing(book)}`,
    user: [
      `## 已写进正文的事实\n${establishedFacts(book, n) || '（无）'}`,
      `## 角色名单\n${castRoster(book)}`,
      `## 书里已经存在的东西（判断「有没有铺垫」的依据）`,
      [
        `物件/地点：${loadEntities(book.slug).filter((e) => e.fromChapter < n).map((e) => e.name).join('、')}`,
        `已写事实：${loadFacts(book.slug).filter((f) => f.chapter < n).slice(-40).map((f) => `${f.subject}：${f.fact}`).join('；')}`,
      ].join('\n'),
      `## 待审章纲（第 ${n} 章）`,
      `${beat.title}\n${beat.beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n钩子：${beat.hook}`,
      beat.requires?.length ? `本章声称依赖：${beat.requires.join('、')}` : '',
      `## 输出`,
      `只输出 JSON：{"ok": true/false, "issues": ["..."]}。`,
      `没有硬伤就 ok=true、issues 为空。**宁可放过，不要凑数。**`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 1200,
    label: `outline-review:${n}`,
  });

  const raw = extractJson<{ ok?: boolean; issues?: string[] }>(res.text);
  return { ok: raw.ok === true, issues: raw.issues ?? [] };
}

/**
 * 把若干章从一句梗概扩成章纲。已定稿的章节不动。
 */
export async function expandOutline(
  book: BookHandle,
  from: number,
  to: number,
  ending = '',
): Promise<OutlineReport[]> {
  const reports: OutlineReport[] = [];
  const outline = structuredClone(book.bible.outline);
  const rules = loadRules(book.slug);

  for (let n = from; n <= to; n++) {
    const ch = loadChapter(book.slug, n);
    if (ch?.meta.status === 'accepted') {
      console.log(`  第 ${n} 章已定稿，跳过`);
      continue;
    }

    // 改到过为止。人和模型一样，第一版总会有漏洞；关键是有没有人在盯。
    // 天数由代码推进：上一章 +1，但不越过入池（第 14 天）
    const prevDay = outline.chapters.filter((c) => c.n < n && c.day !== undefined).at(-1)?.day ?? n - 1;
    const day = Math.min(14, prevDay + 1);

    let fixes: string[] = [];
    // 章纲也要跑和正文一样的机械检查：
    // 上一版把「两短一长」写进了柳青梧的节拍，正文忠实照抄，一路带进稿子。
    const mechanical = (b: ChapterBeat) => [
      ...proximityViolations((b.beats ?? []).join('\n\n'), rules, n).map((v) => v.rule),
      ...missingRequirements(book, n, b).map(
        (r) => `这一章依赖「${r}」，但书里到第 ${n - 1} 章为止从没出现过。要么换成已有的，要么这个情节不成立。`,
      ),
    ];

    let beat = await draftBeat(book, n, day, fixes, ending);
    beat.n = n;
    beat.day = day;
    const mech1 = mechanical(beat);
    let review = mech1.length
      ? { ok: false, issues: mech1 }
      : await reviewBeat(book, n, beat);
    if (mech1.length) console.log(`  第 ${n} 章：机械检查拦下 — ${mech1[0]}`);

    // 情节依赖不存在的前提，是最难改的一种：往往要重新设计整章走向。
    // 这种章多给两轮，普通的只给两轮。
    const MAX_ROUNDS = mech1.some((m) => m.includes('从没出现过')) ? 4 : 2;

    for (let round = 2; round <= MAX_ROUNDS && !review.ok; round++) {
      console.log(`  第 ${n} 章：主编打回（第 ${round - 1} 轮）— ${review.issues[0] ?? ''}`);
      fixes = review.issues;
      beat = await draftBeat(book, n, day, fixes, ending);
      beat.n = n;
      beat.day = day;
      const mechN = mechanical(beat);
      review = mechN.length ? { ok: false, issues: mechN } : await reviewBeat(book, n, beat);
    }

    const idx = outline.chapters.findIndex((c) => c.n === n);
    if (idx >= 0) outline.chapters[idx] = { ...outline.chapters[idx], ...beat };
    else outline.chapters.push(beat);
    outline.chapters.sort((a, b) => a.n - b.n);

    console.log(
      `  第 ${n} 章《${beat.title}》${beat.beats?.length ?? 0} 个节拍｜第 ${beat.day ?? '?'} 天｜${review.ok ? '复核通过' : '仍有问题：' + review.issues.join('；')}`,
    );

    reports.push({
      n,
      title: beat.title,
      beats: beat.beats?.length ?? 0,
      cast: beat.cast ?? [],
      ...(beat.day !== undefined ? { day: beat.day } : {}),
      reviewed: review.ok,
      issues: review.issues,
    });
  }

  saveOutline(book.slug, outline);
  return reports;
}
