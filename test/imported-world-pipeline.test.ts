import { describe, it, expect, beforeAll } from 'vitest';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { MemoryCardStore } from '../src/db/store.js';
import { importCards } from '../src/cards/importer.js';
import { importWorldToArchive } from '../src/db/archive.js';
import { loadWorldIndex, runTurn } from '../src/pipeline.js';
import { getFauxModels, getFauxModelsCollection } from '../src/config/models.js';
import type { TavernCardV2 } from '../src/cards/schema.js';

const v2Alicia: TavernCardV2 = {
  spec: 'chara_card_v2',
  data: {
    name: '艾莉西亚',
    description: '灰烬镇旅馆老板，左眉一道旧疤。',
    personality: '嘴硬心软',
    scenario: '深夜暴雨',
    first_mes: '外乡人，雨这么大还赶路？',
    mes_example: '',
    character_book: {
      entries: [{ keys: ['安德鲁'], content: '三年前安德鲁卷走货款，艾莉西亚提起来就冷笑。', enabled: true, insertion_order: 1 }],
    },
    extensions: {
      pitavern: {
        speechStyle: '短句带刺',
        scenes: [{ id: 'scene_inn', name: '旅馆', description: '炉火噼啪，麦酒桶沿墙排开。', presentCharacterIds: ['艾莉西亚'] }],
      },
    },
  },
};

describe('P4：导入世界档案跑流水线', () => {
  let store: MemoryCardStore;
  let worldId: string;
  let mainCharId: string;

  beforeAll(async () => {
    store = new MemoryCardStore();
    const imported = await importCards(v2Alicia);
    const r = await importWorldToArchive(store, imported.cards, '灰烬镇');
    worldId = r.worldId;
    mainCharId = r.mainCharacterId!;

    const faux = getFauxModels();
    faux.setResponses({
      router: fauxAssistantMessage([
        fauxText(JSON.stringify({
          sceneCardId: null,
          characterCardIds: [mainCharId],
          speakerCharacterId: mainCharId,
          memoryCardIds: [],
          itemCardIds: [],
          historyWindow: 6,
          turn: 1,
        })),
      ]),
      actor: fauxAssistantMessage([fauxText('艾莉西亚抬眼看了看你：「外乡人，深夜来旅馆，不是躲雨就是惹了麻烦。」')]),
      evaluator: fauxAssistantMessage([
        fauxText(JSON.stringify({
          affectionChanges: [{ characterId: mainCharId, delta: 1 }],
          innerThoughts: [{ characterId: mainCharId, thought: '这人看着不像坏人。' }],
          roomChanges: [],
          itemTransfers: [],
          newMemoryCards: [],
        })),
      ]),
    });
  });

  it('从 store 加载索引 → 完整跑一回合 → 好感度写回', async () => {
    const faux = getFauxModels();
    const index = await loadWorldIndex(store, worldId);
    expect(index.characters.some((c) => c.id === mainCharId)).toBe(true);
    expect(index.memories.length).toBe(1);

    const result = await runTurn(
      {
        worldId,
        models: getFauxModelsCollection(),
        routerModel: faux.router,
        actorModel: faux.actor,
        evaluatorModel: faux.evaluator,
        store,
        settle: true,
      },
      index,
      '你们这儿，跟铁匠安德鲁是不是有过节？',
    );

    expect(result.reply).toContain('旅馆');
    expect(result.assembled.prompt).toContain('艾莉西亚');
    expect(result.decision.characterCardIds).toContain(mainCharId);

    // 等后台结算写回好感度 50 → 51（faux 限速流式，轮询直到变化）
    let affection = 50;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const c = await store.getCard(mainCharId);
      if (c?.kind === 'character') {
        affection = (c.data as { state: { affection: number } }).state.affection;
        if (affection === 51) break;
      }
    }
    const char = await store.getCard(mainCharId);
    const d = char!.data as { state: { affection: number } };
    expect(d.state.affection).toBe(51);
  });
});
