/**
 * LLM 调用可靠性封装：超时、瞬时错误重试、串行限流与进度回调。
 *
 * 设计动机（整改）：
 * - 原先 router/evaluator 在 parse 失败时手写 retry 循环、actor 流式阶段没有
 *   超时保护，超时/限流错误直接表现为「转圈 → 报错」，且同一毫秒内的重试
 *   风暴会打满上游限流。
 * - 这里把「请求纪律」收拢成一个文件：
 *     completeWithRetry()   —— 非流式（router/evaluator）有界重试 + 指数退避
 *     collectStream()       —— 流式（actor）空闲超时熔断
 *     createThrottle()      —— 令牌桶，给上游留余量，避免瞬时并发打爆限流
 *
 * 注意：不使用 pi-ai 内置 retryAssistantCall —— 阶段语义需要「超时即放弃」，
 * 且调用方要拿到每个 attempt 的耗时与错误信息做阶段面板展示。
 */
import type { Api, AssistantMessage, Context, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai';

export interface CompleteOptions {
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  /** 思考强度（OpenAI 兼容 reasoning_effort；'off' = 不传，关闭思考） */
  reasoning?: ThinkingLevel | 'off';
  /** 单次请求超时（ms）。默认 60s。 */
  timeoutMs?: number;
  /** 超时/瞬时错误后的最大重试次数。默认 1（共最多 2 次尝试）。 */
  maxRetries?: number;
  /** 重试前回调（UI 面板可展示"重试中…"） */
  onRetry?: (attempt: number, error: string) => void;
  /** 令牌桶（默认进程级共享，见 createThrottle） */
  throttle?: Throttle;
}

export interface CompleteResult {
  /** 成功时为消息；整体失败为 null */
  message: AssistantMessage | null;
  /** 成功前的尝试次数（1 = 一次通过） */
  attempts: number;
  /** 每次尝试的耗时（ms） */
  attemptMs: number[];
  /** 失败原因（message 为 null 时必填） */
  error?: string;
}

/** 简易令牌桶：保证并发窗口内发出的请求数 ≤ capacity */
export interface Throttle {
  capacity: number;
  readonly inflight: number;
  tryAcquire(): boolean;
  release(): void;
}

export function createThrottle(capacity: number): Throttle {
  let inflight = 0;
  return {
    capacity,
    get inflight() {
      return inflight;
    },
    tryAcquire() {
      if (inflight >= capacity) return false;
      inflight += 1;
      return true;
    },
    release() {
      inflight = Math.max(0, inflight - 1);
    },
  };
}

/** 模块级默认令牌桶：同一进程内所有阶段的并发请求总上限（防打爆上游限流） */
const defaultThrottle = createThrottle(4);

/** 解析 AssistantMessage 的错误信息（失败诊断用） */
export function messageError(msg: AssistantMessage | null | undefined): string {
  if (!msg) return '无响应';
  return msg.errorMessage ?? (msg.stopReason === 'error' ? '上游返回 error（stopReason=error）' : '');
}

/** 判定一次失败是否值得重试（超时 / 5xx / 429 / 连接类瞬时错误） */
function isRetryableError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return /timeout|timed ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|5\d\d|429|rate ?limit|too many requests|overloaded|temporarily unavailable|internal server error|busy|unavailable|try again|502|503|504/i.test(
    text,
  );
}

/** 带超时的非流式调用（内部单次尝试）。失败（错误消息/异常）都吞掉由上层分类。 */
async function completeOnce(
  models: Models,
  model: Model<Api>,
  ctx: Context,
  opts: { apiKey?: string; maxTokens?: number; temperature?: number; reasoning?: ThinkingLevel | 'off'; timeoutMs: number },
): Promise<AssistantMessage> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`请求超时（> ${opts.timeoutMs}ms）`)), opts.timeoutMs);
  try {
    return await models.completeSimple(model, ctx, {
      apiKey: opts.apiKey,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoning: opts.reasoning === 'off' ? undefined : opts.reasoning,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 非流式调用 + 有界重试（指数退避 + 抖动）。
 * 重试条件：超时或瞬时错误（429/5xx/连接类）；确定性错误（如模型输出格式
 * 不对、鉴权失败）不重试 —— 由调用方的语义层分类。
 */
export async function completeWithRetry(
  models: Models,
  model: Model<Api>,
  ctx: Context,
  opts: CompleteOptions = {},
): Promise<CompleteResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 1;
  const throttle = opts.throttle ?? defaultThrottle;
  const attemptMs: number[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 等令牌（最多 5s；拿不到说明进程级并发已满，直接报过载）
    const waited = await waitForToken(throttle, 5000);
    if (!waited) {
      return {
        message: null,
        attempts: attempt + 1,
        attemptMs,
        error: '上游请求过载（并发令牌桶已满），请稍后重试',
      };
    }

    const t0 = performance.now();
    let message: AssistantMessage;
    try {
      message = await completeOnce(models, model, ctx, {
        apiKey: opts.apiKey,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        reasoning: opts.reasoning,
        timeoutMs,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      attemptMs.push(performance.now() - t0);
      if (attempt < maxRetries && isRetryableError(err)) {
        opts.onRetry?.(attempt + 1, text);
        await sleep(backoffMs(attempt, timeoutMs));
        continue;
      }
      return { message: null, attempts: attempt + 1, attemptMs, error: text };
    } finally {
      throttle.release();
    }

    attemptMs.push(performance.now() - t0);
    const errText = messageError(message);
    if (!errText) {
      return { message, attempts: attempt + 1, attemptMs };
    }
    if (attempt < maxRetries && isRetryableError(errText)) {
      opts.onRetry?.(attempt + 1, errText);
      await sleep(backoffMs(attempt, timeoutMs));
      continue;
    }
    return { message, attempts: attempt + 1, attemptMs, error: errText };
  }

  return { message: null, attempts: maxRetries + 1, attemptMs, error: '重试次数用尽' };
}

/** 指数退避：base * 2^attempt + 抖动（上限 8s） */
function backoffMs(attempt: number, baseMs: number): number {
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.random() * 200;
  return Math.min(exp + jitter, 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForToken(throttle: Throttle, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (throttle.tryAcquire()) return true;
    await sleep(30);
  }
  return false;
}

/* ------------------------- 流式调用（Actor） ------------------------- */

export interface StreamHandleOptions {
  apiKey?: string;
  /** 思考强度（OpenAI 兼容 reasoning_effort；'off' = 不传，关闭思考） */
  reasoning?: ThinkingLevel | 'off';
  /** 流空闲超时（ms）：距上一个事件超过该时长即熔断。默认 30s。 */
  idleTimeoutMs?: number;
}

export interface StreamResult {
  /** 完整正文（出错且无任何输出时为空串；由调用方决定如何呈现错误） */
  fullText: string;
  /** 输出 token 统计（可能为空） */
  usage: { input: number; output: number; total: number } | null;
  stopReason: string;
  /** 是否因空闲超时被熔断 */
  timedOut: boolean;
  /** 错误信息（出错/熔断时有值） */
  error?: string;
}

/**
 * 流式调用 + 空闲超时熔断。
 * - 事件超时：距上一个事件（含首个）超过 idleTimeoutMs 视为卡死 → abort。
 * - 'error' 事件：透传 errorMessage。
 * - 返回的 fullText 只含真实文本；错误信息走 error 字段，由调用方决策
 *   （抛错给前端 / 保留半截正文）。
 */
export async function collectStream(
  models: Models,
  model: Model<Api>,
  ctx: Context,
  onDelta?: (delta: string) => void,
  opts: StreamHandleOptions = {},
): Promise<StreamResult> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const ac = new AbortController();
  const stream = models.streamSimple(model, ctx, { apiKey: opts.apiKey, reasoning: opts.reasoning === 'off' ? undefined : opts.reasoning, signal: ac.signal });

  let full = '';
  let usage: StreamResult['usage'] = null;
  let stopReason = 'unknown';
  let error: string | undefined;
  let timedOut = false;
  let lastEventAt = Date.now();

  const idleTimer = setInterval(() => {
    if (Date.now() - lastEventAt > idleTimeoutMs) {
      timedOut = true;
      ac.abort(new Error(`演员流式响应超过 ${idleTimeoutMs}ms 无新内容，已熔断`));
    }
  }, Math.min(idleTimeoutMs, 2000));

  try {
    for await (const ev of stream) {
      lastEventAt = Date.now();
      if (ev.type === 'text_delta') {
        full += ev.delta;
        onDelta?.(ev.delta);
      } else if (ev.type === 'done') {
        full = ev.message.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        usage = {
          input: ev.message.usage.input,
          output: ev.message.usage.output,
          total: ev.message.usage.totalTokens,
        };
        stopReason = ev.reason;
      } else if (ev.type === 'error') {
        stopReason = ev.reason;
        const evErr = (ev as { error?: { errorMessage?: string } }).error;
        error = evErr?.errorMessage ?? `流式调用出错（stopReason=${ev.reason}）`;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!timedOut) {
      error = /abort/i.test(msg) && ac.signal.aborted ? `流式调用被中断` : msg;
    }
  } finally {
    clearInterval(idleTimer);
  }

  const result: StreamResult = { fullText: full, usage, stopReason, timedOut, error };
  if (timedOut && !error) error = `演员流式响应超过 ${idleTimeoutMs}ms 无新内容，已熔断`;
  return result;
}
