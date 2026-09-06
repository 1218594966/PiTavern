/**
 * M9-2 记忆分层：层摘要生成器。
 *
 * 玩家在设置里定「压缩宽度 every + 缓冲 buffer」：
 * 完成第 (every+buffer) 层时把最旧段 [1..every] 压成层摘要卡，
 * 最近 buffer 层始终保留全文；再往后每 every 层压一次最旧段。
 * 摘要卡：MemoryCardData.isSummary=true，layerFrom/layerTo 标区间。
 *
 * 上下文组装时（assembler）不再只靠关键词命中：旧层段以摘要全量进上下文
 * （插槽 3A 段摘要链），最近层保留全文（插槽 4）——见 assembler.ts。
 *
 * 摘要质量：有 evaluator apiKey 走真实模型（evaluator 模型）；faux 演示模式
 * 生成确定性占位摘要（行截断拼接），保证无 key 也能看到分层机制在跑。
 */
import type { Models, Model, Api } from '@earendil-works/pi-ai';
import type { Card, HistoryLine } from '../types.js';
import type { CardStore } from '../db/store.js';
import { completeWithRetry } from '../config/robust-llm.js';

export interface LayerSummaryInput {
  worldId: string;
  /** 会话模式（chatId 提供时）——历史存 chat；无则世界级 */
  chatId?: string;
  layerFrom: number;
  layerTo: number;
  /** 该层段的全部对话行（已按 turn 过滤） */
  lines: HistoryLine[];
  /** 参与角色名清单（摘要提示里告知模型谁在场） */
  characterNames: string[];
  /** 是否走真实模型（有 evaluator key） */
  useRealModel: boolean;
}

/** faux 占位摘要：把行压缩成可读回顾（不截断过长，控制 ~ 每行 30 字） */
function placeholderSummary(input: LayerSummaryInput): string {
  const head = `第 ${input.layerFrom}-${input.layerTo} 层回顾`;
  const body = input.lines
    .slice(-40)
    .map((l) => {
      const who = l.speaker === 'user' ? '玩家' : l.speaker === 'ooc' ? '(OOC)' : l.speaker;
      const t = l.text.replace(/\s+/g, ' ').trim();
      return `${who}: ${t.slice(0, 60)}`;
    })
    .join('；');
  return `${head}：${body.slice(0, 700)}`;
}

/** 走真实模型的系统提示 */
const SUMMARY_SYSTEM = `你是 RPG 剧情的复盘记录员。把给定的一段对话压缩成 2~4 句的层回顾，
保留：发生了什么大事、角色关系的实质变化、玩家做出的重要承诺/发现、当前悬而未决的线索。
用中文第三人称叙述，不要出现"玩家说"这类转述格式，直接写事件。`;

/**
 * 生成并入库一层摘要记忆卡。
 * 幂等：同层区间已存在摘要卡则先删旧卡再写新的（层段全文不变时重压）。
 */
export async function summarizeLayer(
  models: Models,
  model: Model<Api>,
  store: CardStore,
  input: LayerSummaryInput,
  opts: { apiKey?: string } = {},
): Promise<{ cardId: string; text: string; realModel: boolean } | null> {
  const { worldId, chatId, layerFrom, layerTo, lines, characterNames } = input;
  if (lines.length === 0) return null;

  // 幂等键：会话模式用会话 id 隔离（不同会话的层摘要各自独立）；
  // 无会话（世界级）沿用固定 id。
  const cardId = chatId
    ? `mem_l${layerFrom}_${layerTo}_${chatId.replace(/^chat_/, '').slice(0, 12)}`
    : `mem_l${layerFrom}_${layerTo}`;

  // 文本块：玩家/角色发言的干净时间线
  const dialogue = lines
    .map((l) => {
      const who = l.speaker === 'user' ? '玩家' : l.speaker;
      return `${who}: ${l.text}`;
    })
    .join('\n');

  let text: string;
  let realModel = false;
  if (input.useRealModel) {
    try {
      const ctx = {
        systemPrompt: SUMMARY_SYSTEM,
        messages: [
          {
            role: 'user' as const,
            content: `在场角色：${characterNames.join('、')}\n\n第 ${layerFrom}-${layerTo} 层对话全文：\n${dialogue.slice(0, 8000)}`,
            timestamp: Date.now(),
          },
        ],
      };
      const call = await completeWithRetry(models, model, ctx, { apiKey: opts.apiKey, maxRetries: 0, maxTokens: 400 });
      if (call.message) {
        const content = (call.message as { content?: unknown }).content;
        let raw = '';
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && typeof b.text === 'string') raw = b.text;
          }
        } else if (typeof content === 'string') raw = content;
        text = raw.trim();
        realModel = true;
        if (!text) text = placeholderSummary(input);
      } else {
        text = placeholderSummary(input);
      }
    } catch {
      text = placeholderSummary(input);
    }
  } else {
    text = placeholderSummary(input);
  }

  // 幂等：同层区间旧摘要卡删掉（重压）——只删本会话/本世界属于自己的那张
  const ids = await store.listWorldCards(worldId);
  const cards = (await store.getCards(ids)).filter((c): c is Card => c !== null && c.kind === 'memory');
  for (const c of cards) {
    const d = c.data as { isSummary?: boolean; layerFrom?: number; layerTo?: number };
    // 会话模式的旧卡 id 带 chat 后缀；世界模式的固定 id —— 双重判定：
    // 用 card.id 是否等于本次将写入的 cardId 来确定归属（历史遗留的全局旧卡
    // 若撞了本会话区间，也会被清理，避免同区间两张摘要卡并存）
    if (d.isSummary && d.layerFrom === layerFrom && d.layerTo === layerTo && c.id === cardId) {
      await store.deleteCard(worldId, c.id);
    }
  }

  const card = {
    id: cardId,
    kind: 'memory' as const,
    data: {
      ownerCharacterId: '', // 层摘要属于整段剧情，不属于单一角色
      summary: `第 ${layerFrom}-${layerTo} 层回顾`,
      detail: text,
      relatedIds: [],
      keywords: ['第' + layerFrom + '层', '第' + layerTo + '层', '回顾', '剧情'],
      isSummary: true,
      layerFrom,
      layerTo,
    },
    keywords: ['剧情回顾'],
    updatedAt: Date.now(),
  };
  await store.putCard(card);
  await store.addCardToWorld(worldId, cardId);
  return { cardId, text, realModel };
}

/**
 * M9-2 分层触发判定（用户机制）：
 * 设置两个点——压缩宽度 every（每多少层压一段）+ 缓冲 buffer（保留全文的最近层数）。
 * 完成第 T 层时，若 (T - buffer) 恰为 every 的整数倍且 >= every → 触发压缩
 * 段 [T-buffer-every+1, T-buffer]，更早的层早已被更早触发压掉；
 * 触发点之后最近 buffer 层保持全文（例：every=20, buffer=10 → 完成第 30 层压 1-20，
 * 21-30 全文；完成第 50 层压 21-40，41-50 全文）。
 * 参数 completed：刚完成回合的层号（= 推进后 state.turn - 1）。
 */
export function layerBoundaryHit(completed: number, every: number, buffer = 0): boolean {
  if (!every || every < 1 || completed < 1) return false;
  const tail = completed - buffer;
  if (tail < every) return false;
  return tail % every === 0;
}

/** 返回本次应压缩的层区间（无则 null）；completed 同上 */
export function layerCompressRange(completed: number, every: number, buffer = 0): { from: number; to: number } | null {
  if (!layerBoundaryHit(completed, every, buffer)) return null;
  const to = completed - buffer;
  const from = to - every + 1;
  return from >= 1 ? { from, to } : null;
}
