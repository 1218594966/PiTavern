import { describe, it, expect } from 'vitest';
import { MemoryCardStore } from '../src/db/store.js';
import { importCards } from '../src/cards/importer.js';
import { importWorldToArchive, getWorldGreeting, toTavernV2 } from '../src/db/archive.js';
import type { TavernCardV2 } from '../src/cards/schema.js';

const v2Alicia: TavernCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾莉西亚',
    description: '灰烬镇旅馆老板，左眉一道旧疤。',
    personality: '嘴硬心软，警惕生人',
    scenario: '深夜暴雨',
    first_mes: '外乡人，雨这么大还赶路？',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 来杯麦酒？',
    alternate_greetings: ['另一种开场。', '还有一段。'],
    system_prompt: '{{original}} 额外规则',
    post_history_instructions: '结尾别问问题。',
    creator_notes: '作者备注',
    creator: '测试作者',
    character_version: '1.2.3',
    tags: ['旅馆', '悬疑'],
    character_book: {
      entries: [
        { keys: ['安德鲁'], content: '三年前安德鲁卷走货款，艾莉西亚提起来就冷笑。', enabled: true, insertion_order: 1 },
      ],
    },
    extensions: {
      pitavern: {
        speechStyle: '短句带刺',
        scenes: [
          {
            id: 'scene_inn',
            name: '麋鹿与铁砧旅馆',
            description: '炉火噼啪，麦酒桶沿墙排开。',
            presentCharacterIds: ['艾莉西亚'],
          },
        ],
      },
    },
  },
};

describe('卡档案库 importWorldToArchive', () => {
  it('导入 V2 卡 → 生成世界档案（角色/场景/记忆/好感度初值/场景引用解析）', async () => {
    const store = new MemoryCardStore();
    const imported = await importCards(v2Alicia);
    const result = await importWorldToArchive(store, imported.cards, '灰烬镇');

    expect(result.worldId).toBe('world_灰烬镇');
    expect(result.counts.character).toBe(1);
    expect(result.counts.scene).toBe(1);
    expect(result.counts.memory).toBe(1);

    // 角色卡落盘且带动态状态
    const charId = result.mainCharacterId!;
    const char = await store.getCard(charId);
    expect(char?.kind).toBe('character');
    const cd = char!.data as { name: string; speechStyle: string; openingLine: string; state: { affection: number } };
    expect(cd.name).toBe('艾莉西亚');
    expect(cd.speechStyle).toBe('短句带刺');
    expect(cd.openingLine).toContain('雨这么大');
    expect(cd.state.affection).toBe(50); // 初始好感度

    // 场景卡在场角色已被解析成角色 id
    const scenes = await store.listWorldCards(result.worldId);
    const sceneId = scenes.find((id) => id.startsWith('scene_'))!;
    const scene = await store.getCard(sceneId);
    const sd = scene!.data as { name: string; presentCharacterIds: string[] };
    expect(sd.name).toBe('麋鹿与铁砧旅馆');
    expect(sd.presentCharacterIds).toContain(charId); // 名字 → id 解析成功

    // 记忆卡可检索
    const worldCards = await store.listWorldCards(result.worldId);
    const memId = worldCards.find((id) => id.startsWith('mem_'))!;
    const mem = await store.getCard(memId);
    expect(mem?.kind).toBe('memory');
    const md = mem!.data as { keywords: string[] };
    expect(md.keywords).toContain('安德鲁');

    // 世界状态初始化到首个有角色的场景
    const ws = await store.getWorldState(result.worldId);
    expect(ws?.currentSceneId).toBe(sceneId);
    expect(ws?.presentCharacterIds).toContain(charId);
  });

  it('重复导入同世界幂等（不产生重复世界，卡被覆盖更新）', async () => {
    const store = new MemoryCardStore();
    const imported = await importCards(v2Alicia);
    await importWorldToArchive(store, imported.cards, '灰烬镇');
    await importWorldToArchive(store, imported.cards, '灰烬镇');

    const worlds = await store.listWorlds();
    expect(worlds).toEqual(['world_灰烬镇']);
  });
});

describe('getWorldGreeting（M1-2 开场白）', () => {
  it('导入卡带 first_mes → 返回主角开场白', async () => {
    const store = new MemoryCardStore();
    const imported = await importCards(v2Alicia);
    const r = await importWorldToArchive(store, imported.cards, '灰烬镇');
    const g = await getWorldGreeting(store, r.worldId);
    expect(g).not.toBeNull();
    expect(g!.text).toContain('雨这么大');
    expect(g!.characterId).toBe(r.mainCharacterId);
  });

  it('无 openingLine/first_mes 的世界 → null（不注入空开场白）', async () => {
    const store = new MemoryCardStore();
    // demo 世界角色卡现在带 openingLine，这里用一个不带 greeting 的裸卡世界
    const bare: TavernCardV2 = {
      spec: 'chara_card_v2',
      data: { name: '无言者', description: '沉默的角色。', personality: '', scenario: '', first_mes: '', mes_example: '' },
    };
    const imported = await importCards(bare);
    const r = await importWorldToArchive(store, imported.cards, '沉默世界');
    const g = await getWorldGreeting(store, r.worldId);
    expect(g).toBeNull();
  });

  it('M1-4/M3-2 toTavernV2：内部角色卡 round-trip 回标准 V2 JSON（含元数据）', async () => {
    const store = new MemoryCardStore();
    const imported = await importCards(v2Alicia);
    const r = await importWorldToArchive(store, imported.cards, '灰烬镇');
    const charId = r.mainCharacterId!;
    const card = (await store.getCard(charId))!;
    const v2 = toTavernV2(card);

    expect(v2.spec).toBe('chara_card_v2');
    const d = v2.data as Record<string, unknown>;
    expect(d.name).toBe('艾莉西亚');
    expect(d.first_mes).toContain('雨这么大'); // openingLine ← first_mes round-trip
    expect(d.personality).toBe('嘴硬心软，警惕生人'); // M4-2：分字段精确往返
    expect(d.scenario).toBe('深夜暴雨');
    expect(d.description).toBe('灰烬镇旅馆老板，左眉一道旧疤。');
    expect((d.extensions as Record<string, unknown>).pitavern).toBeTruthy();
    // M3-2：V2 元数据精确往返
    expect(d.mes_example).toContain('{{char}}');
    expect(d.alternate_greetings).toEqual(['另一种开场。', '还有一段。']);
    expect(d.system_prompt).toContain('额外规则');
    expect(d.post_history_instructions).toContain('结尾别问问题');
    expect(d.creator_notes).toBe('作者备注');
    expect(d.creator).toBe('测试作者');
    expect(d.character_version).toBe('1.2.3');
    expect(d.tags).toEqual(['旅馆', '悬疑']);
    // 导出的 V2 能被导入器再识别（双向闭环）
    const reimported = await importCards(v2);
    const rc = reimported.cards.find((c) => c.name === '艾莉西亚');
    expect(rc).toBeTruthy();
    expect(rc!.alternateGreetings).toEqual(['另一种开场。', '还有一段。']);
    expect(rc!.creatorNotes).toBe('作者备注');
    expect(rc!.systemPrompt).toContain('额外规则');
  });

  it('M10：物品所有者 ownerCharacterId round-trip（导入 → 内部卡）', async () => {
    const imported = await importCards({
      schema: 'pitavern-world/v1',
      world: { id: 'world_t', name: '测试镇', rules: [] },
      characters: [],
      items: [
        { id: 'item_sword', name: '旧剑', description: '锈迹斑斑。', ownerCharacterId: 'char_艾莉西亚' },
        { id: 'item_stone', name: '石子', description: '路边普通石子。' },
      ],
    });
    const store = new MemoryCardStore();
    await importWorldToArchive(store, imported.cards, '测试镇');
    const c1 = await store.getCard('item_sword');
    expect((c1!.data as { ownerCharacterId?: string }).ownerCharacterId).toBe('char_艾莉西亚');
    const c2 = await store.getCard('item_stone');
    expect((c2!.data as { ownerCharacterId?: string }).ownerCharacterId).toBeUndefined();
  });
});
