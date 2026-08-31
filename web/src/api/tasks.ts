import { requestJson, type RequestJsonOptions } from "./client.ts";
import type {
  AbortTaskResponse,
  CreateTaskInput,
  CreateTaskResponse,
  DiscoveredModel,
  HealthResponse,
  LocalStateResponse,
  ModelCatalogItem,
  ModelConfig,
  ModelThinkingLevel,
  Task,
  TestConnectionResponse,
} from "../types/api.ts";

export const getHealth = (options: RequestJsonOptions = {}) => requestJson<HealthResponse>("/api/health", options);
export const getLocalState = () => requestJson<LocalStateResponse>("/api/local-state", { cache: "no-store" });
export const saveLocalSettings = (input: { settings: Record<string, unknown>; mainApiKey?: string }) =>
  requestJson<LocalStateResponse>("/api/local-state/settings", { method: "PUT", body: JSON.stringify(input) });
export const saveLocalDraft = (draft: unknown) => requestJson<LocalStateResponse>("/api/local-state/draft", {
  method: "PUT",
  body: JSON.stringify({ draft }),
});
export const getModels = async () => (await requestJson<{ models: ModelCatalogItem[] }>("/api/models")).models;
export const listTasks = async () => (await requestJson<{ tasks: Task[] }>("/api/tasks")).tasks;
export const getTask = (taskId: string) => requestJson<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
export const createTask = (input: CreateTaskInput) => requestJson<CreateTaskResponse>("/api/tasks", {
  method: "POST",
  body: JSON.stringify(input),
});
export const abortTask = (taskId: string) => requestJson<AbortTaskResponse>(`/api/tasks/${encodeURIComponent(taskId)}/abort`, {
  method: "POST",
  body: "{}",
});
export const testModel = (model: ModelConfig) => requestJson<TestConnectionResponse>("/api/models/test", {
  method: "POST",
  body: JSON.stringify(model),
});
export const setModelThinkingCapability = (input: { capabilityId: string; model: ModelConfig; levels: ModelThinkingLevel[] }) =>
  requestJson<{ capabilityId: string; thinking: TestConnectionResponse["thinking"] }>("/api/models/capability/thinking", {
    method: "PUT",
    body: JSON.stringify(input),
  });
export const discoverModels = (input: { baseUrl: string; protocol: ModelConfig["protocol"]; apiKey?: string; credentialRef?: "main" }) =>
  requestJson<{ models: DiscoveredModel[] }>("/api/models/discover", { method: "POST", body: JSON.stringify(input) });

export function pickPath(type: "file" | "directory", title: string, initialPath?: string) {
  return requestJson<{ path: string | null; cancelled: boolean }>("/api/dialog/pick", {
    method: "POST",
    body: JSON.stringify({ type, title, ...(initialPath?.trim() ? { initialPath: initialPath.trim() } : {}) }),
  });
}

export const revealTaskOutput = (taskId: string, outputIndex?: number) => requestJson<{ status: string }>("/api/system/reveal", {
  method: "POST",
  body: JSON.stringify({ taskId, ...(outputIndex === undefined ? {} : { outputIndex }) }),
});

export const getTaskOutputVideoUrl = (taskId: string, outputIndex: number) =>
  `/api/tasks/${encodeURIComponent(taskId)}/outputs/${outputIndex}/content`;
