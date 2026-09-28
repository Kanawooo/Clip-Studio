import {
  InMemoryCredentialStore,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel as PiModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../security.js";
import {
  MODEL_THINKING_LEVELS,
  type ModelConfig,
  type ModelThinkingLevel,
  type ModelThinkingLevelMap,
  type ThinkingCapability,
} from "../tasks/types.js";
import { discoverModels, type DiscoveredModel } from "./model-discovery.js";
import {
  modelIdentityCandidates,
  resolveModelIdentity,
  type ResolvedModelIdentity,
} from "./model-identity.js";
import { officialThinkingCapability, officialThinkingCapabilityView } from "./thinking-capabilities.js";

export interface TaskModel {
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: ModelThinkingLevel;
}

export type VisionProbeStatus = "supported" | "unsupported" | "inconclusive";

export interface ModelConnectionTestResult {
  vision: {
    status: VisionProbeStatus;
    message: string;
  };
  thinking: ThinkingCapability & { levelMap?: ModelThinkingLevelMap };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MODEL_TEST_TIMEOUT_MS = 60_000;
const MODEL_METADATA_TIMEOUT_MS = 8_000;

/**
 * Convert the frontend model config into a native Pi model.
 *
 * Rules (documented in docs/PI-SDK.md):
 * - No baseUrl + provider/model is built into the installed Pi catalog:
 *   use the native built-in provider and set the API key through the native
 *   runtime credential store (in-memory).
 * - baseUrl provided: register a native custom provider with the explicit wire
 *   protocol and input capabilities supplied by the user.
 *
 * Everything lives in process memory: InMemoryCredentialStore + modelsPath: null.
 * The API key is never written to disk, logs, HTTP responses, or Git.
 */
export async function createTaskModel(
  config: ModelConfig,
): Promise<TaskModel> {
  if (!config.provider.trim() || !config.model.trim()) {
    throw new Error("model.provider and model.model must be non-empty strings");
  }

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  const providerId = config.provider.trim();
  const modelId = config.model.trim();
  const baseUrl = config.baseUrl?.trim();

  if (!baseUrl) {
    const builtin = modelRuntime.getModel(providerId, modelId);
    if (builtin) {
      await modelRuntime.setRuntimeApiKey(providerId, config.apiKey);
      return { modelRuntime, model: builtin, thinkingLevel: taskThinkingLevel(config, builtin) };
    }
    throw new Error(
      `Unknown model "${providerId}/${modelId}". Provide model.baseUrl to register a custom provider, or use a provider/model from the installed Pi catalog.`,
    );
  }

  if (!config.protocol) {
    throw new Error("model.protocol is required for a custom model");
  }
  if (!config.input?.length || !config.input.includes("text")) {
    throw new Error("model.input must include text for a custom model");
  }
  const isDeepSeekFlash = config.protocol === "openai-completions"
    && officialThinkingCapability(modelId)?.canonicalId === "deepseek-flash";
  const thinkingLevelMap = config.thinking?.levelMap
    ?? (isDeepSeekFlash ? officialThinkingCapabilityView(modelId)?.levelMap : undefined);

  // registerProvider requires an auth method to exist on the provider config.
  // The key is held only in this process (extension provider config map). The
  // runtime credential set below takes precedence when requests are resolved.
  modelRuntime.registerProvider(providerId, {
    name: providerId,
    baseUrl,
    api: config.protocol,
    apiKey: config.apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: config.thinking?.reasoning === true,
        input: [...new Set(config.input)],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        ...(isDeepSeekFlash ? { compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens" as const,
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek" as const,
        } } : {}),
      },
    ],
  });

  await modelRuntime.setRuntimeApiKey(providerId, config.apiKey);

  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`Failed to register custom model "${providerId}/${modelId}".`);
  }

  return {
    modelRuntime,
    model,
    thinkingLevel: taskThinkingLevel(config, model),
  };
}

export interface ModelCatalogItem {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  protocol: string;
  input: readonly string[];
  contextWindow: number;
  thinking: ThinkingCapability;
}

export async function listBuiltinModels(): Promise<ModelCatalogItem[]> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const apiKeyProviders = new Map(runtime.getProviders()
    .filter((provider) => Boolean(provider.auth.apiKey))
    .map((provider) => [provider.id, provider.name]));
  return runtime.getModels().filter((model) => (
    apiKeyProviders.has(model.provider) && model.input.includes("image")
  )).map((model) => ({
    provider: model.provider,
    providerName: apiKeyProviders.get(model.provider) ?? model.provider,
    model: model.id,
    name: model.name,
    protocol: model.api,
    input: model.input,
    contextWindow: model.contextWindow,
    thinking: thinkingCapabilityFromModel(model),
  }));
}

export async function testModelConnection(config: ModelConfig): Promise<ModelConnectionTestResult> {
  const { model, modelRuntime } = await createTaskModel(config.baseUrl
    ? { ...config, input: ["text", "image"] }
    : config);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS)]);
  try {
    const textRequest = testTextConnection(config, model, signal);
    const metadataRequest = config.baseUrl ? discoverTargetModels(config, signal) : Promise.resolve(undefined);
    const discovery = await Promise.race([metadataRequest, textRequest.then(() => metadataRequest)]);
    const metadata = discovery?.target;
    const input = config.baseUrl
      ? metadata?.input === null
        ? undefined
        : metadata?.input ?? knownModelInput(modelRuntime, model, config.model, discovery?.models ?? [])
      : model.input;
    const visionRequest = input === undefined
      ? testVisionCapability(config, model, signal)
      : Promise.resolve(visionResultFromModelInput(input));
    const [, vision] = await Promise.all([textRequest, visionRequest]);
    const thinking = config.baseUrl
      ? customThinkingCapability(config, metadata, discovery?.models ?? [], modelRuntime, model)
      : thinkingCapabilityFromModel(model);
    return { vision: vision.vision, thinking };
  } finally {
    controller.abort();
  }
}

async function discoverTargetModels(
  config: ModelConfig,
  signal: AbortSignal,
): Promise<{ target: DiscoveredModel; models: DiscoveredModel[] } | undefined> {
  if (!config.baseUrl || !config.protocol) return undefined;
  try {
    const models = await discoverModels({
      baseUrl: config.baseUrl,
      protocol: config.protocol,
      apiKey: config.apiKey,
    }, {
      targetModelId: config.model,
      includeTargetPage: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS)]),
    });
    const target = models.find((candidate) => candidate.id === config.model);
    return target ? { target, models } : undefined;
  } catch {
    if (signal.aborted) throw new Error("模型能力测试超时");
    return undefined;
  }
}

function knownModelInput(
  runtime: ModelRuntime,
  model: Model<any>,
  modelId: string,
  providerModels: readonly DiscoveredModel[],
): readonly string[] | undefined {
  const candidates = runtime.getModels().filter((candidate) => !sameModel(candidate, model));
  const identity = resolveModelIdentity({
    rawId: modelId,
    providerModels,
    catalog: candidates.map((candidate) => ({
      key: modelKey(candidate),
      id: candidate.id,
      aliases: [`${candidate.provider}/${candidate.id}`],
      capabilityKey: [...candidate.input].sort().join("|"),
    })),
  });
  if (identity.conflict || identity.catalogKeys.length === 0) return undefined;
  const matched = new Set(identity.catalogKeys);
  return candidates.find((candidate) => matched.has(modelKey(candidate)))?.input;
}

function visionResultFromModelInput(input: readonly string[]): Pick<ModelConnectionTestResult, "vision"> {
  if (input.includes("text") && input.includes("image")) {
    return { vision: { status: "supported", message: "模型信息声明支持图片输入" } };
  }
  return { vision: { status: "unsupported", message: "模型信息声明未同时支持文本与图片输入" } };
}

async function testTextConnection(config: ModelConfig, model: Model<any>, signal: AbortSignal): Promise<void> {
  let response;
  try {
    response = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with OK only.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: config.apiKey,
        maxTokens: 1024,
        maxRetries: 0,
        timeoutMs: 30_000,
        signal,
      },
    );
  } catch (error) {
    if (signal.aborted) throw new Error("模型连接测试超时");
    throw error;
  }
  if (signal.aborted || response.stopReason === "aborted") {
    throw new Error("模型连接测试超时");
  }
  if (response.stopReason === "error") throw new Error(response.errorMessage || "模型连接失败");
  if (!response.content.some((item) => item.type === "text" && item.text.trim())) {
    throw new Error("模型没有返回文本内容");
  }
}

async function testVisionCapability(
  config: ModelConfig,
  model: Model<any>,
  signal: AbortSignal,
): Promise<Pick<ModelConnectionTestResult, "vision">> {
  let lastResult: Pick<ModelConnectionTestResult, "vision"> | undefined;
  let outputWasTruncated = false;

  for (let attempt = 0; attempt < VISION_PROBE_ATTEMPTS.length; attempt += 1) {
    const probe = VISION_PROBE_ATTEMPTS[attempt];
    try {
      const visualResponse = await completeSimple(
        model,
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: probe.prompt },
              { type: "image", data: VISION_TEST_PNG, mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          }],
        },
        {
          apiKey: config.apiKey,
          maxTokens: probe.maxTokens,
          maxRetries: 0,
          temperature: 0,
          timeoutMs: 30_000,
          signal,
        },
      );
      if (visualResponse.stopReason === "error") {
        return visionResultFromError(redactSecrets(visualResponse.errorMessage || "图片请求失败", [config.apiKey]));
      } else if (signal.aborted || visualResponse.stopReason === "aborted") {
        return inconclusive("图片能力测试超时，请重新测试");
      } else {
        const text = visualResponse.content
          .map((item) => item.type === "text" ? item.text : "")
          .join(" ");
        const truncated = visualResponse.stopReason === "length";
        outputWasTruncated ||= truncated;
        lastResult = visionResultFromResponse(text, { truncated });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return visionResultFromError(redactSecrets(message, [config.apiKey]));
    }

    if (lastResult.vision.status !== "inconclusive") {
      return lastResult;
    }
  }

  return outputWasTruncated
    ? inconclusive("图片输出被截断，重试后仍无法确认")
    : lastResult ?? inconclusive("图片能力暂时无法确认");
}

export function thinkingCapabilityFromModel(
  model: Model<any>,
): ModelConnectionTestResult["thinking"] {
  if (!model.reasoning) {
    return {
      status: "unsupported",
      levels: [],
      source: "pi-explicit",
      message: "该模型未提供可调思考强度",
    };
  }
  const levels = normalizeThinkingLevels(getSupportedThinkingLevels(model));
  if (!levels.some((level) => level !== "off")) {
    return {
      status: "unsupported",
      levels: [],
      source: "pi-explicit",
      message: "该模型未提供可调思考强度",
    };
  }
  return {
    status: "supported",
    levels,
    source: "pi-explicit",
    message: `Pi 模型目录提供 ${levels.length} 个思考档位`,
    ...(model.thinkingLevelMap ? { levelMap: { ...model.thinkingLevelMap } } : {}),
  };
}

function customThinkingCapability(
  config: ModelConfig,
  discovered?: DiscoveredModel,
  providerModels: readonly DiscoveredModel[] = [],
  runtime?: ModelRuntime,
  model?: Model<any>,
): ModelConnectionTestResult["thinking"] {
  const metadata = providerThinkingCapability(discovered);
  const identity = runtime && model && config.protocol
    ? resolveThinkingIdentity(runtime, model, config.model, config.protocol, providerModels)
    : resolveModelIdentity({ rawId: config.model, providerModels });
  if (metadata?.status === "unsupported") return metadata;
  if (metadata) return recommendPreset(metadata, identity.presetThinkingLevel, false);
  if (identity.conflict) return unverifiedThinking(identity.conflict);

  const pi = runtime && model
    ? thinkingCapabilityForIdentity(runtime, model, identity)
    : undefined;
  if (pi && !(pi.status === "unsupported" && discovered?.reasoning === true)) {
    return recommendPreset(pi, identity.presetThinkingLevel, identity.evidence === "catalog-base");
  }

  const official = officialThinkingForIdentity(config.model, identity);
  if (official) return recommendPreset(official, identity.presetThinkingLevel, Boolean(identity.baseId));

  if (identity.siblingLevels.length > 0) {
    return supportedThinkingCapability(
      identity.siblingLevels,
      "provider-metadata",
      `模型服务中的同系列型号提供 ${identity.siblingLevels.length} 个思考档位`,
      identity.presetThinkingLevel,
    );
  }

  if (identity.presetThinkingLevel) {
    return supportedThinkingCapability(
      [identity.presetThinkingLevel],
      "unverified",
      `模型名预设：${thinkingLevelLabel(identity.presetThinkingLevel)}（仅确认这一档）`,
      identity.presetThinkingLevel,
    );
  }
  return {
    status: "unverified",
    levels: [],
    source: "unverified",
    message: "模型服务未提供可靠思考档位，未自动猜测",
  };
}

function providerThinkingCapability(
  item?: DiscoveredModel,
): ModelConnectionTestResult["thinking"] | undefined {
  if (!item || item.reasoning === undefined) return undefined;
  if (item.reasoning === false) {
    return {
      status: "unsupported",
      levels: [],
      source: "provider-metadata",
      message: "模型服务声明该模型没有可调思考强度",
    };
  }
  if (!item.thinkingLevels?.length) return undefined;
  const levels = normalizeThinkingLevels(item.thinkingLevels);
  return supportedThinkingCapability(levels, "provider-metadata", "已从模型服务获取明确思考档位");
}

function resolveThinkingIdentity(
  runtime: ModelRuntime,
  customModel: Model<any>,
  modelId: string,
  protocol: NonNullable<ModelConfig["protocol"]>,
  providerModels: readonly DiscoveredModel[],
): ResolvedModelIdentity {
  const candidates = runtime.getModels().filter((candidate) => (
    !sameModel(candidate, customModel)
    && candidate.api === protocol
  ));
  return resolveModelIdentity({
    rawId: modelId,
    providerModels,
    catalog: candidates.map((candidate) => ({
      key: modelKey(candidate),
      id: candidate.id,
      aliases: [`${candidate.provider}/${candidate.id}`],
      capabilityKey: thinkingCapabilityKey(thinkingCapabilityFromModel(candidate)),
    })),
  });
}

function thinkingCapabilityForIdentity(
  runtime: ModelRuntime,
  customModel: Model<any>,
  identity: ResolvedModelIdentity,
): ModelConnectionTestResult["thinking"] | undefined {
  const matched = new Set(identity.catalogKeys);
  const candidate = runtime.getModels().find((item) => (
    !sameModel(item, customModel) && matched.has(modelKey(item))
  ));
  return candidate ? thinkingCapabilityFromModel(candidate) : undefined;
}

function officialThinkingForIdentity(
  modelId: string,
  identity: ResolvedModelIdentity,
): ModelConnectionTestResult["thinking"] | undefined {
  const candidates = [
    modelId,
    ...(identity.baseId ? [identity.baseId] : []),
    ...modelIdentityCandidates(modelId).base,
  ];
  for (const candidate of candidates) {
    const capability = officialThinkingCapabilityView(candidate);
    if (capability) return capability;
  }
  return undefined;
}

function recommendPreset(
  capability: ModelConnectionTestResult["thinking"],
  preset: ModelThinkingLevel | undefined,
  requirePreset: boolean,
): ModelConnectionTestResult["thinking"] {
  if (!preset || capability.status !== "supported") return capability;
  if (!capability.levels.includes(preset)) {
    return requirePreset
      ? unverifiedThinking(`模型名预设“${thinkingLevelLabel(preset)}”不在已确认档位中`)
      : capability;
  }
  return { ...capability, recommendedLevel: preset };
}

function unverifiedThinking(message: string): ModelConnectionTestResult["thinking"] {
  return {
    status: "unverified",
    levels: [],
    source: "unverified",
    message,
  };
}

function thinkingCapabilityKey(capability: ModelConnectionTestResult["thinking"]): string {
  return JSON.stringify([
    capability.status,
    capability.levels,
    MODEL_THINKING_LEVELS.map((level) => capability.levelMap?.[level] ?? null),
  ]);
}

function modelKey(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}\0${model.id}`;
}

function sameModel(left: Pick<Model<any>, "provider" | "id">, right: Pick<Model<any>, "provider" | "id">): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function thinkingLevelLabel(level: ModelThinkingLevel): string {
  return ({
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
  } satisfies Record<ModelThinkingLevel, string>)[level];
}

function supportedThinkingCapability(
  levels: ModelThinkingLevel[],
  source: ThinkingCapability["source"],
  message: string,
  recommendedLevel?: ModelThinkingLevel,
): ModelConnectionTestResult["thinking"] {
  const levelSet = new Set(levels);
  const levelMap = Object.fromEntries(MODEL_THINKING_LEVELS
    .filter((level) => level !== "off")
    .map((level) => [level, levelSet.has(level) ? level : null])) as ModelThinkingLevelMap;
  return {
    status: "supported",
    levels,
    ...(recommendedLevel ? { recommendedLevel } : {}),
    source,
    message,
    levelMap,
  };
}

function normalizeThinkingLevels(levels: readonly string[]): ModelThinkingLevel[] {
  const available = new Set(levels);
  return MODEL_THINKING_LEVELS.filter((level) => available.has(level));
}

function taskThinkingLevel(config: ModelConfig, model: Model<any>): ModelThinkingLevel | undefined {
  const requested = config.thinkingLevel === undefined || config.thinkingLevel === "auto"
    ? config.thinking?.recommendedLevel
    : config.thinkingLevel;
  if (!requested) return undefined;
  return clampThinkingLevel(model, requested as PiModelThinkingLevel) as ModelThinkingLevel;
}

const VISION_PROBE_ATTEMPTS = [
  {
    maxTokens: 512,
    prompt: "观察图片的四个象限。只按左上、右上、左下、右下的顺序，输出四个英文大写颜色词，并使用 | 分隔，不要解释。",
  },
  {
    maxTokens: 1024,
    prompt: "重新观察同一张图片。必须只输出四个象限的实际颜色，顺序为左上、右上、左下、右下，使用英文大写颜色词和 | 分隔。示例 WHITE|BLACK|ORANGE|PURPLE 与本图无关。",
  },
] as const;

const VISION_TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAgMAAACJFjxpAAAADFBMVEUA/wD//wD/AAAAAP+JEOrQAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABIklEQVR42u3OMQEAMAwDoJisyZrcROToAwrIlF4pAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAueBLaUlICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcB34myuHcnITA/IAAAAASUVORK5CYII=";

export function visionResultFromResponse(
  text: string,
  options: { truncated?: boolean } = {},
): Pick<ModelConnectionTestResult, "vision"> {
  const preview = safeVisionPreview(text);
  if (isVerifiedVisionAnswer(preview)) {
    return { vision: { status: "supported", message: "图片识别测试通过" } };
  }
  if (options.truncated) {
    return inconclusive("图片输出被截断，重试后仍无法确认");
  }
  if (!preview) {
    return inconclusive("图片请求成功，但模型没有返回最终答案");
  }
  return inconclusive(`图片回答未匹配测试画面：${preview}`);
}

export function visionResultFromError(message: string): Pick<ModelConnectionTestResult, "vision"> {
  const unsupported = /(image|vision).{0,80}(not supported|unsupported)|does not support.{0,40}(image|vision)|unsupported.{0,40}(image|vision)|(?:不支持|无法处理).{0,30}(?:图片|图像|视觉)|(?:图片|图像|视觉).{0,30}(?:不支持|无法处理)/i.test(message);
  if (unsupported) {
    return { vision: { status: "unsupported", message: `服务明确拒绝图片输入：${safeVisionPreview(message)}` } };
  }
  if (/(?:\b429\b|rate.?limit|too many requests|限流|请求过多)/i.test(message)) {
    return inconclusive("图片能力测试受到限流，请稍后重试");
  }
  if (/(?:time.?out|timed out|超时)/i.test(message)) {
    return inconclusive("图片能力测试超时，请重新测试");
  }
  return inconclusive(`图片请求失败，暂时无法确认模型图片能力：${safeVisionPreview(message)}`);
}

function isVerifiedVisionAnswer(text: string): boolean {
  if (!text || /\b(?:guess|guessing|cannot|can't|unable)\b|无法.{0,12}(?:看|读取|识别)|不能.{0,12}(?:看|读取|识别)|猜测|猜一下/i.test(text)) {
    return false;
  }
  const normalized = text
    .replace(/黄色/g, "YELLOW")
    .replace(/蓝色/g, "BLUE")
    .replace(/红色/g, "RED")
    .replace(/绿色/g, "GREEN")
    .toUpperCase();
  const colors = normalized.match(/\b(?:YELLOW|BLUE|RED|GREEN|BLACK|WHITE|ORANGE|PURPLE|PINK|BROWN|GRAY|GREY)\b/g) ?? [];
  return colors.length === 4 && colors.join("|") === "YELLOW|BLUE|RED|GREEN";
}

function safeVisionPreview(text: string): string {
  const normalized = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}

function inconclusive(message: string): Pick<ModelConnectionTestResult, "vision"> {
  return { vision: { status: "inconclusive", message } };
}
