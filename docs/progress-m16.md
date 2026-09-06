# M16 提示词模板编辑器（工作台可编辑保存）

> 用户："全部执行完成啊？前端里也没看到重构"——M15 后端分层没配套前端展示与编辑能力。
> 补全：提示词段模板可编辑 + 保存持久化 + 工作台编辑入口。

## 后端
- PipelineConfig 增 `promptTemplates?: { routerSystem?, actorFrame? }`
- pre-router：导出 `DEFAULT_ROUTER_SYSTEM`；RouterInput.routerSystemTemplate（空=默认）
- pipeline：导出 `DEFAULT_ACTOR_FRAME`（{{char}} 占位）；演绎框架用
  `cfg.promptTemplates.actorFrame ?? DEFAULT`，`{{char}}` replaceAll 展开为主讲名
- store ChatMeta.settings 增 `promptTemplates`；settings_set 支持 routerSystem/actorFrame
  （字符串=保存、''=恢复默认、undefined=不动）；settings 回读带模板
- server runOneTurn cfg 透传 templates

## 前端（🎛 提示词工作台标题栏）
- 「✎ 路由模板」「✎ 演员模板」两钮 → openModal 多行 textarea：
  预填当前已存模板（空=内置默认）；保存发 settings_set；清空保存=恢复默认
- settings 事件回读存 promptTpl 全局（编辑时预填）
- 调试查看（System/世界库/近N层/Tools 分层）自动反映新结构与模板内容

## 验证
- typecheck ✓；**51/51 测试**（+1：路由 System 模板覆盖/默认）
- E2E：settings_set actorFrame 自定义 → 下回合 actor 请求 system 含自定义文本 +
  {{char}} 展开为角色名；空串恢复默认 —— PASS
- 服务 http://127.0.0.1:3100（真实模型）已重启

## 说明
- 模板作用于「路由 System」「演员演绎框架」两段（当前最重要）；世界观/主线等常驻段内容
  来自卡片本身（卡片在仓库编辑），不重复设模板
- 保存即持久化（会话级 settings）；重启不丢
