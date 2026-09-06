/**
 * FileCardStore —— 文件持久化存储（「关掉不丢」里程碑）。
 *
 * 基于 MemoryCardStore 全量快照：
 * - 内存态 = MemoryCardStore（读写快、零依赖）
 * - 每次写操作后 debounce（默认 300ms）把全量快照写入
 *   `PITAVERN_DATA_DIR/state.json`（原子写：tmp + rename）
 * - close() 强制 flush（进程退出前调用，避免丢最后几次写）
 * - 重启构造时若快照存在则自动 load → 进度恢复
 *
 * 适用规模：单机本地（世界/会话/历史总量 ≤ 数 MB）；远大于此请用 Redis。
 */
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, HistoryLine } from '../types.js';
import { MemoryCardStore, RedisCardStore } from './store.js';
import type { CardStore, ChatMeta, WorldState } from './store.js';

export interface FileStoreOptions {
  /** 数据目录（默认 process.env.PITAVERN_DATA_DIR ?? './data'） */
  dir?: string;
  /** 写后落盘延迟 ms（默认 300；测试可设 0 = 立即写） */
  debounceMs?: number;
}

const SNAPSHOT_FILE = 'state.json';

export class FileCardStore extends MemoryCardStore {
  private dir: string;
  private file: string;
  private debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private loaded = false;
  /** init 时是否成功从快照恢复 */
  recovered = false;

  constructor(opts: FileStoreOptions = {}) {
    super();
    this.dir = opts.dir ?? process.env.PITAVERN_DATA_DIR ?? './data';
    this.debounceMs = opts.debounceMs ?? 300;
    this.file = join(this.dir, SNAPSHOT_FILE);
    mkdirSync(this.dir, { recursive: true });
  }

  /** 启动时载入既有快照（幂等；文件不存在静默跳过） */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const snap = JSON.parse(raw) as Parameters<MemoryCardStore['loadSnapshot']>[0];
      this.loadSnapshot(snap);
      this.recovered = true;
    } catch (err) {
      // 快照损坏不应阻断启动：备份后跳过（保留现场供排查）
      console.warn(`[FileCardStore] 快照读取失败（${String(err)}），跳过恢复`);
      try {
        rmSync(this.file);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 已加载的快照文件是否存在（供启动日志） */
  snapshotExists(): boolean {
    return existsSync(this.file);
  }

  /* ---------------- 写路径覆写（写后调度持久化） ---------------- */

  private schedulePersist(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.debounceMs <= 0) {
      void this.persistNow();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistNow();
    }, this.debounceMs);
  }

  /** 立即落盘（串行化：前一次未完成则排队） */
  private async persistNow(): Promise<void> {
    const seq = ++this.writeSeq;
    this.persistChain = this.persistChain.then(async () => {
      if (seq !== this.writeSeq) return; // 已有更新的写请求，跳过本次
      const tmp = this.file + '.tmp';
      try {
        writeFileSync(tmp, JSON.stringify(this.dumpSnapshot()), 'utf8');
        renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`[FileCardStore] 快照写入失败: ${String(err)}`);
      }
    });
    await this.persistChain;
  }

  override async putCard(card: Card): Promise<void> {
    await super.putCard(card);
    this.schedulePersist();
  }

  override async addCardToWorld(worldId: string, cardId: string): Promise<void> {
    await super.addCardToWorld(worldId, cardId);
    this.schedulePersist();
  }

  override async putWorldState(worldId: string, state: WorldState): Promise<void> {
    await super.putWorldState(worldId, state);
    this.schedulePersist();
  }

  override async pushHistory(worldId: string, line: HistoryLine, maxLines: number): Promise<void> {
    await super.pushHistory(worldId, line, maxLines);
    this.schedulePersist();
  }

  override async createChat(worldId: string, title: string, state: WorldState): Promise<ChatMeta> {
    const meta = await super.createChat(worldId, title, state);
    this.schedulePersist();
    return meta;
  }

  override async pushChatMessage(chatId: string, line: HistoryLine, maxLines: number): Promise<void> {
    await super.pushChatMessage(chatId, line, maxLines);
    this.schedulePersist();
  }

  override async editChatMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const ok = await super.editChatMessage(chatId, messageId, text);
    if (ok) this.schedulePersist();
    return ok;
  }

  override async setChatMessageSwipes(chatId: string, messageId: string, text: string, swipes: string[]): Promise<boolean> {
    const ok = await super.setChatMessageSwipes(chatId, messageId, text, swipes);
    if (ok) this.schedulePersist();
    return ok;
  }

  override async deleteChatMessages(chatId: string, messageIds: string[]): Promise<void> {
    await super.deleteChatMessages(chatId, messageIds);
    this.schedulePersist();
  }

  override async setChatMessageExcluded(chatId: string, messageId: string, excluded: boolean): Promise<boolean> {
    const ok = await super.setChatMessageExcluded(chatId, messageId, excluded);
    if (ok) this.schedulePersist();
    return ok;
  }

  override async deleteCard(worldId: string, cardId: string): Promise<void> {
    await super.deleteCard(worldId, cardId);
    this.schedulePersist();
  }

  override async updateChat(chatId: string, meta: Partial<Pick<ChatMeta, 'title' | 'state' | 'usage' | 'persona' | 'settings'>>): Promise<void> {
    await super.updateChat(chatId, meta);
    this.schedulePersist();
  }

  override async deleteChat(chatId: string): Promise<void> {
    await super.deleteChat(chatId);
    this.schedulePersist();
  }

  /** 关闭前 flush 全部挂起写（进程退出路径调用） */
  override async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.persistNow();
  }
}

/**
 * 按环境打开存储：PITAVERN_DATA_DIR（文件持久化）> REDIS_URL（Redis）> 内存。
 * 进程退出前请 await store.close()（FileCardStore flush；RedisCardStore 断连）。
 */
export async function openDefaultStore(): Promise<{
  store: CardStore;
  kind: 'file' | 'redis' | 'memory';
  detail: string;
  /** 是否从既有持久化数据恢复（file 快照成功 load） */
  recovered: boolean;
}> {
  const dataDir = process.env.PITAVERN_DATA_DIR;
  if (dataDir) {
    const store = new FileCardStore({ dir: dataDir });
    await store.init();
    return { store, kind: 'file', detail: store.recovered ? `已恢复快照（${dataDir}）` : `新目录 ${dataDir}`, recovered: store.recovered };
  }
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const rs = new RedisCardStore(redisUrl);
    try {
      await rs.connect();
      return { store: rs, kind: 'redis', detail: redisUrl, recovered: false };
    } catch (err) {
      console.warn(`[openDefaultStore] Redis 连接失败（${String(err)}），回退内存`);
    }
  }
  return { store: new MemoryCardStore(), kind: 'memory', detail: '内存（不持久化）', recovered: false };
}
