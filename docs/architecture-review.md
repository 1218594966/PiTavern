# PiTavern 深度架构审查报告

> 版本：2026-09（配合本次代码修复落地）
> 配套文档：[SillyTavern 借鉴研究报告](./sillytavern-research.md)
> 审查对象：`src/` 全部模块、`test/` 全部用例、`src/web/index.html` 前端、README/package 等工程文件。

---

## 0. TL;DR

PiTavern 目前是一个**架构优秀的单机技术演示（vertical slice demo）**：
四阶段流水线、卡片 JIT 组装、双存储实现、可靠性与并发防护都已超过"玩具"水准，
但**产品维度仍是 demo**——单进程、单世界推进、无鉴权、前端单页无状态管理、
无长记忆/编辑/swipe/多媒体等 RPG 玩家习以为常的能力。

- 代码健康度：**高**（15→17 测试通过、typecheck 干净、错误码/超时/重试齐备）
- 架构成熟度：**中**（清晰的 pipeline + store 接口抽象，但世界状态机耦合在 pipeline 内、无领域层）
- 产品成熟度：**低**（demo_world 单机演示；缺用户体系、持久化目录、多世界并行、UI 打磨）
- 最大风险：**状态推进与结算的耦合已修；但多进程/多世界/多人仍是单机假设**
- 最大机会：照 SillyTavern 补上「卡生态 + 楼层 + 编辑 + 导出」的玩家闭环

---

## 1. 项目现状评估（分层）

### 1.1 亮点（值得保留的架构决策）

| 决策 | 位置 | 评价 |
|---|---|---|
| 四阶段硬时序 await | pipeline.ts | 快慢轨分离清晰，fire-and-forget 结算不阻塞前台 |
| CardStore 接口双实现 | db/store.ts | Redis/内存可切换，测试零成本 |
| JIT 抽卡 < 900 token 预算 | stages/assembler.ts | 每槽预算 + 整体兜底截断，自解释 |
| 错误码 + 统一重试/超时 | config/errors.ts, robust-llm.ts | 协议层稳定错误提示的基础 |
| 会话回合锁 / 结算串行化 | pipeline.ts, post-evaluator.ts | 多开不踩踏（单进程内） |
| provider-registry 单集合混搭 | config/provider-registry.ts | 本次修复：真实+faux 共存，阶段独立判定 |
| 导入器兼容 V1/V2/PNG/世界包 | cards/importer.ts | 生态兼容性良好 |

### 1.2 结构性缺口

1. **没有领域层/实体生命周期**：世界状态（WorldState）散在 pipeline 内被可变地改；`state` 对象在回合内被阶段 1（换场景）、回合末（turn+1）、结算（物品转移）多处原地修改——虽然本次已解耦回合推进与结算写回，但"谁有权限改什么"仍靠注释约定。
2. **单进程假设**：回合锁/结算 runner 是进程内 Map；`MemoryCardStore` 无持久化。一旦多实例/多用户/重启，回合锁失效、历史与卡片状态冲突。
3. **前端无状态管理/无构建**：index.html 内 570 行 JS 手写 DOM，无路由、无组件、无 websocket 重连状态恢复、错误无分类展示（error 事件只显示 message 字符串）。
4. **卡片数据模型未闭环**：avatar 不落库、creator_notes/alternate_greetings/tags/extension 原数据被丢弃；"导入→编辑→导出"会丢信息。
5. **无消息编辑/删除/重roll/分支**：chat 历史是只读 append，玩家无法撤回错发/不满意楼层。
6. **长期记忆单一**：只有"结算生成记忆卡"一条路；无手动 world info、无选择性/递归扫描、无摘要层。
7. **可观测性弱**：logger 打 console，无 requestId 聚合查询、无耗时面板持久化。
8. **安全**：Web 网关无鉴权（本机可用，但 HOST 默认 0.0.0.0 且无 token）；API Key 明文存 .env（本地单机可接受，但要注意）。
9. **测试偏 happy path**：无 Redis 真集成、无 pipeline 失败路径/重试测试、无 WebSocket 协议测试。

### 1.3 是 demo 吗？——成熟度判定

**是的，目前是「可演示的 vertical slice」**。判定依据：

- 数据层：demo_world 一次性 seed；Redis 只是 TTL 键空间，无迁移/备份/多租户
- 世界推进：单 world 指针、无多世界并行后台；所有浏览器会话共享 demo_world 的世界级卡片（好感度写回全局卡！——见下节风险）
- 前端：单页演示聊天 + 状态面板，无角色画廊/卡片编辑/场景地图
- 没有 CLI 之外的用户入口；无部署形态（Docker/HTTPS/环境隔离）

**但底层不是 toy**：pipeline 的时序纪律、robust-llm 的工程化、双存储抽象都是可扩展为产品的骨架。
结论：**离"可玩产品"差一层产品壳，离"多人在线服务"差一层架构壳**。

---

## 2. 已识别的关键问题（含本次已修复）

### 2.1 本次已修复

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| B1 | Redis 滑动历史 ZSET 同回合字典序乱序 | 改 LIST 右进左裁 + 回归测试 | store.test.ts「同回合两条消息保持写入先后」 |
| B2 | 回合号只在后台结算递增 → 快速连发撞车/滞后 | 回合号前台推进 + 状态回合末落盘；结算只写卡片、物品转移时才落 state | twoturn 脚本验证 1,1,2,2 → 3 |
| B3 | Web 热切换模型 isAllFaux 漏算运行时 Key；双集合切换无法混合配置 | 单共享集合（真实+faux 混搭注册）；provider_set 走 resolveStageModelAsync；getStageModel 配 Key 缺模型即抛错不静默降级 | demo 无 Key→faux、有 Key→真实全链路验证 |

### 2.2 仍存在的设计风险（本次未改，建议按章节 6 演进）

**R1 会话共享角色卡状态（隔离模型不完整）**
- 多个 chat（会话）共享同一批卡片：好感度/内心想法存在 `char_*` 卡上，**会话 A 的结算会改会话 B 的 NPC 好感度**！
- 会话的隔离只做了 state（场景/在场/回合/背包），但 NPC 情感状态是跨会话全局的。
- 方案：要么「每个会话深拷贝一套世界卡（存档式隔离）」要么「把情感状态挪进 chat.state + 存档合并」，或明确「单机单存档」的产品定位并文档化。
- **短期建议**：产品定位为「一浏览器=一条时间线」，UI 上隐藏/弱化多会话，或每次新建会话时克隆一套卡片（clone-on-write）。

**R2 世界指针与卡片归属的写放大 / 无版本**
- putCard/putWorldState 无 CAS/版本号；结算基于陈旧 state 的物品转移仍可能覆盖新回合的背包（虽然回合号不再被覆盖，背包 list 有 race 窗口）。
- 演进见 6.4：WorldState 版本化 + store 层乐观锁。

**R3 demo_world 种子用 void 异步写 + 20ms 魔法等待**
- `createDemoIndex` 里 `void store.putCard(...)` 后 sleep(20) 是脆弱的竞态。改为 await 写完后返回（store 接口已是 async，createDemoIndex 也应 async 或内部 await）。

**R4 前端世界状态（w-turn 等）用 DOM 字符串 +1 猜测**
- turn_done 时前端 `parseInt+1` 而不是用服务端返回的真实 turn——若结算尚未落盘 UI 会先跳。应统一由服务端事件驱动（'world' 事件带权威值）。

**R5 自定义端点每次 fetchModels 用固定 header**
- ensureCustomProvider 里 mkModel headers 用了注册时的 apiKey；运行时 setRuntimeKey 后需重建 provider 才生效（好在请求级 options.apiKey 透传兜底，影响有限）。

**R6 no-auth Web 服务 + 0.0.0.0**
- 本机 demo 无妨；一旦部署需加 token/同源限制。见 5.3。

---

## 3. 与 SillyTavern 的能力差距（产品要补什么）

> 完整对照见 `docs/sillytavern-research.md`，此处只列"必须做 / 强烈建议"。

### P0（影响核心玩法闭环，建议 2-3 周）

1. **卡生态闭环**：avatar 落库展示、V2 原数据 round-trip（creator_notes/alternate_greetings/tags/extensions 只读保留）、导出完整 V2（含 extensions.pitavern）——"导入别家的卡能玩，玩完能导回去"。
2. **消息操作**：玩家消息可编辑/删除；NPC 楼层 swipe（同 prompt 重 roll 存多份）；这三点是 RP 玩家肌肉记忆。
3. **开局 greeting**：first_mes 作为世界第一条 NPC 消息（当前导入后从空白开始，玩家不知道"我是谁在哪"）——alternate_greetings 随机/可切。
4. **组装器预算回传**：现在 assembler 只回 tokenEstimate；建议回传各槽实际 token 与是否被裁剪（谁被挤掉了），前端展示"上下文水位条"——可玩性调试刚需。

### P1（体验与生态）

5. **World Info 增强**：记忆卡支持 `constant`（永远在场）/`selective`+`secondary_keys`/`recursive_scanning`——你的 RouteDecision 阶段 1 天然适合"选择性触发"，把 lorebook 的触发逻辑前移到模型裁决之外做确定性第一道闸。
6. **长期记忆摘要**：回合数超过 N 后把旧对话交给小模型压缩成摘要卡（对齐 ST Summarize 锚点回滚：摘要只替换其覆盖区间，不污染新对话）。
7. **成本/token 统计**：每回合 usage 已可拿（pi-ai message.usage），存 chat 级累计并展示。
8. **UI：角色画廊 / 卡片管理**：哪怕只读展示 imported 卡的描述/标签/头像也好——现在是黑盒导入。

### P2（锦上添花）

9. talkativeness 加权接话、宏替换（{{user}}/{{char}}）、mes_example <START> 块、概率随机、PipelineHook 插件化、群聊卡 swap/join。

---

## 4. UI / 页面方案设计

现状：单页左右两栏（聊天 + 状态面板），零路由零构建。目标形态建议分三阶段：

### 4.1 Phase A（当前页改版，1-2 周，纯前端零构建可做）
```
Header: 世界名 | 会话 Tab | 模型徽章（逐阶段 real/faux 点）
─────────────────────────────────────────────
主区：聊天流               右栏 1：世界状态（回合/场景/在场/好感）
  · 玩家气泡/ NPC 气泡        右栏 2：上下文水位条（四槽 token 占比，超预算标红）
  · 消息 hover 菜单           右栏 3：四阶段流水线
    （编辑/删除/重roll）          · 每阶段耗时 + 最近 requestId
  · NPC 气泡 swipe 箭头
  · 系统行（结算完成摘要）
─────────────────────────────────────────────
输入框（多行）: [发送]  快捷：/help /roll /ooc
```
要点：加**消息 hover 操作**、**上下文水位条**、**结算摘要卡片**（好感变化 + 内心想法可折叠展开）——纯 DOM 即可。

### 4.2 Phase B（角色与世界管理，需引入构建，4-6 周）
```
┌ 画廊页 /gallery：卡片网格（avatar/名/token/标签）→ 点开详情
├ 编辑页 /card/:id：V2 字段可视化编辑（description/personality/…/alternate greetings）
├ 世界页 /world/:id：场景列表 + 当前在场角色 + 世界 lorebook 管理
└ 设置页 /settings：provider/key/模型/默认参数（替代右侧接入面板）
```
引入 Vite + 轻量框架（Preact/Svelte 体积小）或维持零构建 + hash 路由手写视图层。

### 4.3 Phase C（多人/服务化 UI）
- 登录/用户头像、房间列表、GM 控制台（世界卡热编辑、NPC 代打）、观众模式。

---

## 5. 架构演进路线

### 5.1 近期（保持单机，1 个月）
- 世界状态隔离策略落地（R1）：克隆会话卡 或 明确定位单存档
- createDemoIndex async 化（R3）、前端权威 turn（R4）
- 消息编辑/删除/swipe 的存储层（HistoryLine 加 id + revision）
- avatar/creator 字段 + 导出 round-trip
- ChatMeta.state 里加 `npcStates`（各角色好感/心理）——把情感从全局卡挪进会话存档的过渡方案

### 5.2 中期（真持久化 + 多用户，2-3 个月）
- **存储层拆分**：
  - 静态卡（系统/角色/场景/物品/记忆）= 共享目录（卡生态，天然只读共享）
  - 动态状态（好感/心理/背包/回合/历史）= chat 存档，每会话私有
  - 引入 `archive.json` 文件导入导出（对齐 ST jsonl + png）
- **文件持久化**：Redis 之外加 `fs` 目录存储（`data/worlds/*.json`、`data/chats/*.jsonl`），实现 CardStore 第三实现 —— 让"重启不丢"成为默认
- **进程模型**：web 网关保持单 Node 进程（可 cluster），世界推进服务化但状态入 Redis
- **鉴权**：可选 `PT_TOKEN` 环境变量 / 同源白名单；HTTPS 反代文档
- **回合锁升级**：Redis SETNX 分布式锁（worldId 维度）替换进程内 Map

### 5.3 远期（多人实时，3-6 个月）
- 房间（room）= 一组 chat 存档 + 共享世界卡；WebSocket 广播回合事件给房间内所有观众
- GM 能力：热编辑卡片/场景/好感（需要卡片写接口 + 权限）
- 结算流水线解耦为可插拔 worker（queue）；卡片更新走 pub/sub 通知在线房间
- 前端工程化：组件化 + 状态管理（zustand 等）+ WS 重连状态恢复

---

## 6. 测试与工程化建议

1. **Redis 真集成测试**（docker compose 起 redis，跑 store 套件）——当前只 mock
2. **pipeline 失败路径**：router 输出非法 JSON → MODEL_FAILED；actor 半截流 → replyTruncated；结算失败 → 世界不脏
3. **WebSocket 协议测试**：ws 连上 → hello → chat → 断言事件序列（可用 `node -e` + ws 包脚本；曾有 ws-multichat.mjs 原型，2026-09 清理审计移除）
4. **vitest 分段**：fast（纯内存）/ slow（含 faux 限速流）用 describe.sequential + timeout 分级
5. **CI**：GitHub Actions `npm ci && npm run typecheck && npm test`
6. **包脚本补充**：`npm run dev:web`（tsx watch）、`npm run lint`（引入 eslint 前先 tsc --noEmit 即可）
7. **文档**：architecture decision records（ADR）记录回合号/历史存储/会话隔离等决策

---

## 7. 路线图（建议排序）

| 阶段 | 内容 | 预估 |
|---|---|---|
| M0（已做） | Bug 修复 + 回归 + 单集合重构 | ✅ |
| M1 | 会话隔离策略（克隆或存档化情感）、greeting 开局、avatar/导出 round-trip、消息编辑/删除/swipe | 2-3 周 |
| M2 | 组装器水位条 + 预算回传、结算摘要 UI、token/成本统计、world info 增强（constant/selective） | 2-3 周 |
| M3 | 文件持久化 + archive 导入导出、redis 分布式锁、鉴权、Docker | 3-4 周 |
| M4 | 多房间 + GM + 前端工程化 | 1-2 月 |

---

## 8. 结论

PiTavern 的核心引擎设计**方向正确且有稀缺性**（把 SillyTavern 的"全部上下文硬塞"改造成 JIT 抽卡 + 四阶段快慢轨，是真正面向长程 RPG 的优化）。
当前最该做的不是堆模型/功能，而是：
1. **补完单机玩家闭环**（编辑/swipe/greeting/导出/画廊）——让"玩得爽"
2. **把动态状态从共享卡挪进会话存档**——让"多开不乱"
3. **文件持久化**——让"关掉不丢"
4. **前端从单页脚本走向有视图层的小应用**

完成 1-3 后，它就从一个优秀 demo 变成一个可日常使用的本地 RPG 引擎；
再往前（多人/GM/云）按 5.3 的壳逐步加即可，无需推翻重来。
