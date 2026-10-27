import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBook, shelfQuery, shelfHref, safeShelfReturn, selectBooks, genreOptions, PAGE_SIZE, type ShelfBook } from './catalogue.ts';
import { renderCatalogue } from './catalogueView.ts';

const query = (value = '') => shelfQuery(new URLSearchParams(value));
const book = (slug: string, patch: Partial<ShelfBook> = {}): ShelfBook => ({
  slug, title: slug, author: 'Author', tagline: '', synopsis: '', tags: [], status: '连载中', state: 'ongoing',
  chapters: 3, firstChapter: 1, lastChapter: 3, wordCount: 6000, addedAt: 100, updatedAt: 100, ...patch,
});
const books = [
  book('a', { title: '甲', tags: ['仙侠', '美食'], tagline: '厨房', addedAt: 300, updatedAt: 400 }),
  book('b', { title: '乙', tags: ['悬疑', '心理'], synopsis: '城市', updatedAt: 500 }),
  book('c', { title: '丙', tags: ['仙侠', '解谜'], state: 'completed', status: '已完结', addedAt: 200, updatedAt: 200 }),
  book('d', { title: '丁', tags: ['奇幻', '悬疑'], chapters: 0, firstChapter: 0, lastChapter: 0, state: 'upcoming', updatedAt: 0 }),
];
test('search intersects exact genre and publication state, and searches existing descriptions', () => {
  assert.deepEqual(selectBooks(books, query('genre=仙侠&status=completed')).books.map(b => b.slug), ['c']);
  assert.deepEqual(selectBooks(books, query('q=城市')).books.map(b => b.slug), ['b']);
  assert.deepEqual(selectBooks(books, query('q=仙侠 厨房')).books.map(b => b.slug), ['a']);
  assert.equal(selectBooks(books, query('genre=仙')).total, 0);
  assert.equal(selectBooks(books, query('q=不存在')).total, 0);
  assert.equal(selectBooks(books, query('status=upcoming')).books[0]?.slug, 'd');
});
test('new arrivals and recently updated are distinct orderings', () => {
  assert.deepEqual(selectBooks(books, query()).books.map(b => b.slug), ['b', 'a', 'c', 'd']);
  assert.deepEqual(selectBooks(books, query('sort=newest')).books.map(b => b.slug), ['a', 'c', 'b', 'd']);
});
test('pagination is bounded, deterministic and retains filters in navigation URLs', () => {
  const many = Array.from({ length: 53 }, (_, i) => book(`book-${String(i).padStart(3, '0')}`, { tags: ['仙侠'] }));
  const q = query('genre=仙侠&sort=newest&page=2');
  const second = selectBooks(many, q);
  assert.equal(second.books.length, PAGE_SIZE);
  assert.equal(second.pages, 3);
  assert.equal(second.books[0]?.slug, 'book-024');
  assert.equal(selectBooks(many, { ...q, page: 999 }).books.length, 5);
  const href = new URL(shelfHref(q, { page: 3 }), 'http://local');
  assert.equal(href.searchParams.get('genre'), '仙侠');
  assert.equal(href.searchParams.get('sort'), 'newest');
  assert.equal(href.searchParams.get('page'), '3');
});
test('malformed query values are normalized; return links cannot leave the library', () => {
  assert.equal(query('page=-3&sort=evil&status=evil').page, 1);
  assert.equal(query('page=Infinity').page, 1);
  assert.equal(query('sort=evil').sort, 'updated');
  for (const raw of ['https://evil.test/', '//evil.test/', '/b/a', 'javascript:alert(1)', '/\\evil.test/']) assert.equal(safeShelfReturn(raw), '', raw);
  const target = safeShelfReturn('/?q=abc&genre=仙侠&page=2&unknown=x');
  const parsed = new URL(target, 'http://local');
  assert.equal(parsed.searchParams.get('q'), 'abc');
  assert.equal(parsed.searchParams.get('page'), '2');
  assert.equal(parsed.searchParams.has('unknown'), false);
});
test('catalogue uses existing genre labels without duplicates and tolerates no published chapter', () => {
  const summary = summarizeBook('empty', { title: 'Empty', genre: '仙侠 · 美食 · 仙侠' }, []);
  assert.deepEqual(summary.tags, ['仙侠', '美食']);
  assert.equal(summary.state, 'upcoming');
  assert.equal(summary.lastChapter, 0);
  assert.equal(genreOptions(books).find(o => o.name === '悬疑')?.count, 2);
});
test('four-book overview escapes metadata and keeps private/unavailable chapters out of reading history', () => {
  const html = renderCatalogue([...books, book('unsafe', { title: '</script><img src=x onerror=alert(1)>', tagline: '<svg onload=alert(1)>' })], query());
  assert.equal((html.match(/class="shelf-card"/g) ?? []).length, 5);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<svg onload='));
  const match = html.match(/id="shelf-index">([^<]+)<\/script>/);
  const index = JSON.parse(match![1]!);
  assert.ok(index.every((b: { slug: string }) => b.slug !== 'd'));
  assert.equal(index.find((b: { slug: string }) => b.slug === 'unsafe').title, '</script><img src=x onerror=alert(1)>');
  assert.ok(!html.includes('/b/d/0'));
});
