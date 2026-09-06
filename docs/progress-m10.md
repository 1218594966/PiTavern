# M10 世界库架构大修（V3 卡全量支持 · 基于 校园.png 解析报告）

> 触发：用户提供 `Card/校园.png`（chara_card_v3 3.0 + PNG tEXt chara/ccv3 base64 包裹），
> 要求以 SillyTavern 专家视角解析，并据此重构世界库。全量开工 P0→P1→P2。

## 解析报告核心发现（校园.png）
- 规格 **chara_card_v3 3.0**（非 V2）；PNG 双 tEXt：`chara` + `ccv3`，值 = base64 包 JSON
- 本体 0 填充（description 全空），内容全在 **character_book 19 条**：
  主线大纲 / 文风 / 「浮城」世界观 / 12+ 人物志（郑剑/安老头/范健/范涛/胡力/柳婷/
  江静/华馨兰/柳国正/吴诗/安佑琪/方佳怡）/ {{user}} 人设（范伟）/ 情感状态机 / 阶段好感规则
- = 一个压缩成单文件的世界仓库（1 玩家 + 12 NPC + 世界观 + 大纲）

## P0：V3 + base64 导入支持
- schema spec 放宽 `'chara_card_v2' | 'chara_card_v3'`
- parsePngCard：keyword 大小写不敏感 + 认 `ccv3`；多候选收集逐个解析（chara 失败可回退 ccv3）
- splitCharacterCard isV2Card 兼容 v3；测试（V3+小写 chara+base64 / ccv3 字段）✓

## P1-A：物品归属角色（所有权）
- `ItemCardData.ownerCharacterId?`：所有物归属（区别于 location"现在在哪"）
- 导入 round-trip：worldpack/ext items → ImportedCard.ownerCharacterId → Card.data
- renderCard 显示「所有者」；world_cards/画廊输出 owner + itemLocation/itemLocationId
- 前端：角色卡🎒「所有物」摘要行；物品卡 `[XX所有]` 前缀 + 位置；
  物品详情编辑（位置/所有者下拉）；角色详情挂其所有物子视图
- 测试：importer（owner 透传/无主缺省）+ archive round-trip ✓

## P1-B：玩家角色卡（isPlayer）
- `CharacterCardData.isPlayer?`；ImportedCard.player → archive role='玩家' + isPlayer
- book 启发式：keys 空 + 以 `{{user}}` 开头 + 短于 4000 → 玩家卡（提取括号名→「玩家·范伟」）
- loadWorldIndex：路由池排除 isPlayer；playerCard 供组装「【玩家身份】」段
- 画廊独立「🎮 玩家」节 + 🎮 图标；世界列表单独 player 计数
- 测试：book {{user}} 条 → 玩家卡（名字/去前缀/余为记忆）✓

## P2-A：常驻记忆（constant）
- `MemoryCardData.constant?`；book 显式 constant:true 或启发式（无 keys >200 字含
  世界观/主线/大纲/规则/设定词）→ 常驻记忆
- loadWorldIndex：常驻记忆不进路由抽卡池 → `constantMemories` 每回合全量进组装
  「【常驻 · 标题】正文」段（system 后、玩家身份前）；测试 ✓

## P2-B：V3 book 拆分（人物志 → 角色池）
- book 启发式：keys≥2 且长文 / 单 key 但「表面上/实际上/【基本信息】」双面体 → 独立角色卡
  （名字抽标题行 `# 名 - 副题` / `名，约N岁`）；郑剑们 12 人物志全拆为角色池 NPC
- 前端：角色池卡标「● 在场 / ○ 可召唤」（presentIdsNow 全局跟踪）；世界列表 🧙/🎮 计数分开
- 校园.png 导入结果：13 NPC（含安老头）+ 🎮 玩家·范伟 + 📜2 常驻（世界观+主线）+ 默认场景

## 验证
- typecheck ✓；**45/45 测试**（+4：V3 导入、玩家识别、owner round-trip、常驻/玩家段组装）
- 端到端：WS 导入校园.png → world_list {character:13, player:1, memory:2, scene:1} ✓
- 服务 http://127.0.0.1:3100（真实模型）已更新

## 遗留/后续
- 状态机/情感规则条（好感 0-100 阶段/羁绊规则）目前仍落普通记忆——后续可映射到
  好感系统（关系档案数值化）；regex/美化扩展暂剥离不渲染
- 角色池 12 NPC 全部常驻路由目录（name+role 摘要 ~60 token）——若卡库更大需池分页/搜索
