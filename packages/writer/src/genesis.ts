/**
 * 出题。
 *
 * 以前这个环节是我手写的：premise、world、style、characters、卷纲。
 * 那是全书唯一还由人写的部分，也是最贵的一部分——它决定了后面所有章节的天花板。
 *
 * 现在人只给两样东西：
 *   - seed：一句话的故事内核
 *   - ending：一句话的结局方向（方向性决策，仍然属于人）
 * 其余由策划自己长出来。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callLLM } from './llm.ts';
import { extractJson } from './json.ts';
import { saveBookInfo, saveCharacters, saveOutline, savePromises } from '../../contract/src/index.ts';
import { bookDir } from './config.ts';
import type { BookInfo, Character, ChapterBeat, Outline } from '../../contract/src/index.ts';

export interface GenesisOptions {
  slug: string;
  seed: string;
  ending: string;
  /** 目标章数。中篇 12–16。 */
  chapters?: number;
  author?: string;
}

interface GenesisDraft {
  title: string;
  tagline: string;
  genre: string;
  synopsis: string;
  premise: string;
  world: string;
  style: string;
  characters: Array<Omit<Character, 'gender' | 'signature'> & { gender?: 'male' | 'female' }>;
  acts: Array<{ name: string; from: number; to: number; gist: string }>;
  chapters: Array<{
    n: number;
    title: string;
    purpose: string;
    hook: string;
    day?: number;
    plant?: string[];
  }>;
}

const SCHEMA = `{
  "title": "书名",
  "tagline": "一句能印在封面上的话",
  "genre": "题材 · 标签",
  "synopsis": "两百字以内的故事简介",
  "premise": "Markdown。核心命题：这本书在讲什么、主角要什么、挡他的是什么、结局方向是什么。",
  "world": "Markdown。世界的规则、禁忌、代价、纪年、地理、势力。必须写清『什么做不到』——负面清单比正面设定更重要。",
  "style": "Markdown。叙述人称、句子长度、对话密度、禁止的写法。",
  "characters": [{"id":"英文小写id","name":"中文名","role":"protagonist|antagonist|supporting","gender":"male|female","age":"十七","appearance":"外形，写具体的","voice":"他怎么说话，写能模仿的特征","wants":"他想要什么","fears":"他怕什么","secret":"他的秘密","arc":"他的弧线","status":"alive","firstChapter":1}],
  "acts": [{"name":"卷一 · 标题","from":1,"to":8,"gist":"这一卷发生什么"}],
  "chapters": [{"n":1,"title":"章名","purpose":"这一章要完成什么","hook":"章末钩子的意图","day":0,"plant":["要埋的债"]}]
}`;

export async function createBook(opts: GenesisOptions): Promise<void> {
  const chapters = opts.chapters ?? 14;
  const author = opts.author ?? '灯下人';

  const res = await callLLM({
    role: 'showrunner',
    system: `你是这本书的策划，要从一句话长出一整本中篇小说的骨架。

你要给的不是"好点子"，是**能写出来的**东西。判断标准：
一个写手拿到你给的设定和卷纲，能不能不问你任何问题就往下写。

硬要求：
- 世界必须有**明确的规则和代价**，以及**做不到的事**。没有边界的设定写不长。
- 主角必须有一个具体的、可以在每章推进的**想要**。
- 结局方向由人给定，你必须让它**从设定里长出来**，不许靠临时新规则。
- 中篇 ${chapters} 章，每章 2000–3000 字。卷数 3 卷左右。
- 人物不超过 6 个，每个都要有功能。
- 一切设定必须是"可以被看见的"：能拍成画面，不是抽象概念。`,
    user: [
      `## 种子（人的一句话）`,
      opts.seed,
      `## 结局方向（人定的，不许改）`,
      opts.ending,
      `## 规模`,
      `中篇，${chapters} 章。`,
      `## 输出`,
      `只输出 JSON，不要解释，不要 Markdown 代码块。结构：`,
      SCHEMA,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 16000,
    label: 'genesis',
  });

  const d = extractJson<GenesisDraft>(res.text);

  const info: BookInfo = {
    title: d.title,
    tagline: d.tagline,
    genre: d.genre,
    author,
    status: '连载中',
    synopsis: d.synopsis,
    endingHint: opts.ending,
  };

  const characters: Character[] = d.characters.map((c) => ({
    ...c,
    gender: c.gender ?? 'male',
    status: c.status ?? 'alive',
    firstChapter: c.firstChapter ?? 1,
  }));

  const outline: Outline = {
    acts: d.acts,
    chapters: d.chapters.map(
      (c): ChapterBeat => ({
        n: c.n,
        title: c.title,
        purpose: c.purpose,
        beats: [],
        hook: c.hook,
        plant: c.plant ?? [],
        ...(c.day !== undefined ? { day: c.day } : {}),
      }),
    ),
  };

  const dir = bookDir(opts.slug);
  mkdirSync(resolve(dir, 'bible'), { recursive: true });
  mkdirSync(resolve(dir, 'chapters'), { recursive: true });
  mkdirSync(resolve(dir, 'canon'), { recursive: true });

  saveBookInfo(opts.slug, info);
  saveCharacters(opts.slug, characters);
  saveOutline(opts.slug, outline);
  savePromises(opts.slug, []);

  writeFileSync(resolve(dir, 'bible', 'premise.md'), d.premise.trim() + '\n');
  writeFileSync(resolve(dir, 'bible', 'world.md'), d.world.trim() + '\n');
  writeFileSync(resolve(dir, 'bible', 'style.md'), d.style.trim() + '\n');
  writeFileSync(resolve(dir, 'bible', 'rules.json'), '[]\n');

  console.log(`\n  《${d.title}》${d.tagline}`);
  console.log(`  ${d.genre}｜${characters.length} 个角色｜${outline.acts.length} 卷｜${outline.chapters.length} 章`);
  console.log(`  人物：${characters.map((c) => c.name).join('、')}\n`);
}
