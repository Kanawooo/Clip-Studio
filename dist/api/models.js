import { discoverModels } from "../pi/model-discovery.js";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
import { errorMessage, redactSecrets } from "../security.js";
import { HttpError, parseModelConfig, readJsonBody, sendJson, } from "./tasks.js";
import { ModelCapabilityError } from "./model-capabilities.js";
export function handleListModels(res, models) {
    sendJson(res, 200, { models });
}
export async function handleTestModel(req, res, registry, localState) {
    let apiKey;
    const startedAt = Date.now();
    try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "model must be an object");
        }
        const raw = body;
        const config = parseModelConfig({ ...raw, apiKey: await localState.resolveApiKey(raw, "main") });
        apiKey = config.apiKey;
        const { testModelConnection } = await import("../pi/model.js");
        const result = await testModelConnection(config);
        const evidence = registry.record(config, result.vision.status, result.thinking);
        await registry.persist();
        const { levelMap: _internalLevelMap, ...publicThinking } = result.thinking;
        sendJson(res, 200, {
            ok: true,
            latencyMs: Date.now() - startedAt,
            vision: result.vision,
            thinking: publicThinking,
            capabilityId: evidence.capabilityId,
            testedAt: evidence.testedAt,
        });
    }
    catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 400;
        sendJson(res, statusCode, {
            ok: false,
            error: redactSecrets(errorMessage(error), [apiKey]),
        });
    }
}
export async function handleDiscoverModels(req, res, localState) {
    let apiKey;
    try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "request body must be an object");
        }
        const raw = body;
        const baseUrl = requiredDiscoveryString(raw.baseUrl, "baseUrl");
        apiKey = await localState.resolveApiKey(raw, "main");
        const protocol = discoveryProtocol(raw.protocol);
        const models = await discoverModels({ baseUrl, apiKey, protocol });
        sendJson(res, 200, { models });
    }
    catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 400;
        sendJson(res, statusCode, {
            error: redactSecrets(errorMessage(error), [apiKey]),
        });
    }
}
export async function handleSetThinkingCapability(req, res, registry, localState) {
    let apiKey;
    try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "request body must be an object");
        }
        const raw = body;
        if (typeof raw.capabilityId !== "string" || !raw.capabilityId) {
            throw new HttpError(400, "capabilityId must be a non-empty string");
        }
        if (!raw.model || typeof raw.model !== "object" || Array.isArray(raw.model)) {
            throw new HttpError(400, "model must be an object");
        }
        const rawModel = raw.model;
        const config = parseModelConfig({ ...rawModel, apiKey: await localState.resolveApiKey(rawModel, "main") });
        apiKey = config.apiKey;
        if (!Array.isArray(raw.levels) || raw.levels.some((level) => !MODEL_THINKING_LEVELS.includes(level))) {
            throw new HttpError(400, "levels must contain only supported standard thinking levels");
        }
        const evidence = registry.configureThinking(raw.capabilityId, config, raw.levels);
        await registry.persist();
        const { levelMap: _internalLevelMap, ...thinking } = evidence.thinking;
        sendJson(res, 200, { capabilityId: evidence.capabilityId, thinking });
    }
    catch (error) {
        const statusCode = error instanceof HttpError || error instanceof ModelCapabilityError ? error.statusCode : 400;
        sendJson(res, statusCode, { error: redactSecrets(errorMessage(error), [apiKey]) });
    }
}
function requiredDiscoveryString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `${name} must be a non-empty string`);
    }
    return value.trim();
}
function discoveryProtocol(value) {
    if (value !== "openai-completions" && value !== "anthropic-messages") {
        throw new HttpError(400, 'protocol must be "openai-completions" or "anthropic-messages"');
    }
    return value;
}
