import path from "node:path";
import { createAgentSession, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createTaskModel } from "./model.js";
import { createProjectResourceLoader } from "./skills.js";
/** Native Pi tools. Video workflow tools deliberately remain outside the backend. */
export const NATIVE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Create exactly one native Pi Session for one video task. */
export async function createPiVideoSession(options) {
    const { modelRuntime, model, thinkingLevel } = await createTaskModel(options.model);
    const resourceLoader = await createProjectResourceLoader(options);
    const { skills } = resourceLoader.getSkills();
    const skillNames = new Set(skills.map((skill) => skill.name));
    if (!skillNames.has("clip-skills") || !skillNames.has("hyperframes")) {
        throw new Error("项目需要的 ClipSkills 或 HyperFrames skill 不可用。");
    }
    const sessionDir = options.sessionDir ?? path.join(options.workspace, ".pi-session");
    let session = null;
    try {
        ({ session } = await createAgentSession({
            cwd: options.workspace,
            agentDir: options.agentDir,
            modelRuntime,
            model,
            ...(thinkingLevel ? { thinkingLevel } : {}),
            resourceLoader,
            sessionManager: SessionManager.create(options.workspace, sessionDir),
            settingsManager: SettingsManager.inMemory({
                ...(process.env.PI_VIDEO_SHELL_PATH ? { shellPath: process.env.PI_VIDEO_SHELL_PATH } : {}),
                enableAnalytics: false,
                enableInstallTelemetry: false,
                compaction: { enabled: true, reserveTokens: 90_000, keepRecentTokens: 24_000 },
            }),
            tools: [...NATIVE_TOOL_NAMES],
        }));
        assertRequiredToolsActive(session, NATIVE_TOOL_NAMES);
    }
    catch (error) {
        session?.dispose();
        throw error;
    }
    return {
        session,
        resourceLoader,
        modelRuntime,
        skills,
        thinkingLevel: session.thinkingLevel,
        sessionFile: session.sessionManager.getSessionFile(),
        async dispose() {
            session.dispose();
        },
    };
}
function assertRequiredToolsActive(session, required) {
    const active = new Set(session.getActiveToolNames());
    const missing = required.filter((name) => !active.has(name));
    if (missing.length > 0)
        throw new Error(`Pi 原生工具不可用：${missing.join(", ")}`);
}
