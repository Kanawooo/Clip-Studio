import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCompositionBatchGuard, initializeCompositionBatch } from "../src/pi/access-policy.js";

const projectRoot = path.resolve(".");
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Clip Studio 批量 工程 ")));
const ffmpeg = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
process.env.HYPERFRAMES_FFPROBE_PATH = path.join(projectRoot, ".runtime", "ffmpeg", "bin", "ffprobe.exe");
const { fillTemplate, writeCompositions } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/write-compositions.mjs");
const { validatedManifest } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
after(() => {
  const relative = path.relative(tmpdir(), root);
  assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const taskDir = path.join(root, `task-${Math.random().toString(16).slice(2)}`);
  const workspace = path.join(taskDir, "workspace"), project = path.join(workspace, "video-project");
  const assets = path.join(taskDir, "素材"), audioDir = path.join(taskDir, "音频");
  const delivery = path.join(taskDir, "delivery"), output = path.join(taskDir, "输出");
  for (const dir of [workspace, project, assets, audioDir, delivery, output]) mkdirSync(dir, {recursive:true});
  const reference = path.join(taskDir, "参考.mp4");
  writeFileSync(reference, "scope fixture");
  const audio = path.join(audioDir, "声音 & 音频.wav");
  execFileSync(ffmpeg, ["-v","error","-f","lavfi","-i","sine=frequency=440:duration=1.2",
    "-c:a","pcm_s16le","-y",audio], {windowsHide:true,timeout:30_000});
  writeFileSync(path.join(workspace,"media-policy.json"), JSON.stringify({version:1,taskId:path.basename(taskDir),
    reuseVisualAnalysis:false,inputs:{referenceVideo:reference,assetsDir:assets,audioDir}}));
  const slots = [1,2].map((number) => `Clip-Studio-${path.basename(taskDir)}-${number}-abcdef12.mp4`);
  writeFileSync(path.join(delivery,"contract.json"), JSON.stringify({version:1,taskId:path.basename(taskDir),
    workspace,outputDir:output,audioDir,slots,silentDuration:null}));
  const template = `<div data-composition-id="{{ID}}" data-duration="1.2" data-width="640" data-height="360">
    <audio src="{{AUDIO}}" data-start="0" data-duration="1.2" data-track-index="10"></audio>
    {{html:BODY}}<script>const shots={{json:SHOTS}};</script></div>`;
  writeFileSync(path.join(workspace,"template.html"),template);
  const rows = [1,2].map((number) => ({composition:`compositions/0${number}.html`,mainAudio:{source:audio},
    values:{ID:`video-${number}`,AUDIO:audio,BODY:`<p class="clip" data-start="0" data-duration="1.2">独立布局 ${number}</p>`,SHOTS:[number]}}));
  const manifest = {version:1,project:"video-project",template:"template.html",fps:30,rows};
  const file = path.join(workspace,"工程 JSON.json");
  const save = (value:unknown=manifest) => writeFileSync(file,JSON.stringify(value));
  save();
  return {taskDir,workspace,project,assets,audioDir,audio,output,slots,manifest,file,save};
}

test("template serializes scalar, JSON and independently-authored HTML without executing code", () => {
  assert.equal(fillTemplate("{{NAME}}",{NAME:'<a "quoted">&'}), "&lt;a &quot;quoted&quot;&gt;&amp;");
  assert.match(fillTemplate("{{json:DATA}}",{DATA:{text:"</script>"}}), /\\u003c\/script/);
  assert.equal(fillTemplate("{{html:BODY}}",{BODY:"<p>authored layout</p>"}), "<p>authored layout</p>");
  assert.throws(() => fillTemplate("{{MISSING}}",{}), /缺失/);
  assert.throws(() => fillTemplate("{{DATA}}",{DATA:{a:1}}), /json/);
  assert.throws(() => fillTemplate("{{json:DATA}}",{DATA:undefined}), /有效 JSON/);
  assert.equal(fillTemplate("${process.exit(1)}",{}), "${process.exit(1)}");
});

test("one batch writes distinct compositions and feeds the existing audio-driven render contract", async () => {
  const item = fixture();
  const result = await writeCompositions({workspace:item.workspace,manifest:item.file});
  assert.equal(result.saved.length,2); assert.deepEqual(result.failed,[]);
  const first = readFileSync(result.saved[0].file,"utf8"), second = readFileSync(result.saved[1].file,"utf8");
  assert.match(first,/独立布局 1/); assert.match(second,/独立布局 2/);
  assert.match(first,/声音 &amp; 音频/);
  const renderFile = path.join(item.workspace,"render-manifest.json");
  writeFileSync(renderFile,JSON.stringify({version:1,project:"video-project",settings:{fps:30,quality:"high"},
    rows:item.manifest.rows.map((row,index) => ({composition:row.composition,mainAudio:row.mainAudio,output:item.slots[index]}))}));
  const verified = await validatedManifest({workspace:item.workspace,manifest:renderFile,"output-dir":item.output});
  assert.ok(verified.rows.every((row) => Math.abs(row.audio.target - 1.2)<0.01 && row.audio.inputs.length===2));
  const retry = await writeCompositions({workspace:item.workspace,manifest:item.file});
  assert.equal(retry.saved.length,0); assert.equal(retry.skipped.length,2);
  assert.equal(readFileSync(result.saved[0].file,"utf8"),first);
});

test("independent full content does not require a shared creative template", async () => {
  const item = fixture();
  const audio = item.audio.replace(/&/g,"&amp;");
  item.save({...item.manifest,rows:[{composition:"custom.html",mainAudio:{source:item.audio},
    content:`<main data-composition-id="custom" data-duration="1.2"><audio src="${audio}" data-start="0" data-duration="1.2"></audio><svg></svg></main>`}]});
  const result = await writeCompositions({workspace:item.workspace,manifest:item.file});
  assert.equal(result.saved.length,1); assert.match(readFileSync(result.saved[0].file,"utf8"),/<svg>/);
});

test("all rows preflight before writing: missing audio, shortened duration, duplicate targets and traversal fail with a row", async () => {
  const item = fixture();
  const cases = [
    {rows:[item.manifest.rows[0],{...item.manifest.rows[1],mainAudio:undefined}]},
    {rows:[item.manifest.rows[0],{...item.manifest.rows[1],content:'<div data-composition-id="bad" data-duration="3"></div>',values:undefined}]},
    {rows:[item.manifest.rows[0],{...item.manifest.rows[1],composition:item.manifest.rows[0].composition}]},
    {rows:[item.manifest.rows[0],{...item.manifest.rows[1],composition:"../../outside.html"}]},
    {rows:[item.manifest.rows[0],{...item.manifest.rows[1],values:{...item.manifest.rows[1].values,ID:"video-1"}}]},
  ];
  for (const change of cases) {
    item.save({...item.manifest,...change});
    await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /rows\[1\]/);
    assert.equal(existsSync(path.join(item.project,"compositions/01.html")),false);
  }
  item.save({...item.manifest,project:"../outside"});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /project/);
});

test("scope and media validation reject external resources, protected links and unselected audio", async () => {
  const item = fixture(), outside = path.join(root,"outside-template.html");
  writeFileSync(outside,"not authorized");
  item.save({...item.manifest,template:outside});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /rows\[0\].*当前任务工作目录/);
  item.save({...item.manifest,rows:[{...item.manifest.rows[0],values:{...item.manifest.rows[0].values,
    BODY:'<img src="https://example.invalid/image.jpg">'}}]});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /工程媒体必须/);
  const unselected = path.join(root,"unselected.wav"); await fs.copyFile(item.audio,unselected);
  item.save({...item.manifest,rows:[{...item.manifest.rows[0],mainAudio:{source:unselected}}]});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /超出音频目录/);
  await fs.link(path.join(item.workspace,"media-policy.json"),path.join(item.project,"linked.html"));
  item.save({...item.manifest,rows:[{...item.manifest.rows[0],composition:"linked.html"}]});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}), /硬链接/);
});

test("different existing content is never overwritten and a failed row retains successful rows for retry", async () => {
  const item = fixture(), options = {workspace:item.workspace,manifest:item.file};
  const failedTarget = path.join(await fs.realpath(item.project),"compositions","02.html");
  const originalLink = fs.link;
  let fail = true;
  fs.link = async (source,destination) => {
    if (fail && String(destination)===failedTarget) {
      throw Object.assign(new Error("fixture I/O error api_key=secret-test-only"),{code:"EIO"});
    }
    return originalLink(source,destination);
  };
  try {
    const result = await writeCompositions(options);
    assert.equal(result.saved.length,1); assert.equal(result.failed.length,1);
    assert.equal(result.failed[0].row,1); assert.match(result.failed[0].error,/fixture I\/O error/);
    assert.doesNotMatch(result.failed[0].error,/secret-test-only/);
    const prior = readFileSync(result.saved[0].file,"utf8");
    fail=false;
    const retry = await writeCompositions(options);
    assert.equal(retry.skipped.length,1); assert.equal(retry.saved.length,1);
    item.manifest.rows[0].values.BODY="changed creative content"; item.save();
    await assert.rejects(writeCompositions(options),/已有工程内容不同.*未覆盖/);
    assert.equal(readFileSync(result.saved[0].file,"utf8"),prior);
    assert.ok((await fs.readdir(path.dirname(result.saved[0].file))).every((name)=>!name.endsWith(".tmp")));
  } finally {fs.link=originalLink;}
});

test("silent batch uses the backend requirement, not a model-supplied duration", async () => {
  const item=fixture(), contractFile=path.join(item.taskDir,"delivery","contract.json");
  item.save({...item.manifest,rows:[{composition:"silent.html",silentDuration:2,
    content:'<div data-composition-id="silent" data-duration="2"></div>'}]});
  await assert.rejects(writeCompositions({workspace:item.workspace,manifest:item.file}),/无声.*明确/);
  const contract=JSON.parse(readFileSync(contractFile,"utf8")); contract.silentDuration=2;
  writeFileSync(contractFile,JSON.stringify(contract));
  assert.equal((await writeCompositions({workspace:item.workspace,manifest:item.file})).saved.length,1);
});

test("actual local CLI accepts documented help and batch arguments without generated-script execution", () => {
  const item=fixture(), script=path.join(projectRoot,".pi/skills/hyperframes/hyperframes-cli/scripts/write-compositions.mjs");
  const execute = (args:string[]) => execFileSync(process.execPath,[script,...args],
    {cwd:item.workspace,encoding:"utf8",windowsHide:true,timeout:30_000});
  assert.match(execute(["--help"]),/--workspace.*--manifest/);
  const result=JSON.parse(execute(["--workspace",item.workspace,"--manifest",item.file]));
  assert.equal(result.saved.length,2); assert.equal(result.failed.length,0);
  assert.equal(JSON.parse(execute(["--workspace",item.workspace,"--manifest",item.file])).skipped.length,2);
  assert.throws(()=>execute(["--workspace",item.workspace,"--manifest",item.file,"--workspace",item.workspace]),/不能重复/);
});

function guardFixture(mark=true) {
  const item=fixture(), sessionDir=path.join(item.taskDir,"session");mkdirSync(sessionDir,{recursive:true});
  const manager=SessionManager.create(item.workspace,sessionDir);
  initializeCompositionBatch(manager,item.workspace,mark);
  manager.appendMessage({role:"user",content:[{type:"text",text:"offline task"}],timestamp:Date.now()});
  const options={projectRoot,tasksDir:root,workspace:item.workspace,referenceVideo:path.join(item.taskDir,"参考.mp4"),assetsDir:item.assets,
    audioDir:item.audioDir,outputDir:item.output};
  const writer=path.join(projectRoot,".pi/skills/hyperframes/hyperframes-cli/scripts/write-compositions.mjs"),queue=path.join(projectRoot,".pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
  const renderFile=path.join(item.workspace,"render.json");
  writeFileSync(renderFile,JSON.stringify({version:1,project:"video-project",settings:{fps:30},
    rows:item.manifest.rows.map((row,i)=>({composition:row.composition,mainAudio:row.mainAudio,output:item.slots[i]}))}));
  const event=(id:string,command:string):any=>({type:"tool_call",toolName:"bash",toolCallId:id,input:{command}});
  const run=event("run",`node "${queue}" run --workspace "${item.workspace}" --manifest "${renderFile}" --output-dir "${item.output}"`);
  const call=(id:string,name:string,args:object)=>manager.appendMessage({role:"assistant",api:"openai-completions",provider:"fixture",model:"fixture",stopReason:"toolUse",timestamp:Date.now(),
    content:[{type:"toolCall",id,name,arguments:args}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const ctx:any={sessionManager:manager};
  const guard=createCompositionBatchGuard(options);
  const result=(id:string,name:string,input:object,value:unknown,isError=false)=>{
    const content:any[]=[{type:"text",text:JSON.stringify(value)}];
    const event:any={toolName:name,toolCallId:id,input,content,isError};
    guard.after(event,ctx,data=>manager.appendCustomEntry("clip-composition-receipt",data));
    manager.appendMessage({role:"toolResult",toolName:name,toolCallId:id,content,isError,timestamp:Date.now()});
  };
  const write=async(id="writer")=>{
    const command=`node "${writer}" --workspace "${item.workspace}" --manifest "${item.file}"`;
    call(id,"bash",{command});const output=await writeCompositions({workspace:item.workspace,manifest:item.file});
    result(id,"bash",{command},output,output.failed.length>0);return output;
  };
  return {...item,manager,ctx,guard,options,run,call,result,write,event,writer,queue,renderFile,sessionDir};
}

test("new multi-output Session gets non-model marker; missing writer corrects once, then batch/edit/restart proceed",async()=>{
  const item=guardFixture();
  const blocked=item.guard.before(item.run,item.ctx);assert.match(blocked!.reason!,/VALIDATION:COMPOSITION_BATCH_REQUIRED/);
  assert.doesNotMatch(blocked!.reason!,/访问策略/);assert.equal(blocked!.terminate,false);
  const original=readFileSync(item.renderFile,"utf8"),badCount=JSON.parse(original);badCount.rows.push(badCount.rows[0]);
  writeFileSync(item.renderFile,JSON.stringify(badCount));
  assert.equal(item.guard.before(item.run,item.ctx),undefined,"wrong count stays with existing queue field validator, not batch-origin guard");
  writeFileSync(item.renderFile,original);
  assert.doesNotMatch(JSON.stringify(item.manager.buildSessionContext()),/clip-composition-batch/);
  assert.equal((await item.write()).saved.length,2);
  assert.equal(item.guard.before(item.run,item.ctx),undefined);
  const file=path.join(item.project,"compositions/01.html"),old=readFileSync(file,"utf8");
  item.call("edit","edit",{path:file,oldText:"独立布局 1",newText:"局部布局修正"});
  writeFileSync(file,old.replace("独立布局 1","局部布局修正"));
  item.result("edit","edit",{path:file},{saved:true});
  assert.equal(item.guard.before(item.run,item.ctx),undefined,"native edit updates existing writer provenance");
  const entry=item.manager.getLeafId();item.manager.appendCompaction("offline compaction",entry,1000);
  const reopened=SessionManager.open(item.manager.getSessionFile()!,item.sessionDir,item.workspace);
  assert.equal(createCompositionBatchGuard(item.options).before(item.run,{sessionManager:reopened} as any),undefined);
  const fallback=SessionManager.create(item.workspace,item.sessionDir);
  initializeCompositionBatch(fallback,item.workspace,false,item.manager.getSessionFile());
  assert.ok(fallback.getEntries().some(e=>e.type==="custom" && e.customType==="clip-composition-batch"),"new Session fallback retains original requirement");
  writeFileSync(file,old+"unrecorded outside edit");
  assert.match(item.guard.before(item.run,item.ctx)!.reason!,/COMPOSITION_BATCH_REQUIRED/);
});

test("legacy and single-output remain unmarked; forged local flags or unpaired native receipts cannot authorize new batches",async()=>{
  const legacy=guardFixture(false);assert.equal(legacy.guard.before(legacy.run,legacy.ctx),undefined);
  const single=fixture(),contractFile=path.join(single.taskDir,"delivery/contract.json"),contract=JSON.parse(readFileSync(contractFile,"utf8"));
  contract.slots=contract.slots.slice(0,1);writeFileSync(contractFile,JSON.stringify(contract));
  const manager=SessionManager.inMemory(single.workspace);initializeCompositionBatch(manager,single.workspace,true);
  assert.equal(manager.getEntries().some(e=>e.type==="custom" && e.customType==="clip-composition-batch"),false);
  const item=guardFixture(),output=await writeCompositions({workspace:item.workspace,manifest:item.file});
  writeFileSync(path.join(item.workspace,"batch-receipt.json"),JSON.stringify(output));
  item.manager.appendCustomEntry("clip-composition-receipt",{kind:"writer",toolCallId:"fake",files:output.saved});
  assert.match(item.guard.before(item.run,item.ctx)!.reason!,/COMPOSITION_BATCH_REQUIRED/);
  assert.equal((await item.write()).skipped.length,2,"identical adoption allowed but not counted as new generation");
  assert.equal(item.guard.before(item.run,item.ctx),undefined);
});

test("unchanged batch errors stop finitely; help is not progress, real writer tail and partial rows are",async()=>{
  const item=guardFixture();let termination="";
  const guard=createCompositionBatchGuard({...item.options,onTermination:reason=>{termination=reason;}});
  assert.equal(guard.before(item.run,item.ctx)?.terminate,false);
  guard.before(item.event("help",`node "${item.writer}" --help`),item.ctx);
  assert.equal(guard.before(item.run,item.ctx)?.terminate,false);
  assert.equal(guard.before(item.run,item.ctx)?.terminate,true);assert.match(termination,/制作失败.*流程错误/);
  item.save({...item.manifest,rows:[item.manifest.rows[0]]});await item.write("first-half");
  assert.match(guard.before(item.run,item.ctx)!.reason!,/02.html/);
  item.save({...item.manifest,rows:[item.manifest.rows[1]]});await item.write("tail");
  assert.equal(guard.before(item.run,item.ctx),undefined,"valid single tail completes coverage");
  const partial=guardFixture();const first=await writeCompositions({workspace:partial.workspace,manifest:partial.file});
  const command=`node "${partial.writer}" --workspace "${partial.workspace}" --manifest "${partial.file}"`;
  partial.call("partial","bash",{command});
  partial.result("partial","bash",{command},{saved:[first.saved[0]],skipped:[],failed:[{row:1,error:"fixture I/O"}]},true);
  assert.match(partial.guard.before(partial.run,partial.ctx)!.reason!,/02.html/);
  await partial.write("retry");assert.equal(partial.guard.before(partial.run,partial.ctx),undefined);
});

test("engineering readiness requires current finalized plan, slots/audio, paired writer or native legacy provenance",async()=>{
  const item=guardFixture();await item.write();
  const planFile=path.join(item.workspace,"edit-plan.json");
  const plan={outputs:item.slots.map(output=>({output,duration:1.2,shots:[],mainAudio:{source:item.audio}}))};
  writeFileSync(planFile,JSON.stringify(plan));
  const proof:any={version:1,file:planFile,sha256:(await import("node:crypto")).createHash("sha256").update(readFileSync(planFile)).digest("hex"),
    taskId:path.basename(item.taskDir),finalized:true,active:[],required:[],excluded:[]};
  assert.equal(item.guard.isReady(item.ctx,proof),false,"unproven render manifest retains images");
  const content=readFileSync(item.renderFile,"utf8");
  item.call("manifest-write","write",{path:item.renderFile,content});item.result("manifest-write","write",{path:item.renderFile},{saved:true});
  assert.equal(item.guard.isReady(item.ctx,proof),true);
  assert.equal(item.guard.isReady(item.ctx,{...proof,finalized:false}),false);
  assert.equal(item.guard.isReady(item.ctx,{...proof,sha256:"a".repeat(64)}),false);
  const render=JSON.parse(content);render.rows[0].mainAudio.from=0.2;writeFileSync(item.renderFile,JSON.stringify(render));
  assert.equal(item.guard.isReady(item.ctx,proof),false);writeFileSync(item.renderFile,content);
  const target=path.join(item.project,"compositions/01.html"),original=readFileSync(target,"utf8");
  writeFileSync(target,original+"unproven edit");assert.equal(item.guard.isReady(item.ctx,proof),false);writeFileSync(target,original);
  const unpaired=SessionManager.inMemory(item.workspace);
  unpaired.appendCustomEntry("clip-composition-receipt",{kind:"writer",toolCallId:"forged",files:[{file:target,sha256:proof.sha256}]});
  assert.equal(item.guard.isReady({sessionManager:unpaired} as any,proof),false);
  const reopened=SessionManager.open(item.manager.getSessionFile()!,item.sessionDir,item.workspace);
  assert.equal(item.guard.isReady({sessionManager:reopened} as any,proof),true);
  const html=original.replace("</div>",`<video src="${item.audio.replace(/&/g,"&amp;")}" data-start="0" data-duration="1.2" data-media-start="2"></video></div>`);
  writeFileSync(target,html);item.call("matching-write","write",{path:target,content:html});item.result("matching-write","write",{path:target},{saved:true});
  plan.outputs[0]!.shots=[{source:item.audio,start:2,end:3.2}] as any;
  writeFileSync(planFile,JSON.stringify(plan));proof.sha256=(await import("node:crypto")).createHash("sha256").update(readFileSync(planFile)).digest("hex");
  assert.equal(item.guard.isReady(item.ctx,proof),true,"native start/end plan matches engineering source window");
  plan.outputs[0]!.shots=[{source:item.audio,start:1,end:2.2}] as any;
  writeFileSync(planFile,JSON.stringify(plan));proof.sha256=(await import("node:crypto")).createHash("sha256").update(readFileSync(planFile)).digest("hex");
  assert.equal(item.guard.isReady(item.ctx,proof),false,"same audio but different selected window retains images");
});
