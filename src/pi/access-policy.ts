import path from "node:path";
import type { InlineExtension, ToolCallEvent } from "@earendil-works/pi-coding-agent";

interface TaskAccessPolicyOptions {
  projectRoot: string;
  workspace: string;
}

export function createTaskAccessPolicy(options: TaskAccessPolicyOptions): InlineExtension {
  const blockedRoots = [
    "node_modules",
    "src",
    "tests",
    "scripts",
    "dist",
    path.join("web", "src"),
  ].map((entry) => path.resolve(options.projectRoot, entry));
  const workspace = path.resolve(options.workspace);

  return {
    name: "task-access-policy",
    hidden: true,
    factory: (pi) => {
      let blockedCalls = 0;
      pi.on("tool_call", (event) => {
        if (!blocksApplicationInternals(event, workspace, blockedRoots, options.projectRoot)) return undefined;
        blockedCalls += 1;
        return {
          block: true,
          reason: "当前任务不能读取工作台或依赖实现源码，请使用技能文档和公开命令帮助。",
          terminate: blockedCalls >= 3,
        };
      });
    },
  };
}

function blocksApplicationInternals(
  event: ToolCallEvent,
  workspace: string,
  blockedRoots: string[],
  projectRoot: string,
): boolean {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") {
    const command = typeof input.command === "string" ? normalize(input.command.replace(/["']/g, "")) : "";
    if (!command) return false;
    if (/(^|[\\/])node_modules([\\/]|$)/i.test(command)) return true;
    return blockedRoots.some((root) => command.includes(normalize(root)))
      || escapedSourcePath(command, projectRoot);
  }

  const candidate = toolPath(input);
  if (!candidate) return false;
  const resolved = path.resolve(workspace, candidate);
  if (isInsideOrEqual(workspace, resolved)) return false;
  return blockedRoots.some((root) => isInsideOrEqual(root, resolved));
}

function escapedSourcePath(command: string, projectRoot: string): boolean {
  if (!command.includes("..")) return false;
  const projectName = normalize(path.basename(projectRoot));
  return command.includes(projectName)
    || /(?:\.\.[\\/])+(?:src|tests|scripts|dist)(?:[\\/]|\s|$)/i.test(command);
}

function toolPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
