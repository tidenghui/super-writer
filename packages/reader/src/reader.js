/* Progressive enhancement: reading and navigation work without JavaScript. */
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const get = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const set = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const main = $('[data-book]');
  const slug = main?.dataset.book;
  const chapter = Number(main?.dataset.chapterNumber);
  const preview = main?.dataset.preview === 'true';

  // ── 匿名阅读事件 ──────────────────────────────────────────────
  // 只回答「走到哪一步」，不认人：不存 IP、不存 UA、不存 referer。
  // rid 是本机随机 ID（清缓存即重置），sid 30 分钟无操作就换新的。
  const rid = (() => {
    let v = get('sw:rid');
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); set('sw:rid', v); }
    return v;
  })();
  const sid = (() => {
    const now = Date.now();
    const last = Number(get('sw:sidAt') || 0);
    let v = get('sw:sid');
    if (!v || now - last > 30 * 60 * 1000) { v = Math.random().toString(36).slice(2) + now.toString(36); set('sw:sid', v); }
    set('sw:sidAt', now);
    return v;
  })();
  function track(e, n) {
    if (preview) return; // 草稿预览不计入
    const payload = JSON.stringify({ e, slug: slug || '', n: n || 0, rid, sid });
    try {
      if (navigator.sendBeacon) { navigator.sendBeacon('/e', new Blob([payload], { type: 'application/json' })); return; }
      fetch('/e', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' }, keepalive: true });
    } catch {}
  }
  if (slug) {
    if (Number.isFinite(chapter) && chapter > 0) track('chapter_start', chapter);
    else track('book_open');
  }

  const endMark = $('.chapter-end');
  if (endMark && Number.isFinite(chapter) && chapter > 0 && 'IntersectionObserver' in window) {
    let done = false;
    new IntersectionObserver((entries) => {
      if (done) return;
      if (entries.some((x) => x.isIntersecting)) { done = true; track('chapter_complete', chapter); }
    }, { threshold: 0.6 }).observe(endMark);
  }

  all('[data-next]').forEach((a) => a.addEventListener('click', () => track('next_chapter_click', chapter)));
  all('a[href^="/feed.xml"]').forEach((a) => a.addEventListener('click', () => track('share_click', chapter)));

  let opener;
  const dialogOpen = () => !!$('dialog[open]');
  function syncSettings() {
    const theme = root.dataset.theme || 'system';
    all('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme)));
    const leading = root.style.getPropertyValue('--leading') || '1.95';
    all('[data-leading]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.leading === leading)));
    all('[data-font]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.font === (root.dataset.font || 'serif'))));
    const output = $('#font-size-value');
    if (output) output.textContent = String(parseInt(getComputedStyle(root).getPropertyValue('--fs')) || 19);
  }
  function close(panel) { panel.close(); }
  all('dialog').forEach(panel => {
    panel.addEventListener('click', e => { if (e.target === panel) {
      const r = panel.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(panel);
    } });
    panel.addEventListener('close', () => {
      root.classList.remove('panel-open');
      opener?.focus({ preventScroll: true });
    });
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.open) {
      const panel = document.getElementById(b.dataset.open);
      if (!panel) return;
      opener = b;
      syncSettings();
      panel.showModal();
      root.classList.add('panel-open');
      panel.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' });
    }
    if (b.hasAttribute('data-close')) close(b.closest('dialog'));
    if (b.dataset.themeChoice) {
      const t = b.dataset.themeChoice;
      if (t === 'system') delete root.dataset.theme;
      else root.dataset.theme = t;
      set('sw:theme', t);
    }
    if (b.dataset.size) {
      const size = parseInt(getComputedStyle(root).getPropertyValue('--fs')) || 19;
      const next = Math.min(28, Math.max(16, size + Number(b.dataset.size)));
      root.style.setProperty('--fs', `${next}px`);
      set('sw:fs', `${next}px`);
    }
    if (b.dataset.leading) { root.style.setProperty('--leading', b.dataset.leading); set('sw:leading', b.dataset.leading); }
    if (b.dataset.font) { root.dataset.font = b.dataset.font; set('sw:font', b.dataset.font); }
    if (b.hasAttribute('data-sort')) {
      const list = $('[data-chapter-list]');
      const reversed = b.getAttribute('aria-pressed') !== 'true';
      [...list.children].reverse().forEach(child => list.appendChild(child));
      b.setAttribute('aria-pressed', String(reversed));
      b.textContent = reversed ? '正序排列 ↑' : '倒序排列 ↓';
    }
    syncSettings();
  });
  function refreshResumeLinks() {
    all('[data-resume]').forEach(link => {
      const last = Number(get(`sw:last:${link.dataset.resume}`));
      const available = link.dataset.available?.split(',').map(Number);
      const valid = available ? available.includes(last) : Number.isInteger(last) && last >= Number(link.dataset.first) && last <= Number(link.dataset.last);
      if (valid) {
        const url = new URL(link.href);
        url.pathname = `/b/${encodeURIComponent(link.dataset.resume)}/${last}`;
        link.href = url.pathname + url.search + url.hash;
        link.innerHTML = `继续第 ${last} 章 <span aria-hidden="true">→</span>`;
      }
    });
  }
  function refreshShelfHistory() {
    const data = $('#shelf-index');
    if (!data) return;
    let books;
    try { books = JSON.parse(data.textContent); } catch { return; }
    const recent = books.map(book => ({ ...book, chapter: Number(get(`sw:last:${book.slug}`)), at: Number(get(`sw:lastAt:${book.slug}`)) || 0 }))
      .filter(book => Number.isInteger(book.chapter) && book.chapter >= book.first && book.chapter <= book.last)
      .sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
    function historyCard(book) {
      const link = document.createElement('a');
      link.className = 'resume-card';
      link.href = `/b/${encodeURIComponent(book.slug)}/${book.chapter}?from=${encodeURIComponent('/' + location.search + '#library')}`;
      const mark = document.createElement('span');
      mark.className = 'resume-mark';
      mark.dataset.coverTone = book.tone;
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = book.title.slice(0, 1);
      const copy = document.createElement('span');
      copy.className = 'resume-copy';
      const title = document.createElement('strong');
      title.textContent = book.title;
      const note = document.createElement('span');
      note.textContent = `继续第 ${book.chapter} 章`;
      copy.append(title, note);
      const arrow = document.createElement('span');
      arrow.className = 'resume-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      link.append(mark, copy, arrow);
      return link;
    }
    const section = $('[data-continue]');
    const list = $('[data-continue-list]');
    const history = $('[data-history-list]');
    list.replaceChildren(...recent.slice(0, 3).map(historyCard));
    section.hidden = !recent.length;
    history.replaceChildren(...recent.map(historyCard));
    if (!recent.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '还没有阅读记录。翻开第一章，下一次就能从这里继续。';
      history.append(empty);
    }
  }
  all('[data-shelf-select]').forEach(select => select.addEventListener('change', () => select.form.requestSubmit()));
  refreshResumeLinks();
  refreshShelfHistory();
  window.addEventListener('pageshow', () => { refreshResumeLinks(); refreshShelfHistory(); });
  if (slug && !chapter) {
    const last = Number(get(`sw:last:${slug}`));
    const rows = all('[data-chapter]');
    if (rows.some(row => Number(row.dataset.chapter) === last)) {
      rows.forEach(row => {
        const n = Number(row.dataset.chapter);
        if (n !== last && (get(`sw:visited:${slug}:${n}`) || get(`sw:pos:${slug}:${n}`) !== null)) row.classList.add('read');
        if (n === last) { row.classList.add('last-read'); row.querySelector('.chapter-label').textContent = '上次读到'; }
      });
      $('[data-reading-note]').textContent = `上次读到第 ${last} 章 · 进度保存在当前浏览器`;
    }
  }
  if (!chapter || !slug) return;
  const posKey = `sw:pos:${slug}:${chapter}`;
  const progress = $('.reading-progress');
  const toolbar = $('.reading-toolbar');
  let lastY = window.scrollY, pending = false, hideTimer;
  let restoring = true;
  function ratio() { return Math.min(1, Math.max(0, window.scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))); }
  function save() {
    if (preview || restoring) return;
    set(posKey, ratio());
    set(`sw:last:${slug}`, chapter);
    set(`sw:lastAt:${slug}`, Date.now());
  }
  function update() {
    const value = Math.round(ratio() * 100);
    if (progress) { progress.style.setProperty('--progress', `${value}%`); progress.setAttribute('aria-valuenow', String(value)); }
    const y = window.scrollY;
    if (!dialogOpen() && !restoring) {
      if (y - lastY > 5 && y > 160 && value < 97) toolbar?.classList.add('is-hidden');
      else if (y < lastY - 3 || value >= 97 || y < 100) toolbar?.classList.remove('is-hidden');
    }
    lastY = y;
    pending = false;
  }
  async function restore() {
    if (document.fonts?.ready) await document.fonts.ready;
    const r = Number(get(posKey));
    if (!preview && Number.isFinite(r) && r > 0 && r <= 1 && !location.hash) {
      window.scrollTo({ top: r * Math.max(1, document.documentElement.scrollHeight - innerHeight), behavior: 'instant' });
    }
    restoring = false;
    if (!preview) {
      set(`sw:last:${slug}`, chapter);
      set(`sw:lastAt:${slug}`, Date.now());
      set(`sw:visited:${slug}:${chapter}`, 1);
    }
    lastY = window.scrollY;
    update();
  }
  restore();
  window.addEventListener('scroll', () => {
    if (!pending) { pending = true; requestAnimationFrame(update); }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(save, 200);
  }, { passive: true });
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  window.addEventListener('resize', update);
  document.addEventListener('keydown', e => {
    if (dialogOpen() || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const link = e.key === 'ArrowLeft' ? $('[data-prev]') : e.key === 'ArrowRight' ? $('[data-next]') : null;
    if (link) { e.preventDefault(); save(); location.href = link.href; }
  });
})();
