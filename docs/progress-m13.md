# M13 常驻交互简化 · 记忆卡可编辑 · 牛皮纸主题

> 用户三点：
> 1. 常驻不需要单独界面/独立节——卡面上"在场"标记旁放个可点的「📌 常驻」chip 即可，
>    整个画廊统一这套交互；
> 2. 世界观/主线剧情卡为什么不能编辑（→ memory 卡缺编辑通道）；
> 3. UI 想要牛皮纸质感，可考虑换肤。

## 落地
### 常驻交互（画廊统一 chip）
- 删除画廊「🧙 常驻角色」独立节（角色全部回到 🧙 角色节，常驻以 chip 区分）
- 每张卡卡面（在场/可召唤 chip 之后）常驻 chip = **拨动开关**：
  - 已常驻：金底金边「📌 常驻」；未常驻：灰边透明钮「📌 常驻」，点击即设
  - click 直发 card_update(patch.constant) + 乐观变色，广播回齐
  - 所有 kind（角色/记忆/物品/场景…）统一这套 chip
- 详情面板内的常驻 checkbox 移除（不重复造界面）

### 记忆卡可编辑（世界观/主线现在能改）
- server card_update 新增 memory 分支：summary（标题）/ detail（正文）/ mclass 可改
- summarizeWorldCards 输出 detail + memSummary 供编辑框回填
- 画廊 memory 卡详情：标题输入 + 正文 textarea + 类别下拉（🌍/📖/🧭/📌 四选），💾 保存
- E2E：改世界观卡标题正文 → 回读成功（MEM EDIT PASS）

### 牛皮纸主题（覆盖层换肤）
- 全站亮纸色系：羊皮纸底 #e7dabf / 米黄卡 #f3e8cd / 墨褐字 #3a2d1a / 深金 #96691d
- header 深棕皮面带 + 金题字；NPC 气泡羊皮纸、user 深金纸；输入框纸白
- 噪点颗粒浅褐化、辉光改纸面柔光；modal/toast/画廊/调试面板/拆卡 mini 全纸化
- CSS 覆盖层追加于 <style> 尾（可整体回退）

## 验证
- typecheck ✓；47/47 测试；MEM EDIT E2E PASS
- 服务 http://127.0.0.1:3100 已重启（纸主题）

## M13-4 提示词工作台（常驻设置区）
- 四阶段流水线下方的调试卡升级为「🎛 提示词工作台」**常驻显示**（不再等回合才有内容）：
  - 顶部「📌 常驻注入」区：当前世界所有常驻卡 chips（🌍世界观/📖主线/🧭规则/🧙角色/🎮玩家）
    —— 点 ✕ 即取消常驻；语境行显示 系统法则/玩家身份/抽卡机制说明
  - 下方保留「📡 模型收发」查看（路由/演员完整 request/response 分层）
- 数据源 = world_cards 广播（页面加载即有；无常驻时给引导文案）

## M13-5 修复：场景卡 null 崩溃 + faux 路由解析
- 真实模型把 null 输出成字符串 `"null"` → pipeline 误判换场 →「选择了不存在的场景卡 null」崩溃。
  修：sanitizeRouteDecision + pipeline 双端把 `'null'/'undefined'/''` 归一为 null；单测锁定
- faux 路由解析：toolCall arguments 为**字符串**（多数 API）时被 JSON.stringify 二次包引号 →
  parse 失败。修：字符串直接用、对象才 stringify

## 备注
- 部分深色组件（dbg pre/代码区）保留墨色，作为纸面"墨迹"点缀
- 内联硬编码色仍有少量深色残点（拆卡动画等），如需可后续补纸色
