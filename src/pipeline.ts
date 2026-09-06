/**
 * 四阶段刚性流水线控制器 —— 业务流水线把控制权收拢在代码层。
 *
 * 时序被 async/await 刚性锁定：
 *   1. await preRouter(...)            // 先挑卡，前一步没出结果后一步绝不运行
 *   2. await assembleCards(...)        // 再拼积木
 *   3. await consumeActorStream(...)   // 演员打字（流式，首字秒回）
 *   4. postEvaluatorRunAsync(...)      // 正文推给前端后，不加 await，后台静默触发
 *
 * 可靠性（整改）：
 * - 同会话回合锁：同一 chatId（无会话时 worldId）的回合串行执行 —— 多开页面
 *   同时发消息不再互相踩踏（历史交错 / state 覆盖）。
 * - 每个阶段有超时与瞬时错误重试（见 config/robust-llm.ts），阶段失败抛
 *   带 code 的 PitavernError，协议层可给出稳定错误提示。
 * - 每回合生成 requestId，贯穿前台与后台结算的日志与事件，可串联排查。
 * - 阶段 4 结算走按会话共享的 runner（post-evaluator.ts），同一会话的结算
 *   串行化 + 只结算最新一单，杜绝慢结算互相覆盖 state。
 */
import type { Model } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai';
import type { Card, HistoryLine, RouteDecision } from './types.js';
import type { CardStore, WorldState } from './db/store.js';
import type { CharacterCardData, MemoryCardData, ItemCardData, SceneCardData } from './types.js';
import { preRouter } from './stages/pre-router.js';
import { assembleCards } from './stages/assembler.js';
import { consumeActorStream } from './stages/actor.js';
import { postEvaluatorRunAsync, type EvalInput } from './stages/post-evaluator.js';
import { summarizeLayer, layerCompressRange } from './stages/summarizer.js';
import { PitavernError } from './config/errors.js';
import { createLogger, newRequestId } from './utils/logger.js';
import { ctxToDebugPrompt, ctxToStructured } from './utils/prompt-debug.js';

const log = createLogger('pipeline');

export interface PipelineConfig {
  worldId: string;
  /** 会话 id（可选）：提供后历史读写走会话级消息，否则退回世界级（兼容测试） */
  chatId?: string;
  /** 新版 pi-ai 的 Models 集合（含 provider 注册与 auth 解析） */
  models: Models;
  /** 阶段 1 模型（小/快） */
  routerModel: Model<Api>;
  /** 阶段 3 模型（大/文笔好） */
  actorModel: Model<Api>;
  /** 阶段 4 模型（小/快） */
  evaluatorModel: Model<Api>;
  store: CardStore;
  /** 前台事件回调（text_delta 逐个推给前端） */
  onDelta?: (delta: string) => void;
  /** 阶段事件回调（阶段 1/2/3/4 的实时进展，供 Web 面板展示） */
  onStageEvent?: (ev: PipelineStageEvent) => void;
  /** 后台结算完成回调（可选） */
  onSettled?: (result: unknown) => void;
  /** 是否启用后台结算（测试可关） */
  settle?: boolean;
  /** 各阶段请求级 apiKey 覆盖（未提供时走 provider auth 解析） */
  apiKeys?: { router?: string; actor?: string; evaluator?: string };
  /** 外部传入的 requestId（不传则内部生成），用于日志串联 */
  requestId?: string;
  /** 演员流空闲超时（ms），默认 45s */
  actorIdleTimeoutMs?: number;
  /** 玩家名（{{user}} 卡正文宏展开；来自会话 persona，缺省 <user> 兜底） */
  userName?: string;
  /** 记忆分层（M9-2）：压缩宽度（每多少层压一段，0 关）+ 缓冲（保留全文层数） */
  layerCompressEvery?: number;
  layerBuffer?: number;
  /** M16 提示词模板（可编辑保存；缺省 undefined = 用内置默认） */
  promptTemplates?: { routerSystem?: string; actorFrame?: string };
}

/** 默认演员演绎框架模板（{{char}} 会被展开为主讲角色名；工作台可编辑覆盖） */
export const DEFAULT_ACTOR_FRAME = [
  '你是「{{char}}」，现在身处上面描述的场景。你只以这个角色的身份说话与行动。',
  '演绎要求：',
  '- 严格贴合设定：性格、说话风格、关系与经历（不要跑出人设）；',
  '- 顺着刚才的对话自然回应，内容要具体、有现场感；',
  '- 一次只开口一轮，不替玩家或其它角色发言；',
  '- 用中文直接输出你的台词/动作，不要任何旁白解释（如"我说道"）、不要引号包裹；',
  '- 字数自然即可（一两句到一小段），别长篇大论，别总结。',
].join('\n');

/** 推给前端的阶段事件（WebSocket 消息体） */
export type PipelineStageEvent =
  | { type: 'stage'; stage: 'router'; status: 'start' | 'done' | 'error'; detail?: unknown; tookMs?: number; requestId?: string }
  | { type: 'stage'; stage: 'assembler'; status: 'start' | 'done' | 'error'; detail?: unknown; tookMs?: number; requestId?: string }
  | { type: 'stage'; stage: 'actor'; status: 'start' | 'delta' | 'done' | 'error'; detail?: unknown; tookMs?: number; requestId?: string }
  | { type: 'stage'; stage: 'evaluator'; status: 'start' | 'done' | 'error'; detail?: unknown; tookMs?: number; requestId?: string }
  | { type: 'world'; worldId: string; turn: number; sceneId: string; presentCharacterIds: string[]; requestId?: string };

export interface PipelineResult {
  /** 阶段 1 抽卡清单 */
  decision: RouteDecision;
  /** 阶段 2 拼装结果 */
  assembled: { prompt: string; tokenEstimate: number };
  /** 阶段 3 完整正文（流式输出可能被半途截断，见 replyTruncated） */
  reply: string;
  /** 正文是否因超时/错误被截断 */
  replyTruncated: boolean;
  /** 各阶段耗时（ms） */
  timings: { routerMs: number; assembleMs: number; actorMs: number };
  /** 模型路由情况 */
  modelsUsed: { router: string; actor: string; evaluator: string };
  /** 本回合 requestId（日志/事件串联） */
  requestId: string;
  /** 本回合 token 用量（router+actor；evaluator 结算后另行累计） */
  usage?: { input: number; output: number };
}

/* ------------------------------------------------------------------ */
/*  种子索引：Demo 里我们把「全量卡片库」放在内存 store 的辅助表里。      */
/*  为保持 CardStore 接口最小，索引由 seed.ts 构建后传入 Pipeline。      */
/* ------------------------------------------------------------------ */

export interface WorldIndex {
  state: WorldState;
  /** 路由卡池（NPC；M10-P1B：玩家角色卡排除在外——"我"不上场被抽；
   *  M14：constant=true 的角色 = 主要NPC（仍在目录可点名，标注常驻） */
  characters: Array<{ id: string; name: string; role: string; constant?: boolean }>;
  /** M10-P1B：玩家角色卡（isPlayer；若有，组装以「玩家身份」段注入） */
  playerCard?: Card | null;
  /** M11：常驻卡全集（Card 顶层 constant=true 的各 kind 卡；system 法则除外——
   *  法则卡已有独立注入路径。每回合全量进组装常驻区，不走路由抽卡） */
  constants: Card[];
  memories: Array<{ id: string; ownerCharacterId: string; summary: string; keywords: string[]; relatedIds: string[] }>;
  /** M8 分层摘要链（按层序；assembler 插槽 3A 全量贴入） */
  layerSummaries?: Array<{ layerFrom: number; layerTo: number; detail: string }>;
  items: Array<{ id: string; name: string; description: string; location: string }>;
  allCards: Card[];
}

export interface WorldIndexOptions {
  /** 会话模式（chatId 提供）：只加载属于本会话的层摘要卡（id 带 chat 后缀），
   *  过滤掉其它会话的摘要，防止跨会话剧情串味；缺省过滤全部会话摘要卡。 */
  chatId?: string;
}

/**
 * 从 store 动态加载某世界的最新索引（导入的世界档案也能跑）。
 * 每次回合前调用，保证拿到最新状态（好感度/新记忆）。
 */
export async function loadWorldIndex(store: CardStore, worldId: string, opts: WorldIndexOptions = {}): Promise<WorldIndex> {
  const { chatId } = opts;
  const state = (await store.getWorldState(worldId)) ?? {
    currentSceneId: '',
    presentCharacterIds: [],
    playerInventory: [],
    turn: 1,
    updatedAt: Date.now(),
  };

  const cardIds = await store.listWorldCards(worldId);
  const cards = (await store.getCards(cardIds)).filter((c): c is Card => c !== null);

  // 会话专属摘要卡：id 带 `_<chatTail>` 后缀（summarizer 生成），只被所属会话消费。
  // - chatId 模式：保留后缀 === 本会话 chatTail 的摘要，过滤其它会话的
  // - 无 chat 模式：全部排除（世界级视图不混入任意会话的私密摘要）
  const chatTail = chatId ? chatId.replace(/^chat_/, '').slice(0, 12) : null;
  const isForeignChatSummary = (c: Card): boolean => {
    if (c.kind !== 'memory' || (c.data as MemoryCardData).isSummary !== true) return false;
    const id = c.id;
    // 会话摘要 = mem_l{from}_{to}_{tail}（tail 不包含 'mem_l' 前缀）
    const m = /^mem_l\d+_\d+_(.+)$/.exec(id);
    if (!m) return false; // 纯世界级摘要（无后缀）
    const tail = m[1]!;
    if (!chatTail) return true; // 无会话上下文 → 会话摘要全部视为外部
    return tail !== chatTail;
  };

  const playerCard = cards.find(
    (c) => c.kind === 'character' && (c.data as CharacterCardData).isPlayer === true,
  );
  // M11：常驻卡全集（顶层 constant；system 法则走独立注入，不在其列）
  const constants = cards.filter(
    (c) => c.constant === true && c.kind !== 'system' && c.kind !== 'history',
  );
  const constantIds = new Set(constants.map((c) => c.id));
  // 路由抽卡池 / 记忆池：常驻卡不参与（始终全量进组装）；chat 专属摘要卡不进池
  const characters = cards
    .filter((c) => c.kind === 'character' && c.id !== playerCard?.id)
    .map((c) => {
      const d = c.data as CharacterCardData;
      return { id: c.id, name: d.name, role: d.role, constant: c.constant === true };
    });
  const memories = cards
    .filter((c) => c.kind === 'memory' && !constantIds.has(c.id) && !isForeignChatSummary(c))
    .map((c) => {
      const d = c.data as MemoryCardData;
      return { id: c.id, ownerCharacterId: d.ownerCharacterId, summary: d.summary, keywords: d.keywords ?? [], relatedIds: d.relatedIds ?? [] };
    });

  const items = cards
    .filter((c) => c.kind === 'item')
    .map((c) => {
      const d = c.data as ItemCardData;
      return { id: c.id, name: d.name, description: d.description, location: d.location };
    });

  const layerSummaries = cards
    .filter((c) => c.kind === 'memory' && (c.data as MemoryCardData).isSummary && !isForeignChatSummary(c))
    .map((c) => {
      const d = c.data as MemoryCardData;
      return { layerFrom: d.layerFrom ?? 0, layerTo: d.layerTo ?? 0, detail: d.detail };
    })
    .sort((a, b) => a.layerFrom - b.layerFrom);

  return { state, characters, memories, items, layerSummaries, allCards: cards, playerCard: playerCard ?? null, constants };
}

/* ------------------------------------------------------------------ */
/*  同会话回合锁：并发回合串行化（防止多开/双发互相踩踏）                  */
/* ------------------------------------------------------------------ */

const turnTails = new Map<string, Promise<void>>();

async function withTurnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = turnTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((r) => (release = r));
  turnTails.set(key, tail);
  await prev; // 等前一个回合（含其后台结算调度）结束；前一个失败不传染
  try {
    return await fn();
  } finally {
    release();
    if (turnTails.get(key) === tail) turnTails.delete(key);
  }
}

function turnLockKey(cfg: PipelineConfig): string {
  return cfg.chatId ?? cfg.worldId;
}

/* ------------------------------------------------------------------ */
/*  单回合主入口                                                        */
/* ------------------------------------------------------------------ */

export async function runTurn(cfg: PipelineConfig, index: WorldIndex, userMessage: string): Promise<PipelineResult> {
  return withTurnLock(turnLockKey(cfg), () => runTurnInner(cfg, index, userMessage));
}

async function runTurnInner(cfg: PipelineConfig, index: WorldIndex, userMessage: string): Promise<PipelineResult> {
  const { worldId, store, onDelta, onSettled } = cfg;
  const requestId = cfg.requestId ?? newRequestId();
  const state = index.state;
  const chatId = cfg.chatId ?? null;
  const currentTurn = state.turn;
  // 本回合完成后回合号立即 +1（后台结算只写卡片，不再推进回合号）
  const nextTurn = currentTurn + 1;

  // 会话优先的读写辅助（无 chatId 时退回世界级历史，兼容测试/demo）
  const pushHist = (line: HistoryLine, max = 50) =>
    chatId ? store.pushChatMessage(chatId, line, max) : store.pushHistory(worldId, line, max);
  const recentHist = (n: number) =>
    chatId ? store.recentChatMessages(chatId, n) : store.recentHistory(worldId, n);
  /** 世界指针落盘：会话模式写会话状态快照，无会话写世界状态 */
  const persistState = (s: WorldState) =>
    chatId ? store.updateChat(chatId, { state: s }) : store.putWorldState(worldId, s);

  const emit = (ev: PipelineStageEvent) => cfg.onStageEvent?.({ ...ev, requestId } as PipelineStageEvent);

  log.info(`回合开始 requestId=${requestId} chat=${chatId ?? worldId} turn=${state.turn}`, { msg: userMessage.slice(0, 60) });

  // 玩家这条输入先进滑动历史（NPC 回话在阶段 3 后追加）
  await pushHist({ speaker: 'user', text: userMessage, turn: currentTurn });

  // ---- 阶段 1：先挑卡（await，硬时序） ----
  const currentScene = index.allCards.find((c) => c.id === state.currentSceneId) as
    | (Card & { data: SceneCardData })
    | undefined;
  if (!currentScene) {
    throw new PitavernError('WORLD_MISSING', `世界 ${worldId} 的当前场景卡 ${state.currentSceneId} 不存在，请先 seed 或检查会话状态。`);
  }
  // M14/M17 路由叙事输入：与记忆分层同口径——近 bufferLayers 层全文。
  // 玩家刚发的这句话也在其中（它就是最新一行；曾为防"重复尾巴"排除，现已无尾巴，必须保留）
  const routerWindow = Math.min(400, Math.max(8, (cfg.layerBuffer ?? 3) * 6));
  const routerRecent = await recentHist(routerWindow);
  const t0 = performance.now();
  emit({ type: 'stage', stage: 'router', status: 'start' });
  let routeResult;
  try {
    routeResult = await preRouter(cfg.models, cfg.routerModel, {
      worldId,
      state,
      userMessage,
      currentScene,
      characters: index.characters,
      memories: index.memories,
      items: index.items,
      recentLines: routerRecent,
      // 分层摘要链：让路由知道全部剧情的大概（l1-20、l21-40…）
      layerSummaries: index.layerSummaries ?? [],
      routerSystemTemplate: cfg.promptTemplates?.routerSystem,
      // M15：常驻卡全量段（与演员同款；排除玩家卡/system）
      constants: index.constants
        .filter((c) => c.kind !== 'system' && !((c.data as CharacterCardData).isPlayer === true))
        .map((c) => {
          const d = c.data as { name?: string; summary?: string; detail?: string; description?: string; mclass?: string };
          return {
            id: c.id,
            kind: c.kind,
            name: d.name ?? d.summary ?? c.id,
            mclass: (c.data as { mclass?: string }).mclass,
            text: (d.detail ?? d.description ?? '').trim(),
          };
        }),
    }, { apiKey: cfg.apiKeys?.router });
  } catch (err) {
    emit({ type: 'stage', stage: 'router', status: 'error', detail: String(err) });
    throw err;
  }
  const routerMs = performance.now() - t0;
  const decision = routeResult.decision;
  emit({
    type: 'stage',
    stage: 'router',
    status: 'done',
    detail: {
      ...decision,
      debugPrompt: routeResult.debugPrompt,
      rawResponse: routeResult.rawResponse,
      request: routeResult.request,
    },
    tookMs: routerMs,
  });

  // 系统法则卡：恒定存在，由流水线注入（不依赖模型输出）
  const systemCardId = index.allCards.find((c) => c.kind === 'system')?.id ?? null;
  decision.systemCardId = systemCardId;

  // 阶段 1 若换了场景：在场角色 = 新场景常驻 + 本次决策点名（防丢人）
  // 防御：模型可能把 null 输出成字符串 "null"/"undefined"/"" → 归一并沿用当前场景
  const sceneIdRaw = decision.sceneCardId;
  const sceneId = sceneIdRaw === 'null' || sceneIdRaw === 'undefined' || sceneIdRaw === '' ? null : sceneIdRaw;
  if (sceneId && sceneId !== state.currentSceneId) {
    const newScene = index.allCards.find((c) => c.id === sceneId) as (Card & { data: SceneCardData }) | undefined;
    if (!newScene) {
      throw new PitavernError('WORLD_MISSING', `阶段 1 选择了不存在的场景卡 ${sceneId}`);
    }
    state.currentSceneId = sceneId;
    const residents = newScene.data.presentCharacterIds ?? [];
    // 决策点名的新角色补充进在场名单（去重、保持顺序）
    const merged = [...residents];
    for (const id of decision.characterCardIds) if (!merged.includes(id)) merged.push(id);
    state.presentCharacterIds = merged;
  } else {
    state.presentCharacterIds = decision.characterCardIds;
  }

  // ---- 阶段 2：拼积木（纯内存，< 2ms） ----
  // 完整上下文：默认取全量历史（记忆分层负责压缩旧段；不在此处裁剪）
  const history = await recentHist(400);
  const t1 = performance.now();
  emit({ type: 'stage', stage: 'assembler', status: 'start' });
  const assembled = await assembleCards(
    {
      worldId,
      state,
      route: decision,
      userMessage,
      history,
      userName: cfg.userName,
      layerSummaries: index.layerSummaries,
      playerCard: index.playerCard ?? undefined,
      constantCards: index.constants,
    },
    store,
  );
  const assembleMs = performance.now() - t1;
  emit?.({
    type: 'stage',
    stage: 'assembler',
    status: 'done',
    detail: { tokenEstimate: assembled.tokenEstimate, slots: assembled.slots },
    tookMs: assembleMs,
  });

  // ---- 阶段 3：演员打字（流式，带空闲超时熔断） ----
  // 演绎框架：组装器已把抽中的卡拼成设定快照（assembled.prompt）；
  // 这里叠加「演员身份 + 演绎规则」，让模型明确自己在扮演谁、怎么演。
  const actorName =
    (decision.speakerCharacterId ? index.characters.find((c) => c.id === decision.speakerCharacterId)?.name : null) ??
    '角色';
  // M16：演绎框架模板可编辑（缺省 DEFAULT_ACTOR_FRAME；{{char}} 展开为主讲名）
  const frameTpl = cfg.promptTemplates?.actorFrame?.trim() || DEFAULT_ACTOR_FRAME;
  const actingFrame = frameTpl.replaceAll('{{char}}', actorName);
  const actorContext = {
    systemPrompt: `${actingFrame}\n\n===== 以下为本回合的完整设定 =====\n${assembled.prompt}`,
    messages: [{ role: 'user' as const, content: userMessage, timestamp: Date.now() }],
  };
  const t2 = performance.now();
  emit({
    type: 'stage',
    stage: 'actor',
    status: 'start',
    detail: { debugPrompt: ctxToDebugPrompt(actorContext), request: ctxToStructured(actorContext) },
  });
  const streamResult = await consumeActorStream(cfg.models, cfg.actorModel, actorContext, (d) => {
    onDelta?.(d);
    emit({ type: 'stage', stage: 'actor', status: 'delta', detail: d });
  }, { apiKey: cfg.apiKeys?.actor, idleTimeoutMs: cfg.actorIdleTimeoutMs ?? 45_000 });
  const actorMs = performance.now() - t2;
  const reply = streamResult.reply;

  if (streamResult.error) {
    emit({ type: 'stage', stage: 'actor', status: 'error', detail: streamResult.error, tookMs: actorMs });
    log.warn(`演员阶段异常 requestId=${requestId}`, { error: streamResult.error, timedOut: streamResult.timedOut });
    // 半截正文也要入历史（玩家已看到），整段失败才抛错
    if (!reply) {
      throw new PitavernError('MODEL_FAILED', `[Actor] 演员未能产出正文: ${streamResult.error}`, { cause: streamResult.error });
    }
  } else {
    emit({ type: 'stage', stage: 'actor', status: 'done', detail: { length: reply.length, response: reply }, tookMs: actorMs });
  }

  // 正文写完（含半截），NPC 回话进历史（与玩家输入同回合号，保持同回合配对）
  if (reply) await pushHist({ speaker: 'NPC', text: reply, turn: currentTurn });

  // ---- 前台状态固化：场景/在场/回合号在回合结束立即落盘 ----
  // 背景：回合号原在后台结算里递增，连续快速发回合时第 2 回合可能读到
  // 结算前的 turn（回合号撞车/语义滞后）。改为前台推进：
  //   - 会话模式：写 chat.state 快照（结算写卡不碰 state，无竞争）
  //   - 无会话模式：写世界 state（postEvaluatorSync/后台结算不再自增 turn）
  state.turn = nextTurn;
  state.updatedAt = Date.now();
  try {
    await persistState(state);
  } catch (err) {
    log.warn(`世界状态落盘失败 requestId=${requestId}`, { error: String(err) });
  }
  // ---- M9-2 记忆分层：触发点（压缩宽度+缓冲）到了则后台压最旧段 ----
  const compressEvery = cfg.layerCompressEvery ?? 0;
  const layerBuffer = cfg.layerBuffer ?? 0;
  const compressRange = compressEvery > 0 ? layerCompressRange(nextTurn - 1, compressEvery, layerBuffer) : null;
  if (compressRange) {
    const layerTo = compressRange.to;
    const layerFrom = compressRange.from;
    void (async () => {
      try {
        const allLines = chatId ? await store.allChatMessages(chatId) : await store.recentHistory(worldId, 1000);
        const layerLines = allLines.filter((l) => l.turn >= layerFrom && l.turn <= layerTo);
        if (layerLines.length > 0) {
          // 用结算模型做摘要（有 evaluator key 走真实模型，否则 faux 占位）
          const charNames = index.characters.map((c) => c.name);
          const res = await summarizeLayer(cfg.models, cfg.evaluatorModel, store, {
            worldId,
            chatId: chatId ?? undefined,
            layerFrom,
            layerTo,
            lines: layerLines,
            characterNames: charNames,
            useRealModel: Boolean(cfg.apiKeys?.evaluator),
          }, { apiKey: cfg.apiKeys?.evaluator });
          if (res) emit({ type: 'stage', stage: 'evaluator', status: 'done', detail: { layerSummary: res.cardId, realModel: res.realModel } });
        }
      } catch (err) {
        log.warn(`层摘要失败 requestId=${requestId}`, { error: String(err) });
      }
    })();
  }

  // ---- 世界状态即时广播：回合末（正文完成、turn 已推进）立即推送 ----
  // 多端/面板不再等结算完成才看到换场与回合号（结算只更新卡片与好感）
  emit({
    type: 'world',
    worldId,
    turn: state.turn,
    sceneId: state.currentSceneId,
    presentCharacterIds: state.presentCharacterIds,
  });

  // ---- 阶段 4：后台静默结算（不加 await；只写卡片，不再推进回合号） ----
  const involvedCards = [
    ...index.allCards.filter((c) => c.id === state.currentSceneId || decision.characterCardIds.includes(c.id)),
    ...index.allCards.filter((c) => decision.memoryCardIds.includes(c.id) || decision.itemCardIds.includes(c.id)),
  ];
  const evalInput: EvalInput = {
    worldId,
    chatId: chatId ?? undefined,
    state,
    route: decision,
    userMessage,
    actorReply: reply,
    involvedCards,
  };
  if (cfg.settle !== false) {
    emit({ type: 'stage', stage: 'evaluator', status: 'start' });
    postEvaluatorRunAsync(cfg.models, cfg.evaluatorModel, evalInput, store, {
      apiKey: cfg.apiKeys?.evaluator,
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`结算后台任务异常 requestId=${requestId}`, { error: msg });
        emit({ type: 'stage', stage: 'evaluator', status: 'error', detail: msg });
      },
      onDone: (result) => {
        log.info(`结算完成 requestId=${requestId}`, { affection: result.affectionChanges });
        emit({ type: 'stage', stage: 'evaluator', status: 'done', detail: result });
        if (onSettled) onSettled(result);
      },
    });
  }

  // ---- token 用量统计（M2-5）：router+actor 本回合累计进会话存档 ----
  const usage = {
    input: (routeResult.usage?.input ?? 0) + (streamResult.usage?.input ?? 0),
    output: (routeResult.usage?.output ?? 0) + (streamResult.usage?.output ?? 0),
  };
  if (chatId && (usage.input > 0 || usage.output > 0)) {
    try {
      await store.updateChat(chatId, { usage: { ...usage, calls: 2 } }); // router + actor 两次调用
    } catch (err) {
      log.warn(`usage 累计失败 requestId=${requestId}`, { error: String(err) });
    }
  }

  log.info(`回合完成 requestId=${requestId}`, { routerMs, assembleMs, actorMs, tokens: assembled.tokenEstimate });

  return {
    decision,
    assembled: { prompt: assembled.prompt, tokenEstimate: assembled.tokenEstimate },
    reply,
    replyTruncated: Boolean(streamResult.error),
    timings: { routerMs, assembleMs, actorMs },
    modelsUsed: {
      router: routeResult.modelUsed,
      actor: `${cfg.actorModel.provider}/${cfg.actorModel.id}`,
      evaluator: `${cfg.evaluatorModel.provider}/${cfg.evaluatorModel.id}`,
    },
    requestId,
    usage: usage.input > 0 || usage.output > 0 ? usage : undefined,
  };
}

/* ------------------------------ 演示用种子数据 ------------------------------ */

/**
 * 构建 demo 索引（纯内存，不写 store）。
 * 参数 store 仅为签名兼容保留（历史版本在此触发写入）；
 * 需要落盘请用 seedDemoWorld(store)（await 完成后卡片才可读）。
 */
export function createDemoIndex(_store: CardStore): WorldIndex {
  const systemCard: Card = {
    id: 'sys_001',
    kind: 'system',
    data: {
      world: '灰烬镇',
      rules: [
        '把现实玩家（Master）和扮演角色（<user>）分清楚；你扮演<user>，永远不替 Master 做决定。',
        '禁止「倒吸一口凉气」「细若蚊蝇」等八股套话；用电影镜头般的微动作（指节敲桌、靴跟碾过碎瓦）代替。',
        '只演当前场景与在场角色；场外人与旧事仅以便利贴设定为准。',
        '每回合只让主讲角色开口，其他人只做背景动作。',
      ],
    },
  };
  const sceneInn: Card = {
    id: 'scene_inn',
    kind: 'scene',
    data: {
      name: '麋鹿与铁砧旅馆一楼',
      description: '炉火噼啪，麦酒桶沿墙排开，木楼梯通往二楼。窗外雨把灰烬镇浇成一片墨色。',
      presentCharacterIds: ['char_alicia'],
      itemIds: ['item_dagger'],
      recentChanges: [],
    },
  };
  const sceneSmithy: Card = {
    id: 'scene_smithy',
    kind: 'scene',
    data: {
      name: '安德鲁的铁匠铺',
      description: '风箱鼓动余烬，墙上挂满半成品镰刀与马蹄铁。安德鲁不在，炉火却还旺着。',
      presentCharacterIds: [],
      itemIds: [],
      recentChanges: [],
    },
  };
  const alicia: Card = {
    id: 'char_alicia',
    kind: 'character',
    data: {
      name: '艾莉西亚',
      role: '旅馆老板',
      description: '三十出头，左眉一道旧疤，围裙口袋里常年揣着一把开信刀。',
      personality: '嘴硬心软，警惕生人，对自己人极其护短。',
      speechStyle: '短句、带刺、爱用反问；紧张时会用指节敲柜台。',
      openingLine: '（擦杯子的手没停，抬眼扫了你一下）雨下成这样还赶路？找个座儿，麦酒还是热茶？',
      state: { affection: 60, innerThought: '这个外乡人深夜冒雨进店，先看看他葫芦里卖的什么药。', roomChanges: [], updatedAtTurn: 0 },
    },
  };
  const andrew: Card = {
    id: 'char_andrew',
    kind: 'character',
    data: {
      name: '安德鲁',
      role: '铁匠（场外人）',
      description: '镇上唯一的铁匠，三年前与艾莉西亚合伙开过武器铺，后决裂。',
      personality: '固执、记仇、手艺极好。',
      speechStyle: '话少，句句带铁锈味。',
      state: { affection: 10, innerThought: '（不在场）', roomChanges: [], updatedAtTurn: 0 },
    },
  };
  const memoryAndrew: Card = {
    id: 'mem_andrew_fallout',
    kind: 'memory',
    data: {
      ownerCharacterId: 'char_alicia',
      summary: '与铁匠安德鲁决裂',
      detail: '三年前安德鲁卷走了合伙铺子的货款，艾莉西亚从此不再提他，提起来就冷笑。',
      relatedIds: ['char_andrew'],
      keywords: ['安德鲁', '铁匠', '决裂', '货款', '旧账'],
    },
  };
  const itemDagger: Card = {
    id: 'item_dagger',
    kind: 'item',
    data: {
      name: '带血的短剑',
      description: '剑鞘沾着干涸的暗红，刃口崩了一角，柄上缠着旅馆的旧绳结。',
      location: 'scene',
      locationId: 'scene_inn',
    },
  };
  const allCards: Card[] = [systemCard, sceneInn, sceneSmithy, alicia, andrew, memoryAndrew, itemDagger];

  const worldId = 'demo_world';
  const state: WorldState = {
    currentSceneId: 'scene_inn',
    presentCharacterIds: ['char_alicia'],
    playerInventory: [],
    turn: 1,
    updatedAt: Date.now(),
  };

  // 全量索引（真实项目从 DB 分页查，Demo 直接构造）
  const index: WorldIndex = {
    state,
    characters: allCards
      .filter((c) => c.kind === 'character')
      .map((c) => {
        const d = c.data as CharacterCardData;
        return { id: c.id, name: d.name, role: d.role };
      }),
    memories: allCards
      .filter((c) => c.kind === 'memory')
      .map((c) => {
        const d = c.data as MemoryCardData;
        return { id: c.id, ownerCharacterId: d.ownerCharacterId, summary: d.summary, keywords: d.keywords, relatedIds: d.relatedIds };
      }),
    items: allCards
      .filter((c) => c.kind === 'item')
      .map((c) => {
        const d = c.data as ItemCardData;
        return { id: c.id, name: d.name, description: d.description, location: d.location };
      }),
    allCards,
    constants: [],
  };

  return index;
}

/** 把 demo 索引写入 store（等待全部落盘） */
async function persistDemoWorld(store: CardStore, index: WorldIndex): Promise<void> {
  await Promise.all([
    store.putWorldState('demo_world', index.state),
    ...index.allCards.map(async (card) => {
      await store.putCard(card);
      await store.addCardToWorld('demo_world', card.id);
    }),
  ]);
}

/**
 * 种子世界落盘（确定版）：把 demo 索引全部写入 store 并等待完成。
 * 消除早期「void 写入 + sleep(20)」的竞态 —— 服务/测试/seed 入口都走这里。
 */
export async function seedDemoWorld(store: CardStore): Promise<WorldIndex> {
  const index = createDemoIndex(store);
  await persistDemoWorld(store, index);
  return index;
}

/** 汇总卡片 token 体积（调试用） */
export function cardCount(index: WorldIndex): number {
  return index.allCards.length;
}
