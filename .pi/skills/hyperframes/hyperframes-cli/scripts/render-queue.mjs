#!/usr/bin/env node
// Invoked by Pi through the project-local HyperFrames skill, never by TaskManager.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutput } from "./output-io.mjs";
import { admissionBudget, classifyRenderFailure, publicError, rowFailureMessage, sourceDiagnostic } from "./render-support.mjs";
import { prepareRenderComposition } from "./render-resources.mjs";
export { publicError } from "./render-support.mjs";

const readPath = (file) => readOutput("交付路径/realpath", file, () => fs.realpath(file));
const readStat = (file) => readOutput("交付文件/stat", file, () => fs.stat(file));
const readLinkStat = (file) => readOutput("交付文件/lstat", file, () => fs.lstat(file));
const readText = (file) => readOutput("交付文件/read", file, () => fs.readFile(file, "utf8"));
function absentPath(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const hyperframesCli = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const ffprobe = process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe";
const MiB = 1024 * 1024;
let interrupted = false;
const children = new Set();

export class ManifestValidationError extends Error {
  constructor(code, field, message, correction) {
    super(`[VALIDATION:${code}] ${field}：${message}。${correction}`);
    this.name = "ManifestValidationError";
    this.code = code;
    this.field = field;
  }
}

function invalid(code, field, message, correction = "请修正该字段后调用同一清单；已有成片保持不变。") {
  throw new ManifestValidationError(code, field, message, correction);
}

async function existingFieldPath(candidate, root, field, type) {
  let actual;
  try { actual = await readPath(candidate); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    invalid("PATH_MISSING", field, `路径不存在：${candidate}`, `请先在任务工作目录准备对应${type === "directory" ? "工程目录" : "文件"}，然后填写相对路径。`);
  }
  if (!inside(root, actual) || (type === "directory" ? !(await readStat(actual)).isDirectory() : !(await readStat(actual)).isFile())) {
    invalid("PATH_ROLE", field, "路径越界或文件类型不符", "工程和 composition 必须位于当前任务工作目录内，不能指向程序实现或其他任务。");
  }
  return actual;
}

export const shouldAdmit = (values) => admissionBudget(values).admit;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function runCapture(command, args, maxBytes = 2_000_000, duringStop = false) {
  if (interrupted && !duringStop) throw new Error("渲染已停止");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    children.add(child);
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-maxBytes); });
    child.stderr.on("data", (chunk) => { error = (error + chunk.toString()).slice(-maxBytes); });
    child.on("error", (cause) => { children.delete(child); reject(new Error(`${path.basename(command)} 启动失败：${cause.message}`)); });
    child.on("close", (code) => { children.delete(child); code === 0 && (!interrupted || duringStop) ? resolve(output)
      : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "未知"}：${error.slice(-2_000) || "未提供详细原因"}`)); });
  });
}

async function sha256(file) {
  return readOutput("成片或输入/hash", file, async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  });
}

function same(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function mediaInfo(file) {
  return JSON.parse(await runCapture(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
}

export function attribute(tag, name) {
  const quoted = tag.match(new RegExp(`(?:\\s|^)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  const value = quoted?.[2] ?? tag.match(new RegExp(`(?:\\s|^)${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1];
  return value?.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" }[entity.toLowerCase()];
    if (named !== undefined) return named;
    const number = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function close(left, right, tolerance = 0.12) { return Math.abs(left - right) <= tolerance; }

async function sourceIdentity(file) {
  const stat = await readStat(file);
  return { path: file, size: stat.size, mtimeMs: stat.mtimeMs, sha256: await sha256(file) };
}

export async function validateAudio(row, composition, project, contract, fps, suppliedHtml) {
  const html = suppliedHtml ?? await readText(composition);
  const rootTag = html.match(/<[a-z][^>]*\bdata-composition-id\s*=\s*(?:["'][^"']+["']|[^\s>]+)[^>]*>/i)?.[0];
  const rootValue = rootTag && attribute(rootTag, "data-duration");
  const rootDuration = rootValue === undefined ? undefined : Number(rootValue);
  if (!rootTag || rootDuration === undefined || !Number.isFinite(rootDuration) || rootDuration <= 0) {
    throw new Error("工程根必须显式设置有效的 data-duration");
  }
  const audioTags = [...html.matchAll(/<audio\b[^>]*>/gi)].map((match) => match[0]);
  const resolvedAudio = await Promise.all(audioTags.map(async (tag) => {
    const src = attribute(tag, "src");
    if (!src || /^(?:https?|data|blob):/i.test(src) || /\bmuted\b/i.test(tag)) return { tag, source: null };
    try {
      const candidate = src.startsWith("file://") ? fileURLToPath(src) : path.resolve(project, src);
      return { tag, source: await readPath(candidate) };
    } catch (error) {
      if (error.code === "ENOENT") return { tag, source: null };
      throw error;
    }
  }));
  const inputs = suppliedHtml === undefined ? [await sourceIdentity(composition)] : [];
  if (row.silentDuration !== undefined) {
    if (!(Number(contract.silentDuration) > 0) || !close(Number(row.silentDuration), Number(contract.silentDuration))) {
      throw new Error("无声成片必须在剪辑要求中明确写出无声和时长");
    }
    if (audioTags.length) throw new Error("无声成片的工程仍含音频轨");
    if (!close(rootDuration, Number(row.silentDuration), Math.max(0.12, 2 / fps))) throw new Error("无声工程时长与要求不符");
    return { target: Number(row.silentDuration), silent: true, inputs };
  }
  const supplied = row.mainAudio?.segments ?? (row.mainAudio?.source ? [{
    source: row.mainAudio.source,
    from: row.mainAudio.from,
    to: row.mainAudio.to,
    at: row.mainAudio.at ?? 0,
    rate: row.mainAudio.rate,
  }] : null);
  if (!Array.isArray(supplied) || !supplied.length) throw new Error("缺少主音频：清单每条需声明 mainAudio.source 或 mainAudio.segments");
  if (!audioTags.length) throw new Error("工程缺少主音频轨 <audio>");
  let timelineEnd = 0;
  for (const [index, segment] of supplied.entries()) {
    if (!segment || typeof segment.source !== "string" || !segment.source.trim()) throw new Error(`主音频第 ${index + 1} 段缺少源文件`);
    const candidate = path.resolve(project, segment.source);
    const source = await readPath(candidate);
    if (!inside(contract.audioDir, source) && !inside(contract.workspace, source)) throw new Error(`主音频第 ${index + 1} 段超出音频目录/任务工作目录`);
    const info = await mediaInfo(source);
    const duration = Number(info.format?.duration);
    if (!info.streams?.some((item) => item.codec_type === "audio") || !(duration > 0)) throw new Error(`主音频第 ${index + 1} 段没有有效音轨`);
    const from = segment.from ?? 0, to = segment.to ?? duration, at = segment.at ?? timelineEnd, rate = segment.rate ?? 1;
    if (![from, to, at, rate].every((value) => typeof value === "number" && Number.isFinite(value))
      || from < 0 || to <= from || to > duration + 0.08 || at < 0 || rate <= 0 || rate > 8) {
      throw new Error(`主音频第 ${index + 1} 段的源区间或播放速度无效`);
    }
    const length = (to - from) / rate;
    if (!close(at, timelineEnd)) throw new Error(`主音频第 ${index + 1} 段未连续接上前一段`);
    const matched = resolvedAudio.some(({ tag, source: actual }) => {
      if (!actual) return false;
      const tagDurationValue = attribute(tag, "data-duration");
      const tagDuration = tagDurationValue === undefined ? (duration - from) / rate : Number(tagDurationValue);
      return same(actual, source) && close(Number(attribute(tag, "data-start")), at)
        && close(tagDuration, length)
        && close(Number(attribute(tag, "data-media-start") ?? 0), from)
        && close(Number(attribute(tag, "data-playback-rate") ?? 1), rate, 0.01);
    });
    if (!matched) throw new Error(`主音频第 ${index + 1} 段未按相同源文件和时间区间进入工程音轨`);
    inputs.push(await sourceIdentity(source));
    timelineEnd = at + length;
  }
  if (!close(rootDuration, timelineEnd, Math.max(0.12, 2 / fps))) {
    throw new Error(`工程时长 ${rootDuration.toFixed(2)} 秒与主音频 ${timelineEnd.toFixed(2)} 秒不符`);
  }
  return { target: timelineEnd, silent: false, inputs };
}

export async function verifyVideo(file, audioTarget, fps) {
  const stat = await readStat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`输出为空：${file}`);
  const info = await mediaInfo(file);
  const video = info.streams?.find((entry) => entry.codec_type === "video");
  const audio = info.streams?.find((entry) => entry.codec_type === "audio");
  if (video?.codec_name !== "h264" || !(Number(info.format?.duration) > 0)) {
    throw new Error(`FFprobe 验证失败：需要可播放的 H.264 视频和有效时长（${file}）`);
  }
  if (audio && audio.codec_name !== "aac") throw new Error(`FFprobe 验证失败：音频不是 AAC（${file}）`);
  const tolerance = Math.max(0.25, 2 / fps);
  if (!!audio === audioTarget.silent) throw new Error(`FFprobe 音轨与清单不符：${file}`);
  if (!close(Number(info.format.duration), audioTarget.target, tolerance)) {
    throw new Error(`成片时长 ${Number(info.format.duration).toFixed(2)} 秒与主音频 ${audioTarget.target.toFixed(2)} 秒不符`);
  }
  const videoDuration = Number(video.duration);
  if (!(videoDuration > 0) || videoDuration < audioTarget.target - tolerance) {
    throw new Error(`成片视频流时长不足或无法确认：${file}`);
  }
  if (audio) {
    const audioDuration = Number(audio.duration);
    if (!(audioDuration > 0) || audioDuration < audioTarget.target - tolerance) {
      throw new Error(`成片音轨时长不足或无法确认：${file}`);
    }
  }
  return { bytes: stat.size, duration: Number(info.format.duration), videoCodec: video.codec_name, audioCodec: audio?.codec_name ?? null };
}

async function writeManifest(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function receiptPath(context, row) { return path.join(context.deliveryDir, `${row.index + 1}.json`); }

async function readReceipt(context, row) {
  const file = receiptPath(context, row);
  const stat = await readLinkStat(file).catch(absentPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`第 ${row.index + 1} 条完成凭据不是普通文件`);
  const receipt = JSON.parse(await readText(file));
  if (receipt.version !== 1 || receipt.index !== row.index + 1 || !same(receipt.output, row.output)
    || receipt.rowSignature !== row.rowSignature) {
    throw new Error(`第 ${row.index + 1} 条已完成成片的工程或主音频被改写；请保持原交付行不变`);
  }
  return receipt;
}

async function publishReceipt(context, row, verified, renderedFile) {
  const file = receiptPath(context, row);
  const receipt = {
    version: 1, index: row.index + 1, output: row.output,
    bytes: verified.bytes, sha256: await sha256(renderedFile), duration: verified.duration,
    audioTarget: row.audio.target, silent: row.audio.silent,
    rowSignature: row.rowSignature, inputs: row.audio.inputs,
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

async function assertInputsUnchanged(row) {
  for (const input of row.audio.inputs) {
    const stat = await readStat(input.path);
    if (stat.size !== input.size || stat.mtimeMs !== input.mtimeMs || await sha256(input.path) !== input.sha256) {
      throw new Error(`第 ${row.index + 1} 条渲染期间主音频或工程发生变化，请重新核对清单`);
    }
  }
}

async function deliveryContext(options) {
  if (!options.workspace || !options["output-dir"]) throw new Error("需要 --workspace 和 --output-dir 指向本任务工作目录及输出目录");
  const workspace = await readPath(options.workspace);
  const outputDir = await readPath(options["output-dir"]);
  const deliveryDir = await readPath(path.join(workspace, "..", "delivery"));
  const contractPath = await readPath(path.join(deliveryDir, "contract.json"));
  if (!inside(deliveryDir, contractPath)) throw new Error("任务交付契约路径越界");
  const contract = JSON.parse(await readText(contractPath));
  const contractWorkspace = typeof contract.workspace === "string"
    ? await readPath(contract.workspace).catch(absentPath) : null;
  const contractOutputDir = typeof contract.outputDir === "string"
    ? await readPath(contract.outputDir).catch(absentPath) : null;
  if (contract.version !== 1 || !Array.isArray(contract.slots) || !contract.slots.length
    || contract.slots.length > 20 || !contractWorkspace || !contractOutputDir
    || !same(contractWorkspace, workspace) || !same(contractOutputDir, outputDir)
    || typeof contract.audioDir !== "string" || contract.taskId !== path.basename(path.dirname(workspace))) {
    throw new Error("任务交付契约无效或不属于当前任务");
  }
  if (!contract.slots.every((slot, index) => typeof slot === "string"
    && slot.startsWith(`Clip-Studio-${contract.taskId}-${index + 1}-`)
    && /^[a-f0-9]{8}\.mp4$/i.test(slot.slice(`Clip-Studio-${contract.taskId}-${index + 1}-`.length)))) {
    throw new Error("任务交付文件名与任务编号不符");
  }
  contract.workspace = workspace;
  contract.audioDir = await readPath(contract.audioDir);
  return { workspace, outputDir, deliveryDir, contract };
}

/** A schema-correct starting point; creative inputs stay with Pi. Existing
 * manifests are never overwritten, so a retry cannot erase completed rows. */
export async function createManifestTemplate(options) {
  if (!options.manifest) throw new Error("template 需要 --manifest 指向新清单文件");
  const context = await deliveryContext(options);
  const candidate = path.resolve(options.manifest);
  const parent = await readPath(path.dirname(candidate));
  const file = path.join(parent, path.basename(candidate));
  if (!inside(context.workspace, parent) || same(file, path.join(context.workspace, "media-policy.json"))) {
    throw new Error("模板必须写入当前任务工作目录中的新 JSON 文件，不能写入任务配置");
  }
  const project = options.project ?? "video-project";
  if (typeof project !== "string" || path.isAbsolute(project) || !inside(context.workspace, path.resolve(context.workspace, project))) {
    throw new Error("template --project 必须相对当前任务工作目录");
  }
  const manifest = {
    version: 1, project, settings: { format: "mp4", fps: 30, quality: "high" },
    rows: context.contract.slots.map((output, index) => ({
      composition: `compositions/${String(index + 1).padStart(2, "0")}.html`, output,
      ...(context.contract.silentDuration ? { silentDuration: context.contract.silentDuration } : { mainAudio: { source: "" } }),
      status: "pending",
    })),
  };
  try { await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("清单已存在，未覆盖。请读取并修正已有清单，保留已完成行；不要重新生成模板。");
    throw error;
  }
  return { manifest: file, rows: manifest.rows.length, next: "填写工程、composition 和 mainAudio.source；保持 version、rows 和 output 正式槽位不变。" };
}

export async function validatedManifest(options) {
  if (!options.manifest) throw new Error("run 需要 --manifest、--workspace 和 --output-dir");
  const { workspace, outputDir, deliveryDir, contract } = await deliveryContext(options);
  const manifestPath = await existingFieldPath(path.resolve(options.manifest), workspace, "manifest", "file");
  let manifest;
  try { manifest = JSON.parse(await readText(manifestPath)); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    invalid("JSON", "manifest", `JSON 解析失败：${error.message}`, "请修正 JSON 语法，不添加 Markdown 围栏或注释；用 template 创建初始格式。");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalid("ROOT", "manifest", "顶层必须是对象，不能直接使用数组", '结构为 {"version":1,"project":"video-project","rows":[...]}；可用 template 生成。');
  }
  if (manifest.version !== 1) invalid("VERSION", "version", "必须填写数字 1", "请保留顶层 version: 1；可用 template 生成标准格式。");
  if (!Array.isArray(manifest.rows)) {
    invalid("ROWS", "rows", "缺失或不是数组", "正式行必须放在顶层 rows 数组，不使用 renders/videos；可用 template 生成准确槽位。");
  }
  if (manifest.rows.length !== contract.slots.length) {
    invalid("ROW_COUNT", "rows.length", `要求 ${contract.slots.length} 行，实际 ${manifest.rows.length} 行`, "每个正式槽位对应一行，包括已完成行；不要删掉已完成行。");
  }
  if (typeof manifest.project !== "string" || !manifest.project.trim() || path.isAbsolute(manifest.project)) {
    invalid("PROJECT", "project", "项目路径必须相对任务工作目录", '例如 project: "video-project"，不要填写绝对路径或程序目录。');
  }
  const project = await existingFieldPath(path.resolve(workspace, manifest.project), workspace, "project", "directory");
  const settings = manifest.settings ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) invalid("SETTINGS", "settings", "必须是设置对象");
  if (![24, 30, 60].includes(settings.fps ?? 30)) invalid("FPS", "settings.fps", "必须是数字 24、30 或 60");
  if (!["standard", "high", "draft"].includes(settings.quality ?? "high")) invalid("QUALITY", "settings.quality", "必须是 standard、high 或 draft");
  if (settings.format && settings.format !== "mp4") invalid("FORMAT", "settings.format", "渲染清单仅支持 MP4", '请填写 format: "mp4"。');
  if (settings.crf !== undefined && (!Number.isInteger(settings.crf) || settings.crf < 0 || settings.crf > 51)) {
    invalid("CRF", "settings.crf", "CRF 必须是 0–51 的整数");
  }
  const seen = new Set();
  const rows = [];
  for (const [index, row] of manifest.rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) invalid("ROW", `rows[${index}]`, "每行必须是对象");
    if (typeof row.composition !== "string" || path.isAbsolute(row.composition) || !row.composition.endsWith(".html")) {
      invalid("COMPOSITION", `rows[${index}].composition`, `第 ${index + 1} 行的工程文件无效`, '请填写相对 project 的 HTML 路径，例如 "compositions/01.html"。');
    }
    const composition = await existingFieldPath(path.resolve(project, row.composition), project, `rows[${index}].composition`, "file");
    if (row.output !== contract.slots[index]) {
      invalid("OUTPUT", `rows[${index}].output`, `第 ${index + 1} 行输出文件名必须使用本任务预留位置：${contract.slots[index]}`, "请复制 template 中该行的 output，不能自行命名或将试片当作正式成片。");
    }
    const output = path.resolve(outputDir, row.output);
    if (!inside(outputDir, output) || output === outputDir) throw new Error(`第 ${index + 1} 行的输出路径越界`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const realParent = await readPath(path.dirname(output));
    if (!inside(outputDir, realParent)) throw new Error(`第 ${index + 1} 行的输出目录通过符号链接越界`);
    const existing = await readLinkStat(output).catch(absentPath);
    if (existing?.isSymbolicLink()) throw new Error(`第 ${index + 1} 行的输出是符号链接`);
    if (seen.has(output.toLowerCase())) throw new Error("渲染清单有重复输出路径");
    seen.add(output.toLowerCase());
    let audio;
    try { audio = await validateAudio(row, composition, project, contract, settings.fps ?? 30); }
    catch (error) {
      // Process, decoding and temporary I/O errors are not deterministic
      // manifest errors; do not turn them into a no-progress loop stop.
      if (/启动失败|退出码/.test(error.message) || (error.code && error.code !== "ENOENT")) throw error;
      invalid("MAIN_AUDIO", `rows[${index}].mainAudio / composition`, error.message,
        "请使用音频目录或工作目录中的主音频，核对 source/from/to/at/rate 与工程 <audio> 的相同区间；根 data-duration 按主音频时间线填写。不要改正式 output 槽位。");
    }
    const rowSignature = createHash("sha256").update(JSON.stringify({
      output: row.output, composition: row.composition, audioTarget: audio.target,
      silent: audio.silent, inputs: audio.inputs,
    })).digest("hex");
    const html = await readText(composition);
    const root = html.match(/<[a-z][^>]*\bdata-composition-id\s*=[^>]*>/i)?.[0] ?? "";
    const dimension = (name, fallback) => { const value = Number(attribute(root, name)); return value > 0 && value <= 16384 ? value : fallback; };
    const pixels = dimension("data-width", 1920) * dimension("data-height", 1080);
    const clips = [...html.matchAll(/<video\b[^>]*>/gi)].length;
    // Existing engineering only: no new source scan/probe. Working surfaces and
    // compressed frame buffers inform startup reservation; observed RSS refines it.
    const estimatedWorkerBytes = 768 * MiB + pixels * Math.max(8, clips * 4) * 4
      + (clips ? audio.target * (settings.fps ?? 30) * pixels / 8 : 0);
    rows.push({ index, composition, output, audio, rowSignature, estimatedWorkerBytes });
  }
  return { workspace, outputDir, deliveryDir, manifestPath, project, manifest, settings, rows, contract };
}

function cpuSnapshot() {
  return os.cpus().reduce((sum, core) => {
    sum.idle += core.times.idle;
    sum.total += Object.values(core.times).reduce((a, b) => a + b, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

export function cpuBusy(previous, current) {
  if (!previous) return 0;
  const total = current.total - previous.total;
  return total > 0 ? Math.max(0, Math.min(1, 1 - (current.idle - previous.idle) / total)) : 0;
}

async function workerResources(active) {
  try {
    let table, committedFreeBytes;
    if (process.platform === "win32") {
      const text = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$clipMemory = Get-CimInstance Win32_OperatingSystem; @{ processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CreationDate); commitFree = [double]$clipMemory.FreeVirtualMemory * 1024 } | ConvertTo-Json -Depth 4 -Compress"]);
      const sample = JSON.parse(text);
      committedFreeBytes = Number(sample.commitFree) > 0 ? Number(sample.commitFree) : undefined;
      table = sample.processes.map((item) => ({ pid: Number(item.ProcessId), parent: Number(item.ParentProcessId), bytes: Number(item.WorkingSetSize), born: String(item.CreationDate) }));
    } else {
      const text = await runCapture("ps", ["-eo", "pid=,ppid=,rss="]);
      table = text.trim().split(/\r?\n/).map((line) => {
        const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
        return { pid, parent, bytes: rss * 1024 };
      });
    }
    const measured = new Map();
    for (const [id, reservation] of active) {
      const child = reservation.child;
      if (!child?.pid) continue;
      const selected = new Set([child.pid]);
      for (let iteration = 0; iteration < table.length; iteration++) {
        let changed = false;
        for (const entry of table) if (selected.has(entry.parent) && !selected.has(entry.pid)) {
          selected.add(entry.pid); changed = true;
        }
        if (!changed) break;
      }
      child.descendants ??= new Map();
      for (const entry of table) if (selected.has(entry.pid) && entry.pid !== child.pid) child.descendants.set(entry.pid, entry.born);
      measured.set(id, table.filter((entry) => selected.has(entry.pid)).reduce((sum, entry) => sum + (entry.bytes || 0), 0));
    }
    return { measured, committedFreeBytes, known: true };
  } catch { return { measured: new Map(), known: false }; }
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await runCapture("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], 2000, true).catch(() => undefined);
    if (child.descendants?.size) {
      // A renderer can exit before its Chrome children. Check creation identity
      // before terminating any orphan; never kill a PID reused by another app.
      const text = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate) | ConvertTo-Json -Compress"], 2_000_000, true).catch(() => "[]");
      let current = [];
      try { current = [JSON.parse(text || "[]")].flat(); } catch { /* Do not substitute cleanup parsing for the real render error. */ }
      for (const item of current) if (child.descendants.get(Number(item.ProcessId)) === String(item.CreationDate))
        await runCapture("taskkill.exe", ["/PID", String(item.ProcessId), "/T", "/F"], 2000, true).catch(() => undefined);
    }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

async function renderOnce(context, row, temporary, gpu, logFile, reservation) {
  const { settings, project } = context;
  let prepared;
  try { prepared = await prepareRenderComposition(row, project); }
  catch (error) { error.failure = { stage: "prepare", kind: "resource-file", retryable: false, cause: publicError(error.message) }; throw error; }
  const args = [context.runtimeCli ?? hyperframesCli, "render", project, "--composition", path.relative(project, prepared.file),
    "--output", temporary, "--format", "mp4", "--quality", settings.quality ?? "high",
    "--fps", String(settings.fps ?? 30), "--workers", "1"];
  if (settings.resolution) args.push("--resolution", settings.resolution);
  if (settings.crf !== undefined) args.push("--crf", String(settings.crf));
  if (gpu) args.push("--gpu");
  try { await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, shell: false,
      detached: process.platform !== "win32", env: { ...process.env, CLIP_RENDER_QUEUE: "1",
        CLIP_RENDER_EXTRACT_WORKERS: String(reservation.extractWorkers), CLIP_RENDER_EXTRACT_THREADS: String(reservation.extractThreads),
        HF_VIDEO_EXTRACTION_MAX_RETRIES: "0",
        ...(reservation.captureFallback ? { PRODUCER_FORCE_SCREENSHOT: "true", PRODUCER_EXPERIMENTAL_FAST_CAPTURE: "false" } : {}) } });
    reservation.child = child;
    children.add(child);
    const stop = () => { void killTree(child); };
    context.signal.addEventListener("abort", stop, { once: true });
    if (context.signal.aborted) stop();
    let tail = "", lineBuffer = "", logBytes = 0, writeChain = Promise.resolve();
    const sources = [];
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-32_000);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop().slice(-32_000);
      for (const line of lines) { const detail = sourceDiagnostic(line); if (detail && sources.length < 20) sources.push(detail); }
      if (logBytes < 8 * MiB) {
        const safe = publicError(text, 32_000, true); logBytes += Buffer.byteLength(safe);
        writeChain = writeChain.then(() => fs.appendFile(logFile, `${safe}\n`)).catch(() => undefined);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => { children.delete(child); reject(new Error(`HyperFrames 启动失败：${error.message}`, { cause: error })); });
    child.on("close", async (code) => {
      try {
      const stopped = interrupted || context.signal.aborted;
      if (code !== 0 || stopped) await killTree(child);
      const finalDetail = sourceDiagnostic(lineBuffer); if (finalDetail && sources.length < 20) sources.push(finalDetail);
      await writeChain;
      if (code === 0 && !stopped) resolve();
      else {
        const failure = stopped ? { stage: "stop", kind: "aborted", retryable: false, cause: "渲染已停止" }
          : classifyRenderFailure(tail, sources, code);
        const error = new Error(`HyperFrames 退出码 ${code ?? "未知"}：${failure.cause}`);
        error.failure = failure; reject(error);
      }
      } catch (error) { reject(error); }
      finally { children.delete(child); context.signal.removeEventListener("abort", stop); }
    });
  }); await prepared.verify(); } finally { await prepared.dispose(); }
}

async function recoveryState(context) {
  const task = await readText(path.join(context.workspace, "..", "task.json")).then(JSON.parse).catch(absentPath);
  if (task && task.id !== context.contract.taskId) throw new Error("渲染恢复记录的任务身份不符");
  const attempt = task?.attemptStartedAt ?? task?.startedAt ?? "legacy";
  const file = path.join(context.deliveryDir, "render-recovery.json");
  const stat = await readLinkStat(file).catch(absentPath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("渲染恢复记录不是普通文件");
  const saved = stat && JSON.parse(await readText(file));
  if (saved && (saved.version !== 1 || saved.taskId !== context.contract.taskId || !saved.rows || typeof saved.rows !== "object"))
    throw new Error("渲染恢复记录损坏，未重置自动恢复额度");
  const state = saved?.attempt === attempt ? saved : { version: 1, taskId: context.contract.taskId, attempt, rows: {} };
  let chain = Promise.resolve();
  return { state, save: () => { const snapshot = structuredClone(state); chain = chain.then(() => writeManifest(file, snapshot)); return chain; } };
}

async function queueLock(context) {
  const file = path.join(context.deliveryDir, "render-queue.lock");
  try {
    const lock = await fs.open(file, "wx");
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, taskId: context.contract.taskId })); }
    finally { await lock.close(); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await readLinkStat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("渲染锁不是普通文件");
    const saved = JSON.parse(await readText(file));
    if (!Number.isInteger(saved.pid) || saved.pid <= 0 || saved.taskId !== context.contract.taskId) throw new Error("渲染锁身份无效");
    try { process.kill(saved.pid, 0); throw new Error("当前任务的渲染队列仍在运行，不重复启动"); }
    catch (cause) { if (cause.code !== "ESRCH") throw cause; }
    await fs.rm(file); return queueLock(context);
  }
  return () => fs.rm(file, { force: true });
}

/** Offline test hooks never enter the CLI protocol. */
export async function runQueue(options, hooks = {}) {
  const context = await validatedManifest(options);
  context.runtimeCli = hooks.runtimeCli;
  const controller = new AbortController();
  const stop = () => controller.abort();
  hooks.signal?.addEventListener("abort", stop, { once: true });
  if (hooks.signal?.aborted) stop();
  context.signal = controller.signal;
  context.cancel = stop;
  const unlock = await queueLock(context);
  try { return await executeQueue(context, hooks); }
  finally { hooks.signal?.removeEventListener("abort", stop); await unlock(); }
}

async function executeQueue(context, hooks) {
  const { manifest, manifestPath, workspace, rows } = context;
  const stopped = () => interrupted || context.signal.aborted;
  const recovery = await recoveryState(context);
  const logsDir = path.join(workspace, "render-logs");
  await fs.mkdir(logsDir, { recursive: true });
  let saveChain = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone(manifest);
    saveChain = saveChain.then(() => writeManifest(manifestPath, snapshot));
    return saveChain;
  };
  const pending = [];
  for (const row of rows) {
    const entry = manifest.rows[row.index];
    const existing = await readStat(row.output).catch(absentPath);
    if (existing) {
      const receipt = await readReceipt(context, row);
      if (!receipt) throw new Error(`第 ${row.index + 1} 条交付位置已有未知文件，未覆盖该文件`);
      try {
        const verified = await verifyVideo(row.output, row.audio, context.settings.fps ?? 30);
        if (receipt.bytes !== verified.bytes || receipt.sha256 !== await sha256(row.output))
          throw new Error("完成凭据与当前成片内容不符");
        entry.status = "completed"; entry.verified = verified; continue;
      } catch (error) { throw new Error(`第 ${row.index + 1} 条已有文件无法验证，未覆盖：${error.message}`); }
    }
    entry.status = "pending"; pending.push(row);
  }
  await save();
  const failures = [], active = new Map(), reservations = new Map();
  let lastCpu = cpuSnapshot(), observedWorkerBytes = 0, pressure = false;
  const sample = hooks.sample ?? workerResources, render = hooks.render ?? renderOnce;
  async function runRow(row, reservation) {
    const entry = manifest.rows[row.index];
    const temporary = path.join(path.dirname(row.output), `.clip-studio-${row.index + 1}-${randomUUID()}.mp4`);
    const logFile = path.join(logsDir, `render-${row.index + 1}-${String(recovery.state.attempt).replace(/[^\da-z]/gi, "_")}.log`);
    let record = recovery.state.rows[row.index];
    if (!record || record.signature !== row.rowSignature)
      record = recovery.state.rows[row.index] = { signature: row.rowSignature, attempts: 0 };
    try {
      if (record.attempts >= 2 || (record.attempts && record.failure?.retryable === false)) {
        const error = new Error(`[RENDER_EXHAUSTED] 本次执行已处理过相同工程，自动恢复额度已用完：${record.failure?.cause ?? "上次执行被中断"}。请修正真实错误，或点击原任务“重试 / 继续制作”；已完成成片保持不变。`);
        error.failure = { stage: record.failure?.stage ?? "render", kind: "exhausted", cause: error.message, retryable: false };
        throw error;
      }
      const previous = record.failure;
      record.attempts++; record.failure = undefined;
      // Durable before spawn; editing manifest status cannot reset the budget.
      await recovery.save();
      entry.status = "running"; entry.error = undefined; await save();
      const hardware = previous?.kind !== "hardware";
      reservation.captureFallback = previous?.stage === "capture";
      await render(context, row, temporary, hardware, logFile, reservation);
      entry.route = hardware ? "gpu-requested" : "software-fallback";
      if (previous) entry.fallbackReason = publicError(previous.cause);
      if (stopped()) throw new Error("渲染已停止");
      await assertInputsUnchanged(row);
      const verified = await verifyVideo(temporary, row.audio, context.settings.fps ?? 30);
      if (stopped()) throw new Error("渲染已停止，未发布最终文件");
      await publishReceipt(context, row, verified, temporary);
      if (stopped()) throw new Error("渲染已停止，未发布最终文件");
      await fs.rename(temporary, row.output);
      entry.status = "completed"; entry.verified = verified; entry.error = undefined;
      process.stdout.write(`完成 ${row.index + 1}/${rows.length}: ${row.output}\n`);
    } catch (error) {
      const failure = stopped() ? { stage: "stop", kind: "aborted", retryable: false, cause: "渲染已停止" }
        : error.failure ?? { stage: "verify/publish", kind: "verification", retryable: false, cause: publicError(error.message) };
      record.failure = failure;
      entry.error = rowFailureMessage(row.index, failure, path.relative(workspace, logFile), record.attempts);
      await fs.writeFile(path.join(logsDir, `failure-${row.index + 1}.json`), JSON.stringify({
        version: 1, row: row.index + 1, attempt: recovery.state.attempt, attempts: record.attempts,
        ...failure, log: path.relative(workspace, logFile),
      }) + "\n");
      if (!stopped() && failure.retryable && record.attempts < 2) {
        entry.status = "pending"; row.recovery = true; pending.unshift(row); pressure = true;
        process.stderr.write(`${entry.error}；等待其他渲染退出后低负载恢复一次\n`);
      } else { entry.status = "failed"; failures.push(entry.error); process.stderr.write(`${entry.error}\n`); }
    } finally {
      await fs.rm(temporary, { force: true });
      await recovery.save(); await save();
    }
  }
  try {
    while ((pending.length || active.size) && !stopped()) {
      const currentCpu = cpuSnapshot(), load = cpuBusy(lastCpu, currentCpu); lastCpu = currentCpu;
      const usage = await sample(reservations);
      for (const [id, bytes] of usage.measured) {
        observedWorkerBytes = Math.max(observedWorkerBytes, bytes);
        const reservation = reservations.get(id);
        if (reservation) reservation.bytes = Math.max(reservation.bytes, bytes * 1.3);
      }
      const budget = admissionBudget({
        active: active.size, logicalCpus: os.availableParallelism(), cpuBusy: load,
        freeBytes: os.freemem(), totalBytes: os.totalmem(), observedWorkerBytes,
        estimatedWorkerBytes: pending[0]?.estimatedWorkerBytes ?? 0, ...usage,
        reservations: [...reservations].map(([id, value]) => ({ id, bytes: value.bytes })),
      });
      const warming = [...reservations.keys()].some((id) => !(usage.measured.get(id) > 0));
      const singleOnly = [...reservations.values()].some((reservation) => reservation.lowLoad);
      if (pending.length && budget.admit && (!active.size || (!pressure && !warming && !singleOnly)) && !stopped()) {
        const row = pending.shift();
        const reservation = {
          bytes: budget.cost, extractWorkers: row.recovery ? 1 : budget.extractWorkers,
          extractThreads: row.recovery ? 1 : budget.extractThreads,
          lowLoad: row.recovery || budget.lowLoad,
        };
        // Reserve synchronously BEFORE runRow reaches any await.
        reservations.set(row.index, reservation);
        const promise = runRow(row, reservation).finally(() => { reservations.delete(row.index); active.delete(row.index); });
        active.set(row.index, promise);
        if (!row.recovery) pressure = false;
      }
      if (!pending.length && active.size) await Promise.race(active.values());
      else if (active.size) await Promise.race([new Promise((resolve) => setTimeout(resolve, hooks.pollMs ?? 3_000)), ...active.values()]);
    }
  } catch (error) {
    context.cancel();
    await Promise.allSettled([...reservations.values()].flatMap((row) => row.child ? [killTree(row.child)] : []));
    await Promise.allSettled(active.values()); throw error;
  }
  await Promise.allSettled(active.values());
  if (stopped()) throw new Error("渲染已停止，已验证成片保持不变");
  if (failures.length) throw new Error(`[RENDER_EXHAUSTED] ${failures.join("；")}`);
  return { completed: manifest.rows.filter((entry) => entry.status === "completed").length, total: rows.length, manifest: manifestPath };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--manifest", "--workspace", "--output-dir", "--project"].includes(rest[i]) || !rest[i + 1]
      || Object.hasOwn(options, rest[i].slice(2))) throw new Error(`参数不完整、未知或重复：${rest[i]}`);
    if (command === "run" && rest[i] === "--project") throw new Error("run 的工程路径在清单 project 字段中填写，不接受 --project");
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    interrupted = true;
    for (const child of [...children]) void killTree(child);
  });
  try {
    const argv = process.argv.slice(2);
    const usage = "用法：render-queue.mjs template|run --manifest <JSON> --workspace <任务工作目录> --output-dir <输出目录>。template 可加 --project <相对工程目录>，不会覆盖已有清单。";
    if ((argv.length === 1 && ["--help", "-h"].includes(argv[0]))
      || (argv.length === 2 && ["template", "run"].includes(argv[0]) && ["--help", "-h"].includes(argv[1]))) {
      process.stdout.write(`${usage}\n`);
    } else {
      const { command, options } = parseArgs(argv);
      if (!["run", "template"].includes(command)) throw new Error(usage);
      process.stdout.write(`${JSON.stringify(await (command === "template" ? createManifestTemplate(options) : runQueue(options)))}\n`);
    }
  } catch (error) {
    process.stderr.write(`render-queue: ${publicError(error.message)}\n`);
    process.exitCode = 1;
  }
}
