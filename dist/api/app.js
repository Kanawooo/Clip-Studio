import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TaskManager } from "../tasks/manager.js";
import { handleDiscoverModels, handleListModels, handleSetThinkingCapability, handleTestModel } from "./models.js";
import { handleAbortTask, handleCreateTask, handleGetTask, handleListTasks, handleTaskEvents, sendJson, } from "./tasks.js";
import { handleStreamTaskOutput } from "./media.js";
import { handleDialogPick, handleReveal } from "./system.js";
import { serveStatic } from "./static.js";
import { ModelCapabilityRegistry } from "./model-capabilities.js";
import { handleGetLocalState, handlePutLocalDraft, handlePutLocalSettings, LocalStateStore, } from "./local-state.js";
export function createApp(options) {
    const taskManager = options.taskManager ??
        new TaskManager({ projectRoot: options.projectRoot, agentDir: options.agentDir });
    const distDir = options.distDir ?? path.join(options.projectRoot, "web", "dist");
    const modelCapabilities = options.modelCapabilities ?? new ModelCapabilityRegistry();
    const localState = options.localState ?? new LocalStateStore(options.projectRoot);
    const healthSnapshot = health(options.projectRoot, options.startupId, options.frontendBuildId);
    const server = createServer((req, res) => {
        if (!setLocalRequestHeaders(req, res))
            return;
        void route(req, res).catch((error) => {
            if (res.headersSent) {
                res.destroy(error instanceof Error ? error : undefined);
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        });
    });
    async function route(req, res) {
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = url.pathname;
        // API Routes
        if (req.method === "GET" && pathname === "/api/health") {
            sendJson(res, 200, healthSnapshot);
            return;
        }
        if (req.method === "GET" && pathname === "/api/local-state") {
            await handleGetLocalState(localState, res);
            return;
        }
        if (req.method === "PUT" && pathname === "/api/local-state/settings") {
            await handlePutLocalSettings(localState, req, res);
            return;
        }
        if (req.method === "PUT" && pathname === "/api/local-state/draft") {
            await handlePutLocalDraft(localState, req, res);
            return;
        }
        if (req.method === "GET" && pathname === "/api/models") {
            handleListModels(res, options.modelCatalog);
            return;
        }
        if (req.method === "POST" && pathname === "/api/models/test") {
            await handleTestModel(req, res, modelCapabilities, localState);
            return;
        }
        if (req.method === "POST" && pathname === "/api/models/discover") {
            await handleDiscoverModels(req, res, localState);
            return;
        }
        if (req.method === "PUT" && pathname === "/api/models/capability/thinking") {
            await handleSetThinkingCapability(req, res, modelCapabilities, localState);
            return;
        }
        if (req.method === "GET" && pathname === "/api/tasks") {
            handleListTasks(taskManager, res);
            return;
        }
        if (req.method === "POST" && pathname === "/api/tasks") {
            await handleCreateTask(taskManager, req, res, modelCapabilities, localState);
            return;
        }
        const outputContentMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/outputs\/(\d+)\/content$/);
        if (outputContentMatch && (req.method === "GET" || req.method === "HEAD")) {
            handleStreamTaskOutput(taskManager, decodeURIComponent(outputContentMatch[1]), decodeURIComponent(outputContentMatch[2]), req, res);
            return;
        }
        const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch && req.method === "GET") {
            handleGetTask(taskManager, decodeURIComponent(taskMatch[1]), res);
            return;
        }
        const abortMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/abort$/);
        if (abortMatch && req.method === "POST") {
            await handleAbortTask(taskManager, decodeURIComponent(abortMatch[1]), res);
            return;
        }
        const eventsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
        if (eventsMatch && req.method === "GET") {
            handleTaskEvents(taskManager, decodeURIComponent(eventsMatch[1]), req, res);
            return;
        }
        if (req.method === "POST" && pathname === "/api/system/reveal") {
            await handleReveal(taskManager, req, res);
            return;
        }
        if (req.method === "POST" && pathname === "/api/dialog/pick") {
            await handleDialogPick(req, res);
            return;
        }
        // Static SPA serve for non-API routes
        if (!pathname.startsWith("/api/")) {
            const served = serveStatic(distDir, req, res);
            if (served)
                return;
        }
        sendJson(res, 404, { error: `not found: ${req.method} ${pathname}` });
    }
    return { server, taskManager };
}
function health(projectRoot, startupId, frontendBuildId) {
    const piPackage = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    const hyperframesPackage = path.join(projectRoot, "node_modules", "hyperframes", "package.json");
    const hyperframesVersion = readJsonField(hyperframesPackage, "version") ?? null;
    const piVersion = readJsonField(piPackage, "version") ?? null;
    const status = piVersion && hyperframesVersion
        ? "ok"
        : "degraded";
    return {
        status,
        startupId: startupId ?? null,
        frontendBuildId: frontendBuildId ?? null,
        node: {
            version: process.version,
            ok: true,
        },
        // The backend validates both commands before it creates the HTTP server.
        ffmpeg: { ok: true },
        ffprobe: { ok: true },
        pi: {
            name: "@earendil-works/pi-coding-agent",
            version: piVersion,
            resolvedFrom: piPackage,
        },
        hyperframes: {
            name: "hyperframes",
            version: hyperframesVersion,
        },
        projectRoot,
    };
}
function readJsonField(filePath, field) {
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        const value = parsed[field];
        return typeof value === "string" ? value : null;
    }
    catch {
        return null;
    }
}
function setLocalRequestHeaders(req, res) {
    const host = req.headers.host?.split(":")[0]?.toLowerCase();
    if (host && host !== "127.0.0.1" && host !== "localhost") {
        sendJson(res, 403, { error: "local requests only" });
        return false;
    }
    const origin = req.headers.origin;
    if (origin) {
        let hostname;
        try {
            hostname = new URL(origin).hostname.toLowerCase();
        }
        catch {
            sendJson(res, 403, { error: "invalid origin" });
            return false;
        }
        if (hostname !== "127.0.0.1" && hostname !== "localhost") {
            sendJson(res, 403, { error: "local origin required" });
            return false;
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");
    return true;
}
