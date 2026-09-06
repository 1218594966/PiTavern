import { describe, it, expect } from 'vitest';
import { MemoryCardStore } from '../src/db/store.js';
import { layerBoundaryHit, layerCompressRange, summarizeLayer } from '../src/stages/summarizer.js';
import { assembleCards } from '../src/stages/assembler.js';
import { seedDemoWorld } from '../src/pipeline.js';
import type { WorldIndex } from '../src/pipeline.js';
import type { RouteDecision } from '../src/types.js';

describe('M8 记忆分层', () => {
  it('M9-2 缓冲触发：宽度 20 + 缓冲 10 → 第 30 层才压 1-20，21-30 留全文', () => {
    // 用户机制：每 20 层压一段 + 缓冲 10 → 完成第 30 层时压缩 [1,20]，21-30 保留全文
    expect(layerBoundaryHit(30, 20, 10)).toBe(true);
    expect(layerCompressRange(30, 20, 10)).toEqual({ from: 1, to: 20 });
    // 21/25/29 层都不触发（缓冲期不动）
    expect(layerBoundaryHit(21, 20, 10)).toBe(false);
    expect(layerBoundaryHit(25, 20, 10)).toBe(false);
    expect(layerBoundaryHit(29, 20, 10)).toBe(false);
    // 完成第 50 层 → 压 [21,40]（41-50 全文）
    expect(layerCompressRange(50, 20, 10)).toEqual({ from: 21, to: 40 });
    // 31~49 缓冲期不触发
    expect(layerBoundaryHit(31, 20, 10)).toBe(false);
    expect(layerBoundaryHit(45, 20, 10)).toBe(false);
    // buffer=0（旧语义）：第 20 层压 [1,20]
    expect(layerCompressRange(20, 20, 0)).toEqual({ from: 1, to: 20 });
    expect(layerBoundaryHit(19, 20, 0)).toBe(false);
    // 关闭
    expect(layerBoundaryHit(30, 0, 10)).toBe(false);
  });

  it('summarizeLayer：faux 占位生成层摘要卡（幂等重压同层区间）', async () => {    const store = new MemoryCardStore();
    await store.putCard({
      id: 'sys_t',
      kind: 'system',
      data: { world: 'w', rules: ['r'] },
    });
    const r = await summarizeLayer(
      {} as never, // faux 模式不调模型
      {} as never,
      store,
      {
        worldId: 'w',
        layerFrom: 1,
        layerTo: 5,
        lines: [
          { speaker: 'user', text: '有人吗？', turn: 1 },
          { speaker: '艾莉西亚', text: '来了来了，要点什么？', turn: 1 },
          { speaker: 'user', text: '你认识安德鲁吗？', turn: 3 },
          { speaker: '艾莉西亚', text: '……别提他。', turn: 3 },
        ],
        characterNames: ['艾莉西亚'],
        useRealModel: false,
      },
    );
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe('mem_l1_5');
    const card = await store.getCard('mem_l1_5');
    expect(card?.kind).toBe('memory');
    const d = card!.data as { isSummary?: boolean; layerFrom?: number; layerTo?: number; detail: string };
    expect(d.isSummary).toBe(true);
    expect(d.layerFrom).toBe(1);
    expect(d.layerTo).toBe(5);
    expect(d.detail).toContain('第 1-5 层回顾');
    expect(d.detail).toContain('安德鲁');
    expect(await store.listWorldCards('w')).toContain('mem_l1_5');

    // 幂等重压：同区间再压一次 → 只一张
    await summarizeLayer(
      {} as never, {} as never, store,
      { worldId: 'w', layerFrom: 1, layerTo: 5, lines: [{ speaker: 'user', text: '再来一次', turn: 2 }], characterNames: [], useRealModel: false },
    );
    const memCards = (await store.getCards(await store.listWorldCards('w'))).filter((c) => c?.kind === 'memory');
    expect(memCards.length).toBe(1);
  });

  it('assembler：层摘要链全量贴入插槽（旧层摘要 + 最近层全文并存）', async () => {
    const store = new MemoryCardStore();
    const index: WorldIndex = await seedDemoWorld(store);
    const route: RouteDecision = {
      sceneCardId: 'scene_inn',
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 4,
      turn: 30,
      systemCardId: null,
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '继续说下去。',
        history: [
          { speaker: 'user', text: '最近层全文第一条', turn: 27 },
          { speaker: '艾莉西亚', text: '最近层全文第二条', turn: 27 },
        ],
        layerSummaries: [
          { layerFrom: 1, layerTo: 10, detail: '你们在暴雨夜相遇，她提起过世的父亲。' },
          { layerFrom: 11, layerTo: 20, detail: '你帮她修好了酒窖的门，她开始信任你。' },
        ],
      },
      store,
    );
    // 两段摘要全量都在
    expect(assembled.prompt).toContain('第 1-10 层回顾');
    expect(assembled.prompt).toContain('第 11-20 层回顾');
    expect(assembled.prompt).toContain('修好了酒窖的门');
    // 最近层全文保留在插槽 4
    expect(assembled.prompt).toContain('最近层全文第一条');
    expect(assembled.slots.tokenBreakdown.layer).toBeGreaterThan(0);
  });

  it('A5：会话摘要卡按 chat 隔离 —— 不同会话同层区间各存各的，loadWorldIndex 只取本会话', async () => {
    const store = new MemoryCardStore();
    await seedDemoWorld(store);
    const chatA = await store.createChat('demo_world', '会话A', (await store.getWorldState('demo_world'))!);
    const chatB = await store.createChat('demo_world', '会话B', (await store.getWorldState('demo_world'))!);
    const mkLines = (turns: number[]) => turns.map((t) => ({ speaker: 'user' as const, text: `t${t}`, turn: t }));

    const rA = await summarizeLayer({} as never, {} as never, store, {
      worldId: 'demo_world', chatId: chatA.chatId, layerFrom: 1, layerTo: 5,
      lines: mkLines([1, 2, 3, 4, 5]), characterNames: [], useRealModel: false,
    });
    const rB = await summarizeLayer({} as never, {} as never, store, {
      worldId: 'demo_world', chatId: chatB.chatId, layerFrom: 1, layerTo: 5,
      lines: mkLines([1, 2, 3, 4, 5]), characterNames: [], useRealModel: false,
    });
    // 各自的卡 id 不同（不再共用 mem_l1_5 互相覆盖）
    expect(rA!.cardId).not.toBe(rB!.cardId);
    const cardA = await store.getCard(rA!.cardId);
    const cardB = await store.getCard(rB!.cardId);
    expect(cardA?.kind).toBe('memory');
    expect(cardB?.kind).toBe('memory');
    expect(cardA!.id).not.toBe(cardB!.id);

    // 幂等重压：只影响自己那张（不会删掉对方的）
    await summarizeLayer({} as never, {} as never, store, {
      worldId: 'demo_world', chatId: chatA.chatId, layerFrom: 1, layerTo: 5,
      lines: mkLines([1, 2, 3, 4, 5]), characterNames: [], useRealModel: false,
    });
    expect(await store.getCard(rB!.cardId)).not.toBeNull();

    // 索引按 chatId 隔离加载：A 只看得到 A 的摘要
    const { loadWorldIndex } = await import('../src/pipeline.js');
    const idxA = await loadWorldIndex(store, 'demo_world', { chatId: chatA.chatId });
    const layerIdsA = (idxA.layerSummaries ?? []).map((s) => s.layerFrom + '-' + s.layerTo);
    expect(layerIdsA).toContain('1-5');
    const idxAll = await loadWorldIndex(store, 'demo_world');
    // 无 chat 上下文时，会话摘要不进世界级视图（避免串味）
    expect((idxAll.layerSummaries ?? []).filter((s) => s.layerFrom === 1 && s.layerTo === 5).length).toBe(0);
  });
});
