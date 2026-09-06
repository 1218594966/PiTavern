# M1 / M2 实现记录（2026-09 第二轮执行）

> 配套：`docs/architecture-review.md`（路线图）、`docs/fixes-2026-09.md`（第一轮修复）。
> 本文记录按路线图落地的 M1（玩家闭环）与 M2 轻量项的实际代码变更与验证。

---

## M1-1 会话情感隔离（npcStates overlay）✅

**目标**：多个会话共享静态角色卡，但好感度/内心想法按会话隔离，互不串扰。

**实现**：
- `src/db/store.ts`：`WorldState` 增加可选 `npcStates?: Record<cardId, { affection; innerThought }>` —— 随 chat.state 存档，天然按会话隔离。
- `src/stages/assembler.ts`：渲染角色卡前，用 `state.npcStates` overlay 覆盖卡上全局情感（只替换动态字段，静态 description/personality 保留）。
- `src/stages/post-evaluator.ts` `applyEvalResult`：情感写入分流 ——
  - 有 chatId → 读写 `chat.state.npcStates`（初值回退卡上的全局值），不碰共享卡；
  - 无 chatId（世界模式/测试）→ 直接写卡（原行为保留）。
- `src/web/server.ts`：settled 事件的好感值改为会话优先读 npcStates。

**验证**：`test/chat-isolation.test.ts` —— 会话 A/B 各自 2 回合，A=58、B=63（60±delta 各自独立），内心想法各自独立，共享卡全局好感保持 60 不被污染。✅

**已知边界**：场景卡 recentChanges / 物品卡归属仍是共享的（M1 范围聚焦 NPC 情感，见 architecture-review R1 局限说明）。

## M1-2 greeting 开场白 ✅

**目标**：新会话自动以角色 first_mes/openingLine 开场，玩家不面对空白。

**实现**：
- `src/db/archive.ts`：`getWorldGreeting(store, worldId)` —— 取第一张带 openingLine 的角色卡。
- `src/web/server.ts`：`ensureChat` 与 `chat_new` 建会话后自动注入首条 NPC 消息（turn 0）；`seedGreeting` 只给空会话播种。
- `src/pipeline.ts`：demo 世界艾莉西亚卡补 openingLine（示例世界也有开场白）。
- 前端 `restoreHistory` 支持任意 speaker（非 user 且非空 → NPC 气泡，speaker 名显示）。

**验证**：archive.test「导入卡带 first_mes → 返回主角开场白」「无 first_mes → null」；ws 冒烟：新会话 history[0] = 艾莉西亚开场白。✅

## M1-3 消息编辑 / 删除 / regenerate ✅

**目标**：楼层重roll（swipe 的雏形）、编辑错字、删除误发。

**实现**：
- `src/types.ts`：`HistoryLine.id?` 稳定消息 id；store push 时自动补（`ensureLineId`，Redis/内存统一）。
- `src/db/store.ts`：接口新增 `editChatMessage(chatId, messageId, text)` 与 `deleteChatMessages(chatId, ids)`（LIST 读改写，≤200 条可接受）；`updateChat` 的 Pick 扩到 usage。
- `src/web/server.ts`：
  - 抽取 `runOneTurn()`（chat 与 regenerate 共用，消除 40 行重复）；
  - `chat_edit` / `chat_delete_message` / `chat_regenerate` 协议；编辑/删除后 `broadcastToChat` 广播 `chat_history_changed`（多开同步）；
  - regenerate：删「最后 NPC 回复 + 前一条 user 输入」→ 用该输入重跑整个回合；
  - turn_done 附带 `lastNpcId`（前端给流式消息激活操作条）。
- `src/web/index.html`：消息 hover 操作条（编辑/删除/重roll）；turn_done 补 id；chat_history_changed 全量重建；rolled_back 状态提示。

**验证**：store.test「push 自动补 id + 编辑 + 删除」；ws 端到端：chat → turn_done(lastNpcId) → chat_edit 成功（history 更新）→ chat_regenerate 出新回复。✅

**局限**：多端并发 regenerate 时只有发起端收到完整回合事件（其它端靠 chat_history_changed 刷新，回合流式不广播）——单机演示可接受，已记录。

## M1-4 round-trip：PNG avatar + 导出 V2 ✅

**目标**：PNG 嵌卡图像成为头像落库；角色卡可导出回 SillyTavern V2 JSON。

**实现**：
- `src/types.ts`：`CharacterCardData.avatar?`（base64 dataURL）。
- `src/cards/importer.ts`：`importCards(buffer)` 检测 PNG 魔数 → 原图 base64 挂到拆出的第一个角色卡。
- `src/db/archive.ts`：`toInternalCard` 透传 avatar；新增 `toTavernV2(card)` —— 内部角色卡 round-trip 回标准 V2（name/description/first_mes=openingLine/extensions.pitavern/avatar）。
- `src/web/server.ts`：`world_export_characters` 协议（导出世界全部角色为 V2 JSON）。
- `src/web/index.html`：世界库「导出角色卡」按钮 + 下载。

**验证**：importer.test「PNG 嵌卡 → 角色 avatar dataURL」；archive.test「toTavernV2 导出 → 再 import 能识别（双向闭环）」。✅

**局限**：V2 的 creator_notes/tags/alternate_greetings 等原数据未存（无 rawExtensions），导出为字段占位——完整 round-trip 需 rawExtensions 存档（P1 待办）。

## M2-5 usage / token 统计 ✅

**目标**：回合 token 用量可观测并随会话累计。

**实现**：
- `ChatMeta.usage?: { input; output; calls }`；`updateChat` 增量合并（两次调用跨实现一致）。
- `src/stages/pre-router.ts`：PreRouterResult 带 `usage`（从 AssistantMessage.usage）。
- `src/pipeline.ts`：回合末汇总 router+actor usage → 写 chat meta；`PipelineResult.usage` 返回；evaluator 的用量在结算 onDone 另行累计（本轮先统计 router+actor 调用计数 2）。
- server turn_done 携带 usage；前端「本会话 token」行（world_selected/chat_selected 重置，turn_done 累加）。

**验证**：真实模型冒烟 turn_done usage = `{"input":1073,"output":430}`；store.test usage 合并（130/70/calls 3）。✅

## M2-6 结算摘要卡 UI ✅

**目标**：结算结果可视化（好感变动/内心想法/房间变化）。

**实现**：`src/web/index.html` settled 事件 → `renderSettleCard()` 渲染聊天流末尾的摘要行（💛好感 ±delta+当前值 / 💭内心想法 / 🏠房间变化），右侧好感面板同步。

**验证**：ws 冒烟 settled 事件带齐全字段；faux/真实双路径 UI 数据流正常。✅

---

## 验证汇总

- `npm run typecheck` ✅
- `npx vitest run` → **7 files / 23 tests 全过**（新增：chat-isolation ×1、store 消息操作 ×1、usage 合并 ×1、importer avatar ×1、archive greeting ×2 + round-trip ×1）
- ws 端到端冒烟（faux + 真实双路径）✅

## 遗留（下一轮候选）

- M1-4 完整 round-trip：rawExtensions 存档（V2 未知字段/alternate_greetings/creator_notes 保留）
- M1-3 楼层 swipe 多版本存储（当前 regenerate 是覆盖式；swipe 需保留历史版本 + 切换 UI）
- 会话情感与「换卡编辑」的一致性（卡描述热编辑后 npcStates 语义）
- world 模式的最近会话自动复用策略（多用户连上可能看到他人会话——需用户体系）
