import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 先 .env.local 再 .env；后加载的不覆盖已存在的键 */
export function loadEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
    } catch {
      /* 文件格式有问题就跳过，不要因此启动失败 */
    }
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
  | 'summarizer';

interface ProviderCfg {
  protocol: 'openai';
  baseUrl: string;
  apiKeyEnv: string;
}

interface ModelCfgFile {
  providers: Record<string, ProviderCfg>;
  pricingCnyPerMTok: Record<string, { in: number; out: number }>;
  roles: Record<string, { provider: string; model: string; temperature?: number }>;
}

export interface ResolvedRole {
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

export function resolveRole(role: Role): ResolvedRole {
  const cfg = modelConfig();
  const entry = cfg.roles[role];
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

export const bookDir = (slug: string) => resolve(ROOT, 'books', slug);
export const runsDir = (slug: string) => resolve(ROOT, 'runs', slug);
