import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishedChapters } from './publication.ts';
import type { ChapterMeta } from '../canon/store.ts';

const chapter = (n: number, patch: Partial<ChapterMeta> = {}): ChapterMeta => ({
  n, title: `Chapter ${n}`, status: 'accepted', wordCount: 0, summary: '',
  createdAt: '2026-10-24T00:00:00Z', ...patch,
});
const now = Date.parse('2026-10-24T12:00:00Z');
test('publication stops at a draft and hides accepted chapters after it', () => {
  assert.deepEqual(publishedChapters([chapter(1), chapter(2, { status: 'draft' }), chapter(3)], now).map(m => m.n), [1]);
});
test('scheduled chapter and all later chapters stay private until its release', () => {
  const metas = [chapter(1), chapter(2, { publishAt: '2026-10-24T13:00:00Z' }), chapter(3)];
  assert.equal(publishedChapters(metas, now).length, 1);
  assert.equal(publishedChapters(metas, now + 3600000).length, 3);
});
test('a missing chapter number cannot leave a hole in the public sequence', () => {
  assert.equal(publishedChapters([chapter(3), chapter(1)], now).length, 1);
  assert.equal(publishedChapters([chapter(2)], now).length, 0);
});
test('invalid publish dates fail closed; metadata input order is irrelevant', () => {
  assert.equal(publishedChapters([chapter(1, { publishAt: 'invalid' })], now).length, 0);
  assert.deepEqual(publishedChapters([chapter(2), chapter(1)], now).map(m => m.n), [1, 2]);
  assert.deepEqual(publishedChapters([], now), []);
});
