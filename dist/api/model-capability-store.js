import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
const THINKING_STATUSES = new Set(["supported", "unsupported", "unverified"]);
const THINKING_SOURCES = new Set([
    "official-registry",
    "provider-metadata",
    "pi-explicit",
    "manual",
    "unverified",
]);
export async function loadModelCapabilityEvidence(storagePath) {
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(storagePath, "utf8"));
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw new Error(`无法读取模型能力记录：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("模型能力记录格式无效");
    }
    const file = parsed;
    if (file.version !== 2 || !Array.isArray(file.entries))
        return [];
    const evidence = file.entries.map(parseStoredEvidence);
    const latestByFingerprint = new Map();
    for (const item of evidence)
        latestByFingerprint.set(item.fingerprint, item);
    return [...latestByFingerprint.values()];
}
export async function saveModelCapabilityEvidence(storagePath, evidence) {
    const directory = path.dirname(storagePath);
    const temporary = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
    const file = {
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
    }
    finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}
function parseStoredEvidence(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("模型能力记录条目无效");
    const raw = value;
    const capabilityId = nonEmptyText(raw.capabilityId, "capabilityId", 200);
    const fingerprint = nonEmptyText(raw.fingerprint, "fingerprint", 32_768);
    const testedAt = nonEmptyText(raw.testedAt, "testedAt", 100);
    if (!Number.isFinite(Date.parse(testedAt)))
        throw new Error("模型能力记录测试时间无效");
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
function parseThinking(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("模型思考能力记录无效");
    const raw = value;
    if (!THINKING_STATUSES.has(raw.status))
        throw new Error("模型思考能力状态无效");
    if (!THINKING_SOURCES.has(raw.source))
        throw new Error("模型思考能力来源无效");
    if (!Array.isArray(raw.levels))
        throw new Error("模型思考档位记录无效");
    const rawLevels = raw.levels;
    const levels = MODEL_THINKING_LEVELS.filter((level) => rawLevels.includes(level));
    const recommendedLevel = MODEL_THINKING_LEVELS.includes(raw.recommendedLevel)
        ? raw.recommendedLevel
        : undefined;
    const levelMap = parseLevelMap(raw.levelMap);
    return {
        status: raw.status,
        levels,
        ...(recommendedLevel && levels.includes(recommendedLevel) ? { recommendedLevel } : {}),
        source: raw.source,
        message: nonEmptyText(raw.message, "thinking.message", 2_000),
        ...(levelMap ? { levelMap } : {}),
    };
}
function parseLevelMap(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("模型思考档位映射无效");
    const raw = value;
    const map = {};
    for (const level of MODEL_THINKING_LEVELS) {
        const mapped = raw[level];
        if (mapped === undefined)
            continue;
        if (mapped !== null && typeof mapped !== "string")
            throw new Error("模型思考档位映射无效");
        map[level] = mapped;
    }
    return map;
}
function cloneThinking(capability) {
    return {
        ...capability,
        levels: [...capability.levels],
        ...(capability.levelMap ? { levelMap: { ...capability.levelMap } } : {}),
    };
}
function nonEmptyText(value, name, limit) {
    if (typeof value !== "string" || !value || value.length > limit)
        throw new Error(`模型能力记录 ${name} 无效`);
    return value;
}
function isMissing(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
