import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 限并发地跑一组任务，保持顺序返回结果 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return results;
}

let logPath: string | null = null;

export function enableCallLog(path: string | null): void {
  logPath = path;
  if (path) mkdirSync(dirname(path), { recursive: true });
}

export function logCall(entry: Record<string, unknown>): void {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}
