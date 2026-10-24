import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from 'node:fs';
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
  /** 故事内的第几天（从 0 起）。有倒计时的书用它驱动节奏。 */
  day?: number;
  /** 本章出场角色的 id。写死它，写手才不会自己造人。 */
  cast?: string[];
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

/**
 * 原子写：先写临时文件，再 rename。
 * 流水线在写、阅读器在读，同一台机器上并发跑——不能让读者读到半截章节。
 */
export function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
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

  writeAtomic(resolve(dir, `${pad}.md`), body.trim() + '\n');
  writeAtomic(resolve(dir, `${pad}.meta.json`), JSON.stringify(full, null, 2));
  return full;
}

/**
 * 写某一章的事实。
 * 必须按章替换而不是追加：重跑一章时，旧版本的事实必须消失，
 * 否则被丢弃的草稿会把它编出来的"事实"留在账本里，污染后面所有章节。
 */
export function replaceFacts(slug: string, chapter: number, facts: Fact[]): void {
  const dir = resolve(bookDir(slug), 'canon');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'facts.jsonl');

  const kept = existsSync(path)
    ? read(path)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Fact)
        .filter((f) => f.chapter !== chapter)
    : [];

  const all = [...kept, ...facts];
  writeAtomic(path, all.map((f) => JSON.stringify(f)).join('\n') + (all.length ? '\n' : ''));
}

/**
 * 删掉某一章自动生成的伏笔。
 * 圣经里手写的伏笔（p1、p2…）不能被删，所以自动生成的用 g{章}-{序} 前缀。
 */
export function dropGeneratedPromises(promises: Promise_[], chapter: number): Promise_[] {
  const prefix = `g${chapter}-`;
  return promises.filter((p) => !p.id.startsWith(prefix));
}

export function saveOutline(slug: string, outline: Outline): void {
  writeAtomic(resolve(bookDir(slug), 'bible', 'outline.json'), JSON.stringify(outline, null, 2) + '\n');
}

export function savePromises(slug: string, promises: Promise_[]): void {
  const p = resolve(bookDir(slug), 'bible', 'promises.json');
  writeAtomic(p, JSON.stringify(promises, null, 2) + '\n');
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


/** 只改元数据，不动正文 */
export function patchChapterMeta(slug: string, n: number, patch: Partial<ChapterMeta>): void {
  const pad = String(n).padStart(3, '0');
  const path = resolve(bookDir(slug), 'chapters', `${pad}.meta.json`);
  if (!existsSync(path)) return;
  const cur = readJson<ChapterMeta>(path);
  writeAtomic(path, JSON.stringify({ ...cur, ...patch }, null, 2));
}
