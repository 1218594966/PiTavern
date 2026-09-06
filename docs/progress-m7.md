# M7 实现记录（2026-09 第七轮执行）

> 主题：UI 管理大修 × 卡管理闭环。
> 触发：用户反馈「特别是 UI 管理，现在垃圾的要死」—— 本轮把原生弹窗、下拉选世界等粗糙交互全部替换。

---

## M7-1 UI 基建（toast / modal / 确认框）✅

**目标**：消灭全部浏览器原生 prompt/alert/confirm，统一成主题内建组件。

**实现**（`src/web/index.html`，纯 DOM/CSS）：
- `toast(text, kind)`：右下角堆叠轻提示（默认 2.6s / err 5s，绿/金/红边）。
- `openModal(title, bodyEls, actions)`：居中模态（字段 label+input/textarea、hint、动作按钮 primary/danger、Esc/遮罩点击关闭、自动聚焦）。
- `uiConfirm(title, text, danger)` → Promise<boolean> 确认框。
- 替换全部 6 处原生弹窗：
  1. 消息编辑（prompt → textarea modal）
  2. 消息删除（confirm → uiConfirm danger）
  3. 会话删除（confirm → uiConfirm danger）
  4. persona 设置（prompt×2 + confirm → 单表单 modal：名字/描述 + 头像按钮 + 保存 toast）
  5. 画廊卡删除（新）
- 消息操作条 hover 依赖补充 `.msg:focus-within` 兜底（触屏可聚焦呼出）；滚动条美化；按钮 hover/disabled、输入框 focus 统一。

## M7-2 世界库卡片化 + 会话管理增强 ✅

**实现**：
- 世界下拉 `<select>` → **世界卡片列表**（`#world-cards`）：发光圆点指示当前世界、名/角色数·场景数 meta、hover 高亮、点击切换。
- 会话 tab：双击当前会话弹 modal 重命名（复用 chat_rename）；新建/导出/删除按钮保留在顶栏。

## M7-3 card_delete 协议 + 引用清理 ✅

**目标**：卡生命周期的另一半（此前只能加/改，不能删）。

**实现**：
- `src/db/store.ts`：接口 + Redis（srem 目录 + del 卡）与 Memory（Map 移除）双实现 `deleteCard(worldId, cardId)`。
- `src/web/server.ts` `card_delete` 协议 + 引用清理：
  - 世界 state：`presentCharacterIds` / `playerInventory` 剔除；
  - 当前场景被删 → `currentSceneId` 回退到世界剩余第一个场景卡；
  - **所有会话的 state 快照**同步清理；
  - 场景卡 `presentCharacterIds/itemIds` 剔除被删卡；记忆卡 `ownerCharacterId` 指向被删卡 → 置空；
  - 完成后推送 `card_deleted` + 刷新 world_cards。
- 画廊详情面板加「🗑 删除卡」按钮（uiConfirm 确认 + toast + 面板收起）。

**验证**：store.test「deleteCard 删卡并移除目录」；实服冒烟「导入测试世界 → card_delete → 卡消失」✅

## M7-4 /roll + /help + slash 提示浮层 ✅

**实现**：
- server `/roll NdM`（或 `/r`，dM 支持）：骰子结果以玩家行入历史（`/roll 2d6（力量检定） → 6 + 3 = 9`），广播不跑回合（上限 100 骰/1000 面）。
- server 已有 `/ooc`（M5）；`/me`（M5）；`/help` 前端浮层（modal 命令清单）。
- 输入框以 `/` 开头 → **命令补全浮层**（↑↓ 选择、Enter 填入、Esc 关闭、点击直接填入）；`/help` 在 send 路径与 Enter 选择路径均可打开。
- 修复潜在 bug：send() 对 `/roll` 与 `/ooc` 本地即显、不置 busy（否则等不到 turn_done 永久锁输入）。

**验证**：实服冒烟 `/roll 1d20 侦察 → 3` ✅

---

## 验证汇总
- `npm run typecheck` ✅
- `npx vitest run` → **9 files / 38 tests 全过**（新增 store deleteCard ×1）
- 实服冒烟（faux 模式，端口 3100）：hello→world→回合→/roll 全流程事件链 ✅；card_delete 引用清理 ✅
- 前端 JS 语法检查全过；服务已在 **http://127.0.0.1:3100** 运行（faux 演示模式）

## 遗留（下一轮候选）
- PNG 嵌卡导出（PNG 含 character chunk 的完整导出）——本轮时间盒未纳入，仍遗留
- 画廊空状态/加载态、世界删除（world_delete 需清理该世界全部 chat/卡）
- 前端拆分（index.html 已 ~1500 行，工程化重构是持续的债）
- 下一轮候选（原第 8 轮）：长期记忆摘要层 + memory constant/selective + mes_example <START> 解析 + post_history_instructions 注入
