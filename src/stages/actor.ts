/**
 * 阶段 3：前台演员 Agent（Actor）——「只专心飙戏的顶级演员」。
 *
 * 拿到阶段 2 的小纸条（< 900 Token）直接开演：
 * - 不猜位置、不在 50 个人设里找人、不算好感度——舞台已搭好
 * - streamSimple() 毫秒级流式打字，首字秒回
 * - 便利贴接梗不出错（认人/旧账由插槽 3 保证）
 *
 * 可靠性（整改）：
 * - consumeActorStream 换成 collectStream（robust-llm）：带「空闲超时熔断」，
 *   流式阶段不再无限等待一个卡死的上游连接；超时/出错会回填可见错误文本。
 * - 保留 actorEngine（事件句柄形态）供需要逐事件消费的调用方/测试使用。
 */
import type { Model } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai';
import { collectStream } from '../config/robust-llm.js';

export interface ActorHandle {
  /** 消费事件：'start' / 'text_delta' / 'done' / 'error' … */
  events: AsyncIterable<AssistantMessageEvent>;
  /** 迭代结束后可读的完整正文 */
  fullText: () => string;
  /** 迭代结束后可读的 usage */
  usage: () => { input: number; output: number; total: number } | null;
  /** 迭代结束后可读的 stopReason */
  stopReason: () => string;
}

/** 把 context 交给演员，返回事件流句柄（不 await 正文，交给调用方逐个事件推流） */
export function actorEngine(models: Models, model: Model<Api>, context: Context, opts: { apiKey?: string; reasoning?: ThinkingLevel | 'off' } = {}): ActorHandle {
  const s = models.streamSimple(model, context, {
    // 对戏默认不需要思考（压低首字延迟）；设置「思考强度」后可开启
    apiKey: opts.apiKey,
    reasoning: opts.reasoning === 'off' ? undefined : opts.reasoning,
  });

  let full = '';
  let usage: { input: number; output: number; total: number } | null = null;
  let stopReason = 'unknown';

  const events = (async function* () {
    for await (const ev of s) {
      if (ev.type === 'text_delta') full += ev.delta;
      if (ev.type === 'done') {
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
      }
      if (ev.type === 'error') {
        stopReason = ev.reason;
        if (ev.error.errorMessage) {
          // 错误信息也回填，避免静默丢正文
          full = full || `[演员出错: ${ev.error.errorMessage}]`;
        }
      }
      yield ev;
    }
  })();

  return {
    events,
    fullText: () => full,
    usage: () => usage,
    stopReason: () => stopReason,
  };
}

export interface ConsumeResult {
  reply: string;
  usage: { input: number; output: number; total: number } | null;
  stopReason: string;
  timedOut: boolean;
  error?: string;
}

/**
 * 便捷入口：完整消费演员流（带空闲超时熔断）。
 * 超时/出错时：若有半截正文则保留（玩家已看到的部分），reply 为半截；
 * 一条都没出则抛 PitavernError（由流水线统一转错误事件）。
 */
export async function consumeActorStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  onDelta?: (delta: string) => void,
  opts: { apiKey?: string; reasoning?: ThinkingLevel | 'off'; idleTimeoutMs?: number } = {},
): Promise<ConsumeResult> {
  const result = await collectStream(models, model, context, onDelta, {
    apiKey: opts.apiKey,
    reasoning: opts.reasoning,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  return {
    reply: result.fullText,
    usage: result.usage,
    stopReason: result.stopReason,
    timedOut: result.timedOut,
    error: result.error,
  };
}
