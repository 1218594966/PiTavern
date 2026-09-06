# M3 实现记录（2026-09 第三轮执行）

> 配套：`docs/architecture-review.md`（路线图）、`docs/fixes-2026-09.md`、`docs/progress-m1-m2.md`。
> 本轮：Swipe 楼层、V2 完整 round-trip、文件持久化（「关掉不丢」）。

---

## M3-1 楼层（Swipe）多版本回复 ✅

**目标**：同一条 NPC 回复可来回切换历史版本（SillyTavern 楼层交互的本地化）。

**实现**：
- `src/types.ts`：`HistoryLine.swipes?: string[]` —— 该消息的旧楼层（旧→新），`text` 恒为当前展示版。
- `src/db/store.ts`：新增接口 `setChatMessageSwipes(chatId, messageId, text, swipes)`（Redis/内存双实现，去重：空串/与当前相同的版本不存）；抽取 `rewriteChatList` 复用删除/编辑/切换的 LIST 重写。
- `src/web/server.ts`：
  - `chat_regenerate` 升级：删除重跑前保留旧回复（含其已有 swipes）→ 新回复生成后把旧楼层**迁移**到新回复的 swipes → 广播 `chat_history_changed`（前端显示楼层指示）。runOneTurn 现在返回新 NPC 消息 id。
  - 新增 `chat_swipe { messageId, direction: 'prev' }`：切回最近旧版（text ↔ swipes 队尾互换，往返成立）。无旧版时报错提示走 regenerate。语义闭环：
    `text=C, swipes=[A,B]` → prev → `text=B, swipes=[A,C]` → prev → `text=C, swipes=[A,B]`（回到原状）。
- `src/web/index.html`：NPC 消息 hover 操作条显示「◀ 楼层（n 个旧版）」；「↻ 新楼层」取代原「重roll」；restoreHistory 透传 swipes 计数。

**验证**：store.test「setChatMessageSwipes 版本切换 + 去重」；ws 端到端：chat(v1) → regenerate(v2, swipes=[v1]) → swipe prev 切回 v1 → 再 prev 切回 v2 —— **SWIPE ROUNDTRIP PASS**。✅

## M3-2 V2 卡元数据完整 round-trip ✅

**目标**：导入的 SillyTavern V2 卡元数据不再丢失，导出可完整回写。

**实现**：
- `src/cards/schema.ts`：`ImportedCard` 增加 V2 元数据字段：`mesExample` / `alternateGreetings` / `systemPrompt` / `postHistoryInstructions` / `creatorNotes` / `creator` / `characterVersion` / `tags`。
- `src/types.ts`：`CharacterCardData` 同步增加 8 个元数据字段（不参与上下文渲染，仅存档/导出）。
- `src/cards/importer.ts`：splitCharacterCard 从 V2 data 原样透传（此前 mes_example 等被丢弃）。
- `src/db/archive.ts`：toInternalCard 落库透传；`toTavernV2` 导回标准 V2 字段（含 mes_example / alternate_greetings / system_prompt / post_history_instructions / creator_notes / creator / character_version / tags）。
- `src/web/server.ts`：导出走 toTavernV2（已有 world_export_characters 协议自动获得完整字段）。

**验证**：archive.test「V2 元数据精确往返 + 再导入闭环」——mes_example 含 `{{char}}`、alternate_greetings 双元素、creator/version/tags 等全部往返；导出的 V2 再 import 后字段仍完整。✅

**局限**：personality/scenario 与 description 以拼接形式存于 body，导出时 description=body、personality/scenario 为空串（语义不丢，字段拆分需进一步重构）。

## M3-3 FileCardStore 文件持久化（「关掉不丢」）✅

**目标**：不依赖 Redis 也能持久化 —— 重启后世界/会话/历史/好感度全恢复。

**实现**：
- `src/db/store.ts`：`MemoryCardStore.dumpSnapshot() / loadSnapshot()`（全量结构化快照）+ `MemorySnapshot` 类型。
- `src/db/file-store.ts`：`FileCardStore extends MemoryCardStore` ——
  - 所有写路径覆写后 debounce（默认 300ms）落盘 `PITAVERN_DATA_DIR/state.json`（tmp + rename 原子写）；
  - `init()` 启动恢复（快照损坏备份跳过不阻断）；
  - `close()` 强制 flush 挂起写（SIGINT/SIGTERM 路径）；
  - 写串行化（persistChain + seq 防旧写覆盖新写）。
  - `openDefaultStore()`：**PITAVERN_DATA_DIR（文件）> REDIS_URL（Redis）> 内存** 统一选择 + `recovered` 标记。
- 接入：`src/web/server.ts`（仅全新存储时播种 demo，恢复快照保留现场；SIGINT/SIGTERM flush）、`src/demo.ts`、`src/db/seed.ts`（播种入口总是写入）。

**验证**：
- file-store.test ×3：写→重建实例读回（卡/世界/会话/历史/usage 全恢复）；close flush 挂起 debounce 写；损坏快照不阻断。
- 端到端：起 server（PITAVERN_DATA_DIR）→ ws 发消息 → SIGINT → state.json 落盘 → 再起 server「已恢复快照」→ 历史含测试消息。✅

---

## 验证汇总
- `npm run typecheck` ✅
- `npx vitest run` → **8 files / 27 tests 全过**（新增：store swipe ×1、file-store ×3）
- ws 端到端：swipe 往返 ✅、文件持久化恢复 ✅

## 遗留（下一轮候选）
- M3-1：swipe 楼层 UI 的「下一版」方向（当前 prev 往返 + regenerate 生成新版已够用；真 index 化楼层需要 versions+index 存储重构）
- M3-2：personality/scenario 字段拆分存储（渲染与导出双精确）
- M3-3：多进程安全（文件锁/多实例写同一目录）；快照增量 vs 全量（数据量大后）
- 下一里程碑 M4：多房间 + GM + 前端工程化（见 architecture-review 5.3）
