# M5 实现记录（2026-09 第五轮执行）

> 主题：同屏协同 × 卡管理闭环 × 场外表达。
> 配套：`docs/architecture-review.md`（§5.3 多人前奏）、`docs/sillytavern-research.md`（OOC 行 / swipe 借鉴）、各轮 progress。

---

## M5-1 多端同屏实时 ✅

**目标**：同会话多开浏览器/客户端时，任一端发起回合，其它端实时跟随（流式打字/阶段面板/结算摘要/历史刷新），并防止回合并发踩踏。

**实现**（`src/web/server.ts`）：
- **回合事件广播**：`runOneTurn` 的 onDelta / onStageEvent / onSettled / turn_done 从「只发发起端」改为 `broadcastToChat(chatId, …)` —— 同 chat 全部连接收到同一事件流；请求级错误（世界无卡/会话不存在）仍只发发起端。
- **per-chat 回合互斥**：新增 `chatBusy: Set<chatId>` —— chat / regenerate 跑回合前检查（同 chat 其它端在跑 → 明确报错），回合结束 finally 释放；**edit / delete / swipe 也加 chatBusy 保护**（避免回合中改历史产生竞态）。
- 前端无需改动：事件驱动渲染天然跟随多端（streaming/阶段/结算均来自服务端广播）。

**验证**：双 ws 客户端冒烟 —— 端 A 发回合，端 B 收到 7 段 delta + 13 阶段事件 + turn_done（**DUAL SYNC PASS**）。✅

## M5-2 卡管理闭环（card_update + 画廊内联编辑）✅

**目标**：角色卡/场景卡可在画廊里直接编辑保存，round-trip 与编辑闭环。

**实现**：
- `src/web/server.ts`：
  - 新增 `card_update { cardId, patch }` 协议：character 卡白名单字段（description/personality/scenario/speechStyle/openingLine/role）；scene 卡（name/description）；其余卡型拒绝。保存后回 `card_updated` 并推送最新 `world_cards`（画廊刷新）。
  - 抽 `summarizeWorldCards(worldId)` 辅助（world_cards 与 card_update 共用，消重）。
  - 卡摘要新增 speechStyle 字段（编辑器预填用）。
- `src/web/index.html`：画廊卡片点击 → **内联详情/编辑面板**（textarea/input 每字段 + 💾保存/收起）；非角色/场景卡只读展示。

**验证**：M5 综合冒烟中 card_update 成功回 card_updated + 画廊数据刷新。✅

## M5-3 玩家身份完整化（persona 头像 + 气泡名）✅

**实现**：
- persona 头像：chip 点击流程支持「设置头像图片」→ 隐藏 file input → FileReader 转 dataURL → persona_set.avatar；persona 事件把头像渲染进 header chip（圆形小图）。
- user 消息气泡 now 显示 persona 名（`myPersona.name`），历史恢复同理；无 persona 显示「你」。

## M5-4 场外表达：/ooc、/me、{{random}} 宏 ✅

**目标**：ST 借鉴 P0 —— OOC 行（场外）与动作行；宏引擎扩展随机。

**实现**：
- `/ooc 文本`：server 不触发回合，直接 push `speaker='ooc'` 行（当前 turn），广播历史刷新；assembler 插槽 4 对 ooc 行渲染 `（OOC）text`（**模型可见但明确标注场外**）；前端 ooc 气泡样式（居中虚线斜体）；send() 本地即显不置 busy。
- `/me 文本`：剥离前缀后作为玩家输入走正常回合（动作感由文本承载）。
- `{{random:选项1|选项2}}`：expandMacros 支持随机宏（每次独立随机、空选项置空）；`hasUnresolvedMacros` 同步识别。

**验证**：assembler.test「OOC 场外行进窗口并标注」；macros.test「random 命中候选集 + 空选项」；端到端冒烟中 B 端实时看到 A 的 ooc 行。✅

---

## 验证汇总
- `npm run typecheck` ✅
- `npx vitest run` → **9 files / 33 tests 全过**（新增 assembler OOC ×1、macros random ×1）
- 端到端：双端同屏（ooc 行实时可见 + 回合事件流 + card_update）✅

## 遗留（下一轮候选）
- M5-1：房间抽象（多 chat 并行的观战模式、世界级事件广播）；回合中的 per-chat 状态指示给其它端（「正在输入…」）
- M5-2：scene/memory 卡在画廊的可视化管理；卡删除（含引用清理）；世界观编辑
- M5-4：/roll 骰子、宏引擎进 assembler（{{random}} 在卡正文渲染时展开）、OOC 行可选「不进模型」
- 下一里程碑 M6：真正的多用户房间（登录/权限）或前端工程化重构（见 architecture-review §4.2/§5.3）
