# M18 默认世界 = 用户校园卡 · Tools 显示清理

> 用户：
> 1. 调试面板 Tools 里那句「工具定义（模型可调用）」多余 label 不该写（内容直接显示）；
> 2. 打开页面默认应该是「我的那张角色卡」（校园），不是演示旅馆的艾莉西亚。

## 落地
### 默认世界 = 校园卡
- **服务端幂等补种**：启动时若 `Card/校园.png` 存在且 world_校园 未导入 → 自动导入为
  默认世界 world_校园（全新/恢复存储都补，演示旅馆保留为备选）
- **auto 默认**：world_select 支持 `auto` = 有校园用校园，无则 demo_world；
  非法 worldId 回退 demo_world（防静默卡死）
- **记住上次玩的世界**：前端 localStorage `pt_last_world`，hello 后优先 select 记忆值，
  无记忆发 auto（校园）
- 打开页面 = 校园卡（郑剑们）；🎴 列表里 demo 旅馆仍可切

### Tools 显示
- 去掉「工具定义（模型可调用）」rq-label 行，工具 schema 直接展示

## 验证
- typecheck ✓；51/51 测试
- 启动日志：已播种 demo + 已补种 world_校园；auto → world_校园；world_list
  [demo_world, world_校园]，current=world_校园；会话标题「与 郑剑 的冒险」
  （世界开场白自动开场）——全绿
- 服务 http://127.0.0.1:3100（真实模型）已重启
