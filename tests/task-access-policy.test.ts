import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createRenderFailureHandler, createTaskAccessHandler } from "../src/pi/access-policy.js";
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
const compositionScript = path.join(path.dirname(queueScript), "write-compositions.mjs");
const hyperframes = path.join(projectRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const source = path.join(projectRoot, "src", "index.ts");
const outside = path.join(root, "unrelated", "secret.txt");
for (const directory of [workspace, otherTask, assetsDir, audioDir, outputDir,
  path.dirname(referenceVideo), path.dirname(skillDoc), path.dirname(mediaScript),
  path.dirname(queueScript), path.dirname(hyperframes), path.dirname(source), path.dirname(outside)]) {
  mkdirSync(directory, { recursive: true });
}
for (const file of [referenceVideo, skillDoc, mediaScript, queueScript, compositionScript, hyperframes, source, outside,
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
  assert.equal(bash(`HYPERFRAMES_SKIP_SKILLS=1 node ${q(hyperframes)} init video-project --non-interactive --example blank`), undefined);
  assert.equal(bash(`HYPERFRAMES_SKIP_SKILLS=1 node ${q(hyperframes)} check video-project`), undefined);
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

test("each clause in a legal batch chain is validated with its own cwd", () => {
  const probe = `ffprobe -v error -show_format ${q(referenceVideo)}`;
  assert.equal(bash(`${probe} && ffprobe -v error ${q(path.join(assetsDir, "素材.mp4"))} && ffprobe -v error ${q(path.join(audioDir, "配乐.mp3"))}`), undefined);
  assert.equal(bash(`cd ${q(assetsDir)} && ls && ffprobe -v error ${q(referenceVideo)} && cd ${q(workspace)} && mkdir parts`), undefined);
  assert.equal(bash(`${probe} && cat ${q(source)}`)?.block, true);
  assert.equal(bash(`cd ${q(assetsDir)} && ffmpeg -i ${q(referenceVideo)} ${q(path.join(workspace, "test.mp4"))}`)?.block, true);
  assert.equal(bash(`cd ${q(workspace)} && ${probe} && node -e "process.exit(0)"`)?.block, true);
  assert.equal(bash(`${probe} &&`)?.block, true);
  assert.equal(bash(`${probe} || cat ${q(source)}`)?.block, true);
  assert.equal(bash(`${probe}; cat ${q(source)}`)?.block, true);
  assert.equal(bash(`rm -rf ${workspace.replace(/\\/g, "/")}/*`)?.block, true);
});

test("read-only CLI help does not require a media input or project", () => {
  for (const command of [`npx hyperframes --help`, `npx hyperframes transcribe --help`,
    `node ${q(hyperframes)} transcribe -h`, `node ${q(hyperframes)} render --help`,
    `node ${q(mediaScript)} --help`, `node ${q(mediaScript)} index --help`,
    `node ${q(queueScript)} run --help`, `node ${q(queueScript)} template --help`,
    `node ${q(queueScript)} --help`]) assert.equal(bash(command), undefined, command);
  assert.equal(bash(`cd ${q(audioDir)} && node ${q(hyperframes)} transcribe --help`), undefined);
  assert.equal(bash(`node ${q(hyperframes)} transcribe --help ${q(outside)}`)?.block, true);
  assert.equal(bash(`node ${q(mediaScript)} --help ${q(outside)}`)?.block, true);
  assert.equal(bash(`node ${q(hyperframes)} auth login`)?.block, true);
});

test("denials identify an admitted alternative without broadening the boundary", () => {
  const docs = bash(`node ${q(hyperframes)} docs examples`);
  assert.equal(docs?.block, true);
  assert.match(docs?.reason ?? "", /hyperframes-core\/references\/minimal-composition\.md/);
  assert.doesNotMatch(docs?.reason ?? "", /不安装、更新/);
  const render = bash(`node ${q(hyperframes)} render video-project`);
  assert.equal(render?.block, true);
  assert.match(render?.reason ?? "", /渲染队列/);
  const search = call("find", { path: projectRoot, pattern: "*gsap*" });
  assert.equal(search?.block, true);
  assert.match(search?.reason ?? "", /技能文档根目录/);
  assert.ok(search?.reason?.includes(resolveTaskPaths(options).skillRoots[0]!.replace(/\\/g, "/")));
  const dynamicCopy = bash(`cp ${assetsDir.replace(/\\/g, "/")}/*.mp4 parts`);
  assert.equal(dynamicCopy?.block, true);
  assert.match(dynamicCopy?.reason ?? "", /单行 && 和明确文件名/);
});

test("template and compact media batch CLI forms remain confined to this task", () => {
  const manifest = path.join(workspace, "batch-input.json");
  const base = `--workspace ${q(workspace)}`;
  assert.equal(bash(`node ${q(queueScript)} template --manifest ${q(manifest)} ${base} --output-dir ${q(outputDir)} --project video-project`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} overview ${base}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} overview ${base} --offset 25 --limit 25`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} overview ${base} --limit 200`)?.block, true);
  assert.equal(bash(`node ${q(mediaScript)} entry --file ${q(referenceVideo)} --kind reference ${base}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} annotate-batch --manifest ${q(manifest)} ${base}`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} transcribe-batch --manifest ${q(manifest)} ${base} --model small.en --language auto`), undefined);
  assert.equal(bash(`node ${q(mediaScript)} annotate-batch --manifest ${q(outside)} ${base}`)?.block, true);
  assert.equal(bash(`node ${q(mediaScript)} transcribe-batch --manifest ${q(manifest)} ${base} --output ${q(outside)}`)?.block, true);
  assert.equal(bash(`node ${q(queueScript)} template --manifest ${q(manifest)} ${base} --output-dir ${q(outputDir)} --project ../escape`)?.block, true);
});

test("trusted version, image locator and batch composition calls have scoped admitted forms", () => {
  const base = `--workspace ${q(workspace)}`;
  const id = "src-123456789abc", other = "ref-abcdef123456";
  const manifest = path.join(workspace, "工程 清单.json");
  for (const command of [`node ${q(hyperframes)} --version`, `node ${q(hyperframes)} -V`,
    `cd ${q(assetsDir)} && node ${q(hyperframes)} --version`, `npx hyperframes --version`,
    `node ${q(mediaScript)} locate ${base} --ids ${id},${other}`,
    `node ${q(mediaScript)} entry ${base} --id ${id}`,
    `node ${q(mediaScript)} check-plan ${base} --file ${q(manifest)} --allow-reuse`,
    `node ${q(mediaScript)} check-plan --file ${q(manifest)}`,
    `node ${q(compositionScript)} --help`,
    `node ${q(compositionScript)} ${base} --manifest ${q(manifest)}`,
    `node ${q(hyperframes)} --version && node ${q(mediaScript)} locate ${base} --ids ${id}`]) {
    assert.equal(bash(command), undefined, command);
  }
  for (const command of [`node ${q(hyperframes)} --version ${q(outside)}`,
    `node ${q(hyperframes)} --version && cat ${q(source)}`,
    `node ${q(mediaScript)} locate ${base} --ids ../secret`,
    `node ${q(mediaScript)} entry ${base} --id ${id} --file ${q(referenceVideo)}`,
    `node ${q(mediaScript)} check-plan --workspace ${q(otherTask)} --file ${q(manifest)}`,
    `node ${q(mediaScript)} check-plan ${base} --file ${q(outside)}`,
    `node ${q(mediaScript)} check-plan ${base} --file ${q(manifest)} --allow-reuse --allow-reuse`,
    `node ${q(mediaScript)} check-plan ${base} --file ${q(manifest)} --eval true`,
    `node ${q(compositionScript)} ${base} --manifest ${q(outside)}`,
    `node ${q(compositionScript)} ${base} --manifest ${q(manifest)} --workspace ${q(otherTask)}`,
    `node ${q(compositionScript)} --workspace ${q(otherTask)} --manifest ${q(manifest)}`,
    `node ${q(compositionScript)} ${base} --manifest ${q(manifest)} --eval true`]) {
    assert.equal(bash(command)?.block, true, command);
  }
  assert.equal(call("read", { path: compositionScript })?.block, true, "trusted execution is not implementation read access");
});

test("backend-owned media preference remains readable but immutable through all admitted writes", (t) => {
  const policy = path.join(workspace, "media-policy.json");
  writeFileSync(policy, '{"version":1,"taskId":"task-one","reuseVisualAnalysis":false}');
  assert.equal(call("read", { path: policy }), undefined);
  for (const tool of ["write", "edit"]) assert.equal(call(tool, { path: policy })?.block, true);
  for (const command of [`rm ${q(policy)}`, `mv ${q(policy)} ${q(path.join(workspace, "removed.json"))}`,
    `cp ${q(path.join(otherTask, "media-policy.json"))} ${q(policy)}`,
    `ffprobe -v error -show_format ${q(referenceVideo)} > ${q(policy)}`,
    `ffmpeg -i ${q(referenceVideo)} ${q(policy)}`,
    `node ${q(queueScript)} template --manifest ${q(policy)} --workspace ${q(workspace)} --output-dir ${q(outputDir)}`,
    `rm -rf ${q(workspace)}`, `cp -r ${q(assetsDir)} ${q(workspace)}`]) {
    assert.equal(bash(command)?.block, true, command);
  }
  const alias = path.join(workspace, "policy-alias.json");
  try { linkSync(policy, alias); } catch { t.skip("file hardlinks unavailable"); return; }
  assert.equal(call("write", { path: alias })?.block, true);
  assert.equal(bash(`ffprobe -v error -show_format ${q(referenceVideo)} > ${q(alias)}`)?.block, true);
  assert.equal(readFileSync(policy, "utf8").includes('"reuseVisualAnalysis":false'), true);
  assert.equal(call("write", { path: path.join(workspace, "normal-observations.json") }), undefined);
});

test("deterministic validation guard ignores superficial schema guesses and resets on meaningful progress", () => {
  const manifest = path.join(workspace, "guard-manifest.json");
  const guard = createRenderFailureHandler(options);
  const command = `cd ${q(workspace)} && node ${q(queueScript)} run --manifest ${q(manifest)} --workspace ${q(workspace)} --output-dir ${q(outputDir)} 2>&1`;
  let id = 0;
  const run = (message: string | null) => {
    const toolCallId = `guard-${id++}`;
    guard.before({ toolName: "bash", toolCallId, input: { command } } as Parameters<typeof guard.before>[0]);
    return guard.after({ toolName: "bash", toolCallId, input: { command }, isError: message !== null,
      content: [{ type: "text", text: message ? `render-queue: ${message}\nCommand exited with code 1` : "completed" }] } as Parameters<typeof guard.after>[0]);
  };
  const missing = "[VALIDATION:ROWS] rows：缺失或不是数组。正式行必须放在顶层 rows 数组。";
  for (const guessed of [{ version: 1, renders: [] }, { version: 1, videos: [] }]) {
    writeFileSync(manifest, JSON.stringify(guessed));
    assert.equal(run(missing), undefined);
    guard.after({ toolName: "read", toolCallId: "unrelated-read", input: { path: skillDoc }, isError: false,
      content: [{ type: "text", text: "schema" }] } as Parameters<typeof guard.after>[0]);
  }
  writeFileSync(manifest, JSON.stringify({ version: 1, changed: "not rows" }));
  assert.match(run(missing) ?? "", /rows.*重复失败 3 次/);
  writeFileSync(manifest, JSON.stringify({ version: 1, rows: [] }));
  assert.equal(run("[VALIDATION:ROW_COUNT] rows.length：要求 1 行，实际 0 行。"), undefined);
  assert.equal(run(null), undefined);
  writeFileSync(manifest, JSON.stringify({ version: 1 }));
  assert.equal(run(missing), undefined, "a successful queue operation clears the guard");
  const retry = createRenderFailureHandler(options);
  retry.before({ toolName: "bash", toolCallId: "retry", input: { command } } as Parameters<typeof retry.before>[0]);
  assert.equal(retry.after({ toolName: "bash", toolCallId: "retry", input: { command }, isError: true,
    content: [{ type: "text", text: `render-queue: ${missing}` }] } as Parameters<typeof retry.after>[0]), undefined);
});

test("validation guard allows modified composition dependencies and does not count transient failures", () => {
  const project = path.join(workspace, "guard-project");
  mkdirSync(project, { recursive: true });
  const composition = path.join(project, "01.html");
  const manifest = path.join(workspace, "dependency-manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, project: "guard-project", rows: [{ composition: "01.html" }] }));
  const guard = createRenderFailureHandler(options);
  const command = `node ${q(queueScript)} run --manifest ${q(manifest)} --workspace ${q(workspace)} --output-dir ${q(outputDir)}`;
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(composition, `<div data-duration="${index + 1}"></div>`);
    const toolCallId = `dependency-${index}`;
    guard.before({ toolName: "bash", toolCallId, input: { command } } as Parameters<typeof guard.before>[0]);
    assert.equal(guard.after({ toolName: "bash", toolCallId, input: { command }, isError: true,
      content: [{ type: "text", text: "render-queue: [VALIDATION:MAIN_AUDIO] rows[0].mainAudio / composition：工程时长与主音频不符。" }] } as Parameters<typeof guard.after>[0]), undefined);
  }
  for (let index = 0; index < 4; index += 1) {
    const toolCallId = `transient-${index}`;
    guard.before({ toolName: "bash", toolCallId, input: { command } } as Parameters<typeof guard.before>[0]);
    assert.equal(guard.after({ toolName: "bash", toolCallId, input: { command }, isError: true,
      content: [{ type: "text", text: "render-queue: HyperFrames 退出码 1：device unavailable" }] } as Parameters<typeof guard.after>[0]), undefined);
  }
});

test("unknown execution, source reads, external writes and setup are stopped before execution", () => {
  const denied = [
    `node ${q(path.join(root, "unknown.mjs"))}`,
    `node -e "require('fs').readFileSync('secret')"`,
    `bash -c "cat ${source}"`,
    `cat ${q(source)}`,
    `cat ${q(outside)}`,
    `npx hyperframes doctor`,
    `npx hyperframes init video-project --non-interactive --example blank`,
    `node ${q(hyperframes)} init video-project --non-interactive --example blank`,
    `HYPERFRAMES_SKIP_SKILLS=1 node ${q(hyperframes)} init video-project --non-interactive --example remote`,
    `HYPERFRAMES_SKIP_SKILLS=1 node ${q(hyperframes)} init ../escape --non-interactive --example blank`,
    `HYPERFRAMES_SKIP_SKILLS=1 node ${q(hyperframes)} init video-project --non-interactive --example blank --video ${q(referenceVideo)}`,
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
