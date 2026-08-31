import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectRoot, "data");
const agentDir = path.join(dataDir, "pi");
async function main() {
    initializeEnvironment();
    console.log("[clip-studio] loading local service modules");
    const { createApp } = await import("./api/app.js");
    const { loadModelCatalog } = await import("./api/model-catalog.js");
    const { ModelCapabilityRegistry } = await import("./api/model-capabilities.js");
    await fs.mkdir(path.join(dataDir, "pi"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "tasks"), { recursive: true });
    const port = Number(process.env.PORT ?? 8787);
    const host = "127.0.0.1";
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PORT: ${process.env.PORT}`);
    }
    const modelCatalog = await loadModelCatalog(projectRoot, {
        allowDynamicFallback: process.env.PI_VIDEO_DEV === "1",
    });
    const modelCapabilities = await ModelCapabilityRegistry.open(projectRoot);
    const frontendBuildId = await readOptionalText(path.join(projectRoot, "web", "dist", "build-id.txt"));
    console.log(`[clip-studio] loaded ${modelCatalog.length} built-in models`);
    const { server, taskManager } = createApp({
        projectRoot,
        agentDir,
        startupId: process.env.PI_VIDEO_STARTUP_ID,
        frontendBuildId,
        modelCatalog,
        modelCapabilities,
    });
    server.listen(port, host, () => {
        console.log(`[clip-studio] listening on http://${host}:${port}`);
        console.log(`[clip-studio] projectRoot: ${projectRoot}`);
        console.log(`[clip-studio] agentDir: ${agentDir}`);
    });
    const shutdown = (signal) => {
        console.log(`[clip-studio] ${signal} received, shutting down`);
        server.close(() => {
            void taskManager.shutdown().finally(() => process.exit(0));
        });
        // Hard exit if graceful shutdown hangs.
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGBREAK", () => shutdown("SIGBREAK"));
}
async function readOptionalText(filePath) {
    try {
        return (await fs.readFile(filePath, "utf8")).trim() || undefined;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function initializeEnvironment() {
    if (process.platform !== "win32") {
        console.error("[clip-studio] This application currently supports Windows only.");
        process.exit(1);
    }
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
        console.error(`[clip-studio] Node.js >= 22.19.0 is required (found ${process.version}). Exiting.`);
        process.exit(1);
    }
    // Project-local HyperFrames first: Pi's native bash tool inherits this PATH,
    // so `hyperframes` and `npx hyperframes` resolve to node_modules/.bin.
    const binDir = path.join(projectRoot, "node_modules", ".bin");
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    if (process.env.PI_VIDEO_RUNTIME_VERIFIED !== "1") {
        const missing = ["ffmpeg", "ffprobe"].filter((command) => !commandOk(command));
        if (missing.length > 0) {
            for (const command of missing) {
                console.error(`[clip-studio] Required command not found on PATH: ${command}`);
            }
            console.error("[clip-studio] Install the missing tools and make sure they are on PATH before starting the backend.");
            process.exit(1);
        }
    }
    else {
        const whisperModelsDir = process.env.HYPERFRAMES_WHISPER_MODELS_DIR
            ?? path.join(projectRoot, ".runtime", "whisper", "models");
        const whisperModel = path.join(whisperModelsDir, "ggml-small.en.bin");
        if (!existsSync(whisperModel)) {
            throw new Error("Project Whisper model is missing; run install.bat before starting the verified runtime.");
        }
    }
}
function commandOk(command) {
    const result = spawnSync(command, ["-version"], { stdio: "ignore" });
    if (result.error)
        return false;
    return result.status === 0;
}
void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clip-studio] startup failed: ${message}`);
    process.exit(1);
});
