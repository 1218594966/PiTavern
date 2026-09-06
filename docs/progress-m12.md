# M12 选卡架构修正（角色卡 = 世界容器 · 开场白归卡不归角色）

> 用户指正三处：
> 1. 群像卡导出的「暧昧高手」空壳不应成为角色；
> 2. 缺少「选择角色卡」层级——一张导入的 PNG = 一张可玩的卡，选中后才看它的世界库；
> 3. 世界库（仓库）里的角色不需要每人有开场白——开场白属于"卡/世界"层。

## 架构定论
- **一张导入 PNG（角色卡）= 一个可玩世界容器**（"仓库"）：内含角色池/世界观/记忆…
- **世界库（侧栏/画廊）永远只呈现当前选中卡的世界**；选卡在「🎴 我的角色卡」列表进行
- **开场白（first_mes）归"卡"所有**：真角色卡（有实质 description）→ first_mes 仍是主体
  角色的 openingLine；**空壳群像包**（description/personality/scenario 全空 + book 有料）
  → 不生成主体 NPC，first_mes 提升为「世界级开场白」（WorldState.greeting）

## 落地
### importer（splitCharacterCard）
- isHollowShell 判定（主体空壳 + book 含 keys 条目或 ≥3 enabled）→ **跳过主体 NPC 生成**
- importCards：主体缺失时 first_mes → `worldGreeting`（ImportResult 新字段，带出）
  - mainName 兼容 V2/V3 data.name；玩家卡不算主体
  - PNG 头像不再挂到池 NPC（无主体时前端图标兜底）

### store/archive
- `WorldState.greeting?: { speaker, text }`
- `importWorldToArchive(store, cards, name, { worldGreeting })` 落库
- `getWorldGreeting`：世界级 greeting 优先 → fallback 扫角色 openingLine（demo 兼容）

### server
- world_import 传 worldGreeting；world_list 每世界带 greeting 预览
  （前端选卡卡面显示「💬 开场白预览」）

### 前端
- 侧栏世界库卡 → **「🎴 我的角色卡（点选一张开始游玩）」**：
  每卡 = 封面头像 + 名字 + 🧙🎮📜🏰🗡️ 计数 + **开场白两行预览** + 「示例」徽章（demo）；
  点击即选中该卡进入其世界（已有交互保留）
- 画廊角色卡照常浏览当前卡世界内容

## 验证
- typecheck ✓；**47/47 测试**（+1：空壳群像无主体 NPC + first_mes→worldGreeting +
  真角色卡保留 openingLine 且无 worldGreeting）
- 端到端（WS 导入校园.png）：角色池 12（无暧昧高手）、世界 greeting=3548 字开场、
  角色带开场白 0 个、玩家卡就位 —— 全绿
- 服务 http://127.0.0.1:3100 已重启

## 遗留
- 世界级 greeting 的 speaker 为空（叙述体开场）→ 前端以世界名显示气泡
- 选卡卡面头像：无主体角色的群像卡暂无 PNG 封面（后续加 world 级 avatar 字段）
