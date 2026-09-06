import { describe, it, expect, beforeAll } from 'vitest';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { MemoryCardStore } from '../src/db/store.js';
import { getFauxModels, getFauxModelsCollection } from '../src/config/models.js';
import { seedDemoWorld, runTurn } from '../src/pipeline.js';
import type { WorldIndex } from '../src/pipeline.js';

describe('四阶段流水线（faux 全链路）', () => {
  let store: MemoryCardStore;
  let index: WorldIndex;

  beforeAll(async () => {
    store = new MemoryCardStore();
    index = await seedDemoWorld(store);

    const faux = getFauxModels();
    // 每个阶段预置 3 份响应（多次跑也够用）
    faux.setResponses({
      router: [
        fauxAssistantMessage([
          fauxText(
            JSON.stringify({
              sceneCardId: null,
              characterCardIds: ['char_alicia'],
              speakerCharacterId: 'char_alicia',
              memoryCardIds: ['mem_andrew_fallout'],
              itemCardIds: [],
              historyWindow: 6,
              turn: 1,
            }),
          ),
        ]),
        fauxAssistantMessage([
          fauxText(
            JSON.stringify({
              sceneCardId: null,
              characterCardIds: ['char_alicia'],
              speakerCharacterId: 'char_alicia',
              memoryCardIds: [],
              itemCardIds: ['item_dagger'],
              historyWindow: 6,
              turn: 2,
            }),
          ),
        ]),
      ],
      actor: [
        fauxAssistantMessage([
          fauxText(
            '艾莉西亚指节在柜台上轻轻一叩：「安德鲁？那笔货款够他烧三年了。你提他做什么？」',
          ),
        ]),
        fauxAssistantMessage([fauxText('她瞥了一眼你手里的短剑：「这东西，还是放回桌上比较好。」')]),
      ],
      evaluator: [
        fauxAssistantMessage([
          fauxText(
            JSON.stringify({
              affectionChanges: [{ characterId: 'char_alicia', delta: -1 }],
              innerThoughts: [{ characterId: 'char_alicia', thought: '提到安德鲁让她想起旧账，戒备又重了一分。' }],
              roomChanges: [],
              itemTransfers: [],
              newMemoryCards: [],
            }),
          ),
        ]),
        fauxAssistantMessage([
          fauxText(
            JSON.stringify({
              affectionChanges: [{ characterId: 'char_alicia', delta: 0 }],
              innerThoughts: [{ characterId: 'char_alicia', thought: '这个外乡人至少知道分寸。' }],
              roomChanges: ['短剑被放回了桌上'],
              itemTransfers: [],
              newMemoryCards: [],
            }),
          ),
        ]),
      ],
    });
  });

  it('刚性时序：路由→组装→演员，正文流式产出，后台结算更新世界状态', async () => {
    const faux = getFauxModels();
    const { router, actor, evaluator } = faux;

    let streamed = '';
    const result = await runTurn(
      {
        worldId: 'demo_world',
        models: getFauxModelsCollection(),
        routerModel: router,
        actorModel: actor,
        evaluatorModel: evaluator,
        store,
        onDelta: (d) => {
          streamed += d;
        },
        settle: true,
      },
      index,
      '你们这儿，跟铁匠安德鲁是不是有过节？',
    );

    // 阶段 1：抽卡清单
    expect(result.decision.characterCardIds).toContain('char_alicia');
    expect(result.decision.memoryCardIds).toContain('mem_andrew_fallout');
    expect(result.decision.speakerCharacterId).toBe('char_alicia');

    // 阶段 2：< 900 token
    expect(result.assembled.tokenEstimate).toBeLessThan(900);

    // 阶段 3：流式正文完整
    expect(streamed.length).toBeGreaterThan(0);
    expect(result.reply).toBe(streamed);

    // 阶段 4：等后台结算落盘（faux 限速流式，轮询直到好感度变化）
    let affection = 60;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const c = await store.getCard('char_alicia');
      if (c?.kind === 'character') {
        affection = (c.data as { state: { affection: number } }).state.affection;
        if (affection === 59) break;
      }
    }
    const alicia = await store.getCard('char_alicia');
    expect(alicia?.kind).toBe('character');
    const d = alicia!.data as { state: { affection: number; innerThought: string } };
    expect(d.state.affection).toBe(59); // 60 + (-1)
    expect(d.state.innerThought).toContain('安德鲁');

    // 世界指针推进
    const state = await store.getWorldState('demo_world');
    expect(state?.turn).toBe(2);
  });

  it('滑动历史：玩家输入与 NPC 回话都被固化', async () => {
    const history = await store.recentHistory('demo_world', 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const texts = history.map((h) => h.text).join(' ');
    expect(texts).toContain('安德鲁');
    expect(texts).toContain('柜台');
  });

  it('M13-5：路由输出 "null" 字符串场景卡 → 归一为 null（不误判换场）', async () => {
    const { sanitizeRouteDecision } = await import('../src/stages/pre-router.js');
    const input = {
      characters: [{ id: 'char_alicia', name: '艾莉西亚', role: 'x' }],
      memories: [], items: [],
      state: { turn: 2, currentSceneId: 'scene_inn', presentCharacterIds: ['char_alicia'] },
    } as never;
    const raw = {
      sceneCardId: 'null' as string | null, // 模型把 null 输出成字符串
      characterCardIds: ['char_alicia'], speakerCharacterId: 'char_alicia',
      memoryCardIds: [], itemCardIds: [], historyWindow: 6, turn: 2,
    };
    const d = sanitizeRouteDecision(raw as never, input);
    expect(d.sceneCardId).toBeNull();
    // 真实场景 id 透传不受影响
    const d2 = sanitizeRouteDecision({ ...raw, sceneCardId: 'scene_smithy' } as never, input);
    expect(d2.sceneCardId).toBe('scene_smithy');
  });

  it('M14/M15：路由提示词分层 = System导演层 + 世界库(常驻全量/档案总览) + 剧情视图', async () => {
    const { buildRouterContext } = await import('../src/stages/pre-router.js');
    const ctx = buildRouterContext({
      worldId: 'w1',
      state: { currentSceneId: 'scene_a', presentCharacterIds: ['c1'], playerInventory: [], turn: 45, updatedAt: Date.now() } as never,
      userMessage: '测试', currentScene: { id: 'scene_a', data: { presentCharacterIds: ['c1'] } } as never,
      characters: [
        { id: 'c1', name: '主角', role: 'x', constant: true },
        { id: 'c2', name: '路人', role: 'y' },
      ],
      memories: [{ id: 'm1', ownerCharacterId: 'c1', summary: '金针觉醒', keywords: ['金针'], relatedIds: [] }],
      items: [{ id: 'i1', name: '玉佩', description: '安老头信物', location: 'player' }],
      constants: [{ id: 'c1', kind: 'character', name: '主角', text: '主角的完整设定全文。' }],
      recentLines: [{ speaker: 'user', text: '之前说过的事', turn: 44 }],
      layerSummaries: [{ layerFrom: 1, layerTo: 20, detail: '第一章：金针觉醒。' }],
    });
    const sys = ctx.systemPrompt ?? '';
    expect(sys).toContain('【规则】');
    expect(sys).toContain('【工具】');
    expect(sys).toContain('【输出】');
    const content = (ctx.messages?.[0]?.content ?? '') as string;
    // 世界库·常驻设定（全量段）
    expect(content).toContain('【世界库 · 常驻设定（全量，直接使用）】');
    expect(content).toContain('主角的完整设定全文');
    // 世界库·档案总览：非常驻角色声明式 + 触发词
    expect(content).toContain('【世界库 · 档案总览】');
    expect(content).toContain('路人');
    expect(content).toContain('触发词: 金针');
    // 剧情视图：摘要链 + 近N层全文（含玩家输入，无重复尾巴）
    expect(content).toContain('【剧情回顾 · 压缩摘要链】');
    expect(content).toContain('第 1-20 层回顾');
    expect(content).toContain('【近 N 层剧情全文】');
    expect(content).toContain('玩家: 之前说过的事');
    expect(content).not.toContain('玩家现在: 「测试」'); // 不重复贴玩家尾巴
    expect(content).toContain('当前回合号: 45');
  });

  it('M16：路由 System 模板可覆盖（空=默认；自定义文本生效）', async () => {
    const { buildRouterContext } = await import('../src/stages/pre-router.js');
    const base = {
      worldId: 'w1',
      state: { currentSceneId: 'scene_a', presentCharacterIds: [], playerInventory: [], turn: 2, updatedAt: Date.now() } as never,
      userMessage: 'hi', currentScene: { id: 'scene_a', data: { presentCharacterIds: [] } } as never,
      characters: [], memories: [], items: [],
    };
    // 自定义模板
    const ctxA = buildRouterContext({ ...base, routerSystemTemplate: '你是我的自定义导演规则 ABC' } as never);
    expect(ctxA.systemPrompt).toContain('自定义导演规则 ABC');
    // 缺省 → 内置默认（含 规则/工具/输出）
    const ctxB = buildRouterContext(base as never);
    expect(ctxB.systemPrompt).toContain('【规则】');
    expect(ctxB.systemPrompt).toContain('【工具】');
    expect(ctxB.systemPrompt).toContain('【输出】');
  });
});
