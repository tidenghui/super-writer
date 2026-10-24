import { resolveRole, type Role } from './config.ts';
import { isMock, mockCall } from './mock.ts';
import { logCall, sleep } from './util.ts';

export interface CallOpts {
  role: Role;
  system: string;
  user: string;
  /** 要求模型只返回 JSON */
  json?: boolean;
  maxTokens?: number;
  /** 用于日志和成本归集 */
  label?: string;
  signal?: AbortSignal;
  /** 覆盖角色默认温度（开场需要更疯一点） */
  temperatureOverride?: number;
}

export interface CallResult {
  text: string;
  model: string;
  ms: number;
  usage: { in: number; out: number };
  costCny: number;
}

const ledger = {
  totalCny: 0,
  calls: 0,
  byLabel: new Map<string, number>(),
};

export function spendSoFar(): { totalCny: number; calls: number } {
  return { totalCny: ledger.totalCny, calls: ledger.calls };
}

function budgetCny(): number {
  const raw = process.env.SW_MAX_CHAPTER_COST_CNY;
  const n = raw ? Number(raw) : 15;
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/**
 * 单次模型调用。带重试、成本记账、预算护栏。
 * 所有阶段都必须走这里——否则成本就统计不准了。
 */
export async function callLLM(opts: CallOpts): Promise<CallResult> {
  if (isMock()) {
    logCall({
      ts: new Date().toISOString(),
      label: opts.label ?? opts.role,
      mock: true,
      system: opts.system,
      user: opts.user,
    });
    return mockCall(opts);
  }

  const r = resolveRole(opts.role);
  const label = opts.label ?? opts.role;

  if (ledger.totalCny > budgetCny()) {
    throw new Error(
      `本章已花费 ¥${ledger.totalCny.toFixed(2)}，超过预算上限 ` +
        `SW_MAX_CHAPTER_COST_CNY=¥${budgetCny()}。已中止，防止跑飞。`,
    );
  }

  let maxTokens = opts.maxTokens ?? 4096;

  // OpenAI 新模型用 max_completion_tokens；DeepSeek 只认 max_tokens
  const isOpenAI = r.provider === 'openai';
  const tokenField = isOpenAI ? 'max_completion_tokens' : 'max_tokens';

  const body: Record<string, unknown> = {
    model: r.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    [tokenField]: maxTokens,
    stream: false,
  };

  // 推理强度：只对 OpenAI 传。DeepSeek 传了反而会开启推理（实测过）。
  if (r.provider === 'openai' && r.reasoningEffort) {
    body.reasoning_effort = r.reasoningEffort;
  }

  // reasoner 类模型不接受 temperature
  if (r.temperature !== undefined && !/reasoner|r1|thinking/i.test(r.model)) {
    body.temperature = opts.temperatureOverride ?? r.temperature;
  }
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(`${r.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${r.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      });

      if (!res.ok) {
        const errText =
          (await res.text().catch(() => '')) || res.statusText || '（服务器未返回错误详情）';
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < 3) {
          await sleep(1000 * 2 ** (attempt - 1));
          lastErr = new Error(`${r.provider} HTTP ${res.status}: ${errText.slice(0, 300)}`);
          continue;
        }
        throw new Error(
          `${r.provider} HTTP ${res.status} (role=${opts.role}, model=${r.model}):\n${errText.slice(0, 600)}`,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };

      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      const finish = choice?.finish_reason ?? '?';
      const reasoningLen = (choice?.message?.reasoning_content ?? '').length;

      // 截断必须重试——不管有没有内容。
      // 推理模型经常把预算烧在思考上，只吐出半截 JSON。以前只在「内容为空」时重试，
      // 结果半截 JSON 会一路走到解析层才炸，看不出原因。
      if (finish === 'length' && attempt < 3) {
        logCall({
          ts: new Date().toISOString(),
          label,
          role: opts.role,
          model: r.model,
          failed: true,
          finish,
          maxTokens,
          reasoningLen,
          usage: data.usage ?? null,
          partialChars: text.length,
        });
        maxTokens = Math.min(maxTokens * 2, 32000);
        (body as Record<string, number>)[tokenField] = maxTokens;
        console.warn(
          `  \x1b[33m!\x1b[0m ${label} 被 max_tokens=${maxTokens / 2} 截断（推理 ${reasoningLen} 字，只出 ${text.length} 字），翻倍重试`,
        );
        continue;
      }

      if (!text) {
        logCall({
          ts: new Date().toISOString(),
          label,
          role: opts.role,
          model: r.model,
          failed: true,
          finish,
          maxTokens,
          reasoningLen,
          usage: data.usage ?? null,
        });
        throw new Error(
          `模型返回了空内容（${label}｜finish=${finish}｜max_tokens=${maxTokens}｜推理 ${reasoningLen} 字）`,
        );
      }

      const usage = {
        in: data.usage?.prompt_tokens ?? 0,
        out: data.usage?.completion_tokens ?? 0,
      };
      const reasoning =
        (data.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
          ?.completion_tokens_details?.reasoning_tokens ?? 0;
      const costCny =
        (usage.in / 1e6) * r.priceIn + (usage.out / 1e6) * r.priceOut;

      ledger.totalCny += costCny;
      ledger.calls += 1;
      ledger.byLabel.set(label, (ledger.byLabel.get(label) ?? 0) + costCny);

      const ms = Date.now() - started;
      logCall({
        ts: new Date().toISOString(),
        label,
        role: opts.role,
        provider: r.provider,
        model: r.model,
        ms,
        usage,
        reasoningTokens: reasoning,
        costCny: Number(costCny.toFixed(4)),
        system: opts.system,
        user: opts.user,
        response: text,
      });

      return { text, model: r.model, ms, usage, costCny };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
