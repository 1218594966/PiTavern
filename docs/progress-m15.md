# M15 PreRouter 提示词分层 v2（导演心智模型落地）

> 用户心智模型（经三轮确认）：
> - 路由 = 导演，输入应为 **System(规则/工具/输出) + 世界库 + 近N层剧情全文 + Tools**
> - 世界库分层借鉴 function-calling/skill：📌常驻卡 = **全量信息在上下文**（导演随时读）；
>   非常驻卡 = **声明式档案**（知道有这人/大概是谁/触发词，点名 route_cards 填 id 后才展开全文）
>   —— 导演知全局、细节按需拉取、上下文不爆炸
> - 「近 N 层全文」与「玩家现在的话」是包含关系：全文末尾即玩家最新输入 → **删重复尾巴**
> - Tools 归 System：导演的"工具"写在 System 里（规则/工具/输出三小节），API tools 照传（双通道）

## 落地（src/stages/pre-router.ts buildRouterContext 全重构）
新提示词结构：
```
【System · 导演层】
  规则：常驻已全量可直接用；非常驻=档案点名才展开；不为了用而用…
  工具：route_cards 唯一工具说明
  输出：调用 route_cards 给参数；reasoning 一句话
user 消息：
  当前回合号/场景
  【世界库 · 常驻设定（全量，直接使用）】   ← constants 段（与演员同款内容）
  【世界库 · 档案总览】
    📌 常驻角色（全量已注入，作索引）
    🧙 角色（点名后展开）
    📌 旧事/线索（触发词）
    🗡️ 物品（点名后展开）
  【剧情回顾 · 压缩摘要链】（如有）
  【近 N 层剧情全文】（末尾即玩家输入——不重复贴「玩家现在:」）
  → 请调用 route_cards
```
- RouterInput 增 `constants?: {id,kind,name,mclass,text}[]`；pipeline 与 server 预演 preview
  同步传（排除 isPlayer 玩家卡与 system——法则在 actor 段独立）
- System 文字三小节（规则/工具/输出）；tools 参数保持（route_cards schema 不变）

## 验证
- typecheck ✓；50/50 测试（更新 M14 用例为 M14/M15 分层断言：System 三段、常驻全量段、
  档案总览+触发词、摘要链+近N层、无重复玩家尾巴）
- 端到端 faux：System 三段/user 档案总览/近N层/无重复尾巴/tools 全绿
- 服务 http://127.0.0.1:3100（真实模型）已重启

## 待办（下轮）
- **提示词段级模板编辑器**：System 规则/工具/输出、演员演绎框架等段可编辑保存
  （工作台 textarea + 服务端持久化，测试期改提示词即存即生效）
- 工作台按新分层展示（路由 System/世界库/剧情视图 树状折叠）——现有 request 分层
  system/messages/tools 已自动反映新结构，细化展示待模板编辑器一起做
