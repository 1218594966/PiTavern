/**
 * PiTavern 全链路 Demo —— 无 API Key 也能跑（faux 假模型）。
 *
 *   npm run demo        # 用 faux 模型跑通四阶段流水线（自动 seed 示例世界）
 *   npm run seed        # 把种子卡片写入内存/Redis
 *
 * 想用真实模型：复制 .env.example 为 .env，填 PI_ROUTE_* / PI_ACTOR_* / PI_EVAL_*
 * （或 COMMANDCODE_API_KEY）；配了 Key 的阶段自动切真实模型，没配的仍走 faux。
 */
import 'dotenv/config';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { openDefaultStore } from './db/file-store.js';
import type { CardStore } from './db/store.js';
import { getFauxModels, getModels, getStageModel, stageUsesRealModel } from './config/models.js';
import { ensureCustomProvider } from './config/provider-registry.js';
import { seedDemoWorld, runTurn } from './pipeline.js';

async function main() {
  // ---- 存储层：PITAVERN_DATA_DIR（文件持久化）> REDIS_URL（Redis）> 内存 ----
  const opened = await openDefaultStore();
  const store: CardStore = opened.store;
  console.log(`[PiTavern] 存储: ${opened.kind} — ${opened.detail}`);

  // ---- 种子：卡片入库 + 世界指针（await 落盘完成，无 sleep 竞态） ----
  const index = await seedDemoWorld(store);

  // ---- 模型路由：三阶段可独立配置；无 Key 自动落 faux ----
  // 共享集合里同时注册真实与 faux provider，各阶段自行解析：
  //   demo 默认不设 Key → 三阶段都落 faux（无需 Key 也能跑全链路）
  // 配了 Key（如 .env 的 COMMANDCODE_API_KEY）→ 先 refresh 目录再解析真实模型
  const models = getModels();
  const wantReal = stageUsesRealModel('router') || stageUsesRealModel('actor') || stageUsesRealModel('evaluator');
  if (wantReal) {
    ensureCustomProvider('commandcode');
    await models.refresh({ providers: ['commandcode'] });
  }
  const routerModel = getStageModel('router');
  const actorModel = getStageModel('actor');
  const evaluatorModel = getStageModel('evaluator');
  const anyReal = stageUsesRealModel('router') || stageUsesRealModel('actor') || stageUsesRealModel('evaluator');
  console.log(`[PiTavern] 阶段1 PreRouter 模型: ${routerModel.provider}/${routerModel.id}${anyReal && !stageUsesRealModel('router') ? '（faux）' : ''}`);
  console.log(`[PiTavern] 阶段3 Actor    模型: ${actorModel.provider}/${actorModel.id}${anyReal && !stageUsesRealModel('actor') ? '（faux）' : ''}`);
  console.log(`[PiTavern] 阶段4 Evaluator 模型: ${evaluatorModel.provider}/${evaluatorModel.id}${anyReal && !stageUsesRealModel('evaluator') ? '（faux）' : ''}`);

  // ---- faux 模式：预置三阶段脚本响应（让 Demo 无需 Key 也完整走通） ----
  const faux = getFauxModels();
  if (!anyReal) {
    faux.setResponses({
      router: fauxAssistantMessage([
        fauxText(
          JSON.stringify({
            sceneCardId: null,
            characterCardIds: ['char_alicia'],
            speakerCharacterId: 'char_alicia',
            memoryCardIds: ['mem_andrew_fallout'],
            itemCardIds: [],
            historyWindow: 6,
            turn: 1,
          }),
        ),
      ]),
      actor: fauxAssistantMessage([
        fauxText(
          '艾莉西亚把围裙一角卷了卷，指节在柜台上轻轻一叩，目光在雨夜里压得很低。\n' +
            '「安德鲁？哈。」她笑了一声，语气像在磨刀，「那笔货款够他在炉边烧三年了。你提他做什么——是来替他还债，还是来听我骂他？」',
        ),
      ]),
      evaluator: fauxAssistantMessage([
        fauxText(
          JSON.stringify({
            affectionChanges: [{ characterId: 'char_alicia', delta: -1 }],
            innerThoughts: [{ characterId: 'char_alicia', thought: '提到安德鲁让她想起旧账，戒备又重了一分，但也在试探这个外乡人知道多少。' }],
            roomChanges: [],
            itemTransfers: [],
            newMemoryCards: [],
          }),
        ),
      ]),
    });
  }

  // ---- 跑一轮四阶段 ----
  console.log('\n==============================');
  console.log('回合 1：玩家 -> "你们这儿，跟铁匠安德鲁是不是有过节？"');
  console.log('==============================\n');

  const userMessage = '你们这儿，跟铁匠安德鲁是不是有过节？';

  let streamed = '';
  const result = await runTurn(
    {
      worldId: 'demo_world',
      models,
      routerModel,
      actorModel,
      evaluatorModel,
      store,
      onDelta: (d) => {
        process.stdout.write(d);
        streamed += d;
      },
      onSettled: (r) => {
        console.log('\n\n[后台结算完成]', JSON.stringify(r, null, 2));
        settleDone?.();
      },
    },
    index,
    userMessage,
  );

  console.log('\n\n-------------------------------');
  console.log('阶段 1 抽卡清单:', JSON.stringify(result.decision, null, 2));
  console.log('阶段 2 拼装结果: token =', result.assembled.tokenEstimate, '(上限 900)');
  console.log('拼装 Prompt 预览:\n', result.assembled.prompt.slice(0, 600), '...');
  console.log('-------------------------------');
  console.log(`阶段耗时: 路由 ${result.timings.routerMs.toFixed(1)}ms | 组装 ${result.timings.assembleMs.toFixed(2)}ms | 演员 ${result.timings.actorMs.toFixed(1)}ms`);
  console.log(`requestId: ${result.requestId}`);

  // 等后台结算落盘：用 Promise 挂在 onSettled 上（真实模型 1~2s，faux 限速流式约 1s）
  const settled = new Promise<void>((resolve) => {
    // onSettled 已在 runTurn 里配置，这里额外挂一个完成信号
    settleDone = resolve;
  });
  await settled;

  // ---- 展示闭环：结算后的世界状态 ----
  const state = await store.getWorldState('demo_world');
  console.log('\n[闭环验证] 结算后的世界指针:');
  console.log('  当前场景:', state?.currentSceneId, '| 在场角色:', state?.presentCharacterIds, '| 回合:', state?.turn);
  const alicia = await store.getCard('char_alicia');
  if (alicia && alicia.kind === 'character') {
    const d = alicia.data as { state: { affection: number; innerThought: string } };
    console.log('  艾莉西亚 好感度:', d.state.affection, '| 内心想法:', d.state.innerThought);
  }
  const history = await store.recentHistory('demo_world', 10);
  console.log('  滑动历史条数:', history.length, '| 最新一条:', JSON.stringify(history.at(-1)?.text ?? '').slice(0, 60));

  await store.close();
  console.log('\n[PiTavern] Demo 结束。');
}

let settleDone: (() => void) | null = null;

main().catch((err) => {
  console.error('[PiTavern] Demo 失败:', err);
  process.exit(1);
});
