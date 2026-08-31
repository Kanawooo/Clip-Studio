import { MODEL_THINKING_LEVELS, } from "../tasks/types.js";
const GOOGLE_THINKING_DOCS = "https://ai.google.dev/gemini-api/docs/thinking";
const OPENAI_REASONING_DOCS = "https://platform.openai.com/docs/guides/reasoning";
// Capability facts only. The source URLs make every model-family rule auditable
// when the project-local registry is updated with a release.
const OFFICIAL_THINKING_ENTRIES = [
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
];
export function officialThinkingCapability(modelId) {
    const normalized = normalizeModelId(modelId);
    const entry = OFFICIAL_THINKING_ENTRIES.find((candidate) => officialAliases(candidate).includes(normalized));
    if (!entry)
        return undefined;
    return {
        canonicalId: entry.canonicalId,
        levels: normalizeLevels(entry.levels),
        ...(entry.recommendedLevel ? { recommendedLevel: entry.recommendedLevel } : {}),
        sourceUrl: entry.sourceUrl,
        verifiedAt: entry.verifiedAt,
    };
}
export function officialThinkingCapabilityView(modelId) {
    const match = officialThinkingCapability(modelId);
    if (!match)
        return undefined;
    return {
        status: "supported",
        levels: [...match.levels],
        ...(match.recommendedLevel ? { recommendedLevel: match.recommendedLevel } : {}),
        source: "official-registry",
        message: `已按官方资料确认 ${match.levels.length} 个思考档位`,
    };
}
function google(canonicalId, levels, recommendedLevel) {
    return {
        canonicalId,
        aliases: [`models/${canonicalId}`, `google/${canonicalId}`],
        levels,
        ...(recommendedLevel ? { recommendedLevel } : {}),
        sourceUrl: GOOGLE_THINKING_DOCS,
        verifiedAt: "2026-08-25",
    };
}
function officialAliases(entry) {
    return [entry.canonicalId, ...(entry.aliases ?? [])].map(normalizeModelId);
}
function normalizeModelId(modelId) {
    return modelId.trim().toLocaleLowerCase().replace(/^models\//, "models/");
}
function normalizeLevels(levels) {
    const available = new Set(levels);
    return MODEL_THINKING_LEVELS.filter((level) => available.has(level));
}
