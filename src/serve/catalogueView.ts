import { bookHref, coverStyle, genreOptions, selectBooks, shelfHref, type ShelfBook, type ShelfQuery } from './catalogue.ts';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const esc = escapeHtml;
export function bookCover(slug: string, title: string, author = '', siteName = '提灯会'): string {
  const { tone, layout } = coverStyle(slug);
  const length = [...title].length;
  return `<div class="cover${length > 10 ? ' cover-long-title' : ''}" data-cover-tone="${tone}" data-cover-layout="${layout}" aria-hidden="true"><div class="cover-frame"><span class="cover-imprint">${esc(siteName)} · 藏书</span><span class="cover-title">${esc(title)}</span><span class="cover-author">${esc(author)}</span><div class="cover-seal">灯下</div></div><div class="cover-orbit"></div></div>`;
}
const date = (ts: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(ts);
function pagination(query: ShelfQuery, page: number, pages: number): string {
  if (pages <= 1) return '';
  const numbers = [...new Set([1, page - 1, page, page + 1, pages])].filter(n => n > 0 && n <= pages).sort((a, b) => a - b);
  let previous = 0;
  const links = numbers.map(n => {
    const gap = previous && n - previous > 1 ? '<span aria-hidden="true">…</span>' : '';
    previous = n;
    return `${gap}<a href="${esc(shelfHref(query, { page: n }))}"${n === page ? ' aria-current="page"' : ''} aria-label="第 ${n} 页">${n}</a>`;
  }).join('');
  return `<nav class="shelf-pagination" aria-label="书库分页">${page > 1 ? `<a href="${esc(shelfHref(query, { page: page - 1 }))}">← 上一页</a>` : ''}${links}${page < pages ? `<a href="${esc(shelfHref(query, { page: page + 1 }))}">下一页 →</a>` : ''}</nav>`;
}
function bookCard(book: ShelfBook, returnTo: string, siteName: string): string {
  const detail = bookHref(book.slug, returnTo);
  const chapter = `/b/${encodeURIComponent(book.slug)}/${book.firstChapter}${returnTo ? '?from=' + encodeURIComponent(returnTo) : ''}`;
  return `<article class="shelf-card"><a class="shelf-cover" href="${esc(detail)}" aria-label="查看${esc(book.title)}">${bookCover(book.slug, book.title, book.author, siteName)}<span class="shelf-status">${esc(book.status)}</span></a><div class="shelf-copy"><div class="shelf-tags">${book.tags.slice(0, 2).map(t => `<span>${esc(t)}</span>`).join('') || '<span>灯下藏书</span>'}</div><h3><a href="${esc(detail)}">${esc(book.title)}</a></h3><p class="shelf-tagline">${esc(book.tagline || book.synopsis)}</p><p class="shelf-meta">${book.chapters ? `${book.updatedAt ? date(book.updatedAt) + ' 更新 · ' : ''}${book.chapters} 章` : '故事正在准备中'}</p>${book.chapters ? `<a class="shelf-read" href="${esc(chapter)}" data-resume="${esc(book.slug)}" data-first="${book.firstChapter}" data-last="${book.lastChapter}">开始阅读 <span aria-hidden="true">→</span></a>` : '<span class="shelf-preparing">即将开始</span>'}</div></article>`;
}
export function renderCatalogue(books: ShelfBook[], query: ShelfQuery, siteName = '提灯会', tagline = '每晚，多一盏灯。'): string {
  const result = selectBooks(books, query);
  const current = { ...query, page: result.page };
  const returnTo = shelfHref(current);
  const options = genreOptions(books);
  const filtered = !!(query.q || query.genre || query.status);
  const chip = (name: string, count?: number) => `<a class="genre-chip${query.genre === name ? ' selected' : ''}" href="${esc(shelfHref(query, { genre: name, page: 1 }))}"${query.genre === name ? ' aria-current="true"' : ''}>${esc(name || '全部')}${count === undefined ? '' : `<span>${count}</span>`}</a>`;
  const firstOptions = options.slice(0, 5);
  const moreOptions = options.slice(5);
  const index = books.filter(b => b.chapters > 0).map(b => ({ slug: b.slug, title: b.title, first: b.firstChapter, last: b.lastChapter, tone: coverStyle(b.slug).tone }));
  const data = JSON.stringify(index).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<section class="shelf-intro" aria-labelledby="shelf-intro-title"><div><p class="eyebrow">TIDENGHUI · 灯下书架</p><h1 id="shelf-intro-title"><span class="shelf-intro-phrase">留一盏灯，</span><span class="shelf-intro-phrase">读一个好故事<span class="accent">。</span></span></h1></div><p>${esc(tagline)}</p></section>
  <section class="continue-section" data-continue hidden aria-labelledby="continue-title"><div class="continue-heading"><h2 id="continue-title">接着上次读</h2><button class="text-button" data-open="history" aria-haspopup="dialog">全部记录 ↗</button></div><div class="continue-grid" data-continue-list></div></section>
  <section id="library" class="shelf-library" aria-labelledby="library-title"><div class="shelf-heading"><div><span class="eyebrow">THE COLLECTION</span><h2 id="library-title">全部作品 <span>${books.length} 部</span></h2></div><span class="shelf-note">总有一个故事，与你相遇。</span></div>
  <form class="shelf-search" action="/#library" method="get" role="search" aria-label="搜索与筛选作品"><div class="search-field"><label class="sr-only" for="shelf-q">搜索书名、题材或简介</label><span aria-hidden="true">⌕</span><input id="shelf-q" type="search" name="q" value="${esc(query.q)}" placeholder="找一本书，或一种心情…" maxlength="100"><button type="submit" aria-label="搜索作品">搜索 →</button></div>${query.genre ? `<input type="hidden" name="genre" value="${esc(query.genre)}">` : ''}<div class="shelf-selects"><label><span>状态</span><select name="status" data-shelf-select aria-label="作品状态"><option value="">全部状态</option>${[['ongoing','连载中'],['completed','已完结'],['upcoming','准备中']].map(([value, label]) => `<option value="${value}"${query.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label><span>排序</span><select name="sort" data-shelf-select aria-label="作品排序">${[['updated','最近更新'],['newest','最近上架'],['title','书名排序']].map(([value, label]) => `<option value="${value}"${query.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div><noscript><button class="button secondary" type="submit">应用筛选</button></noscript></form>
  <div class="genre-bar"><span class="genre-caption">题材</span><nav class="genre-shortcuts" aria-label="按题材浏览">${chip('')}${firstOptions.map(o => chip(o.name, o.count)).join('')}</nav>${moreOptions.length ? `<details class="genre-more"><summary${moreOptions.some(o => o.name === query.genre) ? ' class="selected"' : ''}>更多${moreOptions.some(o => o.name === query.genre) ? ' · ' + esc(query.genre) : ''} ⌄</summary><nav class="genre-popover" aria-label="更多题材">${moreOptions.map(o => chip(o.name, o.count)).join('')}</nav></details>` : ''}</div>
  ${filtered ? `<div class="search-result" role="status"><span>${query.q ? `“${esc(query.q)}” · ` : ''}${query.genre ? esc(query.genre) + ' · ' : ''}找到 ${result.total} 部作品</span><a href="${esc(shelfHref(query, { q: '', genre: '', status: '', page: 1 }))}">清除筛选 ×</a></div>` : ''}
  <div class="shelf-grid">${result.books.map(book => bookCard(book, returnTo, siteName)).join('') || `<div class="shelf-empty"><span aria-hidden="true">▤</span><h3>${books.length ? '还没有找到这本书' : '书架静候新故事'}</h3><p>${books.length ? '试试更短的关键词，或换一种题材。' : '作品准备好后，会在这里与你见面。'}</p>${books.length ? '<a class="button secondary" href="/#library">查看全部作品 →</a>' : ''}</div>`}</div>${pagination(current, result.page, result.pages)}</section>
  <aside class="shelf-footnote"><span>阅读进度留在当前浏览器，下次回来接着读。</span><a href="/feed.xml">RSS 订阅 ↗</a></aside>
  <dialog id="history" class="history panel" aria-labelledby="history-title"><div class="panel-head"><div><span class="eyebrow">YOUR READING</span><h2 id="history-title">本机阅读记录</h2></div><button class="icon-button" data-close aria-label="关闭阅读记录">✕</button></div><div class="history-list" data-history-list></div><p class="panel-note">只显示仍可阅读的章节，无需登录。</p></dialog><script type="application/json" id="shelf-index">${data}</script>`;
}
