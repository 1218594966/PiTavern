import { describe, it, expect, beforeAll } from 'vitest';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { MemoryCardStore } from '../src/db/store.js';
import { getFauxModels, getFauxModelsCollection } from '../src/config/models.js';
import { seedDemoWorld, runTurn } from '../src/pipeline.js';
import type { WorldIndex, PipelineConfig } from '../src/pipeline.js';
import type { Card } from '../src/types.js';
import type { ChatMeta } from '../src/db/store.js';

/**
 * M1-1 会话情感隔离：
 * 两个会话（chatAId / chatBId）共享同一 demo_world 的静态角色卡，但各自推进
 * 好感度时，情感 overlay 只落在各自 chat.state.npcStates —— 互不串扰，
 * 且共享角色卡上的全局好感保持初值不被会话改动污染。
 *
 * 节奏：每回合跑完 → 等该回合后台结算落盘 → 再发下一回合（模拟真实前台：
 * 结算完成在下一回合之前）。
 */
describe('M1-1 会话情感隔离（npcStates overlay）', () => {
  let store: MemoryCardStore;
  let index: WorldIndex;
  let chatAId: string;
  let chatBId: string;

  const ROUTER_OK = () =>
    fauxAssistantMessage([
      fauxText(JSON.stringify({ sceneCardId: null, characterCardIds: ['char_alicia'], speakerCharacterId: 'char_alicia', memoryCardIds: [], itemCardIds: [], historyWindow: 6, turn: 1 })),
    ]);
  const EVAL = (delta: number, thought: string) =>
    fauxAssistantMessage([
      fauxText(JSON.stringify({ affectionChanges: [{ characterId: 'char_alicia', delta }], innerThoughts: [{ characterId: 'char_alicia', thought }], roomChanges: [], itemTransfers: [], newMemoryCards: [] })),
    ]);

  /** 跑一回合并等待其结算完成（模拟真实节奏）；每回合前重读 chat 最新 state */
  async function turnAndSettle(chatId: string, msg: string): Promise<void> {
    let resolveSettled!: () => void;
    const done = new Promise<void>((r) => (resolveSettled = r));
    const chat = (await store.getChat(chatId))!;
    const fresh = { ...index, state: chat.state };
    await runTurn(
      { worldId: 'demo_world', models: getFauxModelsCollection(), routerModel: getFauxModels().router, actorModel: getFauxModels().actor, evaluatorModel: getFauxModels().evaluator, store, settle: true, chatId, onSettled: () => resolveSettled() },
      fresh,
      msg,
    );
    await done;
  }

  beforeAll(async () => {
    store = new MemoryCardStore();
    index = await seedDemoWorld(store);
    const metaA = await store.createChat('demo_world', '会话 A', index.state);
    const metaB = await store.createChat('demo_world', '会话 B', index.state);
    chatAId = metaA.chatId;
    chatBId = metaB.chatId;

    const faux = getFauxModels();
    faux.setResponses({
      router: [ROUTER_OK(), ROUTER_OK(), ROUTER_OK(), ROUTER_OK()],
      actor: [1, 2, 3, 4].map((i) => fauxAssistantMessage([fauxText(`第 ${i} 次回话。`)])),
      evaluator: [
        EVAL(-3, 'A 讨厌他'), // A 回合1
        EVAL(2, 'B 喜欢他'), // B 回合1
        EVAL(1, 'A 缓和'), // A 回合2
        EVAL(1, 'B 更热络'), // B 回合2
      ],
    });
  });

  it('会话 A/B 各自推进好感度：互不串扰且共享卡保持初值', async () => {
    await turnAndSettle(chatAId, 'A：打个招呼'); // -3
    await turnAndSettle(chatBId, 'B：打个招呼'); // +2
    await turnAndSettle(chatAId, 'A：再聊一句'); // +1
    await turnAndSettle(chatBId, 'B：再聊一句'); // +1

    const chatA = (await store.getChat(chatAId)) as ChatMeta;
    const chatB = (await store.getChat(chatBId)) as ChatMeta;
    const affA = chatA.state.npcStates!['char_alicia']!.affection;
    const affB = chatB.state.npcStates!['char_alicia']!.affection;
    expect(affA).toBe(58); // 60 -3 +1
    expect(affB).toBe(63); // 60 +2 +1
    expect(chatA.state.npcStates!['char_alicia']!.innerThought).toBe('A 缓和');
    expect(chatB.state.npcStates!['char_alicia']!.innerThought).toBe('B 更热络');

    // 共享角色卡全局好感保持初值 60（会话没污染卡片）
    const card = (await store.getCard('char_alicia')) as Card & { data: { state: { affection: number } } };
    expect(card.data.state.affection).toBe(60);
  });
});
