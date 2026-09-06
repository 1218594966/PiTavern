/**
 * 调试辅助：把发给模型的 Context 拆成结构化分层，随 stage 事件推给前端
 * 调试面板（路由 / 演员两阶段，各自 Request/Response 分层可折叠查看）。
 */
import type { Context, Message } from '@earendil-works/pi-ai';

export function ctxToDebugPrompt(ctx: Context): string {
  const st = ctxToStructured(ctx);
  const parts: string[] = [];
  if (st.system) parts.push(st.system);
  for (const m of st.messages) parts.push(`--- ${m.role} ---\n${m.content}`);
  if (st.tools) parts.push(`--- 工具 ---\n${st.tools}`);
  return parts.join('\n\n');
}

/** 结构化拆分：system 指令 / 消息序列 / 工具清单 */
export function ctxToStructured(ctx: Context): {
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: string;
} {
  const messages = (ctx.messages ?? []).map((m) => ({
    role: m.role === 'user' ? '用户(最新输入)' : m.role === 'assistant' ? '助手' : String(m.role ?? '消息'),
    content: messageContentToText(m),
  }));
  return {
    system: ctx.systemPrompt ?? '',
    messages,
    tools:
      ctx.tools && ctx.tools.length > 0
        ? ctx.tools
            .map((t) => {
              let s = `${t.name}: ${t.description ?? ''}`;
              const params = (t as unknown as { parameters?: Record<string, unknown> }).parameters;
              if (params && typeof params === 'object' && Object.keys(params).length > 0) {
                s += `\n参数: ${JSON.stringify(params, null, 2)}`;
              }
              return s;
            })
            .join('\n')
        : '',
  };
}

export function messageContentToText(m: Message): string {
  const c = m.content;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === 'string') return b;
        const o = b as { type?: string; text?: string; arguments?: unknown };
        if (o.type === 'text') return o.text ?? '';
        if (o.type === 'toolCall') return `[工具调用 ${o.text ?? ''}] ${o.arguments !== undefined ? JSON.stringify(o.arguments) : ''}`;
        return '';
      })
      .join('');
  }
  return String(c ?? '');
}
