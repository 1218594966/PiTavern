/**
 * 种子脚本：把演示卡片与初始世界状态写入存储层。
 *   npm run seed                         # 内存（进程结束即消失）
 *   REDIS_URL=... npm run seed           # Redis 持久化
 *   PITAVERN_DATA_DIR=./data npm run seed # 文件持久化（关掉不丢）
 */
import 'dotenv/config';
import { openDefaultStore } from '../db/file-store.js';
import type { CardStore } from '../db/store.js';
import { seedDemoWorld } from '../pipeline.js';

async function main() {
  const opened = await openDefaultStore();
  const store: CardStore = opened.store;
  console.log(`[seed] 存储: ${opened.kind}（${opened.detail}）`);

  const index = await seedDemoWorld(store);
  console.log(`[seed] 已写入 ${index.allCards.length} 张卡片 + 世界指针 demo_world`);
  for (const c of index.allCards) console.log(`  - ${c.id} (${c.kind})`);

  await store.close();
}

main().catch((err) => {
  console.error('[seed] 失败:', err);
  process.exit(1);
});
