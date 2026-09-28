#!/usr/bin/env node
// Invoked by Pi through the project-local HyperFrames skill, never by TaskManager.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const hyperframesCli = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const ffprobe = process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe";
const MiB = 1024 * 1024;
let interrupted = false;
const children = new Set();

export function shouldAdmit({ active, logicalCpus, cpuBusy, freeBytes, totalBytes, observedWorkerBytes }) {
  if (active === 0) return true;
  const reserve = Math.max(512 * MiB, totalBytes * 0.1);
  const worker = Math.max(512 * MiB, observedWorkerBytes || 0);
  return active < logicalCpus && cpuBusy < 0.85 && freeBytes > reserve + worker * 1.2;
}

function isHardwareFailure(message) {
  return /\b(?:nvenc|vaapi|qsv|videotoolbox|gpu|encoder|hardware|device|cuda|amf)\b/i.test(message);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function publicError(value) {
  return String(value)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "***")
    .replace(/\b(Authorization\s*:\s*)(?:Bearer\s+)?[^\s,;"']+/gi, "$1***")
    .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&#\s]+/gi, "$1***")
    .replace(/\b((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s,;"']+/gi, "$1***")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").slice(-2_000);
}

async function runCapture(command, args, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-maxBytes); });
    child.stderr.on("data", (chunk) => { error = (error + chunk.toString()).slice(-maxBytes); });
    child.on("error", (cause) => reject(new Error(`${path.basename(command)} 启动失败：${cause.message}`)));
    child.on("close", (code) => code === 0 ? resolve(output)
      : reject(new Error(`${path.basename(command)} 退出码 ${code ?? "未知"}：${error.slice(-2_000) || "未提供详细原因"}`)));
  });
}

async function verifyVideo(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`输出为空：${file}`);
  const info = JSON.parse(await runCapture(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const video = info.streams?.find((entry) => entry.codec_type === "video");
  const audio = info.streams?.find((entry) => entry.codec_type === "audio");
  if (video?.codec_name !== "h264" || !(Number(info.format?.duration) > 0)) {
    throw new Error(`FFprobe 验证失败：需要可播放的 H.264 视频和有效时长（${file}）`);
  }
  if (audio && audio.codec_name !== "aac") throw new Error(`FFprobe 验证失败：音频不是 AAC（${file}）`);
  return { bytes: stat.size, duration: Number(info.format.duration), videoCodec: video.codec_name, audioCodec: audio?.codec_name ?? null };
}

async function writeManifest(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export async function validatedManifest(options) {
  if (!options.manifest || !options.workspace || !options["output-dir"]) {
    throw new Error("run 需要 --manifest、--workspace 和 --output-dir");
  }
  const workspace = await fs.realpath(options.workspace);
  const outputDir = await fs.realpath(options["output-dir"]);
  const manifestPath = await fs.realpath(options.manifest);
  if (!inside(workspace, manifestPath)) throw new Error("渲染清单必须位于当前任务工作目录内");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.rows) || manifest.rows.length < 1 || manifest.rows.length > 20) {
    throw new Error("渲染清单版本或成片行数无效");
  }
  if (typeof manifest.project !== "string" || path.isAbsolute(manifest.project)) throw new Error("项目路径必须相对任务工作目录");
  const project = await fs.realpath(path.resolve(workspace, manifest.project));
  if (!inside(workspace, project) || !(await fs.stat(project)).isDirectory()) throw new Error("工程路径离开任务工作目录");
  const settings = manifest.settings ?? {};
  if (!([24, 30, 60].includes(settings.fps ?? 30)) || !["standard", "high", "draft"].includes(settings.quality ?? "high")) {
    throw new Error("渲染帧率或画质设置无效");
  }
  if (settings.format && settings.format !== "mp4") throw new Error("渲染清单仅支持 MP4");
  if (settings.crf !== undefined && (!Number.isInteger(settings.crf) || settings.crf < 0 || settings.crf > 51)) {
    throw new Error("CRF 必须是 0–51 的整数");
  }
  const seen = new Set();
  const rows = [];
  for (const [index, row] of manifest.rows.entries()) {
    if (typeof row.composition !== "string" || path.isAbsolute(row.composition) || !row.composition.endsWith(".html")) {
      throw new Error(`第 ${index + 1} 行的工程文件无效`);
    }
    const composition = await fs.realpath(path.resolve(project, row.composition));
    if (!inside(project, composition) || !(await fs.stat(composition)).isFile()) throw new Error(`第 ${index + 1} 行的工程文件越界`);
    if (typeof row.output !== "string" || path.isAbsolute(row.output) || path.extname(row.output).toLowerCase() !== ".mp4") {
      throw new Error(`第 ${index + 1} 行的输出路径无效`);
    }
    const output = path.resolve(outputDir, row.output);
    if (!inside(outputDir, output) || output === outputDir) throw new Error(`第 ${index + 1} 行的输出路径越界`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const realParent = await fs.realpath(path.dirname(output));
    if (!inside(outputDir, realParent)) throw new Error(`第 ${index + 1} 行的输出目录通过符号链接越界`);
    const existing = await fs.lstat(output).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new Error(`第 ${index + 1} 行的输出是符号链接`);
    if (seen.has(output.toLowerCase())) throw new Error("渲染清单有重复输出路径");
    seen.add(output.toLowerCase());
    rows.push({ index, composition, output });
  }
  return { workspace, outputDir, manifestPath, project, manifest, settings, rows };
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

async function workerRss(pids) {
  if (!pids.length) return 0;
  try {
    let table;
    if (process.platform === "win32") {
      const text = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"]);
      table = [JSON.parse(text)].flat().map((item) => ({ pid: Number(item.ProcessId), parent: Number(item.ParentProcessId), bytes: Number(item.WorkingSetSize) }));
    } else {
      const text = await runCapture("ps", ["-eo", "pid=,ppid=,rss="]);
      table = text.trim().split(/\r?\n/).map((line) => {
        const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
        return { pid, parent, bytes: rss * 1024 };
      });
    }
    const selected = new Set(pids);
    for (let iteration = 0; iteration < table.length; iteration++) {
      let changed = false;
      for (const entry of table) if (selected.has(entry.parent) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
      if (!changed) break;
    }
    return table.filter((entry) => selected.has(entry.pid)).reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  } catch { return 0; }
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await runCapture("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
  } else child.kill("SIGTERM");
}

async function renderOnce(context, row, temporary, gpu, logFile) {
  const { settings, project } = context;
  const args = [hyperframesCli, "render", project, "--composition", path.relative(project, row.composition),
    "--output", temporary, "--format", "mp4", "--quality", settings.quality ?? "high",
    "--fps", String(settings.fps ?? 30), "--workers", "1"];
  if (settings.resolution) args.push("--resolution", settings.resolution);
  if (settings.crf !== undefined) args.push("--crf", String(settings.crf));
  if (gpu) args.push("--gpu");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, shell: false });
    children.add(child);
    let tail = "";
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-4_000);
      void fs.appendFile(logFile, text).catch(() => undefined);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => { children.delete(child); reject(new Error(`HyperFrames 启动失败：${error.message}`)); });
    child.on("close", (code) => {
      children.delete(child);
      code === 0 && !interrupted ? resolve() : reject(new Error(`HyperFrames 退出码 ${code ?? "未知"}：${tail.trim() || "未提供详细原因"}`));
    });
  });
}

async function runQueue(options) {
  const context = await validatedManifest(options);
  const { manifest, manifestPath, workspace, rows } = context;
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
    const existing = await fs.stat(row.output).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) {
      if (entry.status !== "running" && entry.status !== "completed") {
        throw new Error(`第 ${row.index + 1} 条已有输出文件，但清单未记录为运行或完成；未覆盖该文件`);
      }
      try {
        const verified = await verifyVideo(row.output);
        entry.status = "completed";
        entry.verified = verified;
        continue;
      } catch (error) {
        throw new Error(`第 ${row.index + 1} 条已有文件无法验证，未覆盖：${error.message}`);
      }
    }
    entry.status = "pending";
    pending.push(row);
  }
  await save();
  const failures = [];
  const active = new Map();
  let lastCpu = cpuSnapshot();
  let observedWorkerBytes = 0;
  async function runRow(row) {
    const entry = manifest.rows[row.index];
    entry.status = "running";
    entry.error = undefined;
    await save();
    const temporary = path.join(path.dirname(row.output), `.clip-studio-${row.index + 1}-${randomUUID()}.mp4`);
    const logFile = path.join(logsDir, `render-${row.index + 1}.log`);
    let hardwareError;
    try {
      try {
        await renderOnce(context, row, temporary, true, logFile);
        entry.route = "gpu-requested";
      } catch (error) {
        if (interrupted) throw error;
        if (!isHardwareFailure(error.message)) throw error;
        hardwareError = error;
        await fs.rm(temporary, { force: true });
        await renderOnce(context, row, temporary, false, logFile);
        entry.route = "software-fallback";
        entry.fallbackReason = publicError(hardwareError.message);
      }
      const verified = await verifyVideo(temporary);
      await fs.rename(temporary, row.output);
      entry.status = "completed";
      entry.verified = verified;
      entry.error = undefined;
      process.stdout.write(`完成 ${row.index + 1}/${rows.length}: ${row.output}\n`);
    } catch (error) {
      const message = hardwareError && hardwareError !== error
        ? `硬件路径：${hardwareError.message}；软件路径：${error.message}` : error.message;
      entry.status = "failed";
      entry.error = publicError(message);
      failures.push(`第 ${row.index + 1} 条：${entry.error}`);
      process.stderr.write(`${failures.at(-1)}\n`);
    } finally {
      await fs.rm(temporary, { force: true });
      await save();
    }
  }
  while ((pending.length || active.size) && !interrupted) {
    const currentCpu = cpuSnapshot();
    const load = cpuBusy(lastCpu, currentCpu);
    lastCpu = currentCpu;
    const rss = await workerRss([...children].map((child) => child.pid).filter(Boolean));
    if (rss && active.size) observedWorkerBytes = Math.max(observedWorkerBytes, rss / active.size);
    while (pending.length && shouldAdmit({
      active: active.size, logicalCpus: os.availableParallelism(), cpuBusy: load,
      freeBytes: os.freemem(), totalBytes: os.totalmem(), observedWorkerBytes,
    }) && !interrupted) {
      const row = pending.shift();
      const promise = runRow(row).finally(() => active.delete(row.index));
      active.set(row.index, promise);
      if (active.size === 1) break; // observe the first real worker before admitting more
    }
    if (!pending.length && active.size) await Promise.race(active.values());
    else if (active.size) await Promise.race([new Promise((resolve) => setTimeout(resolve, 3_000)), ...active.values()]);
  }
  await Promise.allSettled(active.values());
  if (interrupted) throw new Error("渲染已停止，已验证成片保持不变");
  if (failures.length) throw new Error(failures.join("；"));
  return { completed: manifest.rows.filter((entry) => entry.status === "completed").length, total: rows.length, manifest: manifestPath };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || !rest[i + 1]) throw new Error(`参数不完整：${rest[i]}`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    interrupted = true;
    for (const child of children) void killTree(child);
  });
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command !== "run") throw new Error("用法：render-queue.mjs run --manifest <JSON> --workspace <任务工作目录> --output-dir <输出目录>");
    process.stdout.write(`${JSON.stringify(await runQueue(options))}\n`);
  } catch (error) {
    process.stderr.write(`render-queue: ${publicError(error.message)}\n`);
    process.exitCode = 1;
  }
}
