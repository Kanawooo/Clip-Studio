import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { createVisualContextHandler, createVisualRuntime, projectVisualContext, groupImages, measurePayload,
  type VisualEvidence, type VisualProof, type SelectionProof } from "../src/pi/visual-context.js";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { convertMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";

type Messages = Parameters<typeof projectVisualContext>[0];
const workspace = path.resolve("context-fixture"), script = path.resolve(".pi/skills/clip-skills/scripts/media-cache.mjs");
const time = Date.parse("2026-09-30T00:00:00Z");
export function assistant(offset: number, content: unknown[], stopReason = "toolUse"): Messages[number] {
  return { role: "assistant", content, api: "openai-completions", provider: "fixture", model: "test",
    stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: time + offset } as Messages[number];
}
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const image = (id = "read-1", offset = 100, error = false): Messages[number] => ({ role: "toolResult", toolName: "read",
  toolCallId: id, timestamp: time + offset, isError: error,
  content: [{ type: "text", text: "image/jpeg" }, { type: "image", mimeType: "image/jpeg", data: "a".repeat(60_000) }] });
const evidence: VisualEvidence = { path: path.join(workspace, "sheet.jpg"), entry: path.join(workspace, "entry.json"),
  source: path.join(workspace, "source.mp4"), sourceKey: "source-1", role: "source", from: 0, to: 9,
  width: 2000, height: 1500, bytes: 45_000, frameCount: 10 };
const proof: VisualProof = { version: 1, taskId: "task", file: path.join(workspace, "plan.json"), sha256: "a".repeat(64),
  excluded: [evidence], active: [], required: [], finalized: false };
const saved = (value = proof, error = false): Messages[number] => ({ role: "toolResult", toolName: "bash", toolCallId: "save-1",
  timestamp: time + 300, isError: error, content: [{ type: "text", text: JSON.stringify({ ok: true, visual: value }) }] });
const history = (): Messages => [assistant(0, [tool("read-1", "read", { path: "sheet.jpg" })]), image(),
  assistant(200, [tool("save-1", "bash", { command: `node "${script}" check-plan --workspace "${workspace}" --file "plan.json"` })]), saved()];
const count = (messages: Messages) => measurePayload(messages.map((message) => message.role === "toolResult"
  ? { role: "user", content: message.content.map((block) => block.type === "image"
    ? { type: "image", source: { data: block.data } } : block) } : {})).images;
const project = (messages = history(), records = [evidence], verified = [proof]) => projectVisualContext(messages, records, script, workspace, verified);

test("only explicitly excluded, seen, task-verified old images are projected; raw history and pairing stay intact", () => {
  const messages = history(), raw = JSON.stringify(messages), projected = project(messages);
  assert.equal(count(projected), 0); assert.equal(JSON.stringify(messages), raw);
  assert.equal(projected.length, messages.length); assert.match(JSON.stringify(projected[1]), /excluded/);
  assert.equal((projected[1] as any).toolCallId, "read-1");
});

test("neutral observations, legacy check, failed/unverified saves, wrong identity and reference exclusion never remove images", () => {
  assert.equal(count(project(history(), [evidence], [])), 1);
  for (const command of [`node "${script}" annotate-batch --manifest "analysis.json"`,
    `echo node "${script}" check-plan`, `node "${script}.fake" check-plan`]) {
    const messages = history(); messages[2] = assistant(200, [tool("save-1", "bash", { command })]);
    assert.equal(count(project(messages)), 1);
  }
  for (const result of [saved(proof, true), { ...saved(), content: [{ type: "text", text: '{"ok":true}' }] } as Messages[number]]) {
    const messages = history(); messages[3] = result; assert.equal(count(project(messages)), 1);
  }
  for (const patch of [{ sourceKey: "other" }, { entry: "another/entry.json" }, { from: 1 }, { role: "reference" }]) {
    assert.equal(count(project(history(), [{ ...evidence, ...patch }])), 1);
  }
  assert.equal(count(project(history(), [evidence], [{ ...proof, active: [evidence] }])), 1);
});

test("same-turn reads cannot be pruned before reaching the next request; rereads restore affected visuals", () => {
  const messages = history();
  const sameTurn = [assistant(0, [...(messages[0] as any).content, ...(messages[2] as any).content]), image(), saved()];
  assert.equal(count(project(sameTurn)), 1);
  const reread = [...messages, assistant(400, [tool("again", "read", { path: evidence.path })]), image("again", 500)];
  assert.equal(count(project(reread)), 2);
  assert.equal(count(project([...reread, assistant(600, [{ type: "text", text: "looked again" }], "stop")])), 2);
});

test("complete plans require all actual source/reference reads; active and unknown visuals remain", () => {
  const ref = { ...evidence, path: path.join(workspace, "reference.jpg"), role: "reference", sourceKey: "ref-key" };
  const final = { ...proof, excluded: [], finalized: true, required: [evidence, ref] };
  const messages = history(); messages[3] = saved(final);
  assert.equal(count(project(messages, [evidence, ref], [final])), 1);
  const seen = [assistant(0, [tool("ref", "read", { path: ref.path }), tool("read-1", "read", { path: evidence.path })]),
    image("ref", 90), image(), ...messages.slice(2)];
  assert.equal(count(project(seen, [evidence, ref], [final])), 0);
  assert.equal(count(project(seen, [evidence, ref], [{ ...final, active: [ref] }])), 1);
});

test("resume is deterministic; missing call/result and newly modified plans conservatively retain images", () => {
  const messages = history(); assert.deepEqual(project(JSON.parse(JSON.stringify(messages))), project(messages));
  assert.equal(count(project(messages.slice(1))), 1);
  assert.equal(count(project(messages.slice(0, 3))), 1);
  assert.equal(count(project(messages, [evidence], [{ ...proof, sha256: "b".repeat(64) }])), 1);
});

test("native OpenAI conversion proves reduction only after validated exclusions, without losing pairing", () => {
  const records = Array.from({ length: 22 }, (_, i) => ({ ...evidence, path: path.join(workspace, `sheet-${i}.jpg`), sourceKey: `source-${i}` }));
  const messages: Messages = [assistant(0, records.map((record, i) => tool(`read-${i}`, "read", { path: record.path }))),
    ...records.map((_, i) => image(`read-${i}`)), ...history().slice(2)];
  const decision = { ...proof, excluded: records }; messages[messages.length - 1] = saved(decision);
  const projected = project(messages, records, [decision]);
  const model = { id: "fixture", provider: "fixture", api: "openai-completions", input: ["text", "image"] };
  const wire = (value: Messages) => JSON.stringify(convertMessages(model, { messages: convertToLlm(value) }, {}));
  assert.equal(count(messages), 22); assert.equal(count(projected), 0);
  assert.ok(wire(projected).length < wire(messages).length * 0.1);
});

test("15 selected pages leave only finalized proven engineering; reread, pending decisions and stale proofs restore images",async()=>{
  const records=Array.from({length:15},(_,i)=>({...evidence,path:path.join(workspace,`chosen-${i}.jpg`),sourceKey:`chosen-${i}`}));
  const final={...proof,finalized:true,excluded:[],active:records,required:records};
  const messages:Messages=[assistant(0,records.map((record,i)=>tool(`chosen-${i}`,"read",{path:record.path}))),
    ...records.map((_,i)=>image(`chosen-${i}`)),history()[2]!,saved(final)];
  const projectReady=(values=messages,ready:VisualProof|undefined=final)=>projectVisualContext(values,records,script,workspace,[final],[],values,ready);
  assert.equal(count(projectVisualContext(messages,records,script,workspace,[final])),15);
  const projected=projectReady();assert.equal(count(projected),0);
  const model={id:"fixture",provider:"fixture",api:"openai-completions",input:["text","image"]};
  const wire=(values:Messages)=>JSON.stringify(convertMessages(model,{messages:convertToLlm(values)},{}));
  assert.ok(wire(projected).length<wire(messages).length*0.1);
  assert.equal(count(projectReady(messages,{...final,sha256:"b".repeat(64)})),15);
  const again=[...messages,assistant(500,[tool("detail-again","read",{path:records[0]!.path})]),image("detail-again",600)];
  assert.equal(count(projectReady(again)),2,"all instances of explicitly reread page reach next request");
  const pending=[...messages,assistant(500,[tool("pending-decision","write",{path:"selections/new.json",content:"unverified"})]),
    {role:"toolResult",toolName:"write",toolCallId:"pending-decision",timestamp:time+600,isError:true,content:[{type:"text",text:"failed"}]} as Messages[number]];
  assert.equal(count(projectReady(pending)),15);
  const entries=messages.map((message,i)=>({type:"message",id:String(i),message}));
  const ctx={sessionManager:{getBranch:()=>entries},abort:()=>{}} as unknown as ExtensionContext;
  const runtime=createVisualRuntime({workspace,projectRoot:path.resolve("."),isEngineeringReady:(_ctx,value)=>value.sha256===final.sha256},async()=>({images:records,proofs:[final]}));
  assert.equal(count((await runtime.context({type:"context",messages:JSON.parse(JSON.stringify(messages))},ctx))!.messages),0);
  const event={reason:"threshold",branchEntries:entries,preparation:{messagesToSummarize:messages,turnPrefixMessages:[]}} as unknown as SessionBeforeCompactEvent;
  assert.equal(await runtime.beforeCompact(event,ctx),undefined);
  assert.equal(count(messages),15,"native history remains unchanged");
});

for (const length of [1, 2, 3, 4, 5, 27]) test(`capacity grouping uses up to four new images for ${length} paths`, () => {
  const images = Array.from({ length }, (_, i) => ({ ...evidence, path: `${i}.jpg` }));
  const result = groupImages(images, { requestBytes: 1000, historyImages: 0 });
  assert.equal(result.groups.length, Math.ceil(length / 4)); assert.ok(result.groups.every((group) => group.length <= 4));
  assert.equal(result.deferred.length, 0); assert.match(result.capacitySource, /client estimate/);
});

test("budget includes history, text/body/output reserves, heterogeneous image sizes and stricter native limits", () => {
  const pictures = [evidence, evidence, evidence, evidence];
  const result = groupImages(pictures, { requestBytes: 1000, historyImages: 3,
    inputLimits: { images: { maxPerRequest: 5, maxPerMessage: 1 } } });
  assert.deepEqual(result.groups.map((group) => group.length), [1, 1]); assert.equal(result.deferred.length, 2);
  assert.equal(groupImages(pictures, { requestBytes: 1000, historyImages: 0, inputLimits: { images: { maxPerMessage: 2 } } }).groups[0].length, 2);
  assert.equal(groupImages(pictures, { requestBytes: 1000, historyImages: 0, inputLimits: { images: { maxPerMessage: 3 } } }).groups[0].length, 3);
  assert.equal(groupImages(pictures, { requestBytes: 20 * 1024 * 1024, historyImages: 0 }).groups.length, 0);
  assert.equal(groupImages(pictures, { requestBytes: 1, historyImages: 0, contextWindow: 100_000, contextTokens: 9000, outputReserve: 90_000 }).groups.length, 0);
  assert.equal(groupImages([{ ...evidence, bytes: 1_000_000 }, evidence], { requestBytes: 100,
    historyImages: 0, inputLimits: { maxRequestBytes: 200_000 } }).groups[0].length, 1);
});

test("payload measurement counts actual images/body across supported native protocols and emits no content", () => {
  for (const block of [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } },
    { type: "image", source: { type: "base64", data: "YQ==" } }, { inlineData: { data: "YQ==", mimeType: "image/jpeg" } }]) {
    const payload = { system: "fixture-secret", messages: [{ role: "user", content: [block, block] }] };
    const stats = measurePayload(payload);
    assert.equal(stats.images, 2); assert.equal(stats.maxMessageImages, 2);
    assert.equal(stats.requestBytes, Buffer.byteLength(JSON.stringify(payload))); assert.doesNotMatch(JSON.stringify(stats), /fixture-secret|YQ==/);
  }
});

test("native compaction protects undecided images but permits verified discarded evidence; overflow ends without retry loop", async () => {
  let failure = "", aborted = 0;
  const runtime = createVisualRuntime({ workspace, projectRoot: path.resolve("."), onTermination: (reason) => { failure = reason; } },
    async () => ({ images: [evidence], proofs: [proof] }));
  const event = (messages: Messages, reason = "threshold") => ({ reason,
    branchEntries: messages.map((message, i) => ({ type: "message", id: `${i}`, message })),
    preparation: { messagesToSummarize: messages, turnPrefixMessages: [] } }) as unknown as SessionBeforeCompactEvent;
  const ctx = { abort: () => { aborted++; } } as ExtensionContext;
  assert.deepEqual(await runtime.beforeCompact(event(history().slice(0, 2)), ctx), { cancel: true });
  assert.equal(aborted, 0);
  assert.deepEqual(await runtime.beforeCompact(event(history().slice(0, 2), "overflow"), ctx), { cancel: true });
  assert.equal(aborted, 1); assert.match(failure, /容量/);
  assert.equal(await runtime.beforeCompact(event(history()), ctx), undefined);
});

test("failed metadata falls back without logging secrets or denying valid image reads", async () => {
  const handler = createVisualContextHandler({ workspace, projectRoot: path.resolve(".") }, async () => { throw Object.assign(new Error("secret"), { code: "ENOENT" }); });
  assert.equal(await handler({ type: "context", messages: history() }), undefined);
});

test("locator advice counts projected history, not stale pre-release native usage, and never mutates the payload", async () => {
  const runtime = createVisualRuntime({workspace,projectRoot:path.resolve(".")}, async () => ({images:[evidence],proofs:[proof]}));
  await runtime.context({type:"context",messages:history()});
  const content = [{type:"text" as const,text:JSON.stringify({images:[evidence,evidence,evidence,evidence]})}];
  const result = runtime.toolResult({toolName:"bash",isError:false,input:{command:`node "${script}" locate --workspace "${workspace}" --ids src-123456789abc`},content} as any,
    {model:{contextWindow:200_000,maxTokens:32768},getContextUsage:()=>({tokens:190000})} as any);
  const value=JSON.parse(result!.content[0].text);
  assert.equal(value.imageGroups[0].length,4); assert.equal(value.grouping.historyImages,0);
  assert.match(value.grouping.tokenSource,/heuristic over projected/);
  assert.equal(JSON.parse(content[0].text).grouping,undefined);
});

const batch: SelectionProof = {version:1,taskId:"task",file:path.join(workspace,"selections/one.json"),sha256:"c".repeat(64),
  images:[{...evidence, imageHash:createHash("sha256").update(Buffer.from("a".repeat(60_000),"base64")).digest("hex"),complete:true,
    decisions:[{from:0,to:9,decision:"selected",purpose:"matching audio",reason:"clear subject"}]}]};
function batchHistory(value=batch): Messages {
  return [history()[0]!, image(),assistant(200,[tool("save-batch","write",{path:"selections/one.json",content:"fixture"}),
    tool("next","read",{path:"next.jpg"})]),
    {role:"toolResult",toolName:"write",toolCallId:"save-batch",isError:false,timestamp:time+300,
      content:[{type:"text",text:JSON.stringify({ok:true,selection:value})}]},image("next",400)];
}
const projectBatch=(messages=batchHistory(),verified=[batch],records=[evidence])=>projectVisualContext(messages,records,script,workspace,[],verified);

test("saved selected batch exits while new same-turn images remain; exact decisions and pairing survive",()=>{
  const raw=batchHistory(),serialized=JSON.stringify(raw),projected=projectBatch(raw);
  assert.equal(count(projected),1); assert.equal(JSON.stringify(raw),serialized);
  assert.match(JSON.stringify(projected[1]),/matching audio/);assert.match(JSON.stringify(projected[1]),/sheet.jpg/);
  assert.equal((projected[1] as any).toolCallId,"read-1");
  const native={id:"fixture",provider:"fixture",api:"openai-completions",input:["text","image"]};
  const payload={messages:convertMessages(native,{messages:convertToLlm(projected)},{} as any)};
  assert.equal(measurePayload(payload).images,1);
});

test("pending, altered records/images, wrong source and unread/same-turn pages stay actual",()=>{
  const pending={...batch,images:[{...batch.images[0]!,complete:false}]};
  assert.equal(count(projectBatch(batchHistory(pending),[pending])),2);
  assert.equal(count(projectBatch(batchHistory(),[])),2);
  assert.equal(count(projectBatch(batchHistory(),[{...batch,sha256:"d".repeat(64)}])),2);
  const failedUpdate=[...batchHistory(),assistant(500,[tool("failed-save","write",{path:batch.file})]),
    {role:"toolResult",toolName:"write",toolCallId:"failed-save",isError:true,timestamp:time+600,
      content:[{type:"text",text:"fixture write failed"}]}] as Messages;
  assert.equal(count(projectBatch(failedUpdate)),2,"failed same-file update must not fall back to old proof even when file bytes remain");
  const modified={...batch,images:[{...batch.images[0]!,imageHash:"f".repeat(64)}]};
  assert.equal(count(projectBatch(batchHistory(modified),[modified])),2);
  assert.equal(count(projectBatch(batchHistory(),[batch],[{...evidence,sourceKey:"changed"}])),2);
  const messages=batchHistory();
  const same=[assistant(0,[tool("read-1","read",{path:evidence.path}),tool("save-batch","write",{path:batch.file})]),
    image(),messages[3]!];
  assert.equal(count(projectBatch(same)),1);
  const reread=[...messages,assistant(500,[tool("reread","read",{path:evidence.path})]),image("reread",600)];
  assert.equal(count(projectBatch(reread)),3);
});

test("independent batch invalidation and compaction reconstruct from trusted native branch",async()=>{
  const nextEvidence={...evidence,path:path.join(workspace,"next.jpg"),sourceKey:"next"};
  const nextBatch={...batch,file:path.join(workspace,"selections/two.json"),sha256:"e".repeat(64),images:[{...batch.images[0]!,...nextEvidence}]};
  const messages=[...batchHistory(),assistant(500,[tool("save-next","write",{path:nextBatch.file})]),
    {role:"toolResult",toolName:"write",toolCallId:"save-next",isError:false,timestamp:time+600,
      content:[{type:"text",text:JSON.stringify({ok:true,selection:nextBatch})}]}] as Messages;
  assert.equal(count(projectBatch(messages,[nextBatch],[evidence,nextEvidence])),1,"stale first batch retains only first image");
  const runtime=createVisualRuntime({workspace,projectRoot:path.resolve(".")},async()=>({images:[evidence,nextEvidence],proofs:[],selections:[batch,nextBatch]}));
  const ctx={sessionManager:{getBranch:()=>messages.map((message,i)=>({type:"message",id:String(i),message}))}} as any;
  const compacted=[messages[0]!,messages[1]!,messages[2]!,messages[4]!];
  const result=await runtime.context({type:"context",messages:compacted},ctx);
  assert.equal(count(result!.messages),0,"retained native branch proves decision even when compacted request omits its result");
  assert.equal(count(projectBatch(compacted)),2,"a data file or missing branch alone is insufficient");
});
