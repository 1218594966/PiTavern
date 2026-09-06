/**
 * 真实接入向导：npm run connect
 *
 * 流程：
 *   1. 选 provider（deepseek / anthropic / openai / openrouter / groq / …）
 *   2. 输入 API Key（存内存 + 可选写 .env）
 *   3. 拉取上游模型列表 → 选择本阶段模型
 *   4. 连通性测试（发一个 ping）
 *   5. 写入 .env（PI_<STAGE>_PROVIDER / _MODEL / _API_KEY）
 *
 * 支持 --stage / --provider / --key / --model / --test-only / --no-write
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getModels,
  listProviderCatalog,
  setRuntimeKey,
  testProviderConnection,
  listUpstreamModels,
} from './provider-registry.js';
import type { StageName } from './models.js';

const STAGES: StageName[] = ['router', 'actor', 'evaluator'];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

// 单例 readline：多次 ask 复用同一个接口（每次新建会导致 stdin 缓冲/EOF 问题）
let rl: ReturnType<typeof createInterface> | null = null;
function getRl() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

async function ask(question: string): Promise<string> {
  const r = getRl();
  return new Promise((res) => {
    r.question(question, (ans) => {
      res(ans);
    });
  });
}

function writeEnv(entries: Record<string, string>): void {
  const envPath = resolve(process.cwd(), '.env');
  let lines: string[] = [];
  if (existsSync(envPath)) lines = readFileSync(envPath, 'utf8').split('\n');
  for (const [key, value] of Object.entries(entries)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, lines.join('\n') + '\n');
  console.log(`\n✓ 已写入 ${envPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = (args.stage as StageName) || 'actor';
  if (!STAGES.includes(stage)) {
    console.error('--stage 必须是 router | actor | evaluator');
    process.exit(1);
  }

  // 1. 选 provider
  let provider = args.provider;
  if (!provider) {
    const catalog = listProviderCatalog();
    console.log('可接入的 provider:');
    catalog.forEach((p, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${p.id}${p.configured ? '  (已配置 Key)' : ''}`);
    });
    const ans = await ask(`\n为阶段 ${stage} 选择 provider (1-${catalog.length}，或输入 id): `);
    const idx = parseInt(ans, 10);
    provider = !Number.isNaN(idx) && idx >= 1 && idx <= catalog.length ? catalog[idx - 1]!.id : ans.trim();
  }
  if (!listProviderCatalog().some((p) => p.id === provider)) {
    console.error(`未知 provider: ${provider}`);
    process.exit(1);
  }

  // 2. 输入 Key
  let apiKey = args.key ?? '';
  if (!apiKey) {
    apiKey = (await ask(`输入 ${provider} 的 API Key（输入后回车）: `)).trim();
  }
  if (!apiKey) {
    console.error('未输入 Key，退出。');
    process.exit(1);
  }
  setRuntimeKey(provider, apiKey);
  console.log(`✓ Key 已载入内存（provider: ${provider}）`);

  // 3. 拉取上游模型 + 选择
  console.log(`\n[发现] 拉取 ${provider} 上游模型目录...`);
  let models = await listUpstreamModels(provider);
  if (models.length === 0) {
    console.log('上游目录为空。请直接输入模型 id（如 deepseek-chat / claude-sonnet-4-5 / gpt-4o）:');
    const manual = (await ask('模型 id: ')).trim();
    models = [{ id: manual, name: manual, contextWindow: 0 }];
  }
  let modelId = args.model;
  if (!modelId) {
    console.log(`\n${provider} 的 ${models.length} 个模型：`);
    const pageSize = 15;
    for (let i = 0; i < Math.min(models.length, pageSize); i++) {
      console.log(`  ${String(i + 1).padStart(2)}. ${models[i]!.id}  (${models[i]!.name})`);
    }
    if (models.length > pageSize) console.log(`  ... 共 ${models.length} 个（输入完整模型 id 也可）`);
    const ans = (await ask(`选择模型 (1-${Math.min(models.length, pageSize)}，或输入 id): `)).trim();
    const idx = parseInt(ans, 10);
    modelId = !Number.isNaN(idx) && idx >= 1 && idx <= models.length ? models[idx - 1]!.id : ans;
  }

  // 4. 连通性测试
  console.log(`\n[测试] 用 ${provider}/${modelId} 发连通性请求...`);
  const test = await testProviderConnection(provider, apiKey);
  console.log(`[测试] ${test.ok ? '✓' : '✗'} ${test.message}`);
  if (!test.ok && !args['force']) {
    console.log('（用 --force 可跳过测试继续）');
    process.exit(1);
  }

  // 5. 写入 .env
  if (args['no-write'] || args['dry-run']) {
    console.log(`\n[dry-run] ${stage} → ${provider}/${modelId}`);
    return;
  }
  const prefix = stage === 'router' ? 'PI_ROUTE' : stage === 'actor' ? 'PI_ACTOR' : 'PI_EVAL';
  writeEnv({
    [`${prefix}_PROVIDER`]: provider,
    [`${prefix}_MODEL`]: modelId,
    [`${prefix}_API_KEY`]: apiKey,
  });
  console.log(`\n完成！阶段 ${stage} 已接入 ${provider}/${modelId}。重启 npm run web 生效（或网页里直接填 Key 立即生效）。`);
}

main().catch((err) => {
  console.error('[connect] 失败:', err);
  process.exit(1);
});
