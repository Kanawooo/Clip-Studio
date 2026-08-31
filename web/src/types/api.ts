export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export type ModelProtocol = "openai-completions" | "anthropic-messages";
export type ModelSource = "builtin" | "custom";
export type ModelInputCapability = "text" | "image";
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelThinkingLevel = typeof MODEL_THINKING_LEVELS[number];
export type ThinkingLevelSetting = "auto" | ModelThinkingLevel;

export interface ThinkingCapability {
  status: "supported" | "unsupported" | "unverified";
  levels: ModelThinkingLevel[];
  recommendedLevel?: ModelThinkingLevel;
  source: "official-registry" | "provider-metadata" | "pi-explicit" | "manual" | "unverified";
  message: string;
}

export interface ModelConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  credentialRef?: "main";
  model: string;
  protocol?: ModelProtocol;
  input?: ModelInputCapability[];
  thinkingLevel?: ThinkingLevelSetting;
}

export interface CreateTaskInput {
  referenceVideo: string;
  assetsDir: string;
  audioDir: string;
  outputDir: string;
  taskRequest: string;
  generateCount: number;
  model: ModelConfig;
  modelCapabilityId: string;
}

export interface TaskOutput { id: string; path: string }

export interface Task {
  id: string;
  status: TaskStatus;
  statusText: string;
  createdAt: string;
  input: {
    referenceVideo: string;
    assetsDir: string;
    audioDir: string;
    outputDir: string;
    taskRequest: string;
    generateCount: number;
  };
  model: { provider: string; model: string; thinkingLevel?: ModelThinkingLevel };
  startedAt?: string | null;
  finishedAt?: string | null;
  outputs: TaskOutput[];
  error?: string | null;
}

export interface ModelCatalogItem {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  protocol: string;
  input: string[];
  contextWindow: number;
  thinking: ThinkingCapability;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
}

export type VisionProbeStatus = "supported" | "unsupported" | "inconclusive";
export interface ModelCapabilityTest {
  fingerprint: string;
  status: VisionProbeStatus;
  testedAt: string;
  capabilityId?: string;
  thinking?: ThinkingCapability;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  startupId: string | null;
  frontendBuildId: string | null;
  node: { version: string; ok: boolean };
  ffmpeg: { ok: boolean };
  ffprobe: { ok: boolean };
  pi: { name: string; version: string | null };
  hyperframes: { name: string; version: string | null };
  projectRoot: string;
}

export type TaskEvent =
  | { id: string; type: "task"; timestamp: string; status: TaskStatus; statusText: string; error?: string }
  | { id: string; type: "status"; timestamp: string; message: string }
  | { id: string; type: "output"; timestamp: string; index: number };

export interface CreateTaskResponse { taskId: string; status: TaskStatus }
export interface AbortTaskResponse { taskId: string; status: TaskStatus }
export interface TestConnectionResponse {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  vision?: { status: VisionProbeStatus; message: string };
  thinking?: ThinkingCapability;
  capabilityId?: string;
  testedAt?: string;
}

export interface AppSettings {
  version: 8;
  modelSource: ModelSource;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  protocol: ModelProtocol;
  builtinProvider: string;
  builtinModel: string;
  customProvider: string;
  customModel: string;
  customBaseUrl: string;
  customProtocol: ModelProtocol;
  modelCapability: ModelCapabilityTest | null;
  thinkingLevel: ThinkingLevelSetting;
  rememberApiKey: boolean;
  mainKeyStored: boolean;
}

export interface LocalStateResponse {
  settings: Record<string, unknown>;
  draft: Record<string, unknown>;
  mainKeyStored: boolean;
}

export interface TaskDraft {
  referenceVideo: string;
  assetsDir: string;
  audioDir: string;
  outputDir: string;
  taskRequest: string;
  generateCount: number;
}
