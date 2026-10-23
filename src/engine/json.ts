/**
 * 从模型输出里把 JSON 挖出来。
 *
 * 为什么需要这个：reasoner 类模型经常在 JSON 前后夹带一段思考、或者用 ```json 包起来，
 * response_format 也不是所有厂商都支持。与其祈祷模型听话，不如在解析层做防御。
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // 1. 纯 JSON
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fallthrough */
  }

  // 2. ```json ... ``` 围栏
  const fenced = trimmed.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fallthrough */
    }
  }

  // 3. 扫出第一个配平的 {...} 或 [...]
  const candidate = firstBalanced(trimmed);
  if (candidate) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* fallthrough */
    }
  }

  throw new Error(
    `模型没有返回可解析的 JSON。开头 400 字符：\n${trimmed.slice(0, 400)}`,
  );
}

function firstBalanced(input: string): string | null {
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = input.indexOf(open);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < input.length; i++) {
      const ch = input[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 中文字数统计：按 Unicode 汉字 + 连续的拉丁字母串各算一个单位 */
export function countChars(text: string): number {
  const hans = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  return hans;
}
