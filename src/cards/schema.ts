/**
 * PiTavern 卡格式规范（schema v1）
 *
 * 设计目标：兼容 SillyTavern 生态的 Character Card V1/V2 格式（全网通用），
 * 并扩展出 PiTavern 自己的卡型（scene/world/item），支持"一包多卡"自动拆分。
 *
 * 三种可导入的载体：
 *   1. PNG/APNG 嵌卡 —— Chara EXIF 字段里 base64 的 JSON（SillyTavern 标准嵌入）
 *   2. .json 文件 —— V1（裸字段）或 V2/V3（spec: 'chara_card_v2'|'chara_card_v3' 包裹 data）
 *   3. .json 世界包 —— 本项目扩展：一个包含多角色/多场景/世界观（拼接式拆分）
 */

/* ======================= 兼容层：Character Card V1/V2 ======================= */

/** V1 格式（历史兼容） */
export interface TavernCardV1 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
}

/** Character Book（角色书/lorebook）：记忆切片 + 触发词，正好映射我们的记忆卡 */
export interface CharacterBookEntry {
  keys: string[];
  content: string;
  extensions?: Record<string, unknown>;
  enabled?: boolean;
  insertion_order?: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  position?: 'before_char' | 'after_char';
}

export interface CharacterBook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions?: Record<string, unknown>;
  entries: CharacterBookEntry[];
}

/** V2 格式（全网通用标准） */
export interface TavernCardV2 {
  spec: 'chara_card_v2' | 'chara_card_v3';
  spec_version?: string;
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    character_book?: CharacterBook;
    tags?: string[];
    creator?: string;
    character_version?: string;
    /** 第三方扩展都放这里（我们放 pitavern 命名空间） */
    extensions?: Record<string, unknown>;
  };
}

/** 统一的外部卡（V1 或 V2） */
export type TavernCard = TavernCardV1 | TavernCardV2;

/* ======================= PiTavern 扩展命名空间 ======================= */

/**
 * 放在 V2 的 data.extensions.pitavern 下，不破坏标准字段。
 * 创作者可选的增强：给角色配场景/世界观/物品，形成"拼接包"。
 */
export interface PitavernExtension {
  /** 卡型（缺省按内容推断：有场景/多人则拆包） */
  kind?: 'character' | 'scene' | 'world' | 'item' | 'memory';
  /** 角色所属世界 id/名（用于把散卡归组） */
  worldId?: string;
  /** 说话风格（进 Actor 设定） */
  speechStyle?: string;
  /** 开场白（覆盖 first_mes 的别名） */
  openingLine?: string;
  /** 该角色关联的场景（scene 卡数据内联） */
  scenes?: Array<{
    id: string;
    name: string;
    description: string;
    presentCharacterIds?: string[];
  }>;
  /** 该角色认识的其他角色（拆成独立角色卡） */
  npcs?: Array<{
    id: string;
    name: string;
    description: string;
    personality?: string;
  }>;
  /** 世界观/规则（拆成 world 卡） */
  world?: {
    id: string;
    name: string;
    rules: string[];
  };
  /** 物品（拆成 item 卡） */
  items?: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

/* ======================= 多卡世界包（本项目拼接式导入） ======================= */

/**
 * 一个"世界包"包含多张卡（角色/场景/世界观/物品），导入时自动拆分。
 * 兼容：任何 V1/V2 单角色卡也能当世界包（只有 1 个角色）。
 */
export interface WorldPack {
  schema: 'pitavern-world/v1';
  /** 世界名（必填，作为所有卡的归组） */
  world: {
    id: string;
    name: string;
    rules: string[];
    description?: string;
  };
  /** 角色卡列表 */
  characters: Array<TavernCardV1 | TavernCardV2>;
  /** 场景卡列表（独立于角色的场景描述） */
  scenes?: Array<{
    id: string;
    name: string;
    description: string;
    presentCharacterNames?: string[];
    items?: string[];
  }>;
  /** 物品卡 */
  items?: Array<{
    id: string;
    name: string;
    description: string;
    /** M10：所有者角色 id（导入后角色也按 id 建档）；无主物缺省 */
    ownerCharacterId?: string;
  }>;
  /** 全局记忆切片（无主记忆，如世界历史事件） */
  lore?: Array<{
    keys: string[];
    content: string;
  }>;
}

/* ======================= 导入结果：拆分后的内部卡 ======================= */

/** 导入解析产物：一张或多张内部卡 + 元信息 */
export interface ImportResult {
  /** 拆分出的卡（与内部 Card 结构对齐前的中间形态） */
  cards: ImportedCard[];
  /** 导入摘要（给前端展示：拆出了几张角色/场景/世界观…） */
  summary: {
    world?: string;
    characters: string[];
    scenes: string[];
    items: string[];
    memories: number;
  };
  /** M12：空壳群像包的世界开场白（无主体角色卡的 first_mes） */
  worldGreeting?: { speaker: string; text: string };
}

/** 中间形态卡（导入器产出，后续转成 db 里的 Card） */
export interface ImportedCard {
  kind: 'system' | 'scene' | 'character' | 'memory' | 'item';
  id: string;
  name: string;
  /** 静态正文（场景描述/物品描述/记忆内容/系统规则；角色卡 = description 本体） */
  body: string;
  /** 角色专属：说话风格/开场白 */
  speechStyle?: string;
  openingLine?: string;
  /* ---- 角色分字段（M4：description/personality/scenario 分开承载） ---- */
  /** 角色专属：性格（V2 personality） */
  personality?: string;
  /** 角色专属：背景设定（V2 scenario） */
  scenario?: string;
  /** 记忆专属：触发词 */
  keys?: string[];
  /** 场景专属：在场角色名（导入后解析成 id） */
  presentCharacterNames?: string[];
  /** 物品专属（M10）：所有者角色 id（世界包 items 可带 owner；导入解析后填） */
  ownerCharacterId?: string;
  /** 玩家角色卡（M10-P1B：{{user}} 人设条目启发式识别；archive 落库为 data.isPlayer） */
  player?: boolean;
  /** 常驻记忆（M10-P2A：显式 constant 或启发式——无 keys 长文本世界观/大纲） */
  constant?: boolean;
  /** M11 记忆小类（worldview/plot/rule/event） */
  mclass?: 'worldview' | 'plot' | 'rule' | 'event';
  /** 原始卡来源（V1/V2/世界包） */
  source: 'v1' | 'v2' | 'worldpack';
  /** 头像（PNG 提取的，base64 或 null） */
  avatar?: string | null;
  /* ---- V2 元数据 round-trip（导入原样保留，导出原样回写） ---- */
  /** mes_example（V2 data.mes_example，对话示例块） */
  mesExample?: string;
  /** alternate_greetings（多开场白） */
  alternateGreetings?: string[];
  /** system_prompt（角色覆盖全局系统提示） */
  systemPrompt?: string;
  /** post_history_instructions（文后指令） */
  postHistoryInstructions?: string;
  /** creator_notes（给使用者看的制作者备注） */
  creatorNotes?: string;
  /** creator（作者） */
  creator?: string;
  /** character_version（角色版本号） */
  characterVersion?: string;
  /** tags（标签） */
  tags?: string[];
}
