import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { TaskManager } from "../src/tasks/manager.js";
import { scanDeliveredOutputs } from "../src/tasks/delivery.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Clip Studio 中文 delivery ")));
const projectRoot = path.resolve(".");
const ffmpeg = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
const ffprobe = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffprobe.exe");
process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;

after(() => rmSync(root, { recursive: true, force: true }));

function audio(file: string, duration = 1.2): void {
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`,
    "-c:a", "libmp3lame", "-y", file], { timeout: 30_000 });
}

function video(file: string, duration = 1.2): void {
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `color=c=blue:s=160x90:r=24:d=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", file], { timeout: 30_000 });
}

function writeReceipt(taskDir: string, index: number, output: string): void {
  const stat = statSync(output);
  writeFileSync(path.join(taskDir, "delivery", `${index}.json`), JSON.stringify({
    version: 1, index, output, bytes: stat.size,
    sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    duration: 1.2, audioTarget: 1.2, silent: false, rowSignature: "test", inputs: [],
  }));
}

function fixture() {
  const taskDir = path.join(root, `task-${Math.random().toString(16).slice(2)}`);
  const workspace = path.join(taskDir, "workspace");
  const project = path.join(workspace, "video-project");
  const outputDir = path.join(root, `输出 ${path.basename(taskDir)}`);
  const audioDir = path.join(root, `音频 ${path.basename(taskDir)}`);
  const deliveryDir = path.join(taskDir, "delivery");
  for (const dir of [project, outputDir, audioDir, deliveryDir, path.join(project, "compositions"), path.join(project, "assets", "audio")]) mkdirSync(dir, { recursive: true });
  const source = path.join(project, "assets", "audio", "voice.mp3");
  audio(source);
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_format", "-of", "json", source], { encoding: "utf8" })) as { format: { duration: string } };
  const duration = Number(probe.format.duration);
  const composition = path.join(project, "compositions", "01.html");
  writeFileSync(composition, `<div data-composition-id="01" data-start="0" data-duration="${duration.toFixed(3)}">
    <audio src="assets/audio/voice.mp3" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="10"></audio></div>`);
  const slot = `Clip-Studio-${path.basename(taskDir)}-1-abcdef12.mp4`;
  writeFileSync(path.join(deliveryDir, "contract.json"), JSON.stringify({
    version: 1, taskId: path.basename(taskDir), workspace, outputDir, audioDir, slots: [slot], silentDuration: null,
  }));
  const manifestPath = path.join(workspace, "render-manifest.json");
  const manifest = { version: 1, project: "video-project", settings: { fps: 24, quality: "high" },
    rows: [{ composition: "compositions/01.html", output: slot,
      mainAudio: { source: "assets/audio/voice.mp3" }, status: "pending" }] };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { taskDir, workspace, project, outputDir, audioDir, deliveryDir, composition, source, slot, manifestPath, manifest, duration };
}

test("queue validates exact slot and selected audio timeline before render", async () => {
  const { validatedManifest } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const item = fixture();
  const options = { manifest: item.manifestPath, workspace: item.workspace, "output-dir": item.outputDir };
  const valid = await validatedManifest(options);
  assert.equal(valid.rows.length, 1);
  assert.ok(Math.abs(valid.rows[0].audio.target - item.duration) < 0.01);
  assert.equal(valid.rows[0].audio.silent, false);
  item.manifest.rows[0].output = "test.mp4";
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  await assert.rejects(validatedManifest(options), /预留位置/);
  item.manifest.rows[0].output = item.slot;
  delete (item.manifest.rows[0] as { mainAudio?: unknown }).mainAudio;
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  await assert.rejects(validatedManifest(options), /缺少主音频/);
  item.manifest.rows[0].mainAudio = { source: "assets/audio/voice.mp3" };
  writeFileSync(item.composition, readFileSync(item.composition, "utf8").replace(`data-duration="${item.duration.toFixed(3)}"`, 'data-duration="3"'));
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  await assert.rejects(validatedManifest(options), /工程时长.*主音频/);
});

test("single main-audio source accepts an explicit trimmed interval", async () => {
  const { validatedManifest } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const item = fixture();
  const trimmed = 0.8;
  writeFileSync(item.composition, `<div data-composition-id="01" data-start="0" data-duration="${trimmed}">
    <audio src="assets/audio/voice.mp3" data-start="0" data-duration="${trimmed}" data-track-index="10"></audio></div>`);
  item.manifest.rows[0].mainAudio = { source: "assets/audio/voice.mp3", from: 0, to: trimmed } as never;
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  const verified = await validatedManifest({ manifest: item.manifestPath, workspace: item.workspace, "output-dir": item.outputDir });
  assert.ok(Math.abs(verified.rows[0].audio.target - trimmed) < 0.01);
  item.manifest.rows[0].mainAudio = { source: "assets/audio/voice.mp3", from: 0, to: item.duration + 2 } as never;
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  await assert.rejects(validatedManifest({ manifest: item.manifestPath, workspace: item.workspace,
    "output-dir": item.outputDir }), /源区间或播放速度无效/);
});

test("silent rows require an explicit task duration and no audio track", async () => {
  const { validatedManifest } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const item = fixture();
  writeFileSync(item.composition, `<div data-composition-id="01" data-start="0" data-duration="1.2"></div>`);
  (item.manifest.rows[0] as { silentDuration?: number }).silentDuration = 1.2;
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  const options = { manifest: item.manifestPath, workspace: item.workspace, "output-dir": item.outputDir };
  await assert.rejects(validatedManifest(options), /必须在剪辑要求中明确/);
  const contractPath = path.join(item.deliveryDir, "contract.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.silentDuration = 1.2;
  writeFileSync(contractPath, JSON.stringify(contract));
  const verified = await validatedManifest(options);
  assert.equal(verified.rows[0].audio.silent, true);
});

test("queue refuses an occupied final slot without a receipt", () => {
  const item = fixture();
  const occupied = path.join(item.outputDir, item.slot);
  video(occupied);
  const before = createHash("sha256").update(readFileSync(occupied)).digest("hex");
  const queue = path.join(projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs");
  assert.throws(() => execFileSync(process.execPath, [queue, "run", "--manifest", item.manifestPath,
    "--workspace", item.workspace, "--output-dir", item.outputDir], { encoding: "utf8", timeout: 30_000 }),
  /已有未知文件/);
  assert.equal(createHash("sha256").update(readFileSync(occupied)).digest("hex"), before);
});

test("final validation rejects a short picture track even when audio extends the MP4", async () => {
  const { verifyVideo } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const file = path.join(root, "画面短于音频.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-y", file], { timeout: 30_000 });
  await assert.rejects(verifyVideo(file, { target: 3, silent: false }, 24), /视频流时长不足/);
});

test("task manager ignores playable tests and accepts only hashed final receipts", async () => {
  const referenceVideo = path.join(root, "参考.mp4");
  const assetsDir = path.join(root, "素材");
  const audioDir = path.join(root, "音频 输入");
  const outputDir = path.join(root, "输出 实测");
  const tasksDir = path.join(root, "任务数据");
  for (const dir of [assetsDir, audioDir, outputDir, tasksDir]) mkdirSync(dir, { recursive: true });
  video(referenceVideo);
  audio(path.join(audioDir, "voice.mp3"));
  let resolvePrompt!: () => void;
  const promptDone = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  let sessions = 0;
  const manager = new TaskManager({ projectRoot, tasksDir, agentDir: path.join(root, "pi"),
    outputScanIntervalMs: 100,
    sessionFactory: async () => { sessions += 1; return { prompt: () => promptDone, abort: async () => {}, dispose: () => {} }; },
  });
  const task = await manager.createTask({ referenceVideo, assetsDir, audioDir, outputDir,
    taskRequest: "按主音频做完整视频", generateCount: 1,
    model: { provider: "test", model: "test", apiKey: "test-only" }, modelCapabilityId: "test" });
  assert.equal(sessions, 1);
  video(path.join(outputDir, "test.mp4"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(task.outputs.length, 0);
  const slot = task.delivery!.slots[0]!;
  const final = path.join(outputDir, slot);
  video(final);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(task.outputs.length, 0, "reserved filename without receipt is not a final video");
  const stat = await import("node:fs/promises").then((mod) => mod.stat(final));
  const digest = createHash("sha256").update(readFileSync(final)).digest("hex");
  writeFileSync(path.join(tasksDir, task.id, "delivery", "1.json"), JSON.stringify({
    version: 1, index: 1, output: final, bytes: stat.size, sha256: digest,
    duration: 1.2, audioTarget: 1.2, silent: false, rowSignature: "test", inputs: [],
  }));
  const saved = JSON.parse(readFileSync(path.join(tasksDir, task.id, "delivery", "1.json"), "utf8"));
  assert.equal(task.input.outputDir, outputDir);
  assert.equal(task.delivery!.slots[0], slot);
  assert.equal(saved.version, 1);
  assert.equal(saved.index, 1);
  assert.equal(saved.audioTarget, 1.2);
  const scan = await scanDeliveredOutputs(task, path.join(tasksDir, task.id), undefined, true);
  assert.equal(scan.outputs.length, 1, scan.failures.join("; "));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(task.outputs.length, 1);
  assert.equal(task.outputs[0]?.path, await import("node:fs/promises").then((mod) => mod.realpath(final)));
  resolvePrompt();
  for (let i = 0; i < 50 && task.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(task.status, "completed");
  await manager.shutdown();
  const validReopen = new TaskManager({ projectRoot, tasksDir, agentDir: path.join(root, "pi") });
  for (let i = 0; i < 40 && validReopen.getTask(task.id)?.outputs.length !== 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(validReopen.getTask(task.id)?.outputs.length, 1, "history must restore a valid delivered output");
  await validReopen.shutdown();
  appendFileSync(final, "changed-after-delivery");
  const invalid = await scanDeliveredOutputs(task, path.join(tasksDir, task.id), undefined, true);
  assert.equal(invalid.outputs.length, 0);
  assert.match(invalid.failures.join(" "), /成片文件已变化/);
  const reopened = new TaskManager({ projectRoot, tasksDir, agentDir: path.join(root, "pi") });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reopened.getTask(task.id)?.outputs.length, 0, "history must not retain a modified output");
  await reopened.shutdown();
});

test("retry keeps the task ID and excludes earlier test clips", async () => {
  const referenceVideo = path.join(root, "重试参考.mp4");
  const assetsDir = path.join(root, "重试素材");
  const audioDir = path.join(root, "重试音频");
  const outputDir = path.join(root, "重试输出");
  const tasksDir = path.join(root, "重试任务");
  for (const dir of [assetsDir, audioDir, outputDir, tasksDir]) mkdirSync(dir, { recursive: true });
  video(referenceVideo);
  audio(path.join(audioDir, "voice.mp3"));
  const model = { provider: "test", model: "test", apiKey: "test-only" };
  let attempts = 0;
  let completeRetry!: () => void;
  const retryDone = new Promise<void>((resolve) => { completeRetry = resolve; });
  const manager = new TaskManager({ projectRoot, tasksDir, agentDir: path.join(root, "retry-pi"),
    outputScanIntervalMs: 100,
    sessionFactory: async () => {
      attempts += 1;
      const attempt = attempts;
      return { prompt: () => attempt === 1 ? Promise.reject(new Error("first attempt failed")) : retryDone,
        abort: async () => {}, dispose: () => {} };
    },
  });
  const task = await manager.createTask({ referenceVideo, assetsDir, audioDir, outputDir,
    taskRequest: "使用完整主音频", generateCount: 1, model, modelCapabilityId: "test" });
  for (let i = 0; i < 50 && task.status !== "failed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, "failed");
  video(path.join(outputDir, "test.mp4"));
  const resumed = await manager.retryTask(task.id, model);
  assert.equal(resumed?.id, task.id);
  assert.equal(attempts, 2);
  assert.equal(task.outputs.length, 0);
  const final = path.join(outputDir, task.delivery!.slots[0]!);
  video(final);
  const stat = await import("node:fs/promises").then((mod) => mod.stat(final));
  writeFileSync(path.join(tasksDir, task.id, "delivery", "1.json"), JSON.stringify({
    version: 1, index: 1, output: final, bytes: stat.size,
    sha256: createHash("sha256").update(readFileSync(final)).digest("hex"),
    duration: 1.2, audioTarget: 1.2, silent: false, rowSignature: "test", inputs: [],
  }));
  completeRetry();
  for (let i = 0; i < 70 && task.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, "completed");
  assert.equal(task.outputs.length, 1);
  await manager.shutdown();
});

test("multi-video task retains partial delivery and finishes missing slot on retry", async () => {
  const referenceVideo = path.join(root, "多条参考.mp4");
  const assetsDir = path.join(root, "多条素材");
  const audioDir = path.join(root, "多条音频");
  const outputDir = path.join(root, "多条输出");
  const tasksDir = path.join(root, "多条任务");
  for (const dir of [assetsDir, audioDir, outputDir, tasksDir]) mkdirSync(dir, { recursive: true });
  video(referenceVideo);
  audio(path.join(audioDir, "voice.mp3"));
  const model = { provider: "test", model: "test", apiKey: "test-only" };
  const finishes: Array<() => void> = [];
  const manager = new TaskManager({ projectRoot, tasksDir, agentDir: path.join(root, "multi-pi"),
    outputScanIntervalMs: 100,
    sessionFactory: async () => ({ prompt: () => new Promise<void>((resolve) => { finishes.push(resolve); }),
      abort: async () => {}, dispose: () => {} }),
  });
  const task = await manager.createTask({ referenceVideo, assetsDir, audioDir, outputDir,
    taskRequest: "制作两条完整视频", generateCount: 2, model, modelCapabilityId: "test" });
  const first = path.join(outputDir, task.delivery!.slots[0]!);
  video(first);
  writeReceipt(path.join(tasksDir, task.id), 1, first);
  finishes[0]!();
  for (let i = 0; i < 70 && task.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, "failed");
  assert.equal(task.outputs.length, 1);
  assert.match(task.error ?? "", /要求 2 条，找到 1 条/);
  await manager.retryTask(task.id, model);
  assert.equal(task.outputs.length, 1);
  const second = path.join(outputDir, task.delivery!.slots[1]!);
  video(second);
  writeReceipt(path.join(tasksDir, task.id), 2, second);
  finishes[1]!();
  for (let i = 0; i < 70 && task.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, "completed");
  assert.equal(task.outputs.length, 2);
  await manager.shutdown();
});
