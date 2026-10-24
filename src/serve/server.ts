/** File-backed, server-rendered reading platform. No build step or external assets. */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listBooks, loadBookInfo, listChapterMetas, loadChapter, type ChapterMeta } from '../canon/store.ts';
import { publishedChapters } from './publication.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, 'theme.css'), 'utf8');
const CLIENT = readFileSync(resolve(HERE, 'reader.js'), 'utf8');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const SITE_URL = (process.env.SITE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const SITE_NAME = process.env.SITE_NAME ?? '提灯会';
const SITE_TAGLINE = process.env.SITE_TAGLINE ?? '每晚，多一盏灯。';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const bookUrl = (slug: string) => `/b/${encodeURIComponent(slug)}`;
const feedUrl = (slug: string) => `/feed.xml?book=${encodeURIComponent(slug)}`;
function live(slug: string): ChapterMeta[] {
  const chapters: ChapterMeta[] = [];
  for (const meta of publishedChapters(listChapterMetas(slug))) {
    if (!loadChapter(slug, meta.n)) break;
    chapters.push(meta);
  }
  return chapters;
}
const date = (iso: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(iso));
const words = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n.toLocaleString('zh-CN')} 字`;
const lantern = `<svg class="lantern" viewBox="0 0 32 40" aria-hidden="true"><path d="M12 3h8M16 3v4M10 32h12M16 33v5"/><rect x="6" y="8" width="20" height="23" rx="8"/><path d="M16 9c-7 7-7 14 0 21M16 9c7 7 7 14 0 21M7 19h18"/></svg>`;
function header(back?: { href: string; text: string }): string {
  return `<header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="${esc(SITE_NAME)}首页">${lantern}<span>${esc(SITE_NAME)}</span></a><nav aria-label="主导航">${back ? `<a href="${back.href}">${esc(back.text)}</a>` : '<a class="nav-current" href="/#library">书库</a>'}<button class="icon-button" data-open="settings" aria-haspopup="dialog" aria-label="打开阅读设置">◐ <span>阅读设置</span></button></nav></div></header>`;
}
function settings(): string {
  return `<dialog id="settings" class="settings panel" aria-labelledby="settings-title"><div class="panel-head"><div><span class="eyebrow">READING PREFERENCES</span><h2 id="settings-title">让阅读更合心意</h2></div><button class="icon-button" data-close aria-label="关闭阅读设置">✕</button></div>
  <fieldset><legend>背景</legend><div class="choices"><button data-theme-choice="light">纸白</button><button data-theme-choice="sepia">暖纸</button><button data-theme-choice="dark">夜读</button><button data-theme-choice="system">跟随系统</button></div></fieldset>
  <fieldset><legend>字号 <output id="font-size-value">19</output></legend><div class="size-control"><button data-size="-1" aria-label="缩小字号">A−</button><span class="setting-sample">灯下，读一页书。</span><button data-size="1" aria-label="放大字号">A＋</button></div></fieldset>
  <fieldset><legend>行距</legend><div class="choices"><button data-leading="1.7">紧凑</button><button data-leading="1.95">适中</button><button data-leading="2.25">宽松</button></div></fieldset>
  <fieldset><legend>字体</legend><div class="choices"><button data-font="serif">宋体</button><button data-font="sans">黑体</button></div></fieldset>
  <p class="panel-note">偏好与阅读进度保存在当前浏览器。</p></dialog>`;
}
function layout(title: string, body: string, theme: string | null, slug?: string): string {
  const validTheme = ['light', 'dark', 'sepia'].includes(theme ?? '') ? theme : null;
  return `<!doctype html><html lang="zh-CN"${validTheme ? ` data-theme="${validTheme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${esc(title === SITE_NAME ? title : `${title} · ${SITE_NAME}`)}</title><link rel="stylesheet" href="/static/theme.css"><link rel="alternate" type="application/rss+xml" title="RSS 订阅" href="${slug ? feedUrl(slug) : '/feed.xml'}"><link rel="icon" href="/static/lantern.svg" type="image/svg+xml">
  <script>(function(){try{var r=document.documentElement,t=localStorage.getItem('sw:theme');if(!r.dataset.theme&&['light','dark','sepia'].includes(t))r.dataset.theme=t;var f=parseInt(localStorage.getItem('sw:fs'));if(f>=16&&f<=28)r.style.setProperty('--fs',f+'px');var l=localStorage.getItem('sw:leading');if(['1.7','1.95','2.25'].includes(l))r.style.setProperty('--leading',l);if(localStorage.getItem('sw:font')==='sans')r.dataset.font='sans';}catch(e){}})();</script><script src="/static/reader.js" defer></script></head><body><a class="skip-link" href="#main">跳到主要内容</a>${body}<footer class="site-footer"><a class="brand" href="/">${lantern}${esc(SITE_NAME)}</a><span>故事在灯下继续。</span><a href="${slug ? feedUrl(slug) : '/feed.xml'}">RSS 订阅 ↗</a></footer>${settings()}</body></html>`;
}
function cover(title: string, author?: string): string {
  return `<div class="cover" aria-hidden="true"><div class="cover-frame"><span class="cover-imprint">${esc(SITE_NAME)} · 藏书</span><span class="cover-title">${esc(title)}</span><span class="cover-author">${esc(author ?? '')}</span><div class="cover-seal">灯下</div></div><div class="cover-orbit"></div></div>`;
}
function readAction(slug: string, chapters: ChapterMeta[], preview = false): string {
  if (!chapters.length) return '<span class="empty-inline">故事正在准备中</span>';
  return `<a class="button primary" href="${bookUrl(slug)}/${chapters[0]!.n}${preview ? '?draft=1' : ''}" ${preview ? '' : `data-resume="${esc(slug)}" data-available="${chapters.map(c => c.n).join(',')}"`}>从第一章开始 <span aria-hidden="true">→</span></a>`;
}
function libraryPage(theme: string | null): string {
  const slugs = listBooks();
  const cards = slugs.map((slug, index) => {
    const info = loadBookInfo(slug), chapters = live(slug), latest = chapters.at(-1);
    return `<article class="featured-book"><a class="cover-link" href="${bookUrl(slug)}" aria-label="查看${esc(info.title)}">${cover(info.title, info.author)}</a><div class="book-copy"><div class="eyebrow">${String(index + 1).padStart(2, '0')} / 灯下藏书 <span class="status-dot">${esc(info.status ?? '连载')}</span></div><h2><a href="${bookUrl(slug)}">${esc(info.title)}</a></h2>${info.tagline ? `<p class="book-tagline">${esc(info.tagline)}</p>` : ''}<div class="book-meta">${[info.genre, info.author, chapters.length ? `${chapters.length} 章 · ${words(chapters.reduce((sum, c) => sum + c.wordCount, 0))}` : '即将开始'].filter(Boolean).map(s => `<span>${esc(s!)}</span>`).join('')}</div><div class="book-actions">${readAction(slug, chapters)}<a class="text-link" href="${bookUrl(slug)}">作品详情 ↗</a></div>${latest ? `<a class="latest" href="${bookUrl(slug)}/${latest.n}"><span>最近更新 · ${date(latest.publishAt ?? latest.createdAt)}</span><strong>第 ${latest.n} 章　${esc(latest.title)}</strong><span aria-hidden="true">→</span></a>` : ''}</div></article>`;
  }).join('');
  return layout(SITE_NAME, `${header()}<main id="main" class="wide"><section class="home-intro"><div><p class="eyebrow">TIDENGHUI · 在线阅读</p><h1>留一盏灯，<br>读一个好故事<span class="accent">。</span></h1><p class="intro-sub">${esc(SITE_TAGLINE)}</p></div><div class="intro-mark" aria-hidden="true">${lantern}<span>灯火可亲 · 故事未完</span></div></section><section id="library" aria-labelledby="library-title"><div class="section-heading"><h2 id="library-title">灯下书架</h2><span>${slugs.length} 部作品</span></div>${cards || '<div class="empty"><h2>书架静候新故事</h2><p>作品准备好后，会在这里与你见面。</p></div>'}</section><aside class="subscription"><div><span class="eyebrow">KEEP A LIGHT ON</span><h2>下次，接着读。</h2><p>阅读进度会留在这台设备上。也可以通过 RSS 订阅更新。</p></div><a class="button secondary" href="/feed.xml">订阅更新 ↗</a></aside></main>`, theme);
}
function chapterRows(slug: string, chapters: ChapterMeta[], current?: number, preview = false): string {
  return chapters.map((c, i) => `<a class="toc-row${c.n === current ? ' current' : ''}" data-chapter="${c.n}" href="${bookUrl(slug)}/${c.n}${preview ? '?draft=1' : ''}"${c.n === current ? ' aria-current="page"' : ''}><span class="toc-no">${String(c.n).padStart(2, '0')}</span><span class="toc-title">${esc(c.title)}</span><span class="chapter-label">${c.n === current ? '正在读' : c.status !== 'accepted' ? '草稿' : i === chapters.length - 1 ? '最新' : ''}</span><span class="toc-words">${words(c.wordCount)}</span></a>`).join('');
}
function tocPage(slug: string, theme: string | null, preview: boolean): string {
  const info = loadBookInfo(slug), chapters = preview ? listChapterMetas(slug) : live(slug), latest = chapters.at(-1);
  const synopsis = (info.synopsis ?? '').split('\n').filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
  return layout(info.title, `${header({ href: '/#library', text: '返回书架' })}<main id="main" class="wide" data-book="${esc(slug)}">${preview ? '<div class="preview-banner">草稿预览 · 仅供内部查看</div>' : ''}<section class="book-detail"><div class="detail-cover">${cover(info.title, info.author)}</div><div class="detail-copy"><p class="eyebrow">${esc(info.genre ?? '灯下藏书')} <span class="status-dot">${esc(info.status ?? '连载')}</span></p><h1>${esc(info.title)}</h1><p class="author">${esc(info.author ?? '')}</p>${info.tagline ? `<p class="book-tagline">${esc(info.tagline)}</p>` : ''}<div class="book-stats"><span><strong>${chapters.length}</strong> 章</span><span><strong>${words(chapters.reduce((sum, c) => sum + c.wordCount, 0))}</strong></span>${latest ? `<span>${date(latest.publishAt ?? latest.createdAt)} 更新</span>` : ''}</div><div class="book-actions">${readAction(slug, chapters, preview)}${latest ? `<a class="button secondary" href="${bookUrl(slug)}/${latest.n}${preview ? '?draft=1' : ''}">看最新章</a>` : ''}</div>${synopsis ? `<details class="synopsis"><summary>作品简介 <span>展开 / 收起</span></summary><div>${synopsis}</div></details>` : ''}</div></section><section class="catalogue" id="catalogue" aria-labelledby="catalogue-title"><div class="section-heading"><div><h2 id="catalogue-title">章节目录 <span>共 ${chapters.length} 章</span></h2><p class="reading-note" data-reading-note>从第一页，走进故事。</p></div><button class="text-button" data-sort aria-pressed="false">倒序排列 ↓</button></div><div class="chapter-list" data-chapter-list>${chapterRows(slug, chapters, undefined, preview) || '<div class="empty">第一章正在准备中。</div>'}</div></section><aside class="subscription compact"><div><h2>把故事留在订阅里</h2><p>使用 RSS 阅读器接收新章更新。</p></div><a class="button secondary" href="${feedUrl(slug)}">订阅本书 ↗</a></aside></main>`, theme, slug);
}
function chapterPage(slug: string, n: number, theme: string | null, preview: boolean): string | null {
  const chapters = preview ? listChapterMetas(slug) : live(slug);
  if (!chapters.some(m => m.n === n)) return null;
  const ch = loadChapter(slug, n);
  if (!ch) return null;
  const info = loadBookInfo(slug), index = chapters.findIndex(m => m.n === n), prev = chapters[index - 1], next = chapters[index + 1];
  const url = (no: number) => `${bookUrl(slug)}/${no}${preview ? '?draft=1' : ''}`;
  const paragraphs = ch.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return layout(`${ch.meta.title} · ${info.title}`, `${header({ href: bookUrl(slug), text: info.title })}<main id="main" class="reader-main" data-book="${esc(slug)}" data-chapter-number="${n}"${preview ? ' data-preview="true"' : ''}><aside class="desktop-rail"><button class="rail-button" data-open="directory" aria-haspopup="dialog">☷<span>目录</span></button><button class="rail-button" data-open="settings" aria-haspopup="dialog">Aa<span>设置</span></button><a class="rail-button" href="${bookUrl(slug)}">↗<span>书页</span></a></aside><article class="reading-page">${preview ? '<div class="preview-banner">草稿预览 · 仅供内部查看</div>' : ''}<header class="chapter-head"><a class="eyebrow" href="${bookUrl(slug)}">${esc(info.title)}</a><p class="chapter-no">第 ${n} 章 <span> / ${chapters.length}</span></p><h1>${esc(ch.meta.title)}</h1><p class="chapter-info">${words(ch.meta.wordCount)}<span>·</span>约 ${Math.max(1, Math.ceil(ch.meta.wordCount / 500))} 分钟</p><div class="chapter-ornament" aria-hidden="true">◆</div></header><div class="prose">${paragraphs}</div><section class="chapter-end" aria-label="章末导航"><span class="end-mark" aria-hidden="true">${lantern}</span>${next ? `<p>这一页读完，故事还在继续。</p><a class="button primary next-chapter" data-next href="${url(next.n)}"><span>下一章 <strong>${esc(next.title)}</strong></span><span aria-hidden="true">→</span></a>` : `<h2>已读到最新</h2><p>下次回来，接着读。</p><a class="button primary" href="${feedUrl(slug)}">订阅本书更新 ↗</a>`}<div class="end-links">${prev ? `<a data-prev href="${url(prev.n)}">← 上一章</a>` : '<span>这是第一章</span>'}<a href="${bookUrl(slug)}#catalogue">全部目录</a></div></section></article><div class="reading-toolbar" aria-label="阅读工具"><button data-open="directory" aria-haspopup="dialog">☷ <span>目录</span></button>${prev ? `<a href="${url(prev.n)}">← <span>上一章</span></a>` : '<span class="disabled">← 上一章</span>'}<button data-open="settings" aria-haspopup="dialog">Aa <span>设置</span></button>${next ? `<a href="${url(next.n)}"><span>下一章</span> →</a>` : '<span class="disabled">已到最新</span>'}<span class="reading-progress" role="progressbar" aria-label="本章阅读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></span></div><dialog id="directory" class="directory panel" aria-labelledby="directory-title"><div class="panel-head"><div><span class="eyebrow">${esc(info.title)}</span><h2 id="directory-title">章节目录</h2></div><button class="icon-button" data-close aria-label="关闭目录">✕</button></div><div class="drawer-chapters">${chapterRows(slug, chapters, n, preview)}</div><a class="drawer-footer" href="${bookUrl(slug)}">查看作品详情 ↗</a></dialog></main>`, theme, slug);
}
function feedXml(slug: string): string {
  const info = loadBookInfo(slug), chapters = live(slug).slice(-20).reverse();
  const items = chapters.map(m => {
    const plain = (loadChapter(slug, m.n)?.body ?? '').replace(/\s+/g, ' ').slice(0, 140);
    const url = `${SITE_URL}${bookUrl(slug)}/${m.n}`;
    return `<item><title>${esc(`${m.n}. ${m.title}`)}</title><link>${esc(url)}</link><guid isPermaLink="true">${esc(url)}</guid><pubDate>${new Date(m.publishAt ?? m.createdAt).toUTCString()}</pubDate><description>${esc(plain)}</description></item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(`${info.title} · ${SITE_NAME}`)}</title><link>${esc(`${SITE_URL}${bookUrl(slug)}`)}</link><description>${esc(info.tagline ?? info.title)}</description><language>zh-CN</language>${items}</channel></rss>`;
}
function sitemapXml(): string {
  const urls = [`${SITE_URL}/`];
  for (const slug of listBooks()) {
    urls.push(`${SITE_URL}${bookUrl(slug)}`);
    for (const m of live(slug)) urls.push(`${SITE_URL}${bookUrl(slug)}/${m.n}`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${esc(u)}</loc></url>`).join('')}</urlset>`;
}
function authorizedPreview(authorization: string | undefined): boolean {
  const token = process.env.SW_PREVIEW_TOKEN;
  if (!token || !authorization) return false;
  const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
  const wantsPreview = url.searchParams.get('draft') === '1';
  const theme = url.searchParams.get('theme');
  const send = (status: number, body: string, type = 'text/html; charset=utf-8', cache?: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': wantsPreview ? 'private, no-store' : cache ?? (status === 200 ? 'public, max-age=120' : 'no-store'), 'x-content-type-options': 'nosniff', ...(wantsPreview ? { 'x-robots-tag': 'noindex, nofollow' } : {}) });
    res.end(body);
  };
  const error = (status: number, title: string, message: string) => send(status, layout(title, `${header()}<main id="main" class="wide empty error-page"><p class="eyebrow">${status}</p><h1>${title}</h1><p>${message}</p><a class="button primary" href="/">回到书架 →</a></main>`, theme));
  try {
    if (wantsPreview && !authorizedPreview(req.headers.authorization)) return error(403, '此页仅供内部预览', '请返回书架，阅读已发布的章节。');
    if (path === '/static/theme.css') return send(200, CSS, 'text/css; charset=utf-8', 'public, max-age=60');
    if (path === '/static/reader.js') return send(200, CLIENT, 'text/javascript; charset=utf-8', 'public, max-age=60');
    if (path === '/static/lantern.svg') return send(200, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40"><rect width="32" height="40" rx="8" fill="#f5f1e8"/><g fill="none" stroke="#ae4635" stroke-width="2"><path d="M12 3h8M16 3v4M10 32h12M16 33v5"/><rect x="6" y="8" width="20" height="23" rx="8"/><path d="M16 9c-7 7-7 14 0 21M16 9c7 7 7 14 0 21"/></g></svg>`, 'image/svg+xml');
    if (path === '/healthz') return send(200, JSON.stringify({ ok: true, books: listBooks().length, chapters: listBooks().reduce((n, b) => n + live(b).length, 0) }), 'application/json; charset=utf-8', 'no-store');
    if (path === '/robots.txt') return send(200, `User-agent: *\nAllow: /\nDisallow: /*?draft=1\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'text/plain; charset=utf-8');
    if (path === '/sitemap.xml') return send(200, sitemapXml(), 'application/xml; charset=utf-8');
    if (path === '/feed.xml') {
      const slug = url.searchParams.get('book') ?? listBooks()[0];
      if (!slug || !listBooks().includes(slug)) return error(404, '没有找到这本书', '回到书架，看看其他故事。');
      return send(200, feedXml(slug), 'application/rss+xml; charset=utf-8');
    }
    if (path === '/') return send(200, libraryPage(theme));
    const m = path.match(/^\/b\/([^/]+)(?:\/(\d+))?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]!);
      if (!listBooks().includes(slug)) return error(404, '没有找到这本书', '回到书架，看看其他故事。');
      if (!m[2]) return send(200, tocPage(slug, theme, wantsPreview));
      const html = chapterPage(slug, Number(m[2]), theme, wantsPreview);
      if (html) return send(200, html);
      return error(404, '这一页还未点亮', '章节尚未发布，或页面不存在。可以返回书籍目录继续阅读。');
    }
    return error(404, '这一页走丢了', '回到书架，重新找到你的故事。');
  } catch (err) {
    console.error('reader request failed:', err);
    return error(500, '暂时无法翻开这一页', '请稍后刷新重试。');
  }
});
server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`阅读平台 http://${HOST}:${typeof address === 'object' && address ? address.port : PORT}`);
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
