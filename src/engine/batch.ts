/**
 * 一本接一本地生产。
 *
 * 运营目标要求书库有货：读者一次坐下能读 3–10 万字，
 * 两本书的站不叫平台。这个模块负责把"从种子到完本"整条链跑完，
 * 中途失败自己重试，不需要人盯着。
 */
import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { createBook } from './genesis.ts';
import { expandOutline } from './outline.ts';
import { runChapter } from './chapter.ts';
import { listChapterMetas, loadBook } from '../canon/store.ts';

export interface ProduceOptions {
  slug: string;
  genre: string;
  chapters: number;
  /** 已用过的种子，避免重复 */
  avoid?: string[];
  author?: string;
}

/** 让策划自己想一个种子和结局方向 */
export async function inventSeed(genre: string, avoid: string[] = []): Promise<{ seed: string; ending: string }> {
  const res = await callLLM({
    role: 'showrunner',
    system: `你是这家小说平台的策划。你要给出一个**能一口气读完**的中篇故事内核。

标准：
- 一句话就能让人想读
- 有具体的、可视化的核心设定，不是抽象概念
- 主角有一个贯穿全书的具体目标
- 结局能收得住，且从设定里长出来

${avoid.length ? `下面这些已经用过了，不要重复它们的设定：\n${avoid.map((a) => `- ${a}`).join('\n')}` : ''}`,
    user: [
      `题材：${genre}`,
      `只输出 JSON：{"seed":"一句话的故事内核","ending":"一句话的结局方向"}`,
    ].join('\n\n'),
    json: true,
    maxTokens: 1500,
    label: 'invent-seed',
  });

  const d = extractJson<{ seed: string; ending: string }>(res.text);
  return { seed: d.seed, ending: d.ending };
}

/** 跑完一本：出题 → 全书章纲 → 逐章写，失败的章改章纲再写 */
export async function produceBook(opts: ProduceOptions): Promise<{ ok: boolean; chapters: number; failedAt?: number }> {
  const { seed, ending } = await inventSeed(opts.genre, opts.avoid ?? []);
  console.log(`\n  【${opts.slug}】种子：${seed}`);

  await createBook({
    slug: opts.slug,
    seed,
    ending,
    chapters: opts.chapters,
    author: opts.author ?? '灯下人',
  });

  // 整本先排章纲——这是第二部首轮通过率从 47% 涨到 86% 的关键
  await expandOutline(loadBook(opts.slug), 1, opts.chapters, ending);

  for (let n = 1; n <= opts.chapters; n++) {
    let ok = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      // 连续两次不过，回头改这一章的章纲再写
      if (attempt === 3) {
        await expandOutline(loadBook(opts.slug), n, n, ending);
      }
      const r = await runChapter({ bookSlug: opts.slug, n });
      if (r.accepted) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      console.log(`  【${opts.slug}】第 ${n} 章反复不过，停止`);
      return { ok: false, chapters: n - 1, failedAt: n };
    }
  }

  const metas = listChapterMetas(opts.slug).filter((m) => m.status === 'accepted');
  const words = metas.reduce((s, m) => s + m.wordCount, 0);
  console.log(`  【${opts.slug}】完本：${metas.length} 章 / ${words} 字`);
  return { ok: true, chapters: metas.length };
}
