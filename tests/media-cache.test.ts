import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createReadToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { createWriteToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
import { createVisualContextHandler, createVisualRuntime } from "../src/pi/visual-context.js";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
  analysisRecord, annotateBatch, automaticParallelism, cacheFile, candidateWindow, detail,
  displayGeometry, entryDetails, fingerprint, indexTask, materializeTaskView, overview,
  readMediaPolicy, sampleTimes, sheet, sheetBatchSize, sheetLayout, transcribeBatch,
  locate, mediaIds, createVisualEvidenceReader, checkTaskPlan, checkSelectionBatch, createVisualStateReader, imageProvenance,
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

test("missing policy and legacy enabled policy both use task-local analysis; invalid policy still fails", async () => {
  const workspace = task("legacy");
  assert.equal((await readMediaPolicy(workspace)).reuseVisualAnalysis, false);
  const enabled = task("legacy-enabled", true);
  assert.equal((await readMediaPolicy(enabled)).reuseVisualAnalysis, false);
  writeFileSync(path.join(workspace, "media-policy.json"), JSON.stringify({ version: 3, taskId: "legacy", reuseVisualAnalysis: false }));
  await assert.rejects(readMediaPolicy(workspace), /media-policy.json/);
});

test("all tasks hide foreign observations, even legacy ON, while keeping images and independent transcripts", { skip: !hasMediaRuntime }, async () => {
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
  assert.equal(json(reused.indexFile).sources[0].observation, null);
  assert.equal(json(reused.indexFile).sources[0].analysis.observation.state, "absent");
  assert.equal(json(reused.indexFile).sources[0].cacheHit, true);
  const foreign = json(source.entry).analysis.observation;
  for (const [workspace, current] of [[second, other], [third, reused]] as const) {
    const source = json(current.indexFile).sources[0];
    const staleView = { ...json(source.entry), observation: foreign.text,
      analysis: { ...json(source.entry).analysis, observation: foreign } };
    // Existing ON workspaces can contain foreign descriptions in their views.
    writeFileSync(source.entry, JSON.stringify(staleView));
    const located = await locate({ workspace, ids: mediaIds([{ ...source, kind: "source" }])[0].id });
    assert.doesNotMatch(JSON.stringify(located), /Neutral hand\/tool/);
    writeFileSync(source.entry, JSON.stringify(staleView));
    await overview({ workspace }, context);
    assert.equal(json(source.entry).observation, null);
    await entryDetails({ workspace, file: video, kind: "source" }, context);
    await overview({ workspace }, context);
    for (const value of [json(source.entry), json(current.overviewFile), located]) {
      assert.doesNotMatch(JSON.stringify(value), /Neutral hand\/tool/);
    }
    assert.doesNotMatch(readFileSync(current.catalogFile, "utf8"), /Neutral hand\/tool/);
    assert.match(json(current.indexFile).audio[0].transcript, /actual spoken/);
    assert.ok(existsSync(source.sheets[0].path));
  }
  await annotateBatch({ workspace: third, manifest: manifest(third, [{ file: video, kind: "source",
    observation: { text: "Current third-task selection", coverage: [[0, 5]], complete: true } }]) }, context);
  await index(third);
  assert.match(json(json(reused.indexFile).sources[0].entry).observation, /Current third-task/);
  await index(first);
  assert.match(json(source.entry).observation, /Neutral/, "own notes survive another task updating shared metadata");
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
  const audioIds = readFileSync(path.join(workspace,"media-catalog.jsonl"),"utf8").trim().split("\n")
    .map(JSON.parse).filter((row) => row.id.startsWith("aud-")).map((row) => ({id:row.id}));
  const first = await transcribeBatch({ workspace, manifest: manifest(workspace, audioIds) }, configured);
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

test("compact catalogue IDs resolve exact pictures, work in batches and reject stale or conflicting identities", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("catalogue-id", false);
  const indexed = await index(workspace);
  const rows = readFileSync(indexed.catalogFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => /^(ref|src|aud)-[a-f0-9]{12}$/.test(row.id)));
  assert.ok(readFileSync(indexed.catalogFile, "utf8").length < readFileSync(indexed.indexFile, "utf8").length / 2);
  const source = rows.find((row) => row.id.startsWith("src-"));
  const located = await locate({ workspace, ids: rows.slice(0, 2).map((row) => row.id).join(",") });
  assert.equal(located.entries[1].source, await fs.realpath(video));
  assert.ok(located.entries[1].sheets.every((sheet) => existsSync(sheet.path)));
  assert.equal(located.images[0].role, "reference");
  assert.equal(located.images[1].role, "source");
  assert.ok(located.images.every((image) => image.bytes === statSync(image.path).size && image.width > 0 && image.height > 0));
  assert.ok(located.imageGroups.every((group) => group.length <= 4));
  const entry = await entryDetails({workspace, id:source.id}, context);
  assert.equal(entry.source, await fs.realpath(video));
  assert.equal(entry.id, source.id);
  const result = await annotateBatch({workspace, manifest:manifest(workspace, [{id:source.id,
    observation:{text:"Looked at the whole isolated fixture", coverage:[[0,5]], complete:true}}])}, context);
  assert.equal(result.saved[0].sourceKey, entry.sourceKey);
  assert.ok(Number.isFinite(Date.parse(result.saved[0].observationCreatedAt)));
  assert.match((await locate({workspace,ids:source.id})).entries[0].observation, /whole isolated/);
  await assert.rejects(entryDetails({workspace,id:source.id,file:video},context), /只能填写一个/);
  await assert.rejects(locate({workspace,ids:"src-000000000000"}), /未知素材 id/);
  await assert.rejects(locate({workspace,ids:`${source.id},${source.id}`}), /不重复/);
  const all = json(indexed.indexFile);
  all.sources[0].sourceKey = "stale-key";
  writeFileSync(indexed.indexFile, JSON.stringify(all));
  const stale = mediaIds([{...all.sources[0],kind:"source"}])[0].id;
  await assert.rejects(locate({workspace,ids:stale}), /已变化.*index/);
});

test("IDs distinguish same names and kinds; reorder is stable, changed identity gets a new ID", () => {
  const views = [{kind:"source",sourceKey:"one",source:"a/name.mp4"},
    {kind:"source",sourceKey:"two",source:"b/name.mp4"}, {kind:"reference",sourceKey:"one"}];
  const first = mediaIds(views), reordered = mediaIds([...views].reverse()).reverse();
  assert.deepEqual(first.map((row) => row.id), reordered.map((row) => row.id));
  assert.equal(new Set(first.map((row) => row.id)).size, 3);
  assert.notEqual(mediaIds([{...views[0],sourceKey:"changed"}])[0].id, first[0].id);
});

test("visual evidence requires current source, current-task successful coverage and compatible record", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("evidence-current", false), indexed = await index(workspace);
  const source = json(indexed.indexFile).sources[0], image = source.sheets[0].path;
  const readEvidence = createVisualEvidenceReader(workspace);
  assert.deepEqual(await readEvidence([image]), []);
  await annotateBatch({workspace,manifest:manifest(workspace,[{file:video,kind:"source",
    observation:{text:"Only first second observed",coverage:[[0,1]],complete:false}}])},context);
  assert.deepEqual(await readEvidence([image]), [], "uncovered page stays an actual image");
  await annotateBatch({workspace,manifest:manifest(workspace,[{file:video,kind:"source",
    observation:{text:"Whole isolated source observed",coverage:[[0,5]],complete:true}}])},context);
  const valid = json(source.entry);
  assert.equal((await readEvidence([image]))[0].text, "Whole isolated source observed");
  for (const patch of [{originTaskId:"foreign"}, {version:9}, {sourceKey:"changed"}, {createdAt:"bad"}, {coverage:[[0,1]]}]) {
    writeFileSync(source.entry, JSON.stringify({...valid,analysis:{...valid.analysis,
      observation:{...valid.analysis.observation,...patch}}}));
    assert.deepEqual(await readEvidence([image]), [], JSON.stringify(patch));
  }
  writeFileSync(source.entry, JSON.stringify(valid));
  assert.equal((await readEvidence([image])).length, 1);
  assert.deepEqual(await readEvidence([path.join(workspace,"missing.jpg"),reference]), []);
  const foreign = task("evidence-foreign",true), foreignIndex = await index(foreign);
  assert.deepEqual(await createVisualEvidenceReader(foreign)([json(foreignIndex.indexFile).sources[0].sheets[0].path]), [],
    "enabled cross-task reuse does not prove this Session saw its pictures");
});

test("native context integration loads task-local evidence and leaves Session history and original JPEG intact", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("native-evidence",false), independentAssets = path.join(root,"Native 独立素材");
  mkdirSync(independentAssets,{recursive:true});
  const selectedVideo = path.join(independentAssets,"source.mp4"); await fs.copyFile(video,selectedVideo);
  writeFileSync(path.join(workspace,"media-policy.json"),JSON.stringify({version:1,taskId:"native-evidence",reuseVisualAnalysis:false,
    inputs:{referenceVideo:reference,assetsDir:independentAssets,audioDir:audio}}));
  const indexed = await indexTask({workspace,reference,assets:independentAssets,audio},context);
  const image = json(indexed.indexFile).sources[0].sheets[0].path;
  const timestamp = Date.now();
  const read = await createReadToolDefinition(workspace).execute("native-read",{path:image});
  const result = await annotateBatch({workspace,manifest:manifest(workspace,[{file:selectedVideo,kind:"source",
    observation:{text:"Observed actual isolated test imagery",coverage:[[0,5]],complete:true}}])},context);
  const modelReply = (time:number,toolCallId:string,name:string,args:object) => ({role:"assistant",timestamp:time,
    api:"openai-completions",provider:"fixture",model:"fixture",stopReason:"toolUse",
    content:[{type:"toolCall",id:toolCallId,name,arguments:args}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const messages = [modelReply(timestamp-1,"native-read","read",{path:image}),
    {role:"toolResult",timestamp,toolCallId:"native-read",toolName:"read",isError:false,content:read.content},
    modelReply(Date.parse(result.saved[0].observationCreatedAt),"native-save","bash",{command:
      `node "${path.join(project,".pi/skills/clip-skills/scripts/media-cache.mjs")}" annotate-batch --workspace "${workspace}" --manifest "analyses.json"`}),
    {role:"toolResult",timestamp:Date.now(),toolCallId:"native-save",toolName:"bash",isError:false,
      content:[{type:"text",text:JSON.stringify(result)}]}] as ContextEvent["messages"];
  const original = JSON.stringify(messages), bytes = readFileSync(image);
  const handler = createVisualContextHandler({workspace,projectRoot:project});
  const projected = await handler({type:"context",messages});
  assert.ok(projected);
  assert.equal(projected.messages[1].content.filter((block)=>block.type==="image").length,1,
    "saved neutral prose cannot replace actual selection imagery");
  assert.equal(JSON.stringify(messages),original);
  assert.deepEqual(readFileSync(image),bytes);
  assert.match(JSON.stringify(projected),/observationCreatedAt/);
  const planFile = path.join(workspace, "selected-plan.json");
  writeFileSync(planFile, JSON.stringify({ outputs: [], visual: { version: 1, taskId: "native-evidence", excluded: [image], active: [], finalized: false } }));
  const verified = await checkTaskPlan({ workspace, file: planFile });
  messages.push(modelReply(Date.now(), "native-check", "bash", {command:
    `node "${path.join(project,".pi/skills/clip-skills/scripts/media-cache.mjs")}" check-plan --workspace "${workspace}" --file "${planFile}"`}) as any,
    {role:"toolResult",timestamp:Date.now(),toolCallId:"native-check",toolName:"bash",isError:false,
      content:[{type:"text",text:JSON.stringify(verified)}]});
  assert.equal((await handler({type:"context",messages}))?.messages[1].content.filter((block)=>block.type==="image").length,0,
    "actual native read plus successful current-file CLI decision permits projection");
  writeFileSync(planFile, JSON.stringify({outputs:[],visual:{version:1,taskId:"native-evidence",excluded:[],active:[image],finalized:false}}));
  assert.equal((await handler({type:"context",messages}))?.messages[1].content.filter((block)=>block.type==="image").length,1,
    "changed selection restores image even before a new check result");
  await fs.appendFile(selectedVideo,"changed identity fixture");
  const changed = await handler({type:"context",messages});
  assert.equal(changed?.messages[1].content.filter((block)=>block.type==="image").length,1);
});

test("legacy task workspaces recover selected roots from the backend record, not the index", { skip: !hasMediaRuntime }, async () => {
  const taskDir = path.join(root, "legacy-backend-task");
  const workspace = path.join(taskDir, "workspace");
  mkdirSync(workspace, {recursive:true});
  writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({schemaVersion:3, id:"legacy-backend-task",
    input:{referenceVideo:reference, assetsDir:assets, audioDir:audio}}));
  const indexed = await index(workspace);
  assert.equal(json(indexed.indexFile).sources[0].cacheHit, true);
  assert.equal((await readMediaPolicy(workspace)).reuseVisualAnalysis, false);
  const wrong = {...json(path.join(taskDir, "task.json")), id:"different-task"};
  writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(wrong));
  await assert.rejects(index(workspace), /不属于当前任务/);
});

test("public CLI help exits successfully without workspace, input or dependency checks", () => {
  const cli = path.join(project, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs");
  const result = command(process.execPath, [cli, "transcribe-batch", "--help"]);
  assert.match(result, /transcribe-batch/);
});

test("visual decisions bind current-task sources and plan bytes; annotations/file presence alone authorize nothing", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("visual-plan-proof", false), indexed = await index(workspace);
  const source = json(indexed.indexFile).sources[0], ref = json(indexed.indexFile).reference;
  const file = path.join(workspace, "visual-plan.json");
  const plan = { outputs: [], visual: { version: 1, taskId: "visual-plan-proof", excluded: [source.sheets[0].path], active: [], finalized: false } };
  writeFileSync(file, JSON.stringify(plan));
  const checked = await checkTaskPlan({ workspace, file });
  assert.equal(checked.ok, true); assert.equal(checked.visual.excluded[0].sourceKey, source.sourceKey);
  const reader = createVisualStateReader(workspace);
  assert.equal((await reader([source.sheets[0].path], [checked.visual])).proofs.length, 1);
  writeFileSync(file, JSON.stringify({ ...plan, visual: { ...plan.visual, active: [ref.sheets[0].path] } }));
  assert.equal((await reader([source.sheets[0].path], [checked.visual])).proofs.length, 0, "changed plan invalidates old proof");
  for (const patch of [{ taskId: "foreign" }, { excluded: [ref.sheets[0].path] },
    { active: [source.sheets[0].path] }, { excluded: [reference] }, { finalized: true }]) {
    writeFileSync(file, JSON.stringify({ ...plan, visual: { ...plan.visual, ...patch } }));
    await assert.rejects(checkTaskPlan({ workspace, file }));
  }
  writeFileSync(file, JSON.stringify({ outputs: [] }));
  assert.equal((await checkTaskPlan({ workspace, file })).visual, undefined, "legacy check result cannot authorize pruning");
});

test("native write saves validated batch without extra model round; pending, reread, corruption and unseen pages remain", { skip: !hasMediaRuntime }, async () => {
  const workspace=task("selection-native",false), indexed=await index(workspace), view=json(indexed.indexFile).sources[0];
  const located=await locate({workspace,ids:mediaIds([{...view,kind:"source"}])[0].id}), descriptor=located.images[0];
  const file=path.join(workspace,"selections/one.json"), nativeRead=createReadToolDefinition(workspace), nativeWrite=createWriteToolDefinition(workspace);
  const read=await nativeRead.execute("image-read",{path:descriptor.path});
  const content=JSON.stringify({version:1,kind:"selection-batch",rows:[{image:descriptor.id,decisions:[{
    from:descriptor.from,to:descriptor.to,decision:"selected",purpose:"match narration",reason:"clear subject"}]}]});
  const reply=(id:string,name:string,args:object):any=>({role:"assistant",timestamp:Date.now(),api:"openai-completions",provider:"fixture",model:"fixture",stopReason:"toolUse",
    content:[{type:"toolCall",id,name,arguments:args}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const messages:any[]=[reply("image-read","read",{path:descriptor.path}),
    {role:"toolResult",toolName:"read",toolCallId:"image-read",isError:false,timestamp:Date.now(),content:read.content},
    reply("save","write",{path:file,content})];
  const ctx:any={sessionManager:{getBranch:()=>messages.map((message,i)=>({type:"message",id:String(i),message}))}};
  const write=await nativeWrite.execute("save",{path:file,content});
  const event:any={type:"tool_result",toolName:"write",toolCallId:"save",input:{path:file,content},content:write.content,isError:false};
  const runtime=createVisualRuntime({workspace,projectRoot:project});
  const result=await runtime.selectionResult(event,ctx);
  assert.notEqual(result?.isError,true); const proof=JSON.parse(result!.content[0].text).selection;
  assert.equal(proof.images[0].sourceKey,view.sourceKey);assert.match(proof.images[0].imageHash,/^[a-f0-9]{64}$/);
  messages.push({role:"toolResult",toolName:"write",toolCallId:"save",isError:false,timestamp:Date.now(),content:result!.content});
  const projected=await runtime.context({type:"context",messages},ctx);
  assert.equal(projected!.messages[1].content.filter((block:any)=>block.type==="image").length,0);
  assert.equal(messages[1].content.filter((block:any)=>block.type==="image").length,1,"native transcript not modified");
  const original=readFileSync(descriptor.path);
  writeFileSync(descriptor.path,Buffer.concat([original,Buffer.from("changed")]));
  assert.equal((await runtime.context({type:"context",messages},ctx))!.messages[1].content.filter((block:any)=>block.type==="image").length,1);
  writeFileSync(descriptor.path,original);
  const pending=JSON.parse(content);pending.rows[0].decisions[0].decision="pending";writeFileSync(file,JSON.stringify(pending));
  assert.equal((await checkSelectionBatch({workspace,file})).selection.images[0].complete,false);
  assert.equal((await runtime.context({type:"context",messages},ctx))!.messages[1].content.filter((block:any)=>block.type==="image").length,1);
  const incomplete=JSON.parse(content);incomplete.rows[0].decisions[0].to=descriptor.to-0.1;writeFileSync(file,JSON.stringify(incomplete));
  await assert.rejects(checkSelectionBatch({workspace,file}),/未覆盖整页/);
  assert.equal((await runtime.selectionResult(event,ctx))?.isError,true);
  writeFileSync(file,content);
  const unseen={sessionManager:{getBranch:()=>[{type:"message",message:messages[2]}]}} as any;
  assert.equal((await runtime.selectionResult(event,unseen))?.isError,true,"current file alone cannot prove model viewed image");
  const sameTurn={sessionManager:{getBranch:()=>[{type:"message",message:{...messages[0],content:[...messages[0].content,...messages[2].content]}},
    {type:"message",message:messages[1]}]}} as any;
  assert.equal((await runtime.selectionResult(event,sameTurn))?.isError,true);
});

test("complete visual plan validates requested slots, source ranges, main audio and shot timeline", { skip: !hasMediaRuntime }, async () => {
  const taskDir = path.join(root, "complete-visual-task"), workspace = path.join(taskDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "media-policy.json"), JSON.stringify({ version: 1, taskId: "complete-visual-task", reuseVisualAnalysis: false,
    inputs: { referenceVideo: reference, assetsDir: assets, audioDir: audio } }));
  const indexed = await index(workspace), sources = json(indexed.indexFile);
  const slot = "Clip-Studio-complete-visual-task-1-12345678.mp4";
  mkdirSync(path.join(taskDir, "delivery"));
  writeFileSync(path.join(taskDir, "delivery", "contract.json"), JSON.stringify({ version: 1, taskId: "complete-visual-task", workspace,
    outputDir: root, audioDir: audio, slots: [slot] }));
  const row = { output: slot, duration: 2, mainAudio: { source: sources.audio[0].source },
    shots: [{ source: sources.sources[0].source, start: 0, end: 2 }] };
  const plan = { outputs: [row], visual: { version: 1, taskId: "complete-visual-task", excluded: [], active: [], finalized: true } };
  const file = path.join(workspace, "plan.json"); writeFileSync(file, JSON.stringify(plan));
  const checked = await checkTaskPlan({ workspace, file });
  assert.equal(checked.visual.finalized, true); assert.equal(checked.visual.required.length, 2);
  for (const patch of [{ duration: 3 }, { output: "test.mp4" }, { mainAudio: null },
    { shots: [{ source: sources.sources[0].source, start: 0, end: 8 }] },
    { shots: [{ source: sources.sources[0].source, start: 0, end: 2, at: 1 }] }]) {
    writeFileSync(file, JSON.stringify({ ...plan, outputs: [{ ...row, ...patch }] }));
    await assert.rejects(checkTaskPlan({ workspace, file }));
  }
  writeFileSync(file, JSON.stringify({ ...plan, outputs: [row, row] }));
  await assert.rejects(checkTaskPlan({ workspace, file }), /全部成片/);
});

test("local detail/window source-time provenance stays accurate with reuse off and never needs saved prose", { skip: !hasMediaRuntime }, async () => {
  const workspace = task("detail-provenance", false);
  const still = await detail({ file: video, at: 1.5, workspace, output: path.join(workspace, "高清 图.jpg"), original: true }, context);
  assert.equal(still.images.length, 1); assert.equal(still.images[0].from, 1.5);
  assert.equal(still.images[0].source, await fs.realpath(video)); assert.equal(still.images[0].frameCount, 1);
  const window = await candidateWindow({ file: video, start: 1, end: 3, workspace }, context);
  assert.ok(window.images.length); assert.equal(window.images[0].from, 1); assert.equal(window.images[0].to, 3);
  assert.equal((await imageProvenance(workspace, [still.path, window.sheets[0].path])).length, 2);
});
