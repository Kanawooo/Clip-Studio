import { MODEL_THINKING_LEVELS, type ModelProtocol, type ModelThinkingLevel } from "../tasks/types.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

export interface ModelDiscoveryConfig {
  baseUrl: string;
  protocol: ModelProtocol;
  apiKey: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
}

export async function discoverModels(config: ModelDiscoveryConfig): Promise<DiscoveredModel[]> {
  const endpoint = modelsEndpoint(config.baseUrl);
  const found = new Map<string, DiscoveredModel>();
  let afterId: string | undefined;

  for (let page = 0; page < MAX_PAGES && found.size < MAX_MODELS; page += 1) {
    const url = new URL(endpoint);
    if (afterId) url.searchParams.set("after_id", afterId);
    if (config.protocol === "anthropic-messages") url.searchParams.set("limit", "100");

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
      if (found.size >= MAX_MODELS) break;
      found.set(model.id, model);
    }

    const paging = pagination(payload);
    if (!paging.hasMore || !paging.lastId || paging.lastId === afterId) break;
    afterId = paging.lastId;
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function modelsEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
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

function discoveryHeaders(config: ModelDiscoveryConfig): Record<string, string> {
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

async function readLimitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("模型服务没有返回内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
  } catch {
    throw new Error("模型列表不是有效 JSON");
  }
}

function extractModels(payload: unknown): DiscoveredModel[] {
  const source = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : null;
  if (!source) throw new Error("模型列表响应格式无法识别");

  const output: DiscoveredModel[] = [];
  for (const item of source) {
    if (typeof item === "string" && item.trim()) {
      output.push({ id: item.trim(), name: item.trim() });
    } else if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
      const id = item.id.trim();
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
      const thinking = modelThinkingMetadata(item);
      output.push({ id, name, ...thinking });
    }
  }
  return output;
}

function modelThinkingMetadata(item: Record<string, unknown>): Pick<DiscoveredModel, "reasoning" | "thinkingLevels"> {
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
  const explicitReasoning = firstBoolean(
    item.reasoning,
    item.supports_reasoning,
    capabilities?.reasoning,
    capabilities?.supports_reasoning,
  );
  const reasoning = explicitReasoning ?? (thinkingLevels.length > 0 ? true : undefined);
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
  };
}

function normalizeThinkingLevels(value: unknown): ModelThinkingLevel[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<ModelThinkingLevel>(MODEL_THINKING_LEVELS);
  const levels: ModelThinkingLevel[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLocaleLowerCase() === "none"
      ? "off"
      : item.trim().toLocaleLowerCase();
    if (known.has(normalized as ModelThinkingLevel) && !levels.includes(normalized as ModelThinkingLevel)) {
      levels.push(normalized as ModelThinkingLevel);
    }
  }
  return MODEL_THINKING_LEVELS.filter((level) => levels.includes(level));
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function pagination(payload: unknown): { hasMore: boolean; lastId?: string } {
  if (!isRecord(payload)) return { hasMore: false };
  return {
    hasMore: payload.has_more === true,
    ...(typeof payload.last_id === "string" && payload.last_id ? { lastId: payload.last_id } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
