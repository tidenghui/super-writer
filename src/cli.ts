#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, ROOT, runsDir, resolveRole, checkCriticDiversity } from './engine/config.ts';
import { runChapter, runWithCandidates, recanonChapter, fixChapter, rereadChapter, polishChapter, runMany, buildBacklog } from './engine/chapter.ts';
import { runAllCritics } from './engine/critics.ts';
import { runColdReaders, firstScreenAll, comparePair } from './engine/coldRead.ts';
import { isMock } from './engine/mock.ts';
import { expandOutline } from './engine/outline.ts';
import { readFileSync } from 'node:fs';
import { enableCallLog } from './engine/util.ts';
import { callLLM } from './engine/llm.ts';
import { extractJson } from './engine/json.ts';
import {
  listBooks,
  listChapterMetas,
  loadBook,
  openPromises,
  overduePromises,
  loadChapter,
} from './canon/store.ts';

loadEnv();

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ─────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  console.log('\n检查环境\n');

  if (isMock()) {
    const books = listBooks();
    console.log(`  模式        \x1b[33mmock（离线演练，不需要 API key）\x1b[0m`);
    console.log(`  项目根目录  ${ROOT}`);
    console.log(`  找到的书    ${books.length ? books.join('、') : '（无）'}`);
    console.log('\n  \x1b[32m可以跑。\x1b[0m 试试：SW_MOCK=1 npm run chapter -- --n 1\n');
    return;
  }

  const books = listBooks();
  console.log(`  项目根目录  ${ROOT}`);
  console.log(`  找到的书    ${books.length ? books.join('、') : '（无）'}`);

  let ok = true;

  for (const role of ['writer', 'critic', 'planner'] as const) {
    try {
      const r = resolveRole(role);
      console.log(`  ${role.padEnd(9)} ${r.provider}/${r.model}  ✓  ${r.baseUrl}`);
    } catch (e) {
      ok = false;
      console.log(`  ${role.padEnd(9)} \x1b[31m${(e as Error).message.split('\n')[0]}\x1b[0m`);
    }
  }

  const div = checkCriticDiversity();
  console.log(`\n  ${div.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m'} ${div.message}`);

  if (!ok) {
    console.log('\n  \x1b[33m先修好上面的问题：cp .env.example .env.local 然后填 key。\x1b[0m\n');
    process.exitCode = 1;
    return;
  }

  if (has('ping')) {
    try {
      const r = await callLLM({
        role: 'writer',
        system: '你是一台在自检的机器。',
        user: '只回复两个字：就绪',
        maxTokens: 16,
        label: 'doctor-ping',
      });
      console.log(`\n  \x1b[32m✓ 真实调用成功\x1b[0m（${r.model}，${r.ms}ms）：${r.text.trim().slice(0, 20)}`);
    } catch (e) {
      console.log(`\n  \x1b[31m✗ 真实调用失败\x1b[0m：${(e as Error).message.split('\n')[0]}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n  \x1b[32m配置就绪。\x1b[0m 跑一章试试：npm run chapter -- --book cangjingge --n 1\n');
}

async function cmdChapter(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const nRaw = flag('n');
  if (!nRaw) throw new Error('缺 --n <章号>');

  const dir = resolve(runsDir(slug), runId());
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));
  console.log(`\x1b[2m日志：${dir}/calls.jsonl\x1b[0m`);

  const n = Number(nRaw);
  const candidates = Number(flag('candidates') ?? 1);

  const res =
    candidates > 1
      ? await runWithCandidates(slug, n, candidates)
      : await runChapter({
          bookSlug: slug,
          n,
          ...(has('resume') ? { resume: true } : {}),
          ...(flag('revise') ? { maxRevisions: Number(flag('revise')) } : {}),
        });

  if (has('print')) console.log('\n' + '─'.repeat(60) + '\n' + res.body);
}

async function cmdFix(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const n = Number(flag('n'));
  const note = flag('m');
  if (!n) throw new Error('缺 --n <章号>');
  if (!note) throw new Error('缺 --m "<批注>"');

  const dir = resolve(runsDir(slug), `fix-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  const r = await fixChapter(slug, n, note);
  console.log(
    `\n  第 ${n} 章：应用 ${r.applied} 处，跳过 ${r.skipped} 处　${r.before} → ${r.after} 字\n`,
  );
  if (r.applied > 0) {
    console.log('  记得跑一次 recanon 对齐事实表：npm run recanon -- --n ' + n + '\n');
  }
}

/**
 * 标定读者分身。
 *
 * 一个从来不说「不」的测试，测不出任何东西。
 * 每次换模型、改提示词之后跑一次：烂稿必须被拒绝，真稿必须被接受。
 * 如果哪天烂稿也能拿 3/3，说明这套判据已经失效了。
 */
/** 卷纲 → 章纲：让策划把干瘪的梗概扩成可以直接开写的章纲 */
async function cmdOutline(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const from = Number(flag('from'));
  const to = Number(flag('to'));
  if (!from || !to) throw new Error('缺 --from 和 --to');

  const book = loadBook(slug);
  const dir = resolve(runsDir(slug), `outline-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  console.log(`\n  扩写章纲 第 ${from}–${to} 章\n`);
  const reports = await expandOutline(book, from, to);

  const bad = reports.filter((r) => !r.reviewed);
  console.log(
    `\n  完成 ${reports.length} 章${bad.length ? `，其中 ${bad.length} 章复核仍有问题` : '，全部复核通过'}\n`,
  );
}

/** 补缓冲：写到手上有 N 章待发为止 */
async function cmdBacklog(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const dir = resolve(runsDir(slug), `backlog-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));
  await buildBacklog(slug, Number(flag('ahead') ?? 5));
}

/** 连更：从第 X 章写到第 Y 章，中途失败就停下，不硬撑 */
async function cmdWrite(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const from = Number(flag('from'));
  const to = Number(flag('to'));
  if (!from || !to) throw new Error('缺 --from 和 --to');

  const dir = resolve(runsDir(slug), runId());
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  await runMany(slug, from, to);
}

/** 只打分，不改稿——用来做前后对比 */
async function cmdScore(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const book = loadBook(slug);
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const targets = has('all') ? metas.map((m) => m.n) : [Number(flag('n') ?? metas[0]?.n)];

  const dir = resolve(runsDir(slug), `score-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  for (const n of targets) {
    if (!n) continue;
    const ch = loadChapter(slug, n);
    if (!ch) continue;
    const run = await runAllCritics(book, n, ch.body);
    const avg = run.ok.reduce((x, c) => x + c.score, 0) / Math.max(1, run.ok.length);
    const hard = run.ok.flatMap((c) => c.defects).filter((d) => d.severity === 'blocker').length;
    console.log(
      `  第 ${n} 章　${run.ok.map((c) => c.score).join('｜')}　均分 ${avg.toFixed(2)}　blocker ${hard}`,
    );
  }
  console.log('');
}

/** 段落级打磨：只重写最弱的几段，原稿也可以赢 */
async function cmdPolish(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const targets = has('all') ? metas.map((m) => m.n) : [Number(flag('n') ?? metas[0]?.n)];

  const dir = resolve(runsDir(slug), `polish-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  for (const n of targets) {
    if (!n) continue;
    console.log(`\n  第 ${n} 章`);
    const r = await polishChapter(slug, n, Number(flag('paras') ?? 3));
    for (const p of r.picked) {
      console.log(`    ${p.kept ? '\x1b[2m保留原稿\x1b[0m' : '\x1b[32m已替换\x1b[0m'}　${p.why}`);
    }
    console.log(`    ${r.before} → ${r.after} 字`);
  }
  console.log('');
}

/** 首屏测试：只看开头 300 字，会不会继续滑 */
async function cmdFirstScreen(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const book = loadBook(slug);
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const targets = has('all') ? metas.map((m) => m.n) : [Number(flag('n') ?? metas[0]?.n)];

  const dir = resolve(runsDir(slug), `firstscreen-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  for (const n of targets) {
    if (!n) continue;
    const ch = loadChapter(slug, n);
    if (!ch) continue;
    const opening = ch.body.slice(0, 320);
    const rs = await firstScreenAll(book, n, opening);
    const keep = rs.filter((r) => r.keepReading).length;
    console.log(`\n  第 ${n} 章　前 320 字　${keep}/${rs.length} 会继续滑`);
    for (const r of rs) {
      console.log(`    ${r.persona}：${r.keepReading ? '继续' : '退出'}｜${r.reason}`);
      if (r.stoppedAt) console.log(`      差点划走：「${r.stoppedAt}」`);
    }
  }
  console.log('');
}

/** 两两对比给章节的开头排名——绝对打分区分不出来，逼着选才知道谁最弱 */
async function cmdCompare(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const book = loadBook(slug);
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');

  const dir = resolve(runsDir(slug), `compare-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  const chapters = metas
    .map((m) => {
      const ch = loadChapter(slug, m.n);
      return ch ? { n: m.n, text: ch.body.slice(0, 320) } : null;
    })
    .filter((c): c is { n: number; text: string } => !!c);

  const wins = new Map<number, number>();
  for (const c of chapters) wins.set(c.n, 0);

  for (let i = 0; i < chapters.length; i++) {
    for (let j = i + 1; j < chapters.length; j++) {
      const a = chapters[i]!;
      const b = chapters[j]!;
      const rs = await comparePair(book, a, b);
      for (const r of rs) {
        if (r.winner === 'a') wins.set(a.n, (wins.get(a.n) ?? 0) + 1);
        else if (r.winner === 'b') wins.set(b.n, (wins.get(b.n) ?? 0) + 1);
      }
      const aw = rs.filter((r) => r.winner === 'a').length;
      const bw = rs.filter((r) => r.winner === 'b').length;
      console.log(`  第${a.n}章 vs 第${b.n}章　${aw} : ${bw}`);
      for (const r of rs) console.log(`     ${r.persona}→ ${r.winner === 'a' ? a.n : r.winner === 'b' ? b.n : '都不'}　${r.why}`);
    }
  }

  const ranked = [...wins.entries()].sort((x, y) => y[1] - x[1]);
  const best = ranked[0]?.[1] ?? 0;

  console.log('\n  开头排名（胜场，满分 ' + (chapters.length - 1) * 3 + '）');
  for (const [n, w] of ranked) {
    const noise = best - w <= 2 ? ' \x1b[2m(与榜首差距在噪声范围内)\x1b[0m' : '';
    console.log(`    第 ${n} 章　${w} 胜${noise}`);
  }
  console.log(
    '\n  \x1b[2m每对只投 3 票，单次排名的噪声约 ±3 胜。' +
      '只可信榜首和榜尾，中间的名次别当真；要可靠排序需多跑几轮取中位数。\x1b[0m\n',
  );
}

async function cmdCalibrate(): Promise<void> {
  const book = loadBook('cangjingge');
  const bad = readFileSync(resolve(ROOT, 'fixtures/bad-chapter.md'), 'utf8');
  const good = loadChapter('cangjingge', 1)?.body ?? '';
  if (!good) throw new Error('先跑出第一章再标定');

  const dir = resolve(runsDir('cangjingge'), `calibrate-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  const badRun = await runColdReaders(book, 1, bad);
  const goodRun = await runColdReaders(book, 1, good);

  const badVotes = badRun.ok.filter((r) => r.willContinue).length;
  const goodVotes = goodRun.ok.filter((r) => r.willContinue).length;

  console.log(`\n  烂稿　${badVotes}/${badRun.ok.length} 会继续`);
  for (const r of badRun.ok) console.log(`    ${r.persona}：${r.verdict}`);
  console.log(`\n  第一章　${goodVotes}/${goodRun.ok.length} 会继续`);
  for (const r of goodRun.ok) console.log(`    ${r.persona}：${r.verdict}`);

  // 首屏也要能分辨：烂稿的开头不该让人想往下滑
  const badFirst = await firstScreenAll(book, 1, bad.slice(0, 320));
  const goodFirst = await firstScreenAll(book, 1, good.slice(0, 320));
  const badKeep = badFirst.filter((r) => r.keepReading).length;
  const goodKeep = goodFirst.filter((r) => r.keepReading).length;

  console.log(`\n  烂稿首屏　${badKeep}/${badFirst.length} 会继续滑`);
  for (const r of badFirst) console.log(`    ${r.persona}：${r.keepReading ? '继续' : '退出'}｜${r.reason}`);
  console.log(`\n  第一章首屏　${goodKeep}/${goodFirst.length} 会继续滑`);

  const gap = goodVotes - badVotes;
  const gapFirst = goodKeep - badKeep;
  const ok = gap >= 2 && gapFirst >= 2;
  console.log(
    `\n  整章判别力 ${gap >= 2 ? '\x1b[32m足够\x1b[0m' : '\x1b[31m不足\x1b[0m'}（${gap}）　` +
      `首屏判别力 ${gapFirst >= 2 ? '\x1b[32m足够\x1b[0m' : '\x1b[31m不足\x1b[0m'}（${gapFirst}）\n`,
  );
  if (!ok) process.exitCode = 1;
}

async function cmdReread(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const targets = has('all')
    ? metas.map((m) => m.n)
    : [Number(flag('n') ?? metas.at(-1)?.n)];

  const dir = resolve(runsDir(slug), `reread-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  for (const n of targets) {
    if (!n) continue;
    const rs = await rereadChapter(slug, n);
    const votes = rs.filter((r) => r.willContinue).length;
    console.log(`\n  第 ${n} 章　${votes}/${rs.length} 会继续`);
    for (const r of rs) console.log(`    ${r.persona}：${r.verdict}`);
    if (has('all')) continue;
  }
  console.log('');
}

async function cmdRecanon(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const n = Number(flag('n'));
  if (!n) throw new Error('缺 --n <章号>');
  const dir = resolve(runsDir(slug), `recanon-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));
  await recanonChapter(slug, n);
}

async function cmdCanon(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const book = loadBook(slug);
  const metas = listChapterMetas(slug);
  const latest = metas.at(-1)?.n ?? 0;

  console.log(`\n《${slug}》\n`);
  console.log(`  角色    ${book.bible.characters.map((c) => c.name).join('、')}`);
  console.log(`  大纲    ${book.bible.outline.chapters.length} 章 / ${book.bible.outline.acts.length} 卷`);
  console.log(`  已写    ${metas.length} 章（最新第 ${latest} 章）`);

  const open = openPromises(book.bible.promises, latest + 1);
  const over = overduePromises(book.bible.promises, latest + 1);

  console.log(`\n  未回收伏笔 ${open.length} 条:`);
  for (const p of open) {
    const late = over.some((o) => o.id === p.id);
    console.log(
      `    ${late ? '\x1b[31m逾期\x1b[0m' : '\x1b[2m  ok\x1b[0m'} [${p.id}] ${p.text}　(第${p.dueBy}章前)`,
    );
  }

  if (metas.length) {
    console.log('\n  章节:');
    for (const m of metas) {
      const flagTxt = m.status === 'accepted' ? '\x1b[32m✓\x1b[0m' : '\x1b[33m·\x1b[0m';
      const cr = m.coldRead ? `冷读 ${m.coldRead.votes}/${m.coldRead.total}` : '';
      console.log(`    ${flagTxt} ${String(m.n).padStart(2)} ${m.title}　${m.wordCount}字　${cr}`);
    }
  }
  console.log('');
}

interface DriftReport {
  drift: Array<{ kind: string; where: string; quote: string; problem: string; fix: string }>;
  biggestRisk: string;
}

async function auditBook(slug: string): Promise<DriftReport> {
  const book = loadBook(slug);
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  if (metas.length === 0) throw new Error('还没有任何章节');

  // 不吃全书原文：摘要 + 事实表 + 最近 5 章。省 60% 输入，判断更聚焦。
  const recent = metas.slice(-5);
  const recentText = recent
    .map((m) => {
      const ch = loadChapter(slug, m.n);
      return `### 第${m.n}章《${m.title}》\n${ch?.body ?? ''}`;
    })
    .join('\n\n');

  const summaries = metas.map((m) => `第${m.n}章《${m.title}》：${m.summary || '（无摘要）'}`).join('\n');

  const res = await callLLM({
    role: 'auditor',
    system: `你是这本连载小说的连续性总编。你唯一的工作是把书从头读一遍，找出作者自己看不见的漂移。

找出这些：
- 角色口吻变形（越写越像同一个人）
- 与设定冲突
- 前后矛盾的事实（物件、时间、地点、伤势、人称）
- 埋了没还的伏笔
- 重复使用的桥段和句式

你不评价文笔好不好，只找漂移。`,
    user: [
      `## 世界设定（作为判据）`,
      book.bible.world,
      `## 未回收的伏笔`,
      book.bible.promises
        .filter((p) => p.paidAt === null)
        .map((p) => `- [${p.id}] ${p.text}（应在第${p.dueBy}章前还）`)
        .join('\n'),
      `## 全书章节摘要`,
      summaries,
      `## 最近 ${recent.length} 章原文`,
      recentText,
      `## 输出`,
      `只输出 JSON，不要解释，不要 Markdown 代码块。drift 最多 6 条，挑最要命的：`,
      `{
  "drift": [{"kind":"口吻|设定|事实|伏笔|重复","where":"第X章","quote":"原文","problem":"...","fix":"..."}],
  "biggestRisk": "如果只修一处，最该修哪里"
}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 6000,
    label: 'audit',
  });

  return extractJson<DriftReport>(res.text);
}

async function cmdAudit(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const metas = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const dir = resolve(runsDir(slug), `audit-${runId()}`);
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));
  console.log(`\n全书审计：${metas.length} 章\n`);

  const report = await auditBook(slug);

  console.log('漂移报告\n');
  for (const d of report.drift ?? []) {
    console.log(`  [${d.kind}] ${d.where}　「${d.quote}」`);
    console.log(`    ${d.problem}`);
    console.log(`    → ${d.fix}\n`);
  }
  console.log(`\n最大的风险：${report.biggestRisk}\n`);
}

// ─────────────────────────────────────────────────────────────

/**
 * 夜班：无人值守跑一整轮。
 * 把它挂到 crontab 上，就是「24 小时不间断」的真实形态。
 */
async function cmdNight(): Promise<void> {
  const slug = flag('book') ?? 'cangjingge';
  const book = loadBook(slug);
  const total = book.bible.outline.chapters.length;
  const accepted = listChapterMetas(slug).filter((m) => m.status === 'accepted');
  const next = (accepted.at(-1)?.n ?? 0) + 1;

  if (next > total) {
    console.log(`\n《${slug}》已经写完（${total} 章）。\n`);
    return;
  }

  // 上一章还在草稿状态时，不许往下写——否则书里会留一个洞
  const prevMeta = listChapterMetas(slug).find((m) => m.n === next - 1);
  if (prevMeta && prevMeta.status !== 'accepted') {
    console.log(
      `\n  第 ${next - 1} 章还是草稿，先修好它再写第 ${next} 章。\n` +
        `  npm run fix -- --n ${next - 1} --m "..."  或  npm run chapter -- --n ${next - 1}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const dir = resolve(runsDir(slug), runId());
  mkdirSync(dir, { recursive: true });
  enableCallLog(resolve(dir, 'calls.jsonl'));

  console.log(`\n\x1b[1m夜班\x1b[0m · 第 ${next}/${total} 章`);
  console.log(`\x1b[2m日志：${dir}/calls.jsonl\x1b[0m\n`);

  if (next > 3) {
    console.log('  \x1b[2m审计\x1b[0m 重读全书，找漂移…');
    try {
      const r = await auditBook(slug);
      console.log(
        `  \x1b[2m审计\x1b[0m ${r.drift?.length ?? 0} 处漂移｜最大风险：${r.biggestRisk}`,
      );
      for (const d of (r.drift ?? []).slice(0, 3)) {
        console.log(`         [${d.kind}] ${d.where}　${d.problem}`);
      }
      console.log('');
    } catch (e) {
      console.log(`  \x1b[2m审计\x1b[0m 跳过：${(e as Error).message.split('\n')[0]}\n`);
    }
  }

  // 产发分离：把待发缓冲补到 N 章，而不是只写一章
  await buildBacklog(slug, Number(flag('ahead') ?? 5));
}

function help(): void {
  console.log(`
  超级写作 · 无人值守中文连载引擎

    npm run doctor [--ping]                     检查环境和 API key（--ping 真实调一次）
    npm run chapter -- --n 1 [--book slug]      生成一章
    npm run canon   [--book slug]               看看故事圣经和伏笔账本
    npm run firstscreen [--n 1 | --all]         首屏测试：只看开头 320 字
    npm run compare                             两两对比，给各章开头排名
    npm run score   [--n 1 | --all]             只打分不改稿，做前后对比
    npm run polish  [--n 1 | --all] [--paras 3] 段落级打磨
    npm run calibrate                           标定读者分身：烂稿必须被拒绝
    npm run reread  [--n 1 | --all]             重跑读者测（不改正文）
    npm run fix     -- --n 3 --m "批注"          按人工批注定点修订一章
    npm run recanon -- --n 1                    从定稿正文重算某章的事实与伏笔
    npm run audit   [--book slug]               全书漂移审计
    npm run night   [--book slug]               夜班：审计 + 写下一章（给 crontab 用）
    npm run backlog [--ahead 5]                 补缓冲：写到手上有 N 章待发
    npm run outline -- --from 13 --to 20        把梗概扩成章纲（策划自己写）
    npm run write   -- --from 7 --to 10         连更若干章

  选项
    --revise N      最多修订几轮（默认：黄金三章 3 轮，之后 2 轮）
    --candidates K  同一章跑 K 个变体，挑最好的那个落盘（第一章建议 3）
    --resume        续修：不重新起草，直接对已有草稿重跑审稿和修订
    --print       生成完把正文打到终端

  书的目录：books/<slug>/bible/
`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'doctor':
      return doctor();
    case 'chapter':
      return cmdChapter();
    case 'canon':
      return cmdCanon();
    case 'recanon':
      return cmdRecanon();
    case 'reread':
      return cmdReread();
    case 'calibrate':
      return cmdCalibrate();
    case 'firstscreen':
      return cmdFirstScreen();
    case 'compare':
      return cmdCompare();
    case 'backlog':
      return cmdBacklog();
    case 'outline':
      return cmdOutline();
    case 'write':
      return cmdWrite();
    case 'score':
      return cmdScore();
    case 'polish':
      return cmdPolish();
    case 'fix':
      return cmdFix();
    case 'audit':
      return cmdAudit();
    case 'night':
      return cmdNight();
    default:
      return help();
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m出错了：\x1b[0m${(err as Error).message}\n`);
  process.exitCode = 1;
});
