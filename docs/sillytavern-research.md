# SillyTavern 架构研究：对 PiTavern 的借鉴报告

> 面向 PiTavern（本地多人在线 RPG 交互引擎：路由抽卡 → 上下文组装 → 流式演员 → 后台结算）。
> 本文所有 SillyTavern 内容均来自对官方文档 / 规范的检索（URL 见文末引用），PiTavern 建议已对照当前代码（`src/cards/schema.ts`、`src/types.ts`、`src/pipeline.ts`、`src/db/store.ts`、`src/web/server.ts`）。
> 当前日期 2026-02-09；SillyTavern 官方文档版本为 2026 年（Docusaurus 生成的 2026 copyright），最新稳定分支为 release。

---

## 1. 人物卡：Character Card V2 spec

### 1.1 SillyTavern 的做法

**V1 六字段**：`name` / `description` / `personality` / `scenario` / `first_mes` / `mes_example`。V2（`malfoyslastname/character-card-spec-v2`，现由 SillyTavern 维护）把 V1 全部挪进 `data`，新增：

```ts
type TavernCardV2 = {
  spec: 'chara_card_v2'; spec_version: '2.0';
  data: {
    name; description; personality; scenario; first_mes; mes_example;   // V1
    creator_notes: string;                 // 不得进 prompt；应显著展示给 bot 用户
    system_prompt: string;                 // 默认覆盖全局 system prompt；{{original}} 引用原值
    post_history_instructions: string;     // 默认覆盖全局 ujb/jailbreak（即"文后指令"）
    alternate_greetings: string[];         // 额外的开场白 → 首次消息 swipe
    character_book?: CharacterBook;        // 角色自带 lorebook
    tags: string[]; creator: string; character_version: string;
    extensions: Record<string, any>;       // 任意扩展数据（必有，默认 {}）
  }
}
```

关键规则：`extensions` 必须保留未知键（`MUST NOT destroy unknown key-value pairs`），且推荐命名空间隔离（如 `"agnai": {...}`、`"pitavern": {...}`）。`character_book` 应默认生效、可与用户级 world info 叠加并**优先于**后者。嵌入载体：`.json`、PNG/APNG 的 **`Chara` EXIF 元数据字段**（base64 JSON）。

SillyTavern 自身的人物卡 UI 强调：

- 卡片上有 **token 计数**：字符定义 token 超过模型上下文一半时标红（"Character tokens" 文档）。
- **Permanent tokens**（永远进 prompt）＝ Name + Description + Personality + Scenario；`first_mes` 只在开局发一次；`mes_example` 在上下文占满后被**按块推出**（可配置是否保留）。
- **Alternate Greetings**：多开场白，新开局时作为首条消息的 swipe；进 group chat 时随机抽一条开局。
- **Creator metadata**（creator/version/notes/tags to embed）不用于 prompt 构建，仅列表/详情页展示。
- **Character's Note（@ Depth）**：可指定"在第几条消息之后、以 user/system/assistant 角色注入"的运行时提示（Character design 文档）。
- 人物卡还有 **talkativeness** 滑块（group chat 用）。
- 还有**群聊卡**与 `{{group}}`/`{{groupNotMuted}}` 宏（Group Chats 文档）。**Assets**（头像/背景/主题）在 ST 里是"按文件类型注册的下载/导入内容"（multi-user scaffold 列表：character/sprites/background/avatar/theme…），用户级与角色级内容分目录存储。

### 1.2 对 PiTavern 的借鉴建议

现状对照：`src/cards/schema.ts` 已完整实现 V1/V2 + `data.extensions.pitavern`（含 kind/worldId/scenes/npcs/items 等）。建议：

- **字段补齐（P1）**：在 `TavernCardV2.data` 转换到内部 `CharacterCardData` 时，**保留 `creator_notes` / `creator` / `character_version` / `alternate_greetings`**（现在是丢弃/未用）。`CharacterCardData` 增加 `creatorNotes?: string`、`alternateGreetings?: string[]`——alternate_greetings 直接映射你的"多开场白"，导入多个 V2 卡时游戏开局随机一条（对齐 ST 群聊随机 greeting 行为）。
- **补充 `avatar` 到内部卡（P0）**：V1 spec 说 PNG 嵌卡时"头像即该 PNG"；你的 importer 已从 PNG 提头像但 `Card` 类型没有 avatar 字段，无法在聊天列表/消息气泡展示。新增 `Card.avatar?: string(base64)`。
- **extensions 只读保留（P0）**：导入→编辑→再导出要 round-trip 不丢数据：内部卡存一个 `rawExtensions?: Record<string, unknown>`，导出时原样塞回 `extensions`，避免 PiTavern 属性破坏其它工具/卡片的扩展字段。
- **talkativeness（P2）**：在你的在场角色多说话场景，给 `CharacterCardData` 加 `talkativeness?: number`（0–100），供抽卡器决定"没被点名时谁接话的概率"——你现在用 `speakerCharacterId` 强约束，可先用 50% 兜底再让模型加权。
- **卡 token 标红（P1）**：照搬"定义 token > 上下文一半标红"的 UX，前端卡片列表显示 token 数（你的 `utils/tokens.ts` 已具备能力）。

---

## 2. 世界信息 / Lorebook（World Info）

### 2.1 SillyTavern 的做法

World Info（WI）＝"动态词典"：按关键词触发把 lore 条目插进 prompt。V2 spec 里 `character_book` 的条目字段（官方 spec 原文）：

```ts
type CharacterBookEntry = {
  keys: string[]; content: string; enabled: boolean;
  insertion_order: number;            // 数字越小插得越靠前
  case_sensitive?: boolean;
  name?: string; priority?: number;   // token 预算不足时 priority 小的先被丢弃
  id?: number; comment?: string;
  selective?: boolean;                // true 时需 keys 与 secondary_keys 各命中一个
  secondary_keys?: string[];
  constant?: boolean;                 // 恒定插入（预算内）
  position?: 'before_char' | 'after_char';
}
type CharacterBook = {
  name?: string; description?: string;
  scan_depth?: number; token_budget?: number; recursive_scanning?: boolean;
  extensions: Record<string, any>; entries: CharacterBookEntry[];
}
```

ST 文档在条目上还扩展了：**selective 逻辑的 AND ANY / AND ALL / NOT ANY / NOT ALL**、**Probability（触发 %）**、**Inclusion Group（同组同回合只进一条 + 组权重抽选 + Group Scoring 按命中 key 数打分）**、**Character Filter / 按 generation type 过滤**、**Timed Effects**（sticky 停留 N 条 / cooldown N 条不可触发 / delay N 条后才可触发——完全是"游戏 buff/状态"语义）、**Recursion 三态（Non-recursable / Prevent further recursion / Delay until recursion + Recursion Level）**、以及 **Outlet**（`{{outlet::Name}}` 手动决定插入位置的命名出口）与正则 key。

**激活与预算机制**（World Info 文档"Activation Settings"）：

- **Scan Depth**：扫描最近 N 条消息（0 = 只查 recursion/AN；可条目级覆盖）。
- **Include Names**：把说话者名字拼进扫描缓冲（默认开），也可用 `\x01` 分隔做"只匹配某角色的台词"的正则。
- **Context % / Budget**：WI 同时可用 token 上限（相对上下文百分比或绝对预算）。预算耗尽即不再激活；**Constant 条目先插，再按 insertion_order 大的先插**；直接命中 key 的条目 > 被其它条目内容带出的（递归）。
- **Min Activations / Max Depth / Max Recursion Steps**：放宽 scan depth 兜底触发 N 条 / 递归上限。
- **Recursive scanning**：条目内容里出现别的条目的 key 会连锁激活（Bessie→Rufus 例子）。
- **Context-Specific Sources**：同一个 lorebook 可绑定到 character / persona / chat，开聊时按 **Chat Lore → Persona Lore → Character/Global Lore** 合并，排序策略可设 "Sorted Evenly / Character First / Global First"。

**插入位置**：Before/After Char Defs、Before/After Example Messages、Top/Bottom of AN、**@ Depth（以指定角色插到聊天第 N 条处）**、Outlet。V2 卡的 character_book 应默认生效、优先于用户 WI。

### 2.2 对 PiTavern 的借鉴建议

现状对照：PiTavern 记忆卡有 `MemoryCardData { ownerCharacterId, summary, detail, relatedIds, keywords }`，路由阶段用玩家输入做"便利贴"触发（pre-router），是简化版 WI。场景描述、`relatedIds` 是"关系图谱"，更接近 ST 的 key→条目。

- **选择性激活 = 你的"在场 + 提及"双条件（P1）**：给 `MemoryCardData` 增加 `selective?: boolean` + `secondary_keys?: string[]`。语义现成：`relatedIds`（在场景/在场角色集合里）+ `keywords`（在文本里）——把 PI 的"对话命中"推广成"对话命中一个 + 在场上下文命中一个"，可做 NPC 私密记忆。
- **插入顺序（P1）**：WI 的 `insertion_order`/`position` 提醒一个 PiTavern 缺口：现在路由返回的是无序 id 列表。**给 RouteDecision 的内存/物品清单加序**（如 memoryCardIds 有序即插槽顺序），并按优先级把"每回合恒定在场"的卡片（currentScene + residents）与便利贴区分：其实这正好是 assembler 的四插槽，建议 slots 输出里加 `position: 'before_system'|'after_scene'` 语义字段，不一定要新配置 UI。
- **token_budget（P0）**：assembler 现在只有 `tokenEstimate` 全量估算，没有预算上限。引入 `assembleBudget`（`maxContext - 响应预留`），填满即停——照 WI 的规则：**恒定的先装，再按顺序，超预算的记入"被裁剪清单"回传前端**（对齐"context depth debugger"精神，见 §7）。
- **递归扫描（P1）**：你的 `relatedIds` 已经是图；实现"装进上下文的记忆正文里若提到另一条记忆的关键词（或 relatedId 的 name）→ 补装"，加递归深度上限 2。对 RPG 非常有用：提到"安德鲁"就把他与艾莉西亚决裂的旧账一起带出。
- **scan_depth 语义迁移（P1）**：ST 扫"最近 N 条消息"，你的 pre-router 已有 `historyWindow`（默认 6）——让它同时成为记忆触发扫描窗口（现在可能是全窗口或单条输入，需对齐文档）。
- **Probability / Timed Effects（P2，很出彩）**：随机触发（1% 概率唤醒 Eldritch 神）＝天然的"随机遭遇/彩蛋"机制；sticky/cooldown 与游戏状态机天然吻合。可在 memory 卡加 `probability?: number` 与可选 `cooldownTurns`，路由阶段吃两个字段即可，成本低。
- **多来源合并（P1）**：PiTavern 已有"世界级 lore + 角色级记忆"，建议存储层允许 lorebook 绑定 chat/character（store.ts 现有 chat meta，可加 `lorebookIds`），对齐 ST 的 Chat/Character Lore。

---

## 3. 对话流程与提示词工程

### 3.1 SillyTavern 的做法

ST 有两条并存的 prompt 构建线：

**A. Text Completion + Instruct Mode**：把"上下文模板（Context Template / Story String，Handlebars）"与"聊天历史"拼成一整段文本。Story String 可放 `{{description}}` `{{personality}}` `{{scenario}}` `{{system}}` `{{persona}}` `{{wiBefore}}`/`{{wiAfter}}` 等插槽；**如果模板里没有某个插槽，该部分就完全不进 prompt**。Instruct Mode 预设（instruct preset）提供 **角色/前缀/后缀序列**：User/Assistant/System Message Prefix+Suffix、First/Last Assistant Prefix、System Instruction Prefix、User Filler、Stop Sequence 等——例如 Llama2 系要求"首条必须 user 开头"，就靠 **User Filler** 兜底。

**B. Chat Completion + Prompt Manager**：一个可拖拽排序的 **prompt 列表**（默认钉住：Main Prompt、World Info、Persona、Char Description/Personality/Scenario、Chat Examples、Chat History、Post-History Instructions…），每条可设 Role（system/assistant/user）、**Position = 列表内相对 或 in-chat @ Depth**、Order，还可按 **Trigger（Normal/Continue/Swipe/Regenerate/Impersonate/Quiet）** 决定哪些请求发这条 prompt——即"同一套设置按生成类型给出不同 prompt"。

**提示词工程要点（Prompts 文档）**：

- 主提示默认即 "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}."；宏 `{{char}}`/`{{user}}` 替换名字，V1 spec 还要求字段里 `{{char}}`/`<BOT>` **大小写不敏感**替换。
- **Post-History Instructions（PHI）**：发在最后一条消息之后（多数模型最重视的位置），ST 明确说"PHI 常能覆盖主提示"；建议"把希望模型做的事放前面、别做的事别写（不要写 'Do not…'）"。
- **历史截断**：character 定义是永久 token；example messages 可整块被挤掉（"Example Messages Behavior: 按块推出"）；对话历史同样在超限后裁掉最旧的——但可指定某条消息"不参与生成"（message included/excluded 开关），关键消息还能用 @ Depth 固定在历史深处。
- **regex 脚本**：还有一套独立的 **Regex extension**，在"消息显示前后 / 发送前 / 生成后"对文本做正则替换，用 **find/replace** 预设实现角色标签、注入等（docs 中 Regex scripts 被多处引用为推荐方案，例如 deprecated 的 "Wrap in Quotes" 被引导改用 regex）。
- **Summary（长期记忆）**：Summarize 扩展（默认内置）用独立 prompt 生成**增量摘要**（Raw/Classic 两种构建方式），摘要**存进聊天文件 metadata 并绑定到"生成时最后一条消息"**——删掉/编辑那条消息会回滚到上一个有效摘要；提供 `{{summary}}` 宏 + Injection Template/Position（如 @Depth）注入；间隔可按"每 X 条消息 / 每 X 词"自动触发，甚至提供"魔棒"根据上下文大小启发式估算最优间隔（summarize 文档给出的公式：`max summary buffer = context - 摘要 prompt - 旧摘要 - 响应长度`）。

### 3.2 对 PiTavern 的借鉴建议

- **把"组装"变成可预览可测的模板线（P0）**：你现在 `assembleCards` 直接拼 `prompt` 字符串。建议对齐 ST 分两半：`slots: AssembledContext.slots`（已存在）→ 渲染模板（可含 `{{scene}}`/`{{rules}}`/`{{char}}`/`{{memories}}` 等宏）。好处：同一拼装逻辑支撑"演示视图（角色卡/场景/记忆分块高亮）+ 调试视图（拼完的全文）+ 发给模型"三份产物，还能做**提示词预览**。
- **宏引擎轻量版（P1）**：PiTavern 最需要的是 `{{user}}`/`{{char}}`/`{{random::a::b}}`（ST 宏：`{{random}}` 每次随机、`{{pick}}` 每聊天稳定、`{{roll}}` droll 语法）与 `{{original}}`。你在 demo seed 里已有 `<user>` 占位（systemCard.rules 出现"扮演<user>"）——统一成 ST 风格 `{{user}}` 大小写不敏感替换即可。`{{random}}` 对"每次回复前掷骰决定反应"是零成本亮点。
- **例对话的"先有后挤"策略（P2）**：`mes_example` 现在被直接忽略。可以低成本复刻"上下文未满时才插入、满了按块挤出"：先装 example 到固定上限，装不下历史时 example 先让位。对 RPG 更有用的是把 ST 的 **`<START>` 块替换语义**借用：你的 importer 已支持 V1 mes_example，可以直接按 `<START>` 切块。
- **PHI / post_history_instructions（P1）**：V2 卡导入时，把 `post_history_instructions` 存进角色卡（schema 已留口）并在 actor 阶段作为**最后一段 system 文本**发出去（你 actor 用的是单条 systemPrompt + messages——把 PHI 拼到 prompt 尾部或作为最后一条消息）。
- **Summary 化（P1，重要）**：你的 `WorldState`/chat 没有长期记忆收敛机制，回合长了必然靠窗口截断。建议最小实现：`chat:{id}:meta` 加 `summary?: string` 与 `summaryAtMsgId?: string`；回合结算（post-evaluator，正好是后台阶段）里顺带触发"每 N 回合用小模型生成/合并摘要"，把"好感度 + innerThought + 摘要"持久化。尤其可抄 ST 的**回滚规则**：消息被编辑/删除后摘要回滚到上一个锚点——这对"跑团回档"很关键。
- **Instruct 前缀（P1）**：给你的"user 消息/NPC 消息"预留"首条特殊前缀"语义（对齐 First User Filler）其实可加可不加，但建议 assembler 的 history 段支持 role 级 wrap 序列配置（如把玩家指令包成 `> 动作`），这与 ST 的 instruct 前缀同构，能给未来接本地 llama.cpp 类模型留口。

---

## 4. 前端 UI / UX

### 4.1 SillyTavern 的做法

- **三栏布局**：左"角色/群聊列表"（搜索、排序：字母/时间/用量/体积/收藏、标签当文件夹、HotSwap 快捷收藏条），中间聊天，右侧/浮出各面板（角色管理、World Info、扩展、设置）；面板可 Pin 住。
- **消息层交互**：每条 AI 消息带按钮组：**Swipe（换一条新回复，生成另一版本）**、Edit、Regenerate、Impersonate、**Continue（快速续写）**、翻译/配图/朗读；编辑面板内可直接 **delete / 上移 / 下移** 该条消息；**消息可标"included/excluded"**（AI 看不到但人可见，比如 OOC 备注、GM 悄悄话——ST 有 `/comment` 隐形消息 + 角色为 user/system/assistant 的任意注入）。swipe 用 **左右方向键**快捷键。
- **流式渲染**：回复是 token 流式到达边生成边渲染，`Smooth Streaming` 逐 token 刷新；UI 上 **Message Timer**（生成耗时）、Message Token Count、Message IDs、Model Icons、Chat Timestamps 都可开关；消息显示 "typing" 状态；"Blip" 扩展还能逐字打字动画。
- **分支与检查点**：任意消息上可 "Create Branch / Create Checkpoint"（克隆到该点并可选切换），支持"回到父聊天"；这是 RPG 存档/回溯的核心。
- **导入导出**：PNG（嵌 Chara 字段）/JSON 导入；聊天可导出 **.jsonl（含 metadata，可再导入）或 .txt（纯文本）**；聊天卡、世界书均可导出分享；官方维护 **"Download Extensions & Assets"** 资源目录（可下载社区角色卡）；用户 UI 侧把角色卡列表做成 **Gallery 视图**。
- **UI 自定义**：主题文件（颜色/字体/CSS/聊天宽度等全部做成可导出主题）、flat/bubbles/document 三种聊天样式、Avatar 形状、Custom CSS 全量覆盖、Visual Novel 模式（背景图+立绘）、MovingUI（浮动面板可拖）。
- **多语言**：官方有 i18n 支持（Administration 菜单旁的国际化页面；登录/设置等文案可翻译，社区提供多语言）。
- **身份**：persona 系统可做"锁定到 chat / 锁定到 character / default"，切聊天自动切人设，`/persona-sync` 批量改写历史消息归属。

### 4.2 对 PiTavern 的借鉴建议

你的 `web/index.html` 单页聊天已带四阶段事件面板。按价值排序：

- **swipe（P0）**：生成另一回复 = 对你 actor 阶段再跑一次（同一 RouteDecision 缓存复用即可），气泡显示"第 N/3 版"；语义上与"换一种说法"天然契合。
- **消息 included/excluded + OOC 行（P0）**：HistoryLine 增加 `excluded?: boolean`；UI 加"此条不进上下文"开关。RPG 的 GM 指令、桌面规则修正、玩家 OOC 讨论都靠它，成本极低（assembler 过滤一下）。
- **消息编辑 + 上移/下移 + 删除（P1）**：编辑消息后**必须**重算后续回合（你的历史是 LIST 快照，目前没有 edit 接口——补 `updateChatMessage/deleteChatMessage` 即可）。
- **Continue 续写 / 分支检查点（P1）**：聊天 UI 加"延续上一条"（直接对 actor 再发一次请求，historyWindow 从该条起）与"从此处分支"（clone chat 到该消息并 store 链接到父 chat，ST 语义照抄）。
- **流式体验细节（P1）**：你已 push delta；补：生成中显示"正在打字/第 N 阶段"状态条 + 每条消息的耗时徽标（pipeline 已回传 timings，前端没显示）、消息 token 数、回合 requestId 可复制（排查用）。**不要**学 ST 全部塞进右侧设置面板：PiTavern 的调试信息应放可折叠"面板"，游玩主界面保持干净。
- **时间轴/世界状态条（P1）**：ST 没有对应的"世界状态持久条"概念，这是你的差异化空间：顶部或侧边常驻显示 场景名/在场角色/好感度/回合数（server 已有 `world` 事件推送 state）。
- **PNG 导出嵌卡（P1）**：`cards/importer.ts` 已能解 PNG 嵌卡，补一个"导出为 PNG 人物卡"（前端画布或 node 端把 JSON base64 写进 Chara 字段）即可打通生态双向。
- **多语言/主题（P2）**：先不做 i18n 框架，但建议所有文案抽 `strings.ts`（避免后面返工）；CSS 变量化主题低优先。

---

## 5. 后端架构："本地优先 + 可选服务端"

### 5.1 SillyTavern 的做法

**本质**：SillyTavern 是"本地 Node 静态服务器 + 浏览器端应用"。后端默认只做两件事：托管前端静态资源、提供少数**数据读写代理**（如文本文件的读/写/上传），把请求转发给外部 LLM API（key 保存在服务端进程内/用户目录，避免在浏览器暴露）。真正的前端数据管理在浏览器端：**`localStorage`（设置）+ IndexedDB/文件读写（聊天、角色、WI 等大量数据）**，聊天可存成 `.jsonl` 文件由服务器管理（"server" 模式支持文件系统后端），数据布局就是文件树：

```
data/[user-handle]/            # 每用户一目录：characters/ chats/ world-info/ backgrounds/ themes/ …
data/_cache、_css、_errors、_storage、_uploads、_webpack   # 系统目录
```

**多用户（multi-user 文档）**：`config.yaml` 里 `enableUserAccounts: true` 启用账号系统；每个 user handle（`[a-z0-9-]`）一个数据目录；角色分 Admin / User；可加密码（仅"基本隐私"，文档明示不做安全边界）；还提供 **content scaffold**（`/default/scaffold/index.json` 声明字符/背景/主题等模板，用户建号时自动拷贝）与 settings.json 快照回滚。文档明确警告**不要公网裸奔**，建议 whitelist/反向代理/HTTPS/SSO。前端扩展机制＝**Extensions**：内置一批（Summarize、TTS、Stable Diffusion、Regex…），第三方扩展以 **git 仓库**安装（`Extensions → Install extension` 贴 URL + 分支），加载为前端模块；扩展可注册宏、slashes 命令、UI 按钮与面板、prompt injection（anchor 机制）、消息动作等；`{{hasExtension::name}}`、STscript 把这些打通。**UI 可扩展**：扩展从"Download Extensions & Assets"目录安装；官方明确 Extras（老式 Python 独立服务）已于 2024-04 废弃。

**群聊多角色**（Group Chats 文档）：组内回话用 **Reply Order Strategy**（Manual / Natural / List / Pooled）；"Natural Order"按消息中提及谁的名字 + **talkativeness** 概率选角，模拟真人对话。**Group generation handling**：默认 **Swap character cards**（每次只注入当前发言者的卡，省 token、角色不串味）或 **Join character cards**（把全体角色字段合并成联合 prompt，稳定 prompt cache）；组内支持 **mute / force talk / auto-mode（5 秒后自动触发下一角）/ scenario override**；聊天历史全组共享。

### 5.2 对 PiTavern 的借鉴建议

PiTavern 的架构（服务端控制流水线 + Redis/内存存储 + WS 推送）与 ST 相反但**更适合多人共玩一局**——建议保持，学 ST 的组织方式：

- **存储分层抽象已就位（P0 保持）**：`CardStore` 接口 + Redis/内存实现 = ST 文件系统的同构替代；进一步：**每"世界"一个目录/前缀**（现键空间已是 `world:{id}:*`），未来加"按房间分片"（Redis cluster / namespace）成本低。**落盘策略**建议补 **TTL 关**：现在 `RedisCardStore` 默认 7 天过期，RPG 存档不应过期——提供 `ttl=0`（永不过期）并按用户配置。
- **用户/会话隔离（P1）**：ST 的"user handle → data 目录"值得借鉴：给 store 键加 `user:` 前缀或 world 归属校验（`world:{id}:owner`），登录会话绑定 owner，避免多玩家互相改卡（你 ws server 里 `ClientSession` 尚无身份）。
- **静态资源 + API 同源（P1）**：ST 的单进程静态托管很朴素但很稳。你已是同源 http+ws，注意**不要把模型 API key 下发到浏览器**（现架构 key 在服务端解析，正确）。
- **扩展机制别学太重（P2）**：ST 的扩展系统本质是"可插拔前端模块 + 统一注册表（宏/slash 命令/面板/anchor）"，维护成本高、安全性差（文档明示三方扩展有风险）。PiTavern 更适合**插件 = 数据包 + 事件钩子**：定义 `PipelineHook { onRoute?(...), onAssemble?(...), onActorDelta?, onSettle? }`，卡片/世界包可通过 `extensions.pitavern.hooks` 声明，流水线在固定点调用——这与 ST 的 anchor/injection 异曲同工但类型安全得多。核心扩展（摘要、翻译）先内置。
- **多人协作锁（P1）**：ST 没有实时协作；你的 `turnLock` 只锁单进程内存。升级为**分布式回合锁**（Redis `SET NX EX` 按 chatId），并把 `WorldState` 乐观版本化（`version` 字段 CAS 更新）——这是"多人在线 RPG"的根基（同一房间两名玩家同时行动会互相覆盖 chat 历史）。

---

## 6. 身份与多人机制

### 6.1 SillyTavern 的做法

- **Persona**：身份=名字+头像+描述文本+**注入位置**（Story String / Top|Bottom of AN / in-chat @ depth），支持"persona 锁定"（chat 锁、character 锁、default persona 三级，切聊天自动切人）；`{{persona}}` 宏进 prompt；`/persona-sync` 把历史用户消息改挂到当前 persona。
- **群聊（Group Chats）**：见 §5.1 的回复策略与卡片合并策略；另外**场景切换**：聊天内可做 scenario override（全体成员共享场景描述覆盖）；World Info 可绑到聊天/角色。
- ST 本身是"一个人玩多角色"的框架，**实时多人同玩一局并不是它的目标**——它解决的是"一个人管理大量身份与群组"。

### 6.2 对 PiTavern 的借鉴建议

- **玩家人设（persona）落库（P0）**：你现在的 `HistoryLine.speaker: 'user' | string`——把"玩家身份"升级为可切换对象：`UserProfile { userId, displayName, description, avatar }`，进 prompt 的 `{{user}}` 用 displayName + description；chat meta 记录"参与玩家列表"（多人一局谁在场）。
- **角色锁定（P1）**：ST 的"character 锁 persona"可直接借鉴为"每个世界/会话记录每个玩家的 `playerCharacterId`"（谁扮演艾莉西亚/安德鲁）——跑团"团里每个人领一个角色"。
- **把 ST 群聊策略搬进多 NPC 场景（P2）**：Natural Order 的"提到谁的名字谁回应 + talkativeness 概率"正是你多人场面的好补丁——你的抽卡器目前决定 speakerCharacterId；当"多名在场角色都被点名"时用 talkativeness 权重随机，而不是每次模型硬挑。

---

## 7. 其它亮点：开发者/玩家小工具

### 7.1 SillyTavern 的做法

- **Prompt 可视化**：消息菜单 "Prompt" 可看**该次生成实际发给模型的完整 prompt**；"Prompt Itemization" 展示各组成块；Prompt Inspector 扩展可在发送前审改。
- **Token 计数**：多处即时 token 计数（角色卡、消息级 Message Token Count、Token Counter 内置扩展）。
- **成本/用量统计**：设置里可配 API 用量与估算成本（usage tracking、token 日志统计）。
- **Context depth debugger**：ST 文档中 Prompt Itemization 直接支持 **context depth**：把 prompt 按"最旧→最新"深度标注，显示每块在哪一层（对应 In-chat @ Depth 注入）；"Prompt Itemization"图标即干这事。
- **Token Probabilities 面板**：可点击 token 看备选词及概率，甚至"换一个词重新生成"（reroll）。
- **消息级开关**：message included/excluded、Message IDs、Chat Timestamps、per-message "view prompt"。
- **自检向**：`/? macros` 列出全部宏，Autocomplete（Ctrl+Space）在任何宏字段可用；正则脚本可预览替换结果。

### 7.2 对 PiTavern 的借鉴建议

- **组装预览与"深度条"（P0）**：assembler 已返回 slots；前端把最终 prompt 按 slot 分块展示（哪些卡、多少 token、历史窗口多大、裁掉了哪几条记忆），渲染成"上下文深度条/水位线"。这直接服务你"四阶段流水线"的调试叙事。
- **requestId 贯穿 + 耗时（P1）**：已有 requestId/timings——补一个只读"回合抽屉"：本回合 路由决策 JSON、被裁记忆清单、各阶段耗时、token 数。
- **成本统计（P1）**：actor/路由/evaluator 三模型各异，按回合记录 `{requestId, stage, model, inTokens?, outTokens}` 到 Redis（`stat:turn:*` 或 append-only list），前端给"本回合/本会话/总计 token 与费用（按配置单价）"。
- **消息状态徽标（P2）**：Message IDs/Timestamps/Timer 这类低成本开关让调试类反馈用户直接可用。

---

## 8. 建议优先级清单

### P0（先做，影响核心玩法闭环）
1. 人物卡 V2 字段 round-trip：`alternate_greetings`/`creator_notes` 入库，`Card.avatar` 落地并展示（聊天列表/气泡）。
2. 消息级 `excluded`（不进上下文的 OOC/GM 行）+ 对应 UI 开关（assembler 过滤）。
3. 上下文预算 `budget`：恒定量先装、按序补装、超限清单回传；slots 增加"被裁剪项"。
4. assemble 模板化 + 前端"组装预览/深度水位条"（分块显示每 slot 内容与 token）。
5. 玩家 persona 落库（displayName/description/avatar 进 prompt 的 `{{user}}`）。
6. 分布式回合锁（Redis SET NX）+ WorldState 版本化 CAS（多人同房间防互相覆盖）。

### P1（体验与可运维性）
7. swipe 换回复 + 多版本存储（复用一次 RouteDecision 重跑 actor）。
8. 消息编辑/删除/上移下移 接口与 UI；chat 摘要锚点与回滚规则（对齐 Summarize）。
9. V2 `post_history_instructions` → actor prompt 尾部（PHI 语义）。
10. 记忆卡 `selective`+`secondary_keys`、`token_budget`、递归扫描（relatedIds/关键词补装，深度≤2）。
11. 记忆触发用 `scan_depth=historyWindow` 语义并文档化。
12. 上下文宏引擎（`{{user}}`/`{{char}}`/`{{random::}}`/`{{original}}`，大小写不敏感）+ 模板 autocomplete 可后置。
13. chat 存档 TTL 可关 + 用户/世界归属隔离；导出 JSONL/PNG 嵌卡双向。
14. 成本/用量统计（requestId 维度落 Redis）+ 回合抽屉（决策 JSON、耗时、裁减清单）。
15. 世界状态条常驻 UI（场景/在场/好感度/回合数——服务端已推 `world` 事件）。
16. Continue（续写上一条）与 Branch/Checkpoint（克隆会话，链接父 chat）。

### P2（锦上添花）
17. 记忆/事件 `probability`（随机遭遇彩蛋）与 timed effects（sticky/cooldown 语义）。
18. Natural Order 群聊策略（名字提及 + talkativeness 加权）落地到多 NPC 场景。
19. `mes_example` 按 `<START>` 块切分并按"先入后挤"插入（例对话让位给真实历史）。
20. 插件化事件钩子 `PipelineHook`（先内置，类型安全，不引入 ST 式三方前端扩展）。
21. 主题 CSS 变量化 / 文案抽取 strings.ts（多语言准备）。
22. 角色卡 token 超一半上下文标红 + 收藏/标签/HotSwap 列表体验。

---

## 引用来源（均经 web_fetch 实读）

- Character Card Spec V2（字段全表、extensions 规则、character_book 类型）: https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v2.md
- Character Card Spec V1（六字段、PNG "Chara" EXIF 嵌卡、mes_example `<START>`）: https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v1.md
- ST Character Design（permanent tokens、alternate greetings、@Depth note、talkativeness）: https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- ST World Info（scan depth/budget/recursion/selective/inclusion groups/timed effects/positions/outlets）: https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- ST Group Chats（reply order strategies、swap/join cards、mute/force/auto-mode、scenario override）: https://docs.sillytavern.app/usage/core-concepts/groupchats/
- ST Prompts（main prompt、PHI、history 影响）: https://docs.sillytavern.app/usage/prompts/
- ST Prompt Manager（prompt 列表、role/position/depth/trigger）: https://docs.sillytavern.app/usage/prompts/prompt-manager/
- ST Instruct Mode（user/assistant/system prefix-suffix 序列、user filler、stop sequence）: https://docs.sillytavern.app/usage/core-concepts/instructmode/
- ST Context Template（story string、anchors、example separator）: https://docs.sillytavern.app/usage/prompts/context-template/
- ST Macros（{{user}}/{{char}}/{{random}}/{{pick}}/{{roll}}、变量、autocomplete）: https://docs.sillytavern.app/usage/core-concepts/macros/
- ST Summarize（增量摘要、{{summary}} 注入、回滚锚点、公式）: https://docs.sillytavern.app/extensions/summarize/
- ST Chatting（swipe/edit/continue/checkpoint/include-exclude/token probabilities）: https://docs.sillytavern.app/usage/chatting/
- ST Chat File Management（branch/checkpoint、导出 jsonl/txt）: https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/
- ST Characters（面板布局、搜索排序、导入导出、gallery）: https://docs.sillytavern.app/usage/characters/
- ST UI Customization（主题、聊天样式、消息级开关、自定义 CSS、VN 模式）: https://docs.sillytavern.app/usage/core-concepts/uicustomization/
- ST Personas（persona 字段、锁定 chat/character/default、persona-sync）: https://docs.sillytavern.app/usage/core-concepts/personas/
- ST Extensions（内置/可安装/三方 git 安装）: https://docs.sillytavern.app/extensions/
- ST Administration（数据目录布局、config.yaml、多用户）: https://docs.sillytavern.app/administration/
- ST Multi-user（user handle、roles、scaffold、明文数据警告）: https://docs.sillytavern.app/administration/multi-user/
- ST Advanced Formatting（模板重置、tokenizer、停止串）: https://docs.sillytavern.app/usage/core-concepts/advancedformatting/
- ST 首页/总览（定位、系统要求、扩展列表）: https://docs.sillytavern.app/

> 注：web_search 工具在本会话无 API key 不可用，所有内容来自对上述 URL 的直接抓取；文档抓取版本以各页 2026 年版权行为准。
