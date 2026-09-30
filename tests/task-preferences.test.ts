import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { LocalStateStore } from "../src/api/local-state.js";
import { ModelCapabilityRegistry } from "../src/api/model-capabilities.js";
import { handleCreateTask, HttpError, parseCreateTaskInput, taskToView } from "../src/api/tasks.js";
import { TaskManager, type SessionStartOptions } from "../src/tasks/manager.js";
import type { CreateTaskInput, Task } from "../src/tasks/types.js";
import { buildCreateInput } from "../web/src/App.tsx";
import { DEFAULT_DRAFT, DEFAULT_SETTINGS, draftFromLocalState } from "../web/src/state/storage.ts";
import type { TaskDraft } from "../web/src/types/api.ts";

const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const { createElement } = requireWeb("react") as typeof import("../web/node_modules/@types/react/index.js");
const { renderToStaticMarkup } = requireWeb("react-dom/server") as typeof import("../web/node_modules/@types/react-dom/server.js");
// JSX must use the frontend's react-jsx configuration, not the server tsconfig.
const { TaskComposer } = await tsImport("../web/src/components/TaskComposer.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)),
}) as typeof import("../web/src/components/TaskComposer.tsx");
const root = mkdtempSync(path.join(tmpdir(), "Clip Studio 中文 preferences "));
let fixtureNumber = 0;
const model = { provider: "test", model: "test", apiKey: "test-only-private-key" };

after(() => {
  const relative = path.relative(tmpdir(), root);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
});

function fixture(): { projectRoot: string; tasksDir: string; input: CreateTaskInput } {
  const directory = path.join(root, String(++fixtureNumber));
  const projectRoot = path.join(directory, "Clip Studio");
  const referenceVideo = path.join(directory, "参考 视频.mp4");
  const assetsDir = path.join(directory, "素材 目录");
  const audioDir = path.join(directory, "音频 目录");
  const outputDir = path.join(directory, "输出 目录");
  for (const file of [projectRoot, assetsDir, audioDir, outputDir]) mkdirSync(file, { recursive: true });
  writeFileSync(referenceVideo, "reference fixture; no decoder needed");
  return {
    projectRoot,
    tasksDir: path.join(projectRoot, "data", "tasks"),
    input: { referenceVideo, assetsDir, audioDir, outputDir, taskRequest: "制作完整成片", generateCount: 2,
      model: { ...model }, modelCapabilityId: "test-only-capability" },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "expected task transition did not settle");
}

function readPolicy(workspace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(workspace, "media-policy.json"), "utf8"));
}

function failedManager(t: TestContext, value: ReturnType<typeof fixture>, onSession?: (
  input: CreateTaskInput, workspace: string, options: SessionStartOptions,
) => void) {
  let sessions = 0;
  let prompts = 0;
  const manager = new TaskManager({
    projectRoot: value.projectRoot,
    tasksDir: value.tasksDir,
    agentDir: path.join(value.projectRoot, ".pi"),
    sessionFactory: async (input, workspace, options) => {
      sessions += 1;
      onSession?.(input, workspace, options);
      return {
        prompt: async (prompt) => {
          prompts += 1;
          assert.ok(prompt.length > 0);
          assert.doesNotMatch(prompt, /reuseVisualAnalysis|复用 AI 画面分析/);
          throw new Error("test-only attempt failure");
        },
        abort: async () => {},
        dispose: () => {},
      };
    },
  });
  t.after(() => manager.shutdown());
  return { manager, sessionCount: () => sessions, promptCount: () => prompts };
}

test("create API normalizes the optional visual preference and rejects non-booleans", () => {
  const { input } = fixture();
  assert.equal(parseCreateTaskInput(input).reuseVisualAnalysis, false);
  for (const choice of [false, true]) {
    assert.equal(parseCreateTaskInput({ ...input, reuseVisualAnalysis: choice }).reuseVisualAnalysis, choice);
  }
  for (const invalid of [null, "false", "true", 0, 1, [], {}]) {
    assert.throws(() => parseCreateTaskInput({ ...input, reuseVisualAnalysis: invalid }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /reuseVisualAnalysis must be a boolean/);
      return true;
    });
  }
});

test("visual reuse does not bypass the server image-capability gate", async (t) => {
  const value = fixture();
  const runner = failedManager(t, value);
  const capabilities = new ModelCapabilityRegistry();
  const evidence = capabilities.record(model, "unsupported");
  const request = Readable.from([JSON.stringify({ ...value.input, modelCapabilityId: evidence.capabilityId,
    reuseVisualAnalysis: true })]) as unknown as IncomingMessage;
  let statusCode = 0;
  let body = "";
  const response = {
    writeHead: (status: number) => { statusCode = status; },
    end: (payload: string) => { body = payload; },
  } as unknown as ServerResponse;
  await handleCreateTask(runner.manager, request, response, capabilities, new LocalStateStore(value.projectRoot));
  assert.equal(statusCode, 409);
  assert.match(JSON.parse(body).error, /不支持图片/);
  assert.equal(runner.sessionCount(), 0);
  assert.equal(runner.manager.listTasks().length, 0);
});

test("draft preference round-trips through the server whitelist and defaults off", async () => {
  const { projectRoot } = fixture();
  const store = new LocalStateStore(projectRoot);
  assert.equal(DEFAULT_DRAFT.reuseVisualAnalysis, false);
  assert.equal(draftFromLocalState(await store.view()).reuseVisualAnalysis, false);
  for (const invalid of [undefined, null, "true", 1, {}, []]) {
    assert.equal(draftFromLocalState({ settings: {}, mainKeyStored: false,
      draft: { reuseVisualAnalysis: invalid } }).reuseVisualAnalysis, false);
  }
  for (const choice of [true, false]) {
    const draft = { ...DEFAULT_DRAFT, referenceVideo: "参考.mp4", generateCount: 3,
      reuseVisualAnalysis: choice, apiKey: model.apiKey, unrelated: "discard me" };
    const saved = await store.saveDraft({ draft });
    assert.equal(saved.draft.reuseVisualAnalysis, choice);
    assert.equal(saved.draft.apiKey, undefined);
    assert.equal(saved.draft.unrelated, undefined);
    const loaded = await new LocalStateStore(projectRoot).view();
    assert.equal(draftFromLocalState(loaded).reuseVisualAnalysis, choice);
    assert.equal(draftFromLocalState(loaded).generateCount, 3);
    assert.doesNotMatch(readFileSync(path.join(projectRoot, ".runtime", "user-state.json"), "utf8"),
      new RegExp(model.apiKey));
  }
  const legacy = await store.saveDraft({ draft: { taskRequest: "旧草稿", generateCount: 2 } });
  assert.equal(legacy.draft.reuseVisualAnalysis, undefined);
  assert.equal(draftFromLocalState(legacy).reuseVisualAnalysis, false);
});

test("frontend submission forwards the normalized draft choice and preserves model gating", () => {
  const settings = { ...DEFAULT_SETTINGS, provider: "test", model: "test", apiKey: model.apiKey,
    modelCapability: { fingerprint: "test", status: "supported" as const, testedAt: new Date().toISOString(),
      capabilityId: "test-only-capability" } };
  for (const choice of [false, true]) {
    const created = buildCreateInput({ ...DEFAULT_DRAFT, referenceVideo: " 参考.mp4 ", reuseVisualAnalysis: choice }, settings);
    assert.equal(created.reuseVisualAnalysis, choice);
    assert.equal(created.referenceVideo, "参考.mp4");
    assert.equal(created.model.model, "test");
    assert.equal(created.modelCapabilityId, "test-only-capability");
  }
  const oldDraft = { ...DEFAULT_DRAFT } as Partial<TaskDraft>;
  delete oldDraft.reuseVisualAnalysis;
  assert.equal(buildCreateInput(oldDraft as TaskDraft, settings).reuseVisualAnalysis, false);
  assert.throws(() => buildCreateInput(DEFAULT_DRAFT, { ...settings, modelCapability: null }), /图片理解能力/);
});

test("composer renders one default-off checkbox and locks it during an active task", () => {
  const props = { draft: DEFAULT_DRAFT, disabled: false, submitting: false, settingsReady: true,
    onChange: () => {}, onSubmit: () => {}, onError: () => {} };
  const render = (overrides: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(TaskComposer, { ...props, ...overrides }));
  const checkbox = (html: string) => html.match(/<input[^>]*id="reuse-visual-analysis"[^>]*>/)?.[0] ?? "";
  const normal = render();
  assert.match(normal, /复用 AI 画面分析/);
  assert.match(normal, /开启后复用已有分析，选镜仍看图。/);
  assert.equal((normal.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(checkbox(normal), /type="checkbox"/);
  assert.doesNotMatch(checkbox(normal), /checked|disabled/);
  assert.match(checkbox(render({ draft: { ...DEFAULT_DRAFT, reuseVisualAnalysis: true } })), /checked/);
  assert.match(checkbox(render({ disabled: true })), /disabled/);
  assert.match(checkbox(render({ submitting: true })), /disabled/);
});

for (const choice of [undefined, false, true]) {
  test(`new task persists preference ${choice ?? "omitted/off"} and writes policy before each single Session`, async (t) => {
    const value = fixture();
    const normalized = choice === true;
    const policies: Record<string, unknown>[] = [];
    const runner = failedManager(t, value, (input, workspace, options) => {
      const policy = readPolicy(workspace);
      assert.deepEqual(policy, { version: 1, taskId: options.taskId, reuseVisualAnalysis: normalized,
        inputs: { referenceVideo: value.input.referenceVideo, assetsDir: value.input.assetsDir, audioDir: value.input.audioDir } });
      assert.equal(input.reuseVisualAnalysis, normalized);
      policies.push(policy);
    });
    const task = await runner.manager.createTask({ ...value.input,
      ...(choice === undefined ? {} : { reuseVisualAnalysis: choice }) });
    await waitUntil(() => task.status === "failed");
    assert.equal(runner.sessionCount(), 1);
    assert.equal(runner.promptCount(), 1);
    assert.equal(task.input.reuseVisualAnalysis, normalized);
    assert.equal((taskToView(task).input as Task["input"]).reuseVisualAnalysis, normalized);
    const taskFile = path.join(value.tasksDir, task.id, "task.json");
    assert.equal(JSON.parse(readFileSync(taskFile, "utf8")).input.reuseVisualAnalysis, normalized);
    assert.doesNotMatch(readFileSync(taskFile, "utf8"), new RegExp(model.apiKey));

    // A later frontend draft change cannot alter the already-created task.
    await new LocalStateStore(value.projectRoot).saveDraft({ draft: { ...DEFAULT_DRAFT, reuseVisualAnalysis: !normalized } });
    const workspace = path.join(value.tasksDir, task.id, "workspace");
    writeFileSync(path.join(workspace, "media-policy.json"), JSON.stringify({ version: 1, taskId: task.id,
      reuseVisualAnalysis: !normalized }));
    const retried = await runner.manager.retryTask(task.id, { ...model });
    await waitUntil(() => task.status === "failed");
    assert.equal(retried?.id, task.id);
    assert.equal(task.input.reuseVisualAnalysis, normalized);
    assert.equal(runner.sessionCount(), 2);
    assert.equal(runner.promptCount(), 2);
    assert.equal(policies.length, 2);
    assert.deepEqual(readPolicy(workspace), { version: 1, taskId: task.id, reuseVisualAnalysis: normalized,
      inputs: { referenceVideo: value.input.referenceVideo, assetsDir: value.input.assetsDir, audioDir: value.input.audioDir } });
  });
}

test("legacy stored tasks keep permissive reuse without adding a preference to history", async (t) => {
  const value = fixture();
  const original = failedManager(t, value);
  const task = await original.manager.createTask(value.input);
  await waitUntil(() => task.status === "failed");
  await original.manager.shutdown();
  const taskFile = path.join(value.tasksDir, task.id, "task.json");
  const legacy = JSON.parse(readFileSync(taskFile, "utf8"));
  delete legacy.input.reuseVisualAnalysis;
  writeFileSync(taskFile, JSON.stringify(legacy));
  const recreated = failedManager(t, value, (input, workspace, options) => {
    assert.equal(input.reuseVisualAnalysis, undefined);
    assert.deepEqual(readPolicy(workspace), { version: 1, taskId: options.taskId, reuseVisualAnalysis: true,
      inputs: { referenceVideo: value.input.referenceVideo, assetsDir: value.input.assetsDir, audioDir: value.input.audioDir } });
  });
  assert.equal(recreated.manager.getTask(task.id)?.input.reuseVisualAnalysis, undefined);
  assert.equal(recreated.sessionCount(), 0, "reading history does not create a Session");
  const restored = await recreated.manager.retryTask(task.id, { ...model });
  await waitUntil(() => restored?.status === "failed");
  assert.equal(restored?.id, task.id);
  assert.equal(recreated.sessionCount(), 1);
  assert.equal(recreated.promptCount(), 1);
  assert.equal(JSON.parse(readFileSync(taskFile, "utf8")).input.reuseVisualAnalysis, undefined);
});

test("invalid persisted preferences are ignored rather than treated as permissive legacy tasks", async (t) => {
  const value = fixture();
  const original = failedManager(t, value);
  const task = await original.manager.createTask(value.input);
  await waitUntil(() => task.status === "failed");
  await original.manager.shutdown();
  const taskFile = path.join(value.tasksDir, task.id, "task.json");
  const invalid = JSON.parse(readFileSync(taskFile, "utf8"));
  invalid.input.reuseVisualAnalysis = "false";
  writeFileSync(taskFile, JSON.stringify(invalid));
  const reopened = failedManager(t, value);
  assert.equal(reopened.manager.getTask(task.id), undefined);
  assert.equal(reopened.sessionCount(), 0);
});
