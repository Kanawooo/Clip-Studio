import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { agentLoop, runAgentLoop } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js";
import { createReadToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { createWriteToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTaskAccessPolicy } from "../src/pi/access-policy.js";
import { fingerprint, imageProvenance, mediaAccess, taskInput } from "../.pi/skills/clip-skills/scripts/media-cache.mjs";
import fs from "node:fs/promises";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { convertMessages as openAI } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { convertMessages as google } from "../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js";
import { stream as anthropic } from "../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
import { groupImages, measurePayload, createVisualRuntime } from "../src/pi/visual-context.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://invalid.test/v1",
  reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000 };
const reply = (content: any[], stopReason = "toolUse"): any => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
  stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });

for (const length of [1, 2, 3, 4, 5, 27]) test(`native agent loop merges ${length} actual reads into planned four-image rounds`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "clip-native-batch-"));
  try {
    const pictures = Array.from({ length }, (_, i) => {
      const file = path.join(root, `素材 ${i}.png`); writeFileSync(file, png);
      return { path: file, bytes: png.length, width: 1, height: 1 };
    });
    const groups = groupImages(pictures, { requestBytes: 1000, historyImages: 0 }).groups;
    let requests = 0, actualImages = 0;
    const context: any = { systemPrompt: "offline fixture", messages: [], tools: [createReadToolDefinition(root)] };
    const stream = (_model: any, input: any) => {
      const result = createAssistantMessageEventStream();
      const reads = input.messages.filter((message: any) => message.role === "toolResult");
      for (const read of reads) {
        assert.equal(read.isError, false, JSON.stringify(read.content));
        assert.ok(read.content.some((block: any) => block.type === "image"), JSON.stringify(read.content));
      }
      actualImages = reads.reduce((sum: number, read: any) => sum + read.content.filter((block: any) => block.type === "image").length, 0);
      assert.equal(actualImages, groups.slice(0, requests).flat().length, "all same-turn images reach next request together");
      const group = groups[requests++];
      const message = group ? reply(group.map((image, i) => ({ type: "toolCall", id: `r-${requests}-${i}`, name: "read", arguments: { path: image.path } })))
        : reply([{ type: "text", text: "done" }], "stop");
      result.push({ type: "done", reason: message.stopReason, message }); result.end(message); return result;
    };
    await agentLoop([{ role: "user", content: [{ type: "text", text: "fixture" }], timestamp: Date.now() }],
      context, { model, convertToLlm }, undefined, stream).result();
    assert.equal(requests, Math.ceil(length / 4) + 1); assert.equal(actualImages, length);
  } finally {
    const relative = path.relative(tmpdir(), root); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual native OpenAI/Gemini/Anthropic payload conversions preserve multi-image source labels with zero network", async () => {
  const messages: any[] = [reply(Array.from({ length: 4 }, (_, i) => ({ type: "toolCall", id: `r-${i}`, name: "read", arguments: { path: `source-${i}.jpg` } }))),
    ...Array.from({ length: 4 }, (_, i) => ({ role: "toolResult", toolName: "read", toolCallId: `r-${i}`, timestamp: Date.now(), isError: false,
      content: [{ type: "text", text: `source-${i}.mp4 page1 range0-3` }, { type: "image", mimeType: "image/png", data: png.toString("base64") }] }))];
  const context: any = { systemPrompt: "fixture", messages, tools: [] };
  const openPayload = { messages: openAI(model, context, {}) };
  const geminiPayload = { contents: google({ ...model, id: "gemini-fixture", provider: "google", api: "google-generative-ai" }, context) };
  assert.equal(measurePayload(openPayload).images, 4); assert.equal(measurePayload(geminiPayload).images, 4);
  let payload: unknown, networkCalls = 0;
  const response = anthropic({ ...model, id: "claude-fixture", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://invalid.test" }, context,
    { apiKey: "offline-not-a-real-key", maxRetries: 0, fetch: async () => { networkCalls++; throw new Error("network forbidden"); },
      onPayload: (value) => { payload = value; throw new Error("offline capture complete"); } });
  await response.result();
  assert.equal(networkCalls, 0); assert.equal(measurePayload(payload).images, 4);
  for (const value of [openPayload, geminiPayload, payload]) for (let i = 0; i < 4; i++) assert.match(JSON.stringify(value), new RegExp(`source-${i}\\.mp4`));
});

test("actual native extension and loop save old selection while reading next batch; wire images are 0/2/2/0 with no extra request",async()=>{
  const root=await fs.realpath(mkdtempSync(path.join(tmpdir(),"clip-selection-loop-")));
  try {
    const tasksDir=path.join(root,"tasks"),workspace=path.join(tasksDir,"task/workspace"),assetsDir=path.join(root,"media"),audioDir=path.join(root,"audio"),outputDir=path.join(root,"outputs");
    for(const dir of [workspace,assetsDir,audioDir,outputDir])mkdirSync(dir,{recursive:true});
    const referenceVideo=path.join(root,"reference.mp4");writeFileSync(referenceVideo,"offline reference");
    writeFileSync(path.join(workspace,"media-policy.json"),JSON.stringify({version:1,taskId:"task",reuseVisualAnalysis:false,inputs:{referenceVideo,assetsDir,audioDir}}));
    const views=[];
    for(let i=0;i<4;i++) {
      const source=path.join(assetsDir,`${i}.mp4`);writeFileSync(source,`offline identity ${i}`);
      const directory=path.join(workspace,`media-views/${i}`);mkdirSync(directory,{recursive:true});
      const file=path.join(directory,"sheet.png"),entry=path.join(directory,"entry.json");writeFileSync(file,png);
      const view={source,sourceKey:(await fingerprint(source)).key,kind:"source",duration:3,entry,
        sheets:[{path:file,firstSecond:0,lastSecond:3,frameCount:2,width:1,height:1}],frames:[]};
      // The stored page can use a Windows short-path alias while native read returns its long real path.
      const alias=path.join(tmpdir(),path.basename(root),path.relative(root,file));
      writeFileSync(entry,JSON.stringify({...view,sheets:[{...view.sheets[0],path:alias}]}));views.push(view);
    }
    writeFileSync(path.join(workspace,"media-index.json"),JSON.stringify({reference:{source:referenceVideo,sourceKey:(await fingerprint(referenceVideo)).key,kind:"reference"},sources:views,audio:[]}));
    for(const view of views) {
      assert.equal((await fingerprint(await (await mediaAccess(workspace)).file(view.source,"source"))).key,view.sourceKey,"fixture source identity");
      const actual=await taskInput(await fs.realpath(workspace),view.sheets[0].path);
      assert.equal(actual.toLowerCase(),path.resolve(view.sheets[0].path).toLowerCase(),"fixture picture path");
      assert.equal(JSON.parse(await fs.readFile(await taskInput(await fs.realpath(workspace),view.entry),"utf8")).duration,3);
    }
    assert.equal((await imageProvenance(workspace,views.map(view=>view.sheets[0].path))).length,4,"fixture uses canonical task-local evidence");
    const manager=SessionManager.inMemory(workspace),ctx:any={sessionManager:manager,model,getContextUsage:()=>undefined,abort:()=>{throw new Error("unexpected abort");}};
    const hooks=new Map<string,any>();
    const extension=createTaskAccessPolicy({projectRoot:path.resolve("."),tasksDir,workspace,referenceVideo,assetsDir,audioDir,outputDir});
    await extension.factory({on:(name:string,fn:any)=>{hooks.set(name,fn);return()=>{};},appendEntry:(kind:string,data:unknown)=>manager.appendCustomEntry(kind,data)} as any);
    const readGroup=(offset:number)=>views.slice(offset,offset+2).map((view,i)=>({type:"toolCall",id:`read-${offset+i}`,name:"read",arguments:{path:view.sheets[0].path}}));
    const saveGroup=(offset:number)=>({type:"toolCall",id:`save-${offset}`,name:"write",arguments:{path:`selections/${offset}.json`,content:JSON.stringify({version:1,kind:"selection-batch",
      rows:views.slice(offset,offset+2).map(view=>({image:view.sheets[0].path,decisions:[{from:0,to:3,decision:"selected",purpose:"match narration",reason:"observed synthetic source"}]}))})}});
    const replies=[reply(readGroup(0)),reply([saveGroup(0),...readGroup(2)]),reply([saveGroup(2)]),reply([{type:"text",text:"done"}],"stop")];
    const counts:number[]=[];
    const stream=(_model:any,input:any)=>{
      const payload={messages:openAI(model,input,{})};counts.push(measurePayload(payload).images);
      hooks.get("before_provider_request")?.({type:"before_provider_request",payload},ctx);
      const message=replies[counts.length-1];assert.ok(message,"no unexpected model request");
      const result=createAssistantMessageEventStream();result.push({type:"done",reason:message.stopReason,message});result.end(message);return result;
    };
    await runAgentLoop([{role:"user",content:[{type:"text",text:"offline fixture"}],timestamp:Date.now()}],
      {systemPrompt:"offline",messages:[],tools:[createReadToolDefinition(workspace),createWriteToolDefinition(workspace)]} as any,
      {model,convertToLlm,transformContext:async(messages:any)=>(await hooks.get("context")({type:"context",messages},ctx))?.messages??messages,
        beforeToolCall:async({toolCall,args}:any)=>hooks.get("tool_call")({type:"tool_call",toolName:toolCall.name,toolCallId:toolCall.id,input:args},ctx),
        afterToolCall:async({toolCall,args,result,isError}:any)=>hooks.get("tool_result")({type:"tool_result",toolName:toolCall.name,toolCallId:toolCall.id,input:args,content:result.content,isError},ctx)},
      async(event:any)=>{if(event.type==="message_end")manager.appendMessage(event.message);},undefined,stream as any);
    assert.deepEqual(counts,[0,2,2,0]);
    const raw=manager.getBranch().filter(entry=>entry.type==="message"&&entry.message.role==="toolResult");
    assert.equal(raw.reduce((sum,entry:any)=>sum+entry.message.content.filter((block:any)=>block.type==="image").length,0),4,"all actual images preserved in native history");
    assert.ok(raw.filter((entry:any)=>entry.message.toolName==="write").every((entry:any)=>!entry.message.isError));
  } finally {const relative=path.relative(await fs.realpath(tmpdir()),root);assert.ok(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));rmSync(root,{recursive:true,force:true});}
});

test("final-payload hard limits abort once with a specific reason; four-image advice never denies tools", () => {
  let reason = "", aborted = 0;
  const runtime = createVisualRuntime({ workspace: path.resolve("fixture"), projectRoot: path.resolve("."), onTermination: (value) => { reason = value; } });
  const ctx: any = { model: { ...model, inputLimits: { images: { maxPerRequest: 1 } } }, abort: () => { aborted++; } };
  const payload = { messages: [{ role: "user", content: Array.from({ length: 2 }, () => ({ type: "image", source: { data: "YQ==" } })) }] };
  runtime.providerRequest({ type: "before_provider_request", payload }, ctx);
  assert.equal(aborted, 1); assert.match(reason, /完整请求图片数/);
  assert.doesNotMatch(reason, /权限|YQ==/);
});
