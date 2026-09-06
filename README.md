# PiTavern 🍺

基于 `@earendil-works/pi-ai`（pi-ai 的延续包）的**四阶段快慢双轨 RPG 交互引擎**。

把单次玩家交互拆成 4 个分工明确的阶段，控制权收拢在代码层的业务流水线里，用 `async/await` 刚性锁定执行顺序——快（流式对戏）与慢（世界结算）彻底解耦。

```
[玩家点击发送]
      │
      ▼
【阶段 1：PreRouter】        completeSimple()  小模型  ~200ms   全自动挑卡裁决器 → JSON 抽卡清单
      │
      ▼
【阶段 2：ContextAssembler】 纯代码内存拼接      < 2ms   四插槽乐高拼装 → < 900 Token 小纸条
      │
      ▼
【阶段 3：Actor】            streamSimple()    大模型   毫秒级流式打字，首字秒回
      │  （正文写完，玩家开始看文字）
      ▼
【阶段 4：PostEvaluator】    completeSimple()  小模型   后台静默 1~2s：好感度/内心想法/房间变化 → 写回 DB
```

## 核心设计

### 痛点 A：上下文爆炸 → JIT 抽卡组装
- 50+ NPC、多个地点的世界观**不硬塞 Context**，全部以卡片（Card）形式躺在 Redis 里。
- 阶段 1 用轻量索引摘要让模型只做「裁决」，输出一份抽卡清单（RouteDecision），
  指明本回合只需哪张场景卡、哪张角色卡、哪条记忆便利贴、哪个物品卡。
- 阶段 2 按清单从 Redis 取卡，插进 **4 个固定插槽**：
  1. 固定底座（系统法则卡）
  2. 现场快照（场景卡 + 在场角色卡，带心理状态）
  3. 临时外挂知识（便利贴：记忆切片 / 物品卡，没提就 0 Token）
  4. 视线窗口（最近 2~3 楼真实对白 + 玩家最新输入）
- 总量硬约束 `< 900 Token`，超预算从最旧历史裁剪。

### 痛点 B：快慢矛盾 → 双轨分离
- 前台只有「挑卡 + 拼装 + 对戏」三段，全部在玩家可感知的延迟内完成。
- 正文写完后，阶段 4 **fire-and-forget** 后台结算（`postEvaluatorRunAsync` 不加 await），
  玩家看文字的 1~2 秒里，好感度变动、NPC 潜意识心理、房间变化静默落盘，
  下一回合阶段 1 拿到的就是最新鲜的世界状态。

### 每个阶段可独立配模型
| 阶段 | 环境变量 | 默认模型 |
|------|---------|---------|
| PreRouter | `PI_ROUTE_PROVIDER` / `PI_ROUTE_MODEL` / `PI_ROUTE_API_KEY` | commandcode / deepseek-v4-flash-fast |
| Actor | `PI_ACTOR_PROVIDER` / `PI_ACTOR_MODEL` / `PI_ACTOR_API_KEY` | commandcode / claude-sonnet-5 |
| PostEvaluator | `PI_EVAL_PROVIDER` / `PI_EVAL_MODEL` / `PI_EVAL_API_KEY` | commandcode / deepseek-v4-flash-fast |

Key 解析优先级：阶段级 `PI_<STAGE>_API_KEY` > 运行时内存 Key > provider 级 env Key。
**每阶段独立判定**：配了 Key 的阶段走真实模型，没配的阶段自动落 faux —— 支持「路由/结算用 faux、演员用真实」的混合配置（共享同一 Models 集合，见 src/config/provider-registry.ts 的 faux 注册）。

没配 Key 时自动落到 **faux 脚本假模型**，Demo 零成本跑通全链路。

### 上游模型发现 + 交互选择
`@earendil-works/pi-ai` 支持从上游拉取 provider 的实时模型目录：

```bash
npm run pick-model -- --stage actor             # 为 Actor 阶段选模型（自动写回 .env）
npm run pick-model -- --stage router --dry-run  # 只列出候选，不写 .env
npm run pick-model -- --stage evaluator --provider deepseek
```

流程：`models.refresh({ providers })` 拉取上游目录 → `models.getAvailable()` 过滤出已配置好鉴权的模型 → 编号交互选择 → 写回 `PI_*_PROVIDER` / `PI_*_MODEL`。
无 Key 时也会列出上游模型并提示配置对应 API Key。

## 真正接入真实模型

四种方式，任选其一：

### 方式一：自定义端点（默认：CommandCode）
本项目默认接入 **CommandCode**（https://api.commandcode.ai/provider/v1）——一个 OpenAI + Anthropic 混合兼容端点，含 Claude / GPT / DeepSeek / Kimi / GLM / Gemini 等 60+ 模型。

```bash
# .env（Key 只存本地，已 gitignore）
COMMANDCODE_BASE_URL=https://api.commandcode.ai/provider/v1
COMMANDCODE_API_KEY=user_xxx
```

- 三阶段默认模型已指向 CommandCode（`deepseek/deepseek-v4-flash-fast` 等）
- **混合协议自动分派**：`claude-*` 模型走 Anthropic Messages API，其余走 OpenAI 兼容 API
- 启动时自动拉取上游模型目录（60+ 模型可选）
- 也支持任意其它 OpenAI 兼容端点（OneAPI / LiteLLM / vLLM）：网页「模型接入」面板填自定义 URL + Key

### 方式二：网页里直接接入（立即生效）
`npm run web` 打开页面后，右侧「🎯 模型接入」面板：
1. 选 Provider（commandcode 默认 / deepseek / anthropic / openai / openrouter / groq / moonshot / mistral / xai / cerebras / huggingface）
2. 粘贴 API Key → 点「拉取模型」→ 从上游模型列表选一个
3. 选目标阶段（① 路由 / ③ 演员 / ④ 结算）→ 点「测连通」验证 → 点「应用到阶段」
4. 立即生效，无需重启；Key 只存内存，不落盘

### 方式三：CLI 向导
```bash
npm run connect -- --stage actor                 # 交互式：选 provider → 输 Key → 选模型 → 测试 → 写 .env
npm run connect -- --stage router --provider commandcode --key user_xxx --model deepseek/deepseek-v4-flash-fast --force
```

### 方式四：直接写 .env
```bash
PI_ACTOR_PROVIDER=commandcode
PI_ACTOR_MODEL=deepseek/deepseek-v4-flash-fast
PI_ACTOR_API_KEY=user_xxx
```
或只设 provider 级 Key（`COMMANDCODE_API_KEY` 等），三个阶段共用。

> 阶段级 `PI_<STAGE>_API_KEY` > 运行时内存 Key > provider 级 env Key。连通性测试会真实发一个最小请求验证 Key 有效。

## 卡片导入（SillyTavern 兼容）

**支持导入全网通用的角色卡，自动拆成 PiTavern 的卡片体系：**

| 你上传什么 | 自动拆成什么 |
|---|---|
| SillyTavern V2 卡（`spec: chara_card_v2`） | 角色卡 ×1 + character_book → 记忆卡 ×N + `extensions.pitavern` 场景/物品/世界观 |
| SillyTavern V1 卡（裸字段） | 角色卡 ×1 |
| PNG 嵌卡（Chara EXIF 字段） | 同上（自动解析） |
| PiTavern 世界包（`pitavern-world/v1`） | 多角色/多场景/物品/lore 全拆 |

导入方式：网页「🌍 世界库」→ 导入 JSON/PNG（或粘贴文本）→ 自动拆分 → 选世界开玩。
无场景的卡会自动补默认场景。**导入的卡用四阶段 JIT 机制玩，不是硬塞长上下文。**

## 快速开始

```bash
npm install
npm run seed     # 种子卡片入库（内存；配 REDIS_URL 或 PITAVERN_DATA_DIR 则持久化）
npm run demo     # 全链路 Demo（faux 模型，无需任何 API Key）
npm run web      # 打开浏览器网页版：http://localhost:3100
npm test         # 27 个单元测试（组装器四插槽 / 全链路 / Redis 键空间 / 会话隔离 / 文件持久化）
npm run typecheck
```

存储优先级：`PITAVERN_DATA_DIR`（文件快照，关掉不丢）> `REDIS_URL`（Redis）> 内存（仅演示）。
例：`PITAVERN_DATA_DIR=./data npm run web` —— 重启后世界/会话/历史自动恢复。

配了 `.env`（见 `.env.example`）后，同一份代码直接换成真实模型跑。

## 网页版

`npm run web` 启动一个零依赖 Web 网关（Node 原生 http + WebSocket）：

- **左侧**：RPG 聊天区，发消息 → 流式看到 NPC 回话（逐字打出）
- **右侧**：四阶段状态面板
  - 世界状态（回合 / 场景 / 在场角色）
  - ① 前置路由 / ② JIT 组装 / ③ 前台演员 / ④ 后台结算 的实时状态与耗时
  - 阶段 1 抽卡清单 JSON、阶段 2 拼装 token 与插槽明细
  - 阶段 4 结算日志（好感度变动 / 内心想法）

`PORT=3200 npm run web` 可换端口。无 API Key 时自动用 faux 演示模型（响应循环 5 组）。

需要给 WebSocket 加锁（内网/共享部署）：`PT_TOKEN=xxx npm run web` —— 之后访问页面用
`http://host:port/?token=xxx`（页面记住 token，聊天通过 WS 鉴权）。

## 代码结构

> 架构与演进路线见 `docs/architecture-review.md`；修复与功能落地记录见
> `docs/fixes-2026-09.md`、`docs/progress-m1-m2.md`、`docs/progress-m3.md`、
> `docs/progress-m4.md`、`docs/progress-m5.md`、`docs/progress-m6.md`、`docs/progress-m7.md`、`docs/progress-m7b-pack.md`、`docs/progress-m8.md`、`docs/progress-m8b-prompt-debug.md`、`docs/progress-m8c-prompts.md`、`docs/progress-m9-ui-theme.md`、`docs/progress-m9b-memory-layering.md`、`docs/progress-m9c-ui-cleanup.md`、`docs/progress-m10.md`（V3 卡全量支持与仓库架构大修）、`docs/progress-m11.md`（卡片通用常驻开关与世界观卡分类）、`docs/progress-m12.md`（选卡架构：角色卡=世界容器、开场白归卡）、`docs/progress-m13.md`（常驻 chip 交互/记忆卡编辑/牛皮纸主题）、`docs/progress-m14.md`（PreRouter 叙事导演化）、`docs/progress-m15.md`（路由分层 v2）、`docs/progress-m16.md`（提示词模板编辑器）、`docs/progress-m17.md`（路由 System 措辞重排）、`docs/progress-m18.md`（默认世界=校园卡、Tools 显示清理）；
> SillyTavern 借鉴研究见 `docs/sillytavern-research.md`。

```
src/
├── types.ts                 # Card / RouteDecision / CharacterState 等核心类型
├── pipeline.ts              # 四阶段刚性流水线控制器（await 时序）+ 种子数据
├── config/
│   ├── models.ts            # 每阶段独立模型路由（真实/faux 逐阶段判定）
│   ├── provider-registry.ts # provider 注册中心：内置 + 自定义端点 + faux 共享集合
│   └── pick-model.ts        # CLI：上游模型列表 + 交互选择 → 写回 .env
├── stages/
│   ├── pre-router.ts        # 阶段 1：models.completeSimple + JSON Schema 抽卡裁决
│   ├── assembler.ts         # 阶段 2：纯代码四插槽拼装，< 900 token 硬约束
│   ├── actor.ts             # 阶段 3：models.streamSimple 流式对戏引擎
│   └── post-evaluator.ts    # 阶段 4：后台结算（好感度/内心/房间变化 → 写回）
├── db/
│   ├── store.ts             # CardStore 接口：ioredis 实现 + 内存回退
│   ├── archive.ts           # 导入世界包 → 内部卡档案（按世界登记）
│   └── seed.ts              # 种子脚本
├── cards/                   # SillyTavern V1/V2/PNG/世界包 导入拆分
├── web/
│   ├── server.ts            # Web 网关（http + WebSocket，四阶段事件推送）
│   └── index.html           # 聊天页 + 状态面板（零构建）
└── utils/tokens.ts          # 轻量 token 估算（CJK 加权）
```

## Redis 键空间

```
card:{id}                    JSON 卡片本体（7 天 TTL）
world:{worldId}:state        世界指针（当前场景/在场角色/回合/背包）
world:{worldId}:history      滑动历史（LIST，右进左裁，保留最近 N 条）
world:{worldId}:cards        世界 → 卡片目录（SET）
chat:{chatId}:meta           会话元信息（标题/独立世界状态）
chat:{chatId}:messages       会话消息（LIST）
world:{worldId}:chats        世界 → 会话索引（SET）
```

没有 Redis 也能跑：`MemoryCardStore` 实现同一接口。

> 历史消息为什么用 LIST 而不是 ZSET？同一回合会写入两条同 score 记录
> （玩家输入 + NPC 回话），Redis ZSET 对同分成员按字典序排列会把同回合
> 两条消息顺序颠倒；LIST 天然保插入序。

## 时序（控制器里的刚性 await）

```typescript
const routeDecision = await preRouter(...);        // 1. 先挑卡（前一步没出结果，后一步不运行）
const prompt = await assembleCards(routeDecision); // 2. 组装积木
const stream = await actorEngine.stream(prompt);   // 3. 演员打字（流式）
// 4. 正文推给前端后，不加 await，后台静默触发结算
postEvaluatorRunAsync(routeDecision, userMsg, stream.fullText);
```

## 真实场景接入点

- **50+ NPC 索引**：`buildRouterIndex` 目前直接构造全量摘要；真实项目从 Redis 分页拉取
  （角色卡按 `card:{id}` + 索引 ZSET），替换 `WorldIndex` 的构造即可。
- **换场景**：阶段 1 判定真移动 → `sceneCardId` 指向新房间，流水线同步世界指针并重置在场名单。
- **多角色防抢话**：`speakerCharacterId` 只选一个主讲，其他角色只做背景动作。
