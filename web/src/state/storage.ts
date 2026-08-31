import {
  MODEL_THINKING_LEVELS,
  type AppSettings,
  type LocalStateResponse,
  type ModelCapabilityTest,
  type ModelProtocol,
  type TaskDraft,
  type ThinkingCapability,
  type ThinkingLevelSetting,
} from "../types/api.ts";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 8,
  modelSource: "custom",
  provider: "",
  model: "",
  apiKey: "",
  baseUrl: "",
  protocol: "openai-completions",
  builtinProvider: "",
  builtinModel: "",
  customProvider: "",
  customModel: "",
  customBaseUrl: "",
  customProtocol: "openai-completions",
  modelCapability: null,
  thinkingLevel: "auto",
  rememberApiKey: false,
  mainKeyStored: false,
};

export const DEFAULT_DRAFT: TaskDraft = {
  referenceVideo: "",
  assetsDir: "",
  audioDir: "",
  outputDir: "",
  taskRequest: "",
  generateCount: 1,
};

export function settingsFromLocalState(state: LocalStateResponse): AppSettings {
  const value = state.settings;
  const modelSource = value.modelSource === "builtin" ? "builtin" : "custom";
  const builtinProvider = stringValue(value.builtinProvider);
  const builtinModel = stringValue(value.builtinModel);
  const customProvider = stringValue(value.customProvider);
  const customModel = stringValue(value.customModel);
  const customBaseUrl = stringValue(value.customBaseUrl);
  const customProtocol = modelProtocol(value.customProtocol);
  const provider = modelSource === "builtin" ? builtinProvider : customProvider;
  const model = modelSource === "builtin" ? builtinModel : customModel;
  return {
    ...DEFAULT_SETTINGS,
    modelSource,
    provider,
    model,
    baseUrl: modelSource === "builtin" ? "" : customBaseUrl,
    protocol: modelSource === "builtin" ? "openai-completions" : customProtocol,
    builtinProvider,
    builtinModel,
    customProvider,
    customModel,
    customBaseUrl,
    customProtocol,
    modelCapability: modelCapabilityValue(value.modelCapability),
    thinkingLevel: thinkingLevelValue(value.thinkingLevel),
    rememberApiKey: value.rememberApiKey === true && state.mainKeyStored,
    mainKeyStored: state.mainKeyStored,
  };
}

export function draftFromLocalState(state: LocalStateResponse): TaskDraft {
  const value = state.draft;
  return {
    referenceVideo: stringValue(value.referenceVideo),
    assetsDir: stringValue(value.assetsDir),
    audioDir: stringValue(value.audioDir),
    outputDir: stringValue(value.outputDir),
    taskRequest: stringValue(value.taskRequest),
    generateCount: Number.isInteger(value.generateCount) && Number(value.generateCount) > 0
      ? Math.min(Number(value.generateCount), 20)
      : 1,
  };
}

export function settingsForPersistence(settings: AppSettings): Record<string, unknown> {
  return {
    version: settings.version,
    modelSource: settings.modelSource,
    builtinProvider: settings.builtinProvider,
    builtinModel: settings.builtinModel,
    customProvider: settings.customProvider,
    customModel: settings.customModel,
    customBaseUrl: settings.customBaseUrl,
    customProtocol: settings.customProtocol,
    modelCapability: settings.modelCapability,
    thinkingLevel: settings.thinkingLevel,
    rememberApiKey: settings.rememberApiKey,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function modelProtocol(value: unknown): ModelProtocol {
  return value === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
}

function modelCapabilityValue(value: unknown): ModelCapabilityTest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.fingerprint !== "string"
    || candidate.fingerprint.length === 0
    || (candidate.status !== "supported" && candidate.status !== "unsupported" && candidate.status !== "inconclusive")
    || typeof candidate.testedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.testedAt))
  ) return null;
  const thinking = thinkingCapabilityValue(candidate.thinking);
  return {
    fingerprint: candidate.fingerprint,
    status: candidate.status,
    testedAt: candidate.testedAt,
    ...(typeof candidate.capabilityId === "string" && candidate.capabilityId ? { capabilityId: candidate.capabilityId } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function thinkingLevelValue(value: unknown): ThinkingLevelSetting {
  return value === "auto" || MODEL_THINKING_LEVELS.includes(value as typeof MODEL_THINKING_LEVELS[number])
    ? value as ThinkingLevelSetting
    : "auto";
}

function thinkingCapabilityValue(value: unknown): ThinkingCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.message !== "string" || !Array.isArray(raw.levels)) return null;
  const status = raw.status === "supported" || raw.status === "unsupported" || raw.status === "unverified"
    ? raw.status
    : undefined;
  const source = raw.source === "official-registry"
    || raw.source === "provider-metadata"
    || raw.source === "pi-explicit"
    || raw.source === "manual"
    || raw.source === "unverified"
    ? raw.source
    : undefined;
  if (!status || !source) return null;
  const rawLevels = raw.levels as unknown[];
  const levels = MODEL_THINKING_LEVELS.filter((level) => rawLevels.includes(level));
  const recommendedLevel = MODEL_THINKING_LEVELS.includes(raw.recommendedLevel as typeof MODEL_THINKING_LEVELS[number])
    ? raw.recommendedLevel as ThinkingCapability["recommendedLevel"]
    : undefined;
  return {
    status,
    source,
    message: raw.message,
    levels,
    ...(recommendedLevel ? { recommendedLevel } : {}),
  };
}
