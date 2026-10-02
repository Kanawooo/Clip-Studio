import assert from "node:assert/strict";
import { test } from "node:test";
import { observeRequestFailure } from "../src/pi/request-failure.js";

test("native HTTP observation delegates exact fetch input and callbacks without reading response bodies", async()=>{
  let fetches=0,callbacks=0;const body={messages:"immutable"};const signal=new AbortController().signal;
  const options:any={signal,maxRetries:2,timeoutMs:90000,onPayload:()=>body,
    fetch:async(...args:unknown[])=>{fetches++;assert.equal(args[0],"fixture-url");assert.equal(args[1],body);return new Response(null,{status:524});},
    onResponse:()=>{callbacks++;}};
  const agent:any={streamFunction:async(model:unknown,context:unknown,received:any)=>{
    assert.equal(context,body);assert.equal(received.signal,signal);assert.equal(received.onPayload,options.onPayload);
    assert.equal(received.maxRetries,2);assert.equal(received.timeoutMs,90000);
    const response=await received.fetch("fixture-url",body);await received.onResponse({status:response.status,headers:{authorization:"never captured"}},model);return response;
  }};
  const original=agent.streamFunction,observer=observeRequestFailure(agent);
  const response=await agent.streamFunction({api:"openai-completions"},body,options);
  assert.equal(response.status,524);assert.equal(fetches,1);assert.equal(callbacks,1);
  assert.match(observer.describe("Request timed out."),/HTTP 524/);
  assert.doesNotMatch(observer.describe("Request timed out."),/authorization/);
  observer.dispose();assert.equal(agent.streamFunction,original);
});

test("underlying transport codes survive SDK generic errors, remain redacted and reset on native success",async()=>{
  const error=Object.assign(new Error("fixture transport token-private-value"),{cause:Object.assign(new Error("certificate check failed"),{code:"CERT_HAS_EXPIRED"})});
  let fail=true;
  const agent:any={streamFunction:async(_model:unknown,_context:unknown,options:any)=>options.fetch("fixture",{})};
  const observer=observeRequestFailure(agent,"token-private-value");
  const options={fetch:async()=>{if(fail)throw error;return new Response(null,{status:200});}};
  await assert.rejects(agent.streamFunction({api:"openai-completions"},{},options));
  assert.match(observer.describe("Connection error"),/CERT_HAS_EXPIRED/);
  assert.doesNotMatch(observer.describe("Connection error"),/token-private-value/);
  fail=false;await agent.streamFunction({api:"openai-completions"},{},options);
  assert.equal(observer.describe("later unrelated failure"),"later unrelated failure");
});

test("Google/Vertex/WebSocket keep native fetch and transport choices; status callback is chained",async()=>{
  for(const api of ["google-generative-ai","google-vertex","openai-responses"]){
    let callbacks=0;
    const options:any={transport:"websocket",onResponse:()=>{callbacks++;}};
    const agent:any={streamFunction:async(model:unknown,_context:unknown,received:any)=>{
      assert.equal(received.fetch,undefined);assert.equal(received.transport,"websocket");
      await received.onResponse({status:503,headers:{}},model);return "native";
    }};
    const observer=observeRequestFailure(agent);
    assert.equal(await agent.streamFunction({api},{},options),"native");
    assert.equal(callbacks,1);assert.match(observer.describe("upstream unavailable"),/HTTP 503/);
  }
});
