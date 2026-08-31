import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MODELS = 2_000;
const MAX_PAGES = 20;
export async function discoverModels(config) {
    const endpoint = modelsEndpoint(config.baseUrl);
    const found = new Map();
    let afterId;
    for (let page = 0; page < MAX_PAGES && found.size < MAX_MODELS; page += 1) {
        const url = new URL(endpoint);
        if (afterId)
            url.searchParams.set("after_id", afterId);
        if (config.protocol === "anthropic-messages")
            url.searchParams.set("limit", "100");
        const response = await fetch(url, {
            method: "GET",
            headers: discoveryHeaders(config),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            throw new Error(`获取模型失败（HTTP ${response.status}）`);
        }
        const payload = await readLimitedJson(response);
        for (const model of extractModels(payload)) {
            if (found.size >= MAX_MODELS)
                break;
            found.set(model.id, model);
        }
        const paging = pagination(payload);
        if (!paging.hasMore || !paging.lastId || paging.lastId === afterId)
            break;
        afterId = paging.lastId;
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function modelsEndpoint(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error("Base URL 不是有效网址");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Base URL 只支持 HTTP 或 HTTPS");
    }
    if (url.username || url.password) {
        throw new Error("Base URL 不能包含用户名或密码");
    }
    url.hash = "";
    if (!url.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/models")) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    }
    return url.toString();
}
function discoveryHeaders(config) {
    if (config.protocol === "anthropic-messages") {
        return {
            Accept: "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
        };
    }
    return {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
    };
}
async function readLimitedJson(response) {
    if (!response.body)
        throw new Error("模型服务没有返回内容");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("模型列表响应过大");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw new Error("模型列表不是有效 JSON");
    }
}
function extractModels(payload) {
    const source = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.data)
            ? payload.data
            : isRecord(payload) && Array.isArray(payload.models)
                ? payload.models
                : null;
    if (!source)
        throw new Error("模型列表响应格式无法识别");
    const output = [];
    for (const item of source) {
        if (typeof item === "string" && item.trim()) {
            output.push({ id: item.trim(), name: item.trim() });
        }
        else if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
            const id = item.id.trim();
            const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
            const thinking = modelThinkingMetadata(item);
            output.push({ id, name, ...thinking });
        }
    }
    return output;
}
function modelThinkingMetadata(item) {
    const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
    const rawLevels = [
        item.supported_reasoning_efforts,
        item.reasoning_efforts,
        item.thinking_levels,
        capabilities?.supported_reasoning_efforts,
        capabilities?.reasoning_efforts,
        capabilities?.thinking_levels,
    ].find(Array.isArray);
    const thinkingLevels = normalizeThinkingLevels(rawLevels);
    const explicitReasoning = firstBoolean(item.reasoning, item.supports_reasoning, capabilities?.reasoning, capabilities?.supports_reasoning);
    const reasoning = explicitReasoning ?? (thinkingLevels.length > 0 ? true : undefined);
    return {
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
    };
}
function normalizeThinkingLevels(value) {
    if (!Array.isArray(value))
        return [];
    const known = new Set(MODEL_THINKING_LEVELS);
    const levels = [];
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const normalized = item.trim().toLocaleLowerCase() === "none"
            ? "off"
            : item.trim().toLocaleLowerCase();
        if (known.has(normalized) && !levels.includes(normalized)) {
            levels.push(normalized);
        }
    }
    return MODEL_THINKING_LEVELS.filter((level) => levels.includes(level));
}
function firstBoolean(...values) {
    return values.find((value) => typeof value === "boolean");
}
function pagination(payload) {
    if (!isRecord(payload))
        return { hasMore: false };
    return {
        hasMore: payload.has_more === true,
        ...(typeof payload.last_id === "string" && payload.last_id ? { lastId: payload.last_id } : {}),
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
