/**
 * 阶段 1：前置路由 Agent（PreRouter）——「全自动挑卡裁决器」。
 *
 * 拿玩家这句话去跟【世界指针 + 全量卡片索引】比对，输出一份 JSON 抽卡清单。
 * 它只做四件事，不做任何对戏：
 *   1. 动作裁决 → 是否换场景卡（嘴上说「去铁匠铺」≠ 真移动）
 *   2. 出场裁决 → 谁在场、谁是主讲（防止多角色抢话）
 *   3. 记忆裁决 → 玩家提到场外人/旧事，撕下关系便利贴（绝不把安德鲁拉进现场）
 *   4. 物品裁决 → 玩家动到旧物品，捞回对应物品卡（防止 NPC 失忆）
 *
 * 底层驱动：completeSimple()（非流式，小模型，~200ms 级），
 * 用 TypeBox JSON Schema 约束输出格式。
 *
 * 可靠性（整改）：
 * - 统一走 robust-llm：单请求 30s 超时 + 瞬时错误有界重试（指数退避），
 *   替换原先「同一毫秒内连续重试 2 次」的手写循环；
 * - 模型输出做「形状校验」（非空数组/字符串类型检查），输出畸形立即判失败
 *   并抛出带 code=MODEL_FAILED 的 PitavernError，由流水线给前端稳定错误提示；
 * - 硬约束修正（sanitize）继续兜底越界 id。
 */
import { Type } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai';
import type { Card, HistoryLine, RouteDecision } from '../types.js';
import type { WorldState } from '../db/store.js';
import { completeWithRetry, messageError } from '../config/robust-llm.js';
import { ctxToDebugPrompt, ctxToStructured, messageContentToText } from '../utils/prompt-debug.js';
import { PitavernError } from '../config/errors.js';

/** PreRouter 的输入：世界指针 + 全量卡片索引（轻量摘要，不塞全卡正文） */
export interface RouterInput {
  worldId: string;
  state: WorldState;
  /** 玩家刚发的这句话 */
  userMessage: string;
  /** 当前场景卡（判断换场） */
  currentScene: Card & { data: { presentCharacterIds: string[] } };
  /** 全量角色卡索引（id + 名字 + 摘要，50 个也不怕；constant=主要NPC常驻） */
  characters: Array<{ id: string; name: string; role: string; constant?: boolean }>;
  /** 全量记忆切片索引 */
  memories: Array<{ id: string; ownerCharacterId: string; summary: string; keywords: string[]; relatedIds: string[] }>;
  /** 全量物品卡索引 */
  items: Array<{ id: string; name: string; description: string; location: string }>;
  /** 最近剧情全文（近 bufferLayers 层，旧→新；供叙事编排判断谁该上场/什么被触动） */
  recentLines?: HistoryLine[];
  /** M14 分层摘要链（全部剧情的压缩回顾：l1-20、l21-40…）——路由与组装同口径 */
  layerSummaries?: Array<{ layerFrom: number; layerTo: number; detail: string }>;
  /** M15 常驻卡全量（与演员同款注入：世界观/主线/规则全文 + 主要NPC设定） */
  constants?: Array<{ id: string; kind: string; name: string; mclass?: string; text: string }>;
  /** M16 路由 System 模板（可编辑；缺省用默认选角导演文本） */
  routerSystemTemplate?: string;
}

/** 默认路由 System 模板（工作台可编辑覆盖） */
export const DEFAULT_ROUTER_SYSTEM = [
  '【规则】',
  '你是这场 RPG 的「选角导演」。每次玩家行动，做一回合的叙事编排。',
  '- 顺着剧情自然发展（非关键词触发）：判断谁在场、谁会开口、哪些伏笔/旧事被触动、',
  '  玩家动到了什么、是否真的移动去了新场景。',
  '- 📌常驻内容（世界观/主线/主要人物等）已全量给你：直接用来理解世界与人物，不需要点名召回。',
  '- 非常驻角色/旧事/物件只有档案摘要：需要出场时点名（route_cards 填 id），点名后详细设定才会被调用进来；',
  '  不要因为"知道有这个人"就默认他在场。',
  '- 已在场角色默认保留；主讲只选一个，无人应声为 null；',
  '- 玩家真做出移动动作才切换场景卡（嘴上说说保持当前）；',
  '- 不为了用而用：旧事/物件仅在确实被触碰到时抽取。',
  '【工具】',
  '你有一个工具：route_cards —— 输出本回合的抽卡清单。参数：',
  '- sceneCardId：要切换的新场景卡 id（玩家真的移动去新地方时）；null = 沿用当前场景',
  '- characterCardIds：本回合在场的角色 id 数组（保留已在场者，含你点名登场的新角色）',
  '- speakerCharacterId：本回合主要张嘴回话的角色 id；无人应声为 null',
  '- memoryCardIds：被这次行动触发的旧事/记忆 id 数组；没有则 []',
  '- itemCardIds：玩家实际动到的物品 id 数组；没有则 []',
  '- historyWindow：上下文里保留的最近对话条数（通常 6）',
  '- turn：当前回合号（系统传入，不得更改）',
  '【输出】',
  '- 只调用 route_cards 输出参数 JSON；reasoning 字段用一句话说明编排理由（不进正文）。',
].join('\n');

/** 与 RouteDecision 对齐的 JSON Schema（抽卡清单契约） */
const routeSchema = Type.Object(
  {
    reasoning: Type.Optional(Type.String({ description: '（可选）一句话决策理由，不进上下文' })),
    sceneCardId: Type.Union([Type.String(), Type.Null()], { description: '换场景时给新场景卡 id；否则 null 表示沿用当前场景' }),
    characterCardIds: Type.Array(Type.String(), { description: '本回合在场的角色卡 id（含主讲）' }),
    speakerCharacterId: Type.Union([Type.String(), Type.Null()], { description: '本回合主要张嘴回话的角色 id；无人说话可为 null' }),
    memoryCardIds: Type.Array(Type.String(), { description: '撕下来的关系/旧账便利贴 id；没有则空数组' }),
    itemCardIds: Type.Array(Type.String(), { description: '玩家动到的旧物品卡 id；没有则空数组' }),
    historyWindow: Type.Number({ description: '最近窗口长度，通常 6' }),
    turn: Type.Number({ description: '当前回合号（由调用方传入，模型不得更改）' }),
  },
  { additionalProperties: false },
);

/**
 * 组装 PreRouter 的 Context —— 路由 = **叙事导演**。
 * 分层：System(规则/工具/输出) + 世界库(常驻全量 + 档案总览) + 剧情视图(摘要链 + 近N层全文)。
 * 非常驻卡 = 声明式档案：知道其人大概，点名（route_cards 填 id）后 assembler 才展开全文给演员。
 */
export function buildRouterContext(input: RouterInput): Context {
  const { state, currentScene, characters, memories, items, constants } = input;
  const presentNames = state.presentCharacterIds
    .map((id) => characters.find((c) => c.id === id)?.name ?? id)
    .join('、');

  // ============ 1) System · 导演层（M16：模板可编辑，缺省用默认） ============
  const systemPrompt = input.routerSystemTemplate?.trim()
    ? input.routerSystemTemplate.trim()
    : DEFAULT_ROUTER_SYSTEM;

  // ============ 2) 数据：常驻全量 / 档案总览 / 剧情视图 ============
  const summaryChain = (input.layerSummaries ?? [])
    .map((ls) => `【第 ${ls.layerFrom}-${ls.layerTo} 层回顾】${ls.detail}`)
    .join('\n\n');
  const recentText = (input.recentLines ?? [])
    .map((l) => {
      const who = l.speaker === 'user' ? '玩家' : l.speaker;
      return `${who}: ${l.text}`;
    })
    .join('\n');

  const constText = (constants ?? [])
    .map((c) => {
      const icon = c.kind === 'character' ? '🧙' : c.kind === 'memory'
        ? (({ worldview: '🌍', plot: '📖', rule: '🧭' }) as Record<string, string>)[c.mclass ?? ''] ?? '📌'
        : c.kind === 'scene' ? '🏰' : c.kind === 'item' ? '🗡️' : '📄';
      return `【${icon} ${c.name}】\n${c.text}`;
    })
    .join('\n\n');

  const constIds = new Set((constants ?? []).map((c) => c.id));
  const constCharIndex = characters
    .filter((c) => constIds.has(c.id))
    .map((c) => `- ${c.id}: ${c.name}（📌常驻，设定已全量注入）${state.presentCharacterIds.includes(c.id) ? ' ← 已在场' : ''}`);
  const charFiles = characters
    .filter((c) => !constIds.has(c.id))
    .map((c) => `- ${c.id}: ${c.name}（${c.role}）${state.presentCharacterIds.includes(c.id) ? '← 已在场' : '← 未在场，点名后展开设定'}`);
  const memoryFiles = memories
    .map((m) => `- ${m.id}: ${m.summary}${m.keywords && m.keywords.length ? `（触发词: ${m.keywords.join('、')}）` : ''}`);
  const itemFiles = items
    .map((i) => `- ${i.id}: ${i.name}（${i.description}${i.location === 'player' ? '，在玩家身上' : i.location === 'character' ? '，在某角色处' : ''}）`);

  // ============ 3) user 消息 ============
  return {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          `当前回合号: ${state.turn} | 当前场景: ${currentScene.id}（在场: ${presentNames || '无人'}）`,
          ...(constText ? ['', '【世界库 · 常驻设定（全量，直接使用）】', constText] : []),
          ...(constCharIndex.length || charFiles.length || memoryFiles.length || itemFiles.length
            ? ['', '【世界库 · 档案总览】',
              ...(constCharIndex.length ? ['📌 常驻角色（全量已注入，作索引）:', ...constCharIndex] : []),
              ...(charFiles.length ? ['🧙 角色（点名后展开）:', ...charFiles] : []),
              ...(memoryFiles.length ? ['📌 旧事/线索（点名后展开）:', ...memoryFiles] : []),
              ...(itemFiles.length ? ['🗡️ 物品（点名后展开）:', ...itemFiles] : []),
            ]
            : []),
          ...(summaryChain ? ['', '【剧情回顾 · 压缩摘要链】', summaryChain] : []),
          // 近 N 层全文（含玩家最新输入——不再单独附"玩家现在:"）
          ...(recentText ? ['', '【近 N 层剧情全文】', recentText] : []),
        ].join('\n'),
        timestamp: Date.now(),
      },
    ],
    tools: [
      {
        name: 'route_cards',
        description: '输出本回合抽卡清单（选角导演的编排决定：谁在场/谁主讲/撕哪些旧事物件/换不换场）',
        parameters: routeSchema,
      },
    ],
  };
}

export function parseRouteDecision(msg: unknown): Omit<RouteDecision, 'systemCardId'> | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;

  let raw: string | null = null;
  const content = m.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') raw = b.text;
        if (b.type === 'toolCall' && b.arguments != null) {
          // arguments 可能是字符串（绝大多数 API）或对象（部分 SDK/faux）
          raw = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments);
        }
      }
    }
  } else if (typeof content === 'string') {
    raw = content;
  }

  if (!raw) return null;
  let jsonText = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  // 健壮化：模型可能先废话再输出 JSON（如「好的，抽卡清单如下：{...}」）——
  // 找不到完整 JSON 时提取从首个 { 到能配平的 } 的片段；仅当整个输出无法解析才做。
  const tryParse = (t: string) => {
    try {
      const obj = JSON.parse(t);
      return obj && typeof obj === 'object' ? obj : null;
    } catch {
      return null;
    }
  };
  if (!tryParse(jsonText)) {
    const first = jsonText.indexOf('{');
    const last = jsonText.lastIndexOf('}');
    if (first >= 0 && last > first) {
      // 配平提取：从 first 起逐字符计括号深度，第一次回到 0 即截断（容忍尾部杂文）
      let depth = 0;
      let end = -1;
      for (let i = first; i <= last && i < jsonText.length; i++) {
        const ch = jsonText[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      const candidate = jsonText.slice(first, end > 0 ? end : last + 1);
      const obj = tryParse(candidate);
      if (obj) jsonText = candidate;
      else jsonText = candidate; // 保留给下方 JSON.parse 报错（信息更准）
    }
  }
  try {
    const obj = JSON.parse(jsonText) as Partial<RouteDecision> & { reasoning?: string };
    if (typeof obj !== 'object' || obj === null) return null;
    return {
      sceneCardId: typeof obj.sceneCardId === 'string' ? obj.sceneCardId : null,
      characterCardIds: Array.isArray(obj.characterCardIds) ? obj.characterCardIds.filter((x): x is string => typeof x === 'string') : [],
      speakerCharacterId: typeof obj.speakerCharacterId === 'string' ? obj.speakerCharacterId : null,
      memoryCardIds: Array.isArray(obj.memoryCardIds) ? obj.memoryCardIds.filter((x): x is string => typeof x === 'string') : [],
      itemCardIds: Array.isArray(obj.itemCardIds) ? obj.itemCardIds.filter((x): x is string => typeof x === 'string') : [],
      historyWindow: typeof obj.historyWindow === 'number' ? obj.historyWindow : 6,
      turn: typeof obj.turn === 'number' ? obj.turn : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 形状校验：确认模型输出真的是「抽卡清单」而非胡说（比如把字符串数组
 * 答成对象、把 id 答成 null 等）。shape 不合格返回 null。
 */
function validateRouteShape(raw: Omit<RouteDecision, 'systemCardId'>): boolean {
  if (!raw) return false;
  // sceneCardId 允许 null（沿用当前场景）；speaker 允许 null（无人说话）
  if (raw.sceneCardId !== null && typeof raw.sceneCardId !== 'string') return false;
  if (raw.speakerCharacterId !== null && typeof raw.speakerCharacterId !== 'string') return false;
  if (!Array.isArray(raw.characterCardIds)) return false;
  if (!Array.isArray(raw.memoryCardIds) || !Array.isArray(raw.itemCardIds)) return false;
  if (typeof raw.historyWindow !== 'number' || typeof raw.turn !== 'number') return false;
  return true;
}

/** 对模型给出的清单做一次「硬约束修正」，防止模型输出越界 id */
export function sanitizeRouteDecision(raw: Omit<RouteDecision, 'systemCardId'>, input: RouterInput): RouteDecision {
  const knownCharacterIds = new Set(input.characters.map((c) => c.id));
  const knownMemoryIds = new Set(input.memories.map((m) => m.id));
  const knownItemIds = new Set(input.items.map((i) => i.id));
  const inScene = new Set(input.state.presentCharacterIds);

  // 角色：必须在索引里；召唤新角色时自动加进在场名单
  const characterCardIds = raw.characterCardIds.filter((id) => knownCharacterIds.has(id));
  for (const id of characterCardIds) inScene.add(id);
  // 主讲人必须在场
  const speakerCharacterId =
    raw.speakerCharacterId && inScene.has(raw.speakerCharacterId) ? raw.speakerCharacterId : characterCardIds[0] ?? null;

  const sceneCardId =
    raw.sceneCardId === null || raw.sceneCardId === 'null' || raw.sceneCardId === 'undefined' || raw.sceneCardId === ''
      ? null
      : raw.sceneCardId;
  return {
    sceneCardId, // 场景卡 id 合法性由组装器验证（可能为 null 沿用当前）
    characterCardIds: [...inScene],
    speakerCharacterId,
    memoryCardIds: raw.memoryCardIds.filter((id) => knownMemoryIds.has(id)),
    itemCardIds: raw.itemCardIds.filter((id) => knownItemIds.has(id)),
    historyWindow: Math.max(2, Math.min(12, raw.historyWindow)),
    turn: input.state.turn,
    // 系统法则卡恒定，由调用方（pipeline）注入；这里只留 null 占位，pipeline 会覆盖
    systemCardId: null,
  };
}

export interface PreRouterResult {
  decision: RouteDecision;
  /** 该次调用的模型说明（真实模型 or faux） */
  modelUsed: string;
  /** 原始输出的首个文本/toolCall（调试用） */
  rawPreview: string;
  /** 总耗时（ms，含重试） */
  tookMs: number;
  /** 各次尝试耗时（ms） */
  attemptMs: number[];
  /** 是否发生过重试/超时等（供阶段面板提示） */
  degraded?: boolean;
  /** token 用量（若有） */
  usage?: { input: number; output: number };
  /** 调试：实际发给路由模型的完整提示词文本 */
  debugPrompt?: string;
  /** 调试：模型完整回复原文（不截断；JSON/工具调用原样） */
  rawResponse?: string;
  /** 调试：请求分层（system/消息/工具） */
  request?: { system: string; messages: Array<{ role: string; content: string }>; tools: string };
}

/** 运行阶段 1：await 等它出结果，产出 RouteDecision 交给组装器 */
export async function preRouter(
  models: Models,
  model: Model<Api>,
  input: RouterInput,
  opts: { apiKey?: string } = {},
): Promise<PreRouterResult> {
  const t0 = performance.now();
  const ctx = buildRouterContext(input);

  const call = await completeWithRetry(models, model, ctx, {
    apiKey: opts.apiKey,
    // 路由只输出一份小 JSON：低温稳定格式；长度放宽（reasoning 型模型会先想再答，
    // 500 容易被截断成半截 JSON → 解析失败）
    maxTokens: 1200,
    temperature: 0.2,
    timeoutMs: 30_000,
    maxRetries: 1,
  });

  if (!call.message) {
    throw new PitavernError('MODEL_FAILED', `[PreRouter] 路由裁决失败: ${call.error ?? '未知错误'}`, { cause: call.error });
  }
  const msg = call.message;
  const decision = parseRouteDecision(msg);
  if (!decision || !validateRouteShape(decision)) {
    const rawText = messageContentToText(msg);
    throw new PitavernError(
      'MODEL_FAILED',
      `[PreRouter] 无法解析路由输出（模型返回格式不合法）: ${messageError(msg) || '内容为空或非 JSON'}。原始输出: ${rawText.slice(0, 300)}`,
      { cause: { raw: rawText.slice(0, 2000) } },
    );
  }
  const sanitized = sanitizeRouteDecision(decision, input);
  const rawText = messageContentToText(msg);
  const rawPreview = rawText.slice(0, 200);
  const u = msg.usage;
  return {
    decision: sanitized,
    modelUsed: `${model.provider}/${model.id}`,
    rawPreview,
    tookMs: performance.now() - t0,
    attemptMs: call.attemptMs,
    degraded: call.attempts > 1,
    usage: u ? { input: u.input, output: u.output } : undefined,
    debugPrompt: ctxToDebugPrompt(ctx),
    rawResponse: rawText,
    request: ctxToStructured(ctx),
  };
}
