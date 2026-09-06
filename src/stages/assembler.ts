/**
 * 阶段 2：JIT 卡片动态组装器（Context Assembler）——「乐高积木拼装台」。
 *
 * 纯代码、零 AI、内存直读 Redis。拿到阶段 1 的抽卡清单后，
 * 把卡片插进 4 个固定插槽，拍平成一份永远 < 900 Token 的精炼小纸条。
 *
 *   插槽 1 固定底座   系统法则卡（焊死在最顶上）
 *   插槽 2 现场快照   场景卡 + 在场角色卡（带当前心理状态）
 *   插槽 3 便利贴     记忆切片 / 物品卡（没提到就 0 Token）
 *   插槽 4 视线窗口   最近 2~3 楼真实对白 + 玩家最新输入
 */
import type { Card, CharacterCardData, HistoryLine, RouteDecision } from '../types.js';
import type { CardStore, WorldState } from '../db/store.js';
import { estimateTokens, truncateHeadToBudget } from '../utils/tokens.js';
import { expandMacros } from '../utils/macros.js';
import type { MacroContext } from '../utils/macros.js';

/** 渲染宏上下文（卡正文里的 {{user}}/{{char}} 展开用） */
export interface RenderCtx extends MacroContext {
  /** 当前卡自身的名字（角色卡 {{char}} 展开为自身） */
  selfName?: string;
}

export interface AssemblerInput {
  worldId: string;
  state: WorldState;
  route: RouteDecision;
  /** 玩家刚发的这句话（插槽 4 最新输入） */
  userMessage: string;
  history: HistoryLine[];
  /** 玩家名（卡正文 {{user}} 展开；缺省 <user> 兜底） */
  userName?: string;
  /** M8/M9-2 分层摘要链：按层序（layerFrom 升序）的全量层回顾（isSummary 记忆卡） */
  layerSummaries?: Array<{ layerFrom: number; layerTo: number; detail: string }>;
  /** M10-P1B：玩家角色卡（"我"的完整人设；有则以「玩家身份」段注入） */
  playerCard?: Card;
  /** M11：常驻卡全集（Card.constant=true 的各 kind 卡；世界观/主线/规则/常驻角色…）
   *  按 kind/mclass 分节全量贴入，不靠路由抽卡。system 法则卡不在此列（独立注入）。 */
  constantCards?: Card[];
}

/** 全装配预算：< 900 Token 是硬约束 */
const MAX_PROMPT_TOKENS = 900;
/** 各插槽预算（token），总和不超 MAX_PROMPT_TOKENS */
// M8：从四插槽预算中分出 layer 槽给「分层摘要链」（sums 900 不变）
const SLOT_BUDGETS = { system: 100, snapshot: 330, sticky: 100, layer: 210, history: 160 } as const;
const HISTORY_LIMIT = 6; // 窗口上限（route.historyWindow 不能超过它）

/**
 * 渲染一张卡为文本。ctx 提供宏上下文：
 * - userName：{{user}} → 玩家名（缺省 <user> 兜底）
 * - charName：{{char}} → 目标角色名（角色卡默认自身名）
 * - selfName：当前卡名（character 卡自动当 charName）
 */
export function renderCard(card: Card, ctx: RenderCtx = {}): string {
  const finalCtx: RenderCtx = { ...ctx, charName: ctx.charName ?? ctx.selfName };
  switch (card.kind) {
    case 'system': {
      const d = card.data as { world: string; rules: string[]; timeline?: string[] };
      const parts = [`【世界法则 · ${d.world}】`, ...d.rules];
      if (d.timeline && d.timeline.length > 0) {
        parts.push(`大事记: ${d.timeline.join('；')}`);
      }
      return expandMacros(parts.join('\n'), finalCtx);
    }
    case 'scene': {
      const d = card.data as { name: string; description: string; recentChanges: string[] };
      const changes = d.recentChanges.length > 0 ? `（最近变化: ${d.recentChanges.join('；')}）` : '';
      return expandMacros(`【场景 · ${d.name}】${d.description}${changes}`, finalCtx);
    }
    case 'character': {
      const d = card.data as {
        name: string;
        role: string;
        description: string;
        personality: string;
        scenario?: string;
        speechStyle: string;
        relationships?: Array<{ targetName: string; relation: string; note?: string }>;
        progression?: string[];
        state: { affection: number; innerThought: string };
      };
      const lines = [`【角色 · ${d.name}（${d.role}）】`, d.description];
      // 老数据 personality 曾与 description 同值（拼接期），跳过避免重复
      if (d.personality && d.personality !== d.description) lines.push(`性格: ${d.personality}`);
      if (d.scenario) lines.push(`背景: ${d.scenario}`);
      lines.push(`说话风格: ${d.speechStyle}`);
      // M8 动态人设：关系网 + 成长档案
      if (d.relationships && d.relationships.length > 0) {
        lines.push(`关系网: ${d.relationships.map((r) => `${r.targetName}（${r.relation}${r.note ? `；${r.note}` : ''}）`).join('；')}`);
      }
      if (d.progression && d.progression.length > 0) {
        lines.push(`经历: ${d.progression.join('；')}`);
      }
      lines.push(`当前心理状态: 好感度 ${d.state.affection}，内心想法「${d.state.innerThought}」`);
      // 角色卡里的 {{char}} 指自己；{{user}} 指玩家
      return expandMacros(lines.join('\n'), { ...finalCtx, charName: finalCtx.charName ?? d.name });
    }
    case 'memory': {
      const d = card.data as { summary: string; detail: string };
      return expandMacros(`【便利贴】${d.summary} —— ${d.detail}`, finalCtx);
    }
    case 'item': {
      const d = card.data as { name: string; description: string; location: string; locationId?: string; ownerCharacterId?: string };
      const ownerText = d.ownerCharacterId
        ? `，所有者: ${d.ownerCharacterId === 'player' ? '玩家' : d.ownerCharacterId.replace(/^char_/, '')}`
        : '';
      return expandMacros(`【物品 · ${d.name}】${d.description}（位置: ${d.location}${d.locationId ? `:${d.locationId}` : ''}${ownerText}）`, finalCtx);
    }
    case 'history':
      return '';
  }
}

/**
 * 主入口：< 2ms 级纯内存拼装。
 * - 插槽 2：场景卡 id 为 null 时沿用世界指针里的 currentSceneId
 * - 插槽 3：只贴清单里的便利贴，没提到就是空（0 Token）
 * - 插槽 4：滑动窗口（旧→新），超出预算从最旧处裁剪
 */
export async function assembleCards(input: AssemblerInput, store: CardStore): Promise<{
  prompt: string;
  tokenEstimate: number;
  slots: {
    system: string[];
    snapshot: string[];
    stickyNotes: string[];
    history: number;
    tokenBreakdown: { system: number; snapshot: number; layer: number; stickyNotes: number; history: number; labels: number };
    truncated: boolean;
  };
  route: RouteDecision;
}> {
  const { route, state } = input;
  const sceneId = route.sceneCardId ?? state.currentSceneId;

  // ---- 插槽 1：系统法则卡（没有则跳过，不阻塞；渲染在宏 ctx 就绪后） ----
  let systemCard: Card | null = null;
  if (route.systemCardId) systemCard = await store.getCard(route.systemCardId);

  // ---- 插槽 2：现场快照（场景卡 + 在场角色卡） ----
  const sceneCard = sceneId ? await store.getCard(sceneId) : null;
  // M14：常驻角色（主要NPC）的设定已由常驻区全量注入 → 快照不再重复贴
  const constIdSet = new Set((input.constantCards ?? []).map((c) => c.id));
  let charCards = (await store.getCards(route.characterCardIds)).filter(
    (c): c is Card => c !== null && !constIdSet.has(c.id),
  );
  // 会话情感 overlay：若世界指针携带 npcStates（会话隔离的情感快照），
  // 角色卡渲染时用 overlay 覆盖卡片上的全局好感/心理 —— 多会话互不串扰。
  const overlays = state.npcStates;
  if (overlays) {
    charCards = charCards.map((c) => {
      const o = c.kind === 'character' ? overlays[c.id] : undefined;
      if (!o) return c;
      // 保留卡内静态字段，仅替换动态情感（name/description 等不能被覆盖丢）
      const d = c.data as CharacterCardData;
      return { ...c, data: { ...d, state: { ...d.state, affection: o.affection, innerThought: o.innerThought } } };
    });
  }
  // 宏上下文：{{user}} = 玩家名；非角色卡里的 {{char}} = 主讲/首个在场角色名
  const charNames = charCards.filter((c) => c.kind === 'character').map((c) => (c.data as { name: string }).name);
  const speakerCard = route.speakerCharacterId ? charCards.find((c) => c.id === route.speakerCharacterId) : null;
  const speakerName = speakerCard ? (speakerCard.data as { name: string }).name : charNames[0];
  const ctxForShared: RenderCtx = { userName: input.userName, charName: speakerName };
  const ctxForSelf = (c: Card): RenderCtx => ({ userName: input.userName, selfName: (c.data as { name?: string }).name });
  const snapshotText = [sceneCard ? renderCard(sceneCard, ctxForShared) : '', ...charCards.map((c) => renderCard(c, ctxForSelf(c)))].filter(Boolean).join('\n\n');

  // ---- 插槽 3A：分层摘要链（按层序贴入；总量超过预算时从最老段整体折叠并标注归档） ----
  const summaries = [...(input.layerSummaries ?? [])].sort((a, b) => a.layerFrom - b.layerFrom);
  const layerHeader = '【剧情回顾 · 分层摘要】';
  let layerText = '';
  let foldedLayers = 0;
  const segOf = (sm: { layerFrom: number; layerTo: number; detail: string }) =>
    `【第 ${sm.layerFrom}-${sm.layerTo} 层回顾】${sm.detail}`;
  const layerTotal = summaries.map(segOf).join('\n');
  if (layerTotal && estimateTokens(`${layerHeader}\n${layerTotal}`) > SLOT_BUDGETS.layer && summaries.length > 1) {
    // 从最老段开始整体丢弃，直到预算内（保留下半段的「最近剧情」语义）
    const keep: typeof summaries = [];
    let used = estimateTokens(layerHeader) + 1;
    for (let i = summaries.length - 1; i >= 0; i--) {
      const seg = segOf(summaries[i]!);
      if (used + estimateTokens(seg) + 1 <= SLOT_BUDGETS.layer) {
        keep.unshift(summaries[i]!);
        used += estimateTokens(seg) + 1;
      } else {
        foldedLayers += 1;
      }
    }
    if (keep.length === 0) {
      // 连最近一层都放不下：只留最近一层（折叠其余）
      keep.push(summaries[summaries.length - 1]!);
      foldedLayers = summaries.length - 1;
    }
    layerText = keep.map(segOf).join('\n');
    if (foldedLayers > 0) layerText += `\n（更早 ${foldedLayers} 层已归档折叠）`;
  } else {
    layerText = layerTotal;
  }

  // ---- 插槽 3：便利贴（记忆切片 + 物品卡） ----
  const stickyCards = (await store.getCards([...route.memoryCardIds, ...route.itemCardIds])).filter(
    (c): c is Card => c !== null,
  );
  const stickyText = stickyCards.map((c) => renderCard(c, ctxForShared)).join('\n\n');
  // 系统法则卡：{{user}} 用玩家名（{{char}} 一般不出现在法则里）
  const systemText = systemCard ? renderCard(systemCard, { userName: input.userName, charName: speakerName }) : '';

  // ---- 插槽 4：视线窗口（全量历史，旧→新）+ 玩家最新输入 ----
  // excluded（出戏）行不进模型上下文（但仍留在历史里供回看）
  const recent = input.history.filter((h) => !h.excluded);
  const historyLines = recent.map((h) => {
    // OOC 场外行：标注（OOC）但仍可见（模型能区分场外与剧情）
    if (h.speaker === 'ooc') return `（OOC）${h.text}`;
    const who = h.speaker === 'user' ? '玩家' : h.speaker;
    const action = h.action ? `（${h.action}）` : '';
    return `${who}${action}: ${h.text}`;
  });
  historyLines.push(`玩家（最新输入）: ${input.userMessage}`);
  let historyText = historyLines.join('\n');
  // 不裁剪：完整上下文（尾部是玩家最新输入，天然保留）
  let historyTruncated = false;

  // ---- 拍平：四插槽顺次压成纯文本，总量 < 900 Token ----
  const historySection = `【最近对话】\n${historyText}`;
  // M10-P1B：玩家身份段（若有玩家卡）——让模型明确"你对面/正在扮演剧情里这个我"
  let playerText = '';
  if (input.playerCard) {
    const pcd = input.playerCard.data as { name: string; role?: string; description?: string; personality?: string; scenario?: string; openingLine?: string };
    const who = pcd.name || '玩家';
    playerText = [
      `【玩家身份】你当前扮演的是「${who}」${pcd.role ? `（${pcd.role}）` : ''}——注意：你是玩家，不是要扮演的 NPC。`,
      pcd.description || pcd.scenario || pcd.personality ? `
设定: ${[pcd.scenario, pcd.description, pcd.personality].filter(Boolean).join('；')}` : '',
      pcd.openingLine ? `
备注: ${pcd.openingLine}` : '',
    ].join('');
    // 卡正文若含 {{user}}/{{char}} 等宏 → 按当前玩家名展开
    playerText = expandMacros(playerText, { userName: input.userName, charName: who });
  }
  // M11：常驻卡段——按 世界观/主线剧情/规则状态机/常驻角色 分节全量贴入
  let constantText = '';
  const constCards = input.constantCards ?? [];
  if (constCards.length > 0) {
    const secTitle = (t: string) => `【${t}】`;
    const parts: string[] = [];
    const pushSec = (title: string, items: string[]) => {
      if (items.length > 0) parts.push(secTitle(title) + '\n' + items.join('\n\n'));
    };
    const worldviews: string[] = [];
    const plots: string[] = [];
    const rules: string[] = [];
    const constChars: string[] = [];
    for (const cc of constCards) {
      const cdata = cc.data as unknown as Record<string, unknown>;
      if (cc.kind === 'character') {
        // M14：常驻角色 = 设定每回合全量注入（语义 B：在场仍按场景/路由）
        const ccName = (cdata.name as string) ?? cc.id;
        const ccBody = renderCard(cc, { userName: input.userName, charName: ccName });
        if (ccBody) constChars.push(ccBody);
        continue;
      }
      const body = (cdata.detail as string) || (cdata.description as string) || '';
      const mclass = (cdata as { mclass?: string }).mclass;
      const label = (cdata.summary as string) || (cdata.name as string) || '常驻设定';
      // 只贴有实际正文的常驻卡（空 detail/description 的 memory/物品不应静默消失，
      // 但也要避免贴出空壳段落；有正文才进上下文）
      if (!body.trim()) continue;
      const item = `【${label}】\n${body}`;
      if (mclass === 'worldview') worldviews.push(item);
      else if (mclass === 'plot') plots.push(item);
      else if (mclass === 'rule') rules.push(item);
      else worldviews.push(item); // 无 mclass 的长文设定归世界观节
    }
    pushSec('世界观设定 · 常驻', worldviews);
    pushSec('主线剧情大纲 · 常驻', plots);
    pushSec('规则 · 状态机 · 常驻', rules);
    pushSec('主要人物 · 常驻', constChars);
    constantText = parts.join('\n\n');
  }
  const sections: string[] = [];
  if (systemText) sections.push(systemText);
  if (constantText) sections.push(constantText);
  if (playerText) sections.push(playerText);
  if (snapshotText) sections.push(snapshotText);
  if (layerText) sections.push(`【剧情回顾 · 分层摘要】\n${layerText}`);
  if (stickyText) sections.push(`【临时外挂知识】\n${stickyText}`);
  sections.push(historySection);

  let prompt = sections.join('\n\n---\n\n');
  const total = estimateTokens(prompt);
  let wholeTruncated = false;
  if (total > MAX_PROMPT_TOKENS) {
    // 总量兜底（防御：预算本应按槽分摊，防极端卡面/常驻卡把总量推超）。
    // 从头部裁（丢世界法则/常驻等旧内容），尾部玩家最新输入绝不丢。
    prompt = truncateHeadToBudget(prompt, MAX_PROMPT_TOKENS);
    wholeTruncated = true;
  }

  return {
    prompt,
    tokenEstimate: estimateTokens(prompt),
    slots: {
      system: systemCard ? [systemCard.id] : [],
      snapshot: [sceneCard?.id ?? '', ...charCards.map((c) => c.id)].filter(Boolean),
      stickyNotes: stickyCards.map((c) => c.id),
      history: recent.length,
      // 各插槽实际 token 消耗 + 是否触发过截断（供前端上下文水位条 / 调试）。
      // 说明：system/snapshot 无标题前缀，sticky/history 各含一个【】标题；
      // labels = 槽间分隔符（---）的固定开销。
      tokenBreakdown: {
        system: systemText ? estimateTokens(systemText) : 0,
        snapshot: snapshotText ? estimateTokens(snapshotText) : 0,
        layer: layerText ? estimateTokens(`【剧情回顾 · 分层摘要】\n${layerText}`) : 0,
        stickyNotes: stickyText ? estimateTokens(`【临时外挂知识】\n${stickyText}`) : 0,
        history: estimateTokens(historySection),
        labels: estimateTokens('---') * Math.max(0, sections.length - 1),
      },
      truncated: wholeTruncated || historyTruncated,
    },
    route,
  };
}
