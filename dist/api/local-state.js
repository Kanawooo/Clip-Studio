import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { errorMessage } from "../security.js";
import { HttpError, readJsonBody, sendJson } from "./tasks.js";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
export class LocalStateStore {
    runtimeDir;
    userStatePath;
    credentialsPath;
    dpapiScriptPath;
    credentialCache = new Map();
    writeQueue = Promise.resolve();
    constructor(projectRoot) {
        this.runtimeDir = path.join(projectRoot, ".runtime");
        this.userStatePath = path.join(this.runtimeDir, "user-state.json");
        this.credentialsPath = path.join(this.runtimeDir, "credentials.json");
        this.dpapiScriptPath = path.join(projectRoot, "scripts", "dpapi-secret.ps1");
    }
    async view() {
        const [state, credentials] = await Promise.all([this.readUserState(), this.readCredentials()]);
        return {
            settings: state.settings,
            draft: state.draft,
            mainKeyStored: Boolean(credentials.main),
        };
    }
    async saveSettings(body) {
        const raw = objectBody(body);
        const settings = safeSettings(raw.settings);
        const mainApiKey = optionalSecret(raw.mainApiKey, "mainApiKey");
        await this.enqueueWrite(async () => {
            const [state, credentials] = await Promise.all([this.readUserState(), this.readCredentials()]);
            const nextCredentials = { ...credentials };
            await this.updateCredential(nextCredentials, "main", settings.rememberApiKey === true, mainApiKey);
            await this.writeCredentials(nextCredentials);
            await this.writeUserState({ ...state, settings });
        });
        return this.view();
    }
    async saveDraft(body) {
        const raw = objectBody(body);
        const draft = safeDraft(raw.draft);
        await this.enqueueWrite(async () => {
            const state = await this.readUserState();
            await this.writeUserState({ ...state, draft });
        });
        return this.view();
    }
    async resolveCredential(kind) {
        const cached = this.credentialCache.get(kind);
        if (cached)
            return cached;
        const credentials = await this.readCredentials();
        const encrypted = credentials[kind];
        if (!encrypted)
            throw new HttpError(400, "model.apiKey is required");
        const plain = await invokeDpapi(this.dpapiScriptPath, "Unprotect", encrypted);
        if (!plain)
            throw new HttpError(400, `stored ${kind} credential is empty`);
        this.credentialCache.set(kind, plain);
        return plain;
    }
    async resolveApiKey(raw, kind) {
        if (typeof raw.apiKey === "string" && raw.apiKey.trim())
            return raw.apiKey.trim();
        if (raw.credentialRef === kind)
            return this.resolveCredential(kind);
        throw new HttpError(400, "model.apiKey is required");
    }
    async resolveRequestCredentials(body) {
        const raw = objectBody(body);
        const resolved = { ...raw };
        if (raw.model && typeof raw.model === "object" && !Array.isArray(raw.model)) {
            const model = raw.model;
            resolved.model = { ...model, apiKey: await this.resolveApiKey(model, "main") };
        }
        return resolved;
    }
    async updateCredential(credentials, kind, remember, secret) {
        if (!remember) {
            delete credentials[kind];
            this.credentialCache.delete(kind);
            return;
        }
        if (!secret)
            return;
        credentials[kind] = await invokeDpapi(this.dpapiScriptPath, "Protect", secret);
        this.credentialCache.set(kind, secret);
    }
    async enqueueWrite(operation) {
        const next = this.writeQueue.then(operation, operation);
        this.writeQueue = next.catch(() => undefined);
        await next;
    }
    async readUserState() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.userStatePath, "utf8"));
            return {
                version: 1,
                settings: safeSettings(parsed.settings),
                draft: safeDraft(parsed.draft),
            };
        }
        catch (error) {
            if (isMissing(error))
                return { version: 1, settings: {}, draft: {} };
            throw new Error(`unable to read project settings: ${errorMessage(error)}`);
        }
    }
    async readCredentials() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.credentialsPath, "utf8"));
            return {
                version: 1,
                ...(typeof parsed.main === "string" && parsed.main ? { main: parsed.main } : {}),
            };
        }
        catch (error) {
            if (isMissing(error))
                return { version: 1 };
            throw new Error(`unable to read project credentials: ${errorMessage(error)}`);
        }
    }
    async writeUserState(state) {
        await atomicJsonWrite(this.runtimeDir, this.userStatePath, state);
    }
    async writeCredentials(credentials) {
        if (!credentials.main) {
            await fs.rm(this.credentialsPath, { force: true });
            return;
        }
        await atomicJsonWrite(this.runtimeDir, this.credentialsPath, credentials);
    }
}
export async function handleGetLocalState(store, res) {
    sendJson(res, 200, await store.view());
}
export async function handlePutLocalSettings(store, req, res) {
    sendJson(res, 200, await store.saveSettings(await readJsonBody(req)));
}
export async function handlePutLocalDraft(store, req, res) {
    sendJson(res, 200, await store.saveDraft(await readJsonBody(req)));
}
function objectBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, "request body must be a JSON object");
    }
    return value;
}
function safeSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const raw = value;
    return compact({
        version: integer(raw.version),
        modelSource: enumValue(raw.modelSource, ["builtin", "custom"]),
        builtinProvider: text(raw.builtinProvider),
        builtinModel: text(raw.builtinModel),
        customProvider: text(raw.customProvider),
        customModel: text(raw.customModel),
        customBaseUrl: text(raw.customBaseUrl),
        customProtocol: enumValue(raw.customProtocol, ["openai-completions", "anthropic-messages"]),
        modelCapability: safeCapability(raw.modelCapability),
        thinkingLevel: enumValue(raw.thinkingLevel, ["auto", ...MODEL_THINKING_LEVELS]),
        rememberApiKey: boolean(raw.rememberApiKey),
    });
}
function safeDraft(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const raw = value;
    return compact({
        referenceVideo: text(raw.referenceVideo),
        assetsDir: text(raw.assetsDir),
        audioDir: text(raw.audioDir),
        outputDir: text(raw.outputDir),
        taskRequest: text(raw.taskRequest),
        generateCount: integer(raw.generateCount),
    });
}
function safeCapability(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const raw = value;
    return compact({
        fingerprint: text(raw.fingerprint),
        status: enumValue(raw.status, ["supported", "unsupported", "inconclusive"]),
        testedAt: text(raw.testedAt),
        capabilityId: text(raw.capabilityId),
        thinking: safeThinkingCapability(raw.thinking),
    });
}
function safeThinkingCapability(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const raw = value;
    const status = enumValue(raw.status, ["supported", "unsupported", "unverified"]);
    const source = enumValue(raw.source, ["official-registry", "provider-metadata", "pi-explicit", "manual", "unverified"]);
    const message = text(raw.message);
    const rawLevels = Array.isArray(raw.levels) ? raw.levels : undefined;
    if (!status || !source || message === undefined || !rawLevels)
        return undefined;
    const levels = MODEL_THINKING_LEVELS.filter((level) => rawLevels.includes(level));
    return compact({
        status,
        levels,
        recommendedLevel: enumValue(raw.recommendedLevel, MODEL_THINKING_LEVELS),
        source,
        message,
    });
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function text(value) {
    return typeof value === "string" ? value.slice(0, 32_768) : undefined;
}
function integer(value) {
    return Number.isInteger(value) ? Number(value) : undefined;
}
function boolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function enumValue(value, allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : undefined;
}
function optionalSecret(value, name) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string")
        throw new HttpError(400, `${name} must be a string`);
    if (value.length > 16_384)
        throw new HttpError(400, `${name} is too long`);
    return value;
}
async function atomicJsonWrite(directory, destination, value) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        await fs.rename(temporary, destination);
    }
    catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
function invokeDpapi(scriptPath, mode, input) {
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => reject(new Error(`unable to start Windows credential protection: ${error.message}`)));
        child.on("close", (code) => {
            if (code !== 0) {
                const detail = Buffer.concat(stderr).toString("utf8").trim();
                reject(new Error(`Windows credential protection failed${detail ? `: ${detail.slice(0, 300)}` : ""}`));
                return;
            }
            resolve(Buffer.concat(stdout).toString("utf8"));
        });
        child.stdin.end(input);
    });
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
