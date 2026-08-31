import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SseHub } from "../api/sse.js";
import { buildTaskPrompt } from "../pi/prompt.js";
import { errorMessage, redactSecrets } from "../security.js";
import {
  diffVideoOutputs,
  filterPlayableVideoFiles,
  snapshotOutputDir,
  waitForStableVideoFiles,
  type VideoSnapshot,
} from "./outputs.js";
import type { CreateTaskInput, ModelThinkingLevel, Task, TaskStatus } from "./types.js";

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  thinkingLevel?: ModelThinkingLevel;
}

export interface SessionStartOptions {
  taskId: string;
  taskDir: string;
  sessionDir: string;
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

  constructor(options: TaskManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.agentDir = options.agentDir;
    this.tasksDir = options.tasksDir ?? path.join(this.projectRoot, "data", "tasks");
    this.outputValidator = options.outputValidator ?? filterPlayableVideoFiles;
    this.outputScanIntervalMs = Math.max(100, options.outputScanIntervalMs ?? 1_000);
    this.sessionFactory = options.sessionFactory ?? (async (input, workspace, start) => {
      const { createPiVideoSession } = await import("../pi/session.js");
      const pi = await createPiVideoSession({
        projectRoot: this.projectRoot,
        agentDir: this.agentDir,
        workspace,
        sessionDir: start.sessionDir,
        model: input.model,
      });
      return {
        prompt: (text) => pi.session.prompt(text),
        abort: () => pi.session.abort(),
        dispose: () => pi.dispose(),
        thinkingLevel: pi.thinkingLevel,
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
    this.assertNoActiveTask();
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
    };
    this.runtimes.set(taskId, runtime);
    this.persist(runtime);
    this.broadcastTask(runtime);

    try {
      runtime.session = await this.sessionFactory(input, workspace, { taskId, taskDir, sessionDir });
      if (runtime.session.thinkingLevel) task.model.thinkingLevel = runtime.session.thinkingLevel;
      task.status = "running";
      task.statusText = "Pi 正在调用剪辑技能并制作成片";
      task.startedAt = new Date().toISOString();
      this.persist(runtime);
      this.broadcastTask(runtime);
      this.startOutputMonitor(runtime);
      runtime.promptPromise = this.executePrompt(runtime, input);
      return task;
    } catch (error) {
      const message = this.safeError(runtime, error);
      await this.finish(runtime, "failed", "无法启动 Pi Session", message);
      throw new TaskCreateError(message, 400);
    }
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

  private async executePrompt(runtime: TaskRuntime, input: CreateTaskInput): Promise<void> {
    try {
      await runtime.session!.prompt(buildTaskPrompt(input));
      if (!isActive(runtime.task.status)) return;
      await this.scanOutputs(runtime);
      const found = runtime.task.outputs.length;
      if (found >= input.generateCount) {
        await this.finish(runtime, "completed", `已完成 ${found} 条成片`);
      } else {
        const message = `要求 ${input.generateCount} 条，找到 ${found} 条`;
        await this.finish(runtime, "failed", message, message);
      }
    } catch (error) {
      if (!isActive(runtime.task.status)) return;
      const message = this.safeError(runtime, error);
      await this.finish(runtime, "failed", "制作失败", message);
    } finally {
      await this.disposeSession(runtime);
    }
  }

  private startOutputMonitor(runtime: TaskRuntime): void {
    runtime.outputMonitor = setInterval(() => {
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
    const known = new Set(runtime.task.outputs.map((output) => normalizePathKey(output.path)));
    for (const filePath of playable) {
      const key = normalizePathKey(filePath);
      if (known.has(key)) continue;
      known.add(key);
      runtime.task.outputs.push({ id: randomUUID(), path: path.resolve(filePath) });
      runtime.task.statusText = `已发现 ${runtime.task.outputs.length}/${runtime.task.input.generateCount} 条成片，Pi 仍在制作`;
      this.persist(runtime);
      runtime.hub.broadcast({ type: "output", timestamp: new Date().toISOString(), index: runtime.task.outputs.length - 1 });
      runtime.hub.broadcast({ type: "status", timestamp: new Date().toISOString(), message: runtime.task.statusText });
    }
  }

  private async finish(runtime: TaskRuntime, status: TaskStatus, statusText: string, error?: string): Promise<void> {
    if (!isActive(runtime.task.status) && runtime.task.status !== status) return;
    this.stopOutputMonitor(runtime);
    runtime.task.status = status;
    runtime.task.statusText = statusText;
    runtime.task.finishedAt = new Date().toISOString();
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
          task.status = "failed";
          task.statusText = "服务在任务完成前退出，请重新创建任务";
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
        };
        this.runtimes.set(task.id, runtime);
        if (task.error === task.statusText && task.statusText.includes("服务在任务完成前退出")) this.persist(runtime);
      } catch {
        // Invalid and legacy task files are intentionally ignored by the new UI.
      }
    }
  }

  private assertNoActiveTask(): void {
    const active = [...this.runtimes.values()].find((runtime) => isActive(runtime.task.status));
    if (active) throw new TaskCreateError("同时只能运行一个任务。", 409, active.task.id);
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

function sanitizePublicText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000);
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
