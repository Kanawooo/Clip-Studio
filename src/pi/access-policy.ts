import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, InlineExtension, SessionManager, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  effectivePath, pathInside, resolveTaskPaths, sameFilePath,
  type TaskPathOptions, type TaskPaths,
} from "./task-paths.js";
import { createVisualRuntime, type VisualProof } from "./visual-context.js";

export interface TaskAccessPolicyOptions extends TaskPathOptions {
  onTermination?: (reason: string) => void;
}

const BATCH_MARKER = "clip-composition-batch";
/** Conservative readiness only, not an authoring validator. Unknown structures
 * retain real images. Native source/range/timeline identity must match the plan. */
function compositionMatchesPlan(html: string, output: { duration?: number; shots?: Array<{ source: string; start: number; end: number; at?: number; rate?: number }> }, resolve: (source: string) => string) {
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2]
    ?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  const root = html.match(/<[a-z][^>]*\bdata-composition-id\s*=[^>]*>/i)?.[0];
  if (!root || !Array.isArray(output.shots) || !(Number(output.duration) > 0)
    || Math.abs(Number(attr(root, "data-duration")) - Number(output.duration)) > 0.12) return false;
  const videos = [...html.matchAll(/<video\b[^>]*>/gi)].map(match => match[0]);
  if (videos.length !== output.shots.length) return false;
  let end = 0;
  return output.shots.every((shot, index) => {
    const tag = videos[index]!, src = attr(tag, "src"), from = shot.start, rate = shot.rate ?? 1;
    const start = shot.at ?? end, duration = (shot.end - from) / rate;
    end = Math.max(end, start + duration);
    return !!src && typeof shot.source === "string" && duration > 0 && resolve(src) === resolve(shot.source)
      && Math.abs(Number(attr(tag, "data-start")) - start) < 0.12
      && Math.abs(Number(attr(tag, "data-duration")) - duration) < 0.12
      && Math.abs(Number(attr(tag, "data-media-start") ?? 0) - from) < 0.12
      && Math.abs(Number(attr(tag, "data-playback-rate") ?? 1) - rate) < 0.01;
  });
}
interface CompositionReceipt { toolCallId: string; kind: "writer" | "edit"; files: Array<{ file: string; sha256: string }> }

/** Native custom entries never participate in the model context. Legacy Sessions stay unmarked. */
export function initializeCompositionBatch(manager: SessionManager, workspace: string, newTask: boolean, recoveryFile?: string): void {
  if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === BATCH_MARKER)) return;
  if (!newTask && !recoveryFile) return;
  const contract = JSON.parse(readFileSync(path.join(workspace, "..", "delivery", "contract.json"), "utf8"));
  let recover = false;
  if (recoveryFile && pathInside(manager.getSessionDir(), effectivePath(recoveryFile))) {
    // A failed normal open can still recover this small trusted native marker.
    recover = readFileSync(recoveryFile, "utf8").split(/\r?\n/).some((line) => {
      try { const entry = JSON.parse(line); return entry.type === "custom" && entry.customType === BATCH_MARKER
        && entry.data?.version === 1 && entry.data.taskId === contract.taskId && entry.data.required === true; }
      catch { return false; }
    });
  }
  if ((newTask || recover) && contract.version === 1 && sameFilePath(contract.workspace, workspace)
    && Array.isArray(contract.slots) && contract.slots.length > 1)
    manager.appendCustomEntry(BATCH_MARKER, { version: 1, taskId: contract.taskId, required: true, count: contract.slots.length });
}

/** Production-contract correction, independent of access-denial counters. */
export function createCompositionBatchGuard(options: TaskAccessPolicyOptions) {
  const workspace = effectivePath(options.workspace);
  const writer = path.join(options.projectRoot, ".pi/skills/hyperframes/hyperframes-cli/scripts/write-compositions.mjs");
  const queue = path.join(options.projectRoot, ".pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  let repeated: { signature: string; count: number } | undefined;
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  function calls(command: unknown, script: string, action?: string) {
    const tokens = typeof command === "string" ? tokenize(command) : undefined;
    if (!tokens) return [];
    const clauses: Token[][] = [[]];
    for (const token of tokens) { if (token.value === "&&" && token.kind === "operator") clauses.push([]); else clauses.at(-1)!.push(token); }
    let cwd = workspace;
    const found: Array<{ manifest: string; cwd: string }> = [];
    for (const clause of clauses) {
      const words = parseSegment(clause)?.words;
      if (!words?.length) continue;
      if (words[0] === "cd" && words.length === 2) { cwd = path.resolve(cwd, words[1]!); continue; }
      if (executable(words[0]!) !== "node" || !words[1] || !path.isAbsolute(words[1]) || !sameFilePath(words[1], script)
        || (action && words[2] !== action)) continue;
      const args = words.slice(action ? 3 : 2), manifest = flagValue(args, "--manifest");
      if (manifest) found.push({ manifest: path.resolve(cwd, manifest), cwd });
    }
    return found;
  }
  function writerResult(event: Pick<ToolResultEvent, "content">): Array<{ file: string; sha256: string }> {
    for (const line of event.content.filter((block) => block.type === "text").flatMap((block) => block.text.split(/\r?\n/))) {
      try {
        const value = JSON.parse(line);
        if (![value.saved, value.skipped, value.failed].every(Array.isArray)) continue;
        return [...value.saved, ...value.skipped].filter((row) => typeof row.file === "string"
          && /^[a-f0-9]{64}$/.test(row.sha256 ?? ""));
      } catch { /* The native Bash error tail can accompany a partial-success JSON. */ }
    }
    return [];
  }
  function history(ctx: ExtensionContext, includeNativeWrites = false) {
    const entries = ctx.sessionManager.getBranch();
    const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    const tools = new Map<string, { name: string; arguments: Record<string, unknown> }>();
    const results = new Map<string, Extract<(typeof messages)[number], { role: "toolResult" }>>();
    for (const message of messages) {
      if (message.role === "assistant" && !["error", "aborted"].includes(message.stopReason))
        for (const block of message.content) if (block.type === "toolCall") tools.set(block.id, block);
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }
    const proven = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== "clip-composition-receipt") continue;
      const receipt = entry.data as CompositionReceipt | undefined;
      if (!receipt || !Array.isArray(receipt.files)) continue;
      const call = tools.get(receipt.toolCallId), result = results.get(receipt.toolCallId);
      if (!call || !result) continue;
      if (receipt.kind === "writer" && call.name === "bash" && calls(call.arguments.command, writer).length) {
        const returned = writerResult(result);
        for (const item of receipt.files) if (returned.some((row) => sameFilePath(row.file, item.file) && row.sha256 === item.sha256))
          proven.set(effectivePath(item.file), item.sha256);
      } else if (receipt.kind === "edit" && !result.isError && ["edit", "write"].includes(call.name)
        && typeof call.arguments.path === "string") {
        const target = effectivePath(path.resolve(workspace, call.arguments.path));
        for (const item of receipt.files) if (sameFilePath(item.file, target) && proven.has(target)) proven.set(target, item.sha256);
      }
    }
    // Legacy/single-output Sessions have native writes but no batch receipts.
    // Only an actual paired successful write with the current exact bytes counts.
    for (const [id, call] of includeNativeWrites ? tools : []) {
      if (call.name !== "write" || results.get(id)?.isError !== false
        || typeof call.arguments.path !== "string" || typeof call.arguments.content !== "string") continue;
      const file = effectivePath(path.resolve(workspace, call.arguments.path));
      try {
        const hash = createHash("sha256").update(call.arguments.content).digest("hex");
        if (pathInside(workspace, file) && digest(file) === hash) proven.set(file, hash);
      } catch { /* Missing/changed engineering is not ready. */ }
    }
    return { entries, proven, tools, results };
  }
  function before(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
    if (event.toolName !== "bash") return;
    const runs = calls(event.input.command, queue, "run");
    if (!runs.length) return;
    const { entries, proven } = history(ctx);
    const policy = JSON.parse(readFileSync(path.join(workspace, "media-policy.json"), "utf8"));
    const marker = entries.find((entry) => entry.type === "custom" && entry.customType === BATCH_MARKER
      && (entry.data as { version?: number; taskId?: string; required?: boolean })?.version === 1
      && (entry.data as { taskId?: string })?.taskId === policy.taskId && (entry.data as { required?: boolean })?.required === true);
    if (!marker || marker.type !== "custom") return;
    const requiredCount = (marker.data as { count?: number }).count;
    for (const run of runs) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(run.manifest, "utf8")); } catch { continue; }
      // Malformed queue fields belong to the existing queue's precise field validator.
      if (typeof parsed?.project !== "string" || !Array.isArray(parsed.rows) || parsed.rows.length < 2
        || (requiredCount !== undefined && parsed.rows.length !== requiredCount)) continue;
      const project = path.resolve(workspace, parsed.project);
      if (!pathInside(workspace, project) || parsed.rows.some((row: { composition?: unknown }) => typeof row?.composition !== "string")) continue;
      const targets: string[] = parsed.rows.map((row: { composition: string }) => effectivePath(path.resolve(project, row.composition)));
      if (targets.some((file) => !pathInside(workspace, file))) continue;
      const missing = targets.filter((file) => { try { return proven.get(file) !== digest(file); } catch { return true; } });
      if (!missing.length) { repeated = undefined; continue; }
      const signature = JSON.stringify([missing, [...proven]]);
      repeated = repeated?.signature === signature ? { signature, count: repeated.count + 1 } : { signature, count: 1 };
      const reason = `[VALIDATION:COMPOSITION_BATCH_REQUIRED] rows.composition：缺少可信批量写入记录：${missing.map((file) => path.relative(workspace, file)).join("、")}。保存工程清单 {version:1,project,rows:[{composition,content 或 template/values,mainAudio}]}，调用 node "${writer}" --workspace "${workspace}" --manifest "${path.join(workspace, "composition-batch.json")}"；可分批及补单行，相同工程可幂等接入，随后保留当前渲染清单重试。局部修改用原生 edit。`;
      if (repeated.count >= 3) options.onTermination?.(`制作失败：${reason} 同一流程错误重复 3 次，已停止；已有工程和成片保留。`);
      return { block: true, reason, terminate: repeated.count >= 3 };
    }
  }
  function after(event: ToolResultEvent, ctx: ExtensionContext, append: (data: CompositionReceipt) => void) {
    if (event.toolName === "bash" && calls(event.input.command, writer).length) {
      const expected = new Set<string>();
      for (const call of calls(event.input.command, writer)) {
        try {
          const manifest = JSON.parse(readFileSync(call.manifest, "utf8"));
          if (typeof manifest.project !== "string" || !Array.isArray(manifest.rows)) continue;
          for (const row of manifest.rows) if (typeof row?.composition === "string")
            expected.add(effectivePath(path.resolve(workspace, manifest.project, row.composition)));
        } catch { /* A failed preflight creates no proven composition. */ }
      }
      const files = writerResult(event).filter((item) => {
        try { const file = effectivePath(item.file); return pathInside(workspace, file) && expected.has(file) && digest(file) === item.sha256; }
        catch { return false; }
      });
      if (files.length) { append({ kind: "writer", toolCallId: event.toolCallId, files }); repeated = undefined; }
    } else if (!event.isError && ["write", "edit"].includes(event.toolName) && typeof event.input.path === "string") {
      const file = effectivePath(path.resolve(workspace, event.input.path));
      if (history(ctx).proven.has(file)) append({ kind: "edit", toolCallId: event.toolCallId, files: [{ file, sha256: digest(file) }] });
    }
  }
  function isReady(ctx: ExtensionContext, proof: VisualProof): boolean {
    if (!proof.finalized || !pathInside(workspace, effectivePath(proof.file))) return false;
    try {
      const { proven, tools, results } = history(ctx, true);
      const plan = JSON.parse(readFileSync(proof.file, "utf8"));
      if (digest(proof.file) !== proof.sha256 || !Array.isArray(plan.outputs) || !plan.outputs.length) return false;
      const contract = JSON.parse(readFileSync(path.join(workspace, "..", "delivery", "contract.json"), "utf8"));
      if (contract.taskId !== proof.taskId || plan.outputs.length !== contract.slots.length) return false;
      const candidates = new Set<string>();
      for (const [id, call] of tools) {
        if (!results.has(id)) continue;
        if (call.name === "bash") for (const run of calls(call.arguments.command, queue, "run")) candidates.add(run.manifest);
        if (call.name === "write" && results.get(id)?.isError === false && typeof call.arguments.path === "string") {
          const file = effectivePath(path.resolve(workspace, call.arguments.path));
          if (proven.has(file)) candidates.add(file);
        }
      }
      type AudioSegment = { source?: string; from?: number; to?: number; at?: number; rate?: number };
      const audio = (value: (AudioSegment & { segments?: AudioSegment[] }) | undefined, root: string) => {
        const segments = value?.segments ?? (value?.source ? [value] : []);
        return JSON.stringify(segments.map((segment) => ({ source: effectivePath(path.resolve(root, segment.source!)),
          from: segment.from ?? 0, to: segment.to ?? null, at: segment.at ?? null, rate: segment.rate ?? 1 })));
      };
      for (const file of candidates) {
        if (!pathInside(workspace, effectivePath(file))) continue;
        let manifest;
        try { manifest = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
        if (manifest.version !== 1 || typeof manifest.project !== "string" || !Array.isArray(manifest.rows)
          || manifest.rows.length !== plan.outputs.length) continue;
        const project = effectivePath(path.resolve(workspace, manifest.project));
        if (!pathInside(workspace, project)) continue;
        const ready = manifest.rows.every((row: { output?: string; composition?: string; mainAudio?: Parameters<typeof audio>[0]; silentDuration?: number }, index: number) => {
          const selected = plan.outputs[index];
          if (row.output !== contract.slots[index] || selected.output !== row.output || typeof row.composition !== "string") return false;
          const target = effectivePath(path.resolve(project, row.composition));
          if (!pathInside(workspace, target) || proven.get(target) !== digest(target)) return false;
          if (!compositionMatchesPlan(readFileSync(target, "utf8"), selected,
            (source: string) => effectivePath(source.startsWith("file://") ? fileURLToPath(source) : path.resolve(project, source)))) return false;
          if (row.silentDuration !== undefined) return row.silentDuration === selected.silentDuration;
          return !!row.mainAudio && !!selected.mainAudio && audio(row.mainAudio, project) === audio(selected.mainAudio, workspace);
        });
        if (ready) return true;
      }
    } catch { /* Fail closed: retain real images on stale/unproven engineering. */ }
    return false;
  }
  return { before, after, isReady };
}

interface Boundary extends TaskPaths {
  mediaCacheScript: string;
  renderQueueScript: string;
  compositionScript: string;
  hyperframesScript: string;
  audioDataScript: string;
  mediaPolicy: string;
}

interface Token { kind: "word" | "operator"; value: string }
interface Segment { words: string[]; redirects: Array<{ operator: string; target: string }> }

const READ_BLOCK = "该路径不属于当前任务可读范围。请读取本任务工作目录、四个已选路径或项目本地技能文档；缓存图片由素材索引复制到工作目录。";
const WRITE_BLOCK = "写入目标不在当前任务工作目录。请将工程和中间文件写入任务工作目录；最终成片由渲染队列写入指定输出目录。";
const COMMAND_BLOCK = "无法确认该命令的访问范围。请使用 Pi 原生文件工具，或直接调用已安装的 FFmpeg/FFprobe、素材索引及 HyperFrames CLI；脚本使用本地绝对入口。批量操作使用单行 && 和明确文件名，不使用通配符、换行续写或内联脚本。";
const SETUP_BLOCK = "视频任务不安装、更新、认证或发布。请使用已安装的剪辑组件；缺失时报告实际错误。";
const POLICY_WRITE_BLOCK = "media-policy.json 是任务创建时固定的配置，只能读取。请将分析、工程和中间文件写入其他工作区文件。";
const HYPERFRAMES_COMMANDS = new Set(["lint", "check", "beats", "transcribe", "keyframes", "compositions", "info", "catalog"]);
const READ_COMMANDS = new Set(["ls", "dir", "rg", "grep", "find", "cat", "type", "head", "tail", "stat", "wc", "pwd"]);
const MUTATION_COMMANDS = new Set(["mkdir", "md", "touch", "rm", "del", "erase", "rmdir", "rd", "cp", "copy", "mv", "move"]);
const OUTPUT_FLAGS = new Set(["-o", "--out", "--output", "--out-dir", "--output-dir", "--dest", "--destination"]);
const MEDIA_EXTENSIONS = /\.(?:mp4|mov|mkv|webm|avi|m4v|mp3|m4a|wav|aac|flac|ogg|srt|vtt|json|jpg|jpeg|png|webp|cube|txt|html)$/i;
const SKILL_READ_EXTENSIONS = new Set([".md", ".txt", ".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const SINGLE_USE_FLAGS = new Set(["--workspace", "--output-dir", "--manifest", "--reference", "--assets", "--audio", "--file", "--id", "--ids", "--text-file", "--textFile", "--project", "--dir", "-d", "--output", "-o", "--out"]);
const ALIAS_GROUPS = [["--project", "--dir", "-d"], ["--output", "--out", "-o"], ["--text-file", "--textFile"]];

export function createTaskAccessPolicy(options: TaskAccessPolicyOptions): InlineExtension {
  const handler = createTaskAccessHandler(options);
  const failure = createRenderFailureHandler(options);
  const batch = createCompositionBatchGuard(options);
  const visual = createVisualRuntime({ ...options, isEngineeringReady: batch.isReady });
  return { name: "task-access-policy", hidden: true, factory: (pi) => {
    pi.on("context", visual.context);
    pi.on("context_with_system", visual.contextWithSystem);
    pi.on("session_before_compact", visual.beforeCompact);
    pi.on("before_provider_request", visual.providerRequest);
    pi.on("tool_call", (event, context) => {
      const result = handler(event);
      if (result) return result;
      failure.before(event);
      return batch.before(event, context);
    });
    pi.on("tool_result", async (event, context) => {
      batch.after(event, context, (data) => pi.appendEntry("clip-composition-receipt", data));
      const reason = failure.after(event);
      if (reason) { options.onTermination?.(reason); context.abort(); }
      else return (await visual.selectionResult(event, context)) ?? visual.toolResult(event, context);
    });
  } };
}

/** Stateful handler exported for deterministic, command-free policy tests. */
export function createTaskAccessHandler(options: TaskAccessPolicyOptions): (event: ToolCallEvent) => ToolCallEventResult | undefined {
  const paths = resolveTaskPaths(options);
  const boundary: Boundary = {
    ...paths,
    mediaCacheScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs")),
    renderQueueScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs")),
    compositionScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "write-compositions.mjs")),
    hyperframesScript: effectivePath(path.join(paths.projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs")),
    audioDataScript: effectivePath(path.join(paths.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-creative", "scripts", "extract-audio-data.py")),
    mediaPolicy: path.join(paths.workspace, "media-policy.json"),
  };
  let repeated: { key: string; count: number } | undefined;
  return (event) => {
    let reason = violation(event, boundary);
    if (!reason) { repeated = undefined; return undefined; }
    if (reason === READ_BLOCK) {
      reason += ` 技能文档根目录：${boundary.skillRoots.map((root) => root.replace(/\\/g, "/")).join("、")}。请直接在这些目录查找文档，不搜索程序根目录或 node_modules。`;
    }
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
    if (candidate && protectedPolicyPath(candidate, boundary.workspace, boundary)) return POLICY_WRITE_BLOCK;
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
    return !protectedPolicyPath(value, cwd, boundary)
      && pathInside(boundary.workspace, resolved) && pathInside(boundary.workspace, effectivePath(resolved));
  } catch { return false; }
}

function protectedPolicyPath(value: string, cwd: string, boundary: Boundary): boolean {
  try {
    const candidate = effectivePath(path.resolve(cwd, value));
    if (sameFilePath(candidate, boundary.mediaPolicy)) return true;
    if (!existsSync(candidate) || !existsSync(boundary.mediaPolicy)) return false;
    const actual = statSync(candidate), policy = statSync(boundary.mediaPolicy);
    return actual.isFile() && actual.ino !== 0 && actual.dev === policy.dev && actual.ino === policy.ino;
  } catch { return true; }
}

function bashViolation(command: string, boundary: Boundary): string | undefined {
  if (!command.trim()) return COMMAND_BLOCK;
  if (/[`\x00]|\$\(|\$\{|\$[A-Za-z0-9_@*?]|<\(|>\(|\\\r?\n/.test(command)) return COMMAND_BLOCK;
  const tokens = tokenize(command);
  if (!tokens) return COMMAND_BLOCK;
  let cwd = boundary.workspace;
  if (tokens.some((item) => item.kind === "operator" && [";", "||", "&", "<<", "&>"].includes(item.value))) return COMMAND_BLOCK;
  const clauses: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "operator" && token.value === "&&") clauses.push([]);
    else clauses.at(-1)!.push(token);
  }
  for (const clause of clauses) {
    const segment = parseSegment(clause);
    if (segment?.words[0]?.toLowerCase() === "cd") {
      if (segment.redirects.length || segment.words.length !== 2) return COMMAND_BLOCK;
      const target = path.resolve(cwd, segment.words[1]!);
      if (!readable(target, cwd, boundary) || !existsSync(target) || !statSync(target).isDirectory()) return READ_BLOCK;
      cwd = effectivePath(target);
      continue;
    }
    const reason = inspectPipeline(clause, cwd, boundary);
    if (reason) return reason;
  }
  return undefined;
}

function inspectPipeline(remaining: Token[], cwd: string, boundary: Boundary): string | undefined {
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
  const publicHelp = ["node", "hyperframes", "npx"].includes(name)
    && (queryOnly(args) || queryOnly(args.slice(1)) || (name === "node" && helpOnly(args.slice(2))));
  if (!pathInside(boundary.workspace, cwd) && !READ_COMMANDS.has(name) && name !== "ffprobe" && !publicHelp) {
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
  if (sameFilePath(actual, boundary.mediaCacheScript)) return helpOnly([action, ...rest]) ? undefined : inspectMediaCache(action, rest, cwd, boundary);
  if (sameFilePath(actual, boundary.renderQueueScript)) return helpOnly([action, ...rest]) ? undefined : inspectRenderQueue(action, rest, cwd, boundary);
  if (sameFilePath(actual, boundary.compositionScript)) {
    if (helpOnly([action, ...rest])) return undefined;
    const values = [action, ...rest];
    if (!validValueFlags(values, ["--workspace", "--manifest"])) return COMMAND_BLOCK;
    const workspace = flagValue(values, "--workspace"), manifest = flagValue(values, "--manifest");
    if (!workspace || !sameFilePath(path.resolve(cwd, workspace), boundary.workspace)) return WRITE_BLOCK;
    return manifest && pathInside(boundary.workspace, path.resolve(cwd, manifest)) ? undefined : READ_BLOCK;
  }
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
  if (!["index", "overview", "entry", "locate", "annotate", "annotate-batch", "transcribe-batch", "detail", "window", "resheet", "check-plan"].includes(action)) return COMMAND_BLOCK;
  if (helpOnly(args)) return undefined;
  if (action === "check-plan") {
    const allowed = args.filter((arg) => arg !== "--allow-reuse");
    if (args.filter((arg) => arg === "--allow-reuse").length > 1
      || !validValueFlags(allowed, ["--file", "--workspace"])) return COMMAND_BLOCK;
    const workspace = flagValue(args, "--workspace"), file = flagValue(args, "--file");
    if (workspace && !sameFilePath(effectivePath(path.resolve(cwd, workspace)), boundary.workspace)) return WRITE_BLOCK;
    return file && pathInside(boundary.workspace, effectivePath(path.resolve(cwd, file))) ? undefined : READ_BLOCK;
  }
  if (["overview", "entry", "locate", "annotate-batch", "transcribe-batch"].includes(action)) {
    const allowed = action === "overview" ? ["--workspace", "--offset", "--limit"]
      : action === "entry" ? ["--workspace", "--file", "--id", "--kind"]
        : action === "locate" ? ["--workspace", "--ids"]
        : action === "transcribe-batch" ? ["--workspace", "--manifest", "--language", "--model"]
          : ["--workspace", "--manifest"];
    if (!validValueFlags(args, allowed)) return COMMAND_BLOCK;
    const workspace = flagValue(args, "--workspace");
    if (!workspace || !sameFilePath(effectivePath(path.resolve(cwd, workspace)), boundary.workspace)) return WRITE_BLOCK;
    if (action === "overview") {
      const offset = flagValue(args, "--offset"), limit = flagValue(args, "--limit");
      return (offset !== undefined && !/^\d+$/.test(offset))
        || (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ? COMMAND_BLOCK : undefined;
    }
    if (action === "entry") {
      const file = flagValue(args, "--file"), kind = flagValue(args, "--kind"), id = flagValue(args, "--id");
      if (id) return !file && /^(ref|src|aud)-[a-f0-9]{12,64}$/.test(id)
        && (!kind || ["reference", "source", "audio"].includes(kind)) ? undefined : COMMAND_BLOCK;
      return file && readable(file, cwd, boundary) && ["reference", "source", "audio"].includes(kind ?? "") ? undefined : READ_BLOCK;
    }
    if (action === "locate") return flagValue(args, "--ids")?.split(",")
      .every((id) => /^(ref|src|aud)-[a-f0-9]{12,64}$/.test(id)) ? undefined : COMMAND_BLOCK;
    const manifest = flagValue(args, "--manifest");
    return manifest && pathInside(boundary.workspace, effectivePath(path.resolve(cwd, manifest))) ? undefined : READ_BLOCK;
  }
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
  if (!["run", "template"].includes(action)) return `渲染队列支持 template 生成标准清单和 run 渲染：${renderCommand(boundary)}`;
  if (helpOnly(args)) return undefined;
  if (!validValueFlags(args, action === "template"
    ? ["--workspace", "--output-dir", "--manifest", "--project"] : ["--workspace", "--output-dir", "--manifest"])) return COMMAND_BLOCK;
  const flags = [["--workspace", boundary.workspace], ["--output-dir", boundary.outputDir]] as const;
  for (const [flag, expected] of flags) {
    const value = flagValue(args, flag);
    if (!value || !sameFilePath(effectivePath(path.resolve(cwd, value)), expected)) return `${flag} 必须指向本任务指定路径：${expected}。`;
  }
  const manifest = flagValue(args, "--manifest");
  if (!manifest || !writable(manifest, cwd, boundary)) return `渲染清单必须位于当前任务工作目录：${renderCommand(boundary)}`;
  const project = flagValue(args, "--project");
  if (project && (path.isAbsolute(project) || !writable(project, boundary.workspace, boundary))) return WRITE_BLOCK;
  return undefined;
}

function inspectHyperframes(args: string[], cwd: string, boundary: Boundary, offlineInit = false): string | undefined {
  if (!existsSync(boundary.hyperframesScript)) return "本地 HyperFrames CLI 未安装，请报告组件缺失错误。";
  const [action, ...rest] = args;
  // Public help does not read media or create a project. Never treat --help
  // with additional positional/path arguments as this read-only form.
  if (queryOnly(args) || (action && (HYPERFRAMES_COMMANDS.has(action) || ["init", "render"].includes(action)) && helpOnly(rest))) return undefined;
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
  if (action === "render") return `正式渲染请使用任务渲染队列，它会保留完成记录并校验主音频：${renderCommand(boundary)}`;
  if (action === "docs") {
    const reference = path.join(boundary.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-core", "references", "minimal-composition.md").replace(/\\/g, "/");
    return `当前任务通过本地技能文档读取工程示例：${reference}。命令参数使用本地 CLI 的 <命令> --help 查询，不查程序实现。`;
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
  if (args.some((arg) => arg.startsWith("--") && !["--recursive", "--force", "--parents", "--preserve", "--verbose"].includes(arg)
    || arg.startsWith("-") && !/^-([rRfpiv]+)$/.test(arg))) return COMMAND_BLOCK;
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (!paths.length) return COMMAND_BLOCK;
  if (["cp", "copy", "mv", "move"].includes(name)) {
    if (paths.length !== 2) return COMMAND_BLOCK;
    if (!(name === "cp" || name === "copy" ? readable(paths[0]!, cwd, boundary) : writable(paths[0]!, cwd, boundary))) return READ_BLOCK;
    let destination = path.resolve(cwd, paths[1]!);
    const source = path.resolve(cwd, paths[0]!);
    if (existsSync(source) && statSync(source).isDirectory() && pathInside(destination, boundary.mediaPolicy)) return POLICY_WRITE_BLOCK;
    if (existsSync(destination) && statSync(destination).isDirectory()) destination = path.join(destination, path.basename(paths[0]!));
    return writable(destination, cwd, boundary) ? undefined : WRITE_BLOCK;
  }
  for (const target of paths) {
    if (!writable(target, cwd, boundary) || sameFilePath(effectivePath(path.resolve(cwd, target)), boundary.workspace)) return WRITE_BLOCK;
  }
  return undefined;
}

/** Counts only explicitly marked, deterministic render validation failures.
 * State is session-local: a user retry gets a fresh guard, while a read/help
 * between unchanged failing runs is not mistaken for file progress. */
export function createRenderFailureHandler(options: TaskAccessPolicyOptions) {
  const queue = effectivePath(path.join(options.projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs"));
  const workspace = effectivePath(options.workspace);
  const pending = new Map<string, { fingerprint: string; fields: Record<string, string> }>();
  const failures = new Map<string, { fingerprint: string; count: number }>();
  function before(event: ToolCallEvent): void {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const tokens = tokenize(event.input.command);
    if (!tokens) return;
    let cwd = workspace;
    const clauses: Token[][] = [[]];
    for (const token of tokens) {
      if (token.kind === "operator" && token.value === "&&") clauses.push([]);
      else clauses.at(-1)!.push(token);
    }
    for (const clause of clauses) {
      const words = parseSegment(clause)?.words;
      if (!words?.length) continue;
      if (words[0] === "cd" && words.length === 2) cwd = path.resolve(cwd, words[1]!);
      const nodeArgs = words[0] === "HYPERFRAMES_SKIP_SKILLS=1" ? words.slice(1) : words;
      if (executable(nodeArgs[0] ?? "") === "node" && nodeArgs[1] && path.isAbsolute(nodeArgs[1])
        && sameFilePath(nodeArgs[1], queue) && nodeArgs[2] === "run") {
        const manifest = flagValue(nodeArgs.slice(3), "--manifest");
        if (manifest) {
          const manifestPath = path.resolve(cwd, manifest);
          const fields: Record<string, string> = {};
          try {
            const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
            fields.ROOT = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "object" : typeof parsed;
            fields.VERSION = JSON.stringify(parsed?.version) ?? "missing";
            fields.ROWS = Array.isArray(parsed?.rows) ? "array" : parsed?.rows == null ? "missing" : typeof parsed.rows;
            fields.ROW_COUNT = String(Array.isArray(parsed?.rows) ? parsed.rows.length : "missing");
          } catch { /* invalid JSON uses the complete byte fingerprint */ }
          pending.set(event.toolCallId, { fingerprint: renderFingerprint(manifestPath, workspace, options.audioDir), fields });
        }
      }
    }
  }
  function after(event: ToolResultEvent): string | undefined {
    const snapshot = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!snapshot) return undefined;
    if (!event.isError) { failures.clear(); return undefined; }
    const text = event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (text.includes("[RENDER_EXHAUSTED]")) {
      return `制作失败：${text.match(/\[RENDER_EXHAUSTED\][^\r\n]*/)?.[0] ?? "相同工程的自动恢复额度已用完"}`;
    }
    const message = text.match(/render-queue:\s*(\[VALIDATION:[A-Z_]+\][^\r\n]*)/)?.[1];
    if (!message) return undefined;
    const code = message.match(/^\[VALIDATION:([A-Z_]+)\]/)?.[1] ?? "";
    // Adding renders/videos or changing an unrelated field is not progress
    // toward fixing a missing version/rows contract.
    const fingerprint = snapshot.fields[code] ?? snapshot.fingerprint;
    const previous = failures.get(message);
    const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
    failures.set(message, { fingerprint, count });
    if (count < 3) return undefined;
    return `制作失败：${message} 同一错误的相关输入未变化，已重复失败 3 次，已停止重复调用。请按字段原因修正后在原任务重试；已验证成片保持不变。`;
  }
  return { before, after };
}

function renderFingerprint(manifestPath: string, workspace: string, audioDir: string): string {
  const hash = createHash("sha256");
  function record(file: string, content = false): void {
    hash.update(file);
    try {
      const stat = statSync(file);
      hash.update(JSON.stringify([stat.size, stat.mtimeMs]));
      if (content && stat.isFile() && stat.size <= 5 * 1024 * 1024) hash.update(readFileSync(file));
    } catch (error) { hash.update((error as NodeJS.ErrnoException).code ?? "unavailable"); }
  }
  record(manifestPath, true);
  record(path.join(workspace, "..", "delivery", "contract.json"), true);
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const project = typeof manifest.project === "string" ? path.resolve(workspace, manifest.project) : workspace;
    if (!pathInside(workspace, project)) return hash.digest("hex");
    record(project);
    for (const row of Array.isArray(manifest.rows) ? manifest.rows : []) {
      if (!row || typeof row !== "object") continue;
      if (typeof row.composition === "string") {
        const file = path.resolve(project, row.composition);
        if (pathInside(workspace, file)) record(file, true);
      }
      const segments = row.mainAudio?.segments ?? (row.mainAudio?.source ? [row.mainAudio] : []);
      for (const segment of Array.isArray(segments) ? segments : []) {
        if (typeof segment?.source === "string") {
          const file = path.resolve(project, segment.source);
          if (pathInside(workspace, file) || pathInside(audioDir, file)) record(file);
        }
      }
    }
  } catch { /* malformed manifests are already represented by their bytes */ }
  return hash.digest("hex");
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
    // Do not validate a literal path and then let Bash expand it to a
    // different set of files (including the backend-owned task policy).
    if (/[\*?\[\]{}~]/.test(char)) return undefined;
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

function helpOnly(args: string[]): boolean { return args.length === 1 && ["--help", "-h"].includes(args[0]!); }
function queryOnly(args: string[]): boolean {
  return helpOnly(args) || (args.length === 1 && ["--version", "-V"].includes(args[0]!));
}

function validValueFlags(args: string[], allowed: string[]): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!, separator = arg.indexOf("=");
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith("--")) return false;
    seen.add(flag);
  }
  return true;
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
