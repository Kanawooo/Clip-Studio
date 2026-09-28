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
const MAX_SHEET = 3840;
const MAX_FRAMES = 25;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const cacheRoot = path.join(projectRoot, ".runtime", "media-cache", `v${CACHE_VERSION}`);
const ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe";

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
  const label = 40;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const availableWidth = Math.floor((bound - gap * (columns + 1)) / columns);
    const availableHeight = Math.floor((bound - gap * (rows + 1)) / rows) - label;
    const frameHeight = Math.min(availableHeight, Math.floor(availableWidth / aspect));
    const frameWidth = Math.floor(frameHeight * aspect);
    if (frameWidth < 80 || frameHeight < 80) continue;
    const cellWidth = Math.floor(frameWidth / 2) * 2;
    const cellHeight = Math.floor((frameHeight + label) / 2) * 2;
    const score = cellWidth * (cellHeight - label);
    if (!best || score > best.score) best = { columns, rows, cellWidth, cellHeight, gap, label, score };
  }
  if (!best) throw new Error("宫格边界过小");
  return best;
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

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
    child.on("error", (error) => reject(new Error(`${path.basename(command)} 启动失败：${error.message}`)));
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "未知"}：${stderr.trim() || "未提供详细原因"}`)));
  });
}

async function probe(file) {
  const data = JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const stream = data.streams?.find((entry) => entry.codec_type === "video");
  const duration = Number(data.format?.duration ?? stream?.duration ?? 0);
  return { duration, stream, audio: data.streams?.filter((entry) => entry.codec_type === "audio").map((entry) => ({ codec: entry.codec_name, channels: entry.channels, sampleRate: entry.sample_rate })) ?? [] };
}

async function fingerprint(file) {
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

async function extract(file, at, output, longEdge = 1280) {
  const filter = `scale=w='min(iw,${longEdge})':h='min(ih,${longEdge})':force_original_aspect_ratio=decrease:reset_sar=1,format=yuvj420p`;
  const common = ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", filter, "-q:v", "3", "-y", output];
  try {
    await run(ffmpeg, ["-hwaccel", "auto", ...common]);
    if (!(await fs.stat(output).then((info) => info.size, () => 0))) throw new Error("未生成画面");
    return "hardware";
  } catch (hardwareError) {
    await fs.rm(output, { force: true });
    try {
      await run(ffmpeg, common);
      if (!(await fs.stat(output).then((info) => info.size, () => 0))) throw new Error("未生成画面");
      return "software";
    }
    catch (softwareError) { throw new Error(`抽帧硬件路径失败：${hardwareError.message}；软件路径失败：${softwareError.message}`); }
  }
}

async function extractTimeline(file, duration, kind, directory) {
  const spacing = kind === "reference" || duration <= 15 ? 1 : 3;
  const pattern = path.join(directory, "frame-%05d.jpg");
  const filter = `fps=1/${spacing}:start_time=0,scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:reset_sar=1,format=yuvj420p`;
  const common = ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", filter, "-q:v", "3", "-y", pattern];
  let route = "hardware";
  try { await run(ffmpeg, ["-hwaccel", "auto", ...common]); }
  catch (hardwareError) {
    route = "software";
    for (const fileName of await fs.readdir(directory)) {
      if (/^frame-\d+\.jpg$/.test(fileName)) await fs.unlink(path.join(directory, fileName));
    }
    try { await run(ffmpeg, common); }
    catch (softwareError) { throw new Error(`抽帧硬件路径失败：${hardwareError.message}；软件路径失败：${softwareError.message}`); }
  }
  const names = (await fs.readdir(directory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
  if (!names.length) throw new Error("FFmpeg 抽帧完成但未生成画面");
  const frames = names.map((name, index) => ({ at: index * spacing, name, path: path.join(directory, name) }));
  const tail = Math.max(0, duration - 1);
  if (tail - frames.at(-1).at >= Math.min(1, spacing / 2)) {
    const name = `frame-${String(frames.length + 1).padStart(5, "0")}.jpg`;
    await extract(file, tail, path.join(directory, name));
    frames.push({ at: tail, name, path: path.join(directory, name) });
  }
  return { frames, route };
}

async function sheet(frames, target, aspect, sourceId, bound = MAX_SHEET) {
  const layout = sheetLayout(frames.length, aspect, bound);
  const { columns, rows, cellWidth, cellHeight, gap, label } = layout;
  const args = ["-hide_banner", "-loglevel", "error"];
  for (const frame of frames) args.push("-i", frame.path);
  const filters = frames.map((frame, i) => {
    const stamp = new Date(frame.at * 1_000).toISOString().slice(11, 19).replaceAll(":", "-");
    const text = `${sourceId} ${stamp}`;
    return `[${i}:v]scale=w='min(iw,${cellWidth})':h='min(ih,${cellHeight - label})':force_original_aspect_ratio=decrease:flags=lanczos,pad=${cellWidth}:${cellHeight}:(${cellWidth}-iw)/2:(${cellHeight - label}-ih)/2:black,drawtext=text='${text}':fontcolor=white:fontsize=26:x=14:y=${cellHeight - label + 5}[v${i}]`;
  });
  const inputs = frames.map((_, i) => `[v${i}]`).join("");
  const positions = frames.map((_, i) => `${gap + (i % columns) * (cellWidth + gap)}_${gap + Math.floor(i / columns) * (cellHeight + gap)}`).join("|");
  const width = columns * (cellWidth + gap) + gap;
  const height = rows * (cellHeight + gap) + gap;
  const stack = frames.length === 1 ? `[v0]pad=${width}:${height}:${gap}:${gap}:black,format=yuvj420p[out]`
    : `${inputs}xstack=inputs=${frames.length}:layout=${positions}:fill=black,pad=${width}:${height}:0:0:black,format=yuvj420p[out]`;
  await run(ffmpeg, [...args, "-filter_complex", [...filters, stack].join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "3", "-y", target]);
  return { ...layout, width, height, path: target, firstSecond: frames[0].at, lastSecond: frames.at(-1).at };
}

async function cacheFile(file, kind) {
  const identity = await fingerprint(file);
  const kindRoot = path.join(cacheRoot, kind);
  const target = path.join(kindRoot, identity.key);
  let invalidExisting = false;
  try {
    const entry = JSON.parse(await fs.readFile(path.join(target, "entry.json"), "utf8"));
    if (entry.version === CACHE_VERSION && entry.source === identity.real && entry.complete === true && entry.kind === kind) {
      await Promise.all([...entry.sheets, ...entry.frames].map((item) => fs.stat(path.join(target, item.name))));
      return { ...entry, cacheHit: true, directory: target };
    }
    invalidExisting = true;
  } catch {
    invalidExisting = await fs.stat(target).then(() => true, () => false);
  }
  await fs.mkdir(kindRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(kindRoot, ".pending-"));
  try {
    const media = await probe(identity.real);
    const isVideo = Boolean(media.stream);
    const geometry = isVideo ? displayGeometry(media.stream) : undefined;
    const { frames, route } = isVideo
      ? await extractTimeline(identity.real, media.duration, kind, temporary)
      : { frames: [], route: "none" };
    const sheets = [];
    for (let i = 0; i < frames.length; i += MAX_FRAMES) {
      const name = `sheet-${String(sheets.length + 1).padStart(3, "0")}.jpg`;
      const info = await sheet(frames.slice(i, i + MAX_FRAMES), path.join(temporary, name), geometry.aspect, identity.key.slice(0, 8));
      sheets.push({ name, ...info, path: undefined });
    }
    const entry = {
      version: CACHE_VERSION, complete: true, kind, source: identity.real,
      size: identity.size, mtimeMs: identity.mtimeMs, duration: media.duration,
      geometry, audio: media.audio, frames: frames.map(({ at, name }) => ({ at, name })),
      sheets, extractionRoute: route, observation: null, transcript: null,
    };
    await fs.writeFile(path.join(temporary, "entry.json"), JSON.stringify(entry, null, 2));
    if (invalidExisting) {
      const stale = path.join(kindRoot, `.stale-${identity.key}-${randomUUID()}`);
      await fs.rename(target, stale);
      await fs.rm(stale, { recursive: true });
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

async function listMedia(dir, extensions) {
  const files = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await listMedia(full, extensions));
    else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase())) files.push(full);
  }
  return files.sort();
}

async function indexTask(options) {
  if (!options.workspace) throw new Error("index 需要 --workspace 以保存素材索引");
  const reference = await cacheFile(path.resolve(options.reference), "reference");
  const videos = await listMedia(path.resolve(options.assets), VIDEO_EXT);
  const audio = await listMedia(path.resolve(options.audio), AUDIO_EXT);
  const sources = [];
  for (const file of videos) sources.push(await cacheFile(file, "source"));
  const sounds = [];
  for (const file of audio) sounds.push(await cacheFile(file, "audio"));
  const compact = (item) => ({
    source: item.source, cacheHit: item.cacheHit, duration: item.duration,
    geometry: item.geometry, observation: item.observation, transcript: item.transcript,
    frames: item.frames.map((frame) => ({ at: frame.at, path: path.join(item.directory, frame.name) })),
    sheets: item.sheets.map((entry) => ({ ...entry, path: path.join(item.directory, entry.name) })),
    entry: path.join(item.directory, "entry.json"),
  });
  const result = { reference: compact(reference), sources: sources.map(compact), audio: sounds.map(compact) };
  const workspace = path.resolve(options.workspace);
  await fs.mkdir(workspace, { recursive: true });
  const indexFile = path.join(workspace, "media-index.json");
  await fs.writeFile(indexFile, JSON.stringify(result, null, 2));
  return { indexFile, sourceCount: sources.length, audioCount: sounds.length,
    sourceCacheHits: sources.filter((item) => item.cacheHit).length };
}

async function annotate(options) {
  const item = await cacheFile(path.resolve(options.file), options.kind || "source");
  const entryFile = path.join(item.directory, "entry.json");
  const value = await fs.readFile(options.textFile, "utf8");
  if (value.length > 100_000) throw new Error("观察记录过长");
  if (/\b(?:sk-[A-Za-z0-9_-]{8,}|authorization\s*:|api[_-]?key\s*[:=])/i.test(value)) {
    throw new Error("观察记录包含疑似密钥，拒绝写入共享缓存");
  }
  const updated = { ...item, cacheHit: undefined, directory: undefined,
    [options.transcript ? "transcript" : "observation"]: value };
  const temp = `${entryFile}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(updated, null, 2));
  await fs.rename(temp, entryFile);
  return { entry: entryFile };
}

async function detail(options) {
  const file = await fs.realpath(options.file);
  const at = Number(options.at);
  if (!(at >= 0 && Number.isFinite(at))) throw new Error("detail --at 必须是非负秒数");
  const media = await probe(file);
  if (!media.stream || at >= media.duration) throw new Error("所选时间不在视频范围内");
  if (!options.workspace) throw new Error("detail 需要 --workspace");
  const workspace = await fs.realpath(options.workspace);
  const out = path.resolve(options.output);
  const relative = path.relative(workspace, out);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("detail 输出必须位于当前任务工作目录内");
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const realParent = await fs.realpath(path.dirname(out));
  const parentRelative = path.relative(workspace, realParent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new Error("detail 输出目录不能通过符号链接离开当前任务工作目录");
  }
  const existing = await fs.lstat(out).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error("detail 输出不能覆盖符号链接");
  const geometry = displayGeometry(media.stream);
  const maxSide = options.original ? Math.ceil(Math.max(geometry.width, geometry.height)) : 1280;
  const route = await extract(file, at, out, maxSide);
  return { path: out, at, geometry, route };
}

async function candidateWindow(options) {
  if (!options.workspace) throw new Error("window 需要 --workspace");
  const workspace = await fs.realpath(options.workspace);
  const file = await fs.realpath(options.file);
  const media = await probe(file);
  if (!media.stream) throw new Error("候选文件没有视频流");
  const start = Number(options.start), end = Number(options.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= media.duration || end - start > 120) {
    throw new Error("window 需要视频范围内、最长 120 秒的 start/end");
  }
  const directory = await fs.mkdtemp(path.join(workspace, "candidate-"));
  const frames = [];
  for (let at = start; at <= end; at += 1) {
    const name = `frame-${String(frames.length + 1).padStart(3, "0")}.jpg`;
    const target = path.join(directory, name);
    await extract(file, at, target);
    frames.push({ at, path: target });
  }
  const geometry = displayGeometry(media.stream);
  const sheets = [];
  for (let i = 0; i < frames.length; i += MAX_FRAMES) {
    sheets.push(await sheet(frames.slice(i, i + MAX_FRAMES), path.join(directory, `sheet-${sheets.length + 1}.jpg`), geometry.aspect, "candidate"));
  }
  return { source: file, directory, geometry, frames, sheets };
}

async function resheet(options) {
  if (!options.workspace) throw new Error("resheet 需要 --workspace");
  const workspace = await fs.realpath(options.workspace);
  const item = await cacheFile(path.resolve(options.file), options.kind || "source");
  if (!item.geometry || !item.frames.length) throw new Error("所选文件没有缓存画面");
  const batch = Number(options["batch-size"] ?? 9);
  const bound = Number(options["max-sheet"] ?? 2048);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_FRAMES || !Number.isInteger(bound) || bound < 512 || bound > MAX_SHEET) {
    throw new Error("resheet 需要 1–25 帧和 512–3840 的边长");
  }
  const directory = await fs.mkdtemp(path.join(workspace, "resheet-"));
  const frames = item.frames.map((frame) => ({ at: frame.at, path: path.join(item.directory, frame.name) }));
  const sheets = [];
  const sourceId = createHash("sha256").update(item.source).digest("hex").slice(0, 8);
  for (let i = 0; i < frames.length; i += batch) {
    sheets.push(await sheet(frames.slice(i, i + batch), path.join(directory, `sheet-${sheets.length + 1}.jpg`), item.geometry.aspect, sourceId, bound));
  }
  return { source: item.source, cacheHit: item.cacheHit, directory, sheets };
}

export function checkPlan(plan, allowReuse = false) {
  const issues = [];
  const outputs = plan.outputs ?? [];
  for (const output of outputs) for (const shot of output.shots ?? []) {
    if (typeof shot.source !== "string" || !shot.source || !Number.isFinite(shot.start)
      || !Number.isFinite(shot.end) || shot.start < 0 || shot.end <= shot.start) {
      throw new Error("方案中的镜头必须包含 source 和有效 start/end 秒数");
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
    if (["original", "transcript", "allow-reuse"].includes(key)) { options[key] = true; i--; }
    else options[key] = rest[i + 1];
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
  try {
    let result;
    if (command === "index") result = await indexTask(options);
    else if (command === "annotate") result = await annotate(options);
    else if (command === "detail") result = await detail(options);
    else if (command === "window") result = await candidateWindow(options);
    else if (command === "resheet") result = await resheet(options);
    else if (command === "check-plan") result = checkPlan(JSON.parse(await fs.readFile(options.file, "utf8")), options["allow-reuse"]);
    else throw new Error("用法：media-cache.mjs index|annotate|detail|window|resheet|check-plan [--key value]");
    process.stdout.write(`${JSON.stringify(result)}${os.EOL}`);
  } catch (error) {
    process.stderr.write(`media-cache: ${error.message}${os.EOL}`);
    process.exitCode = 1;
  }
}
