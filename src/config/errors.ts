/**
 * PiTavern 结构化错误：给「用户可见的失败」一个稳定、可分类的错误码。
 *
 * 用法：
 * - 代码里抛 `new PitavernError(code, message, { cause })`
 * - 协议层（WebSocket/CLI）统一映射成 { type:'error', code, message }，
 *   前端不再靠正则猜错误类型。
 */
export type PitavernErrorCode =
  | 'INTERNAL' // 未分类内部错误
  | 'NOT_FOUND' // 卡/世界/会话不存在
  | 'INVALID_INPUT' // 用户输入/请求参数不合法
  | 'WORLD_MISSING' // 世界无卡片或无初始状态
  | 'MODEL_FAILED' // 阶段模型调用失败（超时/上游错误/解析失败，重试后仍失败）
  | 'MODEL_UNAVAILABLE' // 模型未配置/未找到（需要接入或刷新目录）
  | 'OVERLOADED' // 上游过载/令牌桶满
  | 'CONCURRENCY' // 上一回合仍在处理
  | 'IMPORT_FAILED'; // 卡片导入失败

export class PitavernError extends Error {
  readonly code: PitavernErrorCode;
  readonly cause?: unknown;

  constructor(code: PitavernErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'PitavernError';
    this.code = code;
    this.cause = options.cause;
  }
}

/** 把任意未知错误归类成 PitavernError（协议层出口统一用） */
export function toPitavernError(err: unknown): PitavernError {
  if (err instanceof PitavernError) return err;
  const text = String(err instanceof Error ? err.message : err);
  if (/过载|令牌桶|too many|429|rate limit/i.test(text)) {
    return new PitavernError('OVERLOADED', text, { cause: err });
  }
  if (/找不到模型|未配置|refresh|目录为空|no model|not found/i.test(text)) {
    return new PitavernError('MODEL_UNAVAILABLE', text, { cause: err });
  }
  if (/超时|timeout|熔断/i.test(text)) {
    return new PitavernError('MODEL_FAILED', text, { cause: err });
  }
  return new PitavernError('INTERNAL', text, { cause: err });
}
