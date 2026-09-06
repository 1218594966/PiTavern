/**
 * 卡片导入器：把 SillyTavern 生态卡 / PiTavern 世界包解析拆分成内部卡。
 *
 * 支持的载体：
 *   1. PNG/APNG 嵌卡（Chara EXIF 字段存 base64 JSON）—— SillyTavern 标准
 *   2. .json V1 卡（裸字段）
 *   3. .json V2 卡（spec: 'chara_card_v2'，data 包裹）
 *   4. .json 世界包（pitavern-world/v1，一包多卡 → 自动拆分）
 *
 * 自动拆分逻辑：
 *   - V2 卡：主体拆成角色卡；character_book.entries → 记忆卡；
 *     extensions.pitavern.scenes/npcs/items/world → 场景/角色/物品/世界观卡
 *   - 世界包：characters[] 每个拆一张角色卡；scenes[] → 场景卡；lore → 记忆卡
 */
import type {
  ImportResult,
  ImportedCard,
  PitavernExtension,
  TavernCard,
  TavernCardV1,
  TavernCardV2,
  WorldPack,
} from './schema.js';

/* ------------------------- 工具 ------------------------- */

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'card';
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 防撞 id：同包内重名卡（如 character_book 里两条「郑剑」人物志/同名记忆）
 * 会被 toInternalCard 的 slugify 拍成同一个 id → 后者覆盖前者、静默丢卡。
 * 凡与先前卡 id 冲突的记忆卡/场景卡，改挂唯一随机后缀（角色/物品/系统 id
 * 保留原样，避免破坏跨卡引用语义；导入器生成的 id 本身就带时间戳随机）。
 */
function dedupeIds(list: ImportedCard[]): void {
  if (list.length <= 1) return;
  const seen = new Set<string>();
  for (const c of list) {
    // 记忆/场景/角色（character_book 人物志拆出、npcs 拆出的）都可能同名同 id；
    // 撞车时挂唯一随机后缀（world/物品/系统保留原样，避免破坏包级引用语义）
    if (c.kind === 'memory' || c.kind === 'scene' || c.kind === 'character') {
      let cid = c.id;
      while (seen.has(cid)) cid = `${c.id}_${Math.random().toString(36).slice(2, 8)}`;
      if (cid !== c.id) c.id = cid;
      seen.add(cid);
    } else {
      seen.add(c.id);
    }
  }
}

/* ------------------------- PNG 嵌卡解析 ------------------------- */

/**
 * 从 PNG 字节里提取 Chara EXIF 字段（SillyTavern 嵌入 JSON 的标准位置）。
 * 返回解析后的对象；不是 PNG 或没有 Chara 字段返回 null。
 */
export async function parsePngCard(buffer: Buffer): Promise<TavernCard | WorldPack | null> {
  // PNG 魔数检查
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

  // 遍历 PNG chunks 找 tEXt 里的 chara / ccv3（SillyTavern 标准；ccv3 为 V3 打包副本）。
  // 可能多个字段共存（如 chara + ccv3），收集所有候选、逐个尝试解析，取第一个成功的。
  let offset = 8;
  const candidates: string[] = [];
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'tEXt') {
      // tEXt: keyword\0text
      const nul = buffer.indexOf(0, dataStart);
      if (nul > dataStart && nul < dataStart + len) {
        const keyword = buffer.toString('latin1', dataStart, nul);
        const lower = keyword.toLowerCase();
        if (lower === 'chara' || lower === 'ccv3') {
          candidates.push(buffer.toString('utf8', nul + 1, dataStart + len));
        }
      }
    }
    offset = dataStart + len + 4; // + CRC
  }
  for (const text of candidates) {
    // 1) 直接 JSON
    try {
      return JSON.parse(text) as TavernCard | WorldPack;
    } catch {
      /* 继续 */
    }
    // 2) base64 包裹的 JSON（部分工具会再包一层）
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      return JSON.parse(decoded) as TavernCard | WorldPack;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/* ------------------------- JSON 载体解析 ------------------------- */

function isV2(obj: unknown): obj is TavernCardV2 {
  const o = obj as Record<string, unknown> | null;
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (o?.spec === 'chara_card_v2' || o?.spec === 'chara_card_v3') &&
    typeof o?.data === 'object' &&
    o?.data !== null
  );
}

function isV1(obj: unknown): obj is TavernCardV1 {
  const o = obj as Record<string, unknown> | null;
  return typeof obj === 'object' && obj !== null && typeof o?.name === 'string' && typeof o?.description === 'string';
}

function isWorldPack(obj: unknown): obj is WorldPack {
  const o = obj as Record<string, unknown> | null;
  return (
    typeof obj === 'object' &&
    obj !== null &&
    o?.schema === 'pitavern-world/v1' &&
    typeof o?.world === 'object' &&
    Array.isArray(o?.characters)
  );
}

/** 统一入口：解析任意 JSON 对象 → 世界包或单卡列表 */
export function parseCardJson(raw: unknown): { world?: WorldPack; cards: TavernCard[] } {
  if (typeof raw !== 'object' || raw === null) return { cards: [] };
  if (isWorldPack(raw)) {
    return { world: raw, cards: raw.characters };
  }
  if (isV2(raw) || isV1(raw)) {
    return { cards: [raw] };
  }
  return { cards: [] };
}

/* ------------------------- 拆分逻辑 ------------------------- */

/** 把 V1/V2 角色卡拆成 ImportedCard[]（含 character_book → 记忆卡、扩展 → 场景/NPC/物品） */
function splitCharacterCard(card: TavernCardV1 | TavernCardV2, worldName?: string): ImportedCard[] {
  const isV2Card = 'spec' in card && (card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3');
  const v2 = isV2Card ? (card as TavernCardV2) : null;
  const v1data = isV2Card ? (card as TavernCardV2).data : (card as TavernCardV1);
  // 统一访问 V1 字段（V2 的 data 结构同 V1）
  const data = {
    name: v1data.name,
    description: v1data.description ?? '',
    personality: v1data.personality ?? '',
    scenario: v1data.scenario ?? '',
    first_mes: v1data.first_mes ?? '',
    mes_example: v1data.mes_example ?? '',
  };
  const out: ImportedCard[] = [];

  const ext = (v2?.data.extensions?.['pitavern'] ?? {}) as PitavernExtension;
  const id = slugify(data.name);

  // 1. 主体 → 角色卡（M12：空壳群像包除外——description/personality/scenario 全空
  //    且 world book 有人物志/内容时，主体只是容器壳：不生成 NPC 角色，
  //    first_mes 作为「世界开场白」由 importCards 出口提升为 worldGreeting）
  const personality = (data.personality || '').trim();
  const scenario = (data.scenario || '').trim();
  const descTrim = (data.description || '').trim();
  const v2meta = v2?.data ?? null;
  const bookEntries = v2?.data.character_book?.entries ?? [];
  const poolishBook = bookEntries.some((e) => e.enabled && (e.keys?.length ?? 0) > 0) || bookEntries.filter((e) => e.enabled).length >= 3;
  const isHollowShell = descTrim === '' && personality === '' && scenario === '' && poolishBook;
  if (!isHollowShell) out.push({
    kind: ext.kind === 'scene' ? 'scene' : 'character', // 允许显式声明为场景卡
    id,
    name: data.name,
    body: descTrim,
    personality: personality || undefined,
    scenario: scenario || undefined,
    speechStyle: ext.speechStyle,
    openingLine: data.first_mes || ext.openingLine,
    source: v2 ? 'v2' : 'v1',
    // V2 元数据原样保留（round-trip）
    ...(v2meta
      ? {
          mesExample: v2meta.mes_example || undefined,
          alternateGreetings: v2meta.alternate_greetings && v2meta.alternate_greetings.length > 0 ? [...v2meta.alternate_greetings] : undefined,
          systemPrompt: v2meta.system_prompt || undefined,
          postHistoryInstructions: v2meta.post_history_instructions || undefined,
          creatorNotes: v2meta.creator_notes || undefined,
          creator: v2meta.creator || undefined,
          characterVersion: v2meta.character_version || undefined,
          tags: v2meta.tags && v2meta.tags.length > 0 ? [...v2meta.tags] : undefined,
        }
      : {}),
  });

  // 2. character_book.entries → 世界库卡片（M11 五分类流水线，尊重 ST 语义）：
  //    player({{user}}人设,默认常驻) > constant(世界观/主线/规则,常驻) > 人物志(角色池)
  //    > 事件记忆(非常驻)。标题命名 + mclass 嗅探；条目字段 constant/position/order 直读。
  const book = v2?.data.character_book;
  if (book?.entries?.length) {
    for (const e of book.entries) {
      if (!e.enabled) continue;
      const content = e.content ?? '';
      const keys = e.keys ?? [];

      // ---- ① 玩家档案：{{user}} 人设（默认常驻：玩家是谁始终该知道） ----
      const looksLikeUser =
        keys.length === 0 &&
        /^\s*\{\{user\}\}[，,：:\s(（]/.test(content) &&
        content.length < 4000;
      if (looksLikeUser) {
        const nm = content.match(/\{\{user\}\}\s*[（(]([^）)]+)[）)]/);
        out.push({
          kind: 'character',
          id: newId('player'),
          name: nm ? `玩家·${nm[1]!.trim()}` : '玩家角色',
          body: content.replace(/^\s*\{\{user\}\}\s*[，,：:\s]*/, ''),
          player: true,
          constant: e.constant !== false, // 缺省常驻（作者显式关掉则非常驻）
          source: 'v2',
        });
        continue;
      }

      // ---- ② 常驻卡：作者标 constant:true，或 keys 空的结构化长文（世界观/大纲/规则） ----
      const looksConstant =
        e.constant === true ||
        (keys.length === 0 && content.length > 200 && !looksLikeUser);
      if (looksConstant) {
        // mclass 嗅探 + 标题命名
        const head = content.slice(0, 300);
        let mclass: 'worldview' | 'plot' | 'rule' | 'event' = 'event';
        if (/(世界观|世界详情|世界名称|地理格局|大陆|城邦|位面)/.test(head)) mclass = 'worldview';
        else if (/(主线|剧情大纲|大纲|剧情结构|第一阶段|第.阶段|剧情线)/.test(head)) mclass = 'plot';
        else if (/(规则|规则集|设定集|羁绊规则|状态|指令|写作|文风|大纲说明|提示)/.test(head)) mclass = 'rule';
        // 标题：优先 # 标题行 / 「」内名 / 首行文本
        let cname = e.name;
        if (!cname || cname === '常驻') {
          const t1 = head.match(/^#+\s*(.+)$/m);
          const t2 = head.match(/^[\-—>]*\s*([^：:<>\n]{2,24}?)[：:]/);
          const t3 = head.match(/^---\s*\n#\s*(.+)$/m);
          cname = t1?.[1]?.trim() ?? t3?.[1]?.trim() ?? t2?.[1]?.trim() ?? '常驻设定';
          // 标题行「名字 - 副题」：主名与卡主体同名 → 副题才是内容类型名（取副题）
          const dashM = cname.match(/^(.+?)\s*[-—]\s*(.+)$/);
          if (dashM && dashM[1]!.trim() === data.name && dashM[2]!.trim().length >= 2) {
            cname = dashM[2]!.trim();
          } else {
            cname = cname.replace(/\s*[-—].+$/, '').trim();
          }
          cname = cname || '常驻设定';
        }
        out.push({
          kind: 'memory',
          id: newId('mem'),
          name: cname.slice(0, 40),
          body: content,
          keys,
          constant: true,
          mclass,
          source: 'v2',
        });
        continue;
      }

      // ---- ③ 人物志 → 角色池（别名丰富 / 双面设定体 / 标题体；作者标 constant 的角色常驻） ----
      const looksChar =
        (keys.length >= 2 && content.length > 80) ||
        (keys.length === 1 &&
          content.length > 200 &&
          /表面上|实际上|【基本信息】|【身份背景】/.test(content.slice(0, 300)));
      if (looksChar) {
        let cname = keys[0] ?? '角色';
        const head = content.slice(0, 200);
        const t1 = head.match(/^#+\s*(.+?)\s*[-—].*$/m);
        const t2 = head.match(/^([\u4e00-\u9fffA-Za-z·]{2,8}?)[，,]\s*约?\s*\d/);
        const t3 = head.match(/^([\u4e00-\u9fffA-Za-z·]{2,8}?)，.*?(?:他|她)/);
        if (t1?.[1]) cname = t1[1].trim();
        else if (t2?.[1]) cname = t2[1];
        else if (t3?.[1]) cname = t3[1];
        out.push({
          kind: 'character',
          id: newId('char'),
          name: cname,
          body: content,
          keys,
          // 作者标 constant 的人物志 → 常驻角色（始终该知道其存在/设定）
          constant: e.constant === true ? true : undefined,
          source: 'v2',
        });
        continue;
      }

      // ---- ④ 事件记忆兜底（非常驻，路由按关键词抽） ----
      out.push({
        kind: 'memory',
        id: newId('mem'),
        name: e.name ?? keys[0] ?? '记忆',
        body: content,
        keys,
        source: 'v2',
      });
    }
  }

  // 3. extensions.pitavern.scenes → 场景卡
  for (const s of ext.scenes ?? []) {
    out.push({
      kind: 'scene',
      id: s.id ?? slugify(s.name),
      name: s.name,
      body: s.description,
      presentCharacterNames: s.presentCharacterIds?.map((cid) => cid) ?? [data.name],
      source: 'v2',
    });
  }

  // 4. extensions.pitavern.npcs → 独立角色卡
  for (const n of ext.npcs ?? []) {
    out.push({
      kind: 'character',
      id: n.id ?? slugify(n.name),
      name: n.name,
      body: n.description ?? '',
      personality: n.personality || undefined,
      source: 'v2',
    });
  }

  // 5. extensions.pitavern.items → 物品卡
  for (const it of ext.items ?? []) {
    out.push({
      kind: 'item',
      id: it.id ?? slugify(it.name),
      name: it.name,
      body: it.description,
      source: 'v2',
    });
  }

  // 6. extensions.pitavern.world → 世界观卡（system）
  if (ext.world) {
    out.unshift({
      kind: 'system',
      id: ext.world.id ?? slugify(ext.world.name),
      name: ext.world.name,
      body: ext.world.rules.join('\n'),
      source: 'v2',
    });
  }

  // ---- ⑦ 防撞 id：同包内重名卡（如 character_book 里两条「郑剑」人物志/同名记忆）
  //      会被 toInternalCard 的 slugify 拍成同一个 id → 后者覆盖前者、静默丢卡。
  //      凡与先前卡（含主体角色卡）id 冲突的记忆卡/场景卡，改挂唯一随机后缀。 ----
  dedupeIds(out);
  return out;
}

/** 世界包拆分：characters 逐个拆 + scenes/items/lore */
function splitWorldPack(pack: WorldPack): ImportedCard[] {
  const out: ImportedCard[] = [];
  const worldId = pack.world.id ?? slugify(pack.world.name);

  // 世界观卡
  out.push({
    kind: 'system',
    id: worldId,
    name: pack.world.name,
    body: pack.world.rules.join('\n') + (pack.world.description ? `\n${pack.world.description}` : ''),
    source: 'worldpack',
  });

  // 每个角色卡拆分（挂 worldId 归属）
  for (const c of pack.characters) {
    const parts = splitCharacterCard(c, pack.world.name);
    // 世界包里的角色卡，扩展里带的场景如果没指定 world，都归到本世界
    for (const p of parts) {
      // 场景卡的 presentCharacterNames 需要能被主角色名引用
      out.push(p);
    }
  }

  // 独立场景卡
  for (const s of pack.scenes ?? []) {
    out.push({
      kind: 'scene',
      id: s.id ?? slugify(s.name),
      name: s.name,
      body: s.description,
      presentCharacterNames: s.presentCharacterNames ?? [],
      source: 'worldpack',
    });
  }

  // 独立物品卡
  for (const it of pack.items ?? []) {
    out.push({
      kind: 'item',
      id: it.id ?? slugify(it.name),
      name: it.name,
      body: it.description,
      source: 'worldpack',
      // M10：物品所有权
      ...(it.ownerCharacterId ? { ownerCharacterId: it.ownerCharacterId } : {}),
    });
  }

  // 全局 lore → 记忆卡
  for (const l of pack.lore ?? []) {
    out.push({
      kind: 'memory',
      id: newId('mem'),
      name: l.keys[0] ?? '世界记忆',
      body: l.content,
      keys: l.keys,
      source: 'worldpack',
    });
  }

  // 世界包多角色：各卡 id 可能互撞（如同名角色），跨角色统一去重
  dedupeIds(out);
  return out;
}

/* ------------------------- 主入口 ------------------------- */

export interface ImportOptions {
  /** 世界 id（未指定时从内容推断） */
  worldId?: string;
}

/**
 * 解析任意导入内容（PNG Buffer 或 JSON 文本/对象）→ ImportResult。
 * 这是前端/CLI 上传的统一入口。
 */
export async function importCards(input: Buffer | string | unknown, opts: ImportOptions = {}): Promise<ImportResult> {
  let raw: unknown = null;

  if (Buffer.isBuffer(input)) {
    // PNG 嵌卡
    const png = await parsePngCard(input);
    if (png) raw = png;
    else {
      // 也许 Buffer 里直接是 JSON 文本
      try {
        raw = JSON.parse(input.toString('utf8'));
      } catch {
        throw new Error('无法识别文件：不是 PNG 嵌卡也不是 JSON');
      }
    }
  } else if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new Error('JSON 解析失败');
    }
  } else {
    raw = input;
  }

  const { world, cards } = parseCardJson(raw);
  if (cards.length === 0 && !world) {
    throw new Error('未识别的卡格式（需 V1/V2 角色卡或 pitavern-world 世界包）');
  }

  const imported: ImportedCard[] = [];
  // M12：空壳群像包的 first_mes 提升为「世界开场白」（worldGreeting，importCards 出口带出）
  let worldGreeting: { speaker: string; text: string } | null = null;
  if (world) {
    imported.push(...splitWorldPack(world));
  } else {
    for (const c of cards) {
      const parts = splitCharacterCard(c);
      // V1 用顶层 name，V2/V3 用 data.name
      const mainName = ((c as TavernCardV2).data?.name ?? (c as TavernCardV1).name) as string;
      // 主体角色存在 = 有非玩家、同名的 character 卡（玩家卡 {{user}} 人设不算主体）
      const mainExists = parts.some((p) => p.kind === 'character' && !(p as { player?: boolean }).player && p.name === mainName);
      if (!mainExists && !worldGreeting) {
        const fm = (((c as TavernCardV2).data?.first_mes ?? (c as TavernCardV1).first_mes) ?? '').trim();
        if (fm) worldGreeting = { speaker: '', text: fm };
      }
      imported.push(...parts);
    }
    // 多卡输入（理论上仅单卡，防御）：跨卡 id 去重
    dedupeIds(imported);
  }

  // PNG 嵌卡：PNG 图像本身即角色头像 → 挂到拆出的第一个「主体/玩家」角色卡
  // （空壳群像无主体角色 → 世界头像由前端/选卡 UI 兜底，不挂池 NPC）
  if (Buffer.isBuffer(input) && input.length > 8 && input.readUInt32BE(0) === 0x89504e47) {
    const firstChar = imported.find((c) => c.kind === 'character' && ((c as { player?: boolean }).player || !worldGreeting)) ?? imported.find((c) => c.kind === 'character');
    if (firstChar && !firstChar.avatar) {
      firstChar.avatar = `data:image/png;base64,${input.toString('base64')}`;
    }
  }

  // 汇总
  const summary = {
    world: world?.world.name,
    characters: imported.filter((c) => c.kind === 'character').map((c) => c.name),
    scenes: imported.filter((c) => c.kind === 'scene').map((c) => c.name),
    items: imported.filter((c) => c.kind === 'item').map((c) => c.name),
    memories: imported.filter((c) => c.kind === 'memory').length,
  };

  return { cards: imported, summary, ...(worldGreeting ? { worldGreeting } : {}) };
}
