/**
 * 卡档案库（Archive）：把导入器拆出的 ImportedCard 转成内部 Card，
 * 按世界登记落盘，并解析"场景在场角色"等跨卡引用。
 *
 * 每张导入卡 = 一个持久化档案：
 *   - 静态部分（人格/描述）→ card:{id}（store）
 *   - 动态部分（好感度/记忆）→ 挂在角色卡 data.state + 世界记忆卡
 *
 * 使用流程：
 *   const archive = new CardArchive(store);
 *   const result = await archive.importWorld(importedCards, { worldName: '灰烬镇' });
 *   // 之后就能用 result.worldId 跑流水线
 */
import type { Card, CardKind, SceneCardData } from '../types.js';
import type { CardStore, WorldState } from './store.js';
import type { ImportedCard } from '../cards/schema.js';
import { slugifyName, uid } from '../cards/util.js';

export interface ImportWorldResult {
  worldId: string;
  cards: Card[];
  /** 拆出的主角（第一张角色卡），供前端"选卡开玩" */
  mainCharacterId: string | null;
  counts: { system: number; scene: number; character: number; memory: number; item: number };
}

/** 把 ImportedCard 转成内部 Card（含默认动态状态） */
export function toInternalCard(imported: ImportedCard, worldId: string): Card {
  const base = { updatedAt: Date.now() };
  switch (imported.kind) {
    case 'system': {
      return {
        id: imported.id.startsWith('sys_') ? imported.id : `sys_${slugifyName(imported.id)}`,
        kind: 'system',
        data: { world: imported.name, rules: imported.body.split('\n').filter(Boolean) },
        keywords: imported.keys,
        ...base,
      };
    }
    case 'scene': {
      return {
        id: imported.id.startsWith('scene_') ? imported.id : `scene_${slugifyName(imported.id)}_${uid(4)}`,
        kind: 'scene',
        data: {
          name: imported.name,
          description: imported.body,
          // 在场角色先用名字占位，importWorld 里二次解析成 id
          presentCharacterIds: [],
          itemIds: [],
          recentChanges: [],
          _pendingPresentNames: imported.presentCharacterNames ?? [],
        },
        keywords: imported.keys,
        ...base,
      };
    }
    case 'character': {
      return {
        id: imported.id.startsWith('char_') ? imported.id : `char_${slugifyName(imported.id)}`,
        kind: 'character',
        data: {
          name: imported.name,
          role: imported.player ? '玩家' : '角色',
          description: imported.body,
          personality: imported.personality ?? imported.body,
          scenario: imported.scenario,
          speechStyle: imported.speechStyle ?? '',
          openingLine: imported.openingLine ?? '',
          avatar: imported.avatar ?? undefined,
          // M10-P1B：玩家角色卡标记（不进路由抽卡池；组装注「玩家身份」段）
          ...(imported.player ? { isPlayer: true } : {}),
          // M11：常驻角色（作者标 constant 的人物志——始终该知道其设定）
          ...(imported.player ? {} : imported.constant ? { } : {}),
          // V2 元数据 round-trip
          mesExample: imported.mesExample,
          alternateGreetings: imported.alternateGreetings,
          systemPrompt: imported.systemPrompt,
          postHistoryInstructions: imported.postHistoryInstructions,
          creatorNotes: imported.creatorNotes,
          creator: imported.creator,
          characterVersion: imported.characterVersion,
          tags: imported.tags,
          state: {
            affection: 50,
            innerThought: '初次见面，保持观察。',
            roomChanges: [],
            updatedAtTurn: 0,
          },
        },
        keywords: imported.keys,
        // M11：常驻角色（作者标 constant 的人物志——始终该知道其设定）
        ...(imported.constant ? { constant: true } : {}),
        ...base,
      };
    }
    case 'memory': {
      return {
        id: imported.id.startsWith('mem_') ? imported.id : `mem_${slugifyName(imported.id)}_${uid(4)}`,
        kind: 'memory',
        data: {
          ownerCharacterId: worldId,
          summary: imported.name,
          detail: imported.body,
          relatedIds: [],
          keywords: imported.keys ?? [imported.name],
          // M11：记忆小类透传
          ...(imported.mclass ? { mclass: imported.mclass } : {}),
        },
        // M11：常驻开关在 Card 顶层
        ...(imported.constant ? { constant: true } : {}),
        ...base,
      };
    }
    case 'item': {
      return {
        id: imported.id.startsWith('item_') ? imported.id : `item_${slugifyName(imported.id)}`,
        kind: 'item',
        data: {
          name: imported.name,
          description: imported.body,
          location: 'scene',
          locationId: undefined,
          // M10：物品所有者透传（缺省无主；前端可改成某角色所有）
          ...(imported.ownerCharacterId ? { ownerCharacterId: imported.ownerCharacterId } : {}),
        },
        keywords: imported.keys,
        ...base,
      };
    }
    default: {
      const k = imported.kind;
      throw new Error(`未知卡型: ${String(k)}`);
    }
  }
}

/**
 * 把一组导入卡注册成一个世界档案。
 * 幂等：同名卡（同 id）重复导入会覆盖更新，不会产生重复世界。
 */
export async function importWorldToArchive(
  store: CardStore,
  imported: ImportedCard[],
  worldName: string,
  opts: { worldGreeting?: { speaker: string; text: string } } = {},
): Promise<ImportWorldResult> {
  const worldId = `world_${slugifyName(worldName)}`;
  const cards: Card[] = [];
  const nameToCharId = new Map<string, string>();
  const pendingScenes: Card[] = [];

  for (const imp of imported) {
    const card = toInternalCard(imp, worldId);
    cards.push(card);

    if (card.kind === 'character') {
      nameToCharId.set(imp.name, card.id);
      // 世界归属：登记该卡
      await store.addCardToWorld(worldId, card.id);
    } else if (card.kind === 'scene') {
      pendingScenes.push(card);
    } else {
      await store.addCardToWorld(worldId, card.id);
    }
  }

  // 第二遍：场景的在场角色名 → id 解析
  // 若场景没声明在场角色，默认放全部角色（创作者省略时也能直接玩）
  const allCharIds = cards.filter((c) => c.kind === 'character').map((c) => c.id);
  for (const scene of pendingScenes) {
    const d = scene.data as SceneCardData & { _pendingPresentNames?: string[] };
    const names = d._pendingPresentNames ?? [];
    delete (d as SceneCardData & { _pendingPresentNames?: string[] })._pendingPresentNames;
    const resolved = names.map((n) => nameToCharId.get(n) ?? n).filter(Boolean) as string[];
    d.presentCharacterIds = resolved.length > 0 ? resolved : allCharIds;
    await store.addCardToWorld(worldId, scene.id);
  }

  // 全部落盘
  for (const c of cards) await store.putCard(c);

  // 初始化世界状态（首场景 = 第一个有角色的场景 或 第一个场景）
  const worldState: WorldState = await store.getWorldState(worldId) ?? {
    currentSceneId: '',
    presentCharacterIds: [],
    playerInventory: [],
    turn: 1,
    updatedAt: Date.now(),
  };
  const scenes = cards.filter((c) => c.kind === 'scene') as Card[];
  const firstScene = scenes.find((s) => (s.data as { presentCharacterIds: string[] }).presentCharacterIds.length > 0) ?? scenes[0];
  if (firstScene && !worldState.currentSceneId) {
    worldState.currentSceneId = firstScene.id;
    worldState.presentCharacterIds = (firstScene.data as { presentCharacterIds: string[] }).presentCharacterIds;
  }
  // M12：世界级开场白（导入的空壳群像包 first_mes 归此）
  if (opts.worldGreeting?.text) worldState.greeting = { speaker: opts.worldGreeting.speaker, text: opts.worldGreeting.text };
  await store.putWorldState(worldId, worldState);

  const counts = {
    system: cards.filter((c) => c.kind === 'system').length,
    scene: cards.filter((c) => c.kind === 'scene').length,
    character: cards.filter((c) => c.kind === 'character').length,
    memory: cards.filter((c) => c.kind === 'memory').length,
    item: cards.filter((c) => c.kind === 'item').length,
  };

  return {
    worldId,
    cards,
    mainCharacterId: cards.find((c) => c.kind === 'character')?.id ?? null,
    counts,
  };
}

/**
 * 取世界的「开场白」（greeting）：优先第一张带 openingLine 的角色卡。
 * 用于新会话自动插入首条 NPC 消息，让玩家开局不空白。
 * @returns 无开场白返回 null
 */
export async function getWorldGreeting(
  store: CardStore,
  worldId: string,
): Promise<{ speaker: string; characterId?: string; text: string } | null> {
  // M12：世界级开场白优先（群像包/无主体角色的卡）
  const ws = await store.getWorldState(worldId);
  const wg = ws?.greeting;
  if (wg?.text) return { speaker: wg.speaker || worldId.replace(/^world_|^demo_/, ''), text: wg.text };
  const ids = await store.listWorldCards(worldId);
  const cards = (await store.getCards(ids)).filter((c): c is Card => c !== null);
  for (const card of cards) {
    if (card.kind !== 'character') continue;
    const d = card.data as { name: string; openingLine?: string };
    const line = (d.openingLine ?? '').trim();
    if (line) return { speaker: d.name, characterId: card.id, text: line };
  }
  return null;
}

/**
 * 把内部角色卡转回 SillyTavern V2 JSON（round-trip 导出）。
 * 只导出标准字段（name/description/personality/scenario/first_mes/mes_example）
 * 与 PiTavern 扩展字段（speechStyle/openingLine）；未知扩展原数据未存，不伪造。
 * avatar 为 dataURL 时作为 PNG 载荷提示返回（JSON 卡不含图像本体）。
 */
export function toTavernV2(card: Card): { spec: 'chara_card_v2'; spec_version: string; data: Record<string, unknown> } {
  const d = card.data as {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    speechStyle?: string;
    openingLine?: string;
    avatar?: string;
    role?: string;
    mesExample?: string;
    alternateGreetings?: string[];
    systemPrompt?: string;
    postHistoryInstructions?: string;
    creatorNotes?: string;
    creator?: string;
    characterVersion?: string;
    tags?: string[];
  };
  const pitavern: Record<string, unknown> = {
    kind: 'character',
    speechStyle: d.speechStyle ?? '',
  };
  const data: Record<string, unknown> = {
    name: d.name,
    description: d.description ?? '',
    personality: d.personality ?? '',
    scenario: d.scenario ?? '',
    first_mes: d.openingLine ?? '',
    mes_example: d.mesExample ?? '',
    alternate_greetings: d.alternateGreetings ?? [],
    creator_notes: d.creatorNotes ?? '',
    system_prompt: d.systemPrompt ?? '',
    post_history_instructions: d.postHistoryInstructions ?? '',
    tags: d.tags ?? [],
    creator: d.creator ?? '',
    character_version: d.characterVersion ?? '',
    extensions: {
      pitavern,
      ...(d.avatar ? { avatar: d.avatar } : {}),
    },
  };
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

