/**
 * 阅读数据统计。
 *
 * 不装第三方、不用 cookie、不收集个人信息——只读 Caddy 的访问日志。
 * 目标只有一个：回答「今天几个人来、从哪来、读到第几章走」。
 *
 * Caddy 每行一条 JSON，关键字段：
 *   ts                        时间
 *   request.remote_ip         来访 IP（只用来算独立访客，不存不传）
 *   request.uri               路径
 *   request.headers.User-Agent / Referer
 *   status                    状态码
 */
import { readFileSync, existsSync } from 'node:fs';

export interface LogLine {
  ts?: number;
  request?: {
    remote_ip?: string;
    uri?: string;
    headers?: Record<string, string[]>;
  };
  status?: number;
}

/**
 * 从 UA 判断人是从哪来的。
 *
 * 小红书/微信/微博这些 App 的内置浏览器基本不带 Referer，
 * 只能靠 UA 里的标记认。认不出来的时候宁可归到「直接访问」，
 * 也不要瞎猜——错的分渠道比没有分渠道更误导人。
 */
export function platformOf(ua: string): string {
  if (!ua) return '其他';
  if (/MicroMessenger/i.test(ua)) return '微信';
  if (/xiaohongshu|xhsdiscover|discover\/|XHS/i.test(ua)) return '小红书';
  if (/Weibo/i.test(ua)) return '微博';
  if (/Zhihu/i.test(ua)) return '知乎';
  if (/Douban/i.test(ua)) return '豆瓣';
  if (/Baidu|baiduboxapp/i.test(ua)) return '百度';
  if (/QQ\//i.test(ua)) return 'QQ';
  if (/iPhone|iPad|Android|Macintosh|Windows/i.test(ua)) return '浏览器';
  return '其他';
}

export interface DayStats {
  visitors: number;
  /**
   * 真人读者的估计。
   *
   * 口径：同一个 IP 在同一本书里，**相邻两次读章之间隔了 20 秒到 30 分钟**。
   * 判据是「人的阅读速度」：一章 2500 字，人至少要几分钟；
   * 爬虫是一秒一页地抓，间隔远小于 20 秒，所以会被排除。
   * 这个数偏保守——但运营要看的是它，不是 visitors。
   */
  readers: number;
  pageviews: number;
  chaptersRead: number;
  /** 每章有多少独立 IP 读过（key 是 "slug/n"） */
  chapterReach: Map<string, Set<string>>;
  referrers: Array<[string, number]>;
  topPages: Array<[string, number]>;
  /** 真人读者按来源平台分布 */
  readerSources: Array<[string, number]>;
  /** 全部来访（含只读一章的）按平台分布——发帖之后看这个最快 */
  visitorSources: Array<[string, number]>;
  /** 按书的阅读漏斗：第1章 → 第3章 的到达率 */
  funnels: Array<{ slug: string; c1: number; c3: number; c5: number; rate3: number }>;
}

// 扫描器最爱敲的门，不该算进访问数
const SKIP = [
  /^\/static\//,
  /^\/healthz$/,
  /^\/favicon/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/wp-/,
  /xmlrpc/i,
  /\.php$/i,
  /^\/\./,
  /^\/\//, // 双斜杠开头的探测路径
];

function parseLine(line: string): LogLine | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t) as LogLine;
  } catch {
    return null;
  }
}

export function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(parseLine)
    .filter((x): x is LogLine => x !== null);
}

/** 把 UA 里的爬虫滤掉——它们不算读者 */
function isBot(ua: string): boolean {
  return /bot|crawl|spider|slurp|preview|fetch|curl|wget|python-requests|headless/i.test(ua);
}

export function dayStats(lines: LogLine[], sinceMs: number): DayStats {
  const visitors = new Set<string>();
  const readByBook = new Map<string, Map<string, number[]>>();
  const readerPlatform = new Map<string, string>();
  const visitorPlatform = new Map<string, string>();
  const chapterReach = new Map<string, Set<string>>();
  const referrers = new Map<string, number>();
  const pages = new Map<string, number>();
  let pageviews = 0;
  let chaptersRead = 0;

  for (const l of lines) {
    if (!l.ts || l.ts * 1000 < sinceMs) continue;
    if (l.status !== 200) continue;

    const uri = l.request?.uri ?? '';
    if (!uri || SKIP.some((re) => re.test(uri))) continue;

    const ip = l.request?.remote_ip ?? 'unknown';
    const ua = (l.request?.headers?.['User-Agent'] ?? [''])[0] ?? '';
    if (isBot(ua)) continue;

    pageviews++;
    visitors.add(ip);
    visitorPlatform.set(ip, platformOf(ua));

    const path = uri.split('?')[0] ?? '';
    pages.set(path, (pages.get(path) ?? 0) + 1);

    // 章节访问：/b/<slug>/<n>
    const m = path.match(/^\/b\/([^/]+)\/(\d+)$/);
    if (m) {
      chaptersRead++;
      const key = `${m[1]}/${Number(m[2])}`;
      const set = chapterReach.get(key) ?? new Set<string>();
      set.add(ip);
      chapterReach.set(key, set);

      readerPlatform.set(ip, platformOf(ua));
      const perBook = readByBook.get(m[1]!) ?? new Map<string, number[]>();
      const times = perBook.get(ip) ?? [];
      times.push(l.ts * 1000);
      perBook.set(ip, times);
      readByBook.set(m[1]!, perBook);
    }

    const ref = (l.request?.headers?.['Referer'] ?? [''])[0] ?? '';
    if (ref) {
      try {
        const host = new URL(ref).host;
        if (host) referrers.set(host, (referrers.get(host) ?? 0) + 1);
      } catch {
        /* 非法 referer 直接忽略 */
      }
    }
  }

  // 按书算漏斗
  const byBook = new Map<string, Map<number, Set<string>>>();
  for (const [key, ips] of chapterReach) {
    const [slug, nStr] = key.split('/');
    const n = Number(nStr);
    const m = byBook.get(slug!) ?? new Map<number, Set<string>>();
    m.set(n, ips);
    byBook.set(slug!, m);
  }

  const funnels = [...byBook.entries()].map(([slug, m]) => {
    const c1 = m.get(1)?.size ?? 0;
    const c3 = m.get(3)?.size ?? 0;
    const c5 = m.get(5)?.size ?? 0;
    return { slug, c1, c3, c5, rate3: c1 ? c3 / c1 : 0 };
  });

  const sortDesc = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]);

  // 相邻两章之间隔了 20 秒–30 分钟 → 这是人在读，不是机器在抓
  const MIN_GAP = 20_000;
  const MAX_GAP = 30 * 60_000;
  let readers = 0;
  for (const perBook of readByBook.values()) {
    for (const times of perBook.values()) {
      if (times.length < 2) continue;
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i]! - times[i - 1]!;
        if (gap >= MIN_GAP && gap <= MAX_GAP) {
          readers++;
          break;
        }
      }
    }
  }

  // 真人读者按来源平台聚合（一个 IP 只算一次）
  const srcCount = new Map<string, number>();
  for (const perBook of readByBook.values()) {
    for (const [ip, times] of perBook) {
      if (times.length < 2) continue;
      times.sort((a, b) => a - b);
      let human = false;
      for (let i = 1; i < times.length; i++) {
        const gap = times[i]! - times[i - 1]!;
        if (gap >= 20_000 && gap <= 30 * 60_000) {
          human = true;
          break;
        }
      }
      if (!human) continue;
      const plat = readerPlatform.get(ip) ?? '其他';
      srcCount.set(plat, (srcCount.get(plat) ?? 0) + 1);
    }
  }

  const visCount = new Map<string, number>();
  for (const plat of visitorPlatform.values()) visCount.set(plat, (visCount.get(plat) ?? 0) + 1);

  return {
    visitors: visitors.size,
    readers,
    readerSources: [...srcCount.entries()].sort((a, b) => b[1] - a[1]),
    visitorSources: [...visCount.entries()].sort((a, b) => b[1] - a[1]),
    pageviews,
    chaptersRead,
    chapterReach,
    referrers: sortDesc(referrers).slice(0, 8),
    topPages: sortDesc(pages).slice(0, 8),
    funnels: funnels.sort((a, b) => b.c1 - a.c1),
  };
}

/** 给终端看的短报告：三个数 + 漏斗 + 来源 */
export function formatStats(s: DayStats): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = [];

  lines.push(`真人读者 ${s.readers}　来访 IP ${s.visitors}　浏览 ${s.pageviews}`);

  if (s.funnels.length) {
    lines.push('');
    lines.push('漏斗（第1章 → 第3章 → 第5章）');
    for (const f of s.funnels) {
      lines.push(`  ${f.slug.padEnd(10)} ${String(f.c1).padStart(3)} → ${String(f.c3).padStart(3)} → ${String(f.c5).padStart(3)}　第3章到达 ${pct(f.rate3)}`);
    }
  }

  if (s.visitorSources.length) {
    lines.push('');
    lines.push('来访从哪来（含只读一页的）');
    for (const [name, n] of s.visitorSources) lines.push(`  ${name} ${n}`);
  }

  if (s.readerSources.length) {
    lines.push('');
    lines.push('真人读者从哪来');
    for (const [name, n] of s.readerSources) lines.push(`  ${name} ${n}`);
  }

  if (s.referrers.length) {
    lines.push('');
    lines.push('来源');
    for (const [host, n] of s.referrers) lines.push(`  ${host} ${n}`);
  }

  if (s.topPages.length) {
    lines.push('');
    lines.push('热门页面');
    for (const [p, n] of s.topPages) lines.push(`  ${p} ${n}`);
  }

  return lines.join('\n');
}
