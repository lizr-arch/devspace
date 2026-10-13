"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const panel=fs.readFileSync(path.join(__dirname,"../coach-browser-extension/panel.js"),"utf8");
class MockNode{
 constructor(){this.textContent="";this.children=[];this.className="";this.handlers={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(type,cb){this.handlers[type]=cb;}
}
function fakeEvent(cursor,kind,status,phase){
 return {cursor,kind,status,phase,at:"2026-10-12T10:00:00.000Z",workspaceId:"workspace-one",operationId:"op-one"};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test("Chrome side panel shows terminal state, resets after gaps and handles reconnect without DOM injection",async()=>{
 const names=["state","note","tasks","events","pause"];
 const els=Object.fromEntries(names.map(x=>[x,new MockNode()]));
 const responses=[
  {paired:true,online:true,events:[fakeEvent(1,"start","RUNNING","thread.started")],nextCursor:1,gap:0,reset:false},
  {paired:true,online:true,events:[fakeEvent(3,"tool","RUNNING","item.started")],nextCursor:3,gap:1,reset:false},
  {paired:true,online:true,events:[fakeEvent(4,"end","COMPLETED","runner.finalized")],nextCursor:4,gap:0,reset:false},
  {paired:true,online:false,events:[],nextCursor:4,gap:0,reset:false},
  {paired:true,online:true,events:[fakeEvent(1,"start","RUNNING","thread.started")],nextCursor:1,gap:0,reset:true},
 ];
 let polling,received=[];
 const document={
  getElementById:id=>els[id],
  createElement:()=>new MockNode(),
 };
 const runtime={sendMessage:async request=>{received.push(request);return responses.shift();}};
 const window={addEventListener(){}};
 vm.runInNewContext(panel,{document,window,chrome:{runtime},Date,setInterval:fn=>{polling=fn;return 1;},clearInterval});
 await flush();
 assert.equal(els.tasks.children[0].children[0].children[0].children[0].textContent,"op-one");
 assert.equal(els.tasks.children[0].children[0].children[1].textContent,"RUNNING");
 polling();await flush();
 assert.match(els.note.textContent,/历史缺失 1 条/);
 assert.equal(els.tasks.children[0].children[0].children[1].textContent,"状态未知（历史不完整）");
 polling();await flush();
 assert.equal(els.tasks.children[0].children[0].children[1].textContent,"COMPLETED");
 polling();await flush();assert.match(els.state.textContent,/离线/);
 polling();await flush();
 assert.equal(els.tasks.children[0].children[0].children[1].textContent,"RUNNING");
 assert.match(els.note.textContent,/服务已重启/);
 assert.equal(received[0].cursor,0);
 assert.equal(received[1].cursor,1);
 assert.equal(received[2].cursor,3);
 assert.equal(received[4].cursor,4);
 assert.doesNotMatch(panel,/\.innerHTML\b|document\.querySelector\(|chatgpt\.com|chrome\.tabs/);
});
test("click-to-audit renders durable findings across subsequent polls without HTML injection",async()=>{
 const names=["state","note","tasks","events","pause","auditSummary","auditFindings","auditEvidence"];
 const els=Object.fromEntries(names.map(x=>[x,new MockNode()]));
 const feed=[
  {paired:true,online:true,events:[fakeEvent(1,"start","RUNNING","thread.started"),
    fakeEvent(2,"end","COMPLETED","runner.finalized")],nextCursor:2,gap:0,reset:false},
  {paired:true,online:true,events:[],nextCursor:2,gap:0,reset:false},
 ];
 const audit={
  version:1,identity:{workspaceId:"workspace-one",operationId:"op-one"},
  status:"COMPLETED",elapsedMs:520,confirmedToolStarts:2,confirmedToolCompletions:2,
  tokenUsage:{input_tokens:12,output_tokens:4},
  observations:[{id:"possibly-repeated-input",confidence:"low",
    claim:"<img src=x onerror=alert(1)> repeated input, not proven waste",
    recommendation:"Compare actual tool results before deciding",
    evidenceEventIds:["7","9"]}],
  evidenceTimeline:[{id:"7",kind:"command",phase:"item.started",at:"2026-10-12T10:00:00Z"}],
  dataCoverage:{complete:false,missingEvidence:["agent_intent_unavailable"]}
 };
 let polling,received=[];
 const document={getElementById:id=>els[id],createElement:()=>new MockNode()};
 const chrome={runtime:{sendMessage:async msg=>{
   received.push(msg);
   if(msg.type==="COACH_AGENT_AUDIT")return {ok:true,snapshot:audit};
   return feed.shift()||{paired:true,online:true,events:[],nextCursor:2,gap:0,reset:false};
 }}};
 const window={addEventListener(){}};
 vm.runInNewContext(panel,{document,window,chrome,Date,setInterval:fn=>{polling=fn;return 1;},clearInterval});
 await flush();
 const li=els.tasks.children[0];
 assert.ok(li.children[1].handlers.click,"task must expose a real button action");
 li.children[1].handlers.click();await flush();
 assert.match(els.auditSummary.textContent,/520ms/);
 assert.match(els.auditSummary.textContent,/输入 Token 12/);
 assert.match(els.auditFindings.children[0].children[0].textContent,/img src/);
 assert.equal(els.auditFindings.children[0].children[0].children.length,0,"user content stays text");
 assert.match(els.auditEvidence.children[0].textContent,/agent_intent_unavailable/);
 polling();await flush();
 assert.match(els.auditSummary.textContent,/520ms/,"refresh must not erase audit results");
 assert.ok(received.some(x=>x.type==="COACH_AGENT_AUDIT"&&x.operationId==="op-one"));
 assert.doesNotMatch(panel,/\.innerHTML\b|chrome\.tabs/);
});
