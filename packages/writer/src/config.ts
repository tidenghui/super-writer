import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 根目录一律由契约层提供。
// 这里曾经自己算过一次——搬家之后少了一层，模型配置直接找不到。
import { ROOT } from '../../contract/src/index.ts';
export { ROOT };
export { bookDir } from '../../contract/src/index.ts';

/**
 * 极简 .env 解析。
 *
 * 不用 process.loadEnvFile 是因为它的语义是「不覆盖已存在的环境变量」——
 * 而开发机上经常已经有一些同名变量（比如指向内部网关的 DEEPSEEK_BASE_URL），
 * 那会把项目自己的配置静默盖掉，非常难查。这里明确优先级：
 *
 *   .env.local（本地私有，最高）> 进程环境变量 > .env（只补缺）
 */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnv(): void {
  // .env 只补缺：不覆盖已经存在的变量
  const base = resolve(ROOT, '.env');
  if (existsSync(base)) {
    for (const [k, v] of Object.entries(parseEnvFile(base))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  // .env.local 强制覆盖：它就是这台机器上这个项目的真相
  const local = resolve(ROOT, '.env.local');
  if (existsSync(local)) {
    Object.assign(process.env, parseEnvFile(local));
  }
}

export type Role =
  | 'showrunner'
  | 'planner'
  | 'opener'
  | 'writer'
  | 'reviser'
  | 'critic'
  | 'coldReader'
  | 'auditor'
  | 'canonRecorder'
  | 'summarizer'
  | 'outlineReview'
  | 'arbiter'
  | 'coldReaderStrict';

interface ProviderCfg {
  protocol: 'openai';
  baseUrl: string;
  apiKeyEnv: string;
}

interface ModelCfgFile {
  providers: Record<string, ProviderCfg>;
  pricingCnyPerMTok: Record<string, { in: number; out: number }>;
  roles: Record<
    string,
    { provider: string; model: string; temperature?: number; reasoningEffort?: 'low' | 'medium' | 'high' }
  >;
}

export interface ResolvedRole {
  reasoningEffort?: 'low' | 'medium' | 'high';
  role: Role;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  priceIn: number;
  priceOut: number;
}

let cached: ModelCfgFile | null = null;

export function modelConfig(): ModelCfgFile {
  if (!cached) {
    cached = JSON.parse(
      readFileSync(resolve(ROOT, 'config/models.json'), 'utf8'),
    ) as ModelCfgFile;
  }
  return cached;
}

/**
 * 按进程覆盖角色模型。
 *
 * 用环境变量传，因为一次批量里每本书是独立进程，
 * 环境变量不会串到别的书上；也不用改全局配置。
 *
 *   SW_ROLE_OVERRIDE='{"writer":{"provider":"openai","model":"gpt-6.1-sol"}}'
 */
interface RoleEntry {
  provider: string;
  model: string;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

function roleOverride(role: Role): RoleEntry | null {
  const raw = process.env.SW_ROLE_OVERRIDE;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, RoleEntry>;
    return map[role] ?? null;
  } catch {
    return null;
  }
}

export function resolveRole(role: Role): ResolvedRole {
  const cfg = modelConfig();
  const override = roleOverride(role);
  const entry = override ?? cfg.roles[role];
  if (!entry) throw new Error(`config/models.json 里没有定义角色 "${role}"`);

  const provider = cfg.providers[entry.provider];
  if (!provider) throw new Error(`config/models.json 里没有定义厂商 "${entry.provider}"`);

  const baseUrl = process.env[`${entry.provider.toUpperCase()}_BASE_URL`] ?? provider.baseUrl;
  const apiKey = process.env[provider.apiKeyEnv] ?? '';
  if (!apiKey) {
    throw new Error(
      `缺少 API key：环境变量 ${provider.apiKeyEnv} 未设置。\n` +
        `请在 ${resolve(ROOT, '.env.local')} 里填入（可从 .env.example 复制）。`,
    );
  }

  const price = cfg.pricingCnyPerMTok[entry.model];
  return {
    role,
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    provider: entry.provider,
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model: entry.model,
    temperature: entry.temperature,
    priceIn: price?.in ?? 0,
    priceOut: price?.out ?? 0,
  };
}

/** 写手和批评家是否同源——同源时相关性太高，审稿会失效 */
export function checkCriticDiversity(): { ok: boolean; message: string } {
  const writer = safe(() => resolveRole('writer'));
  const critic = safe(() => resolveRole('critic'));
  if (!writer || !critic) return { ok: false, message: '模型配置未就绪' };
  if (writer.provider !== critic.provider) {
    return { ok: true, message: `写手 ${writer.model} / 批评家 ${critic.model}，厂商不同。` };
  }
  return {
    ok: false,
    message:
      `写手和批评家都在 ${writer.provider} 上（${writer.model} / ${critic.model}）。\n` +
      '同一个模型审自己的稿，盲区会完全重合。建议在 config/models.json 里把 critic 换到第二个厂商。',
  };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export const runsDir = (slug: string) => resolve(ROOT, 'runs', slug);
