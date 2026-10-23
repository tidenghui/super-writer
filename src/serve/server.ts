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
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/theme.css">
<script>
(function(){try{
  var t=localStorage.getItem('sw:theme'); if(t) document.documentElement.dataset.theme=t;
  var f=localStorage.getItem('sw:fs'); if(f) document.documentElement.style.setProperty('--fs',f);
}catch(e){}})();
</script>
</head>
<body>
${body}
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
      const chapters = listChapterMetas(slug).filter((c) => c.status === 'accepted');
      return `<a class="toc-row" href="/b/${esc(slug)}">
        <span class="toc-title">${esc(info.title)}</span>
        <span class="toc-words">${chapters.length ? `${chapters.length} 章` : '即将开始'}</span>
      </a>`;
    })
    .join('');

  return layout(
    '书架',
    `<div class="topbar"><span>书架</span>${TOOLS}</div>
     <div class="wrap"><div class="book-head"><h1 class="book-title">书架</h1>
     <p class="book-meta">每天更新的连载</p></div>
     <div class="toc">${rows || '<div class="empty">还没有书</div>'}</div></div>
     ${SCRIPT}`,
    theme,
  );
}

function tocPage(slug: string, theme: string | null, draft: boolean): string {
  const info = loadBookInfo(slug);
  const allRaw = listChapterMetas(slug);
  const accepted = allRaw.filter((c) => c.status === 'accepted');
  // 默认只发布 accepted；加 ?draft=1 才看得到草稿
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
    `<div class="topbar"><a href="/">← 书架</a>${TOOLS}</div>
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
    `<div class="topbar"><a href="/b/${esc(slug)}">← 目录</a>${TOOLS}</div>
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
// 路由
// ─────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  const send = (status: number, html: string) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(html);
  };

  try {
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

server.listen(PORT, () => {
  console.log(`\n  阅读器  http://127.0.0.1:${PORT}\n`);
});

export type { ChapterMeta };
