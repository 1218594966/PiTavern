/**
 * 交互式模型选择器（CLI 版）。
 *
 * 用法：
 *   npm run pick-model -- --stage actor            # 为 Actor 阶段选模型（写 .env）
 *   npm run pick-model -- --stage actor --dry-run  # 只列出候选，不写 .env
 *
 * 流程：
 *   1. refresh() 拉取该 provider 的上游实时模型目录
 *   2. getAvailable() 过滤出已配置好鉴权的模型
 *   3. 编号列表交互选择 → 把 provider/model 写回 .env（或打印）
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { discoverModels, getModels, listProviders, resolveModelConfig, type StageName } from './models.js';

const STAGES: StageName[] = ['router', 'actor', 'evaluator'];

function parseArgs(argv: string[]): { stage?: StageName; provider?: string; dryRun: boolean } {
  const out = { dryRun: false } as { stage?: StageName; provider?: string; dryRun: boolean };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') out.stage = argv[++i] as StageName;
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help') {
      console.log('用法: npm run pick-model -- --stage actor|router|evaluator [--provider <id>] [--dry-run]');
      process.exit(0);
    }
  }
  if (!out.stage) {
    console.error('缺少 --stage（router | actor | evaluator）');
    process.exit(1);
  }
  return out;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve_) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve_(ans);
    });
  });
}

/** 把选中的 provider/model 写进 .env（保留原文件其它内容） */
function writeEnv(stage: StageName, provider: string, model: string): void {
  const envPath = resolve(process.cwd(), '.env');
  const prefixMap = { router: 'PI_ROUTE', actor: 'PI_ACTOR', evaluator: 'PI_EVAL' } as const;
  const prefix = prefixMap[stage];

  let lines: string[] = [];
  if (existsSync(envPath)) lines = readFileSync(envPath, 'utf8').split('\n');

  const setOrReplace = (key: string, value: string) => {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  };
  setOrReplace(`${prefix}_PROVIDER`, provider);
  setOrReplace(`${prefix}_MODEL`, model);

  writeFileSync(envPath, lines.join('\n') + (lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : ''));
  console.log(`已写入 ${envPath}: ${prefix}_PROVIDER=${provider}, ${prefix}_MODEL=${model}`);
}

async function main() {
  const { stage, provider: providerArg, dryRun } = parseArgs(process.argv.slice(2));
  const stageName = stage!;

  // 1. 确定 provider
  let providerId = providerArg;
  if (!providerId) {
    const current = resolveModelConfig(stageName);
    const providers = listProviders();
    console.log('可用 provider:', providers.join(', '));
    const ans = await ask(`为阶段 ${stageName} 选择 provider（当前: ${current.provider}，直接回车用当前）: `);
    providerId = ans.trim() || current.provider;
  }

  // 2. 拉取上游模型目录 + 过滤可用
  console.log(`\n[发现] 刷新 ${providerId} 的上游模型目录...`);
  const models = getModels();
  const refresh = await models.refresh({ providers: [providerId] });
  if (refresh.errors.size > 0) {
    console.warn('[发现] refresh 部分失败:', [...refresh.errors.entries()].map(([k, v]) => `${k}: ${v.message}`).join('; '));
  }

  // discoverModels 用 getAvailable 只列已配好鉴权的模型；
  // pick 回调里做交互选择；一个都没有时退回完整目录并提示配 Key
  let selected: Awaited<ReturnType<typeof discoverModels>> = null;
  selected = await discoverModels(providerId, async (candidates) => {
    console.log(`\n[候选] ${providerId} 有 ${candidates.length} 个可用模型：`);
    const pageSize = 20;
    let offset = 0;
    let chosen: string | null = null;

    while (chosen === null) {
      const page = candidates.slice(offset, offset + pageSize);
      page.forEach((c, i) => {
        console.log(`  ${String(offset + i + 1).padStart(3)}. ${c.id}  (${c.name}, ctx=${c.contextWindow})`);
      });
      if (offset + pageSize < candidates.length) console.log(`  ... 还有 ${candidates.length - offset - pageSize} 个（输入 n 翻页）`);
      const ans = (await ask(`输入编号选择（1-${page.length}，n=下一页，q=放弃）: `)).trim();
      if (ans.toLowerCase() === 'q') return null;
      if (ans.toLowerCase() === 'n') {
        offset += pageSize;
        continue;
      }
      const idx = parseInt(ans, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= candidates.length) {
        chosen = String(idx);
      } else {
        console.log('无效编号，重试。');
      }
    }
    const picked = candidates[parseInt(chosen!, 10) - 1]!;
    console.log(`\n已选择: ${picked.id}`);
    return picked.model;
  });

  if (!selected) {
    const all = models.getModels(providerId);
    if (all.length > 0) {
      console.log(`\n[提示] ${providerId} 的 ${all.length} 个上游模型已发现，但未配置 API Key，无法选择。`);
      console.log('       请在 .env 中设置对应 API Key（如 DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY），然后重试。');
      console.log('       或为当前阶段设置 <PREFIX>_API_KEY 环境变量。');
    } else {
      console.log(`\n[提示] ${providerId} 没有可用的上游模型（provider 可能未注册或目录为空）。`);
    }
    process.exit(0);
  }

  // 3. 写回 .env 或打印
  if (dryRun) {
    console.log(`[dry-run] ${stageName} → ${providerId}/${selected.id}`);
  } else {
    writeEnv(stageName, providerId, selected.id);
  }
}

main().catch((err) => {
  console.error('[pick-model] 失败:', err);
  process.exit(1);
});
