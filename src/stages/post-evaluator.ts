/**
 * 阶段 4：后置评估 Agent（PostEvaluator）——「隐形裁判与记账员」。
 *
 * 前台演员打完字后后台静默触发（fire-and-forget，不阻塞主链路）：
 *   1. 拿着玩家这句话 + 演员回话做复盘
 *   2. 克制记账：普通闲聊 ±1，递还关键密信才 ±5，杜绝几句话刷满
 *   3. 提炼角色最新潜意识心理（内心想法）
 *   4. 静默写回（好感度 / 心理独白 / 房间变化 / 物品归属），闭环固化
 *
 * 底层驱动：completeSimple()（小模型，1~2s），挂后台跑，玩家在前台看文字。
 *
 * 可靠性（整改）：
 * - 统一走 robust-llm：30s 超时 + 瞬时错误重试，替换手写循环；
 * - applyEvalResult 收紧「写回范围」：只写回合涉及（involvedCards）的卡，
 *   杜绝因并发回合/陈旧快照把别的会话或新回合的状态覆盖掉；
 * - 移除"historyNote 写入滑动历史"（旧代码已注释说明会污染上下文），
 *   用 newMemoryCards 承载值得长期记住的变化。
 */
import { Type } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai';
import type { Card, HistoryLine, RouteDecision } from '../types.js';
import type { CardStore, WorldState } from '../db/store.js';
import { isCharacterCard } from '../cards/util.js';
import { completeWithRetry, messageError } from '../config/robust-llm.js';
import { PitavernError } from '../config/errors.js';

export interface EvalInput {
  worldId: string;
  /** 会话 id（可选）：结算后的 state 写回会话而不是世界） */
  chatId?: string;
  state: WorldState;
  route: RouteDecision;
  userMessage: string;
  actorReply: string;
  /** 本回合涉及的卡片（结算需要写回的） */
  involvedCards: Card[];
}

export interface AffectionChange {
  characterId: string;
  delta: number;
}

/** 结算时新生成的记忆切片（还未分配卡 id） */
export interface NewMemoryDraft {
  kind: 'memory';
  summary: string;
  detail: string;
  ownerCharacterId: string;
  relatedIds: string[];
  keywords: string[];
}

export interface EvalResult {
  /** 本回合有效的好感度变动（不包含已裁剪部分） */
  affectionChanges: AffectionChange[];
  innerThoughts: Array<{ characterId: string; thought: string }>;
  roomChanges: string[];
  /** 物品归属变动（如短剑收进玩家背包） */
  itemTransfers: Array<{ itemId: string; to: 'player' | 'scene' | 'character'; toId?: string }>;
  /** 是否追加一条内心想法卡片（未来给 actor 当便利贴） */
  newMemoryCards: NewMemoryDraft[];
}

const evalSchema = Type.Object({
  reasoning: Type.Optional(Type.String({ description: '（可选）记账理由' })),
  affectionChanges: Type.Array(
    Type.Object({
      characterId: Type.String(),
      delta: Type.Number({ description: '普通闲聊 ±1，重大事件 ±5，范围 -5..+5' }),
    }),
    { description: '本回合各角色的好感度变动' },
  ),
  innerThoughts: Type.Array(
    Type.Object({
      characterId: Type.String(),
      thought: Type.String({ description: '该角色此刻最新的内心想法（潜意识心理），一句话' }),
    }),
  ),
  roomChanges: Type.Array(Type.String(), { description: '房间里发生的可见变化，如 "短剑被收进了玩家背包"' }),
  itemTransfers: Type.Array(
    Type.Object({
      itemId: Type.String(),
      to: Type.Union([Type.Literal('player'), Type.Literal('scene'), Type.Literal('character')]),
      toId: Type.Optional(Type.String()),
    }),
  ),
  newMemoryCards: Type.Array(
    Type.Object({
      kind: Type.Literal('memory'),
      summary: Type.String(),
      detail: Type.String(),
      ownerCharacterId: Type.String(),
      relatedIds: Type.Array(Type.String()),
      keywords: Type.Array(Type.String()),
    }),
  ),
});

export function buildEvalContext(input: EvalInput): Context {
  const { state, userMessage, actorReply, involvedCards } = input;
  const charNames = new Map<string, string>();
  const cardLines = involvedCards.map((card) => {
    if (isCharacterCard(card)) {
      charNames.set(card.id, card.data.name);
      const d = card.data;
      return `${d.name}（${card.id}）: 好感度 ${d.state.affection}，内心「${d.state.innerThought}」`;
    }
    return `${card.id} (${card.kind})`;
  });

  return {
    systemPrompt: [
      '你是一个 RPG 世界的「隐形记账员」。玩家（Master）和 NPC 刚完成一轮互动，你要在后台静默结算：',
      '1. 好感度变动要克制：普通闲聊 ±1；关键剧情事件（递还密信、救命之恩、重大背叛）才 ±5；范围严格在 -5..+5。',
      '2. 提炼每个在场 NPC 最新的潜意识心理（一句话内心想法），要体现状态变化，如从「高度防备」变成「戒备松懈，暗中感激」。',
      '3. 记录房间里发生的可见变化（物品归属、陈设变动、气氛变化）。',
      '4. 若产生了值得长期记住的关系变化，生成一张记忆切片卡（ownerCharacterId 用 NPC id，keywords 给触发词）。',
      '5. 输出 JSON 结算单，不要输出任何对白。',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `当前回合: ${state.turn}`,
          `玩家的话: 「${userMessage}」`,
          `NPC 的回应: 「${actorReply}」`,
          '',
          '【相关卡片现状】',
          ...cardLines,
          '',
          '请输出结算 JSON。',
        ].join('\n'),
        timestamp: Date.now(),
      },
    ],
    tools: [
      {
        name: 'settle_turn',
        description: '输出本回合的世界状态结算单',
        parameters: evalSchema,
      },
    ],
  };
}

function parseEvalResult(msg: unknown): EvalResult | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  let raw: string | null = null;
  const content = m.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') raw = b.text;
        if (b.type === 'toolCall' && b.arguments) raw = JSON.stringify(b.arguments);
      }
    }
  } else if (typeof content === 'string') {
    raw = content;
  }
  if (!raw) return null;

  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const o = JSON.parse(jsonText) as Partial<EvalResult>;
    return {
      affectionChanges: Array.isArray(o.affectionChanges)
        ? o.affectionChanges.filter((a) => a && typeof a.characterId === 'string' && typeof a.delta === 'number')
        : [],
      innerThoughts: Array.isArray(o.innerThoughts) ? o.innerThoughts.filter((t) => t && typeof t.characterId === 'string') : [],
      roomChanges: Array.isArray(o.roomChanges) ? o.roomChanges.filter((x): x is string => typeof x === 'string') : [],
      itemTransfers: Array.isArray(o.itemTransfers)
        ? o.itemTransfers.filter((t) => t && typeof t.itemId === 'string' && (t.to === 'player' || t.to === 'scene' || t.to === 'character'))
        : [],
      newMemoryCards: Array.isArray(o.newMemoryCards)
        ? o.newMemoryCards.filter(
            (mem) =>
              mem &&
              typeof mem.summary === 'string' &&
              typeof mem.ownerCharacterId === 'string' &&
              typeof mem.detail === 'string' &&
              Array.isArray(mem.relatedIds) &&
              Array.isArray(mem.keywords),
          )
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * 把结算单写回：好感度 / 内心想法 / 房间变化 / 物品归属 / 新记忆卡。
 *
 * 并发安全（整改）：
 * - 只允许写「本回合涉及（involvedCards）」的卡 —— 防止模型幻觉 id 或跨会话
 *   串写；
 * - 写回前从 store 重读卡片最新状态，在其上叠加 delta —— 结算单是异步落地的，
 *   若慢结算期间好感度已被别的回合/会话改过，重读能避免「基于陈旧快照覆盖
 *   最新值」的丢失更新；
 * - 场景卡 recentChanges、物品归属同样重读后写；
 * - 新记忆卡 id 用时间戳+随机生成并登记到世界目录（可被后续路由检索到）。
 *
 * 会话隔离（M1-1）：
 * - 有 chatId（会话模式）→ 好感度/内心想法写进 chat.state.npcStates（overlay），
 *   不碰共享角色卡 —— 多会话各自的情感进展互不串扰；
 * - 无 chatId（世界模式/测试）→ 直接写角色卡（原行为）。
 * - 场景 recentChanges / 物品归属仍写共享卡（静态世界事实，M1 暂保持全局）。
 *
 * 世界指针（回合号/场景/在场/背包）**不在这里写**：回合号与场景推进由流水线
 * 前台同步落盘（见 pipeline.runTurnInner），后台结算只写卡片 —— 避免慢结算
 * 基于陈旧 state 覆盖前台已推进的回合号。
 */
export async function applyEvalResult(input: EvalInput, result: EvalResult, store: CardStore): Promise<void> {
  const { worldId, state } = input;
  const chatId = input.chatId;
  const involvedIds = new Set(input.involvedCards.map((c) => c.id));

  // 1. 好感度 / 内心想法（只写本回合涉及的；写前重读最新值）
  //    —— 会话模式：读写 chat.state.npcStates；世界模式：读写角色卡
  const readAffection = async (charId: string): Promise<{ affection: number; innerThought: string } | null> => {
    if (chatId) {
      const o = state.npcStates?.[charId];
      if (o) return { ...o };
      // overlay 无记录 → 回退卡初值（避免把 "50" 硬编码成基线）
      const card = await store.getCard(charId);
      if (card && isCharacterCard(card)) return { affection: card.data.state.affection, innerThought: card.data.state.innerThought };
      return null;
    }
    const card = await store.getCard(charId);
    if (card && isCharacterCard(card)) {
      return { affection: card.data.state.affection, innerThought: card.data.state.innerThought };
    }
    return null;
  };
  const writeAffection = async (charId: string, next: { affection: number; innerThought: string }): Promise<void> => {
    if (chatId) {
      const npc = state.npcStates ?? (state.npcStates = {});
      npc[charId] = next;
      state.updatedAt = Date.now();
      await store.updateChat(chatId, { state });
      return;
    }
    const card = await store.getCard(charId);
    if (card && isCharacterCard(card)) {
      card.data.state.affection = next.affection;
      card.data.state.innerThought = next.innerThought;
      card.data.state.updatedAtTurn = state.turn;
      await store.putCard(card);
    }
  };

  for (const ch of result.affectionChanges) {
    if (!involvedIds.has(ch.characterId)) continue;
    const cur = await readAffection(ch.characterId);
    if (!cur) continue;
    const delta = Math.max(-5, Math.min(5, ch.delta));
    const next = { ...cur, affection: Math.max(-100, Math.min(100, cur.affection + delta)) };
    await writeAffection(ch.characterId, next);
  }
  for (const t of result.innerThoughts) {
    if (!involvedIds.has(t.characterId)) continue;
    const cur = await readAffection(t.characterId);
    if (!cur) continue;
    await writeAffection(t.characterId, { ...cur, innerThought: t.thought });
  }

  // 2. 房间变化写回场景卡（只写本回合场景；写前重读）
  if (result.roomChanges.length > 0 && state.currentSceneId) {
    const sceneId = state.currentSceneId;
    if (involvedIds.has(sceneId)) {
      const scene = await store.getCard(sceneId);
      if (scene && scene.kind === 'scene') {
        const d = scene.data as { recentChanges: string[] };
        d.recentChanges = [...result.roomChanges, ...d.recentChanges].slice(0, 5);
        await store.putCard(scene);
      }
    }
  }

  // 3. 物品归属变动（只写本回合涉及的物品卡；写前重读）
  let stateDirty = false;
  for (const t of result.itemTransfers) {
    if (!involvedIds.has(t.itemId)) continue;
    const card = await store.getCard(t.itemId);
    if (card && card.kind === 'item') {
      const d = card.data as { location: string; locationId?: string };
      d.location = t.to;
      d.locationId = t.toId;
      if (t.to === 'player' && !state.playerInventory.includes(t.itemId)) {
        state.playerInventory.push(t.itemId);
        stateDirty = true;
      }
      if (t.to !== 'player' && state.playerInventory.includes(t.itemId)) {
        state.playerInventory = state.playerInventory.filter((id) => id !== t.itemId);
        stateDirty = true;
      }
      await store.putCard(card);
    }
  }
  // 物品转移改变了背包（state.playerInventory）：同步落盘。
  // 回合号/场景的推进由流水线前台完成，这里只持久化物品变动结果，
  // 用 state.updatedAt 标记（不覆盖前台已推进的 turn）。
  if (stateDirty) {
    state.updatedAt = Date.now();
    if (input.chatId) await store.updateChat(input.chatId, { state });
    else await store.putWorldState(worldId, state);
  }

  // 4. 新记忆卡入库（登记到世界目录，路由阶段可检索）
  for (const mem of result.newMemoryCards) {
    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const card: Card = {
      id,
      kind: 'memory',
      data: {
        ownerCharacterId: mem.ownerCharacterId,
        summary: mem.summary,
        detail: mem.detail,
        relatedIds: mem.relatedIds ?? [],
        keywords: mem.keywords ?? [],
      },
    };
    await store.putCard(card);
    await store.addCardToWorld(worldId, id);
  }

  // 5. 世界指针的回合推进由流水线前台同步完成（runTurnInner 回合末落盘），
  //    结算不再自增 turn / 全量写 state —— 见函数头注释。
}

/**
 * 后台结算（fire-and-forget，带「同一会话串行化 + 只结算最新一单」防抖）：
 *
 * - 每个会话（chatId，无会话时按 worldId）一个 runner：
 *   同一会话的多个回合结算绝不同时跑 —— 慢结算落在快速连发之后时，不再
 *   互相覆盖 state；
 * - pending 只保留最新一单：旧单快照已陈旧，结算意义不大且可能污染新状态，
 *   直接丢弃（新一轮结算会基于最新状态重新裁决）。
 */
export interface EvaluatorJob {
  models: Models;
  model: Model<Api>;
  input: EvalInput;
  store: CardStore;
  onError?: (err: unknown) => void;
  onDone?: (result: EvalResult) => void;
  apiKey?: string;
  reasoning?: ThinkingLevel | 'off';
}

export interface EvaluatorRunner {
  schedule(job: EvaluatorJob): void;
  /** 是否有正在跑/排队中的结算 */
  isBusy(): boolean;
}

export function createEvaluatorRunner(): EvaluatorRunner {
  let running = false;
  let pending: EvaluatorJob | null = null;

  async function pump(): Promise<void> {
    if (running || !pending) return;
    running = true;
    const job = pending;
    pending = null;
    try {
      const ctx = buildEvalContext(job.input);
      const call = await completeWithRetry(job.models, job.model, ctx, {
        apiKey: job.apiKey,
        reasoning: job.reasoning,
        // 结算单是结构化 JSON：限制输出 + 低温稳定格式
        maxTokens: 800,
        temperature: 0.2,
        timeoutMs: 30_000,
        maxRetries: 1,
      });
      if (!call.message) {
        throw new PitavernError('MODEL_FAILED', `[PostEvaluator] 结算失败: ${call.error ?? '未知错误'}`, { cause: call.error });
      }
      const result = parseEvalResult(call.message);
      if (!result) {
        throw new PitavernError('MODEL_FAILED', `[PostEvaluator] 无法解析结算输出: ${messageError(call.message) || '内容为空或非 JSON'}`);
      }
      await applyEvalResult(job.input, result, job.store);
      job.onDone?.(result);
    } catch (err) {
      job.onError?.(err);
      // 结算失败不影响主链路（下次回合世界状态保持旧值），静默记一条日志
    } finally {
      running = false;
      void pump(); // 继续消化排队的下一单
    }
  }

  return {
    schedule(job: EvaluatorJob): void {
      pending = job; // 只留最新一单：旧单被覆盖即丢弃
      void pump();
    },
    isBusy(): boolean {
      return running || pending !== null;
    },
  };
}

/** 按会话共享的 runner 表（同一会话的结算串行化关键） */
const runnersByChat = new Map<string, EvaluatorRunner>();

export function getRunnerFor(input: Pick<EvalInput, 'chatId' | 'worldId'>): EvaluatorRunner {
  const key = input.chatId ?? input.worldId;
  let runner = runnersByChat.get(key);
  if (!runner) {
    runner = createEvaluatorRunner();
    runnersByChat.set(key, runner);
  }
  return runner;
}

/** 兼容旧签名：直接 fire-and-forget（按会话共享 runner，天然串行化/去重） */
export function postEvaluatorRunAsync(
  models: Models,
  model: Model<Api>,
  input: EvalInput,
  store: CardStore,
  opts: { onError?: (err: unknown) => void; onDone?: (result: EvalResult) => void; apiKey?: string; reasoning?: ThinkingLevel | 'off' } = {},
): void {
  getRunnerFor(input).schedule({ models, model, input, store, ...opts });
}

/** 同步入口（测试用）：完整跑一遍结算 */
export async function postEvaluatorSync(
  models: Models,
  model: Model<Api>,
  input: EvalInput,
  store: CardStore,
  opts: { apiKey?: string; reasoning?: ThinkingLevel | 'off' } = {},
): Promise<EvalResult> {
  const ctx = buildEvalContext(input);
  const call = await completeWithRetry(models, model, ctx, { apiKey: opts.apiKey, reasoning: opts.reasoning, maxRetries: 0 });
  if (!call.message) throw new PitavernError('MODEL_FAILED', `无法解析结算输出: ${call.error ?? '未知错误'}`);
  const result = parseEvalResult(call.message);
  if (!result) throw new PitavernError('MODEL_FAILED', `无法解析结算输出: ${messageError(call.message) || '内容为空或非 JSON'}`);
  await applyEvalResult(input, result, store);
  return result;
}
