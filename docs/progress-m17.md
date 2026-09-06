# M17 路由提示词措辞与消息分层校正

> 用户校正：
> 1. 总起句「你是选角导演…」应放进【规则】里（不是 System 开头独立句）；
> 2. 【工具】要把 route_cards 的参数含义写清楚（不要"见 schema"敷衍）；
> 3. 顺序 = 规则/工具 → 世界库档案总览 → 近 10 层记忆 → 模型回复；
>    「💬 用户(最新输入)」这层不该存在——玩家输入已在近 N 层记忆里（含本回合）。

## 落地
- DEFAULT_ROUTER_SYSTEM 重排：首行【规则】，选角导演总起句入规则；工具区逐参数写明
  语义（sceneCardId/characterCardIds/speakerCharacterId/memoryCardIds/itemCardIds/
  historyWindow/turn）；【输出】只调用 route_cards
- user content 去掉尾部「请调用 route_cards…」与「玩家现在:」尾巴（近 N 层全文为最后一段）
- **pipeline 路由窗口不再排除本回合玩家输入行**（该 filter 是为旧"重复尾巴"防重加的，
  尾巴删除后它反而让导演看不到玩家刚说的话）——近 N 层最后一行 = 玩家本回合输入
- 前端工作台：
  - 消息层拆段显示（system【规则/工具/输出】、user 的 世界库常驻/档案总览/摘要链/近N层
    各自成节，默认展开）
  - 不再显示「💬 用户(最新输入)」误导层：路由消息首段标
    「📍 回合信息与剧情输入（玩家输入已含于近N层末尾）」；演员消息标「💬 玩家输入」
  - splitCtxSections 按【】标题行拆段；dbgSec 默认展开（未手动折叠过的节全开）

## 验证
- typecheck ✓；51/51 测试
- E2E：system 首行【规则】/参数明细/无"见 schema"；user 无尾部指令；近 N 层含本回合
  玩家输入 —— 全绿
- 服务 http://127.0.0.1:3100（真实模型）已重启
