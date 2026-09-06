# M6 实现记录（2026-09 第六轮执行）

> 主题：世界一致性 × 卡宏引擎 × 上下文可控。
> 修复路线图 R4 的遗留（世界状态推送时机），并补上卡片宏与出戏行两大能力。

---

## M6-1 世界状态即时广播（完成 R4）✅

**目标**：换场/在场/回合号在回合正文完成后立即推送，不再等后台结算完成才发 —— 修复「多端场景面板陈旧」与前端回合号 +1 hack。

**实现**：
- `src/pipeline.ts`：回合末（正文入历史、`state.turn = nextTurn` 落盘后、阶段 4 结算启动**前**）立即 `emit({type:'world', …})`；删除结算 onDone 里重复的 world 事件（结算只发 settled / 好感）。
- `src/web/index.html`：`turn_done` 移除 `parseInt($('w-turn'))+1` 猜测 —— 回合号完全以 world 事件为权威（world 必先于 turn_done 到达）。

**验证**：ws 冒烟 —— world 事件在 turn_done 之前到达且 turn 值一致（2）；`WORLD-FIRST: PASS`。✅

## M6-2 卡正文宏展开 ✅

**目标**：角色/场景/系统卡正文里的 `{{user}}`/`{{char}}`/`{{random}}` 在进模型前展开（卡生态作者写卡即可引用玩家名/主讲）。

**实现**：
- `src/stages/assembler.ts`：
  - `renderCard(card, ctx?: RenderCtx)` —— ctx 含 `userName`/`charName`/`selfName`；各卡型输出经 `expandMacros` 展开。
  - **character 卡** `{{char}}` → 自身名（selfName 自动兜底 charName）；场景/系统/便利贴/物品卡 `{{char}}` → 主讲角色名（route.speakerCharacterId → 无则首个在场角色名）。
  - `AssemblerInput.userName?`（缺省 `<user>` 兜底，行为不变）。
- `src/pipeline.ts`：`PipelineConfig.userName?` 透传给 assembler。
- `src/web/server.ts`：runOneTurn 从 chat.persona.name 注入 userName。
- greeting/persona 展开与卡正文展开共用宏引擎（{{random}} 亦生效）。

**验证**：assembler.test「renderCard 宏展开 + 无 ctx 行为不变」「assembleCards userName 注入（系统卡 {{user}} 替换 vs <user> 兜底）」✅

## M6-3 历史行 excluded（出戏，不进上下文）✅

**目标**：玩家可将任意行标「出戏」——保留历史可回看，但不进模型上下文（对齐 ST included/excluded 语义）。

**实现**：
- `src/types.ts`：`HistoryLine.excluded?: boolean`。
- `src/db/store.ts`：`setChatMessageExcluded(chatId, messageId, excluded)`（Redis rewriteChatList / 内存两实现）。
- `src/stages/assembler.ts`：插槽 4 过滤 `h.excluded` 行。
- `src/web/server.ts`：`chat_set_excluded` 协议（chatBusy 保护 + 广播刷新）。
- `src/web/index.html`：操作条「⊘ 出戏/回场」按钮（本地即时视觉 + 广播确认）；excluded 行样式（置灰、删除线、虚线、附注「出戏（不进上下文）」）；restoreHistory 透传。

**验证**：store.test「标出戏/回场字段往返 + 行保留」；assembler.test「excluded 行不进插槽 4」；端到端冒烟 excluded 应用成功（`PASS`）。✅

---

## 验证汇总
- `npm run typecheck` ✅
- `npx vitest run` → **9 files / 37 tests 全过**（新增 assembler 宏 ×2、excluded 过滤 ×1、store excluded ×1）
- ws 端到端：world-first 时序 + excluded 链路 ✅

## 遗留（下一轮候选）
- M6-2：{{random}} 在每回合渲染时是否允许变值（当前每次组装重随机——注意一致性）；mes_example <START> 宏展开
- M6-3：excluded 的整段（从某行到某行）批量操作
- 复查确认：结算（post-evaluator）不消费历史行（只读卡/状态），excluded 过滤对结算天然无影响 ✅
- 下一轮候选（原第 7 轮）：卡删除协议 + PNG 嵌卡导出 + /roll 骰子 + /help
