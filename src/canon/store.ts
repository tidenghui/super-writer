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
  /** 性别。写手据此选「他 / 她」，批评家据此查人称。 */
  gender?: 'male' | 'female';
  /** 签名特征：步态、口癖、习惯动作。写手必须照此描写，检查器按此拦截。 */
  signature?: string[];
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
  /**
   * 这一章成立所依赖的**书里已经存在的东西**：物件、地点、关系、事实。
   * 引擎逐条回查，书里没有的就退回重写。
   * 高潮章最容易犯这个错：它默认读者已经知道一堆前面没埋的东西。
   */
  requires?: string[];
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
  /**
   * 预定发布时间（ISO）。没有这个字段的章当作「早就发了」。
   * 生产和发布解耦：写多快都行，到点才放出来。
   */
  publishAt?: string;
}

/** 北京时间的下一个晚上 20:00（无夏令时，直接 +8） */
const BJ_OFFSET = 8 * 3600_000;
export function nextPublishSlot(afterMs: number): number {
  const DAY = 86400_000;
  const bj = afterMs + BJ_OFFSET;
  let slot = Math.floor(bj / DAY) * DAY + 20 * 3600_000;
  if (slot <= bj) slot += DAY;
  return slot - BJ_OFFSET;
}

/** 给新章排下一个发布槽：接在已有排期之后 */
export function schedulePublish(metas: ChapterMeta[]): string {
  const last = metas
    .map((m) => (m.publishAt ? Date.parse(m.publishAt) : NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  return new Date(nextPublishSlot(Math.max(Date.now(), last ?? 0))).toISOString();
}

/** 该发但还没发的章（按顺序，遇到未定稿或未到点就停） */
export function isLive(m: ChapterMeta, now = Date.now()): boolean {
  return !m.publishAt || Date.parse(m.publishAt) <= now;
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
    ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
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
// 硬规则：谁说不出什么话
//
// 以前写死在 lint.ts 里，结果是「第13章新立的规矩，第14章就失效」。
// 现在放在圣经里，归档时可以往里追加。
// ─────────────────────────────────────────────────────────────

export interface HardRule {
  who: string;
  aliases: string[];
  /** 这个词一旦出现在他的话里，就是越界 */
  cannotSay: string[];
  /** 这些短语不能出现在他出现的同一段里（比如把别人的步态安到他身上） */
  notNear?: string[];
  why: string;
  /** 从第几章开始生效 */
  sinceChapter?: number;
}

export function loadRules(slug: string): HardRule[] {
  const seed = resolve(bookDir(slug), 'bible', 'rules.json');
  const auto = resolve(bookDir(slug), 'canon', 'rules.auto.json');
  const out: HardRule[] = [];
  for (const p of [seed, auto]) {
    if (!existsSync(p)) continue;
    out.push(...(JSON.parse(read(p)) as HardRule[]));
  }
  return out;
}

/**
 * 引擎自己抽出来的规则（不许人工编辑）。
 * 和 bible/rules.json 分开存：那份是人给的种子，这份是长出来的。
 */
export function loadAutoRules(slug: string): HardRule[] {
  const p = resolve(bookDir(slug), 'canon', 'rules.auto.json');
  return existsSync(p) ? (JSON.parse(read(p)) as HardRule[]) : [];
}

export function saveAutoRulesForChapter(slug: string, chapter: number, rules: HardRule[]): void {
  const kept = loadAutoRules(slug).filter((r) => r.sinceChapter !== chapter);
  const all = [...kept, ...rules.map((r) => ({ ...r, sinceChapter: chapter }))];
  writeAtomic(resolve(bookDir(slug), 'canon', 'rules.auto.json'), JSON.stringify(all, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────────
// 角色特征：引擎从正文里长出来的，不许人工编辑
// ─────────────────────────────────────────────────────────────

export interface Trait {
  /** 角色 id 或名字 */
  who: string;
  /** 走路姿态、口癖、习惯动作、说话方式 */
  trait: string;
  fromChapter: number;
}

// ─────────────────────────────────────────────────────────────
// 物件名录：引擎从正文里长出来的「这本书里已经存在的东西」
//
// 写手最高频的硬伤不是句子差，是「需要一个东西，就随手造一个」：
// 纸背凭空多个「手」字、凭空多一根麻绳、把时辰写成卯时。
// 给它一张名录，它就知道自己手里有什么。
// ─────────────────────────────────────────────────────────────

export interface Entity {
  name: string;
  kind: '物件' | '地点' | '规矩' | '称谓';
  note?: string;
  fromChapter: number;
}

export function loadEntities(slug: string): Entity[] {
  const p = resolve(bookDir(slug), 'canon', 'entities.json');
  return existsSync(p) ? (JSON.parse(read(p)) as Entity[]) : [];
}

export function saveEntitiesForChapter(slug: string, chapter: number, items: Entity[]): void {
  const kept = loadEntities(slug).filter((e) => e.fromChapter !== chapter);
  const seen = new Set(kept.map((e) => e.name));
  const fresh = items.map((e) => ({ ...e, fromChapter: chapter })).filter((e) => !seen.has(e.name));
  writeAtomic(
    resolve(bookDir(slug), 'canon', 'entities.json'),
    JSON.stringify([...kept, ...fresh], null, 2) + '\n',
  );
}

// ─────────────────────────────────────────────────────────────
// 数字账本：还剩几份墨、离死期几天、几个人
//
// 第10章五次没过，全栽在同一个地方：三份墨开一份用一半，剩的该是两份半，
// 正文写成一份半；倒计时六天→三天→四天，越写越乱。
// 这类错完全由代码能管，不该让批评家去发现。
// ─────────────────────────────────────────────────────────────

export interface LedgerEntry {
  /** 这个数是什么：剩墨 / 剩天数 / 在场人数 */
  key: string;
  /** 本章结束时的值 */
  value: string;
  unit?: string;
  fromChapter: number;
}

export function loadLedger(slug: string): LedgerEntry[] {
  const p = resolve(bookDir(slug), 'canon', 'ledger.json');
  return existsSync(p) ? (JSON.parse(read(p)) as LedgerEntry[]) : [];
}

export function saveLedgerForChapter(slug: string, chapter: number, items: LedgerEntry[]): void {
  const kept = loadLedger(slug).filter((e) => e.fromChapter !== chapter);
  writeAtomic(
    resolve(bookDir(slug), 'canon', 'ledger.json'),
    JSON.stringify([...kept, ...items.map((e) => ({ ...e, fromChapter: chapter }))], null, 2) + '\n',
  );
}

/** 每个 key 取最新一版 */
export function currentLedger(slug: string, beforeChapter: number): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of loadLedger(slug).filter((x) => x.fromChapter < beforeChapter)) {
    const prev = byKey.get(e.key);
    if (!prev || prev.fromChapter < e.fromChapter) byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

export function loadTraits(slug: string): Trait[] {
  const p = resolve(bookDir(slug), 'canon', 'traits.json');
  return existsSync(p) ? (JSON.parse(read(p)) as Trait[]) : [];
}

export function saveTraitsForChapter(slug: string, chapter: number, traits: Trait[]): void {
  const kept = loadTraits(slug).filter((t) => t.fromChapter !== chapter);
  const seen = new Set(kept.map((t) => `${t.who}|${t.trait}`));
  const fresh = traits
    .map((t) => ({ ...t, fromChapter: chapter }))
    .filter((t) => !seen.has(`${t.who}|${t.trait}`));
  writeAtomic(
    resolve(bookDir(slug), 'canon', 'traits.json'),
    JSON.stringify([...kept, ...fresh], null, 2) + '\n',
  );
}

export function saveRules(slug: string, rules: HardRule[]): void {
  writeAtomic(resolve(bookDir(slug), 'bible', 'rules.json'), JSON.stringify(rules, null, 2) + '\n');
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
  /** 结局方向：续写时要用它继续约束章纲，不能丢 */
  endingHint?: string;
}

export function saveBookInfo(slug: string, info: BookInfo): void {
  writeAtomic(resolve(bookDir(slug), 'book.json'), JSON.stringify(info, null, 2) + '\n');
}

export function saveCharacters(slug: string, characters: Character[]): void {
  writeAtomic(
    resolve(bookDir(slug), 'bible', 'characters.json'),
    JSON.stringify(characters, null, 2) + '\n',
  );
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
