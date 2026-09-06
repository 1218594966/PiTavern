/**
 * PiTavern 核心领域类型：卡片（Card）是数据库里最小的可抽单元，
 * 抽卡清单（RouteDecision）是阶段 1 与阶段 2 之间传递的 JSON 契约。
 */

/** 卡片在四插槽中的落位 */
export type CardKind = 'system' | 'scene' | 'character' | 'memory' | 'item' | 'history';

/** 角色当前的动态状态（阶段 4 会更新它） */
export interface CharacterState {
  /** 好感度：普通闲聊 ±1，重大事件 ±5，杜绝几句话刷满 */
  affection: number;
  /** 角色此刻的内心想法（阶段 4 提炼的潜意识心理） */
  innerThought: string;
  /** 场景内可见物品的持有/位置变化，例如 "短剑已收入玩家背包" */
  roomChanges: string[];
  /** 最近一次更新的轮次序号 */
  updatedAtTurn?: number;
}

export interface SceneCardData {
  /** 房间/地点名 */
  name: string;
  description: string;
  /** 在场角色 id（阶段 1 会据此加人/踢人） */
  presentCharacterIds: string[];
  /** 房间内的物品 id（阶段 1 可据此捞「带血短剑」） */
  itemIds: string[];
  /** 本房间最近发生的叙事变化（阶段 4 追加） */
  recentChanges: string[];
  /** 导入临时字段：在场角色名（importWorld 二次解析成 id 后删除） */
  _pendingPresentNames?: string[];
}

/** 一条便利贴式记忆切片：关系、旧账、线索，1~2 句 */
export interface MemoryCardData {
  /** 记忆所属角色（谁记得这件事） */
  ownerCharacterId: string;
  /** 一句话摘要，如 "与铁匠安德鲁决裂" */
  summary: string;
  /** 1~2 句细节，作为插槽 3 的正文 */
  detail: string;
  /** 关联的角色/物品 id，供路由阶段做触发匹配 */
  relatedIds: string[];
  /** 匹配用关键词（玩家输入命中即被撕下贴上） */
  keywords: string[];
  /* ---- M8 记忆分层 ----
   * 摘要卡（isSummary=true）覆盖 [layerFrom, layerTo] 回合区间；
   * 普通记忆卡无层区间（即席事件），摘要卡经压缩生成、可画廊编辑。
   */
  isSummary?: boolean;
  layerFrom?: number;
  /** 旧版 M10-P2A data 内常驻标记（M11 起移到 Card 顶层；读兼容保留） */
  constant?: boolean;
  /** M11 记忆小类：worldview 世界观 / plot 主线剧情 / rule 规则状态机 / event 事件记忆 */
  mclass?: MemoryClass;
  layerTo?: number;
}

export interface ItemCardData {
  name: string;
  description: string;
  /** 物品所处位置：某角色身上 / 某场景内 / 玩家背包（= 现在在哪） */
  location: 'character' | 'scene' | 'player';
  locationId?: string;
  /** 所有权（M10）：这件东西属于哪个角色（即使暂时借走/丢失仍是其所有物）；
   *  玩家所有物用 'player'；无主物缺省。画廊角色详情显示「其所有物」子列表。 */
  ownerCharacterId?: string;
}

export interface CharacterCardData {
  name: string;
  role: string;
  /** M10-P1B：玩家角色卡（"我"的人设）—— 不进路由抽卡池、不登场当 NPC；
   *  若有，组装时以「玩家身份」段注入设定。 */
  isPlayer?: boolean;
  description: string;
  personality: string;
  /** 背景设定（V2 scenario；M4 起分字段承载） */
  scenario?: string;
  speechStyle: string;
  /** 开场白（导入的角色卡 first_mes） */
  openingLine?: string;
  /** 头像（PNG 导入提取，base64 dataURL） */
  avatar?: string;
  /* ---- M8 动态人设（随游玩演化，静态人设之外的"活"部分） ---- */
  /** 关系网：与其它角色/玩家的重要关系（好感数值在 state，这里存关系定性） */
  relationships?: Array<{ targetName: string; relation: string; note?: string }>;
  /** 成长档案：经历的重大事件（按时间追加，渲染进上下文保证一致性） */
  progression?: string[];
  /* ---- V2 元数据（round-trip 保留，不参与上下文渲染） ---- */
  /** mes_example 对话示例（V2 原字段） */
  mesExample?: string;
  /** 多开场白（V2 alternate_greetings） */
  alternateGreetings?: string[];
  /** 角色级系统提示覆盖（V2 system_prompt） */
  systemPrompt?: string;
  /** 文后指令（V2 post_history_instructions） */
  postHistoryInstructions?: string;
  /** 制作者备注（V2 creator_notes） */
  creatorNotes?: string;
  /** 作者（V2 creator） */
  creator?: string;
  /** 角色版本（V2 character_version） */
  characterVersion?: string;
  /** 标签（V2 tags） */
  tags?: string[];
  /** 导入临时字段：场景在场角色名（importWorld 二次解析成 id 后删除） */
  _pendingPresentNames?: string[];
  state: CharacterState;
}

export interface SystemCardData {
  /** 世界名 */
  world: string;
  /** 系统法则卡正文：写在最顶上焊死的规矩 */
  rules: string[];
  /* ---- M8 结构化世界观 ---- */
  /** 大事记时间线：随回合推进追加「第 N 回合：事件」（供模型把握世界全局变化） */
  timeline?: string[];
}

/** 最近窗口里的真实对白/动作（插槽 4） */
export interface HistoryLine {
  speaker: 'user' | string;
  text: string;
  /** 可选动作描述，如 "推门跑向二楼" */
  action?: string;
  turn: number;
  /** 稳定消息 id（编辑/删除/regenerate 用；push 时由存储层补发） */
  id?: string;
  /**
   * 楼层（swipe）历史版本：该条消息之前生成过的其它文本，旧→新。
   * text 为当前展示版本；swipes 供前端 ◀▶ 循环切换。
   */
  swipes?: string[];
  /**
   * 出戏标记：为 true 时不进入模型上下文（assembler 插槽 4 过滤），
   * 但保留在历史里供玩家回看（如整段 OOC 或玩家想删除的剧情）。
   */
  excluded?: boolean;
}

/** 一张卡的完整形态（数据库存的就是它） */
export interface Card {
  id: string;
  kind: CardKind;
  data: SystemCardData | SceneCardData | CharacterCardData | MemoryCardData | ItemCardData;
  /** 匹配用关键词，供路由层触发抽取 */
  keywords?: string[];
  /** M11 卡片通用常驻开关：常驻卡每回合全量进组装器（世界观/主线/规则等），
   *  不经路由抽卡；任何 kind 都可有（历史数据可能在 data.constant —— 读取时兼容提升） */
  constant?: boolean;
  updatedAt?: number;
}

/** M11 记忆卡小类：常驻/内容性质分类（世界观/主线/规则/事件） */
export type MemoryClass = 'worldview' | 'plot' | 'rule' | 'event';

/** 玩家档案（Persona）：你是谁（宏替换 {{user}} 的来源） */
export interface Persona {
  name: string;
  /** 一句话身份描述（可进设定/旁白） */
  description?: string;
  /** 头像（可选，dataURL） */
  avatar?: string;
}

/* ------------------------- 抽卡清单（阶段 1 → 阶段 2 的 JSON 契约） ------------------------- */

export interface RouteDecision {
  /** 场景卡：不换场景则沿用当前房间，换场景则给出新房间 id */
  sceneCardId: string | null;
  /** 在场角色卡：本回合需要出现在插槽 2 的角色 */
  characterCardIds: string[];
  /** 主讲人：本回合主要张嘴回话的角色（防止多角色抢话） */
  speakerCharacterId: string | null;
  /** 便利贴：关系切片 / 物品卡等外挂知识，可空 */
  memoryCardIds: string[];
  /** 物品卡：玩家动到的旧东西 */
  itemCardIds: string[];
  /** 系统法则卡 id（通常恒定） */
  systemCardId: string | null;
  /** 本回合窗口长度（最近 N 条历史，默认 6） */
  historyWindow: number;
  /** 该决策对应的回合号 */
  turn: number;
}

/** 阶段 2 拼装结果：四插槽拍平后的最终 Prompt */
export interface AssembledContext {
  prompt: string;
  tokenEstimate: number;
  /** 本次实际装入的卡片明细，供日志/调试 */
  slots: {
    system: string[];
    snapshot: string[];
    stickyNotes: string[];
    history: number;
  };
  route: RouteDecision;
}
