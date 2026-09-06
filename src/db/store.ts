/**
 * 卡片仓库：Redis 键空间设计与内存回退。
 *
 * 键空间（全部带前缀，避免与其他业务冲突）：
 *   card:{id}               → JSON 卡片本体
 *   world:{id}:state        → 当前场景 / 在场角色 / 回合号等世界指针
 *   world:{id}:history      → 滑动历史（LIST，右进左裁，天然保插入序）
 *   chat:{id}:messages      → 会话消息（LIST，同上）
 *   chat:{id}:meta          → 会话元信息
 *   world:{id}:cards        → 世界卡片目录（SET）
 *   world:{id}:chats        → 世界下会话索引（SET）
 *
 * 存储层为接口 `CardStore`：ioredis 实现 + 内存实现，Demo 无 Redis 也能跑。
 */
import { Redis } from 'ioredis';
import type { Card, CharacterCardData, HistoryLine, Persona, SceneCardData } from '../types.js';
import { isCharacterCard, isSceneCard, makeUniqueId } from '../cards/util.js';

export const CARD_PREFIX = 'card:';
export const WORLD_STATE_KEY = (worldId: string) => `world:${worldId}:state`;
/**
 * 世界级历史键（LIST，右进左裁）。
 * 曾用 ZSET(score=turn, member=整条 JSON)：同一回合会写两条同分记录
 * （玩家输入 + NPC 回话），Redis 对同分成员按字典序排列，会把同一回合
 * 的两条消息顺序颠倒。LIST 天然保插入序，同回合先后关系不再失真。
 */
export const WORLD_HISTORY_KEY = (worldId: string) => `world:${worldId}:history`;
/** 会话级消息键（LIST，右进左裁；语义同上） */
export const CHAT_MESSAGES_KEY = (chatId: string) => `chat:${chatId}:messages`;

export interface WorldState {
  currentSceneId: string;
  /** M12：世界（角色卡）级开场白——群像包的空壳 first_mes 归此；
   *  新建会话时优先于此（fallback 扫角色 openingLine） */
  greeting?: { speaker: string; text: string };
  /** 在场角色（有序，第一个通常为主讲） */
  presentCharacterIds: string[];
  /** 玩家背包里的物品 id */
  playerInventory: string[];
  turn: number;
  updatedAt: number;
  /**
   * 会话级 NPC 情感 overlay（好感度/内心想法按角色卡 id）。
   * 由会话推进产生，随 chat.state 存档 → 天然按会话隔离：
   * 多个会话共享静态角色卡，但各自的情感进展互不串扰。
   * 世界级状态（无 chat 时）不写这里（直接写卡）。
   */
  npcStates?: Record<string, { affection: number; innerThought: string }>;
}

/** 会话元信息（一次"跑团"的档案） */
export interface ChatMeta {
  chatId: string;
  /** 所属世界 */
  worldId: string;
  /** 会话标题（默认角色名/世界名） */
  title: string;
  /** 世界状态快照（会话推进时维护，各会话独立） */
  state: WorldState;
  /** 累计 token 用量（进程内累计；重启清零） */
  usage?: { input: number; output: number; calls: number };
  /** 玩家档案（你是谁；greeting 宏替换与 UI 展示用） */
  persona?: Persona;
  /** 会话设置（M9-2 记忆分层：compressEvery 压缩宽度 / buffer 缓冲层；0 关闭） */
  settings?: {
    /** 压缩宽度：每多少层把最旧的一个完整段压成摘要（默认 20） */
    layerCompressEvery?: number;
    /** 缓冲层：最近多少层保持全文不压缩（默认 10） */
    layerBuffer?: number;
    /** 兼容旧字段 summaryEveryTurns（M8 单参数语义 = buffer 0） */
    summaryEveryTurns?: number;
    /** 旧调试开关（M9-2 起恒开完整上下文，此字段废弃保留兼容） */
    noTruncate?: boolean;
    /** M16 提示词模板（routerSystem 路由 System / actorFrame 演员演绎框架） */
    promptTemplates?: { routerSystem?: string; actorFrame?: string };
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * M11 常驻开关归一化：兼容旧数据（data.constant）→ 提升为 Card 顶层 constant。
 * 读时调用：保证上层只见顶层 constant。
 */
export function normalizeCardConstant(card: Card | null): Card | null {
  if (!card) return null;
  if (!card.constant) {
    const d = card.data as { constant?: boolean } | null;
    if (d && typeof d === 'object' && d.constant === true) card.constant = true;
  }
  return card;
}

export interface CardStore {
  getCard(id: string): Promise<Card | null>;
  /** 批量取卡（mget 语义，顺序保持） */
  getCards(ids: string[]): Promise<(Card | null)[]>;
  putCard(card: Card): Promise<void>;
  /** 列出某世界下的全部卡 id（导入的世界包会登记） */
  listWorldCards(worldId: string): Promise<string[]>;
  /** 把卡登记到某世界目录 */
  addCardToWorld(worldId: string, cardId: string): Promise<void>;
  /** 删除卡并从世界目录移除（引用清理由调用方负责） */
  deleteCard(worldId: string, cardId: string): Promise<void>;
  /** 列出所有已导入的世界 */
  listWorlds(): Promise<string[]>;
  getWorldState(worldId: string): Promise<WorldState | null>;
  putWorldState(worldId: string, state: WorldState): Promise<void>;
  /** 追加一条历史（自动裁剪到 maxLines） */
  pushHistory(worldId: string, line: HistoryLine, maxLines: number): Promise<void>;
  /** 取最近 n 条历史（新→旧） */
  recentHistory(worldId: string, n: number): Promise<HistoryLine[]>;

  /* ---- 会话（chat）级历史管理 ---- */
  /** 新建会话（world 下创建，带标题和初始状态） */
  createChat(worldId: string, title: string, state: WorldState): Promise<ChatMeta>;
  /** 取会话元信息 */
  getChat(chatId: string): Promise<ChatMeta | null>;
  /** 某世界的全部会话（按更新时间倒序） */
  listChats(worldId: string): Promise<ChatMeta[]>;
  /** 追加会话消息（裁剪到 maxLines） */
  pushChatMessage(chatId: string, line: HistoryLine, maxLines: number): Promise<void>;
  /** 编辑某条会话消息文本（按 id；找不到返回 false） */
  editChatMessage(chatId: string, messageId: string, text: string): Promise<boolean>;
  /** 替换某条消息的当前文本 + 楼层历史（swipe 切换 / regenerate 迁移用） */
  setChatMessageSwipes(chatId: string, messageId: string, text: string, swipes: string[]): Promise<boolean>;
  /** 标/取消「出戏」（excluded：不进模型上下文但保留历史） */
  setChatMessageExcluded(chatId: string, messageId: string, excluded: boolean): Promise<boolean>;
  /** 删除消息：按 id 列表（用于单条删除 / regenerate 裁剪尾巴） */
  deleteChatMessages(chatId: string, messageIds: string[]): Promise<void>;
  /** 取会话最近 n 条消息（旧→新） */
  recentChatMessages(chatId: string, n: number): Promise<HistoryLine[]>;
  /** 取会话全部消息（导出/恢复用） */
  allChatMessages(chatId: string): Promise<HistoryLine[]>;
  /** 更新会话元信息（标题/状态/用量） */
  updateChat(chatId: string, meta: Partial<Pick<ChatMeta, 'title' | 'state' | 'usage' | 'persona' | 'settings'>>): Promise<void>;
  /** 删除会话 */
  deleteChat(chatId: string): Promise<void>;
  close(): Promise<void>;
}

/** 世界目录键（世界 → 它包含的所有卡 id） */
export const WORLD_CARDS_KEY = (worldId: string) => `world:${worldId}:cards`;
/** 会话元信息键 */
export const CHAT_META_KEY = (chatId: string) => `chat:${chatId}:meta`;
/** 世界→会话索引（SET） */
export const WORLD_CHATS_KEY = (worldId: string) => `world:${worldId}:chats`;

/** 用时间戳保证每次生成不同 id（同一秒内多次调用也安全） */
export function makeId(kind: string): string {
  return makeUniqueId(kind);
}

function lineToString(line: HistoryLine): string {
  return JSON.stringify(line);
}

/** 消息若没有稳定 id 则补发（push 时调用；旧数据读出不补，保持向后兼容） */
function ensureLineId(line: HistoryLine): void {
  if (!line.id) line.id = makeUniqueId('msg');
}

function stringToLine(s: string): HistoryLine | null {
  try {
    const v = JSON.parse(s) as HistoryLine;
    if (typeof v.turn === 'number' && typeof v.text === 'string') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * 追加一条到 LIST 末尾并裁剪到最近 maxLines 条（一条 pipeline 命令完成，
 * 避免 RPUSH 与 LTRIM 分开导致中间态越界）。
 */
async function rpushTrim(client: Redis, key: string, value: string, maxLines: number): Promise<void> {
  const pipe = client.multi();
  pipe.rpush(key, value);
  pipe.ltrim(key, -maxLines, -1);
  await pipe.exec();
}

/** 从 LIST 末尾读最近 n 条（返回旧→新顺序） */
async function recentList(client: Redis, key: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  // LRANGE [-n, -1] 一次取回旧→新，无需 reverse
  const raws = await client.lrange(key, -n, -1);
  return raws;
}

/** 整体重写一条会话消息 LIST（del + rpush 原子性可接受；历史 ≤ 200 条） */
async function rewriteChatList(client: Redis, key: string, lines: string[]): Promise<void> {
  const pipe = client.multi();
  pipe.del(key);
  if (lines.length > 0) pipe.rpush(key, ...lines);
  await pipe.exec();
}

/* ------------------------------ Redis 实现 ------------------------------ */

export class RedisCardStore implements CardStore {
  private client: Redis;
  private ttlSeconds: number;

  constructor(url: string, ttlSeconds = 7 * 24 * 3600) {
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.ttlSeconds = ttlSeconds;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async getCard(id: string): Promise<Card | null> {
    const raw = await this.client.get(`${CARD_PREFIX}${id}`);
    return normalizeCardConstant(raw ? (JSON.parse(raw) as Card) : null);
  }

  async getCards(ids: string[]): Promise<(Card | null)[]> {
    if (ids.length === 0) return [];
    const raws = await this.client.mget(ids.map((id) => `${CARD_PREFIX}${id}`));
    return raws.map((r) => normalizeCardConstant(r ? (JSON.parse(r) as Card) : null));
  }

  async putCard(card: Card): Promise<void> {
    card.updatedAt = Date.now();
    await this.client.set(`${CARD_PREFIX}${card.id}`, JSON.stringify(card), 'EX', this.ttlSeconds);
  }

  async listWorldCards(worldId: string): Promise<string[]> {
    return this.client.smembers(WORLD_CARDS_KEY(worldId));
  }

  async addCardToWorld(worldId: string, cardId: string): Promise<void> {
    await this.client.sadd(WORLD_CARDS_KEY(worldId), cardId);
  }

  async deleteCard(worldId: string, cardId: string): Promise<void> {
    // 卡本体与目录索引分开删（del 卡 key 用 client.del，目录 srem）
    await this.client.srem(WORLD_CARDS_KEY(worldId), cardId);
    await this.client.del(`${CARD_PREFIX}${cardId}`);
  }

  async listWorlds(): Promise<string[]> {
    const keys = await this.client.keys('world:*:cards');
    return keys.map((k) => k.replace(/^world:|:cards$/g, ''));
  }

  async getWorldState(worldId: string): Promise<WorldState | null> {
    const raw = await this.client.get(WORLD_STATE_KEY(worldId));
    return raw ? (JSON.parse(raw) as WorldState) : null;
  }

  async putWorldState(worldId: string, state: WorldState): Promise<void> {
    await this.client.set(WORLD_STATE_KEY(worldId), JSON.stringify(state), 'EX', this.ttlSeconds);
  }

  async pushHistory(worldId: string, line: HistoryLine, maxLines: number): Promise<void> {
    ensureLineId(line);
    await rpushTrim(this.client, WORLD_HISTORY_KEY(worldId), lineToString(line), maxLines);
  }

  async recentHistory(worldId: string, n: number): Promise<HistoryLine[]> {
    const raws = await recentList(this.client, WORLD_HISTORY_KEY(worldId), n);
    return raws
      .map(stringToLine)
      .filter((l): l is HistoryLine => l !== null);
  }

  /* ---- 会话级 ---- */

  async createChat(worldId: string, title: string, state: WorldState): Promise<ChatMeta> {
    const chatId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const meta: ChatMeta = {
      chatId,
      worldId,
      title,
      state: structuredClone(state),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const pipe = this.client.multi();
    pipe.set(CHAT_META_KEY(chatId), JSON.stringify(meta), 'EX', this.ttlSeconds);
    pipe.sadd(WORLD_CHATS_KEY(worldId), chatId);
    await pipe.exec();
    return meta;
  }

  async getChat(chatId: string): Promise<ChatMeta | null> {
    const raw = await this.client.get(CHAT_META_KEY(chatId));
    return raw ? (JSON.parse(raw) as ChatMeta) : null;
  }

  async listChats(worldId: string): Promise<ChatMeta[]> {
    const ids = await this.client.smembers(WORLD_CHATS_KEY(worldId));
    if (ids.length === 0) return [];
    const raws = await this.client.mget(ids.map(CHAT_META_KEY));
    return raws
      .filter((r): r is string => r !== null)
      .map((r) => JSON.parse(r) as ChatMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async pushChatMessage(chatId: string, line: HistoryLine, maxLines: number): Promise<void> {
    ensureLineId(line);
    await rpushTrim(this.client, CHAT_MESSAGES_KEY(chatId), lineToString(line), maxLines);
    // 触摸 updatedAt（列表排序用）
    const meta = await this.getChat(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      await this.client.set(CHAT_META_KEY(chatId), JSON.stringify(meta), 'EX', this.ttlSeconds);
    }
  }

  async editChatMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const key = CHAT_MESSAGES_KEY(chatId);
    const raws = await this.client.lrange(key, 0, -1);
    let hit = false;
    const next = raws.map((raw) => {
      const l = stringToLine(raw);
      if (l?.id === messageId) {
        hit = true;
        return lineToString({ ...l, text });
      }
      return raw;
    });
    if (!hit) return false;
    await rewriteChatList(this.client, key, next);
    return true;
  }

  async setChatMessageSwipes(chatId: string, messageId: string, text: string, swipes: string[]): Promise<boolean> {
    const key = CHAT_MESSAGES_KEY(chatId);
    const raws = await this.client.lrange(key, 0, -1);
    let hit = false;
    const next = raws.map((raw) => {
      const l = stringToLine(raw);
      if (l?.id === messageId) {
        hit = true;
        // 只保留非空且与当前文本不同的版本
        const uniq = [...new Set(swipes.filter((s) => s.trim() && s !== text))];
        return lineToString({ ...l, text, swipes: uniq.length > 0 ? uniq : undefined });
      }
      return raw;
    });
    if (!hit) return false;
    await rewriteChatList(this.client, key, next);
    return true;
  }

  async setChatMessageExcluded(chatId: string, messageId: string, excluded: boolean): Promise<boolean> {
    const key = CHAT_MESSAGES_KEY(chatId);
    const raws = await this.client.lrange(key, 0, -1);
    let hit = false;
    const next = raws.map((raw) => {
      const l = stringToLine(raw);
      if (l?.id === messageId) {
        hit = true;
        return lineToString({ ...l, excluded: excluded ? true : undefined });
      }
      return raw;
    });
    if (!hit) return false;
    await rewriteChatList(this.client, key, next);
    return true;
  }

  async deleteChatMessages(chatId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const key = CHAT_MESSAGES_KEY(chatId);
    const raws = await this.client.lrange(key, 0, -1);
    const drop = new Set(messageIds);
    const next = raws.filter((raw) => {
      const l = stringToLine(raw);
      return !(l && l.id && drop.has(l.id));
    });
    if (next.length === raws.length) return; // 没有命中任何要删的
    await rewriteChatList(this.client, key, next);
  }

  async recentChatMessages(chatId: string, n: number): Promise<HistoryLine[]> {
    const raws = await recentList(this.client, CHAT_MESSAGES_KEY(chatId), n);
    return raws.map(stringToLine).filter((l): l is HistoryLine => l !== null);
  }

  async allChatMessages(chatId: string): Promise<HistoryLine[]> {
    const raws = await this.client.lrange(CHAT_MESSAGES_KEY(chatId), 0, -1);
    return raws.map(stringToLine).filter((l): l is HistoryLine => l !== null);
  }

  async updateChat(chatId: string, meta: Partial<Pick<ChatMeta, 'title' | 'state' | 'usage' | 'persona' | 'settings'>>): Promise<void> {
    const cur = await this.getChat(chatId);
    if (!cur) return;
    if (meta.title !== undefined) cur.title = meta.title;
    if (meta.state !== undefined) cur.state = structuredClone(meta.state);
    if (meta.usage !== undefined) {
      // usage 按增量合并（calls 计数）
      const u = meta.usage;
      cur.usage = {
        input: (cur.usage?.input ?? 0) + u.input,
        output: (cur.usage?.output ?? 0) + u.output,
        calls: (cur.usage?.calls ?? 0) + u.calls,
      };
    }
    if (meta.persona !== undefined) cur.persona = structuredClone(meta.persona);
    if (meta.settings !== undefined) cur.settings = structuredClone(meta.settings);
    cur.updatedAt = Date.now();
    await this.client.set(CHAT_META_KEY(chatId), JSON.stringify(cur), 'EX', this.ttlSeconds);
  }

  async deleteChat(chatId: string): Promise<void> {
    const meta = await this.getChat(chatId);
    const pipe = this.client.multi();
    pipe.del(CHAT_META_KEY(chatId));
    pipe.del(CHAT_MESSAGES_KEY(chatId));
    if (meta) pipe.srem(WORLD_CHATS_KEY(meta.worldId), chatId);
    await pipe.exec();
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/* ------------------------------ 内存实现（Demo / 测试回退） ------------------------------ */

export class MemoryCardStore implements CardStore {
  private cards = new Map<string, Card>();
  private worlds = new Map<string, WorldState>();
  private histories = new Map<string, HistoryLine[]>();

  async getCard(id: string): Promise<Card | null> {
    const raw = this.cards.get(id);
    return normalizeCardConstant(raw ? structuredClone(raw) : null);
  }

  async getCards(ids: string[]): Promise<(Card | null)[]> {
    return ids.map((id) => normalizeCardConstant(this.cards.get(id) ? structuredClone(this.cards.get(id)!) : null));
  }

  async putCard(card: Card): Promise<void> {
    card.updatedAt = Date.now();
    this.cards.set(card.id, { ...card, data: structuredClone(card.data) });
  }

  // 世界目录（内存版用 Map<String, Set>）
  private worldCardIndex = new Map<string, Set<string>>();

  async listWorldCards(worldId: string): Promise<string[]> {
    return [...(this.worldCardIndex.get(worldId) ?? [])];
  }

  async addCardToWorld(worldId: string, cardId: string): Promise<void> {
    const set = this.worldCardIndex.get(worldId) ?? new Set<string>();
    set.add(cardId);
    this.worldCardIndex.set(worldId, set);
  }

  async deleteCard(worldId: string, cardId: string): Promise<void> {
    const set = this.worldCardIndex.get(worldId);
    if (set) {
      set.delete(cardId);
      if (set.size === 0) this.worldCardIndex.delete(worldId);
      else this.worldCardIndex.set(worldId, set);
    }
    this.cards.delete(cardId);
  }

  async listWorlds(): Promise<string[]> {
    return [...this.worldCardIndex.keys()];
  }

  async getWorldState(worldId: string): Promise<WorldState | null> {
    const s = this.worlds.get(worldId);
    return s ? structuredClone(s) : null;
  }

  async putWorldState(worldId: string, state: WorldState): Promise<void> {
    this.worlds.set(worldId, structuredClone(state));
  }

  async pushHistory(worldId: string, line: HistoryLine, maxLines: number): Promise<void> {
    ensureLineId(line);
    const arr = this.histories.get(worldId) ?? [];
    arr.push({ ...line, id: line.id });
    while (arr.length > maxLines) arr.shift();
    this.histories.set(worldId, arr);
  }

  async recentHistory(worldId: string, n: number): Promise<HistoryLine[]> {
    const arr = this.histories.get(worldId) ?? [];
    return arr.slice(-n);
  }

  /* ---- 会话级（内存版） ---- */

  private chats = new Map<string, ChatMeta>();
  private chatMessages = new Map<string, HistoryLine[]>();
  private worldChatIndex = new Map<string, Set<string>>();

  async createChat(worldId: string, title: string, state: WorldState): Promise<ChatMeta> {
    const chatId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const meta: ChatMeta = {
      chatId,
      worldId,
      title,
      state: structuredClone(state),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.chats.set(chatId, structuredClone(meta));
    const set = this.worldChatIndex.get(worldId) ?? new Set<string>();
    set.add(chatId);
    this.worldChatIndex.set(worldId, set);
    return meta;
  }

  async getChat(chatId: string): Promise<ChatMeta | null> {
    const c = this.chats.get(chatId);
    return c ? structuredClone(c) : null;
  }

  async listChats(worldId: string): Promise<ChatMeta[]> {
    const ids = this.worldChatIndex.get(worldId) ?? new Set<string>();
    return [...ids]
      .map((id) => this.chats.get(id))
      .filter((c): c is ChatMeta => c !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async pushChatMessage(chatId: string, line: HistoryLine, maxLines: number): Promise<void> {
    ensureLineId(line);
    const arr = this.chatMessages.get(chatId) ?? [];
    arr.push({ ...line, id: line.id });
    while (arr.length > maxLines) arr.shift();
    this.chatMessages.set(chatId, arr);
    const meta = this.chats.get(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.chats.set(chatId, meta);
    }
  }

  async editChatMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const arr = this.chatMessages.get(chatId);
    if (!arr) return false;
    const target = arr.find((l) => l.id === messageId);
    if (!target) return false;
    target.text = text;
    this.chatMessages.set(chatId, [...arr]);
    const meta = this.chats.get(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.chats.set(chatId, meta);
    }
    return true;
  }

  async setChatMessageSwipes(chatId: string, messageId: string, text: string, swipes: string[]): Promise<boolean> {
    const arr = this.chatMessages.get(chatId);
    if (!arr) return false;
    const target = arr.find((l) => l.id === messageId);
    if (!target) return false;
    const uniq = [...new Set(swipes.filter((s) => s.trim() && s !== text))];
    target.text = text;
    target.swipes = uniq.length > 0 ? uniq : undefined;
    this.chatMessages.set(chatId, [...arr]);
    const meta = this.chats.get(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.chats.set(chatId, meta);
    }
    return true;
  }

  async setChatMessageExcluded(chatId: string, messageId: string, excluded: boolean): Promise<boolean> {
    const arr = this.chatMessages.get(chatId);
    if (!arr) return false;
    const target = arr.find((l) => l.id === messageId);
    if (!target) return false;
    if (excluded) target.excluded = true;
    else delete target.excluded;
    this.chatMessages.set(chatId, [...arr]);
    const meta = this.chats.get(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.chats.set(chatId, meta);
    }
    return true;
  }

  async deleteChatMessages(chatId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const arr = this.chatMessages.get(chatId);
    if (!arr) return;
    const drop = new Set(messageIds);
    const next = arr.filter((l) => !(l.id && drop.has(l.id)));
    if (next.length === arr.length) return;
    this.chatMessages.set(chatId, next);
    const meta = this.chats.get(chatId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.chats.set(chatId, meta);
    }
  }

  async recentChatMessages(chatId: string, n: number): Promise<HistoryLine[]> {
    const arr = this.chatMessages.get(chatId) ?? [];
    return arr.slice(-n);
  }

  async allChatMessages(chatId: string): Promise<HistoryLine[]> {
    return [...(this.chatMessages.get(chatId) ?? [])];
  }

  async updateChat(chatId: string, meta: Partial<Pick<ChatMeta, 'title' | 'state' | 'usage' | 'persona' | 'settings'>>): Promise<void> {
    const cur = this.chats.get(chatId);
    if (!cur) return;
    if (meta.title !== undefined) cur.title = meta.title;
    if (meta.state !== undefined) cur.state = structuredClone(meta.state);
    if (meta.usage !== undefined) {
      const u = meta.usage;
      cur.usage = {
        input: (cur.usage?.input ?? 0) + u.input,
        output: (cur.usage?.output ?? 0) + u.output,
        calls: (cur.usage?.calls ?? 0) + u.calls,
      };
    }
    if (meta.persona !== undefined) cur.persona = structuredClone(meta.persona);
    if (meta.settings !== undefined) cur.settings = structuredClone(meta.settings);
    cur.updatedAt = Date.now();
    this.chats.set(chatId, cur);
  }

  async deleteChat(chatId: string): Promise<void> {
    this.chats.delete(chatId);
    this.chatMessages.delete(chatId);
    for (const [worldId, set] of this.worldChatIndex) {
      if (set.delete(chatId)) this.worldChatIndex.set(worldId, set);
    }
  }

  /* ---- 快照（FileCardStore 持久化用 / 测试） ---- */

  /** 导出全量快照（结构化 JSON 安全的普通对象） */
  dumpSnapshot(): MemorySnapshot {
    return {
      cards: [...this.cards.entries()].map(([id, card]) => ({ id, card: structuredClone(card) })),
      worlds: [...this.worlds.entries()].map(([id, state]) => ({ id, state: structuredClone(state) })),
      histories: [...this.histories.entries()].map(([id, lines]) => ({ id, lines: structuredClone(lines) })),
      worldCardIndex: [...this.worldCardIndex.entries()].map(([id, set]) => ({ id, ids: [...set] })),
      chats: [...this.chats.entries()].map(([id, meta]) => ({ id, meta: structuredClone(meta) })),
      chatMessages: [...this.chatMessages.entries()].map(([id, lines]) => ({ id, lines: structuredClone(lines) })),
      worldChatIndex: [...this.worldChatIndex.entries()].map(([id, set]) => ({ id, ids: [...set] })),
    };
  }

  /** 载入快照（覆盖当前内存态；用于重启恢复） */
  loadSnapshot(snap: MemorySnapshot): void {
    this.cards = new Map(snap.cards.map(({ id, card }) => [id, structuredClone(card)]));
    this.worlds = new Map(snap.worlds.map(({ id, state }) => [id, structuredClone(state)]));
    this.histories = new Map(snap.histories.map(({ id, lines }) => [id, structuredClone(lines)]));
    this.worldCardIndex = new Map(snap.worldCardIndex.map(({ id, ids }) => [id, new Set(ids)]));
    this.chats = new Map(snap.chats.map(({ id, meta }) => [id, structuredClone(meta)]));
    this.chatMessages = new Map(snap.chatMessages.map(({ id, lines }) => [id, structuredClone(lines)]));
    this.worldChatIndex = new Map(snap.worldChatIndex.map(({ id, ids }) => [id, new Set(ids)]));
  }

  async close(): Promise<void> {
    /* 无事可做 */
  }
}

/** 内存全量快照（MemoryCardStore.dumpSnapshot 的结构化形态） */
export interface MemorySnapshot {
  cards: Array<{ id: string; card: Card }>;
  worlds: Array<{ id: string; state: WorldState }>;
  histories: Array<{ id: string; lines: HistoryLine[] }>;
  worldCardIndex: Array<{ id: string; ids: string[] }>;
  chats: Array<{ id: string; meta: ChatMeta }>;
  chatMessages: Array<{ id: string; lines: HistoryLine[] }>;
  worldChatIndex: Array<{ id: string; ids: string[] }>;
}

/* ------------------------------ 便捷校验 ------------------------------ */
/* 守卫函数实现在 src/cards/util.ts；这里 re-export 保持旧导入路径可用。 */

export { isCharacterCard, isSceneCard };
