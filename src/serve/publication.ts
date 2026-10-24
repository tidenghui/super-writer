import type { ChapterMeta } from '../canon/store.ts';

/** All public entry points share the same contiguous, published prefix. */
export function publishedChapters(metas: ChapterMeta[], now = Date.now()): ChapterMeta[] {
  const out: ChapterMeta[] = [];
  for (const meta of [...metas].sort((a, b) => a.n - b.n)) {
    if (meta.n !== out.length + 1 || meta.status !== 'accepted') break;
    if (meta.publishAt) {
      const at = Date.parse(meta.publishAt);
      if (!Number.isFinite(at) || at > now) break;
    }
    out.push(meta);
  }
  return out;
}
