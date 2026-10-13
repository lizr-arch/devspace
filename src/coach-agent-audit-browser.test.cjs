"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../coach-browser-extension/worker.js"),"utf8");
function fixture(overrides={}){
 return {
   version:1,identity:{workspaceId:"ws-fixture",operationId:"op-fixture"},
   status:"COMPLETED",elapsedMs:130,confirmedToolStarts:1,confirmedToolCompletions:1,
   observations:[],evidenceTimeline:[],tokenUsage:{input_tokens:3,output_tokens:2},
   dataCoverage:{complete:false,missingEvidence:["tool_results_redacted"]},
   ...overrides
 };
}
async function workerQuery(snapshot,contentType="application/json"){
 let handler,requests=[];
 const pair={port:8765,token:"a".repeat(43)};
 const chrome={
   action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
   storage:{session:{get:async()=>({coachPairing:pair}),set:async()=>{},remove:async()=>{}}},
   runtime:{id:"a".repeat(32),onInstalled:{addListener(){}},
     onStartup:{addListener(){}},onMessage:{addListener(fn){handler=fn;}}},
   alarms:{create(){},onAlarm:{addListener(){}}},
 };
 const response={ok:true,status:200,
   headers:{get:name=>name.toLowerCase()==="content-type"?contentType:null},
   text:async()=>JSON.stringify({snapshot})};
 const fetch=async(url,opts)=>{requests.push({url,opts});return response;};
 vm.runInNewContext(source,{chrome,fetch,Date,encodeURIComponent});
 const result=await new Promise(resolve=>{
   assert.ok(handler);
   assert.equal(handler({type:"COACH_AGENT_AUDIT",workspaceId:"ws-fixture",operationId:"op-fixture"},null,resolve),true);
 });
 return {result,requests};
}
test("worker only reads authenticated local JSON and validates snapshot identity",async()=>{
 const {result,requests}=await workerQuery(fixture());
 assert.equal(result.ok,true);
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,
   "http://127.0.0.1:8765/agent/audit?workspaceId=ws-fixture&operationId=op-fixture");
 assert.equal(requests[0].opts.headers.Authorization,"Bearer "+"a".repeat(43));
 const wrong=await workerQuery(fixture({identity:{workspaceId:"another",operationId:"op-fixture"}}));
 assert.equal(wrong.result.ok,false);
 assert.equal(wrong.result.error,"invalid_audit");
});
test("worker rejects malicious mime and invalid audit structures",async()=>{
 const badMime=await workerQuery(fixture(),"text/html");
 assert.equal(badMime.result.error,"invalid_mime");
 const big=await workerQuery(fixture({observations:Array.from({length:17},()=>({claim:"a"}))}));
 assert.equal(big.result.error,"invalid_audit");
 const negative=await workerQuery(fixture({elapsedMs:-1}));
 assert.equal(negative.result.error,"invalid_audit");
});
