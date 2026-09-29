import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { InlineExtension, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  effectivePath, pathInside, resolveTaskPaths, sameFilePath,
  type TaskPathOptions, type TaskPaths,
} from "./task-paths.js";

export interface TaskAccessPolicyOptions extends TaskPathOptions {
  onTermination?: (reason: string) => void;
}

interface Boundary extends TaskPaths {
  mediaCacheScript: string;
  renderQueueScript: string;
  hyperframesScript: string;
  audioDataScript: string;
}

interface Token { kind: "word" | "operator"; value: string }
interface Segment { words: string[]; redirects: Array<{ operator: string; target: string }> }

const READ_BLOCK = "该路径不属于当前任务可读范围。请读取本任务工作目录、四个已选路径或项目本地技能文档；缓存图片由素材索引复制到工作目录。";
const WRITE_BLOCK = "写入目标不在当前任务工作目录。请将工程和中间文件写入任务工作目录；最终成片由渲染队列写入指定输出目录。";
const COMMAND_BLOCK = "无法确认该命令的访问范围。请使用 Pi 原生文件工具，或直接调用已安装的 FFmpeg/FFprobe、素材索引及 HyperFrames CLI；脚本必须使用已核对的本地绝对入口。";
const SETUP_BLOCK = "视频任务不安装、更新、认证或发布。请使用已安装的剪辑组件；缺失时报告实际错误。";
const HYPERFRAMES_COMMANDS = new Set(["lint", "check", "beats", "transcribe", "keyframes", "compositions", "info", "catalog"]);
const READ_COMMANDS = new Set(["ls", "dir", "rg", "grep", "find", "cat", "type", "head", "tail", "stat", "wc", "pwd"]);
const MUTATION_COMMANDS = new Set(["mkdir", "md", "touch", "rm", "del", "erase", "rmdir", "rd", "cp", "copy", "mv", "move"]);
const OUTPUT_FLAGS = new Set(["-o", "--out", "--output", "--out-dir", "--output-dir", "--dest", "--destination"]);
const MEDIA_EXTENSIONS = /\.(?:mp4|mov|mkv|webm|avi|m4v|mp3|m4a|wav|aac|flac|ogg|srt|vtt|json|jpg|jpeg|png|webp|cube|txt|html)$/i;
const SKILL_READ_EXTENSIONS = new Set([".md", ".txt", ".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const SINGLE_USE_FLAGS = new Set(["--workspace", "--output-dir", "--manifest", "--reference", "--assets", "--audio", "--file", "--text-file", "--textFile", "--project", "--dir", "-d", "--output", "-o", "--out"]);
const ALIAS_GROUPS = [["--project", "--dir", "-d"], ["--output", "--out", "-o"], ["--text-file", "--textFile"]];

export function createTaskAccessPolicy(options: TaskAccessPolicyOptions): InlineExtension {
  const handler = createTaskAccessHandler(options);
  return { name: "task-access-policy", hidden: true, factory: (pi) => { pi.on("tool_call", handler); } };
}

/** Stateful handler exported for deterministic, command-free policy tests. */
export function createTaskAccessHandler(options: TaskAccessPolicyOptions): (event: ToolCallEvent) => ToolCallEventResult | undefined {
  const paths = resolveTaskPaths(options);
  const boundary: Boundary = {
    ...paths,
    mediaCacheScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs")),
    renderQueueScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs")),
    hyperframesScript: effectivePath(path.join(paths.projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs")),
    audioDataScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-creative", "scripts", "extract-audio-data.py")),
  };
  let repeated: { key: string; count: number } | undefined;
  return (event) => {
    const reason = violation(event, boundary);
    if (!reason) { repeated = undefined; return undefined; }
    const key = `${event.toolName}\n${reason}\n${JSON.stringify(event.input)}`;
    repeated = repeated?.key === key ? { key, count: repeated.count + 1 } : { key, count: 1 };
    const terminate = repeated.count >= 3;
    if (terminate) options.onTermination?.(`${reason} 同一违规操作已连续重复 3 次。`);
    return {
      block: true,
      reason: repeated.count === 2 ? `${reason} 同一操作再次被拦截；请换用上述方式，继续重复会停止任务。` : reason,
      terminate,
    };
  };
}

function violation(event: ToolCallEvent, boundary: Boundary): string | undefined {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") return bashViolation(typeof input.command === "string" ? input.command : "", boundary);
  const candidate = toolPath(input);
  if (event.toolName === "write" || event.toolName === "edit") {
    return candidate && writable(candidate, boundary.workspace, boundary) ? undefined : WRITE_BLOCK;
  }
  if (["read", "grep", "find", "ls"].includes(event.toolName)) {
    return !candidate || readable(candidate, boundary.workspace, boundary) ? undefined : READ_BLOCK;
  }
  return undefined;
}

function readable(value: string, cwd: string, boundary: Boundary): boolean {
  if (dynamic(value) || protocol(value)) return false;
  try {
    const resolved = path.resolve(cwd, value);
    const actual = effectivePath(resolved);
    if ([boundary.workspace, boundary.referenceVideo, boundary.assetsDir, boundary.audioDir, boundary.outputDir]
      .some((root) => pathInside(root, actual))) return true;
    return boundary.skillRoots.some((root) => {
      if (!pathInside(root, resolved) || !pathInside(root, actual)) return false;
      const relative = path.relative(root, actual).replace(/\\/g, "/").toLowerCase();
      if (/(^|\/)(scripts?|tests?|fixtures?|node_modules|\.git)(\/|$)/.test(relative)) return false;
      if (!existsSync(resolved)) return false;
      const stat = statSync(resolved);
      return stat.isDirectory() || SKILL_READ_EXTENSIONS.has(path.extname(actual).toLowerCase());
    });
  } catch { return false; }
}

function writable(value: string, cwd: string, boundary: Boundary): boolean {
  if (dynamic(value) || protocol(value)) return false;
  try {
    const resolved = path.resolve(cwd, value);
    return pathInside(boundary.workspace, resolved) && pathInside(boundary.workspace, effectivePath(resolved));
  } catch { return false; }
}

function bashViolation(command: string, boundary: Boundary): string | undefined {
  if (!command.trim()) return COMMAND_BLOCK;
  if (/[`\x00]|\$\(|\$\{|\$[A-Za-z0-9_@*?]|<\(|>\(|\\\r?\n/.test(command)) return COMMAND_BLOCK;
  const tokens = tokenize(command);
  if (!tokens) return COMMAND_BLOCK;
  let cwd = boundary.workspace;
  let remaining = tokens;
  const firstAnd = tokens.findIndex((item) => item.kind === "operator" && item.value === "&&");
  if (firstAnd >= 0) {
    const cd = parseSegment(tokens.slice(0, firstAnd));
    if (!cd || cd.redirects.length || cd.words.length !== 2 || cd.words[0]?.toLowerCase() !== "cd") return COMMAND_BLOCK;
    const target = path.resolve(cwd, cd.words[1]!);
    if (!readable(target, cwd, boundary) || !existsSync(target) || !statSync(target).isDirectory()) return READ_BLOCK;
    cwd = effectivePath(target);
    remaining = tokens.slice(firstAnd + 1);
  }
  if (remaining.some((item) => item.kind === "operator" && [";", "&&", "||", "&", "<<", "&>"].includes(item.value))) return COMMAND_BLOCK;
  const pipe = remaining.findIndex((item) => item.kind === "operator" && item.value === "|");
  const left = parseSegment(pipe < 0 ? remaining : remaining.slice(0, pipe));
  if (!left || !left.words.length) return COMMAND_BLOCK;
  const reason = inspectSegment(left, cwd, boundary);
  if (reason) return reason;
  if (pipe < 0) return undefined;
  if (remaining.slice(pipe + 1).some((item) => item.kind === "operator" && item.value === "|")) return COMMAND_BLOCK;
  const right = parseSegment(remaining.slice(pipe + 1));
  if (!right || right.redirects.length || !READ_COMMANDS.has(executable(left.words[0]!))
    && !["ffmpeg", "ffprobe"].includes(executable(left.words[0]!))) return COMMAND_BLOCK;
  if (!right.words.length || !["grep", "rg", "head", "tail", "wc"].includes(executable(right.words[0]!))) return COMMAND_BLOCK;
  if (left.redirects.some((item) => item.operator !== "2>&1")) return COMMAND_BLOCK;
  return inspectReadCommand(right.words.slice(1), cwd, boundary, true);
}

function inspectSegment(segment: Segment, cwd: string, boundary: Boundary): string | undefined {
  for (const { operator, target } of segment.redirects) {
    if (operator === "2>&1") continue;
    if (operator.includes("<")) {
      if (!readable(target, cwd, boundary)) return READ_BLOCK;
    } else if (!nullDevice(target) && !writable(target, cwd, boundary)) return WRITE_BLOCK;
  }
  let [program, ...args] = segment.words;
  if (!program) return COMMAND_BLOCK;
  const skipSkillChecks = program === "HYPERFRAMES_SKIP_SKILLS=1";
  if (skipSkillChecks) {
    [program, ...args] = args;
    if (executable(program ?? "") !== "node") return COMMAND_BLOCK;
  }
  const seenFlags = new Set<string>();
  for (const arg of args) {
    const flag = arg.split("=", 1)[0]!;
    if (!SINGLE_USE_FLAGS.has(flag)) continue;
    if (seenFlags.has(flag)) return COMMAND_BLOCK;
    seenFlags.add(flag);
  }
  if (ALIAS_GROUPS.some((group) => group.filter((flag) => seenFlags.has(flag)).length > 1)) return COMMAND_BLOCK;
  const name = executable(program);
  if (!pathInside(boundary.workspace, cwd) && !READ_COMMANDS.has(name) && name !== "ffprobe") {
    return "当前目录是只读媒体目录。请切回任务工作目录运行 FFmpeg 或本地技能 CLI，并传入媒体绝对路径。";
  }
  if (path.isAbsolute(program) && !["ffmpeg", "ffprobe", "node", "python", "python3", "py", "hyperframes"]
    .some((allowed) => name === allowed && trustedExecutable(program, allowed, boundary))) return COMMAND_BLOCK;
  if (READ_COMMANDS.has(name)) return inspectReadCommand(args, cwd, boundary);
  if (name === "ffprobe") return inspectFfprobe(args, cwd, boundary);
  if (name === "ffmpeg") return inspectFfmpeg(args, cwd, boundary);
  if (name === "node") return inspectNode(args, cwd, boundary, skipSkillChecks);
  if (skipSkillChecks) return COMMAND_BLOCK;
  if (["python", "python3", "py"].includes(name)) return inspectPython(args, cwd, boundary);
  if (name === "hyperframes") return inspectHyperframes(args, cwd, boundary);
  if (name === "npx") {
    const rest = args[0] === "--no-install" ? args.slice(1) : args;
    return rest[0] === "hyperframes" ? inspectHyperframes(rest.slice(1), cwd, boundary) : SETUP_BLOCK;
  }
  if (MUTATION_COMMANDS.has(name)) return inspectMutation(name, args, cwd, boundary);
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "git"].includes(name)) return SETUP_BLOCK;
  return COMMAND_BLOCK;
}

function trustedExecutable(program: string, name: string, boundary: Boundary): boolean {
  const configured = name === "ffmpeg" ? process.env.HYPERFRAMES_FFMPEG_PATH
    : name === "ffprobe" ? process.env.HYPERFRAMES_FFPROBE_PATH
      : name === "node" ? process.execPath : undefined;
  if (configured && sameFilePath(effectivePath(program), effectivePath(configured))) return true;
  if (name === "hyperframes") return sameFilePath(effectivePath(program), effectivePath(path.join(boundary.projectRoot, "node_modules", ".bin", "hyperframes.cmd")));
  return false;
}

function inspectReadCommand(args: string[], cwd: string, boundary: Boundary, pipeTail = false): string | undefined {
  if (args.some((arg) => /^(?:--pre(?:=|$)|-exec(?:dir)?$|-ok(?:dir)?$|-delete$|-f$|--file$|--files-from$)/i.test(arg))) return COMMAND_BLOCK;
  if (pipeTail) return args.some((arg) => !arg.startsWith("-") && (looksPath(arg, cwd) || arg.includes("/"))) ? COMMAND_BLOCK : undefined;
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "-" || arg === ".") continue;
    if (looksPath(arg, cwd) && !readable(arg, cwd, boundary)) return READ_BLOCK;
  }
  return undefined;
}

function inspectFfprobe(args: string[], cwd: string, boundary: Boundary): string | undefined {
  if (args.includes("-show_private_data") || args.includes("-f") || args.includes("-protocol_whitelist")) return COMMAND_BLOCK;
  const output = flagValue(args, "-o") ?? flagValue(args, "--output");
  if (output && !writable(output, cwd, boundary)) return WRITE_BLOCK;
  const input = flagValue(args, "-i");
  if (input && !readable(input, cwd, boundary)) return READ_BLOCK;
  for (const arg of args) {
    if (arg.startsWith("-") || arg === output || arg === input || arg.includes("=")) continue;
    if (looksPath(arg, cwd) && !readable(arg, cwd, boundary)) return READ_BLOCK;
  }
  return undefined;
}

function inspectFfmpeg(args: string[], cwd: string, boundary: Boundary): string | undefined {
  if (args.some((arg) => /(?:^|[,;])(?:a?movie|subtitles|fontfile|textfile|lut3d)=/i.test(arg)
    || /^(?:https?|rtsp|rtmp|ftp|udp|tcp|file|concat|crypto|pipe):/i.test(arg))) return COMMAND_BLOCK;
  if (args.some((arg, index) => arg === "-f" && ["tee", "hls", "dash"].includes(args[index + 1] ?? ""))
    || args.some((arg) => ["-hls_segment_filename", "-segment_list", "-progress"].includes(arg))) return COMMAND_BLOCK;
  const inputIndexes = new Set<number>();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (["-i", "-filter_script", "-filter_complex_script", "-attach"].includes(args[index]!)) inputIndexes.add(index + 1);
  }
  for (const index of inputIndexes) {
    const value = args[index]!;
    if (value.includes("=") && args[index - 1] === "-i" && ["color", "anullsrc", "testsrc", "sine", "aevalsrc"]
      .some((source) => value.startsWith(`${source}=`))) continue;
    if (!readable(value, cwd, boundary)) return READ_BLOCK;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (inputIndexes.has(index) || arg.startsWith("-") || arg.includes("=") || arg === "-" || nullDevice(arg)) continue;
    if (looksPath(arg, cwd) && !writable(arg, cwd, boundary)) return WRITE_BLOCK;
  }
  return undefined;
}

function inspectNode(args: string[], cwd: string, boundary: Boundary, skipSkillChecks = false): string | undefined {
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) return undefined;
  const [script, action, ...rest] = args;
  if (!script || !path.isAbsolute(script) || !action) return COMMAND_BLOCK;
  const actual = effectivePath(script);
  if (skipSkillChecks && !sameFilePath(actual, boundary.hyperframesScript)) return COMMAND_BLOCK;
  if (sameFilePath(actual, boundary.mediaCacheScript)) return inspectMediaCache(action, rest, cwd, boundary);
  if (sameFilePath(actual, boundary.renderQueueScript)) return inspectRenderQueue(action, rest, cwd, boundary);
  if (sameFilePath(actual, boundary.hyperframesScript)) return inspectHyperframes([action, ...rest], cwd, boundary, skipSkillChecks);
  return COMMAND_BLOCK;
}

function inspectPython(args: string[], cwd: string, boundary: Boundary): string | undefined {
  const [script, input, ...rest] = args;
  if (!script || !path.isAbsolute(script) || !sameFilePath(effectivePath(script), boundary.audioDataScript)) return COMMAND_BLOCK;
  if (!input || !readable(input, cwd, boundary)) return READ_BLOCK;
  const output = flagValue(rest, "-o") ?? flagValue(rest, "--output");
  return output && writable(output, cwd, boundary) ? undefined : WRITE_BLOCK;
}

function inspectMediaCache(action: string, args: string[], cwd: string, boundary: Boundary): string | undefined {
  if (!["index", "annotate", "detail", "window", "resheet", "check-plan"].includes(action)) return COMMAND_BLOCK;
  if (action === "index") {
    for (const [flag, expected] of [["--reference", boundary.referenceVideo], ["--assets", boundary.assetsDir],
      ["--audio", boundary.audioDir], ["--workspace", boundary.workspace]] as const) {
      const value = flagValue(args, flag);
      if (!value || !sameFilePath(effectivePath(path.resolve(cwd, value)), expected)) return `${flag} 必须指向本任务指定路径：${expected}。`;
    }
    return undefined;
  }
  if (action !== "check-plan" && action !== "annotate") {
    const workspace = flagValue(args, "--workspace");
    if (!workspace || !sameFilePath(effectivePath(path.resolve(cwd, workspace)), boundary.workspace)) return WRITE_BLOCK;
  }
  const file = flagValue(args, "--file");
  if (!file || !readable(file, cwd, boundary)) return READ_BLOCK;
  if (action === "annotate") {
    const textFile = flagValue(args, "--text-file") ?? flagValue(args, "--textFile");
    if (!textFile || !pathInside(boundary.workspace, effectivePath(path.resolve(cwd, textFile)))) return READ_BLOCK;
  }
  const output = flagValue(args, "--output");
  return output && !writable(output, cwd, boundary) ? WRITE_BLOCK : undefined;
}

function inspectRenderQueue(action: string, args: string[], cwd: string, boundary: Boundary): string | undefined {
  if (action !== "run") return `渲染队列只支持 run：${renderCommand(boundary)}`;
  const flags = [["--workspace", boundary.workspace], ["--output-dir", boundary.outputDir]] as const;
  for (const [flag, expected] of flags) {
    const value = flagValue(args, flag);
    if (!value || !sameFilePath(effectivePath(path.resolve(cwd, value)), expected)) return `${flag} 必须指向本任务指定路径：${expected}。`;
  }
  const manifest = flagValue(args, "--manifest");
  if (!manifest || !writable(manifest, cwd, boundary)) return `渲染清单必须位于当前任务工作目录：${renderCommand(boundary)}`;
  return undefined;
}

function inspectHyperframes(args: string[], cwd: string, boundary: Boundary, offlineInit = false): string | undefined {
  if (!existsSync(boundary.hyperframesScript)) return "本地 HyperFrames CLI 未安装，请报告组件缺失错误。";
  const [action, ...rest] = args;
  if (action === "init") {
    const command = `HYPERFRAMES_SKIP_SKILLS=1 node "${boundary.hyperframesScript.replace(/\\/g, "/")}" init video-project --non-interactive --example blank`;
    if (!offlineInit) return `本地离线初始化请使用：${command}。不要执行技能更新。`;
    const positionals = positionalArgs(rest, new Set(["--example", "--resolution"]));
    const example = flagValue(rest, "--example");
    const resolution = flagValue(rest, "--resolution");
    const allowed = new Set(["--non-interactive", "--example", "--resolution"]);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--example" || arg === "--resolution") { index += 1; continue; }
      if (arg.startsWith("--") && !allowed.has(arg) && !arg.startsWith("--example=") && !arg.startsWith("--resolution=")) return COMMAND_BLOCK;
    }
    if (!rest.includes("--non-interactive") || example !== "blank" || positionals.length !== 1
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(positionals[0]!)
      || (resolution && !["landscape", "portrait", "square", "landscape-4k", "portrait-4k", "square-4k"].includes(resolution))
      || !pathInside(boundary.workspace, cwd)) return `初始化参数不符合当前任务本地模板要求：${command}`;
    return undefined;
  }
  if (!action || !HYPERFRAMES_COMMANDS.has(action)) return SETUP_BLOCK;
  const project = flagValue(rest, "--project") ?? flagValue(rest, "--dir") ?? flagValue(rest, "-d");
  if (project && !writable(project, cwd, boundary)) return WRITE_BLOCK;
  const output = [...OUTPUT_FLAGS].map((flag) => flagValue(rest, flag)).find(Boolean);
  if (output && !writable(output, cwd, boundary)) return WRITE_BLOCK;
  if (action === "transcribe") {
    const input = positionalArgs(rest, new Set(["--dir", "-d", "--engine", "-e", "--model", "-m", "--language", "-l", "--to", "--output", "-o", "--timeout"]))[0];
    if (!input || !readable(input, cwd, boundary)) return READ_BLOCK;
    // By default transcribe writes beside the input. Keep that inside the task.
    if (!project && !writable(path.dirname(path.resolve(cwd, input)), cwd, boundary)) {
      return `转写外部音频时请加 --dir "${boundary.workspace}"，将字幕输出写在任务工作目录。`;
    }
  }
  if (action === "beats") {
    const target = positionalArgs(rest, new Set<string>())[0] ?? cwd;
    if (!writable(target, cwd, boundary)) return WRITE_BLOCK;
  }
  for (const arg of rest) {
    if (arg.startsWith("-") || arg === project || arg === output || arg.includes("=")) continue;
    if (looksPath(arg, cwd) && !readable(arg, cwd, boundary)) return READ_BLOCK;
  }
  return undefined;
}

function inspectMutation(name: string, args: string[], cwd: string, boundary: Boundary): string | undefined {
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (!paths.length) return COMMAND_BLOCK;
  if (["cp", "copy", "mv", "move"].includes(name)) {
    if (paths.length !== 2) return COMMAND_BLOCK;
    if (!(name === "cp" || name === "copy" ? readable(paths[0]!, cwd, boundary) : writable(paths[0]!, cwd, boundary))) return READ_BLOCK;
    return writable(paths[1]!, cwd, boundary) ? undefined : WRITE_BLOCK;
  }
  for (const target of paths) {
    if (!writable(target, cwd, boundary) || sameFilePath(effectivePath(path.resolve(cwd, target)), boundary.workspace)) return WRITE_BLOCK;
  }
  return undefined;
}

function parseSegment(tokens: Token[]): Segment | undefined {
  const words: string[] = [], redirects: Segment["redirects"] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "word") { words.push(token.value); continue; }
    if (token.value === "2>&1") { redirects.push({ operator: token.value, target: "1" }); continue; }
    if (!/^(?:\d)?(?:>|>>|<)$/.test(token.value)) return undefined;
    const target = tokens[++index];
    if (!target || target.kind !== "word") return undefined;
    redirects.push({ operator: token.value, target: target.value });
  }
  return { words, redirects };
}

function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "", quote: "'" | '"' | undefined;
  const flush = () => { if (word) { tokens.push({ kind: "word", value: word }); word = ""; } };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && command[index + 1] === '"') { word += '"'; index += 1; }
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { flush(); if (char === "\n" || char === "\r") tokens.push({ kind: "operator", value: ";" }); continue; }
    if (char === "&" || char === ";" || char === "|") {
      flush();
      const twice = command[index + 1] === char;
      tokens.push({ kind: "operator", value: twice ? char + char : char });
      if (twice) index += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      const descriptor = /^\d$/.test(word) ? word : "";
      if (descriptor) word = ""; else flush();
      if (descriptor === "2" && char === ">" && command.slice(index + 1, index + 3) === "&1") {
        tokens.push({ kind: "operator", value: "2>&1" }); index += 2; continue;
      }
      const twice = command[index + 1] === char;
      tokens.push({ kind: "operator", value: descriptor + char + (twice ? char : "") });
      if (twice) index += 1;
      continue;
    }
    word += char;
  }
  if (quote) return undefined;
  flush();
  return tokens;
}

function renderCommand(boundary: Boundary): string {
  const portable = (value: string) => value.replace(/\\/g, "/");
  return `node "${portable(boundary.renderQueueScript)}" run --manifest "${portable(path.join(boundary.workspace, "render-manifest.json"))}" --workspace "${portable(boundary.workspace)}" --output-dir "${portable(boundary.outputDir)}"`;
}

function toolPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function executable(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positionalArgs(args: string[], valueFlags: Set<string>): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) { index += 1; continue; }
    if (!arg.startsWith("-") && ![...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) positional.push(arg);
  }
  return positional;
}

function dynamic(value: string): boolean { return /[`\x00]|\$\(|\$\{|\$[A-Za-z0-9_@*?]/.test(value); }
function protocol(value: string): boolean { return /^(?:https?|rtsp|ftp|file|concat|crypto|pipe):/i.test(value); }
function nullDevice(value: string): boolean { return /^(?:nul|\/dev\/null)$/i.test(value); }
function looksPath(value: string, cwd: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith(".")
    || MEDIA_EXTENSIONS.test(value) || existsSync(path.resolve(cwd, value));
}
