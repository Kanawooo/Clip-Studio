#!/usr/bin/env node
// Source-neutral media observations. Pi owns descriptions and edit decisions.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_VERSION = 1;
const EXTRACTION_REVISION = 3;
// Changing a contact-sheet format must not invalidate expensive extracted frames.
const SHEET_REVISION = 2;
const ANALYSIS_VERSION = 1;
const MAX_SHEET = 2000;
const MAX_FRAMES = 25;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const cacheRoot = path.join(projectRoot, ".runtime", "media-cache", `v${CACHE_VERSION}`);
const ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe";

function runtime(overrides = {}) {
  return { cacheRoot, ffmpeg, ffprobe, ...overrides };
}

export function automaticParallelism(count, memoryPerJob = 512 * 1024 * 1024, resources = {}) {
  const cpus = resources.cpus ?? os.availableParallelism();
  const freeMemory = resources.freeMemory ?? os.freemem();
  return Math.max(1, Math.min(count || 1, Math.max(1, Math.floor(cpus / 2)),
    Math.max(1, Math.floor(freeMemory * 0.6 / memoryPerJob))));
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index; (index = cursor++) < items.length;) results[index] = await operation(items[index], index);
  }));
  return results;
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function taskInput(workspace, file) {
  const real = await fs.realpath(file);
  if (!inside(workspace, real)) throw new Error("分析清单/文本必须位于当前任务工作目录");
  return real;
}

export async function taskOutput(workspace, file) {
  const supplied = path.resolve(file);
  const existing = await fs.lstat(supplied).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && existing.nlink > 1)) throw new Error("输出不能覆盖任务策略或符号/硬链接");
  // Canonicalize the nearest existing ancestor before mkdir, including Windows
  // long/8.3 aliases. A future directory must not be created outside the task.
  const missing = [];
  let ancestor = supplied;
  for (;;) {
    try { await fs.lstat(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const out = path.join(await fs.realpath(ancestor), ...missing);
  if (out === workspace || !inside(workspace, out)) throw new Error("输出必须位于当前任务工作目录内");
  await fs.mkdir(path.dirname(out), { recursive: true });
  if (!inside(workspace, await fs.realpath(path.dirname(out)))) throw new Error("输出目录不能通过链接离开当前任务工作目录");
  const policyFile = path.join(workspace, "media-policy.json");
  const policy = await fs.stat(policyFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (out.toLowerCase() === policyFile.toLowerCase() || existing?.isSymbolicLink()
    || (existing && (existing.nlink > 1 || (policy && existing.ino === policy.ino && existing.dev === policy.dev)))) {
    throw new Error("输出不能覆盖任务策略或符号/硬链接");
  }
  return out;
}

async function writeTaskJson(workspace, file, value) {
  const target = await taskOutput(workspace, file);
  const temporary = await taskOutput(workspace, `${target}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  try { await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return target;
}

export async function readMediaPolicy(workspace) {
  workspace = await fs.realpath(workspace);
  const fallback = { version: 1, taskId: createHash("sha256").update(workspace).digest("hex"), reuseVisualAnalysis: false };
  try {
    const policyFile = await taskInput(workspace, path.join(workspace, "media-policy.json"));
    const policy = JSON.parse(await fs.readFile(policyFile, "utf8"));
    if (policy.version !== 1 || typeof policy.taskId !== "string" || !policy.taskId
      || typeof policy.reuseVisualAnalysis !== "boolean") throw new Error("media-policy.json 需要 version:1、taskId 和布尔 reuseVisualAnalysis");
    return { ...policy, reuseVisualAnalysis: false };
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// A writable index is an observation artifact, never a source authorization.
// New tasks carry these roots in the immutable policy; old task workspaces can
// recover them from the backend-owned task record outside the writable scope.
export async function mediaAccess(workspace) {
  const policy = await readMediaPolicy(workspace);
  let inputs = policy.inputs;
  if (!inputs) {
    const taskDir = path.dirname(workspace);
    const taskFile = await fs.realpath(path.join(taskDir, "task.json"));
    if (!inside(taskDir, taskFile)) throw new Error("任务媒体配置路径越界");
    const task = JSON.parse(await fs.readFile(taskFile, "utf8"));
    if (task.schemaVersion !== 3 || task.id !== path.basename(taskDir)) throw new Error("任务媒体配置不属于当前任务");
    inputs = task.input;
  }
  if (!inputs || ["referenceVideo", "assetsDir", "audioDir"].some((key) => typeof inputs[key] !== "string" || !inputs[key])) {
    throw new Error("任务媒体访问范围缺失，请在原任务重试恢复配置");
  }
  const [reference, assets, audio] = await Promise.all([inputs.referenceVideo, inputs.assetsDir, inputs.audioDir].map((file) => fs.realpath(file)));
  const equal = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return {
    reference, assets, audio, policy,
    async file(file, kind) {
      const real = await fs.realpath(file);
      const allowed = kind === "reference" ? equal(real, reference)
        : kind === "source" ? inside(assets, real) || inside(workspace, real)
          : kind === "audio" ? inside(audio, real) || inside(workspace, real)
            : equal(real, reference) || inside(assets, real) || inside(audio, real) || inside(workspace, real);
      if (!allowed) throw new Error("媒体文件不在本任务已选路径或工作目录内；请重新执行 index 使用本任务素材");
      return real;
    },
  };
}

export function displayGeometry(stream) {
  const sar = ratio(stream.sample_aspect_ratio) || 1;
  const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0);
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const width = sideways ? Number(stream.height) : Number(stream.width) * sar;
  const height = sideways ? Number(stream.width) * sar : Number(stream.height);
  if (!(width > 0 && height > 0)) throw new Error("FFprobe 未提供有效画面尺寸");
  return { width, height, aspect: width / height, rotation, sampleAspectRatio: sar };
}

function ratio(value) {
  if (typeof value !== "string") return 0;
  const [a, b] = value.split(":").map(Number);
  return a > 0 && b > 0 ? a / b : 0;
}

export function sheetLayout(count, aspect, bound = MAX_SHEET) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES || !(aspect > 0)) throw new Error("无效的宫格参数");
  let best;
  const gap = 8;
  const label = bound <= MAX_SHEET ? 32 : 40;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const availableWidth = Math.floor((bound - gap * (columns + 1)) / columns);
    const availableHeight = Math.floor((bound - gap * (rows + 1)) / rows) - label;
    const frameHeight = Math.min(availableHeight, Math.floor(availableWidth / aspect));
    const frameWidth = Math.floor(frameHeight * aspect);
    if (frameWidth < 2 || frameHeight < 2) continue;
    const cellWidth = Math.floor(frameWidth / 2) * 2;
    const cellHeight = Math.floor((frameHeight + label) / 2) * 2;
    const score = cellWidth * (cellHeight - label);
    if (!best || score > best.score) best = { columns, rows, cellWidth, cellHeight, gap, label, score };
  }
  if (!best) throw new Error("宫格边界过小");
  return best;
}

export function sheetBatchSize(remaining, aspect, bound = MAX_SHEET) {
  for (let count = Math.min(remaining, MAX_FRAMES); count > 1; count--) {
    try {
      const layout = sheetLayout(count, aspect, bound);
      const short = Math.min(layout.cellWidth, layout.cellHeight - layout.label);
      const long = Math.max(layout.cellWidth, layout.cellHeight - layout.label);
      if (short >= 224 && long >= 384) return count;
    } catch { /* Extreme source ratios need fewer frames, never stretching. */ }
  }
  return 1;
}

export function sampleTimes(duration, kind) {
  if (!(duration > 0)) return [0];
  const spacing = kind === "reference" || duration <= 15 ? 1 : 3;
  const times = [];
  for (let t = 0; t < duration; t += spacing) times.push(t);
  const end = Math.max(0, duration - 1);
  if (end - times.at(-1) >= Math.min(1, spacing / 2)) times.push(end);
  return times;
}

async function run(command, args, timeout = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(command)} 超过 ${Math.ceil(timeout / 1000)} 秒，已结束本次调用`)); }, timeout);
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`${path.basename(command)} 启动失败：${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "未知"}：${stderr.trim() || "未提供详细原因"}`));
    });
  });
}

async function probe(file, context = runtime()) {
  const data = JSON.parse(await run(context.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const stream = data.streams?.find((entry) => entry.codec_type === "video");
  const duration = Number(data.format?.duration ?? stream?.duration ?? 0);
  return { duration, stream, audio: data.streams?.filter((entry) => entry.codec_type === "audio").map((entry) => ({ codec: entry.codec_name, channels: entry.channels, sampleRate: entry.sample_rate })) ?? [] };
}

export async function fingerprint(file) {
  const real = await fs.realpath(file);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`不是媒体文件：${real}`);
  const hash = createHash("sha256").update(String(EXTRACTION_REVISION)).update(real.toLowerCase()).update(String(stat.size)).update(String(stat.mtimeMs));
  const handle = await fs.open(real, "r");
  try {
    for (const offset of [0, Math.max(0, stat.size - 65_536)]) {
      const sample = Buffer.alloc(Math.min(stat.size, 65_536));
      await handle.read(sample, 0, sample.length, offset);
      hash.update(sample);
    }
  } finally { await handle.close(); }
  return { real, size: stat.size, mtimeMs: stat.mtimeMs, key: hash.digest("hex") };
}

async function extract(file, at, output, longEdge = 1280, context = runtime()) {
  const filter = `scale=w='min(iw,${longEdge})':h='min(ih,${longEdge})':force_original_aspect_ratio=decrease:reset_sar=1,format=yuvj420p`;
  const common = ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", filter, "-q:v", "3", "-y", output];
  try {
    await run(context.ffmpeg, ["-hwaccel", "auto", ...common]);
    if (!(await fs.stat(output).then((info) => info.size, () => 0))) throw new Error("未生成画面");
    return "hardware";
  } catch (hardwareError) {
    await fs.rm(output, { force: true });
    try {
      await run(context.ffmpeg, common);
      if (!(await fs.stat(output).then((info) => info.size, () => 0))) throw new Error("未生成画面");
      return "software";
    }
    catch (softwareError) { throw new Error(`抽帧硬件路径失败：${hardwareError.message}；软件路径失败：${softwareError.message}`); }
  }
}

async function extractTimeline(file, duration, kind, directory, context = runtime(), offset = 0, limited = false) {
  const spacing = kind === "reference" || duration <= 15 ? 1 : 3;
  const pattern = path.join(directory, "frame-%05d.jpg");
  const filter = `fps=1/${spacing}:start_time=0,scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:reset_sar=1,format=yuvj420p`;
  const common = ["-hide_banner", "-loglevel", "error", ...(context.decodeThreads ? ["-threads", String(context.decodeThreads)] : []),
    ...(offset ? ["-ss", String(offset)] : []), "-i", file, ...(limited ? ["-t", String(duration)] : []),
    "-vf", filter, "-q:v", "3", "-y", pattern];
  let route = "hardware";
  try { await run(context.ffmpeg, ["-hwaccel", "auto", ...common]); }
  catch (hardwareError) {
    route = "software";
    for (const fileName of await fs.readdir(directory)) {
      if (/^frame-\d+\.jpg$/.test(fileName)) await fs.unlink(path.join(directory, fileName));
    }
    try { await run(context.ffmpeg, common); }
    catch (softwareError) { throw new Error(`抽帧硬件路径失败：${hardwareError.message}；软件路径失败：${softwareError.message}`); }
  }
  const names = (await fs.readdir(directory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
  if (!names.length) throw new Error("FFmpeg 抽帧完成但未生成画面");
  const frames = names.map((name, index) => ({ at: offset + index * spacing, name, path: path.join(directory, name) }));
  const tail = offset + Math.max(0, duration - 1);
  if (tail - frames.at(-1).at >= Math.min(1, spacing / 2)) {
    const name = `frame-${String(frames.length + 1).padStart(5, "0")}.jpg`;
    await extract(file, tail, path.join(directory, name), 1280, context);
    frames.push({ at: tail, name, path: path.join(directory, name) });
  }
  return { frames, route };
}

export async function sheet(frames, target, aspect, sourceId, bound = MAX_SHEET, context = runtime()) {
  const layout = sheetLayout(frames.length, aspect, bound);
  const { columns, rows, cellWidth, cellHeight, gap, label } = layout;
  const args = ["-hide_banner", "-loglevel", "error"];
  for (const frame of frames) args.push("-threads", "1", "-i", frame.path);
  const filters = frames.map((frame, i) => {
    const stamp = new Date(frame.at * 1_000).toISOString().slice(11, 19).replaceAll(":", "-");
    const text = cellWidth < 230 ? stamp : `${sourceId} ${stamp}`;
    const fontSize = Math.max(10, Math.min(bound <= MAX_SHEET ? 20 : 26, Math.floor((cellWidth - 16) / text.length * 1.5)));
    return `[${i}:v]scale=w='min(iw,${cellWidth})':h='min(ih,${cellHeight - label})':force_original_aspect_ratio=decrease:flags=lanczos,pad=${cellWidth}:${cellHeight}:(${cellWidth}-iw)/2:(${cellHeight - label}-ih)/2:black,drawtext=text='${text}':fontcolor=white:fontsize=${fontSize}:x=8:y=${cellHeight - label + 5}[v${i}]`;
  });
  const inputs = frames.map((_, i) => `[v${i}]`).join("");
  const positions = frames.map((_, i) => `${gap + (i % columns) * (cellWidth + gap)}_${gap + Math.floor(i / columns) * (cellHeight + gap)}`).join("|");
  const width = columns * (cellWidth + gap) + gap;
  const height = rows * (cellHeight + gap) + gap;
  const stack = frames.length === 1 ? `[v0]pad=${width}:${height}:${gap}:${gap}:black,format=yuvj420p[out]`
    : `${inputs}xstack=inputs=${frames.length}:layout=${positions}:fill=black,pad=${width}:${height}:0:0:black,format=yuvj420p[out]`;
  const encoding = [...args, "-filter_complex_threads", "1", "-filter_complex", [...filters, stack].join(";"), "-map", "[out]", "-frames:v", "1"];
  let bytes = 0;
  for (const quality of [3, 5, 7]) {
    await run(context.ffmpeg, [...encoding, "-q:v", String(quality), "-y", target]);
    bytes = (await fs.stat(target)).size;
    if (bytes < MAX_IMAGE_BYTES) break;
  }
  if (bytes >= MAX_IMAGE_BYTES) throw new Error("概览 JPEG 仍超过原生读图大小，使用更少帧或 detail 查看");
  return { ...layout, width, height, mimeType: "image/jpeg", bytes, frameCount: frames.length,
    path: target, firstSecond: frames[0].at, lastSecond: frames.at(-1).at };
}

async function createSheets(frames, directory, aspect, sourceId, context, maximum = MAX_FRAMES, bound = MAX_SHEET) {
  const sheets = [];
  for (let offset = 0; offset < frames.length;) {
    const count = Math.min(maximum, sheetBatchSize(frames.length - offset, aspect, bound));
    const name = `sheet-r${SHEET_REVISION}-${String(sheets.length + 1).padStart(3, "0")}.jpg`;
    const info = await sheet(frames.slice(offset, offset + count), path.join(directory, name), aspect, sourceId, bound, context);
    sheets.push({ name, ...info, path: undefined });
    offset += count;
  }
  return sheets;
}

export async function cacheFile(file, kind, overrides = {}) {
  const context = runtime(overrides);
  if (!["reference", "source", "audio"].includes(kind)) throw new Error("kind 必须是 reference、source 或 audio");
  const identity = await fingerprint(file);
  const kindRoot = path.join(context.cacheRoot, kind);
  const target = path.join(kindRoot, identity.key);
  let invalidExisting = false;
  try {
    let entry = JSON.parse(await fs.readFile(path.join(target, "entry.json"), "utf8"));
    if (entry.version === CACHE_VERSION && entry.source === identity.real && entry.complete === true && entry.kind === kind) {
      await Promise.all(entry.frames.map((item) => fs.stat(path.join(target, item.name))));
      const sheetsReady = entry.sheetRevision === SHEET_REVISION && await Promise.all(entry.sheets.map((item) =>
        fs.stat(path.join(target, item.name)).then(() => true, () => false))).then((values) => values.every(Boolean));
      if (!sheetsReady) {
        const frames = entry.frames.map((frame) => ({ ...frame, path: path.join(target, frame.name) }));
        const sheets = frames.length ? await createSheets(frames, target, entry.geometry.aspect, identity.key.slice(0, 8), context) : [];
        entry = { ...entry, sheets, sheetRevision: SHEET_REVISION, sourceKey: identity.key };
        await writeCacheEntry(target, entry);
      }
      return { ...entry, sourceKey: identity.key, cacheHit: true, directory: target };
    }
    invalidExisting = true;
  } catch {
    invalidExisting = await fs.stat(target).then(() => true, () => false);
  }
  await fs.mkdir(kindRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(kindRoot, ".pending-"));
  try {
    const media = await probe(identity.real, context);
    const isVideo = Boolean(media.stream);
    const geometry = isVideo ? displayGeometry(media.stream) : undefined;
    const { frames, route } = isVideo
      ? await extractTimeline(identity.real, media.duration, kind, temporary, context)
      : { frames: [], route: "none" };
    const sheets = isVideo ? await createSheets(frames, temporary, geometry.aspect, identity.key.slice(0, 8), context) : [];
    const entry = {
      version: CACHE_VERSION, complete: true, kind, source: identity.real,
      size: identity.size, mtimeMs: identity.mtimeMs, duration: media.duration,
      geometry, audio: media.audio, frames: frames.map(({ at, name }) => ({ at, name })),
      sheets, extractionRoute: route, observation: null, transcript: null,
      sourceKey: identity.key, sheetRevision: SHEET_REVISION,
    };
    await fs.writeFile(path.join(temporary, "entry.json"), JSON.stringify(entry, null, 2));
    if (invalidExisting) {
      const stale = path.join(kindRoot, `.stale-${identity.key}-${randomUUID()}`);
      await fs.rename(target, stale);
    }
    try { await fs.rename(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await fs.rm(temporary, { recursive: true });
    }
    return { ...entry, cacheHit: false, directory: target };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function writeCacheEntry(directory, entry) {
  const target = path.join(directory, "entry.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entry));
  try { await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function listMedia(dir, extensions) {
  const files = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await listMedia(full, extensions));
    else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase())) files.push(full);
  }
  return files.sort();
}

// Give Pi task-local pictures. The shared cache remains an internal CLI detail;
// native Pi reads never need access to observations from another task.
export async function materializeTaskView(item, workspace, kind) {
  const workspaceReal = await fs.realpath(workspace);
  const policy = await readMediaPolicy(workspaceReal);
  const viewDir = path.join(workspaceReal, "media-views", createHash("sha256").update(kind).update(item.directory).digest("hex"));
  await fs.mkdir(viewDir, { recursive: true });
  const realViewDir = await fs.realpath(viewDir);
  const relative = path.relative(workspaceReal, realViewDir);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("素材视图目录离开当前任务工作目录");
  }
  const localCopy = async (name) => {
    if (path.basename(name) !== name) throw new Error("缓存图片名称不是普通文件名");
    const target = await taskOutput(workspaceReal, path.join(viewDir, name));
    await fs.copyFile(path.join(item.directory, name), target);
    return target;
  };
  const frames = await Promise.all(item.frames.map(async (frame) => ({ at: frame.at, path: await localCopy(frame.name) })));
  const sheets = await Promise.all(item.sheets.map(async (entry) => ({ ...entry, path: await localCopy(entry.name) })));
  const sourceKey = item.sourceKey ?? path.basename(item.directory);
  const local = await fs.readFile(path.join(viewDir, "analysis.json"), "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return {};
    throw error;
  });
  const sameTask = local.sourceKey === sourceKey && local.taskId === policy.taskId ? local : {};
  const sourceObservation = sameTask.observationRecord ??
    (item.observationRecord?.originTaskId === policy.taskId
      ? item.observationRecord ?? item.observation : null);
  const analysis = {
    observation: analysisRecord(sourceObservation, sourceKey, item.duration),
    transcript: analysisRecord(sameTask.transcriptRecord ?? item.transcriptRecord ?? item.transcript, sourceKey, item.duration),
  };
  const view = {
    source: item.source, cacheHit: item.cacheHit, duration: item.duration,
    kind, sourceKey, geometry: item.geometry, audio: item.audio,
    observation: analysis.observation.text, transcript: analysis.transcript.text,
    analysis, frames, sheets, entry: path.join(viewDir, "entry.json"),
  };
  // Task views expose only current-task observations, not shared foreign text.
  await writeTaskJson(workspaceReal, view.entry, view);
  return view;
}

export async function indexTask(options, overrides = {}) {
  if (!options.workspace) throw new Error("index 需要 --workspace 以保存素材索引");
  if (!options.reference || !options.assets || !options.audio) throw new Error("index 需要 --reference、--assets 和 --audio");
  const context = runtime(overrides);
  const workspace = await fs.realpath(options.workspace);
  const access = await mediaAccess(workspace);
  await access.file(options.reference, "reference");
  for (const [option, expected] of [[options.assets, access.assets], [options.audio, access.audio]]) {
    if ((await fs.realpath(option)).toLowerCase() !== expected.toLowerCase()) throw new Error("index 必须使用本任务已选目录");
  }
  const videos = await listMedia(path.resolve(options.assets), VIDEO_EXT);
  const audio = await listMedia(path.resolve(options.audio), AUDIO_EXT);
  const jobs = [{ file: options.reference, kind: "reference" },
    ...videos.map((file) => ({ file, kind: "source" })), ...audio.map((file) => ({ file, kind: "audio" }))];
  const concurrency = automaticParallelism(jobs.length, undefined, context.resources);
  const workerContext = { ...context, decodeThreads: Math.max(1, Math.floor((context.resources?.cpus ?? os.availableParallelism()) / concurrency)) };
  const items = await mapConcurrent(jobs, concurrency, async ({ file, kind }) => cacheFile(await access.file(file, kind), kind, workerContext));
  const [reference] = items;
  const sources = items.slice(1, 1 + videos.length), sounds = items.slice(1 + videos.length);
  const result = {
    reference: await materializeTaskView(reference, workspace, "reference"),
    sources: await Promise.all(sources.map((item) => materializeTaskView(item, workspace, "source"))),
    audio: await Promise.all(sounds.map((item) => materializeTaskView(item, workspace, "audio"))),
  };
  const indexFile = path.join(workspace, "media-index.json");
  await writeTaskJson(workspace, indexFile, result);
  const overviewFile = await saveOverview(workspace, result);
  return { catalogFile: path.join(workspace, "media-catalog.jsonl"), overviewFile, indexFile, sourceCount: sources.length, audioCount: sounds.length,
    sourceCacheHits: sources.filter((item) => item.cacheHit).length, concurrency };
}

export function analysisRecord(record, sourceKey, duration) {
  const absent = { state: "absent", text: null, coverage: [] };
  if (record == null || record === "") return absent;
  if (typeof record === "string") return { version: 0, state: "partial", text: record, coverage: [] };
  if (record.version !== ANALYSIS_VERSION || record.sourceKey !== sourceKey || typeof record.text !== "string") {
    return { state: "incompatible", text: null, coverage: [] };
  }
  let coverage;
  try { coverage = normalizeCoverage(record.coverage ?? [], duration); }
  catch { return { state: "incompatible", text: null, coverage: [] }; }
  const full = record.complete === true && coverage.length === 1 && coverage[0][0] <= 0.05 && coverage[0][1] >= duration - 0.05;
  return { ...record, coverage, state: full ? "full" : "partial" };
}

// Read only the relevant task-local views. No decoding, probing, cache writes or model calls.
// Invalid/legacy/foreign records fail closed: their images remain in native context.
export function createVisualEvidenceReader(workspace) {
  const identities = new Map();
  return (images) => visualEvidence({ workspace, images }, identities);
}

export async function visualEvidence({ workspace, images }, identities = new Map()) {
  workspace = await fs.realpath(workspace);
  const access = await mediaAccess(workspace);
  const entries = new Map();
  const result = [];
  for (const image of images) {
    try {
      const actual = await taskInput(workspace, image);
      const entryFile = path.join(path.dirname(actual), "entry.json");
      let view = entries.get(entryFile);
      if (!view) {
        view = JSON.parse(await fs.readFile(await taskInput(workspace, entryFile), "utf8"));
        const source = await access.file(view.source, view.kind);
        const stat = await fs.stat(source);
        const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        let identity = identities.get(source);
        if (!identity || identity.signature !== signature) {
          identity = { signature, key: (await fingerprint(source)).key };
          identities.set(source, identity);
        }
        if (identity.key !== view.sourceKey) continue;
        entries.set(entryFile, view);
      }
      const record = analysisRecord(view.analysis?.observation, view.sourceKey, view.duration);
      if (!["partial", "full"].includes(record.state) || record.originTaskId !== access.policy.taskId
        || !record.text?.trim() || !Number.isFinite(Date.parse(record.createdAt))) continue;
      const sheet = view.sheets?.find((item) => path.resolve(item.path).toLowerCase() === actual.toLowerCase());
      const frame = view.frames?.find((item) => path.resolve(item.path).toLowerCase() === actual.toLowerCase());
      const from = sheet?.firstSecond ?? frame?.at, to = sheet?.lastSecond ?? frame?.at;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from
        || !record.coverage.some(([start, end]) => start <= from && end >= to)) continue;
      result.push({ path: actual, entry: entryFile, source: view.source, sourceKey: view.sourceKey, from, to,
        text: record.text, createdAt: record.createdAt });
    } catch { /* A missing/changed image or record is retained, not guessed. */ }
  }
  return result;
}

function normalizeCoverage(coverage, duration) {
  if (!Array.isArray(coverage)) throw new Error("coverage 必须是 [[开始秒,结束秒]]");
  const sorted = coverage.map((range) => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
      || range[0] < 0 || range[1] <= range[0] || range[1] > duration + 0.05) throw new Error("coverage 时间区间必须位于媒体时长内");
    return [range[0], Math.min(duration, range[1])];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 0.05) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function newRecord(value, item, policy, config) {
  const input = typeof value === "string" ? { text: value } : value;
  if (!input || typeof input.text !== "string" || !input.text.trim()) throw new Error("分析记录 text 必须是已有分析产生的非空文字");
  if (input.text.length > 100_000) throw new Error("分析记录 text 超过 100000 字符");
  if (/\b(?:sk-[A-Za-z0-9_-]{8,}|authorization\s*:|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9_-]{8,})/i.test(input.text)) {
    throw new Error("分析记录包含疑似密钥，拒绝写入缓存");
  }
  if (input.complete !== undefined && typeof input.complete !== "boolean") throw new Error("complete 必须是布尔值");
  const coverage = normalizeCoverage(input.coverage ?? [], item.duration);
  if (input.complete && !(coverage.length === 1 && coverage[0][0] <= 0.05 && coverage[0][1] >= item.duration - 0.05)) {
    throw new Error("complete:true 需要覆盖整段媒体的 coverage；局部观察请使用 complete:false");
  }
  return { version: ANALYSIS_VERSION, sourceKey: item.sourceKey, originTaskId: policy.taskId,
    createdAt: new Date().toISOString(), text: input.text, coverage, complete: input.complete === true,
    ...(config ? { config: normalizedTranscriptConfig(config) } : {}) };
}

const summary = (view) => ({
  id: mediaId(view), source: view.source, kind: view.kind, sourceKey: view.sourceKey, duration: view.duration,
  cacheHit: view.cacheHit, geometry: view.geometry, entry: view.entry,
  sheets: view.sheets.map(({ path: sheetPath, firstSecond, lastSecond, frameCount, width, height }) =>
    ({ path: sheetPath, firstSecond, lastSecond, frameCount, width, height })),
  observation: view.observation?.slice(0, 600) ?? null,
  observationState: view.analysis?.observation.state ?? "absent",
  transcriptState: view.analysis?.transcript.state ?? "absent",
});

export function mediaId(view) {
  // Full identity remains internal; extending colliding prefixes is deterministic across list order.
  const prefix = { reference: "ref", source: "src", audio: "aud" }[view.kind];
  return `${prefix}-${createHash("sha256").update(`${view.kind}:${view.sourceKey}`).digest("hex").slice(0, 12)}`;
}

export function mediaIds(views) {
  const hashes = views.map((view) => createHash("sha256").update(`${view.kind}:${view.sourceKey}`).digest("hex"));
  return views.map((view, index) => {
    let length = 12;
    while (hashes.some((hash, other) => other !== index && hash !== hashes[index]
      && hash.slice(0, length) === hashes[index].slice(0, length))) length += 2;
    return { ...view, id: `${mediaId(view).split("-")[0]}-${hashes[index].slice(0, length)}` };
  });
}

async function saveCatalog(workspace, index) {
  const rows = mediaIds([{ ...index.reference, kind: "reference" },
    ...index.sources.map((view) => ({ ...view, kind: "source" })),
    ...index.audio.map((view) => ({ ...view, kind: "audio" }))]).map((view) => ({
    id: view.id, name: path.basename(view.source), seconds: view.duration,
    ...(view.geometry ? { aspect: Number(view.geometry.aspect.toFixed(4)) } : {}),
    pages: view.sheets.length, observation: view.analysis?.observation.state ?? "absent",
    transcript: view.analysis?.transcript.state ?? "absent",
  }));
  const target = await taskOutput(workspace, path.join(workspace, "media-catalog.jsonl"));
  const temporary = await taskOutput(workspace, `${target}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  try { await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return target;
}

async function saveOverview(workspace, index, offset = 0, limit = 25) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("overview --offset 需非负整数，--limit 需 1–100");
  await saveCatalog(workspace, index);
  const ids = new Map(mediaIds([{ ...index.reference, kind: "reference" },
    ...index.sources.map((view) => ({ ...view, kind: "source" })),
    ...index.audio.map((view) => ({ ...view, kind: "audio" }))]).map((view) => [`${view.kind}:${view.sourceKey}`, view.id]));
  const compact = (view) => ({ id: ids.get(`${view.kind}:${view.sourceKey}`), source: view.source, duration: view.duration, cacheHit: view.cacheHit,
    ...(view.geometry ? { aspect: Number(view.geometry.aspect.toFixed(4)) } : {}),
    sheets: view.sheets.map((entry) => ({ path: entry.path, from: entry.firstSecond, to: entry.lastSecond })),
    observationState: view.analysis.observation.state, observation: view.observation?.slice(0, 160) ?? null,
    transcriptState: view.analysis.transcript.state });
  return writeTaskJson(workspace, path.join(workspace, "media-overview.json"), {
    sourceCount: index.sources.length, audioCount: index.audio.length, offset, limit,
    nextOffset: offset + limit < index.sources.length ? offset + limit : null,
    reference: compact(index.reference), sources: index.sources.slice(offset, offset + limit).map(compact),
    audio: index.audio.map(compact),
  });
}

async function indexedSources(workspace, validateAll = true) {
  const file = await taskInput(workspace, path.join(workspace, "media-index.json"));
  const index = JSON.parse(await fs.readFile(file, "utf8"));
  if (!index.reference || !Array.isArray(index.sources) || !Array.isArray(index.audio)) throw new Error("media-index.json 无效，请先执行 index");
  const all = mediaIds([{ ...index.reference, kind: "reference" },
    ...index.sources.map((item) => ({ ...item, kind: "source" })), ...index.audio.map((item) => ({ ...item, kind: "audio" }))]);
  const access = await mediaAccess(workspace);
  if (validateAll) for (const item of all) await access.file(item.source, item.kind);
  return { index, all, policy: access.policy };
}

async function matchIndexed(all, file, kind, id) {
  if (id !== undefined) {
    if (file !== undefined) throw new Error("file 和 id 只能填写一个");
    const item = all.find((entry) => entry.id === id && (!kind || entry.kind === kind));
    if (!item) throw new Error(`未知素材 id：${id}；读取 media-catalog.jsonl 获取准确标识`);
    if ((await fingerprint(item.source)).key !== item.sourceKey) throw new Error(`素材 ${id} 已变化，请重新执行 index`);
    return item;
  }
  if (typeof file !== "string") throw new Error("分析清单每行需要 file");
  const real = await fs.realpath(file);
  const item = all.find((entry) => entry.source.toLowerCase() === real.toLowerCase() && entry.kind === kind);
  if (!item) throw new Error(`file/kind 不在本任务素材索引内：${path.basename(real)} (${kind})，先执行 index`);
  return item;
}

async function replaceIndexView(workspace, index, view) {
  if (view.kind === "reference") index.reference = view;
  else {
    const list = view.kind === "audio" ? index.audio : index.sources;
    const position = list.findIndex((item) => item.source.toLowerCase() === view.source.toLowerCase());
    if (position < 0) throw new Error("素材记录不在当前任务索引内");
    list[position] = view;
  }
  await writeTaskJson(workspace, path.join(workspace, "media-index.json"), index);
  await saveOverview(workspace, index);
}

export async function entryDetails(options, overrides = {}) {
  const workspace = await fs.realpath(options.workspace);
  const { index, all } = await indexedSources(workspace);
  const indexed = await matchIndexed(all, options.file, options.kind || (options.id ? undefined : "source"), options.id);
  const kind = indexed.kind;
  const item = await cacheFile(indexed.source, kind, overrides);
  const view = await materializeTaskView(item, workspace, kind);
  await replaceIndexView(workspace, index, view);
  return { entry: view.entry, ...summary(view), id: indexed.id };
}

export async function locate(options) {
  const workspace = await fs.realpath(options.workspace);
  const { all, policy } = await indexedSources(workspace);
  const ids = String(options.ids ?? "").split(",").filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("locate --ids 需要逗号分隔且不重复的素材标识");
  const entries = [], images = [];
  for (const id of ids) {
    const indexed = await matchIndexed(all, undefined, undefined, id);
    const view = JSON.parse(await fs.readFile(await taskInput(workspace, indexed.entry), "utf8"));
    if (view.sourceKey !== indexed.sourceKey || view.source !== indexed.source) throw new Error(`素材 ${id} 详情失效，请执行 index`);
    const record = view.analysis?.observation;
    const observation = record?.originTaskId === policy.taskId
      ? analysisRecord(record, view.sourceKey, view.duration) : analysisRecord(null, view.sourceKey, view.duration);
    for (const [page, sheet] of view.sheets.entries()) {
      const actual = await taskInput(workspace, sheet.path);
      images.push({ id: `${id}:page-${page + 1}`, mediaId: id, path: actual, source: view.source,
        sourceKey: view.sourceKey, role: view.kind, entry: view.entry, page: page + 1,
        from: sheet.firstSecond, to: sheet.lastSecond, frameCount: sheet.frameCount,
        width: sheet.width, height: sheet.height, bytes: (await fs.stat(actual)).size });
    }
    entries.push({ ...summary({ ...view, observation: observation.text, analysis: { ...view.analysis, observation } }), id });
  }
  return { entries, images, imageGroups: Array.from({ length: Math.ceil(images.length / 4) },
    (_, index) => images.slice(index * 4, index * 4 + 4).map((image) => image.path)),
    grouping: { defaultNewImages: 4, capacity: "client default; native Session refines using full history" } };
}

// Provenance is independent of saved prose. Only selected, task-local image
// metadata and source fingerprints are inspected; no decoding or library scan.
export async function imageProvenance(workspace, images, identities = new Map()) {
  workspace = await fs.realpath(workspace);
  const access = await mediaAccess(workspace), views = new Map(), result = [];
  for (const image of images) {
    try {
      const actual = await taskInput(workspace, image);
      let entry = path.join(path.dirname(actual), "entry.json");
      if (!(await fs.stat(entry).catch(() => null))) entry = `${actual}.visual.json`;
      let view = views.get(entry);
      if (!view) {
        view = JSON.parse(await fs.readFile(await taskInput(workspace, entry), "utf8"));
        const source = await access.file(view.source, view.kind);
        const stat = await fs.stat(source), signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        let identity = identities.get(source);
        if (!identity || identity.signature !== signature) {
          identity = { signature, key: (await fingerprint(source)).key }; identities.set(source, identity);
        }
        if (identity.key !== view.sourceKey) continue;
        views.set(entry, view);
      }
      const matchingPath = async (candidate) => {
        if (path.resolve(candidate).toLowerCase() === actual.toLowerCase()) return true;
        if (path.basename(candidate).toLowerCase() !== path.basename(actual).toLowerCase()) return false;
        return (await fs.realpath(candidate)).toLowerCase() === actual.toLowerCase();
      };
      let page = -1;
      for (const [index, item] of (view.sheets ?? []).entries()) if (await matchingPath(item.path)) { page = index; break; }
      const sheet = page >= 0 ? view.sheets[page] : undefined;
      let frame;
      if (!sheet) for (const item of view.frames ?? []) if (await matchingPath(item.path)) { frame = item; break; }
      const from = sheet?.firstSecond ?? frame?.at, to = sheet?.lastSecond ?? frame?.at;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > view.duration + 0.05) continue;
      result.push({ path: actual, entry, source: view.source, sourceKey: view.sourceKey, role: view.kind,
        id: `${mediaId(view)}:${sheet ? `page-${page + 1}` : `frame-${frame.at}`}`,
        from, to, page: sheet ? page + 1 : null, frameCount: sheet?.frameCount ?? 1,
        width: sheet?.width ?? view.geometry?.width, height: sheet?.height ?? view.geometry?.height,
        bytes: (await fs.stat(actual)).size });
    } catch { /* Unknown/detail/changed image stays actual; never infer completion. */ }
  }
  return result;
}

/** Optional visual contract. Old check-plan remains a duplicate-shot check. */
export async function checkTaskPlan(options) {
  const workspace = await fs.realpath(options.workspace);
  const file = await taskInput(workspace, options.file);
  const data = await fs.readFile(file), plan = JSON.parse(data.toString("utf8"));
  const checked = checkPlan(plan, options["allow-reuse"]);
  if (!plan.visual) return checked;
  const { all, policy } = await indexedSources(workspace);
  const visual = plan.visual;
  if (visual.version !== 1 || visual.taskId !== policy.taskId || !Array.isArray(visual.excluded)
    || !Array.isArray(visual.active) || typeof visual.finalized !== "boolean") {
    throw new Error("visual 需要 version:1、本任务 taskId、excluded/active 图片路径数组及 finalized 布尔值");
  }
  const requested = [...visual.excluded, ...visual.active];
  if (requested.some((value) => typeof value !== "string") || new Set(requested).size !== requested.length) {
    throw new Error("visual 图片路径必须准确、互不重复，active 与 excluded 不能重叠");
  }
  const images = await imageProvenance(workspace, requested);
  if (images.length !== requested.length) throw new Error("visual 图片身份/范围失效，请 locate 当前任务准确图片，不重扫未变化素材");
  const excluded = images.slice(0, visual.excluded.length), active = images.slice(visual.excluded.length);
  if (excluded.some((image) => image.role === "reference")) throw new Error("选镜期间参考图保持活跃；全部选镜确认后由 finalized 减载");
  const required = [];
  if (visual.finalized) {
    // Backend-owned immutable contract, outside Pi's writable workspace.
    const contractFile = path.join(workspace, "..", "delivery", "contract.json");
    const real = await fs.realpath(contractFile);
    if (real.toLowerCase() !== path.resolve(contractFile).toLowerCase()) throw new Error("交付契约路径异常");
    const contract = JSON.parse(await fs.readFile(real, "utf8"));
    if (contract.version !== 1 || contract.taskId !== policy.taskId
      || (await fs.realpath(contract.workspace)).toLowerCase() !== workspace.toLowerCase()
      || !Array.isArray(contract.slots) || !contract.slots.length || contract.slots.length > 20
      || !Array.isArray(plan.outputs) || plan.outputs.length !== contract.slots.length || !checked.ok) {
      throw new Error("finalized 需要本任务全部成片方案和有效交付契约，不能只设置布尔值");
    }
    const sourceViews = new Map();
    const viewFor = async (source, kinds) => {
      if (typeof source !== "string" || !source) throw new Error("方案需要索引中准确的 source 路径");
      const actual = await fs.realpath(path.resolve(workspace, source));
      const item = all.find((row) => row.source.toLowerCase() === actual.toLowerCase() && kinds.includes(row.kind));
      if (!item || (await fingerprint(actual)).key !== item.sourceKey) throw new Error("方案源文件不在当前有效索引内，请使用 locate 的准确 source");
      if (!sourceViews.has(item.entry)) sourceViews.set(item.entry, JSON.parse(await fs.readFile(await taskInput(workspace, item.entry), "utf8")));
      const view = sourceViews.get(item.entry);
      if (view.sourceKey !== item.sourceKey || view.source !== item.source) throw new Error("方案素材详情身份失效");
      return view;
    };
    const reference = all.find((item) => item.kind === "reference");
    if (!reference) throw new Error("缺少参考视频索引");
    const referenceView = await viewFor(reference.source, ["reference"]);
    required.push(...referenceView.sheets.map((sheet) => sheet.path));
    for (const [index, output] of plan.outputs.entries()) {
      if (output.output !== contract.slots[index] || !Number.isFinite(output.duration) || output.duration <= 0
        || !Array.isArray(output.shots) || !output.shots.length) throw new Error(`outputs[${index}] 需要正式槽位、duration 和非空 shots`);
      let audioEnd = 0;
      if (contract.silentDuration && output.silentDuration === contract.silentDuration) audioEnd = contract.silentDuration;
      else {
        const segments = output.mainAudio?.segments ?? (output.mainAudio?.source ? [output.mainAudio] : []);
        if (!Array.isArray(segments) || !segments.length) throw new Error(`outputs[${index}] 缺少主音频时间线`);
        for (const segment of segments) {
          const view = await viewFor(segment.source, ["audio"]);
          const from = segment.from ?? 0, to = segment.to ?? view.duration, at = segment.at ?? audioEnd, rate = segment.rate ?? 1;
          if (![from, to, at, rate].every(Number.isFinite) || from < 0 || to <= from || to > view.duration + 0.08
            || rate <= 0 || rate > 8 || Math.abs(at - audioEnd) > 0.08) throw new Error(`outputs[${index}] 主音频区间无效或未连续`);
          audioEnd = at + (to - from) / rate;
        }
      }
      if (Math.abs(output.duration - audioEnd) > 0.12) throw new Error(`outputs[${index}] duration 与主音频时间线不符`);
      let shotEnd = 0;
      for (const shot of output.shots) {
        const view = await viewFor(shot.source, ["source"]);
        const at = shot.at ?? shotEnd, rate = shot.rate ?? 1;
        if (shot.end > view.duration + 0.05 || !Number.isFinite(rate) || rate <= 0 || rate > 8
          || !Number.isFinite(at) || at < 0 || at > shotEnd + 0.08) throw new Error(`outputs[${index}] 镜头范围或连续时间线无效`);
        shotEnd = Math.max(shotEnd, at + (shot.end - shot.start) / rate);
        const relevant = view.sheets.filter((sheet) => sheet.lastSecond >= shot.start && sheet.firstSecond < shot.end);
        if (!relevant.length) throw new Error(`outputs[${index}] 镜头没有可定位画面`);
        required.push(...relevant.map((sheet) => sheet.path));
      }
      if (Math.abs(shotEnd - output.duration) > 0.12) throw new Error(`outputs[${index}] 镜头未覆盖主音频时间线`);
    }
  }
  const needed = [...new Set(required)];
  if (needed.some((image) => visual.excluded.includes(image))) throw new Error("已排除图片与完整方案选镜冲突");
  const requiredImages = await imageProvenance(workspace, needed);
  if (requiredImages.length !== needed.length) throw new Error("完整方案所需图片身份失效");
  return { ...checked, visual: { version: 1, taskId: policy.taskId, file,
    sha256: createHash("sha256").update(data).digest("hex"), excluded, active,
    finalized: visual.finalized, required: requiredImages } };
}

/** Small current-task selection files are decisions, not neutral observation prose.
 * Native Session read/write association is verified by the extension, not here. */
export async function checkSelectionBatch(options, identities = new Map(), tolerateStale = false) {
  const workspace = await fs.realpath(options.workspace);
  const file = await taskInput(workspace, path.resolve(workspace, options.file));
  const relative = path.relative(workspace, file).replace(/\\/g, "/");
  if (!/^selections\/[^/]+\.json$/i.test(relative)) throw new Error("选镜记录写入 selections/<批次>.json");
  const data = await fs.readFile(file), batch = JSON.parse(data.toString("utf8"));
  // Only mentioned sources are admitted/fingerprinted below; no directory scan.
  const { all, policy } = await indexedSources(workspace, false);
  if (batch.version !== 1 || batch.kind !== "selection-batch" || !Array.isArray(batch.rows) || !batch.rows.length)
    throw new Error("选镜记录需要 version:1、kind:selection-batch 和非空 rows");
  const images = [], names = new Set();
  for (const [index, row] of batch.rows.entries()) {
    try {
      if (!row || typeof row.image !== "string" || !Array.isArray(row.decisions) || !row.decisions.length)
        throw new Error("需要准确 image 标识/路径和 decisions");
      let image = row.image;
      if (!path.isAbsolute(image) && !image.includes("/") && !image.includes("\\") && image.includes(":page-")) {
        const separator = image.lastIndexOf(":page-");
        const entry = await matchIndexed(all, undefined, undefined, image.slice(0, separator));
        const view = JSON.parse(await fs.readFile(await taskInput(workspace, entry.entry), "utf8"));
        const page = Number(image.slice(separator + 6));
        if (!Number.isInteger(page) || page < 1 || !view.sheets?.[page - 1]) throw new Error("图片页标识失效，请 locate");
        image = view.sheets[page - 1].path;
      }
      const [evidence] = await imageProvenance(workspace, [path.resolve(workspace, image)], identities);
      if (!evidence || evidence.role !== "source") throw new Error("需要本任务有效素材图片；参考图在完整方案确认前保留");
      if (names.has(evidence.path.toLowerCase())) throw new Error("image 重复");
      names.add(evidence.path.toLowerCase());
      let end = evidence.from;
      const decisions = row.decisions.map((decision) => {
        if (!decision || !["selected", "discarded", "pending"].includes(decision.decision)
          || ![decision.from, decision.to].every(Number.isFinite) || decision.from < evidence.from
          || decision.to < decision.from || decision.to > evidence.to || decision.from !== end
          || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000
          || (decision.decision === "selected" && (typeof decision.purpose !== "string" || !decision.purpose.trim())))
          throw new Error("decisions 需按页范围连续覆盖、合法区间及取舍原因；selected 需 purpose，未看清填 pending");
        if (/\b(?:sk-[A-Za-z0-9_-]{8,}|authorization\s*:|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9_-]{8,})/i.test(`${decision.reason} ${decision.purpose ?? ""}`))
          throw new Error("选镜记录包含疑似密钥");
        if (decision.purpose?.length > 2000) throw new Error("purpose 超过 2000 字符");
        end = decision.to;
        return { from: decision.from, to: decision.to, decision: decision.decision, reason: decision.reason,
          ...(decision.decision === "selected" ? { purpose: decision.purpose } : {}) };
      });
      if (end !== evidence.to) throw new Error("decisions 未覆盖整页；未决定的剩余区间填 pending");
      const stat = await fs.stat(evidence.path), signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cacheKey = `image:${evidence.path}`;
      let imageIdentity = identities.get(cacheKey);
      if (!imageIdentity || imageIdentity.signature !== signature) {
        imageIdentity = { signature, hash: createHash("sha256").update(await fs.readFile(evidence.path)).digest("hex") };
        identities.set(cacheKey, imageIdentity);
      }
      const imageHash = imageIdentity.hash;
      images.push({ ...evidence, imageHash, decisions, complete: decisions.every((item) => item.decision !== "pending") });
    } catch (error) {
      if (!tolerateStale) throw new Error(`rows[${index}]：${error.message}`);
    }
  }
  return { ok: true, selection: { version: 1, taskId: policy.taskId, file,
    sha256: createHash("sha256").update(data).digest("hex"), images } };
}

export function createVisualStateReader(workspace) {
  const identities = new Map();
  return async (images, proofs, selections = []) => {
    const evidence = await imageProvenance(workspace, images, identities), verified = [], verifiedSelections = [];
    for (const proof of proofs) {
      try {
        const result = await checkTaskPlan({ workspace, file: proof.file, "allow-reuse": proof.limitedReuseAllowed });
        if (result.ok && result.visual?.sha256 === proof.sha256 && result.visual.taskId === proof.taskId) verified.push(result.visual);
      } catch { /* Modified/failed/foreign plans do not authorize removal. */ }
    }
    for (const proof of selections) {
      try {
        const result = await checkSelectionBatch({ workspace, file: proof.file }, identities, true);
        if (result.selection.sha256 === proof.sha256 && result.selection.taskId === proof.taskId) {
          result.selection.images = result.selection.images.filter((image) => proof.images.some((old) =>
            old.path === image.path && old.sourceKey === image.sourceKey && old.imageHash === image.imageHash));
          verifiedSelections.push(result.selection);
        }
      } catch { /* Changed record invalidates this batch, not unrelated batches. */ }
    }
    return { images: evidence, proofs: verified, selections: verifiedSelections };
  };
}

export async function overview(options, overrides = {}) {
  const workspace = await fs.realpath(options.workspace);
  const { index, all, policy } = await indexedSources(workspace);
  // Page an existing task view, rather than re-fingerprinting every source and
  // copying all extracted pictures on each compact metadata request.
  const views = await mapConcurrent(all, automaticParallelism(all.length), async (entry) => {
    const view = JSON.parse(await fs.readFile(await taskInput(workspace, entry.entry), "utf8"));
    if (view.source !== entry.source || view.sourceKey !== entry.sourceKey || !view.analysis) throw new Error("任务素材详情与索引不一致，请先执行 index");
    const record = view.analysis.observation;
    const observation = record?.originTaskId === policy.taskId
      ? analysisRecord(record, view.sourceKey, view.duration) : analysisRecord(null, view.sourceKey, view.duration);
    const transcript = analysisRecord(view.analysis.transcript, view.sourceKey, view.duration);
    const filtered = { ...view, kind: entry.kind, observation: observation.text, transcript: transcript.text,
      analysis: { observation, transcript } };
    await writeTaskJson(workspace, entry.entry, filtered);
    return filtered;
  });
  index.reference = views[0];
  index.sources = views.filter((view) => view.kind === "source");
  index.audio = views.filter((view) => view.kind === "audio");
  await writeTaskJson(workspace, path.join(workspace, "media-index.json"), index);
  return { catalogFile: path.join(workspace, "media-catalog.jsonl"), overviewFile: await saveOverview(workspace, index, Number(options.offset ?? 0), Number(options.limit ?? 25)),
    sourceCount: index.sources.length, audioCount: index.audio.length };
}

export async function annotateBatch(options, overrides = {}) {
  const workspace = await fs.realpath(options.workspace);
  const manifestFile = await taskInput(workspace, options.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.rows) || !manifest.rows.length) throw new Error("分析清单需要 version:1 和非空 rows 数组");
  const { index, all } = await indexedSources(workspace);
  const policy = await readMediaPolicy(workspace);
  const prepared = [];
  const seen = new Set();
  for (let rowIndex = 0; rowIndex < manifest.rows.length; rowIndex++) {
    const row = manifest.rows[rowIndex];
    try {
      const indexed = await matchIndexed(all, row.file, row.kind || (row.id ? undefined : "source"), row.id);
      const kind = indexed.kind;
      const item = await cacheFile(indexed.source, kind, overrides);
      if (!row.observation && !row.transcript) throw new Error("需要 observation 或 transcript");
      const id = `${kind}:${item.sourceKey}`;
      if (seen.has(id)) throw new Error("同一素材需合并到一行，不能重复覆盖");
      seen.add(id);
      prepared.push({ item, kind,
        observationRecord: row.observation ? newRecord(row.observation, item, policy) : undefined,
        transcriptRecord: row.transcript ? newRecord(row.transcript, item, policy, row.transcript.config) : undefined });
    } catch (error) { throw new Error(`rows[${rowIndex}]：${error.message}`); }
  }
  const saved = [];
  for (const { item, kind, observationRecord, transcriptRecord } of prepared) {
    const localDirectory = path.dirname((await materializeTaskView(item, workspace, kind)).entry);
    const existing = await fs.readFile(path.join(localDirectory, "analysis.json"), "utf8").then(JSON.parse, () => ({}));
    const local = existing.sourceKey === item.sourceKey && existing.taskId === policy.taskId ? existing : {};
    const taskAnalysis = { ...local, version: ANALYSIS_VERSION, taskId: policy.taskId, sourceKey: item.sourceKey,
      ...(observationRecord ? { observationRecord } : {}), ...(transcriptRecord ? { transcriptRecord } : {}) };
    await writeTaskJson(workspace, path.join(localDirectory, "analysis.json"), taskAnalysis);
    const updated = { ...item, cacheHit: undefined, directory: undefined,
      ...(observationRecord && kind !== "reference" ? { observationRecord, observation: observationRecord.text } : {}),
      ...(transcriptRecord ? { transcriptRecord, transcript: transcriptRecord.text } : {}) };
    await writeCacheEntry(item.directory, updated);
    const view = await materializeTaskView(updatedWithDirectory(updated, item), workspace, kind);
    if (kind === "reference") index.reference = view;
    else (kind === "audio" ? index.audio : index.sources).splice(
      (kind === "audio" ? index.audio : index.sources).findIndex((entry) => entry.source === view.source), 1, view);
    saved.push({ source: view.source, sourceKey: view.sourceKey, entry: view.entry,
      ...(observationRecord ? { observationCreatedAt: observationRecord.createdAt } : {}), observationState: view.analysis.observation.state,
      transcriptState: view.analysis.transcript.state });
  }
  await writeTaskJson(workspace, path.join(workspace, "media-index.json"), index);
  await saveOverview(workspace, index);
  return { saved };
}

const updatedWithDirectory = (updated, item) => ({ ...updated, directory: item.directory, cacheHit: true });

export async function annotate(options, overrides = {}) {
  const textFile = options["text-file"] ?? options.textFile;
  if (!textFile) throw new Error("annotate 需要 --text-file");
  const workspace = await fs.realpath(options.workspace || process.cwd());
  const value = await fs.readFile(await taskInput(workspace, textFile), "utf8");
  const manifest = { version: 1, rows: [{ file: options.file, kind: options.kind || "source",
    [options.transcript ? "transcript" : "observation"]: { text: value, complete: false } }] };
  const manifestFile = await writeTaskJson(workspace, path.join(workspace, `analysis-${randomUUID()}.json`), manifest);
  return annotateBatch({ workspace, manifest: manifestFile }, overrides);
}

function normalizedTranscriptConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("transcript.config 必须是处理配置对象");
  const allowed = ["engine", "model", "language", "modelKey", "engineKey", "formatVersion"];
  if (Object.keys(config).some((key) => !allowed.includes(key))) throw new Error("transcript.config 只接受 engine/model/language/modelKey/engineKey/formatVersion");
  const result = {};
  for (const key of allowed) {
    if (config[key] === undefined) continue;
    if (key === "formatVersion") {
      if (config[key] !== 1) throw new Error("transcript.config.formatVersion 必须是 1");
    } else if (typeof config[key] !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(config[key])) {
      throw new Error(`transcript.config.${key} 不是有效配置值`);
    }
    result[key] = config[key];
  }
  return result;
}

async function transcribeOne(item, directory, settings, context) {
  const wav = path.join(directory, "input.wav");
  await run(context.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", item.source,
    "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav]);
  const out = path.join(directory, "transcript");
  await run(settings.executable, ["--model", settings.modelPath, "--file", wav,
    "--language", settings.language, "--threads", String(settings.threads),
    "--output-json-full", "--output-file", out, "--no-prints"],
  Math.max(300_000, Math.min(30 * 60_000, item.duration * 20_000)));
  const raw = JSON.parse(await fs.readFile(`${out}.json`, "utf8"));
  if (!Array.isArray(raw.transcription)) throw new Error("Whisper 输出缺少 transcription，未保存完整转写");
  const segments = raw.transcription.map((segment) => {
    const start = Number(segment.offsets?.from) / 1000, end = Number(segment.offsets?.to) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || typeof segment.text !== "string") {
      throw new Error("Whisper 输出含无效的时间戳或文本，未保存完整转写");
    }
    return { start, end, text: segment.text.trim() };
  });
  return { text: segments.map((segment) => segment.text).join(" ").trim(), segments,
    language: raw.result?.language ?? settings.language };
}

export async function transcribeBatch(options, overrides = {}) {
  const context = runtime(overrides);
  const workspace = await fs.realpath(options.workspace);
  const manifestFile = await taskInput(workspace, options.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.rows) || !manifest.rows.length) throw new Error("转写清单需要 version:1 和非空 rows 数组");
  const model = options.model || "small.en";
  const language = options.language || (model.endsWith(".en") ? "en" : "auto");
  if (!/^[A-Za-z0-9_.-]+$/.test(model) || !/^(auto|[a-z]{2,3})$/.test(language)) throw new Error("--model/--language 不是有效名称");
  if (model.endsWith(".en") && !["en", "auto"].includes(language)) throw new Error(`${model} 是英语模型；请选择本机已安装的对应语言模型`);
  const executable = context.whisper ?? process.env.HYPERFRAMES_WHISPER_PATH
    ?? path.join(projectRoot, ".runtime", "whisper", "runtime", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const modelDirectory = context.whisperModelsDir ?? process.env.HYPERFRAMES_WHISPER_MODELS_DIR
    ?? path.join(projectRoot, ".runtime", "whisper", "models");
  const modelPath = path.join(modelDirectory, `ggml-${model}.bin`);
  const [engineIdentity, modelIdentity] = await Promise.all([fingerprint(executable), fingerprint(modelPath)]).catch((error) => {
    throw new Error(`本地 Whisper 程序/模型缺失或不可读：${error.message}；请运行安装器，本任务不会下载或构建`);
  });
  const config = { engine: "whisper.cpp", model, language, modelKey: modelIdentity.key, engineKey: engineIdentity.key, formatVersion: 1 };
  const { all } = await indexedSources(workspace);
  const items = [];
  const seen = new Set();
  for (let rowIndex = 0; rowIndex < manifest.rows.length; rowIndex++) {
    const row = manifest.rows[rowIndex];
    try {
      const indexed = await matchIndexed(all, row.file, row.kind || (row.id ? undefined : "audio"), row.id);
      const item = await cacheFile(indexed.source, indexed.kind, context);
      if (!item.audio?.length) throw new Error("没有可转写的音频流");
      const id = `${item.kind}:${item.sourceKey}`;
      if (seen.has(id)) throw new Error("同一音频不应重复列入 rows");
      seen.add(id);
      items.push(item);
    } catch (error) { throw new Error(`rows[${rowIndex}]：${error.message}`); }
  }
  const memoryPerJob = modelIdentity.size * 2 + 256 * 1024 * 1024;
  const concurrency = automaticParallelism(items.length, memoryPerJob, context.resources);
  const threads = Math.max(1, Math.floor((context.resources?.cpus ?? os.availableParallelism()) / concurrency));
  const results = await mapConcurrent(items, concurrency, async (item) => {
    try {
      const existing = analysisRecord(item.transcriptRecord, item.sourceKey, item.duration);
      if (existing.state === "full" && JSON.stringify(existing.config) === JSON.stringify(config)) {
        await materializeTaskView(item, workspace, item.kind);
        return { source: item.source, kind: item.kind, reused: true };
      }
      const directory = await fs.mkdtemp(path.join(workspace, "transcribe-"));
      if (!inside(workspace, await fs.realpath(directory))) throw new Error("转写工作目录离开当前任务范围");
      const transcript = await (context.transcribeOne ?? transcribeOne)(item, directory,
        { executable, modelPath, language, threads }, context);
      const text = JSON.stringify(transcript);
      const saveFile = await writeTaskJson(workspace, path.join(directory, "analysis.json"), { version: 1,
        rows: [{ file: item.source, kind: item.kind, transcript: { text, coverage: [[0, item.duration]], complete: true, config } }] });
      // Work is parallel, but index publication is collected below to avoid lost updates.
      return { source: item.source, kind: item.kind, reused: false, saveFile };
    } catch (error) {
      // One bad input must not discard other finished transcripts or keep
      // detached workers running after the batch has already returned.
      return { source: item.source, kind: item.kind, error: error.message };
    }
  });
  const rows = [];
  for (const result of results) if (result.saveFile) {
    const saved = JSON.parse(await fs.readFile(result.saveFile, "utf8"));
    rows.push(...saved.rows);
  }
  if (rows.length) {
    const saveFile = await writeTaskJson(workspace, path.join(workspace, `transcripts-${randomUUID()}.json`), { version: 1, rows });
    await annotateBatch({ workspace, manifest: saveFile }, context);
  } else await overview({ workspace }, context);
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    throw new Error(`转写失败：${failures.map((result) => `${path.basename(result.source)}：${result.error}`).join("；")}。其余成功转写已缓存，修正后重试同一清单即可`);
  }
  return { concurrency, threadsPerJob: threads, results: results.map(({ saveFile: _saveFile, ...result }) => result),
    overviewFile: path.join(workspace, "media-overview.json") };
}

export async function detail(options, overrides = {}) {
  const context = runtime(overrides);
  const workspace = await fs.realpath(options.workspace);
  const file = await (await mediaAccess(workspace)).file(options.file);
  const at = Number(options.at);
  if (!(at >= 0 && Number.isFinite(at))) throw new Error("detail --at 必须是非负秒数");
  const media = await probe(file, context);
  if (!media.stream || at >= media.duration) throw new Error("所选时间不在视频范围内");
  if (!options.workspace) throw new Error("detail 需要 --workspace");
  const out = await taskOutput(workspace, path.resolve(options.output));
  const geometry = displayGeometry(media.stream);
  const maxSide = options.original ? Math.ceil(Math.max(geometry.width, geometry.height)) : 1280;
  const route = await extract(file, at, out, maxSide, context);
  await saveGeneratedView(workspace, file, media.duration, geometry, [{ path: out, at }], [], `${out}.visual.json`);
  return { path: out, source: file, at, geometry, route, images: await imageProvenance(workspace, [out]) };
}

async function saveGeneratedView(workspace, source, duration, geometry, frames, sheets, entry) {
  const access = await mediaAccess(workspace);
  const kind = source.toLowerCase() === access.reference.toLowerCase() ? "reference" : "source";
  const sourceKey = (await fingerprint(await access.file(source, kind))).key;
  await writeTaskJson(workspace, entry, { source, sourceKey, kind, duration, geometry, frames, sheets, entry });
}

export async function candidateWindow(options, overrides = {}) {
  const context = runtime(overrides);
  if (!options.workspace) throw new Error("window 需要 --workspace");
  const workspace = await fs.realpath(options.workspace);
  const file = await (await mediaAccess(workspace)).file(options.file);
  const media = await probe(file, context);
  if (!media.stream) throw new Error("候选文件没有视频流");
  const start = Number(options.start), end = Number(options.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= media.duration || end - start > 120) {
    throw new Error("window 需要视频范围内、最长 120 秒的 start/end");
  }
  const directory = await fs.mkdtemp(path.join(workspace, "candidate-"));
  if (!inside(workspace, await fs.realpath(directory))) throw new Error("候选目录离开当前任务工作目录");
  const frames = end > start
    ? (await extractTimeline(file, end - start + 0.05, "reference", directory, context, start, true)).frames : [];
  if (!frames.length || end - frames.at(-1).at >= 0.05) {
    const name = `frame-${String(frames.length + 1).padStart(5, "0")}.jpg`;
    const target = path.join(directory, name);
    await extract(file, end, target, 1280, context);
    frames.push({ at: end, path: target });
  }
  const geometry = displayGeometry(media.stream);
  const sheets = (await createSheets(frames, directory, geometry.aspect, "candidate", context))
    .map((item) => ({ ...item, path: path.join(directory, item.name) }));
  await saveGeneratedView(workspace, file, media.duration, geometry, frames, sheets, path.join(directory, "entry.json"));
  return { source: file, directory, geometry, frames, sheets,
    images: await imageProvenance(workspace, sheets.map((sheet) => sheet.path)) };
}

export async function resheet(options, overrides = {}) {
  const context = runtime(overrides);
  if (!options.workspace) throw new Error("resheet 需要 --workspace");
  const workspace = await fs.realpath(options.workspace);
  const kind = options.kind || "source";
  const item = await cacheFile(await (await mediaAccess(workspace)).file(options.file, kind), kind, context);
  if (!item.geometry || !item.frames.length) throw new Error("所选文件没有缓存画面");
  const batch = Number(options["batch-size"] ?? 9);
  const requestedBound = Number(options["max-sheet"] ?? MAX_SHEET);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_FRAMES || !Number.isInteger(requestedBound) || requestedBound < 512 || requestedBound > 3840) {
    throw new Error("resheet 需要 1–25 帧和 512–3840 的边长");
  }
  const bound = Math.min(requestedBound, MAX_SHEET);
  const directory = await fs.mkdtemp(path.join(workspace, "resheet-"));
  if (!inside(workspace, await fs.realpath(directory))) throw new Error("宫格输出目录离开当前任务工作目录");
  const frames = item.frames.map((frame) => ({ at: frame.at, path: path.join(item.directory, frame.name) }));
  const sourceId = createHash("sha256").update(item.source).digest("hex").slice(0, 8);
  const sheets = (await createSheets(frames, directory, item.geometry.aspect, sourceId, context, batch, bound))
    .map((entry) => ({ ...entry, path: path.join(directory, entry.name) }));
  await saveGeneratedView(workspace, item.source, item.duration, item.geometry, [], sheets, path.join(directory, "entry.json"));
  return { source: item.source, cacheHit: item.cacheHit, directory, sheets,
    images: await imageProvenance(workspace, sheets.map((sheet) => sheet.path)) };
}

export function checkPlan(plan, allowReuse = false) {
  if (!plan || typeof plan !== "object" || (plan.outputs !== undefined && !Array.isArray(plan.outputs))) throw new Error("方案 outputs 必须是数组");
  const issues = [];
  const outputs = plan.outputs ?? [];
  for (const output of outputs) {
    if (!output || typeof output !== "object" || (output.shots !== undefined && !Array.isArray(output.shots))) throw new Error("方案每行 shots 必须是数组");
    for (const shot of output.shots ?? []) {
    if (!shot || typeof shot.source !== "string" || !shot.source || !Number.isFinite(shot.start)
      || !Number.isFinite(shot.end) || shot.start < 0 || shot.end <= shot.start) {
      throw new Error("方案中的镜头必须包含 source 和有效 start/end 秒数");
    }
    }
  }
  for (let i = 0; i < outputs.length; i++) for (let j = i + 1; j < outputs.length; j++) {
    const a = outputs[i].shots ?? [], b = outputs[j].shots ?? [];
    if (a.length && b.length && a[0].source === b[0].source
      && Math.max(a[0].start, b[0].start) < Math.min(a[0].end, b[0].end)) {
      issues.push({ outputs: [i + 1, j + 1], reason: "相同开场镜头" });
    }
    for (const left of a) for (const right of b) {
      if (left.source !== right.source) continue;
      const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
      if (overlap >= 5 && overlap >= Math.min(left.end - left.start, right.end - right.start) * 0.5) {
        issues.push({ outputs: [i + 1, j + 1], reason: "长片段时间区间重复", source: left.source, overlap });
      }
    }
  }
  return { ok: issues.length === 0 || allowReuse, issues, limitedReuseAllowed: allowReuse };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--")) throw new Error(`无效参数：${rest[i]}`);
    const key = rest[i].slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`重复参数：--${key}`);
    if (["original", "transcript", "allow-reuse"].includes(key)) { options[key] = true; i--; }
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`--${key} 需要参数值`);
      options[key] = rest[i + 1];
    }
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if ((argv.length === 1 || argv.length === 2) && ["--help", "-h"].includes(argv.at(-1))) {
      process.stdout.write("media-cache.mjs index|overview|entry|locate|annotate|annotate-batch|transcribe-batch|detail|window|resheet|check-plan [--key value]\nlocate --workspace <dir> --ids <id,id>; entry --workspace <dir> --id <id> (or --file <media> --kind <kind>)\n");
      process.exit(0);
    }
    const { command, options } = parseArgs(argv);
    let result;
    if (command === "index") result = await indexTask(options);
    else if (command === "overview") result = await overview(options);
    else if (command === "entry") result = await entryDetails(options);
    else if (command === "locate") result = await locate(options);
    else if (command === "annotate") result = await annotate(options);
    else if (command === "annotate-batch") result = await annotateBatch(options);
    else if (command === "transcribe-batch") result = await transcribeBatch(options);
    else if (command === "detail") result = await detail(options);
    else if (command === "window") result = await candidateWindow(options);
    else if (command === "resheet") result = await resheet(options);
    else if (command === "check-plan") result = options.workspace ? await checkTaskPlan(options)
      : checkPlan(JSON.parse(await fs.readFile(options.file, "utf8")), options["allow-reuse"]);
    else throw new Error("用法：media-cache.mjs index|overview|entry|locate|annotate|annotate-batch|transcribe-batch|detail|window|resheet|check-plan [--key value]");
    process.stdout.write(`${JSON.stringify(result)}${os.EOL}`);
  } catch (error) {
    process.stderr.write(`media-cache: ${error.message}${os.EOL}`);
    process.exitCode = 1;
  }
}
