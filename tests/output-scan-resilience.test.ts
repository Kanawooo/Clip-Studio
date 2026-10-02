import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsModule, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { TaskManager, type PiSessionLike } from "../src/tasks/manager.js";
import { scanDeliveredOutputs, type DeliveryProof } from "../src/tasks/delivery.js";
import { isOutputReadUnavailable, outputReadRecoveryExhausted, readOutput, recoverOutputRead,
  videoContentHash, waitForOutputRead } from "../src/tasks/outputs.js";
import type { Task } from "../src/tasks/types.js";

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "Clip Studio 输出恢复 ")));
  const assetsDir = path.join(root, "素材"), audioDir = path.join(root, "音频");
  const outputDir = path.join(root, "输出"), referenceVideo = path.join(root, "参考.mp4");
  await Promise.all([assetsDir, audioDir, outputDir].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(referenceVideo, "offline-reference");
  return { root, assetsDir, audioDir, outputDir, referenceVideo, tasksDir: path.join(root, "任务") };
}

function ioFailure(file: string, code = "UNKNOWN", syscall = "realpath") {
  return Object.assign(new Error(`${code}: injected ${syscall} failure at ${file}`), {
    code, syscall, path: file, errno: -4094,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "offline condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("one delivery realpath UNKNOWN does not abort the running native Session", async (t) => {
  const item = await fixture();
  let aborts = 0, prompts = 0;
  let rejectPrompt!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
  const manager = new TaskManager({ projectRoot: path.resolve("."), tasksDir: item.tasksDir,
    agentDir: path.join(item.root, "agent"), outputScanIntervalMs: 100,
    sessionFactory: async () => ({ prompt: () => { prompts += 1; return pending; },
      abort: async () => { aborts += 1; rejectPrompt(new Error("fixture stopped")); }, dispose: () => {} }),
  });
  t.after(async () => {
    t.mock.restoreAll();
    await manager.shutdown();
    await fs.rm(item.root, { recursive: true, force: true });
  });
  const task = await manager.createTask({ ...item, generateCount: 1, taskRequest: "离线测试",
    modelCapabilityId: "offline", model: { provider: "test", model: "test", apiKey: "fixture-only" } });
  const directory = path.join(item.tasksDir, task.id, "delivery");
  const realpath = fs.realpath.bind(fs);
  let injected = 0;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === directory && injected === 0) { injected += 1; throw ioFailure(directory); }
    return realpath(file);
  });
  await waitFor(() => injected === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(task.status, "running", "one output-only read failure must not terminate production");
  assert.equal(aborts, 0);
  assert.equal(prompts, 1);
  assert.equal(task.outputs.length, 0, "unverified output cannot be counted");
});

const model = { provider: "test", model: "test", apiKey: "fixture-only" };
const projectRoot = path.resolve(".");
const ffmpeg = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
const ffprobe = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffprobe.exe");

async function runningFixture(t: TestContext, count = 1) {
  const item = await fixture();
  const calls = { sessions: 0, prompts: 0, aborts: 0, disposals: 0 };
  let resolve!: () => void, reject!: (error: Error) => void;
  let pending: Promise<void>;
  const manager = new TaskManager({ projectRoot, tasksDir: item.tasksDir,
    agentDir: path.join(item.root, "agent"), outputScanIntervalMs: 100,
    sessionFactory: async (_input, _workspace, options): Promise<PiSessionLike> => {
      calls.sessions++;
      pending = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      const sessionFile = path.join(options.sessionDir, "native.jsonl");
      await fs.writeFile(sessionFile, "offline session");
      return { sessionFile, restoredSession: !!options.resumeSessionFile,
        prompt: () => { calls.prompts++; return pending; },
        abort: async () => { calls.aborts++; reject(new Error("fixture stopped")); },
        dispose: () => { calls.disposals++; } };
    },
  });
  const previousProbe = process.env.HYPERFRAMES_FFPROBE_PATH;
  process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
  t.after(async () => {
    t.mock.restoreAll();
    await manager.shutdown();
    if (previousProbe === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
    else process.env.HYPERFRAMES_FFPROBE_PATH = previousProbe;
    await fs.rm(item.root, { recursive: true, force: true });
  });
  const task = await manager.createTask({ ...item, generateCount: count, taskRequest: "离线测试",
    modelCapabilityId: "offline", model });
  const taskDir = path.join(item.tasksDir, task.id);
  return { ...item, task, taskDir, manager, calls, resolve: () => resolve(), reject: (error: Error) => reject(error) };
}

async function publish(item: { task: Task; taskDir: string }, index = 1) {
  const output = path.join(item.task.input.outputDir, item.task.delivery!.slots[index - 1]!);
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=0.3",
    "-c:v", "libx264", "-y", output], { timeout: 10_000, windowsHide: true });
  const bytes = await fs.readFile(output);
  const receipt = path.join(item.taskDir, "delivery", `${index}.json`);
  await fs.writeFile(receipt, JSON.stringify({ version: 1, index, output, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), duration: 0.3, audioTarget: 0.3,
    silent: false, rowSignature: "offline", inputs: [] }));
  return { output, receipt };
}

test("readonly helper succeeds immediately and retries each genuine candidate at most three times", async () => {
  let calls = 0;
  assert.equal(await readOutput("test", "fixture", async () => { calls++; return 42; }), 42);
  assert.equal(calls, 1);
  for (const code of ["UNKNOWN", "EBUSY", "EAGAIN", "EMFILE", "ENFILE", "EIO"]) {
    calls = 0;
    const cause = ioFailure("fixture", code, "read");
    await assert.rejects(readOutput("read", "fixture", async () => { calls++; throw cause; }), (error: unknown) => {
      assert.ok(isOutputReadUnavailable(error));
      assert.equal((error as Error).cause, cause);
      assert.match((error as Error).message, new RegExp(`${code}/read.*3`));
      return true;
    });
    assert.equal(calls, 3);
  }
});

test("permanent, process, JSON and lookalike model failures are not read retries", async () => {
  for (const error of [ioFailure("fixture", "ENOENT"), ioFailure("fixture", "EACCES"),
    ioFailure("fixture", "EPERM"), ioFailure("fixture", "EIO", "spawn"),
    ioFailure("fixture", "UNKNOWN", "write"), new SyntaxError("UNKNOWN realpath"),
    new Error("model EIO read"), { code: "UNKNOWN", syscall: "realpath" }]) {
    let calls = 0;
    await assert.rejects(readOutput("test", "fixture", async () => { calls++; throw error; }), (actual) => actual === error);
    assert.equal(calls, 1);
  }
});

test("read cancellation and the count/time budget are bounded without timing normal reads", async () => {
  assert.equal(outputReadRecoveryExhausted(9, 100, 15_099), false);
  assert.equal(outputReadRecoveryExhausted(10, 100, 101), true);
  assert.equal(outputReadRecoveryExhausted(2, 100, 15_100), true);
  const controller = new AbortController();
  const reason = new Error("user stop");
  const waiting = waitForOutputRead(15_000, controller.signal);
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  let calls = 0;
  await assert.rejects(readOutput("test", "fixture", async () => { calls++; return 1; }, { signal: controller.signal }));
  assert.equal(calls, 0);
});

test("short multi-scan unavailability recovers even when a successful scan finds no output", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  let errorsLeft = 6;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && errorsLeft-- > 0) throw ioFailure(target);
    return actual(file);
  });
  await waitFor(() => item.task.statusText.includes("暂时不可用"));
  assert.equal(item.task.status, "running");
  await waitFor(() => errorsLeft < 0 && !item.task.statusText.includes("暂时不可用"));
  assert.equal(item.calls.aborts, 0);
  assert.equal(item.task.outputs.length, 0);
  const video = await publish(item);
  await waitFor(() => item.task.outputs.length === 1);
  assert.equal(item.task.outputs[0]!.path, video.output);
  item.resolve();
  await waitFor(() => item.task.status === "completed");
  assert.equal(item.calls.prompts, 1);
});

test("continuous output-only failure stops at ten full failed scans, once, with the real cause", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  let reads = 0;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) { reads++; throw ioFailure(target); }
    return actual(file);
  });
  await waitFor(() => item.task.status === "failed", 7_000);
  await waitFor(() => item.calls.disposals === 1);
  assert.equal(reads, 30);
  assert.equal(item.calls.aborts, 1);
  assert.equal(item.calls.prompts, 1);
  assert.match(item.task.error!, /10 轮.*UNKNOWN\/realpath/);
  assert.equal(item.task.outputs.length, 0);
});

test("force scan recovers a short failure and completes only from a newly verified receipt", async (t) => {
  const item = await runningFixture(t);
  await publish(item);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  let errorsLeft = 3;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && errorsLeft-- > 0) throw ioFailure(target);
    return actual(file);
  });
  item.resolve();
  await waitFor(() => item.task.status === "completed", 4_000);
  assert.equal(item.task.outputs.length, 1);
  assert.equal(item.calls.aborts, 0);
  assert.equal(item.calls.prompts, 1);
});

test("final unavailable verification does not complete from cache or report a count shortage", async (t) => {
  const item = await runningFixture(t);
  await publish(item);
  await waitFor(() => item.task.outputs.length === 1);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs), now = Date.now.bind(Date);
  let offset = 0, reads = 0;
  t.mock.method(Date, "now", () => now() + offset);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) { if (++reads > 3) offset = 16_000; throw ioFailure(target); }
    return actual(file);
  });
  item.resolve();
  await waitFor(() => item.task.status === "failed", 20_000);
  assert.equal(item.task.outputs.length, 1, "last verified output remains available but cannot complete an unavailable force scan");
  assert.equal(item.task.statusText, "无法验证输出视频");
  assert.match(item.task.error!, /连续读取失败.*UNKNOWN/);
  assert.doesNotMatch(item.task.error!, /要求.*找到/);
  assert.equal(item.calls.prompts, 1);
});

test("a model failure remains the primary reason when cleanup verification also fails", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) throw ioFailure(target, "EACCES");
    return actual(file);
  });
  item.reject(new Error(`upstream 524 ${model.apiKey}`));
  await waitFor(() => item.task.status === "failed");
  assert.equal(item.task.statusText, "制作失败");
  assert.match(item.task.error!, /^upstream 524.*输出验证亦未完成.*EACCES/);
  assert.ok(!item.task.error!.includes(model.apiKey));
});

test("stop cancels waiting reads, retains aborted state and disposes once", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) throw ioFailure(target);
    return actual(file);
  });
  await waitFor(() => item.task.statusText.includes("暂时不可用"));
  await Promise.all([item.manager.abortTask(item.task.id), item.manager.abortTask(item.task.id)]);
  assert.equal(item.task.status, "aborted");
  assert.equal(item.calls.aborts, 1);
  assert.equal(item.calls.disposals, 1);
  assert.match(item.task.error!, /停止后输出验证未完成.*UNKNOWN/);
});

test("a full successful scan resets the failure budget and does not impose a duration timeout", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs), now = Date.now.bind(Date);
  let phase: "fail" | "success" = "fail", reads = 0, offset = 0;
  t.mock.method(Date, "now", () => now() + offset);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && phase === "fail") { reads++; throw ioFailure(target); }
    return actual(file);
  });
  await waitFor(() => item.task.statusText.includes("暂时不可用"));
  phase = "success";
  await waitFor(() => !item.task.statusText.includes("暂时不可用"));
  offset = 30_000;
  phase = "fail";
  const before = reads;
  await waitFor(() => reads >= before + 3 && item.task.statusText.includes("暂时不可用"));
  assert.equal(item.task.status, "running", "success reset removes the earlier 15-second failure window");
});

test("row read failures preserve the entire last proof map and actual invalid receipts remain rejected", async (t) => {
  const item = await runningFixture(t, 2);
  const first = await publish(item, 1), second = await publish(item, 2);
  const proofs = new Map<number, DeliveryProof>();
  const good = await scanDeliveredOutputs(item.task, item.taskDir, proofs, true);
  assert.equal(good.outputs.length, 2);
  const saved = new Map(proofs);
  await fs.writeFile(first.receipt, "bad json");
  const actual = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", async (file: Parameters<typeof fs.readFile>[0], options: Parameters<typeof fs.readFile>[1]) => {
    if (String(file) === second.receipt) throw ioFailure(second.receipt, "EIO", "read");
    return actual(file, options);
  });
  await assert.rejects(scanDeliveredOutputs(item.task, item.taskDir, proofs, true), isOutputReadUnavailable);
  assert.deepEqual(proofs, saved, "a later unavailable row cannot commit earlier proof deletions");
  t.mock.restoreAll();
  const rejected = await scanDeliveredOutputs(item.task, item.taskDir, proofs, true);
  assert.equal(rejected.outputs.length, 1);
  assert.match(rejected.failures.join(" "), /凭据无效/);
  assert.equal(proofs.has(0), false);
});

test("missing receipts are pending, missing roots and escaping receipts keep their original checks", async (t) => {
  const item = await runningFixture(t);
  assert.deepEqual(await scanDeliveredOutputs(item.task, item.taskDir), { outputs: [], failures: [] });
  const outside = path.join(item.root, "outside.json");
  await fs.writeFile(outside, "{}");
  const link = path.join(item.taskDir, "delivery", "1.json");
  await fs.symlink(outside, link);
  assert.match((await scanDeliveredOutputs(item.task, item.taskDir)).failures.join(" "), /越界/);
  await fs.unlink(link);
  await fs.rename(path.join(item.taskDir, "delivery"), path.join(item.taskDir, "hidden-delivery"));
  await assert.rejects(scanDeliveredOutputs(item.task, item.taskDir), { code: "ENOENT" });
});

test("history hides unverified outputs and never overwrites disk with an empty read-failure result", async (t) => {
  const item = await runningFixture(t);
  await publish(item);
  item.resolve();
  await waitFor(() => item.task.status === "completed" && item.calls.disposals === 1);
  await item.manager.shutdown();
  const stored = path.join(item.taskDir, "task.json");
  const before = await fs.readFile(stored, "utf8");
  const target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) throw ioFailure(target, "EACCES");
    return actual(file);
  });
  const history = new TaskManager({ projectRoot, tasksDir: item.tasksDir, agentDir: path.join(item.root, "agent") });
  t.after(() => history.shutdown());
  assert.equal(history.getTask(item.task.id)!.outputs.length, 0);
  await waitFor(() => history.getTask(item.task.id)!.error?.includes("历史成片验证未完成") === true);
  assert.equal(history.getTask(item.task.id)!.status, "completed");
  assert.equal(await fs.readFile(stored, "utf8"), before);
});

test("history short failure recovers and shutdown interrupts persistent recovery without erasing saved output", async (t) => {
  const item = await runningFixture(t);
  await publish(item);
  item.resolve();
  await waitFor(() => item.task.status === "completed" && item.calls.disposals === 1);
  await item.manager.shutdown();
  const stored = path.join(item.taskDir, "task.json"), target = path.join(item.taskDir, "delivery");
  const actual = fs.realpath.bind(fs);
  let errorsLeft = 3;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && errorsLeft-- > 0) throw ioFailure(target);
    return actual(file);
  });
  const history = new TaskManager({ projectRoot, tasksDir: item.tasksDir, agentDir: path.join(item.root, "agent") });
  assert.equal(history.getTask(item.task.id)!.outputs.length, 0);
  await waitFor(() => history.getTask(item.task.id)!.outputs.length === 1, 4_000);
  await history.shutdown();
  errorsLeft = 100;
  const stoppedHistory = new TaskManager({ projectRoot, tasksDir: item.tasksDir, agentDir: path.join(item.root, "agent") });
  await waitFor(() => errorsLeft < 100);
  await stoppedHistory.shutdown();
  assert.equal(JSON.parse(await fs.readFile(stored, "utf8")).outputs.length, 1);
});

test("retry preflight read failure does not open a Session and admission is released for a corrected retry", async (t) => {
  const item = await runningFixture(t);
  item.reject(new Error("original model failure"));
  await waitFor(() => item.task.status === "failed" && item.calls.disposals === 1);
  const target = path.join(item.taskDir, "delivery"), actual = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) throw ioFailure(target, "EACCES");
    return actual(file);
  });
  await assert.rejects(item.manager.retryTask(item.task.id, model), /无法恢复原任务输出.*EACCES/);
  assert.equal(item.calls.sessions, 1);
  assert.equal(item.task.status, "failed");
  assert.match(item.task.error!, /original model failure/);
  t.mock.restoreAll();
  const retry = await item.manager.retryTask(item.task.id, model);
  assert.equal(retry!.id, item.task.id);
  assert.equal(item.calls.sessions, 2);
  assert.equal(item.calls.prompts, 2);
});

test("a whole-recovery loop shares the ten/15-second budget", async (t) => {
  const now = Date.now.bind(Date);
  let offset = 0, reads = 0;
  t.mock.method(Date, "now", () => now() + offset);
  await assert.rejects(recoverOutputRead(() => readOutput("read", "fixture", async () => {
    if (++reads > 3) offset = 16_000;
    throw ioFailure("fixture");
  })), /连续读取失败（2 轮）.*UNKNOWN/);
  assert.equal(reads, 6);
});

test("content hashing uses the same read helper and does not reuse a failed hash accumulator", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const bytes = Buffer.from("independent hash bytes");
  const file = path.join(item.root, "hash.bin");
  await fs.writeFile(file, bytes);
  const actual = fsModule.createReadStream.bind(fsModule);
  let streams = 0;
  t.mock.method(fsModule, "createReadStream", (target: Parameters<typeof fsModule.createReadStream>[0], options: Parameters<typeof fsModule.createReadStream>[1]) => {
    if (++streams === 1) return new Readable({ read() {
      this.push(Buffer.from("partial, failed read"));
      this.destroy(ioFailure(file, "EIO", "read"));
    } });
    return actual(target, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await videoContentHash(file), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(streams, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(videoContentHash(file, controller.signal));
});

test("background scans never overlap a slow normal read and stop prevents late publication", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery"), actual = fs.realpath.bind(fs);
  let release!: () => void, started = false, active = 0, peak = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && !started) {
      started = true;
      active++;
      peak = Math.max(peak, active);
      await hold;
      active--;
    } else if (String(file) === target) peak = Math.max(peak, ++active), active--;
    return actual(file);
  });
  await waitFor(() => started);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(peak, 1);
  const stopping = item.manager.abortTask(item.task.id);
  release();
  await stopping;
  assert.equal(item.task.status, "aborted");
  await item.manager.retryTask(item.task.id, model);
  assert.equal(item.task.status, "running");
  assert.equal(item.task.outputs.length, 0);
  assert.equal(item.calls.sessions, 2);
});

test("transient failures on alternating roots share one budget and warnings are redacted and bounded", async (t) => {
  const item = await runningFixture(t);
  const targets = [path.join(item.taskDir, "delivery"), item.task.input.outputDir];
  const actual = fs.realpath.bind(fs);
  let reads = 0, rootIndex = 0;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === targets[rootIndex]) {
      const error = ioFailure(`${targets[rootIndex]} ${model.apiKey}`);
      if (++reads % 3 === 0) rootIndex = 1 - rootIndex;
      throw error;
    }
    return actual(file);
  });
  await waitFor(() => item.task.status === "failed", 7_000);
  assert.match(item.task.error!, /10 轮/);
  await waitFor(() => item.calls.aborts === 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings.some((line) => line.includes(model.apiKey)), false);
  assert.equal(item.task.error!.includes(model.apiKey), false);
  assert.equal(item.calls.aborts, 1);
});

test("history recovery budget exhaustion is visible and cannot authorize playback of stale outputs", async (t) => {
  const item = await runningFixture(t);
  await publish(item);
  item.resolve();
  await waitFor(() => item.task.status === "completed" && item.calls.disposals === 1);
  await item.manager.shutdown();
  const target = path.join(item.taskDir, "delivery"), stored = path.join(item.taskDir, "task.json");
  const original = await fs.readFile(stored, "utf8"), actual = fs.realpath.bind(fs), now = Date.now.bind(Date);
  let reads = 0, offset = 0;
  t.mock.method(Date, "now", () => now() + offset);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) {
      if (++reads > 3) offset = 16_000;
      throw ioFailure(target);
    }
    return actual(file);
  });
  const history = new TaskManager({ projectRoot, tasksDir: item.tasksDir, agentDir: path.join(item.root, "agent") });
  await waitFor(() => history.getTask(item.task.id)!.error?.includes("连续读取失败") === true, 20_000);
  assert.equal(history.listTasks()[0]!.outputs.length, 0);
  assert.equal(await fs.readFile(stored, "utf8"), original);
  await history.shutdown();
});

test("retry transient exhaustion retains the failed attempt, creates no extra prompt and releases admission", async (t) => {
  const item = await runningFixture(t);
  item.reject(new Error("original error"));
  await waitFor(() => item.task.status === "failed" && item.calls.disposals === 1);
  const target = path.join(item.taskDir, "delivery"), actual = fs.realpath.bind(fs), now = Date.now.bind(Date);
  let reads = 0, offset = 0;
  t.mock.method(Date, "now", () => now() + offset);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target) { if (++reads > 3) offset = 16_000; throw ioFailure(target); }
    return actual(file);
  });
  await assert.rejects(item.manager.retryTask(item.task.id, model), /无法恢复原任务输出.*连续读取失败/);
  assert.equal(item.calls.prompts, 1);
  assert.equal(item.task.status, "failed");
  assert.equal(item.task.error, "original error");
  t.mock.restoreAll();
  await item.manager.retryTask(item.task.id, model);
  assert.equal(item.calls.prompts, 2);
});

test("CLI contract readonly errors recover without render or write replay", async (t) => {
  const item = await runningFixture(t);
  const workspace = path.join(item.taskDir, "workspace"), project = path.join(workspace, "video-project");
  await fs.mkdir(path.join(project, "compositions"), { recursive: true });
  const composition = path.join(project, "compositions", "01.html");
  await fs.writeFile(composition, '<div data-composition-id="01" data-duration="1"></div>');
  const contractFile = path.join(item.taskDir, "delivery", "contract.json");
  const contract = JSON.parse(await fs.readFile(contractFile, "utf8"));
  contract.silentDuration = 1;
  await fs.writeFile(contractFile, JSON.stringify(contract));
  const manifest = path.join(workspace, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ version: 1, project: "video-project",
    rows: [{ composition: "compositions/01.html", output: item.task.delivery!.slots[0], silentDuration: 1 }] }));
  const options = { manifest, workspace, "output-dir": item.outputDir };
  const { validatedManifest } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const actual = fs.readFile.bind(fs);
  let errorsLeft = 1;
  t.mock.method(fs, "readFile", async (file: Parameters<typeof fs.readFile>[0], opts: Parameters<typeof fs.readFile>[1]) => {
    if (String(file) === contractFile && errorsLeft-- > 0) throw ioFailure(contractFile, "EIO", "read");
    return actual(file, opts);
  });
  const before = await fs.readFile(manifest, "utf8");
  assert.equal((await validatedManifest(options)).rows.length, 1);
  assert.equal(await fs.readFile(manifest, "utf8"), before);
  errorsLeft = 20;
  await assert.rejects(validatedManifest(options), isOutputReadUnavailable);
  assert.equal(await fs.readFile(manifest, "utf8"), before);
});

test("late stop-cleanup scan cannot dispose or overwrite the next attempt", async (t) => {
  const item = await runningFixture(t);
  const target = path.join(item.taskDir, "delivery"), actual = fs.realpath.bind(fs);
  let release!: () => void, held = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === target && item.task.status === "aborted" && !held) {
      held = true;
      await hold;
    }
    return actual(file);
  });
  const stopping = item.manager.abortTask(item.task.id);
  try {
    await waitFor(() => held && item.calls.disposals === 1);
    await item.manager.retryTask(item.task.id, model);
    assert.equal(item.task.status, "running");
  } finally { release(); }
  await stopping;
  assert.equal(item.task.status, "running");
  assert.equal(item.calls.disposals, 1, "only the old Session was disposed");
  assert.equal(item.calls.prompts, 2);
  assert.equal(item.calls.aborts, 1);
  assert.equal(item.task.error, undefined);
});

test("a permanent receipt-output read error retains its code and does not invalidate other good slots", async (t) => {
  const item = await runningFixture(t, 2);
  const first = await publish(item, 1);
  await publish(item, 2);
  const actual = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === first.output) throw ioFailure(first.output, "EACCES");
    return actual(file);
  });
  const result = await scanDeliveredOutputs(item.task, item.taskDir, undefined, true);
  assert.equal(result.outputs.length, 1);
  assert.match(result.failures.join(" "), /凭据输出无法读取.*EACCES/);
  assert.doesNotMatch(result.failures.join(" "), /文件名不符/);
});
