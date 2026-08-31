import type {
  AppSettings,
  ModelCapabilityTest,
  ModelInputCapability,
  ThinkingCapability,
  VisionProbeStatus,
} from "../types/api.ts";

export type EffectiveModelCapability = VisionProbeStatus | "untested";

export function modelCapabilityFingerprint(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model">,
): string {
  return JSON.stringify([
    settings.provider.trim().toLocaleLowerCase(),
    settings.baseUrl.trim().replace(/\/+$/, ""),
    settings.protocol,
    settings.model.trim(),
  ]);
}

export function capabilityForSettings(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model" | "modelCapability">,
): ModelCapabilityTest | null {
  const capability = settings.modelCapability;
  if (!capability) return null;
  return capability.fingerprint === modelCapabilityFingerprint(settings) ? capability : null;
}

export function effectiveModelCapability(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model" | "modelCapability">,
): EffectiveModelCapability {
  return capabilityForSettings(settings)?.status ?? "untested";
}

export function hasConclusiveModelCapability(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model" | "modelCapability">,
): boolean {
  return effectiveModelCapability(settings) === "supported";
}

export function modelCapabilityBlockMessage(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model" | "modelCapability">,
): string | null {
  const status = effectiveModelCapability(settings);
  if (status === "supported") return null;
  if (status === "inconclusive") return "当前模型的图片能力无法确认，请重新测试";
  if (status === "unsupported") return "当前模型不支持图片，无法用于视频任务";
  return "请先测试主模型的图片理解能力";
}

export function modelInputCapabilities(settings: AppSettings): ModelInputCapability[] {
  return effectiveModelCapability(settings) === "supported"
    ? ["text", "image"]
    : ["text"];
}

export function thinkingCapabilityForSettings(
  settings: Pick<AppSettings, "provider" | "baseUrl" | "protocol" | "model" | "modelCapability">,
): ThinkingCapability | null {
  return capabilityForSettings(settings)?.thinking ?? null;
}
