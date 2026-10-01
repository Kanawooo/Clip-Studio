import path from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../security.js";
import type { ContextEvent, ContextWithSystemEvent, ExtensionContext, SessionBeforeCompactEvent, ToolResultEvent,
  BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";

type Messages = ContextEvent["messages"];
export interface VisualEvidence {
  path: string; entry: string; source: string; sourceKey: string; from: number; to: number;
  role?: string; id?: string; frameCount?: number; bytes?: number; width?: number; height?: number;
  // Legacy neutral observations remain readable, but never authorize pruning.
  text?: string; createdAt?: string;
}
export interface VisualProof {
  version: 1; file: string; sha256: string; taskId: string; finalized: boolean;
  excluded: VisualEvidence[]; active: VisualEvidence[]; required: VisualEvidence[];
  limitedReuseAllowed?: boolean;
}
export interface SelectionProof {
  version: 1; file: string; sha256: string; taskId: string;
  images: Array<VisualEvidence & { imageHash: string; complete: boolean;
    decisions: Array<{ from: number; to: number; decision: string; reason: string; purpose?: string }> }>;
}
export interface VisualState { images: VisualEvidence[]; proofs: VisualProof[]; selections?: SelectionProof[] }
type StateReader = (images: string[], proofs: VisualProof[], selections?: SelectionProof[]) => Promise<VisualState>;
const key = (file: string) => {
  let actual = path.resolve(file);
  try { actual = realpathSync.native(actual); } catch { /* Unresolved identities never establish fresh proof. */ }
  return process.platform === "win32" ? actual.toLowerCase() : actual;
};
const sameImage = (a: VisualEvidence | undefined, b: VisualEvidence) => !!a && key(a.path) === key(b.path)
  && key(a.entry) === key(b.entry) && key(a.source) === key(b.source) && a.sourceKey === b.sourceKey
  && a.from === b.from && a.to === b.to && a.role === b.role;
const imageHashes = new WeakMap<object, string>();
function readImageHash(block: { data: string }): string {
  let digest = imageHashes.get(block);
  if (!digest) { digest = createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex"); imageHashes.set(block, digest); }
  return digest;
}

function nativeHistory(messages: Messages, script: string, workspace: string) {
  const reads = new Map<string, string>(), checks = new Map<string, number>(), writes = new Map<string, { index: number; file: string }>();
  const imageReads: Array<{ index: number; file: string; id: string; sha256?: string }> = [];
  const proofs: Array<{ index: number; callIndex: number; proof: VisualProof }> = [];
  const selections: Array<{ index: number; callIndex: number; proof: SelectionProof }> = [];
  const latestSelectionWrite = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) {
      for (const block of message.content) if (block.type === "toolCall") {
        if (block.name === "read" && typeof block.arguments.path === "string") reads.set(block.id, path.resolve(workspace, block.arguments.path));
        if (block.name === "bash" && mediaAction(block.arguments.command, script) === "check-plan") checks.set(block.id, index);
        if (["write", "edit"].includes(block.name) && typeof block.arguments.path === "string")
          writes.set(block.id, { index, file: path.resolve(workspace, block.arguments.path) });
      }
    }
    if (message.role !== "toolResult") continue;
    const attempt = writes.get(message.toolCallId);
    if (attempt && /^selections\/[^/]+\.json$/i.test(path.relative(workspace, attempt.file).replace(/\\/g, "/")))
      latestSelectionWrite.set(key(attempt.file), message.toolCallId);
    if (message.isError) continue;
    if (message.toolName === "read" && reads.has(message.toolCallId) && message.content.some((block) => block.type === "image")) {
      const blocks = message.content.filter((block) => block.type === "image");
      imageReads.push({ index, file: reads.get(message.toolCallId)!, id: message.toolCallId,
        sha256: blocks.length === 1 ? readImageHash(blocks[0]!) : undefined });
    }
    if (message.toolName === "bash" && checks.has(message.toolCallId)) {
      const value = parseResult(message.content);
      if (value?.ok === true && isProof(value.visual)) proofs.push({ index, callIndex: checks.get(message.toolCallId)!,
        proof: { ...value.visual, limitedReuseAllowed: value.limitedReuseAllowed === true } });
    }
    const write = writes.get(message.toolCallId), value = parseResult(message.content);
    if (write && ["write", "edit"].includes(message.toolName) && value?.ok === true && isSelectionProof(value.selection)
      && key(write.file) === key(value.selection.file)) selections.push({ index, callIndex: write.index, proof: value.selection });
  }
  return { imageReads, proofs, selections, latestSelectionWrite };
}

function isSelectionProof(input: unknown): input is SelectionProof {
  if (!input || typeof input !== "object") return false;
  const value = input as SelectionProof;
  return value.version === 1 && typeof value.file === "string" && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256) && typeof value.taskId === "string" && Array.isArray(value.images);
}

function parseResult(content: Array<{ type: string; text?: string }>): Record<string, unknown> | undefined {
  if (content.length !== 1 || content[0]?.type !== "text") return undefined;
  try { const value: unknown = JSON.parse(content[0].text ?? "");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
function isProof(input: unknown): input is VisualProof {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return value.version === 1 && typeof value.file === "string" && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.taskId === "string" && typeof value.finalized === "boolean"
    && [value.excluded, value.active, value.required].every(Array.isArray);
}

// Direct, policy-checked local CLI only. Echo/comments/similar scripts/chains cannot authorize removal.
function mediaAction(command: unknown, script: string): string | undefined {
  if (typeof command !== "string" || /[\r\n;&|`]/.test(command)) return undefined;
  const parts = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g)?.map((part) => part.replace(/^["']|["']$/g, ""));
  if (!parts || !/^(?:node|node\.exe)$/i.test(path.basename(parts[0]!)) || parts.length < 3
    || !path.isAbsolute(parts[1]!) || key(parts[1]!) !== key(script)) return undefined;
  return parts[2];
}

/** Request-only projection; native transcript/image files are immutable.
 * Proofs must be revalidated against the current task file by the CLI reader. */
export function projectVisualContext(messages: Messages, evidence: VisualEvidence[], mediaScript: string,
  workspace = process.cwd(), verified: VisualProof[] = [], selections: SelectionProof[] = [], trustedHistory: Messages = messages): Messages {
  const history = nativeHistory(trustedHistory, mediaScript, workspace);
  const byPath = new Map(evidence.map((image) => [key(image.path), image]));
  const latestRead = new Map<string, number>();
  for (const read of history.imageReads) latestRead.set(key(read.file), read.index);
  const authorized = new Map<string, { image: VisualEvidence; decision: string; decisions?: SelectionProof["images"][number]["decisions"] }>();
  const latestBatch = new Map<string, (typeof history.selections)[number]>();
  for (const batch of history.selections) for (const image of batch.proof.images) latestBatch.set(key(image.path), batch);
  for (const read of history.imageReads) {
    const batch = latestBatch.get(key(read.file));
    const result = batch && trustedHistory[batch.index];
    if (batch && (result?.role !== "toolResult" || history.latestSelectionWrite.get(key(batch.proof.file)) !== result.toolCallId)) continue;
    const current = batch && selections.find((item) => key(item.file) === key(batch.proof.file)
      && item.sha256 === batch.proof.sha256 && item.taskId === batch.proof.taskId);
    const image = current?.images.find((item) => key(item.path) === key(read.file));
    if (batch && image?.complete && sameImage(byPath.get(key(read.file)), image)
      && read.sha256 === image.imageHash && read.index < batch.callIndex && latestRead.get(key(read.file))! < batch.callIndex)
      authorized.set(read.id, { image, decision: "batch-decided", decisions: image.decisions });
  }
  // A changed/unverified latest decision cannot fall back to an earlier one.
  const native = history.proofs.at(-1);
  const proof = native && verified.find((item) => item.sha256 === native.proof.sha256 && key(item.file) === key(native.proof.file)
    && item.taskId === native.proof.taskId);
  if (native && proof) {
  const seenBefore = (image: VisualEvidence) => history.imageReads.some((read) => read.index < native.callIndex
    && latestRead.get(key(read.file))! < native.callIndex && sameImage(byPath.get(key(read.file)), image));
  const active = new Set(proof.active.map((item) => key(item.path)));
  for (const read of history.imageReads) if (active.has(key(read.file))) authorized.delete(read.id);
  const finalized = proof.finalized && proof.required.length > 0 && proof.required.every(seenBefore);
  for (const read of history.imageReads) {
    const image = byPath.get(key(read.file));
    if (!image || read.index >= native.callIndex || latestRead.get(key(read.file))! >= native.callIndex || active.has(key(read.file))) continue;
    const excluded = image.role !== "reference" && proof.excluded.some((item) => sameImage(item, image)) && seenBefore(image);
    if (excluded || finalized) authorized.set(read.id, { image, decision: finalized ? "plan-finalized" : "excluded" });
  }
  }
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const record = authorized.get(message.toolCallId), image = record?.image;
    if (!image) return message;
    return { ...message, content: [...message.content.filter((block) => block.type !== "image"),
      { type: "text" as const, text: JSON.stringify({ image: image.path, source: image.source,
        sourceKey: image.sourceKey, id: image.id, range: [image.from, image.to], decision: record.decision, decisions: record.decisions,
        review: "read this exact image again to revise selection" }) }] };
  });
}

const imageCount = (messages: Messages) => messages.reduce((sum, message) => sum
  + ("content" in message && Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0), 0);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const validLimit = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
function imageTokens(image?: { width?: number; height?: number }) {
  return Math.ceil((validLimit(image?.width) ?? 2000) / 512) * Math.ceil((validLimit(image?.height) ?? 2000) / 512) * 256 + 128;
}
function projectedTokens(messages: Messages, evidence: VisualEvidence[], workspace: string, script: string) {
  const metadata = new Map(evidence.map((image) => [key(image.path), image]));
  const calls = new Map(nativeHistory(messages, script, workspace).imageReads.map((read) => [read.id, metadata.get(key(read.file))]));
  let images = 0;
  const text = JSON.stringify(messages, (name, value: unknown) => {
    if (name === "data") return "[image data excluded from token estimate]";
    return value;
  });
  for (const message of messages) if (message.role === "toolResult") {
    images += message.content.filter((block) => block.type === "image").length * imageTokens(calls.get(message.toolCallId));
  }
  return Math.ceil(Buffer.byteLength(text) / 4) + images;
}
export interface ImageBudget {
  inputLimits?: { maxRequestBytes?: number; images?: { maxPerMessage?: number; maxPerRequest?: number } };
  requestBytes: number; historyImages: number; largestMessageImages?: number;
  contextWindow?: number; contextTokens?: number | null; outputReserve?: number;
}

/** Advisory groups; never access permissions or a tool scheduler. */
export function groupImages<T extends Pick<VisualEvidence, "path" | "bytes" | "width" | "height">>(images: T[], budget: ImageBudget) {
  const knownBytes = validLimit(budget.inputLimits?.maxRequestBytes);
  const usableBytes = Math.floor((knownBytes ?? 20 * 1024 * 1024) * 0.9);
  const requestLimit = validLimit(budget.inputLimits?.images?.maxPerRequest);
  const messageLimit = validLimit(budget.inputLimits?.images?.maxPerMessage);
  const groups: T[][] = [], deferred: T[] = [];
  let current: T[] = [], body = budget.requestBytes, tokens = budget.contextTokens ?? 0, history = budget.historyImages;
  const reserve = budget.outputReserve ?? 90_000;
  for (const image of images) {
    if (current.length >= Math.min(4, messageLimit ?? 4)) { groups.push(current); current = []; }
    const addedBytes = Math.ceil((image.bytes ?? 3 * 1024 * 1024) / 3) * 4 + 1024;
    const addedTokens = imageTokens(image);
    if ((requestLimit !== undefined && history + 1 > requestLimit)
      || (messageLimit !== undefined && Math.max(budget.largestMessageImages ?? 0, current.length + 1) > messageLimit)
      || body + addedBytes > usableBytes
      || (budget.contextWindow !== undefined && tokens + addedTokens + reserve > budget.contextWindow)) {
      deferred.push(image); continue;
    }
    current.push(image); body += addedBytes; tokens += addedTokens; history++;
  }
  if (current.length) groups.push(current);
  return { groups, deferred, defaultNewImages: 4, usableBytes,
    capacitySource: knownBytes ? "model metadata; conservative 90% planning budget" : "client estimate: 90% of 20 MiB, not upstream maximum",
    tokenSource: budget.contextTokens == null ? "heuristic; native usage unavailable" : "native usage plus image estimate",
    historyImages: budget.historyImages, plannedNewImages: images.length - deferred.length,
    estimatedTotalImages: history, estimatedRequestBytes: body,
    next: deferred.length ? "Compare active/reference images and explicitly decide candidates before adding more; retain undecided images. Use detail/window for unclear regions." : "Read one group per assistant reply using multiple native read calls; results enter the next model request together." };
}

/** Read-only aggregation over native provider payloads, also used for compaction calls. */
export function measurePayload(payload: unknown) {
  let images = 0, imageBytes = 0, maxMessageImages = 0;
  const walk = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + walk(item), 0);
    if (!value || typeof value !== "object") return 0;
    const obj = value as Record<string, unknown>;
    let count = 0;
    const inner = (object: unknown, field: string) => object && typeof object === "object" ? (object as Record<string, unknown>)[field] : undefined;
    const data = obj.type === "image_url" ? inner(obj.image_url, "url")
      : obj.type === "image" ? inner(obj.source, "data") : inner(obj.inlineData, "data");
    if (typeof data === "string") { images++; imageBytes += Buffer.byteLength(data); return 1; }
    for (const item of Object.values(obj)) count += walk(item);
    if (typeof obj.role === "string") maxMessageImages = Math.max(maxMessageImages, count);
    return count;
  };
  walk(payload);
  return { images, imageBytes, maxMessageImages, requestBytes: bytes(payload), measurement: "serialized native payload" };
}

export function createVisualRuntime(options: { workspace: string; projectRoot: string; onTermination?: (reason: string) => void }, reader?: StateReader) {
  const script = path.join(options.projectRoot, ".pi", "skills", "clip-skills", "scripts", "media-cache.mjs");
  let nativeReader: StateReader | undefined, load: Promise<unknown> | undefined;
  let latest: Messages = [], state: VisualState = { images: [], proofs: [] }, systemBytes = 64 * 1024;
  let measured: ReturnType<typeof measurePayload> | undefined, contextAtMeasurement = 0, lastNew = 0, releasedImages = 0;
  const loadModule = async () => { load ??= import(pathToFileURL(script).href); return await load; };
  const loadState: StateReader = reader ?? (async (images, proofs, selections) => {
    const module = await loadModule();
    if (!module || typeof module !== "object" || !("createVisualStateReader" in module)
      || typeof module.createVisualStateReader !== "function") throw new Error("visual reader unavailable");
    nativeReader ??= module.createVisualStateReader(options.workspace) as StateReader;
    return nativeReader!(images, proofs, selections);
  });
  const context = async (event: ContextEvent, ctx?: ExtensionContext) => {
    try {
      const branch = ctx?.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message);
      const trusted = branch?.length ? branch : event.messages;
      const history = nativeHistory(trusted, script, options.workspace);
      state = await loadState([...new Set(history.imageReads.map((read) => read.file))], history.proofs.slice(-1).map((row) => row.proof),
        history.selections.map((row) => row.proof));
      latest = projectVisualContext(event.messages, state.images, script, options.workspace, state.proofs, state.selections, trusted);
      releasedImages = imageCount(event.messages) - imageCount(latest);
      const lastReply = event.messages.findLastIndex((message) => message.role === "assistant");
      lastNew = imageCount(event.messages.slice(lastReply + 1));
      return { messages: latest };
    } catch (error) {
      latest = event.messages; state = { images: [], proofs: [] }; releasedImages = 0;
      const value = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      console.warn(`[clip-studio] visual context retained (${/^[A-Z_0-9]{1,32}$/.test(value) ? value : "invalid metadata"})`);
      return undefined;
    }
  };
  const toolResult = (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "bash" || event.isError
      || !["locate", "detail", "window", "resheet"].includes(mediaAction(event.input.command, script) ?? "")) return undefined;
    const value = parseResult(event.content);
    if (!Array.isArray(value?.images) || !value.images.every((image) => image && typeof image === "object"
      && typeof image.path === "string" && validLimit(image.bytes) !== undefined)) return undefined;
    const usage = ctx.getContextUsage(), model = ctx.model;
    const requestBytes = measured ? measured.requestBytes + Math.max(0, bytes(latest) - contextAtMeasurement)
      : Math.ceil(bytes(latest) * 1.15) + systemBytes;
    const grouping = groupImages(value.images, { inputLimits: model?.inputLimits, requestBytes,
      historyImages: imageCount(latest), largestMessageImages: measured?.maxMessageImages,
      contextWindow: model?.contextWindow,
      contextTokens: releasedImages || usage?.tokens == null ? projectedTokens(latest, state.images, options.workspace, script) + Math.ceil(systemBytes / 4) : usage.tokens,
      outputReserve: Math.min(90_000, model?.maxTokens ?? 90_000) });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...value, imageGroups: grouping.groups.map((group) => group.map((image) => image.path)),
      deferredImages: grouping.deferred.map((image) => image.path), grouping: { ...grouping, groups: undefined, deferred: undefined,
        tokenSource: releasedImages || usage?.tokens == null ? "heuristic over projected history plus prompt/tools; not measured upstream tokens" : grouping.tokenSource,
        requestSource: measured ? "last measured native payload plus subsequent history estimate" : "client history/prompt/tools estimate" } }) }] };
  };
  const selectionResult = async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!["write", "edit"].includes(event.toolName) || event.isError || typeof event.input.path !== "string") return undefined;
    const file = path.resolve(options.workspace, event.input.path);
    if (!/^selections\/[^/]+\.json$/i.test(path.relative(options.workspace, file).replace(/\\/g, "/"))) return undefined;
    try {
      const module = await loadModule();
      if (!module || typeof module !== "object" || !("checkSelectionBatch" in module) || typeof module.checkSelectionBatch !== "function")
        throw new Error("选镜校验入口不可用");
      const result = await module.checkSelectionBatch({ workspace: options.workspace, file }) as { ok: true; selection: SelectionProof };
      const messages = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message);
      const history = nativeHistory(messages, script, options.workspace);
      const call = messages.findIndex((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === event.toolCallId));
      if (call < 0 || result.selection.images.some((image) => !history.imageReads.some((read) => key(read.file) === key(image.path)
        && read.sha256 === image.imageHash && read.index < call)))
        throw new Error("记录中的图片尚未进入此前模型请求或图片字节已变化。先原生 read 对应图片；在看到图片的下一次回复保存取舍，可同时读取下一批");
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: `选镜记录未生效：${redactSecrets(error instanceof Error ? error.message : "校验失败", [])}；实际图片继续保留。修正该批记录即可。` }] };
    }
  };
  const beforeCompact = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const branch = event.branchEntries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    const projected = (await context({ type: "context", messages: branch }))?.messages ?? branch;
    const discarded = new Set([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]
      .filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
    const unsafe = projected.some((message) => message.role === "toolResult" && discarded.has(message.toolCallId)
      && message.content.some((block) => block.type === "image"));
    if (!unsafe) return undefined;
    if (event.reason === "overflow") {
      options.onTermination?.("制作失败：模型上下文容量已不足，安全压缩会丢失仍需比较的真实图片。已保留任务历史；继续时先完成当前候选取舍，或改用容量更大的模型。");
      ctx.abort();
    }
    return { cancel: true };
  };
  const providerRequest = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    measured = measurePayload(event.payload); contextAtMeasurement = bytes(latest);
    const roles = { reference: 0, source: 0, detail: 0, unknown: 0 }, seen = new Set<string>();
    let expandedFrames = 0;
    for (const read of nativeHistory(latest, script, options.workspace).imageReads) {
      const message = latest[read.index];
      if (message?.role !== "toolResult" || !message.content.some((block) => block.type === "image")) continue;
      seen.add(key(read.file));
      const record = state.images.find((item) => key(item.path) === key(read.file));
      roles[record?.role === "reference" ? "reference" : record?.id?.includes(":frame-") ? "detail" : record?.role === "source" ? "source" : "unknown"]++;
      expandedFrames += record?.frameCount ?? 1;
    }
    console.info(`[clip-studio] visual request ${JSON.stringify({ ...measured, newImages: lastNew, roles,
      retainedUniqueImages: seen.size,
      expandedFrames, frameMeasurement: "known page counts; unknown image counted as one" })}`);
    const limits = ctx.model?.inputLimits;
    const reason = limits?.maxRequestBytes && measured.requestBytes > limits.maxRequestBytes ? "请求体字节超过模型声明上限"
      : limits?.images?.maxPerRequest && measured.images > limits.images.maxPerRequest ? "完整请求图片数超过模型声明上限"
        : limits?.images?.maxPerMessage && measured.maxMessageImages > limits.images.maxPerMessage ? "单条原生消息图片数超过模型声明上限" : undefined;
    if (reason) { options.onTermination?.(`制作失败：${reason}。请依据 locate 分组完成候选取舍，保留未确定图片后继续；没有降低图像质量。`); ctx.abort(); }
    return undefined; // Native adapters retain payload/protocol/tool pairing responsibility.
  };
  return { context, toolResult, selectionResult, beforeCompact, providerRequest,
    contextWithSystem: (event: ContextWithSystemEvent) => { systemBytes = Math.max(64 * 1024, bytes(event.messages) - bytes(latest)); } };
}

/** Legacy function form retained for integration callers. */
export function createVisualContextHandler(options: { workspace: string; projectRoot: string }, reader?: (images: string[]) => Promise<VisualEvidence[]>) {
  return createVisualRuntime(options, reader ? async (images) => ({ images: await reader(images), proofs: [] }) : undefined).context;
}
