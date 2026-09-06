# M8 实现记录（2026-09 第八轮执行）

> 主题：卡片架构整理 × 记忆分层（上下文结构化）。
> 用户主导需求：记忆按楼层分层（1-N 层摘要、最近层全文）；世界状态面板前端暂撤；
> 角色卡 = 静态人设 + 动态人设（关系网/成长档案）；世界法则结构化 + 大事记。

---

## M8-1 记忆分层系统 ✅

**语义（用户原话）**：玩家在设置里定「每几层总结一次」→ 每层自动形成摘要记忆卡；
上下文里「旧层段以摘要全量进入、最近段保留全文」（如 1-20 层摘要 + 20-30 层全文）。

**实现**：
- `MemoryCardData`：`isSummary/layerFrom/layerTo` —— 摘要卡标记覆盖回合区间。
- `src/stages/summarizer.ts`（新）：
  - `summarizeLayer()`：把 [layerFrom, layerTo] 段全文压缩成层回顾卡（真实 evaluator key →
    走模型，系统提示「RPG 复盘记录员」；faux → 确定性占位回顾）。**幂等**：同区间旧摘要卡先删再写。
  - `layerBoundaryHit(turnAfter, every)`：回合推进后若 `completed % every === 0` → 刚收层。
- `PipelineConfig.summaryEveryTurns`；pipeline 回合尾（state.turn 推进落盘后、world 广播前）
  **后台 fire-and-forget** 检查收层 → 过滤该层对话全行 → 压卡入库（不阻塞回合返回）。
- `ChatMeta.settings.summaryEveryTurns`；server 协议 `settings_get/settings_set`；
  runOneTurn 把 chat.settings 透传 pipeline。设置弹层（⚙）新增「🧠 记忆分层：每几层一摘要（0=关）」。
- **上下文组装（assembler）**：新「插槽 3A 剧情回顾 · 分层摘要」——
  - WorldIndex.layerSummaries：loadWorldIndex 时把世界内 isSummary 卡按层序整理；
  - 摘要链**全量贴入**（旧层全摘要），超出 layer 槽预算（210 tok）时**从最老段整体折叠**并标注
    「（更早 N 层已归档折叠）」；最近层无摘要卡 → 全文自然由插槽 4 呈现 —— 实现
    「旧层摘要全量 + 最近层全文」语义；
  - 总预算重分（900 不变）：system 100 / snapshot 330 / layer 210 / sticky 100 / history 160；
    tokenBreakdown 增 layer 字段（前端水位条已能展示）。

**验证**：
- summarizer.test ×3（边界命中/占位生成+幂等重压/assembler 摘要链全量+全文并存）；
- 端到端冒烟：settings 设 3 → 连打 3 回合 → `l1-3` 摘要卡自动出现（`LAYER PASS`）。✅

## M8-2 角色卡：静态人设 + 动态人设 ✅

- `CharacterCardData.relationships?: [{targetName, relation, note?}]` —— 关系网（谁/什么关系/备注）；
  好感数值仍在 state（关系定性 + 数值分离）。
- `CharacterCardData.progression?: string[]` —— 成长档案（经历大事按时间追加）。
- `renderCard` 角色段输出「关系网: …」「经历: …」→ 进上下文保证一致性。
- 画廊角色详情表单新增两字段（每行 `目标|关系|备注` / 每行一条经历），保存时前端行文本
  → 结构化数组，server card_update 白名单扩展（数组整体替换、空则清除）。

## M8-3 世界法则：结构化 + 大事记 ✅

- `SystemCardData.timeline?: string[]` —— 世界大事记（第 N 回合发生了…，可画廊追加编辑）。
- renderCard 法则段输出「大事记: …」；画廊 system 卡详情可编辑 timeline（只读展示 rules）。

## M8-4 前端调整 ✅

- **移除「世界状态」侧栏卡**（回合/场景/在场/好感 —— 用户：还没到那一步；面板渲染函数保留
  空安全守卫，未来可回）。
- 画廊「📜 记忆簿」**子分组**：🗂 层回顾（已归档剧情，按层序）/ 📌 即席记忆（普通记忆）。
- world_cards 摘要扩展：isSummary/layerFrom/layerTo/relationships/progression/timeline。

---

## 验证汇总
- `npm run typecheck` ✅；`npx vitest run` → **10 files / 41 tests 全过**（新增 summarizer ×3）
- 端到端：settings_set → 连打 3 回合 → 层摘要卡自动生成入库（幂等重压验证）✅

## 遗留（下一轮候选）
- 层摘要生成时机与回合结束的耦合：摘要用 evaluator 模型且后台跑，若用户在收层瞬间立刻发
  下一回合，摘要可能读到层内最后一条尚在写入的历史（可接受：异步偏差）；
- faux 占位摘要简单截断，无 key 演示时语义弱（真 key 自动走模型）；
- 世界大事记（timeline）目前手动编辑，尚未与结算/回合自动挂钩（候选：结算 roomChanges 大事件
  自动追加）；
- 记忆簿子分组 UI 内「层回顾卡」的 body 显示已带区间；
- 设置弹层「记忆分层」只对当前会话生效（per-chat settings）；未来可上世界级默认。
