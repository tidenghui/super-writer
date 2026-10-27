/** 补丁：只替换指定的片段，不做整章重写。 */

export interface Patch {
  find: string;
  replace: string;
}

/**
 * 应用补丁。
 * 只接受「在正文里唯一出现」的 find —— 找不到或找到多处一律跳过，
 * 宁可漏修，也不要改错地方。
 */
export function applyPatches(
  body: string,
  patches: Patch[],
): { body: string; applied: number; skipped: number } {
  let out = body;
  let applied = 0;
  let skipped = 0;

  for (const p of patches) {
    const find = (p.find ?? '').trim();
    if (find.length < 4) {
      skipped++;
      continue;
    }
    const first = out.indexOf(find);
    if (first === -1 || out.indexOf(find, first + 1) !== -1) {
      skipped++;
      continue;
    }
    out = out.slice(0, first) + (p.replace ?? '') + out.slice(first + find.length);
    applied++;
  }
  return { body: out, applied, skipped };
}
