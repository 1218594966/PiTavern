# M8b 提示词调试面板（第八轮补充）

> 用户需求：四阶段流水线卡片下方区域，展示「本回合发给模型的提示词」——
> 分两路：① 前置路由提示词（PreRouter 收到的抽卡提示）；③ 组装后发给演员的提示词。

## 实现
- `src/utils/prompt-debug.ts`（新）：`ctxToDebugPrompt(ctx)` —— 把发给模型的 Context
  （systemPrompt + 各消息 + 工具清单）拼成可读全文。
- `src/stages/pre-router.ts`：`PreRouterResult.debugPrompt` —— 路由完整提示词
  （挑卡裁决器系统提示 + 世界指针/可抽卡清单 + 玩家的话）。
- `src/pipeline.ts`：
  - router done 事件 detail 附 `debugPrompt`；
  - actor start 事件 detail 附 `debugPrompt` —— 即 **组装后真正发给演员模型的全文**
    （systemPrompt = 四插槽拍平 prompt；user = 玩家最新输入）。
- `src/web/index.html` 四阶段卡下新增「🔍 本回合提示词」区：
  - 两路切换 tab（① 路由 / ③ 演员）；`<pre>` 全文（等宽滚动、自动换行、max-height）；
  - ⧉ 复制按钮（clipboard + toast）；
  - 回合开始（clearStages）自动清空，逐阶段到达即显示（路由先到、演员紧随）。

## 验证
- 端到端：faux 跑一回合 → router debugPrompt（806 字符，含「挑卡裁决器」）+
  actor debugPrompt（542 字符，含「角色·艾莉西亚」与「最近对话」）—— **PROMPT DEBUG PASS**；
- 41/41 测试 + typecheck 干净；服务 http://127.0.0.1:3100 已更新。

## 说明
- actor 提示词文本 == 组装器输出（900 token 硬顶内），真实模型回合可长一些；
  面板文本来自事件 detail，不走额外存储，重启即清。
- 后续候选：evaluator 结算提示词也展示；提示词区折叠记忆（上一回合对比）。

## M8b-2 调试免裁剪（完整上下文开关）
> 用户反馈：调试阶段不需要自动裁剪（水位条「历史超预算被裁剪」烦人，想看完整上下文）。

- `ChatMeta.settings.noTruncate`；settings_set 支持；⚙ 设置弹层「🐞 调试」区复选框
  「完整上下文：不自动裁剪」，勾选即生效（toast 反馈）。
- pipeline/assembler `noTruncate` 穿透：历史全量多取（400 条）并跳过三处裁剪
  —— 层摘要不折叠、历史不按 160 预算裁、无 900 全局截断；水位条 truncated=false
  （「⚠ 历史超预算」提示随之消失）；actor debugPrompt 显示完整拼装文本。
- 冒烟：noTruncate=true 回合 → assembled.truncated=false（NO-TRUNCATE PASS）。
- 提醒：模型窗口需足够大（长剧情 + 免裁剪可能超 900 token，仅调试期建议开启）。

## M8b-3 分层收发面板（模型请求/响应查看器）
> 用户架构思维：调试面板要按阶段分层显示"完整发给模型的是什么 + 模型回复了什么"，
> 可折叠、显示全。

- **服务端**：`ctxToStructured(ctx)`（prompt-debug.ts）把 Context 拆成
  { system 指令 / messages[]（各角色消息） / tools（含 JSON Schema）}；
  `messageContentToText()` 取模型回复完整原文。
  - 路由：PreRouterResult 增 `request`（结构化）+ `rawResponse`（回复全文，原 200 截断移除）；
    router done 事件 detail 携带。
  - 演员：actor start 事件带结构化 request；actor done 事件带 `response`（流式完整回复）。
- **前端**（🔍 模型收发面板重写）：
  - 每阶段一个大块（① 路由 / ③ 演员），块头状态（等待/请求中/✓ 已回复 + 耗时），点击整块折叠；
  - 块内按层分节，节头可独立折叠展开：
    - 🎛 System 系统指令
    - 💬 用户(最新输入) 等消息
    - 🔧 Tools（含参数 Schema）
    - 📤 模型回复（完整，不截断）
  - 「展开全部」一键全开；「⧉ 复制」导出全部分层收发（含标题）；新回合自动清空；
  - 文本经 esc() 转义显示，pre 等宽滚动不截断。
- 冒烟：路由 request（system 385c + tools 1395c Schema）+ JSON 回复原文；
  演员 request（演绎框架 746c）+ 完整台词 —— LAYERED DEBUG PASS ✓
