import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelThinkingLevelMap, ThinkingCapability } from "../tasks/types.js";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
import type { VisionProbeStatus } from "../pi/model.js";
import type { ModelCapabilityEvidence } from "./model-capabilities.js";

interface CapabilityFile {
  version: 2;
  entries: StoredCapabilityEvidence[];
}

interface StoredCapabilityEvidence {
  capabilityId: string;
  fingerprint: string;
  vision: VisionProbeStatus;
  testedAt: string;
  thinking: ThinkingCapability & { levelMap?: ModelThinkingLevelMap };
}

const THINKING_STATUSES = new Set<ThinkingCapability["status"]>(["supported", "unsupported", "unverified"]);
const THINKING_SOURCES = new Set<ThinkingCapability["source"]>([
  "official-registry",
  "provider-metadata",
  "pi-explicit",
  "manual",
  "unverified",
]);

export async function loadModelCapabilityEvidence(storagePath: string): Promise<ModelCapabilityEvidence[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(storagePath, "utf8"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error(`无法读取模型能力记录：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型能力记录格式无效");
  }
  const file = parsed as Partial<CapabilityFile>;
  if (file.version !== 2 || !Array.isArray(file.entries)) return [];
  const evidence = file.entries.map(parseStoredEvidence);
  const latestByFingerprint = new Map<string, ModelCapabilityEvidence>();
  for (const item of evidence) latestByFingerprint.set(item.fingerprint, item);
  return [...latestByFingerprint.values()];
}

export async function saveModelCapabilityEvidence(
  storagePath: string,
  evidence: readonly ModelCapabilityEvidence[],
): Promise<void> {
  const directory = path.dirname(storagePath);
  const temporary = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
  const file: CapabilityFile = {
    version: 2,
    entries: evidence.map((item) => ({
      capabilityId: item.capabilityId,
      fingerprint: item.fingerprint,
      vision: item.vision,
      testedAt: item.testedAt,
      thinking: cloneThinking(item.thinking),
    })),
  };
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await fs.rename(temporary, storagePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseStoredEvidence(value: unknown): ModelCapabilityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型能力记录条目无效");
  const raw = value as Record<string, unknown>;
  const capabilityId = nonEmptyText(raw.capabilityId, "capabilityId", 200);
  const fingerprint = nonEmptyText(raw.fingerprint, "fingerprint", 32_768);
  const testedAt = nonEmptyText(raw.testedAt, "testedAt", 100);
  if (!Number.isFinite(Date.parse(testedAt))) throw new Error("模型能力记录测试时间无效");
  const vision = raw.vision;
  if (vision !== "supported" && vision !== "unsupported" && vision !== "inconclusive") {
    throw new Error("模型能力记录图片状态无效");
  }
  return {
    capabilityId,
    fingerprint,
    vision,
    testedAt,
    thinking: parseThinking(raw.thinking),
  };
}

function parseThinking(value: unknown): ThinkingCapability & { levelMap?: ModelThinkingLevelMap } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型思考能力记录无效");
  const raw = value as Record<string, unknown>;
  if (!THINKING_STATUSES.has(raw.status as ThinkingCapability["status"])) throw new Error("模型思考能力状态无效");
  if (!THINKING_SOURCES.has(raw.source as ThinkingCapability["source"])) throw new Error("模型思考能力来源无效");
  if (!Array.isArray(raw.levels)) throw new Error("模型思考档位记录无效");
  const rawLevels = raw.levels;
  const levels = MODEL_THINKING_LEVELS.filter((level) => rawLevels.includes(level));
  const recommendedLevel = MODEL_THINKING_LEVELS.includes(raw.recommendedLevel as typeof MODEL_THINKING_LEVELS[number])
    ? raw.recommendedLevel as ThinkingCapability["recommendedLevel"]
    : undefined;
  const levelMap = parseLevelMap(raw.levelMap);
  return {
    status: raw.status as ThinkingCapability["status"],
    levels,
    ...(recommendedLevel && levels.includes(recommendedLevel) ? { recommendedLevel } : {}),
    source: raw.source as ThinkingCapability["source"],
    message: nonEmptyText(raw.message, "thinking.message", 2_000),
    ...(levelMap ? { levelMap } : {}),
  };
}

function parseLevelMap(value: unknown): ModelThinkingLevelMap | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型思考档位映射无效");
  const raw = value as Record<string, unknown>;
  const map: ModelThinkingLevelMap = {};
  for (const level of MODEL_THINKING_LEVELS) {
    const mapped = raw[level];
    if (mapped === undefined) continue;
    if (mapped !== null && typeof mapped !== "string") throw new Error("模型思考档位映射无效");
    map[level] = mapped;
  }
  return map;
}

function cloneThinking(
  capability: ThinkingCapability & { levelMap?: ModelThinkingLevelMap },
): ThinkingCapability & { levelMap?: ModelThinkingLevelMap } {
  return {
    ...capability,
    levels: [...capability.levels],
    ...(capability.levelMap ? { levelMap: { ...capability.levelMap } } : {}),
  };
}

function nonEmptyText(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value || value.length > limit) throw new Error(`模型能力记录 ${name} 无效`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
