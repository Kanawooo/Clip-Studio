import { randomUUID } from "node:crypto";
import path from "node:path";
import { MODEL_THINKING_LEVELS } from "../tasks/types.js";
import { loadModelCapabilityEvidence, saveModelCapabilityEvidence, } from "./model-capability-store.js";
export class ModelCapabilityRegistry {
    storagePath;
    entries = new Map();
    writeQueue = Promise.resolve();
    constructor(storagePath) {
        this.storagePath = storagePath;
    }
    static async open(projectRoot) {
        const storagePath = modelCapabilityStoragePath(projectRoot);
        const registry = new ModelCapabilityRegistry(storagePath);
        const evidence = await loadModelCapabilityEvidence(storagePath);
        for (const item of evidence)
            registry.entries.set(item.capabilityId, cloneEvidence(item));
        return registry;
    }
    record(config, status, thinkingOrNow, currentTime = Date.now()) {
        const now = typeof thinkingOrNow === "number" ? thinkingOrNow : currentTime;
        const thinking = typeof thinkingOrNow === "number" || thinkingOrNow === undefined
            ? unavailableThinkingCapability()
            : cloneThinkingCapability(thinkingOrNow);
        const testedAt = new Date(now).toISOString();
        const fingerprint = modelConfigFingerprint(config);
        for (const [capabilityId, current] of this.entries) {
            if (current.fingerprint === fingerprint)
                this.entries.delete(capabilityId);
        }
        const evidence = {
            capabilityId: randomUUID(),
            fingerprint,
            vision: status,
            testedAt,
            thinking,
        };
        this.entries.set(evidence.capabilityId, evidence);
        return evidence;
    }
    verify(capabilityId, config, _now) {
        const evidence = this.currentEvidence(capabilityId, config);
        if (evidence.vision === "inconclusive") {
            throw new ModelCapabilityError("当前模型的图片能力无法确认，请重新测试");
        }
        if (evidence.vision === "unsupported") {
            throw new ModelCapabilityError("当前模型不支持图片，无法用于视频任务");
        }
        const requested = config.thinkingLevel ?? "auto";
        if (requested !== "auto" && !evidence.thinking.levels.includes(requested)) {
            throw new ModelCapabilityError("当前思考强度未通过模型测试，请重新测试后选择可用档位");
        }
        return evidence;
    }
    configureThinking(capabilityId, config, requestedLevels, _now) {
        const evidence = this.currentEvidence(capabilityId, config);
        const requested = new Set(requestedLevels);
        const levels = MODEL_THINKING_LEVELS.filter((level) => requested.has(level));
        if (levels.length === 0) {
            throw new ModelCapabilityError("请至少选择一个确认可用的思考档位");
        }
        evidence.thinking = {
            status: "supported",
            levels,
            source: "manual",
            message: `已手动确认 ${levels.length} 个可用思考档位`,
        };
        this.entries.set(evidence.capabilityId, evidence);
        return evidence;
    }
    async persist() {
        if (!this.storagePath)
            return;
        const snapshot = [...this.entries.values()].map(cloneEvidence);
        const write = this.writeQueue.then(() => saveModelCapabilityEvidence(this.storagePath, snapshot));
        this.writeQueue = write.catch(() => undefined);
        await write;
    }
    currentEvidence(capabilityId, config) {
        if (!capabilityId)
            throw new ModelCapabilityError("请先测试主模型的图片理解能力");
        const evidence = this.entries.get(capabilityId);
        if (!evidence)
            throw new ModelCapabilityError("主模型测试记录不存在，请重新测试后再开始任务");
        if (evidence.fingerprint !== modelConfigFingerprint(config)) {
            throw new ModelCapabilityError("主模型设置已经改变，请重新测试后再开始任务");
        }
        return evidence;
    }
}
export function modelCapabilityStoragePath(projectRoot) {
    return path.join(projectRoot, ".runtime", "model-capabilities.json");
}
export class ModelCapabilityError extends Error {
    statusCode = 409;
}
export function modelConfigFingerprint(config) {
    return JSON.stringify([
        config.provider.trim().toLocaleLowerCase(),
        (config.baseUrl ?? "").trim().replace(/\/+$/, "").toLocaleLowerCase(),
        config.protocol ?? "",
        config.model.trim(),
    ]);
}
export function applyModelCapabilityEvidence(config, evidence) {
    return {
        ...config,
        input: evidence.vision === "supported" ? ["text", "image"] : ["text"],
        thinking: verifiedThinking(evidence.thinking),
    };
}
function verifiedThinking(capability) {
    const levels = capability.status === "supported" ? [...capability.levels] : [];
    const recommendedLevel = capability.status === "supported"
        ? capability.recommendedLevel
        : undefined;
    return {
        reasoning: capability.status === "supported" && levels.some((level) => level !== "off"),
        levels,
        ...(recommendedLevel ? { recommendedLevel } : {}),
        ...(capability.levelMap ? { levelMap: { ...capability.levelMap } } : {}),
    };
}
function unavailableThinkingCapability() {
    return {
        status: "unverified",
        levels: [],
        source: "unverified",
        message: "思考档位尚未确认",
    };
}
function cloneThinkingCapability(capability) {
    return {
        ...capability,
        levels: [...capability.levels],
        ...(capability.levelMap ? { levelMap: { ...capability.levelMap } } : {}),
    };
}
function cloneEvidence(evidence) {
    return {
        ...evidence,
        thinking: cloneThinkingCapability(evidence.thinking),
    };
}
