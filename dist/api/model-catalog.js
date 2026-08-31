import { promises as fs } from "node:fs";
import path from "node:path";
export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export async function loadModelCatalog(projectRoot, options = {}) {
    try {
        const artifact = await readModelCatalog(projectRoot);
        await validatePackageVersions(projectRoot, artifact);
        return artifact.models;
    }
    catch (error) {
        if (!options.allowDynamicFallback)
            throw error;
        console.warn(`[models] generated catalog unavailable in development: ${errorMessage(error)}`);
        const { listBuiltinModels } = await import("../pi/model.js");
        return sortModels(await listBuiltinModels());
    }
}
export async function readModelCatalog(projectRoot) {
    const filePath = path.join(projectRoot, "dist", "model-catalog.json");
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    catch (error) {
        throw new Error(`内置模型目录不可用，请重新构建项目：${errorMessage(error)}`);
    }
    if (!isArtifact(parsed)) {
        throw new Error("内置模型目录格式无效，请重新构建项目");
    }
    return parsed;
}
async function validatePackageVersions(projectRoot, artifact) {
    const [piAi, piCodingAgent] = await Promise.all([
        packageVersion(projectRoot, "@earendil-works", "pi-ai"),
        packageVersion(projectRoot, "@earendil-works", "pi-coding-agent"),
    ]);
    if (artifact.packages.piAi !== piAi || artifact.packages.piCodingAgent !== piCodingAgent) {
        throw new Error("内置模型目录与当前 Pi 版本不一致，请重新构建项目");
    }
}
async function packageVersion(projectRoot, scope, name) {
    const filePath = path.join(projectRoot, "node_modules", scope, name, "package.json");
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (typeof value.version !== "string" || !value.version) {
        throw new Error(`无法读取 ${scope}/${name} 版本`);
    }
    return value.version;
}
function isArtifact(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const artifact = value;
    return artifact.schemaVersion === MODEL_CATALOG_SCHEMA_VERSION
        && Boolean(artifact.packages)
        && typeof artifact.packages?.piAi === "string"
        && typeof artifact.packages?.piCodingAgent === "string"
        && Array.isArray(artifact.models)
        && artifact.models.length > 0
        && artifact.models.every(isCatalogItem);
}
function isCatalogItem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const item = value;
    return typeof item.provider === "string"
        && typeof item.providerName === "string"
        && typeof item.model === "string"
        && typeof item.name === "string"
        && typeof item.protocol === "string"
        && Array.isArray(item.input)
        && typeof item.contextWindow === "number"
        && Boolean(item.thinking);
}
function sortModels(models) {
    return [...models].sort((left, right) => (left.providerName.localeCompare(right.providerName)
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model)));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
