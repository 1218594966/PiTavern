# M7b 仓库界面实现记录（第七轮补充）

> 用户主导的需求澄清与落地：**一张导入的游戏卡 = 一个仓库**。
> 补充 M7（UI 大修）之后的「仓库可视化」增量。

## 需求（用户原话语义）
- 「每个角色卡 PNG 一个仓库」——实际是**一张游戏卡**（PNG/JSON）一个仓库，游戏卡内可含**多个角色**（阵营/副本/NPC 群）；
- 导入一张卡后自动**拆解分门别类**进仓库；
- 界面上：仓库要有界面、有分类、可查看，导入即归位。

## 现状核对（重要：数据模型天然匹配）
- 此前每张导入卡/世界包 → `importWorldToArchive` 已自动建**独立世界**（world_<名字>），
  内部把角色/场景/记忆/物品分别落库并登记到世界目录 —— **一游戏卡=一世界=一仓库已成立**；
- character_book → 记忆卡（ownerCharacterId 归属）、extensions.pitavern 的 npcs/scenes/items → 各类型卡（M1 已实现）。
- 缺的是：**仓库感 UI**（分类分组、封面、计数、归属）。

## 本轮改动
### server
- `listPlayableWorlds()` 升级为**仓库摘要**：每世界返回
  `counts {character/memory/scene/item/system}`、`avatar`（首个带头像角色的封面）、
  `characters[]`、`kind demo|import`、可读 name；
- `summarizeWorldCards()` 记忆卡补 `ownerCharacterId`（画廊记忆簿显示归属）。

### 前端（index.html）
- **世界库列表 → 仓库卡**：封面头像缩略图（主角 PNG 头像；无则 🃏/🍺 图标）、
  名字、分类徽章（🧙n 📜n 🏰n 🗡️n）、当前世界发光圆点、点击切换；
- **画廊抽屉 → 分组浏览**：按 🧙角色 / 📜记忆簿 / 🏰场景 / 🗡️物品 / 🌍系统 分节，
  每节带计数徽章；记忆卡前缀 `[归属角色]`（ownerCharacterId 反查名字）；
  卡片点击仍展开内联详情/编辑/删除（M7 已建）；
- 导入成功 → toast 汇总 `已导入「xx」：🧙n 角色 · 📜n 记忆 · 🏰n 场景 · 🗡️n 物品`。

## 验证
- 模拟一张含 2 角色 + 场景 + 物品的 V2 游戏卡导入：
  `imported counts: {character:2, scene:1, item:1}`；world_list 仓库摘要
  `米德加夜未眠 🧙2 🏰1 🗡️1 chars=[蒂法,克劳德]` —— **PACK DATA PASS**；
- 全部既有测试 38/38 通过；typecheck 干净。

## 说明与遗留
- V2 扩展必须写在 `data.extensions.pitavern`（V2 规范内），顶层 extensions 不被解析（冒烟首轮即踩此格式坑）；
- 仓库的「世界」语义保留：多仓库角色可同台（demo_world 混编）仍是远期能力；
- 封面头像目前取第一个带 avatar 的角色；游戏卡无图时占位 🃏；
- 后续候选：仓库级重命名/删除（连带世界与会话清理）、仓库搜索、本体卡字段编辑（已能改但画廊内 system 卡只读）。
