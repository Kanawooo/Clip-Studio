import {
  MODEL_THINKING_LEVELS,
  type ModelThinkingLevel,
  type ModelThinkingLevelMap,
  type ThinkingCapability,
} from "../tasks/types.js";

interface OfficialThinkingEntry {
  canonicalId: string;
  aliases?: readonly string[];
  levels: readonly ModelThinkingLevel[];
  levelMap?: ModelThinkingLevelMap;
  recommendedLevel?: ModelThinkingLevel;
  sourceUrl: string;
  verifiedAt: string;
}

export interface OfficialThinkingMatch {
  canonicalId: string;
  levels: ModelThinkingLevel[];
  levelMap?: ModelThinkingLevelMap;
  recommendedLevel?: ModelThinkingLevel;
  sourceUrl: string;
  verifiedAt: string;
}

const GOOGLE_THINKING_DOCS = "https://ai.google.dev/gemini-api/docs/thinking";
const OPENAI_REASONING_DOCS = "https://platform.openai.com/docs/guides/reasoning";
const DEEPSEEK_THINKING_DOCS = "https://api-docs.deepseek.com/guides/thinking_mode/";

// Capability facts only. The source URLs make every model-family rule auditable
// when the project-local registry is updated with a release.
const OFFICIAL_THINKING_ENTRIES: readonly OfficialThinkingEntry[] = [
  google("gemini-3.7-flash", ["low", "medium", "high"], "medium"),
  google("gemini-3.6-flash", ["minimal", "low", "medium", "high"], "medium"),
  google("gemini-3.5-flash", ["minimal", "low", "medium", "high"], "medium"),
  google("gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"], "minimal"),
  google("gemini-3.1-pro-preview", ["low", "medium", "high"], "high"),
  google("gemini-3.1-flash-lite-image", ["minimal", "high"], "minimal"),
  google("gemini-3-flash-preview", ["minimal", "low", "medium", "high"], "high"),
  google("gemini-3-pro-preview", ["low", "high"], "high"),
  google("gemini-2.5-pro", ["low", "medium", "high"]),
  google("gemini-2.5-flash", ["low", "medium", "high"]),
  google("gemini-2.5-flash-lite", ["low", "medium", "high"]),
  {
    canonicalId: "deepseek-flash",
    levels: ["off", "low", "high", "max"],
    levelMap: { minimal: null, medium: null, xhigh: null, max: "max" },
    recommendedLevel: "high",
    sourceUrl: DEEPSEEK_THINKING_DOCS,
    verifiedAt: "2026-09-27",
  },
  {
    canonicalId: "gpt-5.1",
    aliases: ["openai/gpt-5.1"],
    levels: ["off", "low", "medium", "high"],
    recommendedLevel: "off",
    sourceUrl: OPENAI_REASONING_DOCS,
    verifiedAt: "2026-08-25",
  },
  {
    canonicalId: "gpt-5-pro",
    aliases: ["openai/gpt-5-pro"],
    levels: ["high"],
    recommendedLevel: "high",
    sourceUrl: OPENAI_REASONING_DOCS,
    verifiedAt: "2026-08-25",
  },
] as const;

export function officialThinkingCapability(modelId: string): OfficialThinkingMatch | undefined {
  const normalized = normalizeModelId(modelId);
  const suffix = normalized.split("/").at(-1);
  const entry = OFFICIAL_THINKING_ENTRIES.find((candidate) => officialAliases(candidate).includes(normalized))
    ?? OFFICIAL_THINKING_ENTRIES.find((candidate) => normalizeModelId(candidate.canonicalId) === suffix);
  if (!entry) return undefined;
  return {
    canonicalId: entry.canonicalId,
    levels: normalizeLevels(entry.levels),
    ...(entry.levelMap ? { levelMap: { ...entry.levelMap } } : {}),
    ...(entry.recommendedLevel ? { recommendedLevel: entry.recommendedLevel } : {}),
    sourceUrl: entry.sourceUrl,
    verifiedAt: entry.verifiedAt,
  };
}

export function officialThinkingCapabilityView(
  modelId: string,
): (ThinkingCapability & { levelMap?: ModelThinkingLevelMap }) | undefined {
  const match = officialThinkingCapability(modelId);
  if (!match) return undefined;
  return {
    status: "supported",
    levels: [...match.levels],
    ...(match.levelMap ? { levelMap: { ...match.levelMap } } : {}),
    ...(match.recommendedLevel ? { recommendedLevel: match.recommendedLevel } : {}),
    source: "official-registry",
    message: `已按官方资料确认 ${match.levels.length} 个思考档位`,
  };
}

function google(
  canonicalId: string,
  levels: readonly ModelThinkingLevel[],
  recommendedLevel?: ModelThinkingLevel,
): OfficialThinkingEntry {
  return {
    canonicalId,
    aliases: [`models/${canonicalId}`, `google/${canonicalId}`],
    levels,
    ...(recommendedLevel ? { recommendedLevel } : {}),
    sourceUrl: GOOGLE_THINKING_DOCS,
    verifiedAt: "2026-08-25",
  };
}

function officialAliases(entry: OfficialThinkingEntry): string[] {
  return [entry.canonicalId, ...(entry.aliases ?? [])].map(normalizeModelId);
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLocaleLowerCase().replace(/^models\//, "models/");
}

function normalizeLevels(levels: readonly ModelThinkingLevel[]): ModelThinkingLevel[] {
  const available = new Set(levels);
  return MODEL_THINKING_LEVELS.filter((level) => available.has(level));
}
