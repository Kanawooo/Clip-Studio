import { InMemoryCredentialStore, clampThinkingLevel, } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MODEL_THINKING_LEVELS, } from "../tasks/types.js";
import { discoverModels } from "./model-discovery.js";
import { officialThinkingCapabilityView } from "./thinking-capabilities.js";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
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
export async function createTaskModel(config) {
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
        throw new Error(`Unknown model "${providerId}/${modelId}". Provide model.baseUrl to register a custom provider, or use a provider/model from the installed Pi catalog.`);
    }
    if (!config.protocol) {
        throw new Error("model.protocol is required for a custom model");
    }
    if (!config.input?.length || !config.input.includes("text")) {
        throw new Error("model.input must include text for a custom model");
    }
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
                ...(config.thinking?.levelMap ? { thinkingLevelMap: config.thinking.levelMap } : {}),
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
export async function listBuiltinModels() {
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const apiKeyProviders = new Map(runtime.getProviders()
        .filter((provider) => Boolean(provider.auth.apiKey))
        .map((provider) => [provider.id, provider.name]));
    return runtime.getModels().filter((model) => (apiKeyProviders.has(model.provider) && model.input.includes("image"))).map((model) => ({
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
export async function testModelConnection(config) {
    const { model } = await createTaskModel(config);
    const response = await completeSimple(model, {
        messages: [
            {
                role: "user",
                content: "Reply with OK only.",
                timestamp: Date.now(),
            },
        ],
    }, {
        apiKey: config.apiKey,
        maxTokens: 8,
        timeoutMs: 30_000,
    });
    if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "model connection failed");
    }
    const vision = await testVisionCapability(config, model);
    const thinking = config.baseUrl
        ? await testCustomThinkingCapability(config)
        : thinkingCapabilityFromModel(model);
    return { vision: vision.vision, thinking };
}
async function testVisionCapability(config, model) {
    if (!config.baseUrl && !model.input.includes("image")) {
        return { vision: { status: "unsupported", message: "模型目录声明仅支持文本" } };
    }
    const visualModel = config.baseUrl
        ? (await createTaskModel({ ...config, input: ["text", "image"] })).model
        : model;
    let lastResult;
    let outputWasTruncated = false;
    for (let attempt = 0; attempt < VISION_PROBE_ATTEMPTS.length; attempt += 1) {
        const probe = VISION_PROBE_ATTEMPTS[attempt];
        try {
            const visualResponse = await completeSimple(visualModel, {
                messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: probe.prompt },
                            { type: "image", data: VISION_TEST_PNG, mimeType: "image/png" },
                        ],
                        timestamp: Date.now(),
                    }],
            }, {
                apiKey: config.apiKey,
                maxTokens: probe.maxTokens,
                maxRetries: 0,
                temperature: 0,
                timeoutMs: 30_000,
            });
            if (visualResponse.stopReason === "error") {
                lastResult = visionResultFromError(visualResponse.errorMessage || "图片请求失败");
            }
            else {
                const text = visualResponse.content
                    .map((item) => item.type === "text" ? item.text : "")
                    .join(" ");
                const truncated = visualResponse.stopReason === "length";
                outputWasTruncated ||= truncated;
                lastResult = visionResultFromResponse(text, { truncated });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastResult = visionResultFromError(message);
        }
        if (lastResult.vision.status !== "inconclusive") {
            return lastResult;
        }
    }
    return outputWasTruncated
        ? inconclusive("图片输出被截断，重试后仍无法确认")
        : lastResult ?? inconclusive("图片能力暂时无法确认");
}
export function thinkingCapabilityFromModel(model) {
    const official = officialThinkingCapabilityView(model.id);
    if (official)
        return official;
    if (!model.reasoning) {
        return {
            status: "unsupported",
            levels: [],
            source: "pi-explicit",
            message: "该模型未提供可调思考强度",
        };
    }
    if (!isCompleteThinkingLevelMap(model.thinkingLevelMap)) {
        return {
            status: "unverified",
            levels: [],
            source: "unverified",
            message: "模型目录未提供完整思考档位，未自动猜测",
        };
    }
    const levels = normalizeThinkingLevels(MODEL_THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null));
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
        message: `Pi 模型目录明确提供 ${levels.length} 个思考档位`,
        levelMap: { ...model.thinkingLevelMap },
    };
}
async function testCustomThinkingCapability(config) {
    const metadata = await providerThinkingCapability(config);
    const official = officialThinkingCapabilityView(config.model);
    if (metadata?.status === "unsupported")
        return metadata;
    if (official && metadata?.status === "supported") {
        const levels = official.levels.filter((level) => metadata.levels.includes(level));
        if (levels.length === 0) {
            return {
                status: "unverified",
                levels: [],
                source: "unverified",
                message: "模型服务返回的档位与官方资料不一致，未自动采用",
            };
        }
        return supportedThinkingCapability(levels, "provider-metadata", "已按模型服务与官方资料的共同档位确认", official.recommendedLevel && levels.includes(official.recommendedLevel) ? official.recommendedLevel : undefined);
    }
    if (official)
        return official;
    if (metadata)
        return metadata;
    return {
        status: "unverified",
        levels: [],
        source: "unverified",
        message: "模型服务未提供可靠思考档位，未自动猜测",
    };
}
async function providerThinkingCapability(config) {
    if (!config.baseUrl || !config.protocol)
        return undefined;
    try {
        const discovered = await discoverModels({
            baseUrl: config.baseUrl,
            protocol: config.protocol,
            apiKey: config.apiKey,
        });
        const item = discovered.find((candidate) => candidate.id === config.model);
        if (!item || item.reasoning === undefined)
            return undefined;
        if (item.reasoning === false) {
            return {
                status: "unsupported",
                levels: [],
                source: "provider-metadata",
                message: "模型服务声明该模型没有可调思考强度",
            };
        }
        if (!item.thinkingLevels?.length)
            return undefined;
        const levels = normalizeThinkingLevels(item.thinkingLevels);
        return supportedThinkingCapability(levels, "provider-metadata", "已从模型服务获取明确思考档位");
    }
    catch {
        return undefined;
    }
}
function supportedThinkingCapability(levels, source, message, recommendedLevel) {
    const levelSet = new Set(levels);
    const levelMap = Object.fromEntries(MODEL_THINKING_LEVELS
        .filter((level) => level !== "off")
        .map((level) => [level, levelSet.has(level) ? level : null]));
    return {
        status: "supported",
        levels,
        ...(recommendedLevel ? { recommendedLevel } : {}),
        source,
        message,
        levelMap,
    };
}
function normalizeThinkingLevels(levels) {
    const available = new Set(levels);
    return MODEL_THINKING_LEVELS.filter((level) => available.has(level));
}
function taskThinkingLevel(config, model) {
    const requested = config.thinkingLevel === undefined || config.thinkingLevel === "auto"
        ? config.thinking?.recommendedLevel
        : config.thinkingLevel;
    if (!requested)
        return undefined;
    return clampThinkingLevel(model, requested);
}
function isCompleteThinkingLevelMap(levelMap) {
    return Boolean(levelMap && MODEL_THINKING_LEVELS.every((level) => Object.hasOwn(levelMap, level)));
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
];
const VISION_TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAgMAAACJFjxpAAAADFBMVEUA/wD//wD/AAAAAP+JEOrQAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABIklEQVR42u3OMQEAMAwDoJisyZrcROToAwrIlF4pAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAueBLaUlICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcB34myuHcnITA/IAAAAASUVORK5CYII=";
export function visionResultFromResponse(text, options = {}) {
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
export function visionResultFromError(message) {
    const unsupported = /(image|vision).{0,80}(not supported|unsupported)|does not support.{0,40}(image|vision)|unsupported.{0,40}(image|vision)|(?:不支持|无法处理).{0,30}(?:图片|图像|视觉)|(?:图片|图像|视觉).{0,30}(?:不支持|无法处理)/i.test(message);
    if (unsupported) {
        return { vision: { status: "unsupported", message: "服务明确表示该模型不支持图片输入" } };
    }
    if (/(?:\b429\b|rate.?limit|too many requests|限流|请求过多)/i.test(message)) {
        return inconclusive("图片能力测试受到限流，请稍后重试");
    }
    if (/(?:time.?out|timed out|超时)/i.test(message)) {
        return inconclusive("图片能力测试超时，请重新测试");
    }
    return inconclusive("图片请求失败，暂时无法确认模型图片能力");
}
function isVerifiedVisionAnswer(text) {
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
function safeVisionPreview(text) {
    const normalized = text
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}
function inconclusive(message) {
    return { vision: { status: "inconclusive", message } };
}
