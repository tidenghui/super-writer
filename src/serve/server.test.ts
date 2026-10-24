import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { listBooks, listChapterMetas } from '../canon/store.ts';
import { publishedChapters } from './publication.ts';

// Uses existing local books read-only; no model calls or authored content fixtures.
let child: ChildProcess;
let origin = '';
const token = randomBytes(24).toString('hex');
const slug = listBooks()[0];
const chapters = slug ? publishedChapters(listChapterMetas(slug)) : [];
before(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/serve/server.ts'], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', SW_PREVIEW_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reader startup timed out')), 10000);
    let output = '';
    child.stdout!.on('data', data => {
      output += String(data);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Reader exited: ${code}`)); });
  });
});
after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
});
test('public pages, static assets, RSS and sitemap respond with correct content types', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/static/theme.css', 'text/css'], ['/static/reader.js', 'text/javascript'], ['/static/lantern.svg', 'image/svg+xml'], ['/sitemap.xml', 'application/xml'], ['/healthz', 'application/json']]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type')?.includes(type!), path);
  }
  if (slug) {
    const res = await fetch(`${origin}/feed.xml?book=${slug}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /application\/rss\+xml/);
  }
});
test('the no-JavaScript reading entry points to chapter one, not the latest', { skip: !chapters.length }, async () => {
  const html = await (await fetch(`${origin}/b/${slug}`)).text();
  assert.match(html, new RegExp(`href="/b/${slug}/1" data-resume=`));
  assert.ok(html.includes('从第一章开始'));
});
test('unpublished chapters and unknown books cannot be reached directly', async () => {
  assert.equal((await fetch(`${origin}/b/nonexistent-book`)).status, 404);
  assert.equal((await fetch(`${origin}/feed.xml?book=nonexistent-book`)).status, 404);
  if (slug) assert.equal((await fetch(`${origin}/b/${slug}/${chapters.length + 1}`)).status, 404);
});
test('preview requires authorization and never enters a shared cache', async () => {
  const path = slug ? `/b/${slug}?draft=1` : '/?draft=1';
  for (const authorization of ['', 'Bearer incorrect']) {
    const res = await fetch(origin + path, { headers: { authorization } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  const res = await fetch(origin + path, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});
test('theme parameters cannot inject HTML attributes', async () => {
  const html = await (await fetch(`${origin}/?theme=${encodeURIComponent('" onload="alert(1)')}`)).text();
  assert.ok(!html.includes('onload="alert(1)'));
});

test('new HTML bypasses cached unversioned CSS and JS using their content hashes', async () => {
  const html = await (await fetch(origin)).text();
  for (const name of ['theme.css', 'reader.js']) {
    const expected = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    const hash = createHash('sha256').update(expected).digest('hex').slice(0, 16);
    const versioned = `/static/${name}?v=${hash}`;
    assert.ok(html.includes(`"${versioned}"`));
    assert.ok(!html.includes(`"/static/${name}"`), 'HTML must not reuse the old browser cache key');
    const res = await fetch(origin + versioned);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), expected);
  }
});

test('inline lanterns retain a safe size and appearance when CSS is unavailable', async () => {
  const html = await (await fetch(origin)).text();
  const icons = html.match(/<svg class="lantern"[^>]*>/g) ?? [];
  assert.ok(icons.length > 0);
  for (const svg of icons) {
    assert.match(svg, /width="27" height="36"/);
    assert.match(svg, /fill="none"/);
    assert.match(svg, /stroke="#[0-9a-f]+"/);
  }
});
