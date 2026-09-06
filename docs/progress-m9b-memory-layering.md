# M9b 记忆分层机制修正（双参数 + 完整上下文默认）

> 用户指正两件事：
> 1. 「完整上下文：不自动裁剪」开关是多余的（托裤子放屁）—— 上下文本来就该全量，
>    压缩是记忆分层的职责，默认即完整上下文；
> 2. 记忆分层机制理解错：不是「到 21 层就压 1-20」（会丢掉 21 的缓冲），
>    而是设**两个点**——压缩宽度 + 缓冲层；到 30 层才压 1-20，21-30 保持全文。

## 机制（用户语义）
- **压缩宽度 every**：每多少层把最旧的一个完整段压成摘要卡（默认 20）。
- **缓冲层 buffer**：最近多少层保持全文不压（默认 10）。
- 触发：完成第 T 层时，若 `(T - buffer)` 是 every 的整数倍且 ≥ every
  → 把 `[T-buffer-every+1, T-buffer]` 段压成层回顾摘要卡。
- 例（20/10）：完成第 30 层 → 压 [1,20]，21-30 全量；完成第 50 层 → 压 [21,40]，41-50 全量。
- 0 = 关闭（全部保持全文）。

## 改动
- `src/db/store.ts`：settings 改 `{ layerCompressEvery?, layerBuffer? }`（保留旧 summaryEveryTurns 读兼容）。
- `src/stages/summarizer.ts`：
  - `layerBoundaryHit(completed, every, buffer)` / `layerCompressRange(...)` 按新公式；
  - 语义以「刚完成层号 completed」为参（= 推进后 state.turn - 1）。
- `src/pipeline.ts`：cfg 两参数；触发处 `layerCompressRange(nextTurn-1, ...)`。
- `src/stages/assembler.ts`：**删除全部自动裁剪**（历史窗口、160 预算、层折叠、900 全局截断），
  完整上下文默认；`noTruncate` 输入字段移除。history 由 pipeline 全量取（400）。
- `src/web/server.ts`：settings_set 协议收两参数（旧字段映射 compress、buffer=0）；
  runOneTurn 透传。
- 前端 ⚙：删「🐞 调试 完整上下文」区；记忆分层改两输入（压缩宽度/缓冲层）+ 动态机制
  预览（updateLayerDemo 显示「完成第 N 层压 X-Y，M-Z 全文」示例文案）。

## 验证
- summarizer.test 新用例：20/10 → 完成第 30 层压 [1,20]，21~29 缓冲期不触发，50 → [21,40]；
  buffer=0 兼容旧语义 [1,20]@20；0 关闭。
- 端到端冒烟（width2+buffer1）：完成第 3 层自动生成 l1-2 摘要卡，第 3-4 层仍全文
  —— BUFFER LAYER PASS ✓。
- typecheck + 41/41 测试过；服务 http://127.0.0.1:3100 已更新。

## 遗留
- 连发节奏 <200ms 时偶见 turn 错位（两回合读同 turn）——chatBusy 已串行化 runOneTurn，
  但 runOneTurn 内部 read chat.state 与写回存在小竞态窗口，慢速/常规操作无感；
  候选修复：runOneTurn 开头重新读取 chat.state 覆盖 idx.state（读改写原子化）。
