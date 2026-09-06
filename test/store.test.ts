import { describe, it, expect, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisCardStore, MemoryCardStore, WORLD_HISTORY_KEY, WORLD_STATE_KEY, CARD_PREFIX } from '../src/db/store.js';

/**
 * 用 mock Redis 客户端验证 RedisCardStore 的键空间与命令序列，
 * 保证「卡片 → world:state → 滑动历史 LIST」的读写符合预期。
 * （真实 Redis 行为由 ioredis 保证，这里验证我们的调用方式。）
 */
function mockRedisClient() {
  const calls: string[][] = [];
  const state = new Map<string, string>();
  /** key → 元素数组（队首为最旧；模拟 Redis LIST 左裁右进） */
  const lists = new Map<string, string[]>();

  /** 从 LIST 末尾裁掉超过 maxLines 的头部旧元素（模拟 LTRIM -maxLines -1） */
  const trimTail = (key: string, maxLines: number) => {
    const arr = lists.get(key) ?? [];
    lists.set(key, arr.slice(Math.max(0, arr.length - maxLines)));
  };

  const client = {
    get: vi.fn(async (key: string | Buffer) => state.get(String(key)) ?? null),
    set: vi.fn(async (key: string | Buffer, value: string | number | Buffer, _mode: string, _ttl: number) => {
      state.set(String(key), String(value));
      return 'OK' as const;
    }),
    mget: vi.fn(async (keys: Array<string | Buffer>) => keys.map((k) => state.get(String(k)) ?? null)),
    rpush: vi.fn(async (key: string | Buffer, ...values: string[]) => {
      const arr = lists.get(String(key)) ?? [];
      for (const v of values) arr.push(String(v));
      lists.set(String(key), arr);
      return arr.length;
    }),
    del: vi.fn(async (key: string | Buffer) => {
      lists.delete(String(key));
      state.delete(String(key));
      return 1;
    }),
    ltrim: vi.fn(async (key: string | Buffer, start: number, stop: number) => {
      const arr = lists.get(String(key)) ?? [];
      // 支持负索引（-maxLines → 保留末尾 maxLines 条）
      const normStart = start < 0 ? Math.max(0, arr.length + start) : start;
      const normStop = stop < 0 ? arr.length + stop : stop;
      lists.set(String(key), arr.slice(normStart, normStop + 1));
      return 'OK' as const;
    }),
    lrange: vi.fn(async (key: string | Buffer, start: number, stop: number) => {
      const arr = lists.get(String(key)) ?? [];
      if (start < 0 || stop < 0) {
        const normStart = start < 0 ? Math.max(0, arr.length + start) : start;
        const normStop = stop < 0 ? arr.length + stop : stop;
        return arr.slice(normStart, normStop + 1);
      }
      return arr.slice(start, stop + 1);
    }),
    multi: vi.fn(() => {
      const queued: Array<{ cmd: string; args: unknown[] }> = [];
      return {
        rpush: vi.fn(function (this: { cmds: unknown[] }, key: string, ...values: string[]) {
          queued.push({ cmd: 'rpush', args: [key, ...values] });
          return this;
        }),
        ltrim: vi.fn(function (this: { cmds: unknown[] }, key: string, a: number, b: number) {
          queued.push({ cmd: 'ltrim', args: [key, a, b] });
          return this;
        }),
        del: vi.fn(function (this: { cmds: unknown[] }, key: string) {
          queued.push({ cmd: 'del', args: [key] });
          return this;
        }),
        exec: vi.fn(async function (this: { cmds: unknown[] }) {
          calls.push(['multi', ...queued.map((q) => JSON.stringify([q.cmd, ...q.args]))]);
          // 真实执行排队命令
          for (const q of queued) {
            if (q.cmd === 'rpush') {
              const [key, ...values] = q.args as [string, ...string[]];
              const arr = lists.get(key) ?? [];
              for (const v of values) arr.push(v);
              lists.set(key, arr);
            } else if (q.cmd === 'ltrim') {
              const [key, start, stop] = q.args as [string, number, number];
              trimTail(key, Math.abs(start)); // 我们只用 -maxLines 形态
              void stop;
            } else if (q.cmd === 'del') {
              lists.delete(String(q.args[0]));
            }
          }
          return [];
        }),
      };
    }),
    quit: vi.fn(async () => 'OK' as const),
    connect: vi.fn(async () => undefined),
  };

  return { client, calls, state, lists };
}

describe('RedisCardStore 键空间与命令', () => {
  it('写卡/读卡使用 card: 前缀；批量 mget 保序', async () => {
    const m = mockRedisClient();
    // mock 实现与 ioredis 重载签名不兼容时用 never 断言（测试只关心调用行为）
    vi.spyOn(Redis.prototype, 'get').mockImplementation(m.client.get as never);
    vi.spyOn(Redis.prototype, 'set').mockImplementation(m.client.set as never);
    vi.spyOn(Redis.prototype, 'mget').mockImplementation(m.client.mget as never);
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(m.client.quit as never);
    vi.spyOn(Redis.prototype, 'connect').mockImplementation(m.client.connect as never);

    const store = new RedisCardStore('redis://x');
    await store.putCard({ id: 'char_1', kind: 'character', data: { name: 'A', state: { affection: 1, innerThought: '', roomChanges: [], updatedAtTurn: 0 } } as never });
    const card = await store.getCard('char_1');
    expect(card?.id).toBe('char_1');
    expect(m.client.set).toHaveBeenCalledWith(CARD_PREFIX + 'char_1', expect.any(String), 'EX', expect.any(Number));

    const cards = await store.getCards(['char_1', 'nope']);
    expect(cards.map((c) => c?.id ?? null)).toEqual(['char_1', null]);
  });

  it('世界状态与世界历史使用独立键；LIST 滑动窗口只留最近 N 条', async () => {
    const m = mockRedisClient();
    vi.spyOn(Redis.prototype, 'get').mockImplementation(m.client.get as never);
    vi.spyOn(Redis.prototype, 'set').mockImplementation(m.client.set as never);
    vi.spyOn(Redis.prototype, 'multi').mockImplementation(m.client.multi as never);
    vi.spyOn(Redis.prototype, 'lrange').mockImplementation(m.client.lrange as never);
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(m.client.quit as never);
    vi.spyOn(Redis.prototype, 'connect').mockImplementation(m.client.connect as never);

    const store = new RedisCardStore('redis://x');
    await store.putWorldState('w1', { currentSceneId: 's1', presentCharacterIds: ['c1'], playerInventory: [], turn: 1, updatedAt: 1 });
    const ws = await store.getWorldState('w1');
    expect(ws?.currentSceneId).toBe('s1');
    expect(m.client.set).toHaveBeenCalledWith(WORLD_STATE_KEY('w1'), expect.any(String), 'EX', expect.any(Number));

    // 推 3 条历史，窗口 2
    await store.pushHistory('w1', { speaker: 'user', text: 'a', turn: 1 }, 2);
    await store.pushHistory('w1', { speaker: 'user', text: 'b', turn: 2 }, 2);
    await store.pushHistory('w1', { speaker: 'user', text: 'c', turn: 3 }, 2);

    // pushHistory 内部 multi 应包含 rpush + ltrim（exec 时批量发送）
    const multiCalls = m.calls.filter((c) => c[0] === 'multi');
    expect(multiCalls.length).toBe(3);
    expect(multiCalls[0]![1]).toContain('rpush');
    expect(multiCalls[0]![2]).toContain('ltrim');

    const recent = await store.recentHistory('w1', 10);
    expect(recent.map((h) => h.text)).toEqual(['b', 'c']); // 窗口 2，最旧的 a 被裁掉
    expect(m.client.lrange).toHaveBeenCalledWith(WORLD_HISTORY_KEY('w1'), -10, -1);
  });

  it('同回合两条消息保持写入先后（回归：ZSET 字典序曾颠倒同回合顺序）', async () => {
    const m = mockRedisClient();
    vi.spyOn(Redis.prototype, 'multi').mockImplementation(m.client.multi as never);
    vi.spyOn(Redis.prototype, 'lrange').mockImplementation(m.client.lrange as never);
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(m.client.quit as never);
    vi.spyOn(Redis.prototype, 'connect').mockImplementation(m.client.connect as never);

    const store = new RedisCardStore('redis://x');
    // 同一回合 turn=1：先玩家输入，后 NPC 回话（旧 ZSET 实现会因同分字典序颠倒）
    await store.pushHistory('w1', { speaker: 'user', text: '玩家问题', turn: 1 }, 50);
    await store.pushHistory('w1', { speaker: 'NPC', text: 'NPC 回答', turn: 1 }, 50);
    // 再推下一回合的同分对，验证滑动窗口裁剪不影响顺序
    await store.pushHistory('w1', { speaker: 'user', text: '玩家追问', turn: 2 }, 50);
    await store.pushHistory('w1', { speaker: 'NPC', text: 'NPC 再答', turn: 2 }, 50);

    const recent = await store.recentHistory('w1', 50);
    expect(recent.map((h) => h.text)).toEqual(['玩家问题', 'NPC 回答', '玩家追问', 'NPC 再答']);
    expect(recent.map((h) => h.speaker)).toEqual(['user', 'NPC', 'user', 'NPC']);
  });

  it('会话消息：allChatMessages 旧→新、recentChatMessages 取最近 N 条且保序', async () => {
    const m = mockRedisClient();
    vi.spyOn(Redis.prototype, 'get').mockImplementation(m.client.get as never);
    vi.spyOn(Redis.prototype, 'set').mockImplementation(m.client.set as never);
    vi.spyOn(Redis.prototype, 'multi').mockImplementation(m.client.multi as never);
    vi.spyOn(Redis.prototype, 'lrange').mockImplementation(m.client.lrange as never);
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(m.client.quit as never);
    vi.spyOn(Redis.prototype, 'connect').mockImplementation(m.client.connect as never);

    const store = new RedisCardStore('redis://x');
    await store.pushChatMessage('c1', { speaker: 'user', text: 'm1', turn: 1 }, 10);
    await store.pushChatMessage('c1', { speaker: 'NPC', text: 'm2', turn: 1 }, 10);
    await store.pushChatMessage('c1', { speaker: 'user', text: 'm3', turn: 2 }, 10);

    expect((await store.allChatMessages('c1')).map((h) => h.text)).toEqual(['m1', 'm2', 'm3']);
    expect((await store.recentChatMessages('c1', 2)).map((h) => h.text)).toEqual(['m2', 'm3']);
  });

  it('M1-3 消息编辑/删除：push 自动补 id，可按 id 编辑与删除', async () => {
    const m = mockRedisClient();
    vi.spyOn(Redis.prototype, 'get').mockImplementation(m.client.get as never);
    vi.spyOn(Redis.prototype, 'set').mockImplementation(m.client.set as never);
    vi.spyOn(Redis.prototype, 'multi').mockImplementation(m.client.multi as never);
    vi.spyOn(Redis.prototype, 'lrange').mockImplementation(m.client.lrange as never);
    vi.spyOn(Redis.prototype, 'rpush').mockImplementation(m.client.rpush as never);
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(m.client.quit as never);
    vi.spyOn(Redis.prototype, 'connect').mockImplementation(m.client.connect as never);

    const store = new RedisCardStore('redis://x');
    await store.pushChatMessage('c1', { speaker: 'user', text: '原话', turn: 1 }, 10);
    await store.pushChatMessage('c1', { speaker: 'NPC', text: '回复', turn: 1 }, 10);
    const all = await store.allChatMessages('c1');
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBeTruthy(); // 自动补 id
    expect(all[1]!.id).toBeTruthy();

    // 编辑第一条
    const ok = await store.editChatMessage('c1', all[0]!.id!, '改后的话');
    expect(ok).toBe(true);
    const afterEdit = await store.allChatMessages('c1');
    expect(afterEdit[0]!.text).toBe('改后的话');
    expect(afterEdit[1]!.text).toBe('回复');

    // 编辑不存在的 id → false
    expect(await store.editChatMessage('c1', 'no_such', 'x')).toBe(false);

    // 删除两条（regenerate 语义）
    await store.deleteChatMessages('c1', [all[0]!.id!, all[1]!.id!]);
    expect(await store.allChatMessages('c1')).toEqual([]);
  });

  it('M2-5 updateChat usage 增量合并（会话累计 token）', async () => {
    const store = new MemoryCardStore();
    const created = await store.createChat('w1', 't2', { currentSceneId: 's', presentCharacterIds: [], playerInventory: [], turn: 1, updatedAt: 1 });
    // 更新不存在的会话 → no-op
    await store.updateChat('no_such', { usage: { input: 5, output: 3, calls: 2 } });
    await store.updateChat(created.chatId, { usage: { input: 100, output: 50, calls: 2 } });
    await store.updateChat(created.chatId, { usage: { input: 30, output: 20, calls: 1 } });
    const after = await store.getChat(created.chatId);
    expect(after?.usage).toEqual({ input: 130, output: 70, calls: 3 });
  });

  it('M3-1 setChatMessageSwipes：版本切换（text ↔ swipes 循环）+ 去重', async () => {
    const store = new MemoryCardStore();
    const created = await store.createChat('w1', 't', { currentSceneId: 's', presentCharacterIds: [], playerInventory: [], turn: 1, updatedAt: 1 });
    await store.pushChatMessage(created.chatId, { speaker: 'NPC', text: '版本A', turn: 1 }, 50);
    const msg = (await store.allChatMessages(created.chatId))[0]!;

    // 迁移：text=版本B，历史=[版本A]
    await store.setChatMessageSwipes(created.chatId, msg.id!, '版本B', ['版本A']);
    let cur = (await store.allChatMessages(created.chatId))[0]!;
    expect(cur.text).toBe('版本B');
    expect(cur.swipes).toEqual(['版本A']);

    // 切回版本A：text=版本A，swipes=[版本B]（旧 current 回历史）
    await store.setChatMessageSwipes(created.chatId, msg.id!, '版本A', ['版本B']);
    cur = (await store.allChatMessages(created.chatId))[0]!;
    expect(cur.text).toBe('版本A');
    expect(cur.swipes).toEqual(['版本B']);

    // 去重：重复版本与当前文本相同的不进历史
    await store.setChatMessageSwipes(created.chatId, msg.id!, '版本C', ['版本C', '版本A', '', '版本A']);
    cur = (await store.allChatMessages(created.chatId))[0]!;
    expect(cur.swipes).toEqual(['版本A']);

    // 不存在的 id → false
    expect(await store.setChatMessageSwipes(created.chatId, 'no_such', 'x', [])).toBe(false);
  });

  it('M6-3 setChatMessageExcluded：标出戏/回场（MemoryCardStore）', async () => {
    const store = new MemoryCardStore();
    const created = await store.createChat('w1', 't', { currentSceneId: 's', presentCharacterIds: [], playerInventory: [], turn: 1, updatedAt: 1 });
    await store.pushChatMessage(created.chatId, { speaker: 'user', text: '剧情行', turn: 1 }, 50);
    const msg = (await store.allChatMessages(created.chatId))[0]!;
    expect(msg.excluded).toBeUndefined();

    // 出戏
    expect(await store.setChatMessageExcluded(created.chatId, msg.id!, true)).toBe(true);
    let cur = (await store.allChatMessages(created.chatId))[0]!;
    expect(cur.excluded).toBe(true);
    // 行保留（不删除）
    expect((await store.allChatMessages(created.chatId)).length).toBe(1);

    // 回场（字段移除）
    await store.setChatMessageExcluded(created.chatId, msg.id!, false);
    cur = (await store.allChatMessages(created.chatId))[0]!;
    expect(cur.excluded).toBeUndefined();

    // 不存在的 id → false
    expect(await store.setChatMessageExcluded(created.chatId, 'no_such', true)).toBe(false);
  });

  it('M7 deleteCard：删卡并从世界目录移除', async () => {
    const store = new MemoryCardStore();
    await store.putCard({ id: 'char_a', kind: 'character', data: { name: 'A', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
    await store.addCardToWorld('w1', 'char_a');
    await store.putCard({ id: 'char_b', kind: 'character', data: { name: 'B', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
    await store.addCardToWorld('w1', 'char_b');
    expect(await store.listWorldCards('w1')).toEqual(['char_a', 'char_b']);

    await store.deleteCard('w1', 'char_a');
    expect(await store.listWorldCards('w1')).toEqual(['char_b']);
    expect(await store.getCard('char_a')).toBeNull();
    expect(await store.getCard('char_b')).not.toBeNull();
  });
});
