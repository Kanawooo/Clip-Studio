import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
  InlineExtension,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export interface TaskAccessPolicyOptions {
  projectRoot: string;
  workspace: string;
  outputDir: string;
  onTermination?: (reason: string) => void;
}

interface TaskAccessBoundary {
  workspace: string;
  workspaceReal: string;
  outputDir: string;
  blockedReadRoots: string[];
  mediaCacheScript: string;
  renderQueueScript: string;
}

interface ShellToken {
  kind: "word" | "operator";
  value: string;
}

const READ_BLOCK_REASON = "当前任务不能读取程序或依赖实现源码，请使用技能文档和公开命令帮助。";
const WRITE_BLOCK_REASON = "当前任务只能在任务工作目录内创建或修改文件；成片请使用渲染队列输出。";
const OPAQUE_BLOCK_REASON = "当前命令无法确认写入范围，请改用路径明确的公开命令。";
const OUTPUT_FLAGS = new Set([
  "-o", "--out", "--out-dir", "--output", "--output-dir", "--destination", "--dest", "--target-directory",
]);
const PACKAGE_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pip", "pip3", "uv"]);
const FILE_MUTATION_COMMANDS = new Set([
  "rm", "unlink", "rmdir", "mkdir", "touch", "truncate", "chmod", "chown",
  "del", "erase", "md", "rd", "ren", "rename",
]);

export function createTaskAccessPolicy(options: TaskAccessPolicyOptions): InlineExtension {
  const handler = createTaskAccessHandler(options);
  return {
    name: "task-access-policy",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", handler);
    },
  };
}

/** Stateful handler exported for deterministic policy tests. */
export function createTaskAccessHandler(
  options: TaskAccessPolicyOptions,
): (event: ToolCallEvent) => ToolCallEventResult | undefined {
  const boundary = createBoundary(options);
  let blockedCalls = 0;
  return (event) => {
    const reason = taskAccessViolation(event, boundary);
    if (!reason) {
      blockedCalls = 0;
      return undefined;
    }
    blockedCalls += 1;
    if (blockedCalls >= 3) options.onTermination?.(reason);
    return { block: true, reason, terminate: blockedCalls >= 3 };
  };
}

function createBoundary(options: TaskAccessPolicyOptions): TaskAccessBoundary {
  const projectRoot = path.resolve(options.projectRoot);
  const workspace = path.resolve(options.workspace);
  return {
    workspace,
    workspaceReal: realpathSync.native(workspace),
    outputDir: path.resolve(options.outputDir),
    blockedReadRoots: [
      "node_modules",
      "src",
      "tests",
      "scripts",
      "dist",
      path.join("web", "src"),
    ].map((entry) => path.resolve(projectRoot, entry)),
    mediaCacheScript: path.resolve(projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs"),
    renderQueueScript: path.resolve(projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs"),
  };
}

function taskAccessViolation(event: ToolCallEvent, boundary: TaskAccessBoundary): string | undefined {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return bashAccessViolation(command, boundary);
  }

  const candidate = toolPath(input);
  if (event.toolName === "write" || event.toolName === "edit") {
    if (!candidate) return WRITE_BLOCK_REASON;
    const resolved = path.resolve(boundary.workspace, candidate);
    return isSafeWorkspaceTarget(resolved, boundary) ? undefined : WRITE_BLOCK_REASON;
  }

  if (!candidate) return undefined;
  const resolved = path.resolve(boundary.workspace, candidate);
  if (isInsideOrEqual(boundary.workspace, resolved)) return undefined;
  return boundary.blockedReadRoots.some((root) => isInsideOrEqual(root, resolved))
    ? READ_BLOCK_REASON
    : undefined;
}

function bashAccessViolation(command: string, boundary: TaskAccessBoundary): string | undefined {
  if (!command.trim()) return undefined;
  const tokens = tokenizeShell(command);
  if (!tokens || hasOpaqueShellSyntax(command)) return OPAQUE_BLOCK_REASON;

  let cwd = boundary.workspace;
  let segment: string[] = [];
  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || (token.kind === "operator" && isControlOperator(token.value))) {
      if (segment.length > 0) {
        const result = inspectCommandSegment(segment, cwd, boundary);
        if (result.reason) return result.reason;
        cwd = result.cwd;
        segment = [];
      }
      continue;
    }
    if (token.kind === "operator" && isRedirection(token.value)) {
      const target = tokens[index + 1];
      if (!target || target.kind !== "word") return OPAQUE_BLOCK_REASON;
      if (!isFileDescriptor(target.value)) {
        const reason = token.value.includes(">")
          ? validateWriteTarget(target.value, cwd, boundary)
          : validateReadTarget(target.value, cwd, boundary);
        if (reason) return reason;
      }
      index += 1;
      continue;
    }
    segment.push(token.value);
  }
  return undefined;
}

function inspectCommandSegment(
  words: string[],
  cwd: string,
  boundary: TaskAccessBoundary,
): { cwd: string; reason?: string } {
  const commandIndex = words.findIndex((word) => !isEnvironmentAssignment(word));
  if (commandIndex < 0) return { cwd };
  const commandWord = words[commandIndex]!;
  const command = executableName(commandWord);
  const args = words.slice(commandIndex + 1);

  const protectedReason = explicitProtectedPath(words, cwd, boundary);
  if (protectedReason) return { cwd, reason: protectedReason };

  if (["env", "command"].includes(command)) {
    const nestedIndex = args.findIndex((arg) => !arg.startsWith("-") && !isEnvironmentAssignment(arg));
    return nestedIndex < 0
      ? { cwd, reason: OPAQUE_BLOCK_REASON }
      : inspectCommandSegment(args.slice(nestedIndex), cwd, boundary);
  }

  if (["if", "then", "fi", "for", "while", "until", "case", "select", "do", "done", "function"].includes(command)) {
    return { cwd, reason: OPAQUE_BLOCK_REASON };
  }

  if (command === "cd") {
    const target = args.find((arg) => !arg.startsWith("-"));
    if (!target || containsDynamicPath(target)) return { cwd, reason: OPAQUE_BLOCK_REASON };
    const resolved = path.resolve(cwd, target);
    return isInsideOrEqual(boundary.workspace, resolved)
      ? { cwd: resolved }
      : { cwd, reason: WRITE_BLOCK_REASON };
  }

  if (isInlineInterpreter(command, args)) {
    const source = inlineSource(args);
    if (!source || args.some((arg) => arg.toLowerCase() === "-encodedcommand") || inlineCodeMayMutate(source)) {
      return { cwd, reason: OPAQUE_BLOCK_REASON };
    }
  }

  if (isPackageMutation(command, args) || isGitMutation(command, args)) {
    return { cwd, reason: WRITE_BLOCK_REASON };
  }

  const scriptReason = validateTrustedNodeScript(command, args, cwd, boundary);
  if (scriptReason) return { cwd, reason: scriptReason };

  const outputReason = validateOutputFlags(args, cwd, boundary, command, words);
  if (outputReason) return { cwd, reason: outputReason };

  if (command === "ffmpeg") {
    const reason = validateFfmpegOutputs(args, cwd, boundary);
    if (reason) return { cwd, reason };
  }

  const mutationTargets = fileMutationTargets(command, args);
  for (const target of mutationTargets) {
    const reason = validateWriteTarget(target, cwd, boundary);
    if (reason) return { cwd, reason };
  }

  return { cwd };
}

function validateTrustedNodeScript(
  command: string,
  args: string[],
  cwd: string,
  boundary: TaskAccessBoundary,
): string | undefined {
  if (command !== "node") return undefined;
  const script = args.find((arg) => !arg.startsWith("-"));
  if (!script || script === "-") return undefined;
  const resolved = path.resolve(cwd, script);
  if (samePath(resolved, boundary.mediaCacheScript)) {
    const subcommand = args[args.indexOf(script) + 1]?.toLowerCase();
    if (["index", "detail", "window", "resheet"].includes(subcommand ?? "")) {
      return validateExactFlagPath(args, "--workspace", boundary.workspace, cwd);
    }
    return undefined;
  }
  if (samePath(resolved, boundary.renderQueueScript)) {
    if (args[args.indexOf(script) + 1]?.toLowerCase() !== "run") return OPAQUE_BLOCK_REASON;
    return validateExactFlagPath(args, "--workspace", boundary.workspace, cwd)
      ?? validateExactFlagPath(args, "--output-dir", boundary.outputDir, cwd)
      ?? validateContainedFlagPath(args, "--manifest", boundary.workspace, cwd);
  }
  return undefined;
}

function validateExactFlagPath(
  args: string[],
  flag: string,
  expected: string,
  cwd: string,
): string | undefined {
  const value = flagValue(args, flag);
  if (!value || containsDynamicPath(value) || !samePath(path.resolve(cwd, value), expected)) {
    return WRITE_BLOCK_REASON;
  }
  return undefined;
}

function validateContainedFlagPath(
  args: string[],
  flag: string,
  root: string,
  cwd: string,
): string | undefined {
  const value = flagValue(args, flag);
  if (!value || containsDynamicPath(value) || !isInsideOrEqual(root, path.resolve(cwd, value))) {
    return WRITE_BLOCK_REASON;
  }
  return undefined;
}

function validateOutputFlags(
  args: string[],
  cwd: string,
  boundary: TaskAccessBoundary,
  command: string,
  words: string[],
): string | undefined {
  const isRenderQueue = command === "node"
    && words.some((word) => samePath(path.resolve(cwd, word), boundary.renderQueueScript));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equalsAt = arg.indexOf("=");
    const flag = equalsAt >= 0 ? arg.slice(0, equalsAt).toLowerCase() : arg.toLowerCase();
    if (!OUTPUT_FLAGS.has(flag)) continue;
    const value = equalsAt >= 0 ? arg.slice(equalsAt + 1) : args[index + 1];
    if (!value) return OPAQUE_BLOCK_REASON;
    if (isRenderQueue && flag === "--output-dir") continue;
    const reason = validateWriteTarget(value, cwd, boundary);
    if (reason) return reason;
    if (equalsAt < 0) index += 1;
  }
  return undefined;
}

function validateFfmpegOutputs(args: string[], cwd: string, boundary: TaskAccessBoundary): string | undefined {
  const inputs = new Set<number>();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (["-i", "-filter_script", "-filter_complex_script"].includes(args[index] ?? "")) inputs.add(index + 1);
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (inputs.has(index) || arg.startsWith("-") || !looksLikeStandaloneOutput(arg)) continue;
    const reason = validateWriteTarget(arg, cwd, boundary);
    if (reason) return reason;
  }
  return undefined;
}

function fileMutationTargets(command: string, args: string[]): string[] {
  const positional = args.filter((arg) => !arg.startsWith("-") && !isFileDescriptor(arg));
  if (FILE_MUTATION_COMMANDS.has(command)) return positional;
  if (command === "ln") return positional;
  if (["cp", "copy", "mv", "move", "install"].includes(command)) {
    const targetFlag = flagValue(args, "-t") ?? flagValue(args, "--target-directory");
    return targetFlag ? [targetFlag] : positional.slice(-1);
  }
  if (command === "tee") return positional;
  if (command === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))) return positional.slice(-1);
  if (command === "perl" && args.some((arg) => /^-.*i/.test(arg))) return positional;
  return [];
}

function validateWriteTarget(value: string, cwd: string, boundary: TaskAccessBoundary): string | undefined {
  if (isNullDevice(value)) return undefined;
  if (containsDynamicPath(value)) return OPAQUE_BLOCK_REASON;
  return isSafeWorkspaceTarget(path.resolve(cwd, value), boundary) ? undefined : WRITE_BLOCK_REASON;
}

function validateReadTarget(value: string, cwd: string, boundary: TaskAccessBoundary): string | undefined {
  if (isNullDevice(value)) return undefined;
  if (containsDynamicPath(value)) return OPAQUE_BLOCK_REASON;
  const resolved = path.resolve(cwd, value);
  return boundary.blockedReadRoots.some((root) => isInsideOrEqual(root, resolved))
    ? READ_BLOCK_REASON
    : undefined;
}

function explicitProtectedPath(words: string[], cwd: string, boundary: TaskAccessBoundary): string | undefined {
  for (const word of words) {
    for (const candidate of pathCandidates(word)) {
      if (containsDynamicPath(candidate)) continue;
      const resolved = path.resolve(cwd, candidate);
      if (boundary.blockedReadRoots.some((root) => isInsideOrEqual(root, resolved))) return READ_BLOCK_REASON;
    }
    if (/(?:^|[\\/])\.\.[\\/](?:\.\.[\\/])*(?:src|tests|scripts|dist|node_modules)(?:[\\/]|$)/i.test(word)) {
      return READ_BLOCK_REASON;
    }
  }
  return undefined;
}

function pathCandidates(word: string): string[] {
  const candidates = [word];
  const equalsAt = word.indexOf("=");
  if (equalsAt >= 0 && equalsAt < word.length - 1) candidates.push(word.slice(equalsAt + 1));
  return candidates.filter((value) => value.startsWith(".") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
}

function tokenizeShell(command: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "'" | "\"" | undefined;
  const flush = () => {
    if (!word) return;
    tokens.push({ kind: "word", value: word });
    word = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && command[index + 1] === "\"") {
        word += "\"";
        index += 1;
      } else word += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n" || char === "\r") tokens.push({ kind: "operator", value: ";" });
      continue;
    }
    if (char === ";" || char === "|") {
      flush();
      const doubled = command[index + 1] === char;
      tokens.push({ kind: "operator", value: doubled ? char + char : char });
      if (doubled) index += 1;
      continue;
    }
    if (char === "&") {
      flush();
      let operator = char;
      if (command[index + 1] === "&" || command[index + 1] === ">") {
        operator += command[index + 1];
        index += 1;
      }
      if (operator === "&>" && command[index + 1] === ">") {
        operator += ">";
        index += 1;
      }
      tokens.push({ kind: "operator", value: operator });
      continue;
    }
    if (char === ">" || char === "<") {
      let descriptor = "";
      if (/^\d$/.test(word)) {
        descriptor = word;
        word = "";
      } else flush();
      let operator = descriptor + char;
      if (command[index + 1] === char) {
        operator += char;
        index += 1;
      }
      tokens.push({ kind: "operator", value: operator });
      continue;
    }
    word += char;
  }
  if (quote) return undefined;
  flush();
  return tokens;
}

function isControlOperator(value: string): boolean {
  return value === ";" || value === "|" || value === "||" || value === "&" || value === "&&";
}

function isRedirection(value: string): boolean {
  return /^(?:\d|&)?(?:>|>>|<|<<)$/.test(value);
}

function hasOpaqueShellSyntax(command: string): boolean {
  return /<\(|>\(|\beval\b|(?:^|[;&|]\s*)[({]|\w+\s*\(\)\s*\{/.test(command);
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function executableName(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function isInlineInterpreter(command: string, args: string[]): boolean {
  if (command === "node") return args.includes("-e") || args.includes("--eval");
  if (["python", "python3", "py", "perl", "ruby"].includes(command)) return args.includes("-c") || args.includes("-e");
  if (["powershell", "pwsh"].includes(command)) return args.some((arg) => ["-c", "-command", "-encodedcommand"].includes(arg.toLowerCase()));
  if (["bash", "sh", "cmd"].includes(command)) return args.some((arg) => ["-c", "/c"].includes(arg.toLowerCase()));
  return false;
}

function inlineSource(args: string[]): string | undefined {
  const index = args.findIndex((arg) => ["-e", "--eval", "-c", "/c", "-command", "-encodedcommand"].includes(arg.toLowerCase()));
  return index >= 0 ? args[index + 1] : undefined;
}

function inlineCodeMayMutate(source: string): boolean {
  return /\b(?:writeFile|appendFile|rename|unlink|remove|replace|rm|rmdir|mkdir|copyFile|link|symlink|chmod|chown|truncate)(?:Sync)?\b|\bcreateWriteStream\b|\b(?:spawn|exec|execFile|system|popen|mklink|del|erase|copy|move|ren)\b|\bopen\s*\([^)]*["'](?:w|a|x)\b|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b/i.test(source);
}

function isPackageMutation(command: string, args: string[]): boolean {
  if (!PACKAGE_COMMANDS.has(command)) return false;
  const action = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  return action === "install" || action === "add" || action === "remove" || action === "uninstall"
    || action === "update" || action === "upgrade" || action === "link" || action === "exec";
}

function isGitMutation(command: string, args: string[]): boolean {
  if (command !== "git") return false;
  const action = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  return Boolean(action && !["--version", "status", "log", "show", "diff", "rev-parse"].includes(action));
}

function flagValue(args: string[], flag: string): string | undefined {
  const exact = args.indexOf(flag);
  if (exact >= 0) return args[exact + 1];
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function looksLikeStandaloneOutput(value: string): boolean {
  if (value === "-" || value.includes("=")) return false;
  return /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9%]{1,8}$/.test(value) || /^[^\\/]+\.[A-Za-z0-9%]{1,8}$/.test(value);
}

function containsDynamicPath(value: string): boolean {
  return /\x60|\$\(|\$\{|\$[A-Za-z_]|\x00/.test(value);
}

function isFileDescriptor(value: string): boolean {
  return /^&?\d+$/.test(value) || value === "-";
}

function isNullDevice(value: string): boolean {
  return /^(?:\/dev\/null|nul)$/i.test(value);
}

function toolPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function isSafeWorkspaceTarget(candidate: string, boundary: TaskAccessBoundary): boolean {
  if (!isInsideOrEqual(boundary.workspace, candidate)) return false;
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    return isInsideOrEqual(boundary.workspaceReal, realpathSync.native(existing));
  } catch {
    return false;
  }
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
