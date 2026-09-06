import { describe, it, expect, beforeAll } from 'vitest';
import { MemoryCardStore } from '../src/db/store.js';
import { assembleCards, renderCard } from '../src/stages/assembler.js';
import { seedDemoWorld } from '../src/pipeline.js';
import type { WorldIndex } from '../src/pipeline.js';
import type { Card, RouteDecision } from '../src/types.js';

describe('阶段 2：JIT 卡片组装器', () => {
  let store: MemoryCardStore;
  let index: WorldIndex;

  beforeAll(async () => {
    store = new MemoryCardStore();
    index = await seedDemoWorld(store);
  });

  it('四插槽齐备：系统法则 / 现场快照 / 便利贴 / 视线窗口，总量 < 900 token', async () => {
    const route: RouteDecision = {
      sceneCardId: null, // 沿用当前场景
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: ['mem_andrew_fallout'], // 撕下安德鲁关系便利贴
      itemCardIds: ['item_dagger'],
      historyWindow: 6,
      turn: 1,
      systemCardId: 'sys_001',
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '把桌上的短剑拿起来。',
        history: [
          { speaker: 'user', text: '你们这儿跟铁匠安德鲁是不是有过节？', turn: 0 },
          { speaker: '艾莉西亚', text: '「那笔货款够他烧三年了。」', turn: 0 },
        ],
      },
      store,
    );

    expect(assembled.tokenEstimate).toBeLessThan(900);
    expect(assembled.prompt).toContain('世界法则'); // 插槽 1
    expect(assembled.prompt).toContain('场景 · 麋鹿与铁砧旅馆'); // 插槽 2
    expect(assembled.prompt).toContain('艾莉西亚'); // 插槽 2 角色
    expect(assembled.prompt).toContain('安德鲁'); // 插槽 3 便利贴
    expect(assembled.prompt).toContain('带血的短剑'); // 插槽 3 物品
    expect(assembled.prompt).toContain('最近对话'); // 插槽 4
    expect(assembled.slots.snapshot).toEqual(['scene_inn', 'char_alicia']);
    expect(assembled.slots.stickyNotes).toContain('mem_andrew_fallout');
    expect(assembled.slots.stickyNotes).toContain('item_dagger');
  });

  it('没有提到场外旧事时，插槽 3 为 0 Token（便利贴空）', async () => {
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 6,
      turn: 2,
      systemCardId: 'sys_001',
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '来一杯麦酒。',
        history: [],
      },
      store,
    );

    expect(assembled.slots.stickyNotes).toEqual([]);
    expect(assembled.prompt).not.toContain('临时外挂知识');
    expect(assembled.prompt).not.toContain('安德鲁');
    expect(assembled.prompt).not.toContain('带血的短剑');
  });

  it('换场景：sceneCardId 指向新房间时，快照换成新场景卡', async () => {
    const route: RouteDecision = {
      sceneCardId: 'scene_smithy',
      characterCardIds: [],
      speakerCharacterId: null,
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 6,
      turn: 3,
      systemCardId: 'sys_001',
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '推门跑向二楼的铁匠铺。',
        history: [],
      },
      store,
    );

    expect(assembled.prompt).toContain('安德鲁的铁匠铺');
    expect(assembled.prompt).not.toContain('麋鹿与铁砧旅馆');
    expect(assembled.slots.snapshot).toEqual(['scene_smithy']);
  });

  it('M5：OOC 场外行进视线窗口并标注（OOC），普通行不受影响', async () => {
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 6,
      turn: 4,
      systemCardId: 'sys_001',
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '（推门走进来）老板在吗？',
        history: [
          { speaker: 'user', text: '有人吗？', turn: 3 },
          { speaker: '艾莉西亚', text: '来了来了。', turn: 3 },
          { speaker: 'ooc', text: '我五分钟回来', turn: 3 },
        ],
      },
      store,
    );
    expect(assembled.prompt).toContain('（OOC）我五分钟回来'); // 标注但仍可见
    expect(assembled.prompt).toContain('来了来了'); // 正常行不受影响
  });

  it('M6：renderCard 卡正文宏展开（{{user}}/{{char}}），无 ctx 时行为不变', () => {
    const char: Card = {
      id: 'char_x',
      kind: 'character',
      data: {
        name: '薇拉',
        role: '老板娘',
        description: '她是{{user}}的老朋友，{{char}}从不记账。',
        personality: '豪爽',
        speechStyle: '嗓门大',
        state: { affection: 50, innerThought: '', roomChanges: [] },
      },
    };
    // 无 ctx：{{user}} → <user> 兜底；{{char}} → 自身名（角色卡）
    const plain = renderCard(char);
    expect(plain).toContain('<user>');
    expect(plain).toContain('薇拉从不记账');
    // 有 userName：{{user}} 替换为 persona 名
    const withUser = renderCard(char, { userName: '旅人阿飞' });
    expect(withUser).toContain('旅人阿飞的老朋友');
    expect(withUser).not.toContain('{{user}}');
    // 非角色卡 {{char}} 用 ctx.charName（场景卡指向主讲），{{user}} 也可展开
    const scene: Card = { id: 'scene_x', kind: 'scene', data: { name: '酒馆', description: '{{char}}在柜台后擦杯子，对{{user}}点头。', presentCharacterIds: [], itemIds: [], recentChanges: [] } };
    expect(renderCard(scene, { charName: '薇拉', userName: '阿飞' })).toContain('薇拉在柜台后');
    expect(renderCard(scene, { charName: '薇拉', userName: '阿飞' })).toContain('对阿飞点头');
    expect(renderCard(scene, { charName: '薇拉', userName: '阿飞' })).not.toContain('{{char}}');
    expect(renderCard(scene, { charName: '薇拉', userName: '阿飞' })).not.toContain('{{user}}');
  });

  it('M6：assembleCards 传入 userName 时卡正文里的 {{user}} 展开', async () => {
    const store2 = new MemoryCardStore();
    await store2.putCard({
      id: 'sys_macro',
      kind: 'system',
      data: { world: '宏测试', rules: ['称呼{{user}}要恭敬。'] },
    });
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 2,
      turn: 5,
      systemCardId: 'sys_macro',
    };
    const withUser = await assembleCards(
      { worldId: 'demo_world', state: index.state, route, userMessage: '你好', history: [], userName: '阿飞' },
      store2,
    );
    expect(withUser.prompt).toContain('称呼阿飞要恭敬');
    const noUser = await assembleCards(
      { worldId: 'demo_world', state: index.state, route, userMessage: '你好', history: [] },
      store2,
    );
    expect(noUser.prompt).toContain('称呼<user>要恭敬');
  });

  it('M6：excluded（出戏）历史行不进插槽 4，普通行不受影响', async () => {
    const store2 = new MemoryCardStore();
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 6,
      turn: 6,
      systemCardId: null,
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '继续。',
        history: [
          { speaker: 'user', text: '这句出戏，别让模型看到。', turn: 5, excluded: true },
          { speaker: '艾莉西亚', text: '这句正常。', turn: 5 },
          { speaker: 'user', text: '这句也出戏。', turn: 5, excluded: true },
        ],
      },
      store2,
    );
    expect(assembled.prompt).not.toContain('别让模型看到');
    expect(assembled.prompt).not.toContain('这句也出戏');
    expect(assembled.prompt).toContain('这句正常');
  });

  it('M10-P2A/P1B：常驻记忆段 + 玩家身份段注入组装提示词', async () => {
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'],
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [],
      itemCardIds: [],
      historyWindow: 6,
      turn: 1,
      systemCardId: 'sys_001',
    };
    const assembled = await assembleCards(
      {
        worldId: 'demo_world',
        state: index.state,
        route,
        userMessage: '帮我拿杯酒。',
        history: [],
        // M11：常驻卡全集（mclass 分节）
        constantCards: [
          { id: 'mem_world1', kind: 'memory', constant: true, data: { ownerCharacterId: 'w', summary: '浮城世界观', detail: '浮城，环状扩张型都市，黑道势力盘踞。', keywords: [], relatedIds: [], mclass: 'worldview' }, keywords: [] },
          { id: 'mem_main1', kind: 'memory', constant: true, data: { ownerCharacterId: 'w', summary: '主线大纲', detail: '金针觉醒后从差生逆袭。', keywords: [], relatedIds: [], mclass: 'plot' }, keywords: [] },
        ],
        // M10-P1B：玩家角色卡
        playerCard: {
          id: 'char_player1', kind: 'character', keywords: [],
          data: { name: '玩家·范伟', role: '玩家', description: '16 岁少年，单亲家庭', personality: '', speechStyle: '', isPlayer: true },
        } as never,
      },
      store,
    );
    expect(assembled.prompt).toContain('世界观设定 · 常驻');
    expect(assembled.prompt).toContain('主线剧情大纲 · 常驻');
    expect(assembled.prompt).toContain('浮城世界观');
    expect(assembled.prompt).toContain('浮城，环状扩张型都市');
    expect(assembled.prompt).toContain('玩家身份');
    expect(assembled.prompt).toContain('玩家·范伟');
    expect(assembled.prompt).toContain('16 岁少年');
  });

  it('M14：常驻角色 → 主要人物节注入设定；快照不重复贴', async () => {
    const route: RouteDecision = {
      sceneCardId: null,
      characterCardIds: ['char_alicia'], // 路由点名（在场）
      speakerCharacterId: 'char_alicia',
      memoryCardIds: [], itemCardIds: [],
      historyWindow: 6, turn: 1, systemCardId: 'sys_001',
    };
    const constChar: Card = {
      id: 'char_alicia', kind: 'character', constant: true, keywords: [],
      data: { name: '艾莉西亚', role: '老板娘', description: '灰烬镇旅馆老板，左眉一道旧疤。嘴硬心软。', personality: '', speechStyle: '短句', openingLine: '外乡人？', state: { affection: 50, innerThought: '', roomChanges: [], updatedAtTurn: 0 } },
    } as never;
    const assembled = await assembleCards(
      {
        worldId: 'demo_world', state: index.state, route,
        userMessage: '把酒端来。', history: [],
        constantCards: [constChar],
      },
      store,
    );
    expect(assembled.prompt).toContain('主要人物 · 常驻');
    expect(assembled.prompt).toContain('灰烬镇旅馆老板');   // 常驻区全量注入
    // 快照不重复：艾莉西亚卡只出现一次全卡渲染（常驻区那份），无二次快照
    const occ = assembled.prompt.split('灰烬镇旅馆老板').length - 1;
    expect(occ).toBe(1);
  });
});
