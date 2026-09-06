# M4 实现记录（2026-09 第四轮执行）

> 主题：玩家身份 × 卡生态 × 安全收尾。
> 配套：`docs/architecture-review.md`、`docs/progress-m1-m2.md`、`docs/progress-m3.md`。

---

## M4-1 Persona 玩家档案 + 宏替换 ✅

**目标**：玩家有「我是谁」，角色卡里的 `{{user}}`/`{{char}}` 占位宏能展开（SillyTavern 生态标准）。

**实现**：
- `src/types.ts`：`Persona { name; description?; avatar? }`；`ChatMeta.persona`（随会话存档，Redis/内存/文件快照自动跟随）。
- `src/db/store.ts`：`updateChat` Pick 扩展 persona（两实现合并赋值）。
- `src/utils/macros.ts`：`expandMacros(text, { userName, charName })` —— `{{user}}`(大小写变体) → persona 名，无 persona 兜底 `<user>`（ST 语义）；`{{char}}` → 角色名（缺则保留原文）；`hasUnresolvedMacros` 调试辅助。
- `src/web/server.ts`：
  - `persona_get` / `persona_set` 协议；
  - `seedGreeting` 播种开场白时展开宏；
  - `refreshGreetingForPersona`：persona 设置后，若会话只有开场白（turn 0）则用新 persona 重展开（不追溯历史对话）。
- 前端：header「🧙 名字 ✎」chip，显示/编辑玩家身份（名字 + 一句话描述）；world/chat 切换后自动 persona_get。

**验证**：macros.test ×4（大小写变体/兜底/char/未解析检测）；ws 端到端：导入带 `{{user}}` 开场白的卡 → greeting 先显示 `<user>` → persona_set 后重展开为「旅人阿飞！又见面了…」**PERSONA MACRO PASS**。✅

## M4-2 角色卡字段拆分（description / personality / scenario）✅

**目标**：round-trip 精确性根基 —— 三字段分开承载，渲染/导出不再靠拼接反解。

**实现**：
- `src/cards/schema.ts`：`ImportedCard` 增加 `personality` / `scenario` 分字段（body 专指 description 本体）。
- `src/types.ts`：`CharacterCardData.scenario?`。
- `src/cards/importer.ts`：主体角色卡与 extensions.npcs 分支按分字段产出（不再拼「性格:」「背景:」进 body）。
- `src/db/archive.ts`：toInternalCard 落库拆分（personality 空时回退 body 兼容老数据）；toTavernV2 精确导回 personality/scenario。
- `src/stages/assembler.ts`：renderCard 分字段渲染；老数据（personality==description）跳过重复「性格」行；scenario 输出「背景:」。

**验证**：archive.test round-trip 断言 personality='嘴硬心软，警惕生人'、scenario='深夜暴雨'、description 单独（此前导出 personality/scenario 为空串）。✅

## M4-3 角色画廊抽屉 UI ✅

**目标**：导入的角色卡可浏览/详查（头像/名字/描述/开场白/token），告别黑盒导入。

**实现**：
- `src/web/server.ts`：`world_cards` 协议 —— 世界全部卡摘要（kind/name/role/description/personality/scenario/openingLine/avatar/keywords/summary/textTokens）。
- `src/web/index.html`：世界库「🗂 画廊」按钮 → 右侧滑入抽屉（360px）；角色网格卡：头像（PNG 导入的 dataURL 直接显示）/名/token 估算；点击 alert 详情（身份/描述/性格/背景/开场白/触发词）。

**验证**：ws 冒烟 —— demo 世界 7 卡、2 角色（艾莉西亚 tok 68、安德鲁 tok 34）、openingLine 就绪。✅

## M4-4 PT_TOKEN 轻鉴权 ✅

**目标**：0.0.0.0 部署时给 WebSocket 加一道锁（HTTP 静态页不受限，适合内网/共享场景）。

**实现**：
- `src/web/server.ts`：WebSocketServer 改 `noServer: true` + `server.on('upgrade')` 校验 —— 设了 `PT_TOKEN` 后，WS 连接必须带 `?token=<PT_TOKEN>`，否则 401 拒绝；未设 PT_TOKEN 行为完全不变。
- `src/web/index.html`：连接 URL 从 `localStorage.pt_token` 取 token；页面 URL 带 `?token=xxx` 首次访问自动记住；连接被拒提示带 token 访问。

**验证**：无 token → 401 拒绝；`?token=sekret` → 正常 hello。✅

---

## 验证汇总
- `npm run typecheck` ✅
- `npx vitest run` → **9 files / 31 tests 全过**（新增 macros ×4；archive round-trip 断言增强）
- ws 端到端：persona 宏展开 ✅、画廊数据 ✅、token 鉴权 ✅

## 遗留（下一轮候选）
- M4-1：persona 头像上传 UI；{{random}}/{{group}} 等更多宏；mes_example <START> 块解析
- M4-3：画廊卡片详情内联（替代 alert）；卡片编辑入口（需 card_update 协议）
- M4-4：HTTPS 反代文档；token 轮换/多用户
- 下一里程碑 M5：多房间 + GM 控制台 + 前端工程化（见 architecture-review §5.3/§4.2）
