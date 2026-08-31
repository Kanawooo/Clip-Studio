import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { errorMessage } from "../security.js";
import { HttpError, readJsonBody, sendJson } from "./tasks.js";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";

type CredentialKind = "main";

interface CredentialFile {
  version: 1;
  main?: string;
}

interface UserStateFile {
  version: 1;
  settings: Record<string, unknown>;
  draft: Record<string, unknown>;
}

export interface LocalStateView {
  settings: Record<string, unknown>;
  draft: Record<string, unknown>;
  mainKeyStored: boolean;
}

export class LocalStateStore {
  private readonly runtimeDir: string;
  private readonly userStatePath: string;
  private readonly credentialsPath: string;
  private readonly dpapiScriptPath: string;
  private readonly credentialCache = new Map<CredentialKind, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.runtimeDir = path.join(projectRoot, ".runtime");
    this.userStatePath = path.join(this.runtimeDir, "user-state.json");
    this.credentialsPath = path.join(this.runtimeDir, "credentials.json");
    this.dpapiScriptPath = path.join(projectRoot, "scripts", "dpapi-secret.ps1");
  }

  async view(): Promise<LocalStateView> {
    const [state, credentials] = await Promise.all([this.readUserState(), this.readCredentials()]);
    return {
      settings: state.settings,
      draft: state.draft,
      mainKeyStored: Boolean(credentials.main),
    };
  }

  async saveSettings(body: unknown): Promise<LocalStateView> {
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

  async saveDraft(body: unknown): Promise<LocalStateView> {
    const raw = objectBody(body);
    const draft = safeDraft(raw.draft);
    await this.enqueueWrite(async () => {
      const state = await this.readUserState();
      await this.writeUserState({ ...state, draft });
    });
    return this.view();
  }

  async resolveCredential(kind: CredentialKind): Promise<string> {
    const cached = this.credentialCache.get(kind);
    if (cached) return cached;
    const credentials = await this.readCredentials();
    const encrypted = credentials[kind];
    if (!encrypted) throw new HttpError(400, "model.apiKey is required");
    const plain = await invokeDpapi(this.dpapiScriptPath, "Unprotect", encrypted);
    if (!plain) throw new HttpError(400, `stored ${kind} credential is empty`);
    this.credentialCache.set(kind, plain);
    return plain;
  }

  async resolveApiKey(raw: Record<string, unknown>, kind: CredentialKind): Promise<string> {
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) return raw.apiKey.trim();
    if (raw.credentialRef === kind) return this.resolveCredential(kind);
    throw new HttpError(400, "model.apiKey is required");
  }

  async resolveRequestCredentials(body: unknown): Promise<unknown> {
    const raw = objectBody(body);
    const resolved = { ...raw };
    if (raw.model && typeof raw.model === "object" && !Array.isArray(raw.model)) {
      const model = raw.model as Record<string, unknown>;
      resolved.model = { ...model, apiKey: await this.resolveApiKey(model, "main") };
    }
    return resolved;
  }

  private async updateCredential(
    credentials: CredentialFile,
    kind: CredentialKind,
    remember: boolean,
    secret: string | undefined,
  ): Promise<void> {
    if (!remember) {
      delete credentials[kind];
      this.credentialCache.delete(kind);
      return;
    }
    if (!secret) return;
    credentials[kind] = await invokeDpapi(this.dpapiScriptPath, "Protect", secret);
    this.credentialCache.set(kind, secret);
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  private async readUserState(): Promise<UserStateFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.userStatePath, "utf8")) as Partial<UserStateFile>;
      return {
        version: 1,
        settings: safeSettings(parsed.settings),
        draft: safeDraft(parsed.draft),
      };
    } catch (error) {
      if (isMissing(error)) return { version: 1, settings: {}, draft: {} };
      throw new Error(`unable to read project settings: ${errorMessage(error)}`);
    }
  }

  private async readCredentials(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.credentialsPath, "utf8")) as Partial<CredentialFile>;
      return {
        version: 1,
        ...(typeof parsed.main === "string" && parsed.main ? { main: parsed.main } : {}),
      };
    } catch (error) {
      if (isMissing(error)) return { version: 1 };
      throw new Error(`unable to read project credentials: ${errorMessage(error)}`);
    }
  }

  private async writeUserState(state: UserStateFile): Promise<void> {
    await atomicJsonWrite(this.runtimeDir, this.userStatePath, state);
  }

  private async writeCredentials(credentials: CredentialFile): Promise<void> {
    if (!credentials.main) {
      await fs.rm(this.credentialsPath, { force: true });
      return;
    }
    await atomicJsonWrite(this.runtimeDir, this.credentialsPath, credentials);
  }

}

export async function handleGetLocalState(store: LocalStateStore, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await store.view());
}

export async function handlePutLocalSettings(
  store: LocalStateStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, await store.saveSettings(await readJsonBody(req)));
}

export async function handlePutLocalDraft(
  store: LocalStateStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, await store.saveDraft(await readJsonBody(req)));
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function safeSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
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

function safeDraft(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return compact({
    referenceVideo: text(raw.referenceVideo),
    assetsDir: text(raw.assetsDir),
    audioDir: text(raw.audioDir),
    outputDir: text(raw.outputDir),
    taskRequest: text(raw.taskRequest),
    generateCount: integer(raw.generateCount),
  });
}

function safeCapability(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return compact({
    fingerprint: text(raw.fingerprint),
    status: enumValue(raw.status, ["supported", "unsupported", "inconclusive"]),
    testedAt: text(raw.testedAt),
    capabilityId: text(raw.capabilityId),
    thinking: safeThinkingCapability(raw.thinking),
  });
}

function safeThinkingCapability(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = enumValue(raw.status, ["supported", "unsupported", "unverified"]);
  const source = enumValue(raw.source, ["official-registry", "provider-metadata", "pi-explicit", "manual", "unverified"]);
  const message = text(raw.message);
  const rawLevels = Array.isArray(raw.levels) ? raw.levels : undefined;
  if (!status || !source || message === undefined || !rawLevels) return undefined;
  const levels = MODEL_THINKING_LEVELS.filter((level) => rawLevels.includes(level));
  return compact({
    status,
    levels,
    recommendedLevel: enumValue(raw.recommendedLevel, MODEL_THINKING_LEVELS),
    source,
    message,
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 32_768) : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? Number(value) : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function optionalSecret(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  if (value.length > 16_384) throw new HttpError(400, `${name} is too long`);
  return value;
}

async function atomicJsonWrite(directory: string, destination: string, value: unknown): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function invokeDpapi(scriptPath: string, mode: "Protect" | "Unprotect", input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", mode],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
