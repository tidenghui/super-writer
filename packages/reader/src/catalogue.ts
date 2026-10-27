import type { BookInfo, ChapterMeta } from '../../contract/src/index.ts';

export interface ShelfBook {
  slug: string;
  title: string;
  author: string;
  tagline: string;
  synopsis: string;
  tags: string[];
  status: string;
  state: 'ongoing' | 'completed' | 'upcoming';
  chapters: number;
  wordCount: number;
  firstChapter: number;
  lastChapter: number;
  addedAt: number;
  updatedAt: number;
}
export interface ShelfQuery {
  q: string;
  genre: string;
  status: string;
  sort: 'updated' | 'newest' | 'title';
  page: number;
}
export const PAGE_SIZE = 24;
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function summarizeBook(slug: string, info: BookInfo, chapters: ChapterMeta[]): ShelfBook {
  const first = chapters[0], last = chapters.at(-1);
  return {
    slug, title: info.title, author: info.author ?? '', tagline: info.tagline ?? '', synopsis: info.synopsis ?? '',
    tags: [...new Set((info.genre ?? '').split(/[·・/|｜,，、;；]/u).map(tag => tag.trim()).filter(Boolean))],
    status: info.status ?? (last ? '连载中' : '准备中'),
    state: !last ? 'upcoming' : /完结|完本|已完成/.test(info.status ?? '') ? 'completed' : 'ongoing',
    chapters: chapters.length, wordCount: chapters.reduce((sum, ch) => sum + ch.wordCount, 0),
    firstChapter: first?.n ?? 0, lastChapter: last?.n ?? 0,
    addedAt: timestamp(first?.publishAt ?? first?.createdAt),
    updatedAt: timestamp(last?.publishAt ?? last?.createdAt),
  };
}
export function shelfQuery(params: URLSearchParams): ShelfQuery {
  const sort = params.get('sort');
  const page = Number(params.get('page') ?? '1');
  return {
    q: (params.get('q') ?? '').trim().slice(0, 100),
    genre: (params.get('genre') ?? '').trim().slice(0, 60),
    status: ['ongoing', 'completed', 'upcoming'].includes(params.get('status') ?? '') ? params.get('status')! : '',
    sort: sort === 'newest' || sort === 'title' ? sort : 'updated',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
export function shelfHref(query: ShelfQuery, patch: Partial<ShelfQuery> = {}): string {
  const q = { ...query, ...patch };
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.genre) params.set('genre', q.genre);
  if (q.status) params.set('status', q.status);
  if (q.sort !== 'updated') params.set('sort', q.sort);
  if (q.page > 1) params.set('page', String(q.page));
  return `/${params.size ? '?' + params.toString() : ''}#library`;
}
export function safeShelfReturn(raw: string | null): string {
  if (!raw?.startsWith('/')) return '';
  try {
    const url = new URL(raw, 'http://shelf.local');
    if (url.origin !== 'http://shelf.local' || url.pathname !== '/') return '';
    return shelfHref(shelfQuery(url.searchParams));
  } catch { return ''; }
}
export function bookHref(slug: string, returnTo = ''): string {
  return `/b/${encodeURIComponent(slug)}${returnTo ? '?from=' + encodeURIComponent(returnTo) : ''}`;
}
export function coverStyle(slug: string): { tone: string; layout: string } {
  let hash = 2166136261;
  for (const c of slug) hash = Math.imul(hash ^ c.codePointAt(0)!, 16777619) >>> 0;
  return {
    tone: ['pine', 'ochre', 'indigo', 'plum', 'slate', 'clay'][(hash >>> 16) % 6]!,
    layout: ['vertical', 'centered', 'framed'][(hash >>> 4) % 3]!,
  };
}
export function selectBooks(books: ShelfBook[], query: ShelfQuery) {
  const terms = query.q.normalize('NFKC').toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean);
  const matched = books.filter(book => {
    if (query.genre && !book.tags.includes(query.genre)) return false;
    if (query.status && book.state !== query.status) return false;
    const text = [book.title, book.author, book.tagline, book.synopsis, ...book.tags].join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN');
    return terms.every(term => text.includes(term));
  }).sort((a, b) => {
    const primary = query.sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') :
      query.sort === 'newest' ? b.addedAt - a.addedAt : b.updatedAt - a.updatedAt;
    return primary || a.slug.localeCompare(b.slug);
  });
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(query.page, pages);
  return { books: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: matched.length, pages, page };
}
export function genreOptions(books: ShelfBook[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const book of books) for (const tag of book.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const main = ['仙侠', '悬疑', '奇幻', '科幻', '都市', '历史', '言情', '现实', '武侠', '玄幻', '游戏'];
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => {
    const ai = main.indexOf(a.name), bi = main.indexOf(b.name);
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || b.count - a.count || a.name.localeCompare(b.name, 'zh-CN');
  });
}
