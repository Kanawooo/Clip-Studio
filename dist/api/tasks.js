import { statSync } from "node:fs";
import { TaskCreateError } from "../tasks/manager.js";
import { DEFAULT_TASK_REQUEST, MODEL_THINKING_LEVELS, } from "../tasks/types.js";
import { errorMessage, redactSecrets } from "../security.js";
import { applyModelCapabilityEvidence, ModelCapabilityError, } from "./model-capabilities.js";
const MAX_BODY_BYTES = 1_000_000;
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new HttpError(413, "request body too large");
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new HttpError(400, "request body is not valid JSON");
    }
}
export function parseCreateTaskInput(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "request body must be a JSON object");
    }
    const raw = body;
    const referenceVideo = requiredString(raw.referenceVideo, "referenceVideo");
    const assetsDir = requiredString(raw.assetsDir, "assetsDir");
    const audioDir = requiredString(raw.audioDir, "audioDir");
    const outputDir = requiredString(raw.outputDir, "outputDir");
    const generateCount = raw.generateCount === undefined ? 1 : raw.generateCount;
    if (!Number.isInteger(generateCount) || Number(generateCount) < 1 || Number(generateCount) > 20) {
        throw new HttpError(400, "generateCount must be an integer between 1 and 20");
    }
    validateTaskPaths({ referenceVideo, assetsDir, audioDir, outputDir });
    return {
        referenceVideo,
        assetsDir,
        audioDir,
        outputDir,
        generateCount: Number(generateCount),
        taskRequest: taskRequestString(raw.taskRequest),
        model: parseModelConfig(raw.model),
        modelCapabilityId: requiredString(raw.modelCapabilityId, "modelCapabilityId"),
    };
}
export function parseModelConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, "model must be an object");
    }
    const raw = value;
    const provider = requiredString(raw.provider, "model.provider");
    const model = requiredString(raw.model, "model.model");
    const apiKey = requiredString(raw.apiKey, "model.apiKey");
    const baseUrl = optionalString(raw.baseUrl, "model.baseUrl");
    const protocol = optionalProtocol(raw.protocol);
    const input = optionalModelInput(raw.input);
    const thinkingLevel = optionalThinkingLevel(raw.thinkingLevel);
    if (baseUrl && !protocol)
        throw new HttpError(400, "model.protocol is required when model.baseUrl is provided");
    if (baseUrl && (!input || !input.includes("text"))) {
        throw new HttpError(400, "model.input must include text for a custom model");
    }
    if (baseUrl)
        validateServiceUrl(baseUrl, "model.baseUrl");
    return {
        provider,
        model,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(protocol ? { protocol } : {}),
        ...(input ? { input } : {}),
        thinkingLevel,
    };
}
export function taskToView(task) {
    return {
        id: task.id,
        status: task.status,
        statusText: task.statusText,
        createdAt: task.createdAt,
        input: task.input,
        model: task.model,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
        outputs: task.outputs,
        error: task.error ?? null,
    };
}
export async function handleCreateTask(manager, req, res, modelCapabilities, localState) {
    let input;
    try {
        input = parseCreateTaskInput(await localState.resolveRequestCredentials(await readJsonBody(req)));
        const capability = modelCapabilities.verify(input.modelCapabilityId, input.model);
        input.model = applyModelCapabilityEvidence(input.model, capability);
        const task = await manager.createTask(input);
        sendJson(res, 202, { taskId: task.id, status: task.status });
    }
    catch (error) {
        if (error instanceof HttpError || error instanceof ModelCapabilityError || error instanceof TaskCreateError) {
            sendJson(res, error.statusCode, {
                error: error.message,
                ...(error instanceof TaskCreateError && error.conflictingTaskId
                    ? { conflictingTaskId: error.conflictingTaskId }
                    : {}),
            });
            return;
        }
        sendJson(res, 500, { error: redactSecrets(errorMessage(error), [input?.model.apiKey]) });
    }
}
export function handleListTasks(manager, res) {
    sendJson(res, 200, { tasks: manager.listTasks().map(taskToView) });
}
export function handleGetTask(manager, taskId, res) {
    const task = manager.getTask(taskId);
    if (!task)
        return sendJson(res, 404, { error: `task not found: ${taskId}` });
    sendJson(res, 200, taskToView(task));
}
export async function handleAbortTask(manager, taskId, res) {
    const existing = manager.getTask(taskId);
    if (!existing)
        return sendJson(res, 404, { error: `task not found: ${taskId}` });
    if (existing.status !== "running" && existing.status !== "pending") {
        return sendJson(res, 409, { error: `task is not running (status: ${existing.status})` });
    }
    const task = (await manager.abortTask(taskId));
    sendJson(res, 202, { taskId: task.id, status: task.status });
}
export function handleTaskEvents(manager, taskId, req, res) {
    const task = manager.getTask(taskId);
    const hub = manager.getHub(taskId);
    if (!task || !hub)
        return sendJson(res, 404, { error: `task not found: ${taskId}` });
    const header = req.headers["last-event-id"];
    hub.attach(res, typeof header === "string" ? header : undefined);
}
function optionalProtocol(value) {
    if (value === undefined)
        return undefined;
    if (value !== "openai-completions" && value !== "anthropic-messages") {
        throw new HttpError(400, 'model.protocol must be "openai-completions" or "anthropic-messages"');
    }
    return value;
}
function optionalModelInput(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length === 0)
        throw new HttpError(400, "model.input must be a non-empty array");
    if (value.some((item) => item !== "text" && item !== "image")) {
        throw new HttpError(400, 'model.input entries must be "text" or "image"');
    }
    return [...new Set(value)];
}
function optionalThinkingLevel(value) {
    if (value === undefined)
        return "auto";
    if (value === "auto" || MODEL_THINKING_LEVELS.includes(value)) {
        return value;
    }
    throw new HttpError(400, `model.thinkingLevel must be "auto" or one of: ${MODEL_THINKING_LEVELS.join(", ")}`);
}
function requiredString(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new HttpError(400, `${name} must be a non-empty string`);
    return value.trim();
}
function optionalString(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `${name} must be a non-empty string when provided`);
    }
    return value.trim();
}
function taskRequestString(value) {
    if (value === undefined)
        return DEFAULT_TASK_REQUEST;
    if (typeof value !== "string")
        throw new HttpError(400, "taskRequest must be a string");
    return value.trim() || DEFAULT_TASK_REQUEST;
}
function validateServiceUrl(value, name) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new HttpError(400, `${name} must be a valid HTTP or HTTPS URL`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new HttpError(400, `${name} must be an HTTP or HTTPS URL without embedded credentials`);
    }
}
function validateTaskPaths(paths) {
    validatePath(paths.referenceVideo, "referenceVideo", "file", false);
    validatePath(paths.assetsDir, "assetsDir", "directory", false);
    validatePath(paths.audioDir, "audioDir", "directory", false);
    validatePath(paths.outputDir, "outputDir", "directory", true);
}
function validatePath(value, label, expected, allowMissing) {
    try {
        const stat = statSync(value);
        if (expected === "file" ? !stat.isFile() : !stat.isDirectory()) {
            throw new HttpError(400, `${label} is not a ${expected}: ${value}`);
        }
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        if (isNodeError(error) && error.code === "ENOENT") {
            if (allowMissing)
                return;
            throw new HttpError(400, `${label} does not exist: ${value}`);
        }
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
export class HttpError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
    }
}
export function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}
