# M9 UI 卡牌游戏质感主题

> 用户需求：把 UI 做成类似卡牌游戏那种有质感、有动效的风格。

## 主题方向：暗色奇幻 + 鎏金镶边 + 卡面光影

### 色彩（新 palette）
- 底：深褐黑 `#0b0a08` + 暖色径向辉光（左上/右下低亮金）；
- 主色鎏金 `#d4af37`（含柔和字色 `#c9a25e`）、面板两层深褐、线金 `#6b5730`；
- 全站 `text-shadow` 轻微压字，纸张颗粒噪点 overlay（body::before 1px 点阵）。

### 卡片质感
- **所有 .card（侧栏卡盒）**：渐变面板 + `::before` 渐变鎏金描边（mask-composite 内嵌金线）
  + 顶部内高光 + 阴影；h3 标题带金线延长（letter-spacing + 渐隐横线）。
- **消息气泡**：NPC = 左金边 + 顶部 1px 高光渐变线 + 微暖内辉光；user = 深金渐变 + 右下小尾巴；
  入场 `msgIn`（上浮 + 轻微缩放回弹）；hover 显示金属小按钮操作条（上浮+金光）。
- **仓库卡 wcard**：悬浮抬升 + 金边亮起；选中 = 渐变金底 + **呼吸光晕**（activeGlow 循环）；
  封面小图带内阴影像卡面。
- **输入区**：嵌金输入框（focus 外发光）+ 发送按钮 3D 金属质感（立体底边、按压下沉、
  **流光扫过** btnSheen）；inputbar 顶部金线。

### 动效清单
- 标题 `sheen` 流光周期扫过；阶段圆点 done/running/error 径向渐变光 + running **ripple 扩散环**；
- 结算摘要卡 `settleIn` 浮现 + 顶部金条；think-line 呼吸文字辉光；
- 拆卡动画增强（sourcePop 带 drop-shadow 金光、cardFlyIn 带旋转回弹）；
- toast/modal/settings/slash/gallery/dbg 全部覆盖成深金卡面风格。

## 文件
- `src/web/index.html` 的 `<style>` 全量重写 + 两个覆盖层追加（组件卡面化、氛围动效）。

## 验证
- CSS 花括号配平 223/223；JS 语法检查过；
- faux 聊天回合冒烟（UI THEME RUN OK）；服务 http://127.0.0.1:3100 已更新。
