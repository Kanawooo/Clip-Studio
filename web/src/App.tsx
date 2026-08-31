import { Clock3, Plus, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectTaskEvents } from "./api/sse.ts";
import {
  abortTask,
  createTask,
  getHealth,
  getLocalState,
  getModels,
  getTask,
  listTasks,
  saveLocalDraft,
  saveLocalSettings,
} from "./api/tasks.ts";
import { RunPanel } from "./components/RunPanel.tsx";
import { SettingsDrawer } from "./components/SettingsDrawer.tsx";
import { TaskComposer } from "./components/TaskComposer.tsx";
import { TaskHistoryDrawer } from "./components/TaskHistoryDrawer.tsx";
import { Toast, type ToastState } from "./components/Toast.tsx";
import { hasConclusiveModelCapability, modelCapabilityBlockMessage, modelInputCapabilities } from "./state/model-capability.ts";
import {
  DEFAULT_DRAFT,
  DEFAULT_SETTINGS,
  draftFromLocalState,
  settingsForPersistence,
  settingsFromLocalState,
} from "./state/storage.ts";
import type { AppSettings, CreateTaskInput, HealthResponse, ModelCatalogItem, Task, TaskDraft, TaskEvent } from "./types/api.ts";

const FRONTEND_BUILD_ID = typeof __FRONTEND_BUILD_ID__ === "string" ? __FRONTEND_BUILD_ID__ : "test";

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS });
  const [draft, setDraft] = useState<TaskDraft>({ ...DEFAULT_DRAFT });
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [connection, setConnection] = useState<"checking" | "connected" | "degraded" | "disconnected">("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<number | null>(null);
  const localStateReady = useRef(false);
  const seenEvents = useRef(new Set<string>());

  const mergeTask = useCallback((task: Task) => {
    setTasks((current) => sortTasks([task, ...current.filter((item) => item.id !== task.id)]));
  }, []);

  const notify = useCallback((message: string, tone: ToastState["tone"] = "info") => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 4_200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let mounted = true;
    setReady(false);
    setLoadError(null);
    void Promise.all([getLocalState(), getModels(), listTasks()]).then(([state, models, tasks]) => {
      if (!mounted) return;
      setSettings(settingsFromLocalState(state));
      setDraft(draftFromLocalState(state));
      setModelCatalog(models);
      setTasks(sortTasks(tasks));
      setSelectedTaskId(null);
      localStateReady.current = true;
      setReady(true);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setLoadError(errorMessage(error));
      setReady(true);
    });
    return () => { mounted = false; };
  }, [reloadKey]);

  const probeHealth = useCallback(async () => {
    try {
      const next = await getHealth({ cache: "no-store", timeoutMs: 5_000 });
      if (next.frontendBuildId && next.frontendBuildId !== FRONTEND_BUILD_ID && reloadForFrontendBuild(next.frontendBuildId)) return;
      setHealth(next);
      setConnection(next.status === "ok" ? "connected" : "degraded");
    } catch {
      setHealth(null);
      setConnection("disconnected");
    }
  }, []);

  useEffect(() => {
    void probeHealth();
    const timer = window.setInterval(() => void probeHealth(), 5_000);
    window.addEventListener("focus", probeHealth);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", probeHealth);
    };
  }, [probeHealth]);

  useEffect(() => {
    if (!localStateReady.current) return;
    const timer = window.setTimeout(() => {
      void saveLocalDraft(draft).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const refreshTask = useCallback(async (taskId: string) => {
    const task = await getTask(taskId);
    mergeTask(task);
    return task;
  }, [mergeTask]);

  const runningTask = tasks.find((task) => isActive(task.status)) ?? null;
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) ?? null : null;

  useEffect(() => {
    if (!runningTask) return;
    const taskId = runningTask.id;
    seenEvents.current = new Set();
    return connectTaskEvents(taskId, {
      onEvent: (event) => {
        if (seenEvents.current.has(event.id)) return;
        seenEvents.current.add(event.id);
        setTasks((current) => current.map((task) => task.id === taskId ? applyTaskEvent(task, event) : task));
        if (event.type === "output" || event.type === "task") {
          void refreshTask(taskId).then((task) => {
            if (event.type === "task" && isTerminal(task.status)) notifyTerminal(task, notify);
          }).catch((error) => notify(errorMessage(error), "error"));
        }
      },
      onTerminal: (task) => {
        mergeTask(task);
        notifyTerminal(task, notify);
      },
      onError: (error) => notify(error.message, "error"),
    });
  }, [mergeTask, notify, refreshTask, runningTask?.id, runningTask?.status]);

  const modelConfigured = Boolean(settings.provider.trim() && settings.model.trim() && (settings.apiKey.trim() || settings.mainKeyStored));
  const settingsReady = modelConfigured && hasConclusiveModelCapability(settings);
  const busy = Boolean(runningTask);

  const handleCreate = async () => {
    if (busy) return notify("当前任务结束或停止后才能开始新的制作", "info");
    const required: Array<[keyof TaskDraft, string, string]> = [
      ["referenceVideo", "请先选择参考视频", "reference-video"],
      ["assetsDir", "请选择素材目录", "assets-directory"],
      ["audioDir", "请选择音频目录", "audio-directory"],
      ["outputDir", "请选择输出目录", "output-directory"],
    ];
    for (const [key, message, elementId] of required) {
      if (String(draft[key]).trim()) continue;
      notify(message, "error");
      document.getElementById(elementId)?.focus();
      return;
    }
    if (!modelConfigured) {
      setSettingsOpen(true);
      return;
    }
    if (!hasConclusiveModelCapability(settings)) {
      notify(modelCapabilityBlockMessage(settings) ?? "当前模型无法用于视频任务", "error");
      setSettingsOpen(true);
      return;
    }

    setSubmitting(true);
    try {
      const created = await createTask(buildCreateInput(draft, settings));
      const task = await getTask(created.taskId);
      mergeTask(task);
      setSelectedTaskId(task.id);
      notify("任务已经开始", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAbort = async () => {
    if (!selectedTask || !isActive(selectedTask.status)) return;
    setAborting(true);
    try {
      await abortTask(selectedTask.id);
      const stopped = await getTask(selectedTask.id);
      mergeTask(stopped);
      notify("任务已停止", "info");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setAborting(false);
    }
  };

  const handleNewTask = () => {
    setHistoryOpen(false);
    setSelectedTaskId(null);
    window.requestAnimationFrame(() => document.getElementById("new-task-title")?.focus());
  };

  const handleSelectHistory = (taskId: string) => {
    setSelectedTaskId(taskId);
    setHistoryOpen(false);
    void refreshTask(taskId).catch((error) => notify(errorMessage(error), "error"));
  };

  const persistSettings = async (next: AppSettings): Promise<AppSettings> => {
    const state = await saveLocalSettings({
      settings: settingsForPersistence(next),
      ...(next.rememberApiKey && next.apiKey ? { mainApiKey: next.apiKey } : {}),
    });
    return { ...next, mainKeyStored: state.mainKeyStored };
  };

  const handleSaveSettings = async (next: AppSettings) => {
    try {
      setSettings(await persistSettings(next));
      setSettingsOpen(false);
      notify("设置已保存", "success");
    } catch (error) {
      notify(`无法保存设置：${errorMessage(error)}`, "error");
    }
  };

  const handleAutoSaveSettings = async (next: AppSettings): Promise<boolean> => {
    try {
      setSettings(await persistSettings(next));
      return true;
    } catch (error) {
      notify(`无法自动保存设置：${errorMessage(error)}`, "error");
      return false;
    }
  };

  if (!ready) return <div className="bootstrap-screen" aria-live="polite"><p>正在准备本地剪辑环境…</p></div>;
  if (loadError) {
    return <div className="bootstrap-screen"><div className="bootstrap-card"><strong>无法加载界面</strong><p>{loadError}</p><button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>重新加载</button></div></div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="product-mark"><span aria-hidden="true" /><strong>Clip Studio</strong></div>
        <div className="top-actions">
          <button className={`top-action-button${selectedTaskId === null ? " active" : ""}`} type="button" onClick={handleNewTask}>
            <Plus size={17} /><span className="top-action-label">新建任务</span>
          </button>
          <button className={`top-action-button${historyOpen || selectedTaskId !== null ? " active" : ""}`} type="button" aria-expanded={historyOpen} onClick={() => { setSettingsOpen(false); setHistoryOpen(true); }}>
            <Clock3 size={17} /><span className="top-action-label">历史任务</span>
          </button>
          <span className={`connection-pill ${connection}`}><span />{connectionLabel(connection, health)}</span>
          <button className="top-action-button" type="button" aria-expanded={settingsOpen} onClick={() => { setHistoryOpen(false); setSettingsOpen(true); }}>
            <Settings2 size={17} /><span className="top-action-label">模型设置</span>
          </button>
        </div>
      </header>

      <main className="workspace-grid">
        <TaskComposer
          draft={draft}
          disabled={Boolean(busy)}
          submitting={submitting}
          settingsReady={settingsReady}
          onChange={setDraft}
          onSubmit={() => void handleCreate()}
          onError={(message) => notify(message, "error")}
        />
        <RunPanel
          task={selectedTask}
          blockedByRunningTask={Boolean(runningTask && !selectedTask)}
          aborting={aborting}
          onAbort={() => void handleAbort()}
          onError={(message) => notify(message, "error")}
        />
      </main>

      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        modelCatalog={modelCatalog}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        onAutoSave={handleAutoSaveSettings}
        onModelTestSettled={() => void probeHealth()}
        onError={(message) => notify(message, "error")}
      />
      <TaskHistoryDrawer
        open={historyOpen}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        onClose={() => setHistoryOpen(false)}
        onSelect={handleSelectHistory}
      />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function buildCreateInput(draft: TaskDraft, settings: AppSettings): CreateTaskInput {
  const modelCapabilityId = settings.modelCapability?.capabilityId;
  if (!modelCapabilityId) throw new Error("请先测试主模型的图片理解能力");
  return {
    referenceVideo: draft.referenceVideo.trim(),
    assetsDir: draft.assetsDir.trim(),
    audioDir: draft.audioDir.trim(),
    outputDir: draft.outputDir.trim(),
    taskRequest: draft.taskRequest.trim(),
    generateCount: Math.min(20, Math.max(1, draft.generateCount)),
    model: {
      provider: settings.provider.trim(),
      model: settings.model.trim(),
      ...(settings.apiKey ? { apiKey: settings.apiKey } : { credentialRef: "main" as const }),
      ...(settings.baseUrl.trim() ? {
        baseUrl: settings.baseUrl.trim(),
        protocol: settings.protocol,
        input: modelInputCapabilities(settings),
      } : {}),
      thinkingLevel: settings.thinkingLevel,
    },
    modelCapabilityId,
  };
}

function applyTaskEvent(task: Task, event: TaskEvent): Task {
  if (event.type === "task") {
    return { ...task, status: event.status, statusText: event.statusText, error: event.error ?? task.error };
  }
  if (event.type === "status") return { ...task, statusText: event.message };
  return task;
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function isActive(status: Task["status"]): boolean {
  return status === "pending" || status === "running";
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function notifyTerminal(task: Task, notify: (message: string, tone?: ToastState["tone"]) => void): void {
  if (task.status === "completed") notify("视频已经制作完成", "success");
  else if (task.status === "failed") notify(task.error || "制作失败", "error");
  else if (task.status === "aborted") notify("任务已停止", "info");
}

function connectionLabel(state: "checking" | "connected" | "degraded" | "disconnected", health: HealthResponse | null): string {
  if (state === "connected" && health?.status === "ok") return "本地服务正常";
  if (state === "degraded") return "环境需要检查";
  if (state === "disconnected") return "本地服务已断开";
  return "正在连接";
}

function reloadForFrontendBuild(buildId: string): boolean {
  const marker = `pi-video-frontend-reload:${buildId}`;
  try {
    if (window.sessionStorage.getItem(marker) === "1") return false;
    window.sessionStorage.setItem(marker, "1");
  } catch { /* a disabled session store should not block the UI */ }
  const url = new URL(window.location.href);
  url.searchParams.set("ui-build", buildId);
  window.location.replace(url);
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误";
}
