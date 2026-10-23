#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, ROOT, runsDir, resolveRole, checkCriticDiversity } from './engine/config.ts';
import { runChapter, runWithCandidates } from './engine/chapter.ts';
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
          ...(flag('revise') ? { maxRevisions: Number(flag('revise')) } : {}),
        });

  if (has('print')) console.log('\n' + '─'.repeat(60) + '\n' + res.body);
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

  const text = metas
    .map((m) => {
      const ch = loadChapter(slug, m.n);
      return `\n\n### 第${m.n}章《${m.title}》\n${ch?.body ?? ''}`;
    })
    .join('');


  const res = await callLLM({
    role: 'auditor',
    system: `你是这本连载小说的连续性总编。你唯一的工作是把已经写出来的全部章节从头读一遍，找出作者自己看不见的漂移。

找出这些：
- 角色口吻变形（越写越像同一个人）
- 与设定冲突
- 前后矛盾的事实（物件、时间、地点、伤势）
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
      `## 全书正文`,
      text,
      `## 输出`,
      `{
  "drift": [{"kind":"口吻|设定|事实|伏笔|重复","where":"第X章","quote":"原文","problem":"...","fix":"..."}],
  "biggestRisk": "如果只修一处，最该修哪里"
}`,
    ].join('\n\n---\n\n'),
    json: true,
    maxTokens: 12000,
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

  // 黄金三章跑三个变体挑一个，之后一天一章
  await runWithCandidates(slug, next, next <= 3 ? 3 : 1);
}

function help(): void {
  console.log(`
  超级写作 · 无人值守中文连载引擎

    npm run doctor [--ping]                     检查环境和 API key（--ping 真实调一次）
    npm run chapter -- --n 1 [--book slug]      生成一章
    npm run canon   [--book slug]               看看故事圣经和伏笔账本
    npm run audit   [--book slug]               全书漂移审计
    npm run night   [--book slug]               夜班：审计 + 写下一章（给 crontab 用）

  选项
    --revise N      最多修订几轮（默认：黄金三章 3 轮，之后 2 轮）
    --candidates K  同一章跑 K 个变体，挑最好的那个落盘（第一章建议 3）
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
