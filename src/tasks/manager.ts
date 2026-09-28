import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { modelConfigFingerprint } from "../api/model-capabilities.js";
import { SseHub } from "../api/sse.js";
import { buildResumePrompt, buildTaskPrompt, type TaskExecutionPaths } from "../pi/prompt.js";
import { errorMessage, redactSecrets } from "../security.js";
import {
  diffVideoOutputs,
  filterPlayableVideoFiles,
  snapshotOutputDir,
  videoProbeFailure,
  waitForStableVideoFiles,
  type VideoSnapshot,
} from "./outputs.js";
import type { CreateTaskInput, ModelConfig, ModelThinkingLevel, Task, TaskStatus } from "./types.js";

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  thinkingLevel?: ModelThinkingLevel;
  getFailure?(): string | undefined;
  sessionFile?: string;
  restoredSession?: boolean;
}

export interface SessionStartOptions {
  taskId: string;
  taskDir: string;
  sessionDir: string;
  resumeSessionFile?: string;
}

export type SessionFactory = (
  input: CreateTaskInput,
  workspace: string,
  options: SessionStartOptions,
) => Promise<PiSessionLike>;

interface TaskRuntime {
  task: Task;
  taskDir: string;
  workspace: string;
  sessionDir: string;
  session: PiSessionLike | null;
  hub: SseHub;
  outputSnapshot: VideoSnapshot;
  outputMonitor: NodeJS.Timeout | null;
  outputScan: Promise<void> | null;
  promptPromise: Promise<void> | null;
  persistPromise: Promise<void>;
  secrets: string[];
  disposed: boolean;
  outputFailures: Map<string, string>;
}

export interface TaskManagerOptions {
  projectRoot: string;
  agentDir: string;
  sessionFactory?: SessionFactory;
  outputValidator?: (files: string[]) => Promise<string[]>;
  tasksDir?: string;
  outputScanIntervalMs?: number;
}

/**
 * Minimal task lifecycle around one native Pi Session.
 * Pi owns every video decision and command; the manager owns state, SSE and
 * technical output discovery only.
 */
export class TaskManager {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly projectRoot: string;
  private readonly agentDir: string;
  private readonly tasksDir: string;
  private readonly sessionFactory: SessionFactory;
  private readonly outputValidator: (files: string[]) => Promise<string[]>;
  private readonly outputScanIntervalMs: number;
  private admissionReserved = false;

  constructor(options: TaskManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.agentDir = options.agentDir;
    this.tasksDir = options.tasksDir ?? path.join(this.projectRoot, "data", "tasks");
    this.outputValidator = options.outputValidator ?? filterPlayableVideoFiles;
    this.outputScanIntervalMs = Math.max(100, options.outputScanIntervalMs ?? 1_000);
    this.sessionFactory = options.sessionFactory ?? (async (input, workspace, start) => {
      const { createPiVideoSession } = await import("../pi/session.js");
      const sessionOptions = {
        projectRoot: this.projectRoot,
        agentDir: this.agentDir,
        workspace,
        outputDir: input.outputDir,
        sessionDir: start.sessionDir,
        model: input.model,
      };
      let pi;
      let restoredSession = false;
      if (start.resumeSessionFile) {
        try {
          pi = await createPiVideoSession({ ...sessionOptions, resumeSessionFile: start.resumeSessionFile });
          restoredSession = true;
        }
        catch { pi = await createPiVideoSession(sessionOptions); }
      } else pi = await createPiVideoSession(sessionOptions);
      let lastToolFailure: string | undefined;
      const unsubscribe = pi.session.subscribe((event) => {
        if (event.type !== "tool_execution_end" || !event.isError) return;
        const content = Array.isArray(event.result?.content) ? event.result.content : [];
        const detail = content.filter((item: { type?: string; text?: string }) => item.type === "text")
          .map((item: { text?: string }) => item.text ?? "").join(" ").trim();
        lastToolFailure = `${event.toolName} 执行失败${detail ? `：${detail.slice(-1_500)}` : "（工具未提供详细原因）"}`;
      });
      return {
        prompt: async (text) => {
          try {
            await pi.session.prompt(text);
          } catch (error) {
            const policyFailure = pi.getFailure();
            if (policyFailure) throw new Error(policyFailure, { cause: error });
            throw error;
          }
          const policyFailure = pi.getFailure();
          if (policyFailure) throw new Error(policyFailure);
          const lastAssistant = [...pi.session.messages].reverse().find((message) => message.role === "assistant");
          if (lastAssistant?.stopReason === "error") {
            throw new Error(lastAssistant.errorMessage || "Pi 模型请求失败");
          }
        },
        abort: () => pi.session.abort(),
        dispose: async () => { unsubscribe(); await pi.dispose(); },
        thinkingLevel: pi.thinkingLevel,
        getFailure: () => pi.getFailure() || lastToolFailure,
        get sessionFile() { return pi.session.sessionManager.getSessionFile(); },
        restoredSession,
      };
    });

    mkdirSync(this.tasksDir, { recursive: true });
    this.loadPersistedTasks();
  }

  getTask(taskId: string): Task | undefined {
    return this.runtimes.get(taskId)?.task;
  }

  listTasks(): Task[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.task)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getHub(taskId: string): SseHub | undefined {
    return this.runtimes.get(taskId)?.hub;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    this.reserveTaskAdmission();
    try { return await this.createReservedTask(input); }
    finally { this.admissionReserved = false; }
  }

  private async createReservedTask(input: CreateTaskInput): Promise<Task> {
    const taskId = randomUUID();
    const taskDir = path.join(this.tasksDir, taskId);
    const workspace = path.join(taskDir, "workspace");
    const sessionDir = path.join(taskDir, "session");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(sessionDir, { recursive: true }),
      fs.mkdir(input.outputDir, { recursive: true }),
    ]);

    const now = new Date().toISOString();
    const task: Task = {
      schemaVersion: 3,
      id: taskId,
      status: "pending",
      statusText: "正在准备 Pi Session",
      createdAt: now,
      input: {
        referenceVideo: input.referenceVideo,
        assetsDir: input.assetsDir,
        audioDir: input.audioDir,
        outputDir: input.outputDir,
        taskRequest: input.taskRequest,
        generateCount: input.generateCount,
      },
      model: { provider: input.model.provider, model: input.model.model },
      outputs: [],
      activeDurationMs: 0,
      attemptStartedAt: now,
      lastHeartbeatAt: now,
    };
    const runtime: TaskRuntime = {
      task,
      taskDir,
      workspace,
      sessionDir,
      session: null,
      hub: new SseHub(),
      outputSnapshot: await snapshotOutputDir(input.outputDir),
      outputMonitor: null,
      outputScan: null,
      promptPromise: null,
      persistPromise: Promise.resolve(),
      secrets: [input.model.apiKey].filter(Boolean),
      disposed: false,
      outputFailures: new Map(),
    };
    task.model = {
      ...task.model,
      ...(input.model.input ? { input: [...input.model.input] } : {}),
      requestedThinkingLevel: input.model.thinkingLevel ?? "auto",
      ...(input.model.thinking ? { verifiedThinking: input.model.thinking } : {}),
      fingerprint: modelIdentityHash(input.model),
    };
    task.outputBaseline = [...runtime.outputSnapshot.values()];
    this.runtimes.set(taskId, runtime);
    this.persist(runtime);
    this.broadcastTask(runtime);

    try {
      await this.startAttempt(runtime, input, buildTaskPrompt(input, this.executionPaths(runtime)));
      return task;
    } catch (error) {
      const message = this.safeError(runtime, error);
      await this.finish(runtime, "failed", "无法启动 Pi Session", message);
      throw new TaskCreateError(message, 400);
    }
  }

  async retryTask(taskId: string, model: ModelConfig): Promise<Task | undefined> {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return undefined;
    if (runtime.task.status !== "failed" && runtime.task.status !== "aborted") {
      throw new TaskCreateError("只有失败或已停止的任务可以重试。", 409);
    }
    this.reserveTaskAdmission();
    try { return await this.retryReservedTask(runtime, model); }
    finally { this.admissionReserved = false; }
  }

  private async retryReservedTask(runtime: TaskRuntime, model: ModelConfig): Promise<Task> {
    await runtime.promptPromise?.catch(() => undefined);
    const original = runtime.task.model;
    if (!original.fingerprint || original.fingerprint !== modelIdentityHash(model)
      || original.requestedThinkingLevel !== (model.thinkingLevel ?? "auto")) {
      throw new TaskCreateError("重试需使用原任务的服务商、地址、模型和思考设置；旧任务若缺少模型记录，请重新创建任务。", 409);
    }
    if (runtime.task.activeDurationMs === undefined) {
      runtime.task.activeDurationMs = Math.max(0,
        Date.parse(runtime.task.finishedAt ?? runtime.task.createdAt) - Date.parse(runtime.task.createdAt));
    }
    const input: CreateTaskInput = {
      ...runtime.task.input,
      model: {
        ...model,
        ...(original.input ? { input: original.input } : {}),
        ...(original.verifiedThinking ? { thinking: original.verifiedThinking } : {}),
      },
      modelCapabilityId: "",
    };
    const resumeSessionFile = await this.safeSessionFile(runtime);
    runtime.secrets = [model.apiKey].filter(Boolean);
    runtime.disposed = false;
    await this.recoverOutputs(runtime);
    await Promise.all([
      fs.mkdir(runtime.workspace, { recursive: true }),
      fs.mkdir(runtime.sessionDir, { recursive: true }),
    ]);
    runtime.task.status = "pending";
    runtime.task.statusText = "正在继续原任务";
    runtime.task.error = undefined;
    runtime.task.finishedAt = undefined;
    runtime.task.attemptStartedAt = new Date().toISOString();
    runtime.task.lastHeartbeatAt = runtime.task.attemptStartedAt;
    await this.persist(runtime);
    this.broadcastTask(runtime);
    try {
      await this.startAttempt(runtime, input,
        (restored) => buildResumePrompt(
          input,
          restored,
          runtime.task.outputs.map((item) => item.path),
          this.executionPaths(runtime),
        ), resumeSessionFile);
      return runtime.task;
    } catch (error) {
      const message = this.safeError(runtime, error);
      await this.finish(runtime, "failed", "无法继续任务", message);
      throw new TaskCreateError(message, 400);
    }
  }

  private async safeSessionFile(runtime: TaskRuntime): Promise<string | undefined> {
    const taskRoot = await fs.realpath(runtime.taskDir);
    const sessionRoot = await fs.realpath(runtime.sessionDir).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!sessionRoot) return undefined;
    if (!isInsideOrEqual(taskRoot, sessionRoot)) throw new TaskCreateError("原任务 Session 目录越界，无法安全恢复。", 400);
    let candidate = runtime.task.sessionFile;
    if (!candidate) {
      const files = await fs.readdir(sessionRoot, { withFileTypes: true });
      const sessions = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const file = path.join(sessionRoot, entry.name);
          return { file, mtimeMs: (await fs.stat(file)).mtimeMs };
        }));
      candidate = sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
    }
    if (!candidate) return undefined;
    const resolved = await fs.realpath(candidate).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!resolved) return undefined;
    if (!isInsideOrEqual(sessionRoot, resolved) || path.extname(resolved).toLowerCase() !== ".jsonl") {
      throw new TaskCreateError("原任务 Session 路径越界，无法安全恢复。", 400);
    }
    return resolved;
  }

  private async recoverOutputs(runtime: TaskRuntime): Promise<void> {
    runtime.outputFailures.clear();
    await fs.mkdir(runtime.task.input.outputDir, { recursive: true });
    const configuredOutput = path.resolve(runtime.task.input.outputDir);
    const outputRoot = await fs.realpath(runtime.task.input.outputDir);
    const known: Array<{ id: string; path: string }> = [];
    for (const output of runtime.task.outputs) {
      const real = await fs.realpath(output.path).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!real) continue;
      if (!isInsideOrEqual(outputRoot, real)) throw new TaskCreateError("已保存的成片路径越界，无法安全恢复。", 400);
      known.push({ id: output.id, path: real });
    }
    const playableKnown = new Set((await this.outputValidator(known.map((item) => item.path))).map(normalizePathKey));
    runtime.task.outputs = known.filter((item) => playableKnown.has(normalizePathKey(item.path)));
    const before: VideoSnapshot = runtime.task.outputBaseline
      ? new Map(runtime.task.outputBaseline.filter((item) => isInsideOrEqual(configuredOutput, item.path))
        .map((item) => [normalizePathKey(item.path), item]))
      : await snapshotOutputDir(configuredOutput);
    const after = await snapshotOutputDir(configuredOutput);
    const changed = diffVideoOutputs(before, after);
    const stable = await waitForStableVideoFiles(changed);
    const playable = await this.outputValidator(stable);
    const valid = new Set(playable.map(normalizePathKey));
    for (const file of stable) if (!valid.has(normalizePathKey(file))) {
      runtime.outputFailures.set(normalizePathKey(file), await videoProbeFailure(file) ?? `成片无法通过验证：${file}`);
    }
    const present = new Set(runtime.task.outputs.map((item) => normalizePathKey(item.path)));
    for (const file of playable) {
      const real = await fs.realpath(file);
      if (!isInsideOrEqual(outputRoot, real) || present.has(normalizePathKey(real))) continue;
      runtime.task.outputs.push({ id: randomUUID(), path: real });
      present.add(normalizePathKey(real));
    }
    runtime.outputSnapshot = after;
  }

  private async startAttempt(runtime: TaskRuntime, input: CreateTaskInput, prompt: string | ((restored: boolean) => string), resumeSessionFile?: string): Promise<void> {
    runtime.session = await this.sessionFactory(input, runtime.workspace, {
      taskId: runtime.task.id, taskDir: runtime.taskDir, sessionDir: runtime.sessionDir, resumeSessionFile,
    });
    if (!isActive(runtime.task.status)) {
      await runtime.session.dispose();
      runtime.session = null;
      runtime.disposed = true;
      throw new TaskCreateError("任务已停止，未启动 Pi。", 409);
    }
    if (runtime.session.thinkingLevel) runtime.task.model.thinkingLevel = runtime.session.thinkingLevel;
    if (runtime.session.sessionFile) runtime.task.sessionFile = runtime.session.sessionFile;
    runtime.task.status = "running";
    runtime.task.statusText = "Pi 正在调用剪辑技能并制作成片";
    runtime.task.startedAt ??= new Date().toISOString();
    await this.persist(runtime);
    this.broadcastTask(runtime);
    this.startOutputMonitor(runtime);
    runtime.promptPromise = this.executePrompt(runtime, input,
      typeof prompt === "string" ? prompt : prompt(runtime.session.restoredSession === true));
  }

  async abortTask(taskId: string): Promise<Task | undefined> {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return undefined;
    if (runtime.task.status !== "pending" && runtime.task.status !== "running") return runtime.task;

    await this.finish(runtime, "aborted", "任务已停止");
    try {
      await runtime.session?.abort();
    } catch {
      // The public state is already stopped. Abort failures must not restart it.
    }
    await this.disposeSession(runtime);
    return runtime.task;
  }

  async shutdown(): Promise<void> {
    const active = [...this.runtimes.values()].filter((runtime) => isActive(runtime.task.status));
    await Promise.allSettled(active.map((runtime) => this.abortTask(runtime.task.id)));
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.persistPromise));
  }

  private async executePrompt(runtime: TaskRuntime, input: CreateTaskInput, prompt: string): Promise<void> {
    try {
      await runtime.session!.prompt(prompt);
      if (!isActive(runtime.task.status)) return;
      await this.scanOutputs(runtime);
      const found = runtime.task.outputs.length;
      if (found >= input.generateCount) {
        await this.finish(runtime, "completed", `已完成 ${found} 条成片`);
      } else {
        const lastFailure = runtime.session?.getFailure?.() ?? [...runtime.outputFailures.values()].at(-1);
        const message = this.safeError(runtime, lastFailure
          ? `制作未完成（要求 ${input.generateCount} 条，找到 ${found} 条）。最近错误：${lastFailure}`
          : `要求 ${input.generateCount} 条，找到 ${found} 条`);
        await this.finish(runtime, "failed", message, message);
      }
    } catch (error) {
      if (!isActive(runtime.task.status)) return;
      // A completed file may still be in the debounce scan when Pi reports an error.
      // Settle and retain it before persisting the failed attempt.
      await runtime.outputScan?.catch(() => undefined);
      if (!isActive(runtime.task.status)) return;
      await this.scanOutputs(runtime).catch(() => undefined);
      if (!isActive(runtime.task.status)) return;
      const message = this.safeError(runtime, error);
      await this.finish(runtime, "failed", "制作失败", message);
    } finally {
      await this.disposeSession(runtime);
    }
  }

  private startOutputMonitor(runtime: TaskRuntime): void {
    runtime.outputMonitor = setInterval(() => {
      if (Date.now() - Date.parse(runtime.task.lastHeartbeatAt ?? runtime.task.createdAt) >= 30_000) {
        runtime.task.lastHeartbeatAt = new Date().toISOString();
        this.persist(runtime);
      }
      if (!isActive(runtime.task.status) || runtime.outputScan) return;
      runtime.outputScan = this.scanOutputs(runtime)
        .catch((error) => this.failFromOutputScan(runtime, error))
        .finally(() => { runtime.outputScan = null; });
    }, this.outputScanIntervalMs);
    runtime.outputMonitor.unref?.();
  }

  private async failFromOutputScan(runtime: TaskRuntime, error: unknown): Promise<void> {
    if (!isActive(runtime.task.status)) return;
    const message = this.safeError(runtime, error);
    await this.finish(runtime, "failed", "无法验证输出视频", message);
    try { await runtime.session?.abort(); } catch { /* best effort */ }
  }

  private async scanOutputs(runtime: TaskRuntime): Promise<void> {
    const current = runtime.outputScan;
    if (current) await current;
    if (!isActive(runtime.task.status)) return;

    const after = await snapshotOutputDir(runtime.task.input.outputDir);
    const changed = diffVideoOutputs(runtime.outputSnapshot, after);
    runtime.outputSnapshot = after;
    const stable = await waitForStableVideoFiles(changed);
    const playable = await this.outputValidator(stable);
    const valid = new Set(playable.map(normalizePathKey));
    for (const filePath of stable) {
      const key = normalizePathKey(filePath);
      if (valid.has(key)) runtime.outputFailures.delete(key);
      else runtime.outputFailures.set(key, await videoProbeFailure(filePath) ?? `成片无法通过验证：${filePath}`);
    }
    const known = new Set(runtime.task.outputs.map((output) => normalizePathKey(output.path)));
    for (const filePath of playable) {
      const real = await fs.realpath(filePath);
      const key = normalizePathKey(real);
      if (known.has(key)) continue;
      known.add(key);
      runtime.task.outputs.push({ id: randomUUID(), path: real });
      runtime.task.statusText = `已发现 ${runtime.task.outputs.length}/${runtime.task.input.generateCount} 条成片，Pi 仍在制作`;
      this.persist(runtime);
      runtime.hub.broadcast({ type: "output", timestamp: new Date().toISOString(), index: runtime.task.outputs.length - 1 });
      runtime.hub.broadcast({ type: "status", timestamp: new Date().toISOString(), message: runtime.task.statusText });
    }
  }

  private async finish(runtime: TaskRuntime, status: TaskStatus, statusText: string, error?: string): Promise<void> {
    if (!isActive(runtime.task.status)) return;
    this.stopOutputMonitor(runtime);
    runtime.task.status = status;
    runtime.task.statusText = statusText;
    if (runtime.session?.sessionFile) runtime.task.sessionFile = runtime.session.sessionFile;
    const endedAt = new Date().toISOString();
    const beganAt = Date.parse(runtime.task.attemptStartedAt ?? runtime.task.createdAt);
    runtime.task.activeDurationMs = (runtime.task.activeDurationMs ?? 0)
      + Math.max(0, Date.parse(endedAt) - (Number.isFinite(beganAt) ? beganAt : Date.parse(runtime.task.createdAt)));
    runtime.task.attemptStartedAt = undefined;
    runtime.task.finishedAt = endedAt;
    runtime.task.error = error;
    await this.persist(runtime);
    this.broadcastTask(runtime);
  }

  private stopOutputMonitor(runtime: TaskRuntime): void {
    if (runtime.outputMonitor) clearInterval(runtime.outputMonitor);
    runtime.outputMonitor = null;
  }

  private async disposeSession(runtime: TaskRuntime): Promise<void> {
    if (runtime.disposed) return;
    runtime.disposed = true;
    await runtime.session?.dispose();
    runtime.session = null;
  }

  private broadcastTask(runtime: TaskRuntime): void {
    runtime.hub.broadcast({
      type: "task",
      timestamp: new Date().toISOString(),
      status: runtime.task.status,
      statusText: runtime.task.statusText,
      ...(runtime.task.error ? { error: runtime.task.error } : {}),
    });
  }

  private persist(runtime: TaskRuntime): Promise<void> {
    const filePath = path.join(runtime.taskDir, "task.json");
    const snapshot = JSON.parse(JSON.stringify(runtime.task)) as Task;
    runtime.persistPromise = runtime.persistPromise
      .catch(() => undefined)
      .then(() => atomicWrite(filePath, snapshot));
    return runtime.persistPromise;
  }

  private loadPersistedTasks(): void {
    for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(this.tasksDir, entry.name);
      try {
        const task = parsePersistedTask(readFileSync(path.join(taskDir, "task.json"), "utf8"));
        if (!task) continue; // Persisted tasks from earlier schemas stay on disk.
        if (isActive(task.status)) {
          const beganAt = Date.parse(task.attemptStartedAt ?? task.createdAt);
          const lastActiveAt = Date.parse(task.lastHeartbeatAt ?? task.attemptStartedAt ?? task.createdAt);
          task.activeDurationMs = (task.activeDurationMs ?? 0) + Math.max(0, lastActiveAt - beganAt);
          task.attemptStartedAt = undefined;
          task.status = "failed";
          task.statusText = "服务在任务完成前退出，可继续原任务";
          task.error = task.statusText;
          task.finishedAt = new Date().toISOString();
        }
        const runtime: TaskRuntime = {
          task,
          taskDir,
          workspace: path.join(taskDir, "workspace"),
          sessionDir: path.join(taskDir, "session"),
          session: null,
          hub: new SseHub(),
          outputSnapshot: new Map(),
          outputMonitor: null,
          outputScan: null,
          promptPromise: null,
          persistPromise: Promise.resolve(),
          secrets: [],
          disposed: true,
          outputFailures: new Map(),
        };
        this.runtimes.set(task.id, runtime);
        if (task.error === task.statusText && task.statusText.includes("服务在任务完成前退出")) this.persist(runtime);
      } catch {
        // Invalid and legacy task files are intentionally ignored by the new UI.
      }
    }
  }

  private assertNoActiveTask(): void {
    if (this.admissionReserved) throw new TaskCreateError("同时只能运行一个任务。", 409);
    const active = [...this.runtimes.values()].find((runtime) => isActive(runtime.task.status));
    if (active) throw new TaskCreateError("同时只能运行一个任务。", 409, active.task.id);
  }

  private reserveTaskAdmission(): void {
    this.assertNoActiveTask();
    this.admissionReserved = true;
  }

  private executionPaths(runtime: TaskRuntime): TaskExecutionPaths {
    const portable = (value: string) => path.resolve(value).replace(/\\/g, "/");
    return {
      workspace: portable(runtime.workspace),
      mediaCacheScript: portable(path.join(this.projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs")),
      renderQueueScript: portable(path.join(this.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs")),
    };
  }

  private safeError(runtime: TaskRuntime, error: unknown): string {
    return sanitizePublicText(redactSecrets(errorMessage(error), runtime.secrets));
  }
}

export class TaskCreateError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly conflictingTaskId?: string,
  ) {
    super(message);
    this.name = "TaskCreateError";
  }
}

function isActive(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function modelIdentityHash(model: ModelConfig): string {
  return createHash("sha256").update(modelConfigFingerprint(model)).digest("hex");
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sanitizePublicText(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= 2_000 ? clean : `${clean.slice(0, 300)} … ${clean.slice(-1_696)}`;
}

function parsePersistedTask(json: string): Task | undefined {
  const value = JSON.parse(json) as Partial<Task>;
  if (
    value.schemaVersion !== 3
    || typeof value.id !== "string"
    || !["pending", "running", "completed", "failed", "aborted"].includes(String(value.status))
    || typeof value.statusText !== "string"
    || typeof value.createdAt !== "string"
    || !value.input
    || typeof value.input.referenceVideo !== "string"
    || typeof value.input.assetsDir !== "string"
    || typeof value.input.audioDir !== "string"
    || typeof value.input.outputDir !== "string"
    || typeof value.input.taskRequest !== "string"
    || !Number.isInteger(value.input.generateCount)
    || !value.model
    || typeof value.model.provider !== "string"
    || typeof value.model.model !== "string"
    || !Array.isArray(value.outputs)
    || value.outputs.some((output) => !output || typeof output.id !== "string" || typeof output.path !== "string")
  ) return undefined;
  return value as Task;
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}
