import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createTaskAccessHandler } from "../src/pi/access-policy.js";
import { pathInside, resolveTaskPaths, sameFilePath } from "../src/pi/task-paths.js";
import { TaskManager } from "../src/tasks/manager.js";
import { materializeTaskView } from "../.pi/skills/clip-skills/scripts/media-cache.mjs";

const root = mkdtempSync(path.join(tmpdir(), "clip-task-policy-"));
const projectRoot = path.join(root, "Clip Studio");
const tasksDir = path.join(projectRoot, "data", "tasks");
const workspace = path.join(tasksDir, "task-one", "workspace");
const otherTask = path.join(tasksDir, "task-two", "workspace");
const referenceVideo = path.join(root, "素材 文件", "参考.mp4");
const assetsDir = path.join(root, "素材 文件", "实拍");
const audioDir = path.join(root, "素材 文件", "音频");
const outputDir = path.join(root, "输出 成片");
const skillDoc = path.join(projectRoot, ".pi", "skills", "clip-skills", "SKILL.md");
const mediaScript = path.join(projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs");
const queueScript = path.join(projectRoot, ".pi", "skills", "hyperframes", "hyperframes-cli", "scripts", "render-queue.mjs");
const hyperframes = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const source = path.join(projectRoot, "src", "index.ts");
const outside = path.join(root, "unrelated", "secret.txt");
for (const directory of [workspace, otherTask, assetsDir, audioDir, outputDir,
  path.dirname(referenceVideo), path.dirname(skillDoc), path.dirname(mediaScript),
  path.dirname(queueScript), path.dirname(hyperframes), path.dirname(source), path.dirname(outside)]) {
  mkdirSync(directory, { recursive: true });
}
for (const file of [referenceVideo, skillDoc, mediaScript, queueScript, hyperframes, source, outside,
  path.join(assetsDir, "素材.mp4"), path.join(audioDir, "配乐.mp3")]) writeFileSync(file, "fixture");

const options = { projectRoot, tasksDir, workspace, referenceVideo, assetsDir, audioDir, outputDir };
const handler = createTaskAccessHandler(options);
const call = (toolName: string, input: Record<string, unknown>) => handler({ toolName, input } as Parameters<typeof handler>[0]);
const bash = (command: string) => call("bash", { command });
const q = (value: string) => `"${value.replace(/\\/g, "/")}"`;

after(() => {
  assert.equal(pathInside(tmpdir(), root), true);
  rmSync(root, { recursive: true, force: true });
});

test("task path table accepts selected input and safe output but rejects overlap", () => {
  assert.equal(sameFilePath(resolveTaskPaths(options).workspace, workspace), true);
  assert.throws(() => resolveTaskPaths({ ...options, outputDir: assetsDir }), /输出目录.*重叠/);
  assert.throws(() => resolveTaskPaths({ ...options, assetsDir: projectRoot }), /素材目录.*重叠/);
  assert.throws(() => resolveTaskPaths({ ...options, outputDir: path.join(projectRoot, "src", "out") }), /输出目录.*重叠/);
  assert.throws(() => resolveTaskPaths({ ...options, referenceVideo: source }), /参考视频.*程序目录/);
});

test("native tools use task roles, not a repository denylist", () => {
  for (const file of [referenceVideo, assetsDir, audioDir, workspace, outputDir, skillDoc]) {
    assert.equal(call("read", { path: file }), undefined, file);
  }
  for (const file of [source, mediaScript, otherTask, outside, path.join(projectRoot, ".runtime", "media-cache", "v1")]) {
    assert.equal(call("read", { path: file })?.block, true, file);
  }
  assert.equal(call("write", { path: path.join(workspace, "工程.html") }), undefined);
  assert.equal(call("edit", { path: path.join(outputDir, "wrong.mp4") })?.block, true);
  assert.equal(call("ls", { path: projectRoot })?.block, true);
});

test("existing directory junction cannot move a write or read outside the task", (t) => {
  const link = path.join(workspace, "linked");
  try { symlinkSync(path.dirname(outside), link, process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("directory links unavailable on this host"); return; }
  assert.equal(call("write", { path: path.join(link, "new.txt") })?.block, true);
  assert.equal(call("read", { path: path.join(link, "secret.txt") })?.block, true);
});

test("a dangling link is not treated as a future file in the workspace", (t) => {
  const link = path.join(workspace, "dangling.txt");
  try { symlinkSync(path.join(root, "missing-secret.txt"), link, "file"); }
  catch { t.skip("file links unavailable on this host"); return; }
  assert.equal(call("write", { path: link })?.block, true);
});

test("a future output below a junction into source is rejected before mkdir", (t) => {
  const link = path.join(root, "source-output-link");
  try { symlinkSync(path.dirname(source), link, process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("directory links unavailable on this host"); return; }
  assert.throws(() => resolveTaskPaths({ ...options, outputDir: path.join(link, "future") }), /输出目录.*重叠/);
});

test("Windows casing and a not-yet-created output directory use canonical paths", () => {
  const future = path.join(root, "另一个 输出目录");
  assert.equal(pathInside(root, resolveTaskPaths({ ...options, outputDir: future }).outputDir), true);
  if (process.platform === "win32") assert.equal(call("read", { path: referenceVideo.toUpperCase() }), undefined);
});

test("media cache exposes only task-local image copies to Pi", async () => {
  const directory = path.join(projectRoot, ".runtime", "media-cache", "v1", "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "frame.jpg"), "frame");
  writeFileSync(path.join(directory, "sheet.jpg"), "sheet");
  writeFileSync(path.join(directory, "entry.json"), "{}");
  const view = await materializeTaskView({
    source: referenceVideo, directory, cacheHit: true, duration: 1,
    geometry: {}, observation: "", transcript: "",
    frames: [{ at: 0, name: "frame.jpg" }], sheets: [{ name: "sheet.jpg" }],
  }, workspace, "reference");
  assert.equal(pathInside(workspace, view.frames[0].path), true);
  assert.equal(readFileSync(view.sheets[0].path, "utf8"), "sheet");
  assert.equal(call("read", { path: view.sheets[0].path }), undefined);
  assert.equal(call("read", { path: path.join(directory, "sheet.jpg") })?.block, true);
});

test("known CLI entries allow media analysis, local audio and render queue", () => {
  assert.equal(bash(`node ${q(mediaScript)} index --reference ${q(referenceVideo)} --assets ${q(assetsDir)} --audio ${q(audioDir)} --workspace ${q(workspace)}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} detail --file ${q(path.join(assetsDir, "素材.mp4"))} --at 2 --workspace ${q(workspace)} --output ${q(path.join(workspace, "detail.jpg"))}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} window --file ${q(path.join(assetsDir, "素材.mp4"))} --start 1 --end 3 --workspace ${q(workspace)}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} resheet --file ${q(path.join(assetsDir, "素材.mp4"))} --kind source --workspace ${q(workspace)} --batch-size 9`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} check-plan --file ${q(path.join(workspace, "plan.json"))}`), undefined);
  assert.equal(bash(`node ${q(queueScript)} run --manifest ${q(path.join(workspace, "render-manifest.json"))} --workspace ${q(workspace)} --output-dir ${q(outputDir)}`), undefined);
  assert.equal(bash(`npx hyperframes transcribe ${q(path.join(audioDir, "配乐.mp3"))} --model small --dir ${q(workspace)}`), undefined);
  assert.equal(bash(`npx hyperframes beats ${q(workspace)} --json`), undefined);
  assert.equal(bash(`npx hyperframes check --dir ${q(workspace)}`), undefined);
  const note = path.join(workspace, "镜头观察.txt");
  writeFileSync(note, "observation");
  assert.equal(bash(`node ${q(mediaScript)} annotate --file ${q(path.join(assetsDir, "素材.mp4"))} --kind source --text-file ${q(note)}`), undefined);
});

test("read-only probes and bounded diagnostic pipes remain available", () => {
  assert.equal(bash(`ffprobe -v error -show_format ${q(referenceVideo)}`), undefined);
  assert.equal(bash(`ffprobe -v error -show_format ${q(referenceVideo)} | head -n 10`), undefined);
  assert.equal(bash(`cd ${q(assetsDir)} && ls`), undefined);
  assert.equal(bash(`ffmpeg -i ${q(referenceVideo)} -af silencedetect=noise=-30dB:d=0.5 -f null - 2>&1 | grep silence`), undefined);
  assert.equal(bash(`ffmpeg -i ${q(referenceVideo)} ${q(path.join(workspace, "audio.wav"))}`), undefined);
  assert.equal(bash(`ffmpeg -i ${q(referenceVideo)} ${q(path.join(outputDir, "wrong.mp4"))}`)?.block, true);
});

test("unknown execution, source reads, external writes and setup are stopped before execution", () => {
  const denied = [
    `node ${q(path.join(root, "unknown.mjs"))}`,
    `node -e "require('fs').readFileSync('secret')"`,
    `bash -c "cat ${source}"`,
    `cat ${q(source)}`,
    `cat ${q(outside)}`,
    `npx hyperframes doctor`,
    `npm install anything`,
    `hyperframes auth login`,
    `hyperframes render --output ${q(path.join(outputDir, "wrong.mp4"))}`,
    `npx hyperframes transcribe ${q(path.join(audioDir, "配乐.mp3"))} --model small`,
    `node ${q(mediaScript)} index --reference ${q(referenceVideo)} --assets ${q(assetsDir)} --audio ${q(audioDir)} --workspace ${q(workspace)} --workspace ${q(outside)}`,
    `ffmpeg -i ${q(referenceVideo)} ${q(path.join(assetsDir, "overwrite.bin"))}`,
  ];
  for (const command of denied) assert.equal(bash(command)?.block, true, command);
});

test("a valid operation resets the repeated-denial limit", () => {
  let reason = "";
  const stateful = createTaskAccessHandler({ ...options, onTermination: (value) => { reason = value; } });
  const event = { toolName: "read", input: { path: source } } as Parameters<typeof stateful>[0];
  assert.equal(stateful(event)?.terminate, false);
  assert.equal(stateful(event)?.terminate, false);
  assert.equal(stateful({ toolName: "read", input: { path: referenceVideo } } as Parameters<typeof stateful>[0]), undefined);
  assert.equal(stateful(event)?.terminate, false);
  assert.equal(reason, "");
  stateful(event);
  assert.equal(stateful(event)?.terminate, true);
  assert.match(reason, /连续重复 3 次/);
});

test("task creation and retry check paths before starting a Pi session", async (t) => {
  let sessions = 0;
  const manager = new TaskManager({
    projectRoot, tasksDir, agentDir: path.join(projectRoot, "data", "pi"),
    outputValidator: async () => [],
    sessionFactory: async () => {
      sessions += 1;
      return { prompt: async () => {}, abort: async () => {}, dispose: () => {} };
    },
  });
  const model = { provider: "fixture", model: "fixture", apiKey: "test-only" };
  const input = { referenceVideo, assetsDir, audioDir, outputDir: assetsDir,
    taskRequest: "fixture", generateCount: 1, model, modelCapabilityId: "fixture" };
  await assert.rejects(manager.createTask(input), /输出目录.*重叠/);
  assert.equal(sessions, 0);
  await assert.rejects(manager.createTask({ ...input, outputDir: path.join(assetsDir, model.apiKey) }),
    (error: unknown) => error instanceof Error && !error.message.includes(model.apiKey));
  assert.equal(sessions, 0);
  const dedicatedOutput = path.join(root, "manager-output");
  const task = await manager.createTask({ ...input, outputDir: dedicatedOutput });
  for (let index = 0; index < 50 && manager.getTask(task.id)?.status !== "failed"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.getTask(task.id)?.status, "failed");
  assert.equal(sessions, 1);
  rmSync(dedicatedOutput, { recursive: true });
  try { symlinkSync(assetsDir, dedicatedOutput, process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("directory links unavailable on this host"); return; }
  await assert.rejects(manager.retryTask(task.id, model), /输出目录.*重叠/);
  assert.equal(sessions, 1);
});
