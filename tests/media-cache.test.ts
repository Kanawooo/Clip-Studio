import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createReadToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import {
  analysisRecord, annotateBatch, automaticParallelism, cacheFile, candidateWindow, detail,
  displayGeometry, entryDetails, fingerprint, indexTask, materializeTaskView, overview,
  readMediaPolicy, sampleTimes, sheet, sheetBatchSize, sheetLayout, transcribeBatch,
} from "../.pi/skills/clip-skills/scripts/media-cache.mjs";

const root = mkdtempSync(path.join(tmpdir(), "clip-media-cache-"));
const cacheRoot = path.join(root, "cache");
const project = path.resolve(import.meta.dirname, "..");
const ffmpeg = existsSync(path.join(project, ".runtime", "ffmpeg", "bin", "ffmpeg.exe"))
  ? path.join(project, ".runtime", "ffmpeg", "bin", "ffmpeg.exe") : "ffmpeg";
const ffprobe = existsSync(path.join(project, ".runtime", "ffmpeg", "bin", "ffprobe.exe"))
  ? path.join(project, ".runtime", "ffmpeg", "bin", "ffprobe.exe") : "ffprobe";
const hasMediaRuntime = spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status === 0;
const assets = path.join(root, "中文 素材");
const audio = path.join(root, "音频 目录");
const video = path.join(assets, "实拍 1.mp4");
const reference = path.join(root, "参考 1.mp4");
const context = { cacheRoot, ffmpeg, ffprobe, resources: { cpus: 4, freeMemory: 2 * 1024 ** 3 } };

function command(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

function task(name: string, reuseVisualAnalysis?: boolean, selectedReference = reference) {
  const workspace = path.join(root, name);
  mkdirSync(workspace, { recursive: true });
  if (reuseVisualAnalysis !== undefined) writeFileSync(path.join(workspace, "media-policy.json"),
    JSON.stringify({ version: 1, taskId: name, reuseVisualAnalysis,
      inputs: { referenceVideo: selectedReference, assetsDir: assets, audioDir: audio } }));
  return workspace;
}

async function index(workspace: string, ref = reference) {
  return indexTask({ workspace, reference: ref, assets, audio }, context);
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function manifest(workspace: string, rows: unknown[], name = "analyses.json") {
  const file = path.join(workspace, name);
  writeFileSync(file, JSON.stringify({ version: 1, rows }));
  return file;
}

before(() => {
  mkdirSync(assets, { recursive: true });
  mkdirSync(audio, { recursive: true });
  if (!hasMediaRuntime) return;
  command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=480x720:rate=6:duration=5",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-y", video]);
  command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=6:duration=4",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-y", reference]);
  for (let i = 1; i <= 2; i++) command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=330:sample_rate=16000:duration=2", "-c:a", "pcm_s16le", "-y", path.join(audio, `配音 ${i}.wav`)]);
});

after(() => {
  const relative = path.relative(tmpdir(), root);
  assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  rmSync(root, { recursive: true, force: true });
});

test("geometry uses arbitrary display ratio, SAR and rotation, not fixed portrait buckets", () => {
  assert.equal(displayGeometry({ width: 720, height: 480, sample_aspect_ratio: "4:3" }).aspect, 2);
  assert.equal(displayGeometry({ width: 720, height: 480, sample_aspect_ratio: "4:3", tags: { rotate: "90" } }).aspect, 0.5);
  for (const aspect of [0.18, 0.56, 0.75, 1, 1.4, 1.78, 2.4, 4.5]) {
    const count = sheetBatchSize(25, aspect);
    const layout = sheetLayout(count, aspect);
    const width = layout.columns * (layout.cellWidth + layout.gap) + layout.gap;
    const height = layout.rows * (layout.cellHeight + layout.gap) + layout.gap;
    assert.ok(width <= 2000 && height <= 2000);
    assert.ok(count >= 1 && count <= 25);
    assert.ok(Math.abs(layout.cellWidth / (layout.cellHeight - layout.label) - aspect) < 0.025);
  }
  assert.ok(sheetBatchSize(25, 1) < 25, "small square thumbnails split into readable pages");
  assert.deepEqual(sampleTimes(7, "reference"), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(sampleTimes(18, "source"), [0, 3, 6, 9, 12, 15, 17]);
});

test("analysis distinguishes missing, legacy partial, covered full and incompatible identity/version", () => {
  assert.equal(analysisRecord(null, "key", 10).state, "absent");
  assert.equal(analysisRecord("old text", "key", 10).state, "partial");
  const record = { version: 1, sourceKey: "key", text: "actual observation", coverage: [[0, 4], [4, 10]], complete: true };
  assert.equal(analysisRecord(record, "key", 10).state, "full");
  assert.equal(analysisRecord({ ...record, coverage: [[3, 7]] }, "key", 10).state, "partial");
  assert.equal(analysisRecord({ ...record, version: 9 }, "key", 10).state, "incompatible");
  assert.equal(analysisRecord(record, "different-source", 10).text, null);
});

test("machine-aware concurrency scales with CPU and available memory", () => {
  assert.equal(automaticParallelism(16, 1024 ** 3, { cpus: 16, freeMemory: 12 * 1024 ** 3 }), 7);
  assert.equal(automaticParallelism(16, 1024 ** 3, { cpus: 2, freeMemory: 12 * 1024 ** 3 }), 1);
  assert.equal(automaticParallelism(16, 1024 ** 3, { cpus: 32, freeMemory: 1024 ** 3 }), 1);
});

test("legacy missing policy stays permissive, explicit invalid policy fails", async () => {
  const workspace = task("legacy");
  assert.equal((await readMediaPolicy(workspace)).reuseVisualAnalysis, true);
  writeFileSync(path.join(workspace, "media-policy.json"), JSON.stringify({ version: 3, taskId: "legacy", reuseVisualAnalysis: false }));
  await assert.rejects(readMediaPolicy(workspace), /media-policy.json/);
});

test("OFF hides every foreign observation entry while keeping images and independent transcripts", { skip: !hasMediaRuntime }, async () => {
  const first = task("first", false);
  const indexed = await index(first);
  const source = json(indexed.indexFile).sources[0];
  const rows = [{ file: video, kind: "source", observation: { text: "Neutral hand/tool shot, actual time coverage", coverage: [[0, 5]], complete: true } },
    { file: path.join(audio, "配音 1.wav"), kind: "audio", transcript: { text: "actual spoken phrase", coverage: [[0, 2]], complete: true } }];
  await annotateBatch({ workspace: first, manifest: manifest(first, rows) }, context);
  assert.equal(json(source.entry).analysis.observation.state, "full");
  await index(first);
  assert.match(json(source.entry).observation, /Neutral/);

  const second = task("second", false);
  const other = await index(second);
  const result = json(other.indexFile);
  assert.equal(result.sources[0].cacheHit, true);
  assert.equal(result.sources[0].observation, null);
  assert.equal(json(result.sources[0].entry).observation, null);
  assert.equal(json(other.overviewFile).sources[0].observation, null);
  assert.match(result.audio[0].transcript, /actual spoken/);
  assert.ok(existsSync(result.sources[0].sheets[0].path));

  const third = task("third", true);
  const reused = await index(third);
  assert.match(json(reused.indexFile).sources[0].observation, /Neutral/);
  assert.equal(json(reused.indexFile).sources[0].analysis.observation.state, "full");
  await entryDetails({ workspace: second, file: video, kind: "source" }, context);
  assert.equal(json(json(other.indexFile).sources[0].entry).observation, null);
  await overview({ workspace: second }, context);
  assert.equal(json(other.overviewFile).sources[0].observation, null);
});

test("new references reuse source extraction but never reuse the old reference judgment", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("reference-analysis", true);
  const indexed = await index(workspace);
  await annotateBatch({ workspace, manifest: manifest(workspace, [{ file: reference, kind: "reference",
    observation: { text: "This reference uses fast closeups", coverage: [[0, 4]], complete: true } }]) }, context);
  await index(workspace);
  assert.match(json(indexed.indexFile).reference.observation, /fast closeups/);
  const next = task("other-reference", true, video);
  const other = await index(next, video);
  assert.equal(json(other.indexFile).sources[0].cacheHit, true);
  assert.equal(json(other.indexFile).reference.observation, null);
  assert.equal(json((await index(task("same-reference-new-task", true))).indexFile).reference.observation, null);
});

test("partial observations stay partial and secret/outside/invalid coverage batches are rejected before publication", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("partial", false);
  const indexed = await index(workspace);
  await annotateBatch({ workspace, manifest: manifest(workspace, [{ file: video, kind: "source",
    observation: { text: "Only looked at the first second", coverage: [[0, 1]], complete: false } }]) }, context);
  assert.equal(json(indexed.indexFile).sources[0].analysis.observation.state, "partial");
  await assert.rejects(annotateBatch({ workspace, manifest: manifest(workspace, [{ file: video, kind: "source",
    observation: { text: "wrong coverage", coverage: [[0, 1]], complete: true } }]) }, context), /rows\[0\].*complete:true/);
  await assert.rejects(annotateBatch({ workspace, manifest: manifest(workspace, [{ file: video, kind: "source",
    observation: { text: "api_key=must-not-cache" } }]) }, context), /疑似密钥/);
  await assert.rejects(annotateBatch({ workspace, manifest: manifest(workspace, [{ file: reference, kind: "source",
    observation: { text: "unauthorized kind" } }]) }, context), /不在本任务素材索引/);
  assert.match(json(indexed.indexFile).sources[0].observation, /first second/);
});

test("old sheet revision regenerates from existing frames without probe or full source decode", { skip: !hasMediaRuntime }, async () => {
  const item = await cacheFile(video, "source", context);
  const entryFile = path.join(item.directory, "entry.json");
  const old = json(entryFile);
  delete old.sheetRevision;
  writeFileSync(entryFile, JSON.stringify(old));
  const frameStats = item.frames.map((frame: { name: string }) => statSync(path.join(item.directory, frame.name)).mtimeMs);
  const migrated = await cacheFile(video, "source", { ...context, ffprobe: path.join(root, "missing-probe.exe") });
  assert.equal(migrated.cacheHit, true);
  assert.equal(migrated.sheetRevision, 2);
  assert.deepEqual(migrated.frames.map((frame: { name: string }) => statSync(path.join(item.directory, frame.name)).mtimeMs), frameStats);
  assert.ok(migrated.sheets.every((entry: { width: number; height: number }) => entry.width <= 2000 && entry.height <= 2000));
});

test("native Pi image read preserves generated JPEG dimensions and bytes; original frames remain high resolution", { skip: !hasMediaRuntime }, async () => {
  const item = await cacheFile(video, "source", context);
  const view = await materializeTaskView(item, task("native-read", false), "source");
  const definition = createReadToolDefinition(root);
  const result = await definition.execute("jpeg-test", { path: view.sheets[0].path });
  const image = result.content.find((entry: { type: string }) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, readFileSync(view.sheets[0].path).toString("base64"));
  const frame = JSON.parse(command(ffprobe, ["-v", "error", "-show_streams", "-of", "json", view.frames[0].path])).streams[0];
  assert.equal(frame.width / frame.height, 2 / 3);
  assert.equal(frame.height, 720);
});

test("file changes invalidate only that identity, and compact paged overview avoids frame-path expansion", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("invalidation", false);
  const indexed = await index(workspace);
  const oldIndex = json(indexed.indexFile);
  await fs.appendFile(video, Buffer.from([0]));
  const changed = await index(workspace);
  const current = json(changed.indexFile);
  assert.notEqual(current.sources[0].sourceKey, oldIndex.sources[0].sourceKey);
  assert.equal(current.sources[0].cacheHit, false);
  assert.equal(current.reference.cacheHit, true);
  assert.equal(current.audio[0].cacheHit, true);
  assert.equal(current.sources[0].analysis.observation.state, "absent");
  const compact = json(changed.overviewFile);
  assert.equal(compact.sources[0].frames, undefined);
  assert.ok(statSync(changed.overviewFile).size < statSync(changed.indexFile).size);
  await overview({ workspace, offset: 0, limit: 1 }, context);
  assert.equal(json(changed.overviewFile).sources.length, 1);
  await assert.rejects(overview({ workspace, offset: -1, limit: 1 }, context), /offset/);
});

test("batched local transcription is resource-parallel and source/config-valid across OFF tasks", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("transcribe-one", false);
  await index(workspace);
  const models = path.join(root, "installed models");
  mkdirSync(models, { recursive: true });
  const whisper = path.join(root, "installed-whisper-fixture.exe");
  writeFileSync(whisper, "fixture engine");
  writeFileSync(path.join(models, "ggml-small.en.bin"), "fixture model");
  let active = 0, peak = 0, calls = 0;
  const configured = { ...context, whisper, whisperModelsDir: models, transcribeOne: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active--;
    return { text: "real engine fixture words", segments: [{ start: 0, end: 2, text: "real engine fixture words" }] };
  } };
  const rows = [1, 2].map((number) => ({ file: path.join(audio, `配音 ${number}.wav`), kind: "audio" }));
  const first = await transcribeBatch({ workspace, manifest: manifest(workspace, rows) }, configured);
  assert.equal(first.concurrency, 2);
  assert.equal(peak, 2);
  assert.equal(calls, 2);
  const next = task("transcribe-two", false);
  await index(next);
  const reused = await transcribeBatch({ workspace: next, manifest: manifest(next, rows) }, configured);
  assert.ok(reused.results.every((result: { reused: boolean }) => result.reused));
  assert.equal(calls, 2);
  const changedConfig = await transcribeBatch({ workspace: next, manifest: manifest(next, rows), language: "auto" }, configured);
  assert.ok(changedConfig.results.every((result: { reused: boolean }) => !result.reused));
  assert.equal(calls, 4);
});

test("a failed audio waits for the batch, preserves successful cache and only retries the failed file", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("partial-audio-batch", false);
  await index(workspace);
  const models = path.join(root, "partial models");
  mkdirSync(models, {recursive:true});
  const whisper = path.join(root, "partial-whisper-fixture.exe");
  writeFileSync(whisper, "fixture engine");
  writeFileSync(path.join(models, "ggml-small.en.bin"), "fixture model");
  let active = 0, calls = 0, failSecond = true;
  const configured = {...context, whisper, whisperModelsDir:models, transcribeOne:async (item: {source:string}) => {
    calls++; active++;
    try {
      if (failSecond && path.basename(item.source) === "配音 2.wav") throw new Error("fixture decoding failure");
      await new Promise(resolve => setTimeout(resolve,40));
      return {text:"actual fixture words", segments:[{start:0,end:2,text:"actual fixture words"}]};
    } finally { active--; }
  }};
  const file = manifest(workspace, [1,2].map(number => ({file:path.join(audio,`配音 ${number}.wav`), kind:"audio"})));
  await assert.rejects(transcribeBatch({workspace,manifest:file},configured), /配音 2.wav.*fixture decoding failure.*成功转写已缓存/);
  assert.equal(active,0);
  assert.equal(calls,2);
  const indexed = json(path.join(workspace,"media-index.json"));
  assert.equal(indexed.audio[0].analysis.transcript.state,"full");
  failSecond = false;
  const retried = await transcribeBatch({workspace,manifest:file},configured);
  assert.equal(calls,3);
  assert.equal(retried.results[0].reused,true);
  assert.equal(retried.results[1].reused,false);
});

test("detail/window remain available while task policy and hard links are protected", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("detail", false);
  const result = await detail({ workspace, file: video, at: 1, output: path.join(workspace, "detail.jpg") }, context);
  assert.ok(existsSync(result.path));
  await assert.rejects(detail({ workspace, file: video, at: 1, output: path.join(workspace, "media-policy.json") }, context), /任务策略/);
  const hard = path.join(workspace, "linked.jpg");
  await fs.link(path.join(workspace, "media-policy.json"), hard);
  await assert.rejects(detail({ workspace, file: video, at: 1, output: hard }, context), /硬链接/);
  const window = await candidateWindow({ workspace, file: video, start: 1, end: 3 }, context);
  assert.ok(window.frames.every((frame: { at: number }) => frame.at >= 1 && frame.at <= 3.05));
  assert.ok(window.sheets.every((entry: { width: number; height: number }) => entry.width <= 2000 && entry.height <= 2000));
});

test("writable indexes cannot authorize outside media for batch or overview operations", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("forged-index", false);
  const indexed = await index(workspace);
  const outside = path.join(root, "未选择 音频.wav");
  await fs.copyFile(path.join(audio, "配音 1.wav"), outside);
  const forged = json(indexed.indexFile);
  forged.audio[0].source = outside;
  writeFileSync(indexed.indexFile, JSON.stringify(forged));
  const rows = [{file: outside, kind: "audio", transcript: {text: "must not read", complete: false}}];
  await assert.rejects(annotateBatch({workspace, manifest:manifest(workspace, rows)}, context), /不在本任务已选路径/);
  await assert.rejects(entryDetails({workspace, file:outside, kind:"audio"}, context), /不在本任务已选路径/);
  await assert.rejects(overview({workspace}, context), /不在本任务已选路径/);
  const models = path.join(root, "boundary models");
  mkdirSync(models, {recursive:true});
  const whisper = path.join(root, "boundary-whisper.exe");
  writeFileSync(whisper, "vetted fixture engine");
  writeFileSync(path.join(models, "ggml-small.en.bin"), "vetted fixture model");
  let calls = 0;
  await assert.rejects(transcribeBatch({workspace, manifest:manifest(workspace, [{file:outside,kind:"audio"}])},
    {...context, whisper, whisperModelsDir:models, transcribeOne:async()=>{calls++;return {};}}), /不在本任务已选路径/);
  assert.equal(calls, 0);
});

test("overview pages metadata without invoking FFmpeg or FFprobe again", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("metadata-only-overview", false);
  await index(workspace);
  const compact = await overview({workspace, offset:0, limit:1},
    {...context, ffmpeg:path.join(root,"nonexistent-ffmpeg.exe"), ffprobe:path.join(root,"nonexistent-ffprobe.exe")});
  assert.equal(json(compact.overviewFile).sources.length, 1);
});

test("legacy task workspaces recover selected roots from the backend record, not the index", { skip: !hasMediaRuntime }, async () => {
  const taskDir = path.join(root, "legacy-backend-task");
  const workspace = path.join(taskDir, "workspace");
  mkdirSync(workspace, {recursive:true});
  writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({schemaVersion:3, id:"legacy-backend-task",
    input:{referenceVideo:reference, assetsDir:assets, audioDir:audio}}));
  const indexed = await index(workspace);
  assert.equal(json(indexed.indexFile).sources[0].cacheHit, true);
  assert.equal((await readMediaPolicy(workspace)).reuseVisualAnalysis, true);
  const wrong = {...json(path.join(taskDir, "task.json")), id:"different-task"};
  writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(wrong));
  await assert.rejects(index(workspace), /不属于当前任务/);
});

test("public CLI help exits successfully without workspace, input or dependency checks", () => {
  const cli = path.join(project, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs");
  const result = command(process.execPath, [cli, "transcribe-batch", "--help"]);
  assert.match(result, /transcribe-batch/);
});
