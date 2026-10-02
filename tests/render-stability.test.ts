import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const projectRoot = path.resolve(".");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "Clip Studio 渲染 恢复 ")));
const ffmpeg = path.join(projectRoot, ".runtime/ffmpeg/bin/ffmpeg.exe");
process.env.HYPERFRAMES_FFPROBE_PATH = path.join(projectRoot, ".runtime/ffmpeg/bin/ffprobe.exe");
const { runQueue } = await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-queue.mjs");
const { admissionBudget, renderMap, extractionThreadArgs, classifyRenderFailure, publicError, sourceDiagnostic } =
  await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-support.mjs");
const { localizeGsap, prepareRenderComposition, verifyGsapResource } =
  await import("../.pi/skills/hyperframes/hyperframes-cli/scripts/render-resources.mjs");
const { patchRenderSource } = await import("../scripts/hyperframes-render-patch.mjs");
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
after(() => {
  assert.ok(!path.relative(os.tmpdir(), root).startsWith(".."));
  rmSync(root, { recursive: true, force: true });
});

test("reservation/commit budgets account for unspawned children and missing measurements on different hosts", () => {
  const GiB = 1024 ** 3;
  const machine = { active: 0, logicalCpus: 16, cpuBusy: 0.1, freeBytes: 12*GiB, totalBytes:16*GiB, estimatedWorkerBytes:2*GiB };
  assert.equal(admissionBudget(machine).admit,true);
  assert.equal(admissionBudget({...machine,active:1,known:false}).admit,false);
  assert.equal(admissionBudget({...machine,known:false}).admit,true);
  assert.equal(admissionBudget({...machine,active:1,committedFreeBytes:GiB}).admit,false);
  const reserved=admissionBudget({...machine,freeBytes:5*GiB,active:2,reservations:[{id:1,bytes:2*GiB},{id:2,bytes:2*GiB}]});
  assert.equal(reserved.admit,false);
  assert.equal(admissionBudget({...machine,freeBytes:5*GiB,active:1,reservations:[{id:1,bytes:2*GiB}],measured:new Map([[1,2*GiB]])}).admit,true);
  assert.equal(admissionBudget({...machine,active:1,cpuBusy:0.95}).admit,false);
  assert.equal(admissionBudget({...machine,logicalCpus:2,active:2}).admit,false);
  assert.equal(admissionBudget({...machine,active:1,freeBytes:GiB,totalBytes:4*GiB}).admit,false);
  assert.equal(admissionBudget({...machine,active:2,observedWorkerBytes:4*GiB,freeBytes:5*GiB}).admit,false,"stage growth reduces future admissions");
});

test("idle queues always make progress at one worker/thread under physical, commit, CPU or unknown pressure", () => {
  const GiB=1024**3;
  const machine={active:0,logicalCpus:16,cpuBusy:0,freeBytes:12*GiB,totalBytes:16*GiB,estimatedWorkerBytes:2*GiB};
  for(const pressure of [
    {freeBytes:0}, {committedFreeBytes:0}, {cpuBusy:1}, {known:false},
    {freeBytes:2.2*GiB,observedWorkerBytes:4*GiB}, {freeBytes:GiB,totalBytes:4*GiB},
  ]) {
    const minimum=admissionBudget({...machine,...pressure});
    assert.equal(minimum.admit,true);
    assert.equal(minimum.lowLoad,true);
    assert.equal(minimum.extractWorkers,1);assert.equal(minimum.extractThreads,1);
    assert.equal(admissionBudget({...machine,...pressure,active:1}).admit,false,"pressure must not add a second output");
  }
  const healthy=admissionBudget({...machine,active:1});
  assert.equal(healthy.admit,true);assert.equal(healthy.lowLoad,false);
  assert.ok(healthy.extractWorkers>1,"healthy machines still use parallel extraction");
});

test("nested extraction bounds concurrency, preserves order and drains already-started work on failure", async () => {
  const before=process.env.CLIP_RENDER_EXTRACT_WORKERS;
  process.env.CLIP_RENDER_EXTRACT_WORKERS="2";
  let running=0,peak=0,finished=0;
  try {
    assert.deepEqual(await renderMap([0,1,2,3],async (n:number)=>{
      running++;peak=Math.max(peak,running);await delay(10);running--;return n;
    }),[0,1,2,3]);
    assert.equal(peak,2);
    await assert.rejects(renderMap([0,1,2,3],async(n:number)=>{
      if(n===0) throw new Error("fixture decode failure");await delay(10);finished++;return n;
    }),/decode failure/);
    assert.equal(finished,1);
    process.env.CLIP_RENDER_EXTRACT_THREADS="2";
    assert.deepEqual(extractionThreadArgs(),["-threads","2","-filter_threads","2","-filter_complex_threads","2"]);
  } finally {
    if(before===undefined) delete process.env.CLIP_RENDER_EXTRACT_WORKERS; else process.env.CLIP_RENDER_EXTRACT_WORKERS=before;
    delete process.env.CLIP_RENDER_EXTRACT_THREADS;
  }
});

test("source/browser/OOM/hardware/unknown causes stay distinct, bounded and redacted", () => {
  const source=sourceDiagnostic('[CLIP_RENDER_SOURCE] '+JSON.stringify({kind:"ffmpeg",source:"素材.mov",cause:"Invalid data api_key=private-test-key",retryable:false}));
  assert.ok(source);assert.doesNotMatch(JSON.stringify(source),/private-test-key/);
  assert.equal(classifyRenderFailure("Missing coverage",[source],1).stage,"extract");
  assert.equal(classifyRenderFailure("Runtime.evaluate timed out",[],1).stage,"capture");
  assert.equal(classifyRenderFailure("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",[],1).kind,"resource");
  assert.equal(classifyRenderFailure("nvenc encoder not available",[],1).kind,"hardware");
  assert.equal(classifyRenderFailure("unknown fixture error",[],1).retryable,false);
  assert.equal(classifyRenderFailure("--gpu enabled\nUnknown composition",[],1).retryable,false);
  assert.doesNotMatch(publicError('Bearer private-token api_key=private-key https://x/?token=private-query'),/private-/);
  assert.ok(publicError("a".repeat(9000)).length<=2000);
});

test("pinned renderer patch is idempotent, rejects mismatches and preserves coverage verification", () => {
  const source=readFileSync(path.join(projectRoot,"node_modules/hyperframes/dist/cli.js"),"utf8");
  const patched=patchRenderSource(source,"0.8.4");
  assert.equal(patchRenderSource(patched,"0.8.4"),patched);
  assert.throws(()=>patchRenderSource(source,"0.9.0"),/Unsupported/);
  assert.throws(()=>patchRenderSource(source.replace("const metadataResults =", "const unexpectedResults ="),"0.8.4"),/Missing/);
  assert.match(patched,/clipSourceFailures\(extractionResult, composition.videos\)/);
  assert.match(patched,/applyVideoExtractionFailurePolicy/);
  assert.match(patched,/CLIP_RENDER_QUEUE === "1"/);
  assert.match(patched,/kind: "ffprobe_" \+ outcome.reason/);
  const isolated=path.join(root,"syntax.mjs");writeFileSync(isolated,patched);
  execFileSync(process.execPath,["--check",isolated],{windowsHide:true,timeout:30_000});
});

test("fixed local GSAP is hash-checked; legacy render copy preserves original bytes and rejects changed assets", async () => {
  const project=path.join(root,"离线 中文 工程");mkdirSync(project,{recursive:true});
  const original='<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><div data-duration="1.2"></div>';
  const composition=path.join(project,"original.html");writeFileSync(composition,original);
  const digest=hash(composition), prepared=await prepareRenderComposition({composition},project);
  assert.notEqual(prepared.file,composition);assert.match(readFileSync(prepared.file,"utf8"),/assets\/vendor\/gsap-3.14.2/);
  assert.equal(hash(composition),digest);await prepared.verify();await prepared.dispose();assert.equal(existsSync(prepared.file),false);
  const normalized=await localizeGsap(original,project);assert.equal(await localizeGsap(normalized,project),normalized);
  assert.equal(createHash("sha256").update(await verifyGsapResource()).digest("hex"),"ecfee15040cfabcb76889161ac067b6c11ee38d31f087f2248e43c0c3f2c706b");
  writeFileSync(path.join(project,"assets/vendor/gsap-3.14.2.min.js"),"changed asset");
  await assert.rejects(localizeGsap(normalized,project),/固定版本/);
  assert.equal(hash(composition),digest);
});

test("postinstall preflights all pinned signatures before writes; release routes include required runtime resources",async()=>{
  const project=path.join(root,"postinstall"),scripts=path.join(project,"scripts"),browser=path.join(project,"node_modules/@puppeteer/browsers"),renderer=path.join(project,"node_modules/hyperframes");
  for(const dir of [scripts,path.join(browser,"lib"),path.join(browser,"src"),path.join(renderer,"dist")])mkdirSync(dir,{recursive:true});
  for(const file of ["patch-puppeteer-windows.mjs","hyperframes-render-patch.mjs"])await fs.copyFile(path.join(projectRoot,"scripts",file),path.join(scripts,file));
  writeFileSync(path.join(browser,"package.json"),JSON.stringify({version:"3.2.1"}));
  writeFileSync(path.join(renderer,"package.json"),JSON.stringify({version:"0.8.4"}));
  const original="opts.detached ??= true; // windowsHide: true";
  for(const file of ["lib/launch.js","src/launch.ts"])writeFileSync(path.join(browser,file),original);
  writeFileSync(path.join(renderer,"dist/cli.js"),"unexpected renderer signature");
  assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,"patch-puppeteer-windows.mjs")],{windowsHide:true,stdio:"pipe"}),/Missing HyperFrames block/);
  for(const file of ["lib/launch.js","src/launch.ts"])assert.equal(readFileSync(path.join(browser,file),"utf8"),original);
  await fs.copyFile(path.join(projectRoot,"node_modules/hyperframes/dist/cli.js"),path.join(renderer,"dist/cli.js"));
  execFileSync(process.execPath,[path.join(scripts,"patch-puppeteer-windows.mjs")],{windowsHide:true,stdio:"pipe"});
  const first=hash(path.join(renderer,"dist/cli.js"));
  execFileSync(process.execPath,[path.join(scripts,"patch-puppeteer-windows.mjs")],{windowsHide:true,stdio:"pipe"});
  assert.equal(hash(path.join(renderer,"dist/cli.js")),first);
  const audit=readFileSync(path.join(projectRoot,"scripts/audit-release.mjs"),"utf8"),copier=readFileSync(path.join(projectRoot,"scripts/package-release.mjs"),"utf8");
  for(const file of ["scripts/hyperframes-render-patch.mjs",".pi/skills/hyperframes/hyperframes-cli/scripts/render-support.mjs",
    ".pi/skills/hyperframes/hyperframes-cli/scripts/render-resources.mjs",".pi/skills/hyperframes/hyperframes-cli/resources/gsap-3.14.2.min.js",".pi/skills/hyperframes/hyperframes-cli/resources/gsap-3.14.2.json"]){
    assert.equal(existsSync(path.join(projectRoot,file)),true);assert.equal(audit.includes(file),true);
  }
  assert.match(copier,/copyTree\(path.join\("\.pi", "skills"\)/);assert.match(copier,/scripts\/hyperframes-render-patch.mjs/);
});

function fixture(count=2) {
  const taskDir=path.join(root,`task-${Math.random().toString(16).slice(2)}`);
  const workspace=path.join(taskDir,"workspace"),project=path.join(workspace,"工程 空格"),delivery=path.join(taskDir,"delivery"),output=path.join(taskDir,"输出"),audioDir=path.join(taskDir,"音频");
  for(const dir of [workspace,project,delivery,output,audioDir]) mkdirSync(dir,{recursive:true});
  const media=path.join(project,"source.mp4");
  execFileSync(ffmpeg,["-v","error","-f","lavfi","-i","color=c=teal:s=160x90:r=24:d=1.2","-f","lavfi","-i","sine=frequency=440:duration=1.2","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-y",media],{windowsHide:true,timeout:30_000});
  const slots=Array.from({length:count},(_,i)=>`Clip-Studio-${path.basename(taskDir)}-${i+1}-abcdef12.mp4`);
  const contract={version:1,taskId:path.basename(taskDir),workspace,outputDir:output,audioDir,slots};
  writeFileSync(path.join(delivery,"contract.json"),JSON.stringify(contract));
  writeFileSync(path.join(taskDir,"task.json"),JSON.stringify({id:contract.taskId,attemptStartedAt:"attempt-1"}));
  const rows=slots.map((slot,i)=>({output:slot,composition:`${i+1}.html`,mainAudio:{source:media},status:"pending"}));
  for(const row of rows) writeFileSync(path.join(project,row.composition),`<div data-composition-id="row" data-duration="1.2"><audio id="main" src="source.mp4" data-start="0" data-duration="1.2"></audio></div>`);
  const manifest=path.join(workspace,"render.json");writeFileSync(manifest,JSON.stringify({version:1,project:path.basename(project),settings:{fps:24,quality:"high"},rows}));
  const options={workspace,manifest,"output-dir":output};
  const sample=async(reservations:Map<number,unknown>)=>({known:true,measured:new Map([...reservations.keys()].map(id=>[id,1024**3])),freeBytes:24*1024**3,totalBytes:32*1024**3});
  const copy=async(_ctx:unknown,_row:unknown,temp:string)=>{await fs.copyFile(media,temp);};
  return {taskDir,workspace,project,delivery,output,media,slots,options,sample,copy};
}

test("shared row recovery budget survives repeated queue calls; manual retry resets it and keeps completed slots",async()=>{
  const item=fixture();let calls=0;
  const render=async(ctx:unknown,row:any,temp:string)=>{
    calls++;if(row.index===0)throw Object.assign(new Error("fixture browser timeout"),{failure:{stage:"capture",kind:"browser",cause:"Runtime.evaluate timed out",retryable:true}});
    await item.copy(ctx,row,temp);
  };
  await assert.rejects(runQueue(item.options,{sample:item.sample,render,pollMs:1}),/Runtime.evaluate/);
  assert.equal(calls,3);const completed=path.join(item.output,item.slots[1]);const digest=hash(completed);
  calls=0;await assert.rejects(runQueue(item.options,{sample:item.sample,render,pollMs:1}),/RENDER_EXHAUSTED/);assert.equal(calls,0);
  writeFileSync(path.join(item.taskDir,"task.json"),JSON.stringify({id:path.basename(item.taskDir),attemptStartedAt:"attempt-2"}));
  const result=await runQueue(item.options,{sample:item.sample,render:item.copy,pollMs:1});assert.equal(result.completed,2);assert.equal(hash(completed),digest);
  let repeated=0;await runQueue(item.options,{sample:item.sample,render:async()=>{repeated++;},pollMs:1});assert.equal(repeated,0);
});

test("deterministic source errors do not retry; stop never publishes late success or poison later independent queues",async()=>{
  const item=fixture(1);let calls=0;
  await assert.rejects(runQueue(item.options,{sample:item.sample,pollMs:1,render:async()=>{
    calls++;throw Object.assign(new Error("invalid source"),{failure:{stage:"extract",kind:"source",cause:"invalid media",retryable:false}});
  }}),/invalid media/);assert.equal(calls,1);
  await assert.rejects(runQueue(item.options,{sample:item.sample,pollMs:1,render:item.copy}),/RENDER_EXHAUSTED/);
  const stopped=fixture(1),controller=new AbortController();
  await assert.rejects(runQueue(stopped.options,{sample:async(reservations:Map<number,unknown>)=>({...await stopped.sample(reservations),freeBytes:0}),signal:controller.signal,pollMs:1,render:async(ctx:unknown,row:unknown,temp:string)=>{
    controller.abort();await stopped.copy(ctx,row,temp);
  }}),/停止/);
  assert.equal(existsSync(path.join(stopped.output,stopped.slots[0])),false);
  assert.equal(existsSync(path.join(stopped.delivery,"render-queue.lock")),false);
  const next=fixture(1);assert.equal((await runQueue(next.options,{sample:next.sample,render:next.copy,pollMs:1})).completed,1);
});

test("compatible hosts admit multiple reserved jobs; unknown sampling keeps delayed starts serial",async(t)=>{
  const idleCpu=os.cpus();t.mock.method(os,"cpus",()=>idleCpu);
  for(const known of [true,false]) {
    const item=fixture(4);let running=0,peak=0;
    const sample=async(reservations:Map<number,unknown>)=>({...await item.sample(reservations),known,cpuBusy:0});
    await runQueue(item.options,{sample,pollMs:1,render:async(ctx:unknown,row:unknown,temp:string)=>{
      running++;peak=Math.max(peak,running);await delay(25);await item.copy(ctx,row,temp);running--;
    }});
    assert.equal(known ? peak>1 : peak===1,true);
  }
});

test("low-memory queues render every pending row serially; existing receipts are skipped and pressure can recover",async(t)=>{
  const idleCpu=os.cpus();t.mock.method(os,"cpus",()=>idleCpu);
  const item=fixture(3);let running=0,peak=0,calls=0;
  const sample=async(reservations:Map<number,unknown>)=>({...await item.sample(reservations),freeBytes:0,committedFreeBytes:0});
  const result=await runQueue(item.options,{sample,pollMs:1,render:async(ctx:unknown,row:unknown,temp:string,_gpu:boolean,_log:string,reservation:any)=>{
    assert.equal(reservation.extractWorkers,1);assert.equal(reservation.extractThreads,1);assert.equal(reservation.lowLoad,true);
    assert.equal(_gpu,true,"minimum-load admission keeps hardware-first encoding");
    calls++;running++;peak=Math.max(peak,running);await delay(10);await item.copy(ctx,row,temp);running--;
  }});
  assert.equal(result.completed,3);assert.equal(calls,3);assert.equal(peak,1);
  const completed=path.join(item.output,item.slots[0]),digest=hash(completed);
  await runQueue(item.options,{sample,render:async()=>{throw new Error("completed output must not render again");}});
  assert.equal(hash(completed),digest);

  const recovering=fixture(4);let initialRunning=false,firstDone=false,parallel=0,parallelPeak=0;
  const improvedSample=async(reservations:Map<number,unknown>)=>({...await recovering.sample(reservations),freeBytes:initialRunning?24*1024**3:0});
  await runQueue(recovering.options,{sample:improvedSample,pollMs:1,render:async(ctx:unknown,row:any,temp:string,_gpu:boolean,_log:string,reservation:any)=>{
    if(row.index===0){assert.equal(reservation.lowLoad,true);initialRunning=true;await delay(20);await recovering.copy(ctx,row,temp);firstDone=true;return;}
    assert.equal(firstDone,true,"a minimum-load active row must finish before adding parallel work");
    assert.equal(reservation.lowLoad,false);parallel++;parallelPeak=Math.max(parallelPeak,parallel);
    await delay(25);await recovering.copy(ctx,row,temp);parallel--;
  }});
  assert.ok(parallelPeak>1,"subsequent rows can use restored headroom");
});

test("real low-load render failures retry once, preserve their cause and do not loop on estimated budgets",async()=>{
  const item=fixture(1);let calls=0;
  const sample=async(reservations:Map<number,unknown>)=>({...await item.sample(reservations),freeBytes:0});
  await assert.rejects(runQueue(item.options,{sample,pollMs:1,render:async(_ctx:unknown,_row:unknown,_temp:string,_gpu:boolean,_log:string,reservation:any)=>{
    calls++;assert.equal(reservation.extractWorkers,1);assert.equal(reservation.extractThreads,1);
    throw Object.assign(new Error("fixture actual allocation failure"),{failure:{stage:"render",kind:"resource",cause:"fixture actual allocation failure",retryable:true}});
  }}),/RENDER_EXHAUSTED.*actual allocation failure/);
  assert.equal(calls,2);
  await assert.rejects(runQueue(item.options,{sample,pollMs:1,render:async()=>{calls++;}}),/RENDER_EXHAUSTED/);
  assert.equal(calls,2);assert.equal(existsSync(path.join(item.delivery,"render-queue.lock")),false);
});
