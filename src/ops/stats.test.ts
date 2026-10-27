import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayStats, formatStats, readLog } from './stats.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const now = 1_800_000_000;
const line = (ip: string, uri: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: now - 60,
    request: { remote_ip: ip, uri, headers: { 'User-Agent': ['Mozilla/5.0'], Referer: [] } },
    status: 200,
    ...extra,
  });

test('独立访客按 IP 去重，静态与健康检查不计入', () => {
  const lines = readLog(
    (() => {
      const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 'a.log');
      writeFileSync(
        p,
        [
          line('1.1.1.1', '/'),
          line('1.1.1.1', '/b/x/1'),
          line('2.2.2.2', '/b/x/1'),
          line('2.2.2.2', '/static/theme.css'),
          line('3.3.3.3', '/healthz'),
        ].join('\n'),
      );
      return p;
    })(),
  );
  const s = dayStats(lines, now - 86400);
  assert.equal(s.visitors, 2);
  assert.equal(s.pageviews, 3);
  assert.equal(s.chaptersRead, 2);
});

test('漏斗按第 1 章到第 3 章的独立 IP 算', () => {
  const lines = [
    line('a', '/b/x/1'),
    line('a', '/b/x/2'),
    line('a', '/b/x/3'),
    line('b', '/b/x/1'),
    line('c', '/b/x/1'),
    line('c', '/b/x/3'),
  ].map((l) => JSON.parse(l));
  const s = dayStats(lines, now - 86400);
  assert.deepEqual(s.funnels[0] && { c1: s.funnels[0].c1, c3: s.funnels[0].c3 }, { c1: 3, c3: 2 });
  assert.ok(s.funnels[0]!.rate3 > 0.66 && s.funnels[0]!.rate3 < 0.67);
});

test('爬虫不计入来客', () => {
  const lines = [
    { ts: now - 60, request: { remote_ip: 'bot', uri: '/', headers: { 'User-Agent': ['Googlebot/2.1'] } }, status: 200 },
    { ts: now - 60, request: { remote_ip: 'human', uri: '/', headers: { 'User-Agent': ['Mozilla/5.0'] } }, status: 200 },
  ];
  assert.equal(dayStats(lines, now - 86400).visitors, 1);
});

test('同一本书 6 小时内读两章以上才算真人读者', () => {
  const base = now - 3600;
  const mk = (ip: string, uri: string, off: number) => ({
    ts: base + off,
    request: { remote_ip: ip, uri, headers: { 'User-Agent': ['Mozilla/5.0'], Referer: [] } },
    status: 200,
  });
  // 60 秒读完一章：人
  const human = dayStats([mk('a', '/b/x/1', 0), mk('a', '/b/x/2', 60), mk('b', '/b/x/1', 0)], now - 86400);
  assert.equal(human.readers, 1);
  // 2 秒翻一章：爬虫
  const crawler = dayStats([mk('c', '/b/x/1', 0), mk('c', '/b/x/2', 2)], now - 86400);
  assert.equal(crawler.readers, 0);
});

test('扫描器路径不计入访问', () => {
  const s = dayStats(
    [
      { ts: now - 60, request: { remote_ip: 'bot', uri: '//xmlrpc.php', headers: { 'User-Agent': ['Mozilla/5.0'] } }, status: 200 },
    ],
    now - 86400,
  );
  assert.equal(s.visitors, 0);
});

test('报告包含三个数与漏斗', () => {
  const lines = [line('a', '/'), line('a', '/b/x/1')].map((l) => JSON.parse(l));
  const text = formatStats(dayStats(lines, now - 86400));
  assert.match(text, /来访 IP 1/);
  assert.match(text, /第3章到达/);
});
