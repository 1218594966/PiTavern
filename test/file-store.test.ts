import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCardStore } from '../src/db/file-store.js';
import { seedDemoWorld } from '../src/pipeline.js';

/** 每个用例独立临时目录 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'pitavern-test-'));
}

describe('M3 FileCardStore 文件持久化', () => {
  it('写入（debounce=0）→ 重建实例 init → 全部读回', async () => {
    const dir = freshDir();
    try {
      const s1 = new FileCardStore({ dir, debounceMs: 0 });
      await s1.init();
      await seedDemoWorld(s1);
      const chat = await s1.createChat('demo_world', '测试会话', (await s1.getWorldState('demo_world'))!);
      await s1.pushChatMessage(chat.chatId, { speaker: 'user', text: '你好', turn: 1 }, 50);
      await s1.pushChatMessage(chat.chatId, { speaker: 'NPC', text: '欢迎', turn: 1 }, 50);
      await s1.updateChat(chat.chatId, { usage: { input: 10, output: 5, calls: 2 } });
      // 依赖副作用顺序：直接 s1 关
      await s1.close();

      expect(existsSync(join(dir, 'state.json'))).toBe(true);

      // 重启：新实例读回
      const s2 = new FileCardStore({ dir, debounceMs: 0 });
      await s2.init();
      const card = await s2.getCard('char_alicia');
      expect(card?.kind).toBe('character');
      const worldCards = await s2.listWorldCards('demo_world');
      expect(worldCards.length).toBeGreaterThan(0);
      const chats = await s2.listChats('demo_world');
      expect(chats.length).toBe(1);
      const lines = await s2.allChatMessages(chat.chatId);
      expect(lines.map((l) => l.text)).toEqual(['你好', '欢迎']);
      expect((await s2.getChat(chat.chatId))?.usage).toEqual({ input: 10, output: 5, calls: 2 });
      const state = await s2.getWorldState('demo_world');
      expect(state?.turn).toBe(1);
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() flush 挂起的 debounce 写（timer 未触发也能落盘）', async () => {
    const dir = freshDir();
    try {
      const s1 = new FileCardStore({ dir, debounceMs: 10_000 }); // 长 debounce：不 close 不会落盘
      await s1.init();
      await s1.putCard({ id: 'char_x', kind: 'character', data: { name: 'X', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
      await s1.close(); // flush

      const s2 = new FileCardStore({ dir, debounceMs: 0 });
      await s2.init();
      expect((await s2.getCard('char_x'))?.kind).toBe('character');
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('快照损坏不阻断启动（备份跳过，可继续写）', async () => {
    const dir = freshDir();
    try {
      const s1 = new FileCardStore({ dir, debounceMs: 0 });
      await s1.init();
      await s1.putCard({ id: 'char_y', kind: 'character', data: { name: 'Y', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
      await s1.close();
      // 破坏快照
      const fs = await import('node:fs');
      fs.writeFileSync(join(dir, 'state.json'), '{broken json');
      const s2 = new FileCardStore({ dir, debounceMs: 0 });
      await s2.init(); // 不应抛
      await s2.putCard({ id: 'char_z', kind: 'character', data: { name: 'Z', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
      await s2.close();
      const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { cards: Array<{ id: string }> };
      expect(raw.cards.some((c) => c.id === 'char_z')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('删除卡 / 出戏开关也持久化（A2：覆写缺失导致重启回滚）', async () => {
    const dir = freshDir();
    try {
      const s1 = new FileCardStore({ dir, debounceMs: 0 });
      await s1.init();
      await s1.putCard({ id: 'char_x', kind: 'character', data: { name: 'X', role: '', description: '', personality: '', speechStyle: '', state: { affection: 0, innerThought: '', roomChanges: [] } } });
      await s1.addCardToWorld('w1', 'char_x');
      const chat = await s1.createChat('w1', '会话', (await s1.getWorldState('w1')) ?? { currentSceneId: '', presentCharacterIds: [], playerInventory: [], turn: 1, updatedAt: Date.now() });
      await s1.pushChatMessage(chat.chatId, { id: 'msg1', speaker: 'user', text: '你好', turn: 1 }, 50);
      await s1.pushChatMessage(chat.chatId, { id: 'msg2', speaker: 'NPC', text: '欢迎', turn: 1 }, 50);
      // 删除卡 + 出戏
      await s1.deleteCard('w1', 'char_x');
      await s1.setChatMessageExcluded(chat.chatId, 'msg2', true);
      await s1.close();

      const s2 = new FileCardStore({ dir, debounceMs: 0 });
      await s2.init();
      expect(await s2.getCard('char_x')).toBeNull(); // 删除在重启后仍生效
      const lines = await s2.allChatMessages(chat.chatId);
      expect(lines.find((l) => l.id === 'msg2')?.excluded).toBe(true); // 出戏仍在
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
