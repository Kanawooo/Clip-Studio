/** Minimal task and model data shared by the local API and task runner. */

export type ModelProtocol = "openai-completions" | "anthropic-messages";
export type ModelInputCapability = "text" | "image";
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelThinkingLevel = typeof MODEL_THINKING_LEVELS[number];
export type ThinkingLevelSetting = "auto" | ModelThinkingLevel;
export type ModelThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export interface ThinkingCapability {
  status: "supported" | "unsupported" | "unverified";
  levels: ModelThinkingLevel[];
  recommendedLevel?: ModelThinkingLevel;
  source: "official-registry" | "provider-metadata" | "pi-explicit" | "manual" | "unverified";
  message: string;
}

/** Backend-verified runtime metadata. HTTP input cannot populate this field. */
export interface VerifiedModelThinking {
  reasoning: boolean;
  levels: ModelThinkingLevel[];
  recommendedLevel?: ModelThinkingLevel;
  levelMap?: ModelThinkingLevelMap;
}

export const DEFAULT_TASK_REQUEST =
  "模仿参考视频的节奏和画面组织，筛掉误拍、晃动、空镜头和没有意义的素材，制作一条完整成片。";

export interface ModelConfig {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  model: string;
  protocol?: ModelProtocol;
  input?: ModelInputCapability[];
  thinkingLevel?: ThinkingLevelSetting;
  thinking?: VerifiedModelThinking;
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

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface TaskOutput {
  id: string;
  path: string;
}

export interface Task {
  schemaVersion: 3;
  id: string;
  status: TaskStatus;
  statusText: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  input: {
    referenceVideo: string;
    assetsDir: string;
    audioDir: string;
    outputDir: string;
    taskRequest: string;
    generateCount: number;
  };
  model: {
    provider: string;
    model: string;
    thinkingLevel?: ModelThinkingLevel;
  };
  outputs: TaskOutput[];
  error?: string;
}
