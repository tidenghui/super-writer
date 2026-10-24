import {
  loadChapter,
  loadFacts,
  loadBookInfo,
  loadTraits,
  listChapterMetas,
  summaryIndex,
  openPromises,
  promisesDueSoon,
  overduePromises,
  type BookHandle,
  type ChapterBeat,
  type Character,
  type Promise_,
} from '../canon/store.ts';

/** 给模型看的「这本书是什么」——每次调用都带上，防止跑偏 */
export function bookBriefing(book: BookHandle): string {
  const b = book.bible;
  return [
    '## 这本书的前提',
    b.premise,
    '## 世界设定（硬约束，不得违反）',
    b.world,
  ].join('\n\n');
}

/** 书名。提示词里必须用人话，不能把 slug 塞进去。 */
/** 只有前提——给不需要世界全貌的批评家用 */
export function premiseOnly(book: BookHandle): string {
  return book.bible.premise;
}

export function bookTitle(book: BookHandle): string {
  try {
    return loadBookInfo(book.slug).title;
  } catch {
    return book.slug;
  }
}

export function styleRules(book: BookHandle): string {
  return `## 文风规范（违反任何一条都会被批评家打回）\n\n${book.bible.style}`;
}

export function beatFor(book: BookHandle, n: number): ChapterBeat {
  const beat = book.bible.outline.chapters.find((c) => c.n === n);
  if (!beat) {
    throw new Error(`outline.json 里没有第 ${n} 章的大纲。先把大纲补上——引擎不即兴编主线。`);
  }
  return beat;
}

export function actFor(book: BookHandle, n: number): string {
  const act = book.bible.outline.acts.find((a) => n >= a.from && n <= a.to);
  return act ? `【${act.name}】（第 ${act.from}–${act.to} 章）${act.gist}` : '';
}

export function castSheet(book: BookHandle, ids: string[]): string {
  const byId = new Map(book.bible.characters.map((c) => [c.id, c]));
  // 引擎从正文里长出来的特征，和人物卡里的并列使用
  const traits = loadTraits(book.slug);
  const picked: Character[] = ids.map((id) => byId.get(id)).filter((c): c is Character => !!c);
  if (picked.length === 0) return '（本章登场的人物见场景表）';

  return picked
    .map((c) =>
      [
        `### ${c.name}（${c.id}，${c.role === 'protagonist' ? '主角' : c.role === 'antagonist' ? '反派' : '配角'}，${c.gender === 'female' ? '女' : '男'}）`,
        `- 说话方式：${c.voice}`,
        `- 想要：${c.wants}`,
        `- 怕：${c.fears}`,
        c.secret ? `- 秘密（读者此时未必知道，但你必须守住一致性）：${c.secret}` : '',
        `- 外形：${c.appearance}`,
        (() => {
          const learned = traits.filter((t) => t.who === c.id || t.who === c.name).map((t) => t.trait);
          const all = [...new Set([...(c.signature ?? []), ...learned])];
          return all.length ? `- 签名特征（必须照此写，写错就是串味）：${all.join('；')}` : '';
        })(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export function progressBrief(book: BookHandle, n: number): string {
  const metas = listChapterMetas(book.slug);
  const prior = summaryIndex(metas, n);
  const prev = loadChapter(book.slug, n - 1);

  const parts: string[] = [];
  if (prior) parts.push(`## 前情（每章一句）\n${prior}`);
  if (prev) {
    const tail = prev.body.trim().slice(-500);
    parts.push(`## 上一章的结尾原文（衔接用，注意不要重复它的写法）\n……${tail}`);
  }
  if (parts.length === 0) {
    parts.push('## 前情\n这是第一章。读者对你一无所知，你对他们也一无所知。');
  }
  return parts.join('\n\n');
}

/**
 * 最近几章是怎么收尾的。
 * 连载写作最容易犯的错不是写差，是每章用同一招收尾——
 * 读者到第五章就腻了，而且说不出哪里腻。
 */
export function recentEndings(book: BookHandle, n: number, count = 3): string {
  const lines: string[] = [];
  for (let i = Math.max(1, n - count); i < n; i++) {
    const ch = loadChapter(book.slug, i);
    if (!ch) continue;
    const tail = ch.body.trim().split(/\n{2,}/).slice(-2).join(' ');
    lines.push(`- 第${i}章结尾：……${tail.slice(-80)}`);
  }
  if (lines.length === 0) return '';
  return `## 最近几章是怎么收尾的（这一章不许用同样的方式）\n${lines.join('\n')}`;
}

export function promiseBrief(book: BookHandle, n: number): string {
  const all = book.bible.promises;
  const open = openPromises(all, n);
  const overdue = overduePromises(all, n);
  const soon = promisesDueSoon(all, n, 3);

  const fmt = (p: Promise_) => `- [${p.id}] ${p.text}（第${p.plantedAt}章埋，应在第${p.dueBy}章前还）`;

  const out: string[] = [];
  if (overdue.length) {
    out.push(
      `## ⚠ 已逾期未还的债（读者已经在心里记账了）\n${overdue.map(fmt).join('\n')}`,
    );
  }
  if (soon.length) {
    out.push(`## 近期该还的债\n${soon.map(fmt).join('\n')}`);
  }
  const openIds = new Set([...overdue, ...soon].map((p) => p.id));
  const rest = open.filter((p) => !openIds.has(p.id));
  if (rest.length) out.push(`## 尚未回收的伏笔\n${rest.map(fmt).join('\n')}`);

  return out.join('\n\n');
}

export function factsBrief(book: BookHandle, n: number): string {
  const facts = loadFacts(book.slug).filter((f) => f.chapter < n);
  if (facts.length === 0) return '';
  return `## 已经写进正文的事实（不许改口）\n${facts.map((f) => `- ${f.subject}：${f.fact}（第${f.chapter}章）`).join('\n')}`;
}
