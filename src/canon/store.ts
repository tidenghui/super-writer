import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bookDir } from '../engine/config.ts';
import { countChars } from '../engine/json.ts';

// ─────────────────────────────────────────────────────────────
// 类型：故事圣经 + 章节产物
// ─────────────────────────────────────────────────────────────

export interface Character {
  id: string;
  name: string;
  role: 'protagonist' | 'ally' | 'antagonist' | 'bystander';
  age?: string;
  appearance: string;
  /** 说话方式：这是防「所有角色一个腔调」的唯一有效约束 */
  voice: string;
  wants: string;
  fears: string;
  secret?: string;
  arc: string;
  status: 'alive' | 'dead' | 'missing' | 'transformed';
  firstChapter: number;
}

export interface Promise_ {
  id: string;
  /** 对读者许下的承诺，一句话 */
  text: string;
  plantedAt: number;
  /** 最迟必须在第几章回收 */
  dueBy: number;
  paidAt: number | null;
  importance: 1 | 2 | 3;
}

export interface ChapterBeat {
  n: number;
  title: string;
  /** 这一章在整本书里的功能（为什么存在） */
  purpose: string;
  beats: string[];
  /** 章末必须留下的钩子 */
  hook: string;
  plant?: string[];
  pay?: string[];
  newFacts?: string[];
}

export interface Outline {
  acts: Array<{ name: string; from: number; to: number; gist: string }>;
  chapters: ChapterBeat[];
}

export interface ChapterMeta {
  n: number;
  title: string;
  status: 'draft' | 'accepted';
  wordCount: number;
  summary: string;
  coldRead?: { votes: number; total: number; notes: string[] };
  critics?: Array<{ name: string; score: number; verdict: string; defects: number }>;
  revisions?: number;
  costCny?: number;
  createdAt: string;
}

export interface Bible {
  premise: string;
  world: string;
  style: string;
  characters: Character[];
  outline: Outline;
  promises: Promise_[];
}

export interface Fact {
  id: string;
  chapter: number;
  subject: string;
  fact: string;
}

export interface BookHandle {
  slug: string;
  dir: string;
  bible: Bible;
}

// ─────────────────────────────────────────────────────────────
// 读取
// ─────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(p, 'utf8');
const readJson = <T>(p: string): T => JSON.parse(read(p)) as T;

export function loadBook(slug: string): BookHandle {
  const dir = bookDir(slug);
  const b = resolve(dir, 'bible');
  if (!existsSync(b)) {
    throw new Error(`找不到书的圣经目录：${b}\n先运行 npm run canon 看看有哪些书。`);
  }

  const bible: Bible = {
    premise: read(resolve(b, 'premise.md')),
    world: read(resolve(b, 'world.md')),
    style: read(resolve(b, 'style.md')),
    characters: readJson<Character[]>(resolve(b, 'characters.json')),
    outline: readJson<Outline>(resolve(b, 'outline.json')),
    promises: readJson<Promise_[]>(resolve(b, 'promises.json')),
  };

  return { slug, dir, bible };
}

export function listBooks(): string[] {
  const root = resolve(bookDir('__none__'), '..');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function listChapterMetas(slug: string): ChapterMeta[] {
  const dir = resolve(bookDir(slug), 'chapters');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => readJson<ChapterMeta>(resolve(dir, f)))
    .sort((a, b) => a.n - b.n);
}

export function loadChapter(slug: string, n: number): { meta: ChapterMeta; body: string } | null {
  const dir = resolve(bookDir(slug), 'chapters');
  const pad = String(n).padStart(3, '0');
  const md = resolve(dir, `${pad}.md`);
  const metaPath = resolve(dir, `${pad}.meta.json`);
  if (!existsSync(md) || !existsSync(metaPath)) return null;
  return { meta: readJson<ChapterMeta>(metaPath), body: read(md) };
}

export function loadFacts(slug: string): Fact[] {
  const p = resolve(bookDir(slug), 'canon', 'facts.jsonl');
  if (!existsSync(p)) return [];
  return read(p)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Fact);
}

// ─────────────────────────────────────────────────────────────
// 写入
// ─────────────────────────────────────────────────────────────

export function saveChapter(
  slug: string,
  n: number,
  title: string,
  body: string,
  meta: Partial<ChapterMeta> & { status: 'draft' | 'accepted' },
): ChapterMeta {
  const dir = resolve(bookDir(slug), 'chapters');
  mkdirSync(dir, { recursive: true });
  const pad = String(n).padStart(3, '0');

  const full: ChapterMeta = {
    n,
    title,
    status: meta.status,
    wordCount: countChars(body),
    summary: meta.summary ?? '',
    ...(meta.coldRead ? { coldRead: meta.coldRead } : {}),
    ...(meta.critics ? { critics: meta.critics } : {}),
    ...(meta.revisions !== undefined ? { revisions: meta.revisions } : {}),
    ...(meta.costCny !== undefined ? { costCny: meta.costCny } : {}),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(resolve(dir, `${pad}.md`), body.trim() + '\n');
  writeFileSync(resolve(dir, `${pad}.meta.json`), JSON.stringify(full, null, 2));
  return full;
}

export function appendFacts(slug: string, facts: Fact[]): void {
  if (facts.length === 0) return;
  const dir = resolve(bookDir(slug), 'canon');
  mkdirSync(dir, { recursive: true });
  appendFileSync(resolve(dir, 'facts.jsonl'), facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
}

export function savePromises(slug: string, promises: Promise_[]): void {
  const p = resolve(bookDir(slug), 'bible', 'promises.json');
  writeFileSync(p, JSON.stringify(promises, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

/** 还没回收的承诺 */
export function openPromises(promises: Promise_[], upToChapter: number): Promise_[] {
  return promises.filter((p) => p.paidAt === null && p.plantedAt <= upToChapter);
}

/** 已经逾期、还没还的债 —— 这是引擎最该尖叫的东西 */
export function overduePromises(promises: Promise_[], atChapter: number): Promise_[] {
  return promises.filter((p) => p.paidAt === null && p.dueBy < atChapter);
}

export function promisesDueSoon(promises: Promise_[], atChapter: number, window = 3): Promise_[] {
  return promises.filter(
    (p) => p.paidAt === null && p.dueBy >= atChapter && p.dueBy <= atChapter + window,
  );
}

export function summaryIndex(metas: ChapterMeta[], upTo: number): string {
  return metas
    .filter((m) => m.n < upTo && m.summary)
    .map((m) => `第${m.n}章《${m.title}》：${m.summary}`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// 书的元信息（阅读器用；引擎不依赖它）
// ─────────────────────────────────────────────────────────────

export interface BookInfo {
  title: string;
  tagline?: string;
  genre?: string;
  author?: string;
  status?: string;
  synopsis?: string;
}

export function loadBookInfo(slug: string): BookInfo {
  const p = resolve(bookDir(slug), 'book.json');
  if (!existsSync(p)) return { title: slug };
  const raw = readJson<Partial<BookInfo>>(p);
  return { title: raw.title ?? slug, ...raw };
}
