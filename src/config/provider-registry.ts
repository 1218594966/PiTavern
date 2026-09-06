/**
 * Provider 运行时注册中心 —— 「真正接入模型」的核心。
 *
 * 目标：网页/CLI 填好 API Key 后立刻生效，无需重启。
 *
 * 设计：
 * - 内置工厂：anthropic / openai / deepseek / openrouter / groq / moonshot / mistral / xai / cerebras / huggingface
 *   按需懒注册（每个 provider 的 SDK 只在首次请求时加载）
 * - 每个阶段的 Key 可以：
 *   1) 阶段级 PI_<STAGE>_API_KEY（优先）
 *   2) provider 级 DEEPSEEK_API_KEY 等（回退）
 *   3) 网页/CLI 运行时写入的内存 Key（最高优先，无需写 .env）
 * - 请求时通过 options.apiKey 透传（新 pi-ai 支持请求级覆盖）
 * - 自定义 OpenAI 兼容端点（如 OneAPI / LiteLLM / vLLM）：openai-completions + baseUrl 动态 provider
 */
import 'dotenv/config';
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { huggingfaceProvider } from '@earendil-works/pi-ai/providers/huggingface';
import type { Model, MutableModels, Provider } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { StageName } from './models.js';

/* ------------------------- provider 目录 ------------------------- */

export interface ProviderEntry {
  id: string;
  name: string;
  /** 该 provider 读取 API Key 的环境变量名（逗号分隔取第一个存在的） */
  envKeys: string[];
  /** 是否为 OpenAI 兼容端点（可自定义 baseUrl） */
  openaiCompat?: boolean;
  /** 可选：自定义 baseUrl（openaiCompat 时生效） */
  baseUrl?: string;
  build: () => Provider;
}

/** 内置 provider 目录（id → 构建函数）。动态注册时按需调用。 */
const BUILTIN: Record<string, () => Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  openrouter: openrouterProvider,
  groq: groqProvider,
  moonshot: moonshotaiProvider,
  mistral: mistralProvider,
  xai: xaiProvider,
  cerebras: cerebrasProvider,
  huggingface: huggingfaceProvider,
};

/** provider id → 它用的环境变量 Key 名 */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  huggingface: ['HF_TOKEN'],
  commandcode: ['COMMANDCODE_API_KEY'],
};

/* ------------------------- 自定义 OpenAI 兼容端点（默认：CommandCode） ------------------------- */

/** 默认自定义端点：CommandCode（OpenAI 兼容） */
export const DEFAULT_CUSTOM_ENDPOINT = {
  id: 'commandcode',
  name: 'CommandCode',
  baseUrl: process.env.COMMANDCODE_BASE_URL ?? 'https://api.commandcode.ai/provider/v1',
  envKeyName: 'COMMANDCODE_API_KEY',
};

/** 运行时注册的自定义端点表（id → baseUrl） */
const customEndpoints = new Map<string, string>([
  [DEFAULT_CUSTOM_ENDPOINT.id, DEFAULT_CUSTOM_ENDPOINT.baseUrl],
]);

/** 运行时注册自定义端点（网页/CLI 调用；Key 存内存或 .env） */
export function registerCustomEndpoint(id: string, baseUrl: string, apiKey: string): void {
  customEndpoints.set(id, baseUrl);
  if (apiKey) setRuntimeKey(id, apiKey);
}

/** 查询某 id 是否为自定义端点，返回 baseUrl */
export function getCustomEndpointBaseUrl(id: string): string | undefined {
  return customEndpoints.get(id);
}

/** 列出所有自定义端点 */
export function listCustomEndpoints(): Array<{ id: string; baseUrl: string }> {
  return [...customEndpoints.entries()].map(([id, baseUrl]) => ({ id, baseUrl }));
}

/**
 * 判断模型走哪种协议（CommandCode 混合端点：claude 前缀 → Anthropic Messages，其余 → OpenAI 兼容）
 */
function modelApiFor(providerId: string, modelId: string): 'openai-completions' | 'anthropic-messages' {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude')) return 'anthropic-messages';
  return 'openai-completions';
}

/**
 * 构建自定义端点 provider 并注册进集合。
 * 支持混合协议：Claude 模型走 Anthropic Messages API，其余走 OpenAI 兼容 API。
 * 用 fetchModels 从 /models 拉取真实模型目录。
 */
export function ensureCustomProvider(id: string): void {
  const models = getModels();
  if (models.getProvider(id)) return; // 已注册
  const baseUrl = customEndpoints.get(id) ?? DEFAULT_CUSTOM_ENDPOINT.baseUrl;
  const apiKey = resolveProviderKey(id) ?? '';
  const mkModel = (modelId: string, name: string, ctx: number) => ({
    id: modelId,
    name,
    api: modelApiFor(id, modelId),
    provider: id,
    baseUrl,
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx,
    maxTokens: 8192,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  const provider = createProvider({
    id,
    name: id === DEFAULT_CUSTOM_ENDPOINT.id ? DEFAULT_CUSTOM_ENDPOINT.name : `自定义端点 ${id}`,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${id} API key`, [`${id.toUpperCase()}_API_KEY`]) },
    models: [
      // 兜底模型：refresh 拉取真实目录后叠加（避免空列表导致 getModel 失败）
      mkModel('claude-sonnet-5', 'Claude Sonnet 5（兜底）', 1000000),
    ],
    fetchModels: async () => {
      try {
        const url = baseUrl.replace(/\/+$/, '') + '/models';
        const key = resolveProviderKey(id) ?? apiKey;
        const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id: string; name?: string; context_length?: number }> };
          if (data.data?.length) {
            return data.data.map((m) => mkModel(m.id, m.name ?? m.id, m.context_length ?? 128000));
          }
        }
      } catch {
        /* 拉取失败保留兜底模型 */
      }
      return [];
    },
    // 混合协议分派：按模型 api 字段路由到不同实现
    api: {
      'openai-completions': openAICompletionsApi(),
      'anthropic-messages': anthropicMessagesApi(),
    },
  });
  models.setProvider(provider);
}

/** 运行时内存 Key 表（网页/CLI 写入，优先于 .env） */
const runtimeKeys = new Map<string, string>();

/** 网页/CLI 写入某 provider 的运行时 Key */
export function setRuntimeKey(providerId: string, apiKey: string): void {
  runtimeKeys.set(providerId, apiKey.trim());
}
export function clearRuntimeKey(providerId: string): void {
  runtimeKeys.delete(providerId);
}
export function getRuntimeKeys(): Record<string, string> {
  return Object.fromEntries(runtimeKeys);
}

/** 解析某 provider 当前生效的 Key（运行时 > 阶段级 > provider 级 env） */
export function resolveProviderKey(providerId: string, stage?: StageName): string | undefined {
  const stageKey = stage ? process.env[`PI_${stageNameToPrefix(stage)}_API_KEY`] : undefined;
  if (stageKey) return stageKey;
  const runtime = runtimeKeys.get(providerId);
  if (runtime) return runtime;
  const envNames = PROVIDER_ENV_KEYS[providerId] ?? [];
  for (const name of envNames) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

function stageNameToPrefix(stage: StageName): string {
  return stage === 'router' ? 'ROUTE' : stage === 'actor' ? 'ACTOR' : 'EVAL';
}

/** 列出所有可接入的 provider（内置 + 自定义端点，自定义端点排最前） */
export function listProviderCatalog(): Array<{ id: string; name: string; envKeys: string[]; configured: boolean; baseUrl?: string }> {
  const custom = listCustomEndpoints().map((e) => ({
    id: e.id,
    name: e.id === DEFAULT_CUSTOM_ENDPOINT.id ? DEFAULT_CUSTOM_ENDPOINT.name : `自定义 ${e.id}`,
    envKeys: PROVIDER_ENV_KEYS[e.id] ?? [],
    configured: resolveProviderKey(e.id) !== undefined,
    baseUrl: e.baseUrl,
  }));
  const builtin = Object.keys(BUILTIN).map((id) => ({
    id,
    name: id,
    envKeys: PROVIDER_ENV_KEYS[id] ?? [],
    configured: resolveProviderKey(id) !== undefined,
  }));
  return [...custom, ...builtin];
}

/* ------------------------- Models 集合 ------------------------- */

let modelsInstance: MutableModels | null = null;

/** faux 的 provider 注册表（id → 注册句柄）——供"混搭集合"复用同一组 faux */
const fauxRegistrations = new Map<string, ReturnType<typeof fauxProvider>>();

/**
 * 构建 Models 集合：注册全部内置 provider（懒加载 SDK，不请求网络）
 * + 三个 faux 演示 provider（无真实 Key 时各阶段回退用）。
 * faux 与真实 provider 同处一个集合 ⇒ demo/web 不再需要「真实集合 / faux
 * 集合」双集合切换，任一阶段配了 Key 其它阶段仍可走 faux（混合配置）。
 */
function buildModels(): MutableModels {
  const models = createModels();
  for (const [id, build] of Object.entries(BUILTIN)) {
    try {
      models.setProvider(build());
    } catch (err) {
      console.warn(`[registry] provider ${id} 注册失败（已跳过）:`, err);
    }
  }
  for (const def of [
    { provider: 'faux-router', model: 'route-3b', tps: 80 },
    { provider: 'faux-actor', model: 'actor-sonnet', tps: 120 },
    { provider: 'faux-eval', model: 'eval-3b', tps: 60 },
  ]) {
    try {
      const f = fauxProvider({
        provider: def.provider,
        models: [{ id: def.model, name: `faux ${def.provider}`, reasoning: false }],
        tokensPerSecond: def.tps,
      });
      models.setProvider(f.provider);
      fauxRegistrations.set(def.provider, f);
    } catch (err) {
      console.warn(`[registry] faux provider ${def.provider} 注册失败（已跳过）:`, err);
    }
  }
  modelsInstance = models;
  return modelsInstance;
}

/** 取某 faux provider 的注册句柄（未注册先 buildModels；测试可直接 setResponses） */
export function getFauxRegistration(provider: 'faux-router' | 'faux-actor' | 'faux-eval'): ReturnType<typeof fauxProvider> {
  if (fauxRegistrations.size === 0) buildModels();
  const f = fauxRegistrations.get(provider);
  if (!f) throw new Error(`faux provider ${provider} 未注册`);
  return f;
}

/** 取得全局 Models 集合（懒初始化单例） */
export function getModels(): MutableModels {
  if (!modelsInstance) buildModels();
  return modelsInstance!;
}

/** 测试注入（替换集合） */
export function setModelsInstance(m: MutableModels): void {
  modelsInstance = m;
}

/**
 * 取某阶段的模型对象：
 * - provider 有 Key（运行时或 env）→ 真实模型（查集合目录）
 * - 无 Key → 返回 null（调用方决定是否回退 faux）
 */
export function getRealModelOrNull(stage: StageName, provider: string, modelId: string): Model<Api> | null {
  const models = getModels();
  const m = models.getModel(provider, modelId);
  if (!m) return null;
  return m;
}

/** 请求级 apiKey 透传：解析该阶段最终生效的 Key（传给 options.apiKey） */
export function apiKeyForStage(stage: StageName, provider: string): string | undefined {
  return resolveProviderKey(provider, stage);
}

/* ------------------------- 连通性测试 ------------------------- */

/**
 * 用给定 Key 测试某个 provider 是否真的能通。
 * 发一个极小请求（"ping"），成功返回 true。
 */
export async function testProviderConnection(providerId: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const models = getModels();
    // 自定义端点先确保注册 + 拉取目录
    if (customEndpoints.has(providerId)) {
      ensureCustomProvider(providerId);
      await models.refresh({ providers: [providerId] });
    }
    // 优先用便宜的小模型 id，目录里没有就取第一个（跳过兜底模型）
    const preferred = pickTestModel(providerId);
    const all = models.getModels(providerId);
    const model = all.find((m) => m.id === preferred) ?? all.find((m) => m.id !== 'claude-sonnet-5') ?? all[0];
    if (!model) {
      return { ok: false, message: `provider ${providerId} 没有可用模型（目录为空）` };
    }
    const msg = await models.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
      { apiKey, maxTokens: 8, cacheRetention: 'none' },
    );
    if (msg.stopReason === 'error' || msg.errorMessage) {
      return { ok: false, message: msg.errorMessage ?? '请求失败' };
    }
    return { ok: true, message: `连通成功（模型 ${model.id}）` };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
}

/** 每个 provider 挑一个便宜的小模型做连通性测试 */
function pickTestModel(providerId: string): string {
  const table: Record<string, string> = {
    anthropic: 'claude-3-5-haiku-20241022',
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    openrouter: 'deepseek/deepseek-chat',
    groq: 'llama-3.1-8b-instant',
    moonshot: 'moonshot-v1-8k',
    mistral: 'mistral-small-latest',
    xai: 'grok-2-latest',
    cerebras: 'llama3.1-8b',
    huggingface: 'meta-llama/Meta-Llama-3-8B-Instruct',
    // 自定义端点（commandcode 等）：用端点自带、基础套餐可用的模型
    commandcode: 'deepseek/deepseek-v4-flash-fast',
  };
  // 未知自定义端点：fallback 到兜底模型 id
  return table[providerId] ?? 'claude-sonnet-5';
}

/** 列出某 provider 的上游模型（静态目录直接可用；自定义端点/动态目录 refresh 拉取） */
export async function listUpstreamModels(providerId: string): Promise<Array<{ id: string; name: string; contextWindow: number }>> {
  const models = getModels();
  const isCustom = customEndpoints.has(providerId);
  // 自定义端点总是 refresh 拉真实目录（可能有兜底模型，refresh 后叠加真实列表）
  if (isCustom) {
    await models.refresh({ providers: [providerId] });
  } else {
    // 静态目录已有模型就直接返回（不发起网络请求，避免卡住）
    const staticModels = models.getModels(providerId);
    if (staticModels.length > 0) {
      return staticModels.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
    }
    await models.refresh({ providers: [providerId] });
  }
  return models.getModels(providerId).map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
}

/* ------------------------- 自定义 OpenAI 兼容端点 ------------------------- */
