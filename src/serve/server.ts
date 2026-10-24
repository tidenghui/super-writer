/**
 * 阅读器。
 *
 * 设计取向：零依赖、服务端渲染、文件即数据库。
 * 一章 3000 字，用户要的是「打开就能读」，不是「等一个前端框架启动」。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listBooks,
  loadBookInfo,
  listChapterMetas,
  loadChapter,
  type ChapterMeta,
} from '../canon/store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, 'theme.css'), 'utf8');
const PORT = Number(process.env.PORT ?? 8787);
// 默认只绑本机，由反向代理（Caddy/nginx）对外。想让 Node 直接对外再改 HOST=0.0.0.0
const HOST = process.env.HOST ?? '127.0.0.1';
const SITE_URL = (process.env.SITE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const SITE_NAME = process.env.SITE_NAME ?? '提灯会';
const SITE_TAGLINE = process.env.SITE_TAGLINE ?? '每晚，多一盏灯。';

// ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title: string, body: string, theme: string | null = null): string {
  const attr = theme ? ` data-theme="${theme}"` : '';
  return `<!doctype html>
<html lang="zh-CN"${attr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(title === SITE_NAME ? title : `${title} · ${SITE_NAME}`)}</title>
<link rel="stylesheet" href="/static/theme.css">
<link rel="alternate" type="application/rss+xml" title="订阅" href="/feed.xml">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='13' y='1' width='6' height='3' rx='1' fill='%23b08a63'/><path d='M16 5c5 0 8 3 8 7v6c0 4-3 6-8 6s-8-2-8-6v-6c0-4 3-7 8-7z' fill='%23d9694f'/><path d='M16 8c3 0 5 2 5 5v4c0 2-2 3-5 3s-5-1-5-3v-4c0-3 2-5 5-5z' fill='%23f2a07b'/><rect x='14' y='24' width='4' height='4' rx='1' fill='%23b08a63'/><rect x='15' y='28' width='2' height='3' fill='%23b08a63'/></svg>">
<script>
(function(){try{
  var t=localStorage.getItem('sw:theme'); if(t) document.documentElement.dataset.theme=t;
  var f=localStorage.getItem('sw:fs'); if(f) document.documentElement.style.setProperty('--fs',f);
}catch(e){}})();
</script>
</head>
<body>
${body}
<footer style="margin:4rem auto 2rem;max-width:34rem;padding:0 1.4rem;font-size:.72rem;color:var(--muted);letter-spacing:.08em;text-align:center">
  ${esc(SITE_NAME)} · <a href="/feed.xml" style="color:inherit">订阅</a>
</footer>
</body>
</html>`;
}

const TOOLS = `<div class="tools">
  <button class="tool" data-act="fs" title="字号">字</button>
  <button class="tool" data-act="theme" title="昼夜">◐</button>
</div>`;

const SCRIPT = `<script>
(function(){
  var root=document.documentElement;
  function setFs(v){root.style.setProperty('--fs',v);try{localStorage.setItem('sw:fs',v)}catch(e){}}
  var sizes=['17px','19px','22px'];
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]'); if(!b) return;
    if(b.dataset.act==='fs'){
      var cur=getComputedStyle(root).getPropertyValue('--fs').trim()||'19px';
      var i=sizes.indexOf(cur);
      setFs(sizes[(i+1)%sizes.length]);
    }
    if(b.dataset.act==='theme'){
      var now=root.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
      var next=now==='dark'?'light':'dark';
      root.dataset.theme=next;
      try{localStorage.setItem('sw:theme',next)}catch(e){}
    }
  });
  // 键盘翻页
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'){var a=document.querySelector('a[data-prev]');if(a)location.href=a.href;}
    if(e.key==='ArrowRight'){var b2=document.querySelector('a[data-next]');if(b2)location.href=b2.href;}
  });
})();
</script>`;

// ─────────────────────────────────────────────────────────────
// 页面
// ─────────────────────────────────────────────────────────────

function libraryPage(theme: string | null): string {
  const rows = listBooks()
    .map((slug) => {
      const info = loadBookInfo(slug);
      const chapters = publishingChapters(slug);
      const meta = [info.genre, chapters.length ? `${chapters.length} 章` : '即将开始']
        .filter(Boolean)
        .join(' · ');
      return `<a class="book-card" href="/b/${esc(slug)}">
        <div class="book-card-title">${esc(info.title)}</div>
        ${info.tagline ? `<div class="book-card-tag">${esc(info.tagline)}</div>` : ''}
        <div class="book-card-meta">${esc(meta)}</div>
        <div class="book-card-cta">开始阅读 →</div>
      </a>`;
    })
    .join('');

  return layout(
    SITE_NAME,
    `<div class="topbar"><span>${esc(SITE_NAME)}</span>${TOOLS}</div>
     <div class="wrap"><div class="book-head"><h1 class="book-title">${esc(SITE_NAME)}</h1>
     <p class="book-meta">${esc(SITE_TAGLINE)}</p></div>
     <div class="toc">${rows || '<div class="empty">还没有书</div>'}</div></div>
     ${SCRIPT}`,
    theme,
  );
}

function tocPage(slug: string, theme: string | null, draft: boolean): string {
  const info = loadBookInfo(slug);
  const allRaw = listChapterMetas(slug);
  // 连载不能出现断章：只发布到第一个未定稿的章为止
  const accepted: ChapterMeta[] = [];
  for (const m of allRaw) {
    if (m.status !== 'accepted') break;
    accepted.push(m);
  }
  const all = draft ? allRaw : accepted;

  const rows = all
    .map(
      (c) => `<a class="toc-row${c.status === 'accepted' ? '' : ' draft'}" href="/b/${esc(slug)}/${c.n}">
        <span class="toc-no">${String(c.n).padStart(2, '0')}</span>
        <span class="toc-title">${esc(c.title)}</span>
        <span class="toc-words">${c.status === 'accepted' ? `${c.wordCount} 字` : '草稿'}</span>
      </a>`,
    )
    .join('');

  const synopsis = (info.synopsis ?? '')
    .split('\n')
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');

  const continueBtn = accepted.length
    ? `<a class="start" href="/b/${esc(slug)}/${accepted.at(-1)!.n}">
         <span>开始阅读</span><span class="start-meta">共 ${accepted.length} 章</span></a>`
    : '<div class="empty">作者还在写第一章</div>';

  return layout(
    info.title,
    `<div class="topbar"><a href="/">← ${esc(SITE_NAME)}</a>${TOOLS}</div>
     <div class="wrap">
       <div class="book-head">
         <h1 class="book-title">${esc(info.title)}</h1>
         <p class="book-meta">${esc([info.genre, info.author, info.status].filter(Boolean).join(' · '))}</p>
         <div class="book-desc">${info.tagline ? `<p><em>${esc(info.tagline)}</em></p>` : ''}${synopsis}</div>
       </div>
       <div class="toc">${continueBtn}${rows}</div>
     </div>
     ${SCRIPT}`,
    theme,
  );
}

function chapterPage(slug: string, n: number, theme: string | null, draft: boolean): string | null {
  const ch = loadChapter(slug, n);
  if (!ch) return null;
  if (ch.meta.status !== 'accepted' && !draft) return null;

  const info = loadBookInfo(slug);
  const metas = listChapterMetas(slug);
  const prev = metas.find((m) => m.n === n - 1);
  const next = metas.find((m) => m.n === n + 1);

  const paragraphs = ch.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const pager = `<div class="pager">
    ${
      prev
        ? `<a data-prev href="/b/${esc(slug)}/${prev.n}"><span class="dir">上一章</span><span>${esc(prev.title)}</span></a>`
        : `<span class="disabled"><span class="dir">上一章</span><span>没有了</span></span>`
    }
    <a href="/b/${esc(slug)}"><span class="dir">目录</span><span>${metas.length} 章</span></a>
    ${
      next
        ? `<a data-next class="next" href="/b/${esc(slug)}/${next.n}"><span class="dir">下一章</span><span>${esc(next.title)}</span></a>`
        : `<span class="next disabled"><span class="dir">下一章</span><span>明天见</span></span>`
    }
  </div>`;

  const resume = `<script>
(function(){
  var key='sw:pos:${esc(slug)}:${n}';
  try{ var v=localStorage.getItem(key); if(v){ var r=parseFloat(v); if(r>0.02&&r<0.95) window.scrollTo(0, r*document.body.scrollHeight); } }catch(e){}
  var t;
  window.addEventListener('scroll',function(){
    clearTimeout(t);
    t=setTimeout(function(){
      try{ localStorage.setItem(key, String(window.scrollY/Math.max(1,document.body.scrollHeight-window.innerHeight))); localStorage.setItem('sw:last:${esc(slug)}',String(${n})); }catch(e){}
    },400);
  },{passive:true});
})();
</script>`;

  return layout(
    `${ch.meta.title} · ${info.title}`,
    `<div class="topbar"><a href="/b/${esc(slug)}">← 目录</a><span>${esc(SITE_NAME)}</span>${TOOLS}</div>
     <div class="wrap page">
       <div class="chapter-head">
         <div class="chapter-no">第 ${n} 章</div>
         <h1 class="chapter-title">${esc(ch.meta.title)}</h1>
       </div>
       <div class="prose">${paragraphs}</div>
       <hr class="end">
       ${pager}
       <div style="height:3rem"></div>
     </div>
     ${SCRIPT}${resume}`,
    theme,
  );
}

// ─────────────────────────────────────────────────────────────
// 订阅与搜素
// ─────────────────────────────────────────────────────────────

/** 连载的命脉是订阅。没有 RSS，读者只能靠记忆回来看。 */
function feedXml(slug: string): string {
  const info = loadBookInfo(slug);
  const chapters = publishingChapters(slug).slice(-20).reverse();

  const items = chapters
    .map((m) => {
      const ch = loadChapter(slug, m.n);
      const plain = (ch?.body ?? '').replace(/\s+/g, ' ').slice(0, 140);
      const url = `${SITE_URL}/b/${slug}/${m.n}`;
      return `  <item>
    <title>${esc(`${m.n}. ${m.title}`)}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    <pubDate>${new Date(m.createdAt).toUTCString()}</pubDate>
    <description>${esc(plain)}</description>
  </item>`;
    })
    .join('\n');

  const latest = chapters[0] ? new Date(chapters[0].createdAt).toUTCString() : new Date().toUTCString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(`${info.title} · ${SITE_NAME}`)}</title>
  <link>${esc(`${SITE_URL}/b/${slug}`)}</link>
  <description>${esc(info.tagline ?? info.title)}</description>
  <language>zh-CN</language>
  <lastBuildDate>${latest}</lastBuildDate>
${items}
</channel>
</rss>`;
}

function sitemapXml(): string {
  const urls: string[] = [`${SITE_URL}/`];
  for (const slug of listBooks()) {
    urls.push(`${SITE_URL}/b/${slug}`);
    for (const m of publishingChapters(slug)) urls.push(`${SITE_URL}/b/${slug}/${m.n}`);
  }
  const body = urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

/**
 * 对外可见的章：走到第一个「还没定稿」或「还没到发布点」为止。
 * 连载不能有洞，也不能提前漏出来。
 */
function publishingChapters(slug: string): ChapterMeta[] {
  const out: ChapterMeta[] = [];
  const now = Date.now();
  for (const m of listChapterMetas(slug)) {
    if (m.status !== 'accepted') break;
    if (m.publishAt && Date.parse(m.publishAt) > now) break;
    out.push(m);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  const send = (status: number, html: string) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      // 章节内容一旦发布就不再变；短缓存既能扛流量又不至于让新章节延迟太久
      'cache-control': status === 200 ? 'public, max-age=120' : 'no-cache',
    });
    res.end(html);
  };

  try {
    if (path === '/healthz') {
      const books = listBooks();
      const chapters = books.reduce((n, b) => n + publishingChapters(b).length, 0);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, books: books.length, chapters }));
    }

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    }

    if (path === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'max-age=300' });
      return res.end(sitemapXml());
    }

    if (path === '/feed.xml') {
      const slug = url.searchParams.get('book') ?? listBooks()[0];
      if (!slug) return send(404, layout('找不到', '<div class="wrap"><div class="empty">还没有书</div></div>'));
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'max-age=300' });
      return res.end(feedXml(slug));
    }

    if (path === '/static/theme.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=60' });
      return res.end(CSS);
    }

    const theme = url.searchParams.get('theme');
    const draftMode = url.searchParams.get('draft') === '1';

    if (path === '/') return send(200, libraryPage(theme));

    const m = path.match(/^\/b\/([^/]+)(?:\/(\d+))?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]!);
      if (!listBooks().includes(slug)) return send(404, layout('找不到', '<div class="wrap"><div class="empty">没有这本书</div></div>', theme));

      if (m[2]) {
        const html = chapterPage(slug, Number(m[2]), theme, draftMode);
        if (!html) return send(404, layout('找不到', '<div class="wrap"><div class="empty">没有这一章</div></div>'));
        return send(200, html);
      }
      return send(200, tocPage(slug, theme, draftMode));
    }

    send(404, layout('找不到', '<div class="wrap"><div class="empty">404</div></div>'));
  } catch (err) {
    send(500, layout('出错了', `<div class="wrap"><div class="empty">${esc((err as Error).message)}</div></div>`));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  阅读器  http://${HOST}:${PORT}   对外地址 ${SITE_URL}\n`);
});

// 让 systemd / docker stop 能干净地关掉
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`\n  收到 ${sig}，关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export type { ChapterMeta };
