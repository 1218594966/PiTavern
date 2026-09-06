# M11 世界库卡片架构整改（通用常驻开关 · 世界观卡）

> 用户架构洞察：世界库 = 一张张卡片的逻辑仓库。每张卡片都有「常驻/非常驻」开关；
> 导入角色卡 = 解包它的世界书（character_book），逐条变独立卡片——世界观本身就是
> 一张**默认常驻**的卡。先做完整调查（校园.png 逐条字段 + ST 官方语义），后全量整改。

## 调查结论（校园.png 19 条 character_book 实测）
- 每条目自带 **constant**（作者已标注意图）：世界观/主线大纲/状态机/玩家人设 = constant:true
  =「常驻卡片」；人物志（带 keys 别名）= 非常驻（触发/进场抽）
- 每条还有 position(before/after_char)、insertion_order、selective、secondary_keys、
  enabled、use_regex —— 旧解析全丢
- data 层 mes_example/system_prompt/depth_prompt/talkativeness 等存而未用（后续活）

## 整改落地
### A 数据层
- `Card.constant?: boolean` 顶层通用开关（从 memory.data 私有提升；读兼容：store
  getCard/getCards normalize——data.constant=true 自动升顶）
- `MemoryCardData.mclass?: 'worldview'|'plot'|'rule'|'event'` 记忆小类
- MemoryCardStore/RedisCardStore 读归一化 normalizeCardConstant()

### B importer（尊重 ST 语义，五分类流水线）
character_book 每条目依序判定：
1. **player**：{{user}} 人设 → 玩家角色卡，默认 constant（作者关掉则非常驻）
2. **constant**：条目 constant===true（直读）或 keys 空 >200 字长文 → mclass 嗅探
   （世界观词→worldview / 主线大纲词→plot / 规则状态词→rule）+ **标题命名**
   （`# 名字 - 副题` 且主名与主体同名时取副题，如「暧昧高手 - 主线剧情发展大纲」→「主线剧情发展大纲」）
3. **人物志**：keys≥2 >80 字 / 单 key「表面上/实际上」体 → 角色池（作者标 constant 的
   角色卡常驻）；名字取标题行/「名，约N岁」
4. **事件记忆**兜底（非常驻，路由按关键词抽）
- 每条目 id/keys/position/order/enabled 尊重（enabled=false 跳过）

### C archive
- memory：mclass 透传 data；constant 写 Card 顶层
- character：constant 写 Card 顶层（常驻角色）

### D pipeline
- loadWorldIndex 产出 **constants: Card[]**（各 kind 顶层 constant 卡，exclude system/
  history——法则卡独立注入）；characters/memories 池按 constantIds 排除（常驻不抽）
- playerCard 保留（组装走玩家身份段）

### E assembler
- 输入 constantCards: Card[]；常驻区按小类分节渲染：
  【世界观设定 · 常驻】【主线剧情大纲 · 常驻】【规则 · 状态机 · 常驻】
  （记忆卡渲染 label=summary、body=detail；无 mclass 长文归世界观节）

### F server
- summarizeWorldCards 输出 constant/mclass；memory 名用 summary 兜底（不再显示 id）
- card_update 支持任意 kind `patch.constant` 拨动顶层开关（立即落盘+广播）

### G 前端画廊分类（memory 按 mclass 拆节）
- 🎮 玩家 / 🧙 角色 / 🧙 常驻角色 / 🌍 世界观 / 📖 主线剧情 / 🧭 规则·状态机 /
  📌 记忆·事件（含层回顾子分组）/ 🏰 场景 / 🗡️ 物品 / ⚖️ 世界法则
- 卡面「📌 常驻」角标；详情面板顶部「📌 常驻」checkbox（change 即发 card_update）

## 验证
- typecheck ✓；**46/46 测试**（+1：M11 五分类/mclass/constant 直读/副题命名）
- 校园.png 端到端：导入 → 世界观「世界观详情」(constant+mclass=worldview)、
  主线「主线剧情发展大纲」(constant+mclass=plot)、玩家卡 constant、
  13 角色池非常驻 → 拨动郑剑 constant=true 生效 —— **M11 FINAL PASS**
- 服务 http://127.0.0.1:3100 已重启

## 遗留
- data 层 mes_example/depth_prompt/talkativeness/system_prompt 尚未接入上下文/UI
- selective/secondary_keys/position/order 已识别未用（回写导出 + 未来选择性注入用）
- 世界书独立文件（extensions.world 引用外部 world info）未跟随导入（卡内嵌 book 已全量）
