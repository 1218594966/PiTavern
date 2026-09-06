/**
 * 模型路由（新版 pi-ai：@earendil-works/pi-ai）
 *
 * - 每个阶段可独立配置 provider + model（PI_ROUTE_* / PI_ACTOR_* / PI_EVAL_*）
 * - 支持「上游模型发现」：refresh() 拉取 provider 的实时模型目录，
 *   再用 getAvailable() 只列出已配置好鉴权的模型，供交互选择
 * - 无 Key 时自动回退到 faux 脚本模型（Demo 零成本跑通全链路）
 *
 * 迁移自 @mariozechner/pi-ai 的全局 API（getModel/completeSimple）：
 *   旧: getModel('anthropic','claude-sonnet-4-5') + completeSimple(model, ctx)
 *   新: models.getModel('anthropic','claude-sonnet-4-5') + models.completeSimple(model, ctx)
 */
import 'dotenv/config';
import type { Model, Models } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import {
  getFauxRegistration,
  getModels as registryGetModels,
  resolveProviderKey as registryResolveProviderKey,
  ensureCustomProvider,
} from './provider-registry.js';
import { PitavernError } from './errors.js';

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
}

export type StageName = 'router' | 'actor' | 'evaluator';

const ENV_PREFIX: Record<StageName, string> = {
  router: 'PI_ROUTE',
  actor: 'PI_ACTOR',
  evaluator: 'PI_EVAL',
};

/** 各阶段的 faux provider/model id（注册在 provider-registry 的共享集合里） */
const FAUX_STAGE: Record<StageName, { provider: 'faux-router' | 'faux-actor' | 'faux-eval'; model: string }> = {
  router: { provider: 'faux-router', model: 'route-3b' },
  actor: { provider: 'faux-actor', model: 'actor-sonnet' },
  evaluator: { provider: 'faux-eval', model: 'eval-3b' },
};

const DEFAULT_MODELS: Record<StageName, ModelConfig> = {
  // 默认接入：CommandCode 自定义端点（https://api.commandcode.ai/provider/v1）
  // 配 COMMANDCODE_API_KEY 后即真实模型；未配 Key 自动回退 faux 演示
  router: { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash-fast' },
  actor: { provider: 'commandcode', model: 'claude-sonnet-5' },
  evaluator: { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash-fast' },
};

/* ------------------------- 单例 Models 集合 ------------------------- */

let modelsInstance: Models | null = null;

/**
 * 构建 Models 集合：委托给 provider-registry（内置 provider + 自定义端点）。
 */
function buildModels(): Models {
  return registryGetModels() as unknown as Models;
}

/** 取得全局 Models 集合（懒初始化单例） */
export function getModels(): Models {
  if (!modelsInstance) modelsInstance = buildModels();
  return modelsInstance;
}

/** 显式替换 Models 集合（测试注入用） */
export function setModelsInstance(m: Models): void {
  modelsInstance = m;
}

/** 列出已注册的 provider */
export function listProviders(): string[] {
  return getModels()
    .getProviders()
    .map((p) => p.id);
}

/* ------------------------- faux 假模型（Demo/测试回退） ------------------------- */

export interface FauxModels {
  router: Model<Api>;
  actor: Model<Api>;
  evaluator: Model<Api>;
  setResponses: (responses: { router?: unknown; actor?: unknown; evaluator?: unknown }) => void;
  getRouterModel: () => Model<Api>;
  getActorModel: () => Model<Api>;
  getEvaluatorModel: () => Model<Api>;
  callCount: () => number;
}

let fauxModelsInstance: FauxModels | null = null;

/**
 * faux 模型句柄。faux provider 已注册进与真实 provider 共享的集合
 * （见 provider-registry.buildModels），这里只是取句柄 + 便捷 setResponses。
 */
export function getFauxModels(): FauxModels {
  if (fauxModelsInstance) return fauxModelsInstance;

  const faux = {
    router: getFauxRegistration('faux-router'),
    actor: getFauxRegistration('faux-actor'),
    evaluator: getFauxRegistration('faux-eval'),
  };

  fauxModelsInstance = {
    router: faux.router.getModel()!,
    actor: faux.actor.getModel()!,
    evaluator: faux.evaluator.getModel()!,
    setResponses: ({ router, actor, evaluator }) => {
      const flatten = (v: unknown): unknown[] => (Array.isArray(v) ? v : v !== undefined ? [v] : []);
      if (router !== undefined) faux.router.setResponses(flatten(router) as never[]);
      if (actor !== undefined) faux.actor.setResponses(flatten(actor) as never[]);
      if (evaluator !== undefined) faux.evaluator.setResponses(flatten(evaluator) as never[]);
    },
    getRouterModel: () => faux.router.getModel()!,
    getActorModel: () => faux.actor.getModel()!,
    getEvaluatorModel: () => faux.evaluator.getModel()!,
    callCount: () =>
      faux.router.state.callCount + faux.actor.state.callCount + faux.evaluator.state.callCount,
  };
  return fauxModelsInstance;
}

/**
 * 全局共享集合（真实 provider + faux provider 混搭注册）。
 * demo / web / 测试统一用它跑流水线 —— 每阶段的模型由 getStageModel 解析
 * （配了 Key 用真实，没配用 faux），彻底告别「双集合切换」的维护负担。
 */
export function getFauxModelsCollection(): Models {
  return getModels();
}

/* ------------------------- 运行时阶段配置（网页/CLI 热设置） ------------------------- */

/** 运行时阶段配置表：网页 provider_set 写入，优先于 .env */
const runtimeStageConfig: Partial<Record<StageName, { provider: string; model: string }>> = {};

/** 设置某阶段的运行时 provider/model（网页 provider_set 调用） */
export function setStageRuntimeConfig(stage: StageName, provider: string, model: string): void {
  runtimeStageConfig[stage] = { provider, model };
}

/** 清除某阶段运行时配置（回退 .env/默认） */
export function clearStageRuntimeConfig(stage: StageName): void {
  delete runtimeStageConfig[stage];
}

/** 当前各阶段的运行时配置快照（供 UI 展示） */
export function getStageRuntimeConfigs(): Partial<Record<StageName, { provider: string; model: string }>> {
  return { ...runtimeStageConfig };
}

/* ------------------------- 解析与选择 ------------------------- */

/** 解析某阶段要用的模型配置（运行时 > 环境变量 → 默认） */
export function resolveModelConfig(stage: StageName, override?: Partial<ModelConfig>): ModelConfig {
  const prefix = ENV_PREFIX[stage];
  const def = DEFAULT_MODELS[stage];
  const runtime = runtimeStageConfig[stage];
  return {
    provider: runtime?.provider ?? process.env[`${prefix}_PROVIDER`] ?? override?.provider ?? def.provider,
    model: runtime?.model ?? process.env[`${prefix}_MODEL`] ?? override?.model ?? def.model,
    apiKey: process.env[`${prefix}_API_KEY`] ?? override?.apiKey,
  };
}

/** 判断该配置是否「没有真实 Key」——回退到 faux 脚本模型 */
export function isFaux(cfg: ModelConfig): boolean {
  // 阶段级 Key 或 provider 级 env Key 任一存在都算真实接入
  return !cfg.apiKey && !registryResolveProviderKey(cfg.provider);
}

/** 阶段配置里指定的 provider 是否已有可用 Key（env / 阶段级 / 运行时内存） */
export function providerHasKey(provider: string, stage?: StageName): boolean {
  return registryResolveProviderKey(provider, stage) !== undefined;
}

/**
 * 某阶段当前是否走「真实模型」：
 * - 有阶段级 Key，或 provider 级 env/运行时 Key（providerHasKey）→ 真实
 * - 否则 → faux 演示模型
 * 用于启动横幅 / hello 消息的 mode 展示。
 */
export function stageUsesRealModel(stage: StageName): boolean {
  const cfg = resolveModelConfig(stage);
  return !isFaux(cfg);
}

/**
 * 上游模型发现 + 交互选择：
 *   1. refresh() 拉取 provider 的实时模型目录（动态 provider 才有；静态内置目录直接可用）
 *   2. getAvailable() 只列出已配置好鉴权的模型
 *   3. 用 pick 回调让外部做交互选择（CLI 列表选择 / Web UI 下拉）
 *
 * @param providerId provider id（如 'deepseek'）
 * @param pick 选择回调：传入候选模型列表，返回选中的模型；返回 null 表示放弃
 * @param opts.refresh 是否强制 refresh（默认 true）
 */
export async function discoverModels(
  providerId: string,
  pick?: (candidates: Array<{ model: Model<Api>; id: string; name: string; contextWindow: number }>) => Promise<Model<Api> | null>,
  opts: { refresh?: boolean } = {},
): Promise<Model<Api> | null> {
  const models = getModels();
  if (opts.refresh !== false) {
    await models.refresh({ providers: [providerId] });
  }
  const available = await models.getAvailable(providerId);
  const candidates = available.map((m) => ({
    model: m,
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
  }));
  if (candidates.length === 0) return null;
  if (!pick) return candidates[0]!.model;
  return pick(candidates);
}

/** 无交互的便捷版：直接返回 provider 的第一个可用模型 */
export async function firstAvailableModel(providerId: string): Promise<Model<Api> | null> {
  return discoverModels(providerId, undefined, { refresh: false });
}

/**
 * 同步取某阶段的模型对象：
 * - 没有可用 Key → faux 脚本模型（demo 零成本回退）
 * - 有 Key（阶段级 / provider 级 / 运行时）→ 查真实 Models 集合；
 *   若模型不在目录（自定义端点尚未 refresh）→ 抛错提示刷新，
 *   **不静默回退 faux**（用户配了 Key 却悄悄用假模型，会误导调试）。
 *
 * 目录刷新是异步的：需要「配 Key 即生效」的入口请先 ensureCustomProvider +
 * refresh（如 server 启动、demo 启动），或直接用 resolveStageModelAsync。
 */
export function getStageModel(stage: StageName, override?: Partial<ModelConfig>): Model<Api> {
  const cfg = resolveModelConfig(stage, override);
  if (!isFaux(cfg)) {
    ensureCustomProvider(cfg.provider);
    const model = getModels().getModel(cfg.provider, cfg.model);
    if (model) return model;
    throw new PitavernError(
      'MODEL_UNAVAILABLE',
      `阶段 ${stage} 配置了真实模型 ${cfg.provider}/${cfg.model}，但模型目录里找不到它（自定义端点可能尚未 refresh）。` +
        `请在启动流程里 await models.refresh({ providers: ['${cfg.provider}'] }) 后重试。`,
    );
  }
  return fauxStageModel(stage);
}

/** 取某阶段的 faux 模型（共享集合里的 faux provider） */
export function fauxStageModel(stage: StageName): Model<Api> {
  return getFauxModels()[stage];
}

/**
 * 异步解析某阶段的真实模型；找不到时 refresh 一次再查。
 * 用于「用户明确配了 Key / 网页热切换」等需要确定性的路径。
 * 仍未找到 → 返回 null（调用方决定报错或回退 faux）。
 */
export async function resolveStageModelAsync(stage: StageName, override?: Partial<ModelConfig>): Promise<Model<Api> | null> {
  const cfg = resolveModelConfig(stage, override);
  if (isFaux(cfg)) return null;
  ensureCustomProvider(cfg.provider);
  const models = getModels();
  const fromCatalog = models.getModel(cfg.provider, cfg.model);
  if (fromCatalog) return fromCatalog;
  // 目录缺失：refresh（自定义端点拉 /models；静态 provider 为 no-op）
  await models.refresh({ providers: [cfg.provider] });
  return models.getModel(cfg.provider, cfg.model) ?? null;
}

/** 从完整模型对象里反解出 ModelConfig（供日志展示当前各阶段用的模型） */
export function describeModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}
