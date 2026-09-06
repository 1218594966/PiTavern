/**
 * PiTavern Web 网关：浏览器聊天页 + WebSocket 四阶段事件推送。
 *
 *   npm run web          # 启动（默认 http://localhost:3100）
 *   PORT=3200 npm run web
 *
 * 前端页面内嵌在 src/web/index.html（零构建、零依赖，原生 http + WebSocketServer）。
 * 每个连接的浏览器 = 一个「玩家会话」，共用 demo_world（单机演示）；
 * 多开页面时共享世界状态（faux 模型响应队列会串，真实模型下各自推进）。
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { openDefaultStore } from '../db/file-store.js';
import type { CardStore } from '../db/store.js';
import type { Card, SceneCardData } from '../types.js';
import {
  getFauxModels,
  getModels,
  getStageModel,
  setStageRuntimeConfig,
  stageUsesRealModel,
  resolveStageModelAsync,
  resolveModelConfig,
} from '../config/models.js';
import {
  listProviderCatalog,
  listUpstreamModels,
  setRuntimeKey,
  testProviderConnection,
  resolveProviderKey,
  apiKeyForStage,
  ensureCustomProvider,
} from '../config/provider-registry.js';
import { seedDemoWorld, loadWorldIndex as loadWorldIndexFromStore, runTurn } from '../pipeline.js';
import { buildRouterContext, routerDebugFlow } from '../stages/pre-router.js';
import { ctxToStructured } from '../utils/prompt-debug.js';
import type { PipelineStageEvent } from '../pipeline.js';
import { importCards } from '../cards/importer.js';
import { importWorldToArchive, getWorldGreeting, toTavernV2 } from '../db/archive.js';
import { expandMacros } from '../utils/macros.js';
import { estimateTokens } from '../utils/tokens.js';
import type { Persona } from '../types.js';

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '0.0.0.0';
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf8');

interface ClientSession {
  ws: WebSocket;
  /** 是否正在处理一回合（防重入） */
  busy: boolean;
  /** 当前游玩的世界（默认 demo_world；导入世界后可切换） */
  worldId: string;
  /** 当前会话（一次跑团；切换世界时自动新建） */
  chatId: string | null;
}

/** 当前各阶段是否真实模型（供横幅/hello 展示；任一阶段有 Key 即真实） */
function modeSummary(): { router: boolean; actor: boolean; evaluator: boolean; anyReal: boolean } {
  const router = stageUsesRealModel('router');
  const actor = stageUsesRealModel('actor');
  const evaluator = stageUsesRealModel('evaluator');
  return { router, actor, evaluator, anyReal: router || actor || evaluator };
}

/** M18：把 Card/校园.png 补种为默认世界 world_校园（若存在且未导入过；幂等） */
async function seedCampusWorldIfPresent(store: CardStore): Promise<string | null> {
  try {
    const worlds = await store.listWorlds();
    if (worlds.includes('world_校园')) return 'world_校园'; // 已存在
    let png;
    try { png = readFileSync('Card/校园.png'); } catch { return null; }
    const result = await importCards(png);
    await importWorldToArchive(store, result.cards, '校园', {
      worldGreeting: (result as { worldGreeting?: { speaker: string; text: string } }).worldGreeting,
    });
    console.log('[web] 已补种默认世界 world_校园（Card/校园.png）');
    return 'world_校园';
  } catch (err) {
    console.warn(`[seedCampus] 补种校园世界失败: ${String(err).slice(0, 120)}`);
    return null;
  }
}

async function main() {
  // ---- 存储层：PITAVERN_DATA_DIR（文件持久化）> REDIS_URL（Redis）> 内存 ----
  const opened = await openDefaultStore();
  const store: CardStore = opened.store;
  console.log(`[web] 存储: ${opened.kind}（${opened.detail}）`);

  // ---- 种子与默认世界 ----
  // 全新存储：优先用用户的校园角色卡（Card/校园.png）作为默认世界；
  // 仅当校园卡缺失/导入失败时才兜底播种内置示例世界 demo_world（老用户不受影响）。
  let defaultWorldId = 'demo_world';
  const campusId = await seedCampusWorldIfPresent(store);
  if (campusId) {
    defaultWorldId = campusId;
    if (!opened.recovered) {
      console.log(`[web] 默认世界: ${campusId}（校园角色卡）`);
    }
  }
  if (!opened.recovered && !campusId) {
    await seedDemoWorld(store);
    console.log('[web] 已播种示例世界 demo_world（未检测到 Card/校园.png，作为兜底示例）');
  }

  // ---- 模型路由（可变引用：网页 provider_set 可热切换） ----
  // 单一共享集合：真实 provider 与 faux 混搭注册。每阶段独立解析：
  //   配了 Key（env / provider 级 / 网页运行时 Key）→ 真实模型
  //   没配 → faux 演示模型
  ensureCustomProvider('commandcode');
  await getModels().refresh({ providers: ['commandcode'] });
  const stageModels = {
    router: await resolveStageModelAsync('router').then((m) => m ?? getStageModel('router')),
    actor: await resolveStageModelAsync('actor').then((m) => m ?? getStageModel('actor')),
    evaluator: await resolveStageModelAsync('evaluator').then((m) => m ?? getStageModel('evaluator')),
  };
  const models = getModels();
  const banner = modeSummary();
  console.log(`[web] 阶段1 PreRouter 模型: ${stageModels.router.provider}/${stageModels.router.id}${banner.router ? '' : '（faux）'}`);
  console.log(`[web] 阶段3 Actor    模型: ${stageModels.actor.provider}/${stageModels.actor.id}${banner.actor ? '' : '（faux）'}`);
  console.log(`[web] 阶段4 Evaluator 模型: ${stageModels.evaluator.provider}/${stageModels.evaluator.id}${banner.evaluator ? '' : '（faux）'}`);

  // faux 模式（任一阶段为 faux 都预置脚本响应；真实阶段会忽略对应响应）
  if (!banner.anyReal) {
    const faux = getFauxModels();
    // 多回合支持：响应队列里放 5 组（用完后 faux 返回错误消息，前端能看到容错）
    // 角色 id 动态取自默认世界第一个非玩家角色（不硬编码 demo 世界的角色；
    // 若默认世界是校园卡，faux 决策也会指向真实存在的校园角色）。
    const defCards = defaultWorldId ? (await store.getCards(await store.listWorldCards(defaultWorldId))).filter((c): c is Card => c !== null) : [];
    const defChar = defCards.find((c) => c.kind === 'character' && (c.data as { isPlayer?: boolean }).isPlayer !== true);
    const defCharId = defChar?.id ?? null;
    const defSceneId = defCards.find((c) => c.kind === 'scene')?.id ?? null;
    const defMemId = defCards.find((c) => c.kind === 'memory' && !(c.data as { isSummary?: boolean }).isSummary)?.id ?? null;
    const defItemId = defCards.find((c) => c.kind === 'item')?.id ?? null;
    const routerResp = [
      { sceneCardId: null, characterCardIds: defCharId ? [defCharId] : [], speakerCharacterId: defCharId, memoryCardIds: defMemId ? [defMemId] : [], itemCardIds: [], historyWindow: 6, turn: 1 },
      { sceneCardId: null, characterCardIds: defCharId ? [defCharId] : [], speakerCharacterId: defCharId, memoryCardIds: [], itemCardIds: defItemId ? [defItemId] : [], historyWindow: 6, turn: 2 },
      { sceneCardId: defSceneId, characterCardIds: [], speakerCharacterId: null, memoryCardIds: [], itemCardIds: [], historyWindow: 6, turn: 3 },
      { sceneCardId: null, characterCardIds: defCharId ? [defCharId] : [], speakerCharacterId: defCharId, memoryCardIds: defMemId ? [defMemId] : [], itemCardIds: [], historyWindow: 6, turn: 4 },
      { sceneCardId: null, characterCardIds: defCharId ? [defCharId] : [], speakerCharacterId: defCharId, memoryCardIds: [], itemCardIds: defItemId ? [defItemId] : [], historyWindow: 6, turn: 5 },
    ];
    const defName = (defChar?.data as { name?: string })?.name ?? '角色';
    const actorResp = [
      `${defName}轻轻点了点头，目光落向你：「嗯，我在听。你刚才说的事——后来怎么样了？」`,
      `${defName}想了想，语气放缓了一些：「这样啊……我大概明白了。你打算怎么办？」`,
      `${defName}环顾四周，这里看起来刚有人离开不久，炉火还温着。\n（场景空荡，主人不知去向。）`,
      `${defName}给你倒了杯热茶推过来：「先喝口热的，慢慢说。」`,
      `${defName}若有所思地看了你一眼：「这事我知道了。放心，不会到处说。」`,
    ];
    const evalResp = [
      defCharId ? { affectionChanges: [{ characterId: defCharId, delta: -1 }], innerThoughts: [{ characterId: defCharId, thought: '他提到的旧事让我起了戒心，先试探两句。' }], roomChanges: [], itemTransfers: [], newMemoryCards: [] } : { affectionChanges: [], innerThoughts: [], roomChanges: [], itemTransfers: [], newMemoryCards: [] },
      defCharId ? { affectionChanges: [{ characterId: defCharId, delta: 1 }], innerThoughts: [{ characterId: defCharId, thought: '这人看着不像坏人，可以多聊两句。' }], roomChanges: [], itemTransfers: [], newMemoryCards: [] } : { affectionChanges: [], innerThoughts: [], roomChanges: [], itemTransfers: [], newMemoryCards: [] },
      { affectionChanges: [], innerThoughts: [], roomChanges: [], itemTransfers: [], newMemoryCards: [] },
      defCharId ? { affectionChanges: [{ characterId: defCharId, delta: 2 }], innerThoughts: [{ characterId: defCharId, thought: '他肯说实话，倒是个爽快人。' }], roomChanges: [], itemTransfers: [], newMemoryCards: [] } : { affectionChanges: [], innerThoughts: [], roomChanges: [], itemTransfers: [], newMemoryCards: [] },
      defCharId ? { affectionChanges: [{ characterId: defCharId, delta: 1 }], innerThoughts: [{ characterId: defCharId, thought: '这人知道分寸，可以多聊两句。' }], roomChanges: [], itemTransfers: [], newMemoryCards: [] } : { affectionChanges: [], innerThoughts: [], roomChanges: [], itemTransfers: [], newMemoryCards: [] },
    ];
    faux.setResponses({
      router: routerResp.map((r) => fauxAssistantMessage([fauxText(JSON.stringify(r))])),
      actor: actorResp.map((t) => fauxAssistantMessage([fauxText(t)])),
      evaluator: evalResp.map((r) => fauxAssistantMessage([fauxText(JSON.stringify(r))])),
    });
  }

  // ---- HTTP 服务器（静态页） ----
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      // 开发阶段页面零构建：禁用缓存，保证刷新即最新
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(INDEX_HTML);
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  // ---- WebSocket 网关 ----
  // 轻鉴权：设了 PT_TOKEN 环境变量后，WS 连接必须带 ?token=<PT_TOKEN>（HTTP 静态页不受限）
  const PT_TOKEN = process.env.PT_TOKEN;
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      /* 保持空 */
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (PT_TOKEN) {
      const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
      if (token !== PT_TOKEN) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** 给所有正在看某 chatId 的客户端广播（多开同步用） */
  function broadcastToChat(chatId: string, msg: unknown): void {
    for (const c of clients) {
      if (c.chatId === chatId && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify(msg));
      }
    }
  }

  const clients = new Set<ClientSession>();
  /** per-chat 回合互斥：同 chat 多端同时发消息只有一个回合在跑 */
  const chatBusy = new Set<string>();

  /** 世界卡摘要（画廊/卡更新后刷新用） */
  async function summarizeWorldCards(worldId: string) {
    const ids = await store.listWorldCards(worldId);
    const cards = (await store.getCards(ids)).filter((c): c is Card => c !== null);
    return cards.map((c) => {
      const cd = c.data as unknown as Record<string, unknown>;
      return {
        id: c.id,
        kind: c.kind,
        name:
          typeof cd.name === 'string'
            ? cd.name
            : c.kind === 'memory' && typeof cd.summary === 'string'
              ? cd.summary
              : c.id,
        role: typeof cd.role === 'string' ? cd.role : undefined,
        description: typeof cd.description === 'string' ? cd.description : undefined,
        personality: typeof cd.personality === 'string' ? cd.personality : undefined,
        scenario: typeof cd.scenario === 'string' ? cd.scenario : undefined,
        openingLine: typeof cd.openingLine === 'string' ? cd.openingLine : undefined,
        speechStyle: typeof cd.speechStyle === 'string' ? cd.speechStyle : undefined,
        avatar: typeof cd.avatar === 'string' ? cd.avatar : undefined,
        keywords: c.keywords ?? [],
        summary: c.kind === 'memory' && typeof cd.summary === 'string' ? cd.summary : undefined,
        ownerCharacterId: (c.kind === 'memory' || c.kind === 'item') && typeof cd.ownerCharacterId === 'string' ? cd.ownerCharacterId : undefined,
        itemLocation: c.kind === 'item' && typeof cd.location === 'string' ? cd.location : undefined,
        itemLocationId: c.kind === 'item' && typeof cd.locationId === 'string' ? cd.locationId : undefined,
        isSummary: c.kind === 'memory' && cd.isSummary === true ? true : undefined,
        layerFrom: c.kind === 'memory' && typeof cd.layerFrom === 'number' ? cd.layerFrom : undefined,
        layerTo: c.kind === 'memory' && typeof cd.layerTo === 'number' ? cd.layerTo : undefined,
        isPlayer: c.kind === 'character' && cd.isPlayer === true ? true : undefined,
        contextMode: c.kind === 'character' && (cd as { contextMode?: string }).contextMode === 'summary' ? 'summary' : undefined,
        constant: c.constant === true ? true : undefined,
        mclass: c.kind === 'memory' && typeof (cd as { mclass?: string }).mclass === 'string' ? (cd as { mclass?: string }).mclass : undefined,
        detail: c.kind === 'memory' && typeof (cd as { detail?: string }).detail === 'string' ? (cd as { detail?: string }).detail : undefined,
        memSummary: c.kind === 'memory' && typeof cd.summary === 'string' ? cd.summary : undefined,
        relationships: c.kind === 'character' && Array.isArray(cd.relationships) ? (cd.relationships as unknown[]) : undefined,
        progression: c.kind === 'character' && Array.isArray(cd.progression) ? (cd.progression as string[]) : undefined,
        timeline: c.kind === 'system' && Array.isArray(cd.timeline) ? (cd.timeline as string[]) : undefined,
        textTokens: estimateTokens([c.kind, cd.name, cd.description, cd.personality, cd.openingLine].filter(Boolean).join(' ')),
      };
    });
  }

  /**
   * 跑一个完整回合（chat / chat_regenerate 共用）。
   * 前置：会话已存在、busy 已置位。结束由调用方复位 busy 并处理 turn_done/error。
   * @returns 新生成的 NPC 消息 id（无则 null）
   */
  async function runOneTurn(ws: WebSocket, session: ClientSession, chatId: string, text: string): Promise<string | null> {
    // 只加载本会话的层摘要卡（其它会话的摘要不进上下文）
    const worldIndex = await loadWorldIndexFromStore(store, session.worldId, { chatId });
    if (!worldIndex || worldIndex.allCards.length === 0) {
      send(ws, { type: 'error', message: `世界 ${session.worldId} 没有卡片，请先导入或切换到示例世界` });
      return null;
    }
    const chat = await store.getChat(chatId);
    if (!chat) return null;
    const apiKeys = {
      router: apiKeyForStage('router', stageModels.router.provider),
      actor: apiKeyForStage('actor', stageModels.actor.provider),
      evaluator: apiKeyForStage('evaluator', stageModels.evaluator.provider),
    };
    // 思考强度：各阶段独立（provider_set 写入运行时配置）
    const reasoning = {
      router: resolveModelConfig('router').reasoning,
      actor: resolveModelConfig('actor').reasoning,
      evaluator: resolveModelConfig('evaluator').reasoning,
    };
    // 会话状态快照合并进索引（场景/在场/回合/好感 overlay 都是会话独立的）
    const idx = { ...worldIndex, state: chat.state };
    const result = await runTurn(
      {
        worldId: session.worldId,
        chatId,
        models,
        routerModel: stageModels.router,
        actorModel: stageModels.actor,
        evaluatorModel: stageModels.evaluator,
        store,
        apiKeys,
        reasoning,
        userName: chat.persona?.name?.trim() || undefined,
        // 记忆分层两参数：兼容旧 summaryEveryTurns（= compressEvery, buffer 0）
        layerCompressEvery: chat.settings?.layerCompressEvery ?? chat.settings?.summaryEveryTurns ?? 0,
        layerBuffer: chat.settings?.layerBuffer ?? 0,
        // M16 提示词模板（可编辑）
        promptTemplates: chat.settings?.promptTemplates,
        // 同屏：回合事件广播给同 chat 全部客户端（多端跟随流式/阶段/结算）
        onDelta: (d) => broadcastToChat(chatId, { type: 'delta', text: d }),
        onStageEvent: (ev: PipelineStageEvent) => broadcastToChat(chatId, ev),
        onSettled: async (r) => {
          // 结算完成：附带各角色最新好感度（前端世界状态显示用）
          // 会话模式好感在 chat.state.npcStates（overlay），世界模式在卡上
          const r2 = r as { affectionChanges?: Array<{ characterId: string; delta: number }> };
          const affections: Record<string, number> = {};
          const chatNow = await store.getChat(chatId);
          const npc = chatNow?.state.npcStates ?? {};
          for (const c of r2.affectionChanges ?? []) {
            if (npc[c.characterId]) {
              affections[c.characterId] = npc[c.characterId]!.affection;
              continue;
            }
            const card = await store.getCard(c.characterId);
            if (card?.kind === 'character') {
              affections[c.characterId] = (card.data as { state: { affection: number } }).state.affection;
            }
          }
          broadcastToChat(chatId, { type: 'settled', result: r, affections });
        },
      },
      idx,
      text,
    );
    // 回合结束：把刚生成的 NPC 消息 id 带给前端（编辑/重roll 用）
    const tail = await store.recentChatMessages(chatId, 3);
    const lastNpc = [...tail].reverse().find((l) => l.speaker !== 'user' && l.text);
    const lastNpcId = lastNpc?.id ?? null;
    broadcastToChat(chatId, {
      type: 'turn_done',
      reply: result.reply,
      timings: result.timings,
      decision: result.decision,
      tokenEstimate: result.assembled.tokenEstimate,
      lastNpcId,
      usage: result.usage ?? null,
    });
    return lastNpcId;
  }

  // ---- 世界管理 ----
  /**
   * 列出所有可玩世界（demo + 导入）。每个导入的「游戏卡」即一个独立世界
   * （仓库语义）：内含多角色/记忆/场景/物品，此摘要带封面与分类件数，
   * 供前端仓库界面展示。
   */
  async function listPlayableWorlds() {
    const worlds = await store.listWorlds();
    // M18 之后：内置示例 demo_world 不再是默认。若用户校园世界已存在（world_校园），
    // 从候选列表隐藏 demo_world——「演示旅馆」只在没有任何导入/校园世界时作为兜底出现。
    const hasCampus = worlds.includes('world_校园');
    const visible = worlds.filter((w) => !(hasCampus && w === 'demo_world'));
    const out: Array<{
      worldId: string;
      name: string;
      characters: string[];
      scenes: string[];
      counts: { character: number; memory: number; scene: number; item: number; system: number };
      avatar: string | null;
      kind: 'demo' | 'import';
      greeting?: { speaker: string; text: string };
    }> = [];
    for (const w of visible) {
      const cards = (await store.getCards(await store.listWorldCards(w))).filter((c): c is Card => c !== null);
      const chars: string[] = [];
      const scenes: string[] = [];
      const counts = { character: 0, memory: 0, scene: 0, item: 0, system: 0, player: 0 };
      let avatar: string | null = null;
      for (const c of cards) {
        const d = c.data as { name?: string; avatar?: string; isPlayer?: boolean };
        if (c.kind === 'character') {
          if (d.isPlayer === true) { counts.player++; continue; }
          chars.push(d.name ?? c.id);
          counts.character++;
          if (!avatar && typeof d.avatar === 'string' && d.avatar) avatar = d.avatar;
        } else if (c.kind === 'scene') {
          scenes.push(d.name ?? c.id);
          counts.scene++;
        } else if (c.kind === 'memory') counts.memory++;
        else if (c.kind === 'item') counts.item++;
        else if (c.kind === 'system') counts.system++;
      }
      // M12：开场白预览（世界级 greeting 优先，fallback 首个带开场白的角色）
      const wsState = await store.getWorldState(w);
      const wGreeting = wsState?.greeting;
      let greeting: { speaker: string; text: string } | undefined;
      if (wGreeting?.text) greeting = { speaker: wGreeting.speaker, text: wGreeting.text };
      else {
        const firstLine = cards.find((c) => c.kind === 'character' && (c.data as { openingLine?: string }).openingLine);
        if (firstLine) {
          const d = firstLine.data as { name: string; openingLine?: string };
          greeting = { speaker: d.name, text: d.openingLine ?? '' };
        }
      }
      out.push({
        worldId: w,
        name: w === 'demo_world' ? '演示旅馆' : w.replace(/^world_/, '').replace(/-/g, ' '),
        characters: chars,
        scenes,
        counts,
        avatar,
        kind: w === 'demo_world' ? 'demo' : 'import',
        greeting,
      });
    }
    return out;
  }

  /** 给会话补一个标题（优先主角名） */
  async function worldDefaultTitle(worldId: string): Promise<string> {
    const cards = await store.getCards(await store.listWorldCards(worldId));
    const mainChar = cards.find((c) => c?.kind === 'character');
    if (mainChar) return `与 ${(mainChar.data as { name: string }).name} 的冒险`;
    return worldId.replace(/^(world_|demo_)/, '');
  }

  /** 世界开局问候：新建会话时若角色卡有 openingLine，写入首条 NPC 消息 */
  async function seedGreeting(chatId: string, worldId: string): Promise<void> {
    const existing = await store.allChatMessages(chatId);
    if (existing.length > 0) return; // 只给空会话播种
    const g = await getWorldGreeting(store, worldId);
    if (!g) return;
    // 宏展开：{{user}} → persona 名；{{char}} → 说话角色名
    const chat = await store.getChat(chatId);
    const personaName = chat?.persona?.name?.trim();
    const text = expandMacros(g.text, { userName: personaName, charName: g.speaker });
    await store.pushChatMessage(chatId, { speaker: g.speaker, text, turn: 0 }, 200);
  }

  /**
   * persona 更新后追加重展开：仅当会话只有开场白（greeting，turn 0）时，
   * 用新 persona 重新展开原始开场白（{{user}} → persona 名）。
   * 不追溯已展开的历史对话（persona 变更只影响开场）。
   */
  async function refreshGreetingForPersona(chatId: string, worldId: string, personaName?: string): Promise<void> {
    const lines = await store.allChatMessages(chatId);
    if (lines.length !== 1 || lines[0]!.turn !== 0) return;
    const g = await getWorldGreeting(store, worldId);
    if (!g) return;
    const text = expandMacros(g.text, { userName: personaName, charName: g.speaker });
    await store.editChatMessage(chatId, lines[0]!.id!, text);
  }

  /** 确保会话存在：无 chatId 时取最近会话或自动新建 */
  async function ensureChat(session: ClientSession): Promise<string | null> {
    const chats = await store.listChats(session.worldId);
    if (chats.length > 0) {
      // 只把「当前会话仍存在」的补选为当前；客户端没在会话时禁止静默操作它
      const current = chats.find((c) => c.chatId === session.chatId);
      session.chatId = current?.chatId ?? chats[0]!.chatId;
      return session.chatId;
    }
    // 无会话 → 用世界初始状态建一个（带开场白）
    const wsState = await store.getWorldState(session.worldId);
    if (!wsState) return null;
    const title = await worldDefaultTitle(session.worldId);
    const meta = await store.createChat(session.worldId, title, wsState);
    session.chatId = meta.chatId;
    await seedGreeting(meta.chatId, session.worldId);
    return meta.chatId;
  }

  /** 切换世界并确保会话 */
  async function switchWorld(session: ClientSession, wid: string): Promise<string | null> {
    session.worldId = wid;
    session.chatId = null;
    return ensureChat(session);
  }

  wss.on('connection', (ws) => {
    const session: ClientSession = { ws, busy: false, worldId: defaultWorldId, chatId: null };
    clients.add(session);
    const m = modeSummary();
    send(ws, { type: 'hello', models: {
      router: `${stageModels.router.provider}/${stageModels.router.id}`,
      actor: `${stageModels.actor.provider}/${stageModels.actor.id}`,
      evaluator: `${stageModels.evaluator.provider}/${stageModels.evaluator.id}`,
      // 逐阶段真实/演示标记（前端横幅用）；mode 保留语义 = 任一阶段真实即 real
      stages: { router: m.router, actor: m.actor, evaluator: m.evaluator },
      mode: m.anyReal ? 'real' : 'faux',
    } });

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        send(ws, { type: 'error', message: 'JSON 解析失败' });
        return;
      }
      if (msg.type === 'chat') {
        const rawText = String(msg.text ?? '').trim();
        if (!rawText) return;
        // ---- 斜杠命令（场外表达） ----
        // /roll NdM（或 dM）→ 掷骰，结果以玩家行入历史并广播（不跑回合）
        const rollMatch = rawText.match(/^\/(roll|r)\s+(\d*)d(\d+)(.*)$/i);
        if (rollMatch) {
          let targetId = String(msg.chatId ?? session.chatId ?? '');
          if (!targetId) {
            const ensured = await ensureChat(session);
            if (!ensured) return;
            targetId = ensured;
          }
          const count = Math.min(Number(rollMatch[2] || '1') || 1, 100);
          const sides = Math.min(Number(rollMatch[3] || '6'), 1000);
          const label = rollMatch[4]?.trim() ? `（${rollMatch[4]!.trim()}）` : '';
          const rolls: number[] = [];
          for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
          const total = rolls.reduce((a, b) => a + b, 0);
          const summary = count > 1 ? ` = ${total}` : '';
          const resultText = `/roll ${count}d${sides}${label} → ${rolls.join(' + ')}${summary}`;
          const chatMeta = await store.getChat(targetId);
          await store.pushChatMessage(targetId, { speaker: 'user', text: resultText, turn: chatMeta?.state.turn ?? 1 }, 200);
          broadcastToChat(targetId, { type: 'chat_history_changed', chatId: targetId, history: await store.allChatMessages(targetId) });
          return;
        }
        if (rawText.startsWith('/ooc ')) {
          // 场外行：存历史（OOC 标注），不触发回合
          let targetId = String(msg.chatId ?? session.chatId ?? '');
          if (!targetId) {
            const ensured = await ensureChat(session);
            if (!ensured) return;
            targetId = ensured;
          }
          const oocText = rawText.slice(5).trim();
          if (oocText) {
            const chatMeta = await store.getChat(targetId);
            await store.pushChatMessage(targetId, { speaker: 'ooc', text: oocText, turn: chatMeta?.state.turn ?? 1 }, 200);
            broadcastToChat(targetId, { type: 'chat_history_changed', chatId: targetId, history: await store.allChatMessages(targetId) });
          }
          return;
        }
        // /me xxx → 玩家动作（作为 user 输入走正常回合）
        let text = rawText;
        if (text.startsWith('/me ')) text = text.slice(4).trim();
        if (!text) return;
        if (session.busy) {
          send(ws, { type: 'error', message: '你上一回合还在处理中，请稍候' });
          return;
        }
        session.busy = true;
        try {
          // 确保会话存在（自动新建首个会话）
          const chatId = await ensureChat(session);
          if (!chatId) {
            send(ws, { type: 'error', message: `世界 ${session.worldId} 没有初始状态，请先导入或切换到示例世界` });
            session.busy = false;
            return;
          }
          // per-chat 互斥：同 chat 其它端在跑回合时拒绝（不排队，避免陈旧状态竞态）
          if (chatBusy.has(chatId)) {
            send(ws, { type: 'error', message: '该会话正有回合在处理中（可能是其它窗口），请稍候' });
            session.busy = false;
            return;
          }
          chatBusy.add(chatId);
          try {
            await runOneTurn(ws, session, chatId, text);
          } finally {
            chatBusy.delete(chatId);
          }
        } catch (err) {
          send(ws, { type: 'error', message: String(err) });
        } finally {
          session.busy = false;
        }
        return;
      }

      // ---- 会话管理协议 ----
      if (msg.type === 'chat_list') {
        const chats = await store.listChats(session.worldId);
        send(ws, { type: 'chat_list', worldId: session.worldId, chats, current: session.chatId });
        return;
      }
      if (msg.type === 'chat_new') {
        const title = String(msg.title ?? '').trim() || (await worldDefaultTitle(session.worldId));
        const wsState = await store.getWorldState(session.worldId);
        if (!wsState) {
          send(ws, { type: 'error', message: '该世界无初始状态，无法新建会话' });
          return;
        }
        const meta = await store.createChat(session.worldId, title, wsState);
        session.chatId = meta.chatId;
        await seedGreeting(meta.chatId, session.worldId);
        const history = await store.allChatMessages(meta.chatId);
        send(ws, { type: 'chat_selected', chatId: meta.chatId, title: meta.title, chat: meta, history });
        return;
      }
      if (msg.type === 'chat_select') {
        const chatId = String(msg.chatId ?? '');
        const meta = await store.getChat(chatId);
        if (!meta || meta.worldId !== session.worldId) {
          send(ws, { type: 'error', message: `会话 ${chatId} 不存在或不属于当前世界` });
          return;
        }
        session.chatId = chatId;
        const history = await store.allChatMessages(chatId);
        send(ws, { type: 'chat_selected', chatId, title: meta.title, chat: meta, history });
        return;
      }
      if (msg.type === 'chat_edit') {
        // 编辑某条历史消息（按消息 id；无 id 的旧数据不支持编辑）
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        if (chatBusy.has(chatId)) {
          send(ws, { type: 'error', message: '回合处理中，请稍后再编辑' });
          return;
        }
        const messageId = String(msg.messageId ?? '');
        const text = String(msg.text ?? '').trim();
        if (!chatId || !messageId || !text) return;
        const ok = await store.editChatMessage(chatId, messageId, text);
        if (ok) {
          // 编辑成功 → 通知该会话其它端刷新
          const history = await store.allChatMessages(chatId);
          broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history });
        } else {
          send(ws, { type: 'error', message: '编辑失败：消息不存在或缺少稳定 id' });
        }
        return;
      }
      if (msg.type === 'chat_set_excluded') {
        // 出戏开关：excluded=true 的行不进模型上下文（保留历史）
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        if (chatBusy.has(chatId)) {
          send(ws, { type: 'error', message: '回合处理中，请稍后再切换' });
          return;
        }
        const messageId = String(msg.messageId ?? '');
        const excluded = Boolean(msg.excluded);
        if (!chatId || !messageId) return;
        const ok = await store.setChatMessageExcluded(chatId, messageId, excluded);
        if (ok) {
          const history = await store.allChatMessages(chatId);
          broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history });
        } else {
          send(ws, { type: 'error', message: '切换失败：消息不存在或缺少稳定 id' });
        }
        return;
      }
      if (msg.type === 'chat_delete_message') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        if (chatBusy.has(chatId)) {
          send(ws, { type: 'error', message: '回合处理中，请稍后再删除' });
          return;
        }
        const messageId = String(msg.messageId ?? '');
        if (!chatId || !messageId) return;
        await store.deleteChatMessages(chatId, [messageId]);
        const history = await store.allChatMessages(chatId);
        broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history });
        return;
      }
      if (msg.type === 'chat_regenerate') {
        // 重roll 最后一条 NPC 回复：删除「最后 NPC 回复 + 它前面最近的 user 输入」，
        // 用那句 user 输入重跑整个回合；旧回复文本迁移为新回复的楼层（swipes）历史。
        if (session.busy) {
          send(ws, { type: 'error', message: '上一回合还在处理中，请稍候' });
          return;
        }
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        if (chatBusy.has(chatId)) {
          send(ws, { type: 'error', message: '该会话正有回合在处理中（可能是其它窗口），请稍候' });
          return;
        }
        const lines = await store.allChatMessages(chatId);
        // 找最后一条 NPC 消息（ES2022 无 findLastIndex，用循环）
        let lastNpcIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i]!;
          if (l.speaker !== 'user' && l.text) {
            lastNpcIdx = i;
            break;
          }
        }
        if (lastNpcIdx < 0) {
          send(ws, { type: 'error', message: '没有可重roll的 NPC 回复' });
          return;
        }
        let lastUserIdx = -1;
        for (let i = lastNpcIdx - 1; i >= 0; i--) {
          if (lines[i]!.speaker === 'user') {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx < 0) {
          send(ws, { type: 'error', message: '找不到对应的玩家输入，无法重roll（请手动删除后重发）' });
          return;
        }
        const userText = lines[lastUserIdx]!.text;
        const oldNpc = lines[lastNpcIdx]!;
        // 旧回复（含已有楼层）→ 迁移到新回复的 swipes
        const legacySwipes = [...(oldNpc.swipes ?? []), oldNpc.text];
        const dropIds = [oldNpc.id, lines[lastUserIdx]!.id].filter(Boolean) as string[];
        if (dropIds.length === 0) {
          send(ws, { type: 'error', message: '消息缺少稳定 id，无法重roll' });
          return;
        }
        await store.deleteChatMessages(chatId, dropIds);
        broadcastToChat(chatId, { type: 'chat_rolled_back', chatId, messageIds: dropIds });
        // 用同一句玩家输入重跑（per-chat 互斥）
        session.busy = true;
        chatBusy.add(chatId);
        try {
          const newNpcId = await runOneTurn(ws, session, chatId, userText);
          if (newNpcId) {
            // 新回复挂上旧楼层（注意此时新消息 text=新回复，作为当前版）
            const fresh = (await store.allChatMessages(chatId)).find((l) => l.id === newNpcId);
            if (fresh) {
              await store.setChatMessageSwipes(chatId, newNpcId, fresh.text, legacySwipes);
              // 广播最新历史（让各端显示版本指示 ◀ n/N ▶）
              broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history: await store.allChatMessages(chatId) });
            }
          }
        } catch (err) {
          send(ws, { type: 'error', message: String(err) });
        } finally {
          chatBusy.delete(chatId);
          session.busy = false;
        }
        return;
      }
      if (msg.type === 'chat_swipe') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        // 楼层切换：direction = 'prev'（切回最近一个旧版本）
        // swipes 存「旧楼层，旧→新」，队尾 = 最近旧版；prev 把它与当前 text 互换：
        //   text ← 队尾；原 text 追加到队尾（下次 prev 又能切回，往返成立）。
        // 想看「更新版本/新楼层」→ 前端在无更旧可切时发 chat_regenerate 生成新楼层。
        const messageId = String(msg.messageId ?? '');
        if (!chatId || !messageId || msg.direction !== 'prev') return;
        const lines = await store.allChatMessages(chatId);
        const target = lines.find((l) => l.id === messageId);
        if (!target) {
          send(ws, { type: 'error', message: '消息不存在或缺少稳定 id' });
          return;
        }
        const swipes = target.swipes ?? [];
        if (swipes.length === 0) {
          send(ws, { type: 'error', message: '没有更早的楼层可切换（可点↻生成新回复）' });
          return;
        }
        const older = swipes.slice(0, -1);
        const lastOld = swipes[swipes.length - 1]!;
        await store.setChatMessageSwipes(chatId, messageId, lastOld, [...older, target.text]);
        broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history: await store.allChatMessages(chatId) });
        return;
      }
      if (msg.type === 'persona_get') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        const chat = chatId && session.chatId === chatId ? await store.getChat(chatId) : null;
        send(ws, { type: 'persona', chatId: chatId || null, persona: chat?.persona ?? null });
        return;
      }
      if (msg.type === 'persona_set') {
        // 设置玩家档案（你是谁）：{ name?, description?, avatar? }
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        const name = String(msg.name ?? '').trim();
        if (!name) {
          send(ws, { type: 'error', message: 'persona 需要至少一个名字' });
          return;
        }
        const persona: Persona = { name };
        const description = String(msg.description ?? '').trim();
        if (description) persona.description = description;
        const avatar = String(msg.avatar ?? '').trim();
        if (avatar) persona.avatar = avatar;
        await store.updateChat(chatId, { persona });
        // 会话只有开场白时用新 persona 重展开 {{user}}
        const chat = await store.getChat(chatId);
        if (chat) await refreshGreetingForPersona(chatId, chat.worldId, name);
        const history = await store.allChatMessages(chatId);
        broadcastToChat(chatId, { type: 'chat_history_changed', chatId, history });
        send(ws, { type: 'persona', chatId, persona });
        return;
      }
      if (msg.type === 'settings_get') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        const chat = chatId && session.chatId === chatId ? await store.getChat(chatId) : null;
        send(ws, { type: 'settings', chatId: chatId || null, settings: chat?.settings ?? null });
        return;
      }
      if (msg.type === 'settings_set') {
        // 会话设置（M9-2 记忆分层 + M16 提示词模板）
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        const chatNow = await store.getChat(chatId);
        if (!chatNow) return;
        const settings: { layerCompressEvery?: number; layerBuffer?: number; promptTemplates?: { routerSystem?: string; actorFrame?: string } } = { ...(chatNow.settings ?? {}) };
        const num = (v: unknown, dft: number): number => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : dft;
        };
        if (msg.layerCompressEvery !== undefined || msg.layerBuffer !== undefined) {
          const compress = num(msg.layerCompressEvery, 20);
          const buffer = num(msg.layerBuffer, 10);
          settings.layerCompressEvery = compress;
          settings.layerBuffer = compress === 0 ? 0 : buffer;
        }
        // M16：提示词模板（undefined=不动；''=恢复默认；字符串=保存）
        const pt: { routerSystem?: string; actorFrame?: string } = settings.promptTemplates ?? {};
        if (msg.routerSystem !== undefined) pt.routerSystem = String(msg.routerSystem) || undefined;
        if (msg.actorFrame !== undefined) pt.actorFrame = String(msg.actorFrame) || undefined;
        if (pt.routerSystem || pt.actorFrame) settings.promptTemplates = pt;
        else delete settings.promptTemplates;
        await store.updateChat(chatId, { settings });
        const chat = await store.getChat(chatId);
        send(ws, { type: 'settings', chatId, settings: chat?.settings ?? null });
        return;
      }
      if (msg.type === 'chat_rename') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        const title = String(msg.title ?? '').trim();
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        if (!title) return;
        await store.updateChat(chatId, { title });
        send(ws, { type: 'chat_renamed', chatId, title });
        return;
      }
      if (msg.type === 'chat_delete') {
        const chatId = String(msg.chatId ?? '');
        if (!chatId) return;
        await store.deleteChat(chatId);
        if (session.chatId === chatId) session.chatId = null;
        send(ws, { type: 'chat_deleted', chatId });
        return;
      }
      if (msg.type === 'chat_export') {
        const chatId = String(msg.chatId ?? session.chatId ?? '');
        if (!chatId || !session.chatId || chatId !== session.chatId) {
          send(ws, { type: 'error', message: '没有当前会话，请先选择/新建一个会话' });
          return;
        }
        const meta = await store.getChat(chatId);
        const lines = await store.allChatMessages(chatId);
        const jsonl = lines.map((l) => JSON.stringify(l)).join('\n');
        send(ws, { type: 'chat_exported', chatId, title: meta?.title ?? chatId, jsonl });
        return;
      }

      // ---- 世界管理协议 ----
      if (msg.type === 'world_list') {
        send(ws, { type: 'world_list', worlds: await listPlayableWorlds(), current: session.worldId });
        return;
      }
      if (msg.type === 'world_select') {
        let wid = String(msg.worldId ?? '');
        const worlds = await store.listWorlds();
        if (wid === 'auto') {
          // 默认世界 = 校园卡（M18）；没有校园卡则示例
          const campus = worlds.includes('world_校园') ? 'world_校园' : null;
          wid = campus ?? 'demo_world';
        }
        if (wid !== 'demo_world' && !worlds.includes(wid)) wid = defaultWorldId; // 非法 id 回退默认世界
        if (worlds.includes(wid) || wid === 'demo_world') {
          const chatId = await switchWorld(session, wid);
          const chat = chatId ? await store.getChat(chatId) : null;
          const history = chatId ? await store.allChatMessages(chatId) : [];
          const wsStateNow = await store.getWorldState(wid);
          // 未发消息也要能看路由上下文：按当前世界指针预演一版「路由将看到的提示词」
          // （玩家消息为空占位，标记 preview；发回合后被真实数据覆盖）
          let debugPreview: { system: string; messages: Array<{ role: string; content: string }>; tools: string; flow?: unknown[] } | null = null;
          try {
            const index = await loadWorldIndexFromStore(store, wid, { chatId: chatId ?? undefined });
            const state = chat?.state ?? wsStateNow;
            if (state && index.allCards.length > 0) {
              const currentScene = index.allCards.find((c) => c.id === state.currentSceneId) as
                | (Card & { data: SceneCardData })
                | undefined;
              if (currentScene) {
                const routerInput = {
                  worldId: wid,
                  state,
                  userMessage: '（等待你输入…）',
                  currentScene,
                  characters: index.characters,
                  memories: index.memories,
                  items: index.items,
                  recentLines: chat ? (await store.allChatMessages(chatId ?? '')).slice(-4) : [],
                  // 在场角色全卡（与真实回合同款：导演每回合读全卡）
                  presentCards: index.allCards.filter(
                    (c) => c.kind === 'character'
                      && state.presentCharacterIds.includes(c.id)
                      && !((c.data as { isPlayer?: boolean }).isPlayer === true),
                  ),
                  userName: chat?.persona?.name?.trim() || undefined,
                  // M15：常驻全量段与真实回合同款
                  constants: index.constants
                    .filter((c) => c.kind !== 'system' && !((c.data as { isPlayer?: boolean }).isPlayer === true))
                    .map((c) => {
                      const d = c.data as { name?: string; summary?: string; detail?: string; description?: string; mclass?: string };
                      return {
                        id: c.id,
                        kind: c.kind,
                        name: d.name ?? d.summary ?? c.id,
                        mclass: d.mclass,
                        text: (d.detail ?? d.description ?? '').trim(),
                      };
                    }),
                };
                const ctx = buildRouterContext(routerInput);
                debugPreview = {
                  ...ctxToStructured(ctx),
                  flow: routerDebugFlow(routerInput),
                };
              }
            }
          } catch {
            debugPreview = null; // 世界不完整时预览可为空（回合中照常）
          }
          send(ws, {
            type: 'world_selected',
            worldId: wid,
            chatId,
            chat,
            history,
            chats: await store.listChats(wid),
            // 世界状态初始快照（前端侧栏世界状态面板首屏填充；回合推进后由 world 事件权威更新）
            state: wsStateNow
              ? {
                  turn: wsStateNow.turn,
                  sceneId: wsStateNow.currentSceneId,
                  presentCharacterIds: wsStateNow.presentCharacterIds,
                }
              : null,
            debugPreview,
          });
        } else {
          send(ws, { type: 'error', message: `未知世界: ${wid}` });
        }
        return;
      }
      if (msg.type === 'world_import') {
        // 接收导入内容：{ name?, json? | pngBase64?, fileName? }
        try {
          const raw = msg.payload;
          let result;
          if (typeof raw === 'string') {
            // 可能是 JSON 文本或 PNG base64
            const trimmed = raw.trim();
            if (trimmed.startsWith('{')) {
              result = await importCards(trimmed);
            } else {
              const buf = Buffer.from(trimmed, 'base64');
              result = await importCards(buf);
            }
          } else {
            result = await importCards(raw as Record<string, unknown>);
          }
          const worldName = String(msg.worldName ?? result.summary.world ?? '导入世界');
          const archived = await importWorldToArchive(store, result.cards, worldName, {
            // M12：空壳群像包 → 世界级开场白
            worldGreeting: (result as { worldGreeting?: { speaker: string; text: string } }).worldGreeting,
          });

          // 导入的世界若没有场景卡：自动补一张默认场景（让角色有地方出场）
          if (archived.counts.scene === 0 && archived.counts.character > 0) {
            const charCards = await store.getCards(await store.listWorldCards(archived.worldId));
            const charIds = charCards.filter((c) => c?.kind === 'character').map((c) => c!.id);
            const defaultScene: Card = {
              id: `scene_${archived.worldId.replace('world_', '')}_default`,
              kind: 'scene',
              data: {
                name: `${worldName} · 初始场景`,
                description: '一个普通的相遇之地。你就在这里开始了与他们的故事。',
                presentCharacterIds: charIds,
                itemIds: [],
                recentChanges: [],
              },
            };
            await store.putCard(defaultScene);
            await store.addCardToWorld(archived.worldId, defaultScene.id);
            // 世界状态指向默认场景
            const wsState = await store.getWorldState(archived.worldId);
            if (wsState) {
              wsState.currentSceneId = defaultScene.id;
              wsState.presentCharacterIds = charIds;
              await store.putWorldState(archived.worldId, wsState);
            }
            archived.counts.scene = 1;
          }

          // 自动切到新世界并建首个会话
          const chatId = await switchWorld(session, archived.worldId);
          const chat = chatId ? await store.getChat(chatId) : null;
          send(ws, {
            type: 'world_imported',
            worldId: archived.worldId,
            summary: { ...result.summary, world: worldName, counts: archived.counts },
            mainCharacterId: archived.mainCharacterId,
            chatId,
            chat,
          });
        } catch (err) {
          send(ws, { type: 'error', message: `导入失败: ${String(err)}` });
        }
        return;
      }
      if (msg.type === 'world_export_characters') {
        // 导出当前世界全部角色卡为 SillyTavern V2 JSON（round-trip）
        const worldId = String(msg.worldId ?? session.worldId ?? '');
        const ids = await store.listWorldCards(worldId);
        const cards = (await store.getCards(ids)).filter((c): c is Card => c !== null && c.kind === 'character');
        const exported = cards.map((c) => toTavernV2(c));
        send(ws, { type: 'world_characters_exported', worldId, cards: exported });
        return;
      }
      if (msg.type === 'world_cards') {
        // 角色画廊数据：世界全部卡（角色卡带头像/开场白/描述，附 token 估算）
        const worldId = String(msg.worldId ?? session.worldId ?? '');
        send(ws, { type: 'world_cards', worldId, cards: await summarizeWorldCards(worldId) });
        return;
      }
      if (msg.type === 'card_update') {
        // 卡编辑：白名单字段，按 kind 校验。{ cardId, kind, patch }
        const cardId = String(msg.cardId ?? '');
        const patch = (msg.patch ?? {}) as Record<string, unknown>;
        if (!cardId || typeof patch !== 'object') return;
        const card = await store.getCard(cardId);
        if (!card) {
          send(ws, { type: 'error', message: `卡片 ${cardId} 不存在` });
          return;
        }
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
        const d = card.data as unknown as Record<string, unknown>;
        // M11：任意卡拨动「常驻」开关（顶层 constant；kind 专属编辑之外的通用品）
        const patchConst = patch.constant === true || patch.constant === false ? patch.constant : undefined;
        if (patchConst !== undefined) {
          card.constant = patchConst;
          await store.putCard(card);
          send(ws, { type: 'card_updated', cardId, kind: card.kind });
          const widc = session.worldId;
          send(ws, { type: 'world_cards', worldId: widc, cards: await summarizeWorldCards(widc) });
          return;
        }
        if (card.kind === 'character') {
          const allowed = ['description', 'personality', 'scenario', 'speechStyle', 'openingLine', 'role'] as const;
          let changed = false;
          for (const k of allowed) {
            if (patch[k] !== undefined) {
              const v = str(patch[k]);
              if (v !== undefined) {
                if (k === 'description') d.description = v;
                else if (k === 'personality') d.personality = v;
                else if (k === 'scenario') d.scenario = v;
                else if (k === 'speechStyle') d.speechStyle = v;
                else if (k === 'openingLine') d.openingLine = v;
                else if (k === 'role') d.role = v;
                changed = true;
              }
            }
          }
          // M8 动态人设：关系网 / 成长档案（数组整体替换）
          if (Array.isArray(patch.relationships)) {
            const arr = (patch.relationships as Array<Record<string, unknown>>)
              .map((r) => ({
                targetName: String(r.targetName ?? '').trim(),
                relation: String(r.relation ?? '').trim(),
                note: r.note !== undefined ? String(r.note).trim() : undefined,
              }))
              .filter((r) => r.targetName);
            d.relationships = arr.length > 0 ? arr : undefined;
            changed = true;
          }
          if (Array.isArray(patch.progression)) {
            const arr = (patch.progression as unknown[]).map((x) => String(x).trim()).filter(Boolean);
            d.progression = arr.length > 0 ? arr : undefined;
            changed = true;
          }
          // skill 式注入级别：'summary' 摘要卡 / 'full' 全卡（枚举校验）
          if (patch.contextMode === 'summary' || patch.contextMode === 'full') {
            d.contextMode = patch.contextMode;
            changed = true;
          }
          if (!changed) return;
        } else if (card.kind === 'scene') {
          const name = str(patch.name);
          const description = str(patch.description);
          if (name !== undefined) d.name = name;
          if (description !== undefined) d.description = description;
          if (name === undefined && description === undefined) return;
        } else if (card.kind === 'item') {
          // M10 物品：名称/描述/位置/所有者可编辑（owner 'player' = 玩家所有；角色 id = 其所有物）
          const name = str(patch.name);
          const description = str(patch.description);
          const location = patch.location === 'character' || patch.location === 'scene' || patch.location === 'player' ? patch.location : undefined;
          const locationId = typeof patch.locationId === 'string' ? patch.locationId.trim() || undefined : undefined;
          let owner = patch.ownerCharacterId === null ? null : typeof patch.ownerCharacterId === 'string' ? patch.ownerCharacterId.trim() || null : undefined;
          const ownerChanged = owner !== undefined;
          if (ownerChanged) { d.ownerCharacterId = owner ?? undefined; }
          if (name !== undefined) d.name = name;
          if (description !== undefined) d.description = description;
          if (location !== undefined) d.location = location;
          if (locationId !== undefined) d.locationId = locationId;
          if (name === undefined && description === undefined && location === undefined && locationId === undefined && !ownerChanged) return;
        } else if (card.kind === 'memory') {
          // M11/M13：记忆卡可编辑（标题/正文/关键词）；常驻卡同走顶层 constant 通道
          const summary = str(patch.summary);
          const detail = str(patch.detail);
          const mclass = patch.mclass === 'worldview' || patch.mclass === 'plot' || patch.mclass === 'rule' || patch.mclass === 'event' ? patch.mclass : undefined;
          if (summary !== undefined) d.summary = summary;
          if (detail !== undefined) d.detail = detail;
          if (mclass !== undefined) d.mclass = mclass;
          if (summary === undefined && detail === undefined && mclass === undefined) return;
        } else if (card.kind === 'system') {
          // M8 世界法则：大事记时间线整体替换
          if (Array.isArray(patch.timeline)) {
            const arr = (patch.timeline as unknown[]).map((x) => String(x).trim()).filter(Boolean);
            d.timeline = arr.length > 0 ? arr : undefined;
            await store.putCard(card);
            send(ws, { type: 'card_updated', cardId, kind: card.kind });
            const wid2 = session.worldId;
            send(ws, { type: 'world_cards', worldId: wid2, cards: await summarizeWorldCards(wid2) });
          }
          return;
        } else {
          send(ws, { type: 'error', message: `卡型 ${card.kind} 暂不支持编辑` });
          return;
        }
        await store.putCard(card);
        // 会话情感 overlay 基于卡初值：卡描述改动不触碰 npcStates（情感独立）
        send(ws, { type: 'card_updated', cardId, kind: card.kind });
        // 通知画廊刷新（广播当前世界）
        const wid = session.worldId;
        send(ws, { type: 'world_cards', worldId: wid, cards: await summarizeWorldCards(wid) });
        return;
      }
      if (msg.type === 'card_delete') {
        // 删除卡片 + 引用清理：
        //   - 世界 state：presentCharacterIds 剔除；currentSceneId 若指向被删场景 → 回退首场景
        //   - 场景卡：presentCharacterIds/itemIds 剔除被删卡
        //   - 记忆卡：ownerCharacterId 指向被删角色 → 置空
        //   - 所有会话 state：同上清理（会话持有自己的 worldState 快照）
        const worldId = String(msg.worldId ?? session.worldId ?? '');
        const cardId = String(msg.cardId ?? '');
        if (!cardId) return;
        const card = await store.getCard(cardId);
        if (!card) {
          send(ws, { type: 'error', message: `卡片 ${cardId} 不存在` });
          return;
        }
        await store.deleteCard(worldId, cardId);

        // ---- 引用清理 ----
        const cleanState = (st: {
          presentCharacterIds?: string[];
          playerInventory?: string[];
          currentSceneId?: string;
        }) => {
          let changed = false;
          if (st.presentCharacterIds?.includes(cardId)) {
            st.presentCharacterIds = st.presentCharacterIds.filter((c) => c !== cardId);
            changed = true;
          }
          if (st.playerInventory?.includes(cardId)) {
            st.playerInventory = st.playerInventory.filter((i) => i !== cardId);
            changed = true;
          }
          if (card.kind === 'scene' && st.currentSceneId === cardId) {
            changed = true;
          }
          return changed;
        };
        // 世界状态 / 各会话 state：引用剔除；当前场景被删 → 回退剩余首场景
        const fallbackScene = async (): Promise<string> => {
          if (card.kind !== 'scene') return '';
          const ids = await store.listWorldCards(worldId);
          const cards = (await store.getCards(ids)).filter((c): c is Card => c !== null && c.kind === 'scene');
          return cards.length > 0 ? cards[0]!.id : '';
        };
        const fb = await fallbackScene();
        const wsState = await store.getWorldState(worldId);
        if (wsState) {
          const changed = cleanState(wsState);
          if (changed) {
            if (wsState.currentSceneId === cardId) wsState.currentSceneId = fb;
            await store.putWorldState(worldId, wsState);
          }
        }
        // 各会话 state（会话持有独立 worldState 快照）
        const chats = await store.listChats(worldId);
        for (const ch of chats) {
          const st = ch.state;
          const changed = cleanState(st);
          if (changed) {
            if (st.currentSceneId === cardId) st.currentSceneId = fb;
            await store.updateChat(ch.chatId, { state: st });
          }
        }
        // 场景卡引用剔除
        for (const c of (await store.getCards(await store.listWorldCards(worldId))).filter((c): c is Card => c !== null)) {
          if (c.kind === 'scene') {
            const sd = c.data as { presentCharacterIds: string[]; itemIds: string[] };
            let cChanged = false;
            if (sd.presentCharacterIds?.includes(cardId)) {
              sd.presentCharacterIds = sd.presentCharacterIds.filter((x) => x !== cardId);
              cChanged = true;
            }
            if (sd.itemIds?.includes(cardId)) {
              sd.itemIds = sd.itemIds.filter((x) => x !== cardId);
              cChanged = true;
            }
            if (cChanged) await store.putCard(c);
          } else if (c.kind === 'memory') {
            const md = c.data as { ownerCharacterId?: string };
            if (md.ownerCharacterId === cardId) {
              md.ownerCharacterId = '';
              await store.putCard(c);
            }
          }
        }
        send(ws, { type: 'card_deleted', cardId, worldId });
        send(ws, { type: 'world_cards', worldId, cards: await summarizeWorldCards(worldId) });
        return;
      }

      // ---- 模型接入协议 ----
      if (msg.type === 'provider_list') {
        send(ws, { type: 'provider_list', providers: listProviderCatalog() });
        return;
      }
      if (msg.type === 'provider_models') {
        const providerId = String(msg.provider ?? '');
        try {
          const models_ = await listUpstreamModels(providerId);
          send(ws, { type: 'provider_models', provider: providerId, models: models_ });
        } catch (err) {
          send(ws, { type: 'error', message: `拉取 ${providerId} 模型失败: ${String(err)}` });
        }
        return;
      }
      if (msg.type === 'provider_test') {
        const providerId = String(msg.provider ?? '');
        const apiKey = String(msg.apiKey ?? '');
        if (!providerId || !apiKey) {
          send(ws, { type: 'error', message: 'provider_test 需要 provider 和 apiKey' });
          return;
        }
        const t = await testProviderConnection(providerId, apiKey);
        send(ws, { type: 'provider_test_result', provider: providerId, ok: t.ok, message: t.message });
        return;
      }
      if (msg.type === 'provider_set') {
        // 设置某阶段的 provider/model/key/reasoning（运行时生效，不写 .env）
        const stage = String(msg.stage ?? '');
        const providerId = String(msg.provider ?? '');
        const modelId = String(msg.model ?? '');
        const apiKey = String(msg.apiKey ?? '');
        const reasoningRaw = msg.reasoning;
        const reasoning = reasoningRaw === 'off' || reasoningRaw === 'minimal' || reasoningRaw === 'low' || reasoningRaw === 'medium' || reasoningRaw === 'high' || reasoningRaw === 'xhigh' || reasoningRaw === 'max'
          ? reasoningRaw
          : undefined;
        if (!['router', 'actor', 'evaluator'].includes(stage) || !providerId || !modelId) {
          send(ws, { type: 'error', message: 'provider_set 需要 stage(router|actor|evaluator) + provider + model' });
          return;
        }
        if (apiKey) setRuntimeKey(providerId, apiKey);
        // 写入阶段运行时配置（getStageModel 优先读它）
        const st = stage as 'router' | 'actor' | 'evaluator';
        setStageRuntimeConfig(st, providerId, modelId, reasoning);
        // 热切换：异步刷新目录并解析真实模型；找不到则报错（保持旧配置不动）
        const resolved = await resolveStageModelAsync(st);
        if (!resolved) {
          // 回滚：清除刚写的运行时配置，避免半配置状态
          send(ws, { type: 'error', message: `找不到模型 ${providerId}/${modelId}（目录刷新后仍无），配置未生效` });
          return;
        }
        stageModels[st] = resolved;
        // 集合是全局单例（真实+faux 混搭），无需切换 models 变量
        send(ws, { type: 'provider_set_ok', stage, provider: providerId, model: modelId });
        return;
      }
    });

    ws.on('close', () => {
      clients.delete(session);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[web] PiTavern 已启动: http://localhost:${PORT}  (WebSocket: ws://localhost:${PORT}/ws)`);
  });

  // 退出前 flush 文件存储（FileCardStore 落盘 / Redis 断连）
  const shutdown = async () => {
    console.log('[web] 正在关闭，flush 存储…');
    try {
      await store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[web] 启动失败:', err);
  process.exit(1);
});
