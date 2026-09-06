/**
 * 卡片工具：id 生成、名称 slug 化与卡型守卫。
 *
 * 说明：`isSceneCard` / `isCharacterCard` 是「运行时守卫」，与具体的
 * 存储实现无关，放这里而不是 db/store，避免 store ← stages 的循环依赖。
 * `store.ts` 为兼容旧调用点保留了 re-export。
 */
import type { Card, CardKind, CharacterCardData, SceneCardData } from '../types.js';

export function slugifyName(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'card'
  );
}

/** 短随机 id（同一前缀下防碰撞） */
export function uid(len = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** 带时间戳的唯一 id */
export function makeUniqueId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${uid(4)}`;
}

export type CharacterCard = Card & { kind: 'character'; data: CharacterCardData };
export type SceneCard = Card & { kind: 'scene'; data: SceneCardData };

export function isCharacterCard(card: Card): card is CharacterCard {
  return card.kind === 'character' && (card.data as CharacterCardData).state !== undefined;
}

export function isSceneCard(card: Card): card is SceneCard {
  return card.kind === 'scene' && (card.data as SceneCardData).presentCharacterIds !== undefined;
}

/** 判断卡型是否合法（导入/校验用） */
export function isKnownKind(kind: string): kind is CardKind {
  return kind === 'system' || kind === 'scene' || kind === 'character' || kind === 'memory' || kind === 'item' || kind === 'history';
}
