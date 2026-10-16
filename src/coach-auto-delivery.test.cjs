"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const root=join(__dirname,"../coach-browser-extension");
const code=readFileSync(join(root,"auto-worker.js"),"utf8");
const content=readFileSync(join(root,"chatgpt-delivery.js"),"utf8");
const URL_OK="https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const EVENT={event_id:12,workspace_id:"ws-qa",operation_id:"codex-qa",event_type:"READY_FOR_GPT_REVIEW"};
const tick=()=>new Promise(r=>setImmediate(r));
test("all delivery extension scripts are valid JavaScript",()=>{
 for(const file of ["worker.js","auto-worker.js","chatgpt-delivery.js","popup.js","autosend-popup.js"]){
   assert.doesNotThrow(()=>new vm.Script(readFileSync(join(root,file),"utf8"),{filename:file}));
 }
});

function workerHarness(overrides={}) {
  const session={},local={},listeners=[],alarms=[],messages=[],tabUpdates=[],tabRemovals=[];
  const tab={id:42,url:URL_OK};
  let events=[EVENT],delivered={ok:true,submitted:true},pendingCount=null;
  const chrome={
    storage:{
      session:{async get(k){return {[k]:session[k]};},async set(v){Object.assign(session,v);},async remove(k){delete session[k];}},
      local:{async get(k){return {[k]:local[k]};},async set(v){Object.assign(local,v);}}
    },
    tabs:{
      async query(){return [tab];},async get(id){if(id!==42)throw Error("tab_gone");return tab;},
      async sendMessage(id,m){messages.push({id,m});return typeof delivered==="function"?delivered(id,m):delivered;},
      onUpdated:{addListener(f){tabUpdates.push(f);}},
      onRemoved:{addListener(f){tabRemovals.push(f);}}
    },
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},
      onMessage:{addListener(f){listeners.push(f);}}},
    alarms:{create(){},onAlarm:{addListener(f){alarms.push(f);}}}
  };
  const fetch=async(url,options)=>{
    assert.match(url,/^http:\/\/127\.0\.0\.1:8765\/events$/);
    assert.match(options.headers.Authorization,/^Bearer A{43}$/);
    return {ok:true,json:async()=>({pending_count:pendingCount??events.length,events})};
  };
  const context=vm.createContext({chrome,fetch,URL,Date,Number,Object,Array,
    String,RegExp,Error,Math,Promise,console});
  vm.runInContext(code,context);
  async function msg(type,extra={}) {
    const fn=listeners.find(f=>f({type},null,()=>{})===true);
    assert.ok(fn, "listener not installed");
    return new Promise(resolve=>fn({type,...extra},null,resolve));
  }
  async function drain(){for(let i=0;i<5;i++)await tick();}
  return {session,local,tab,messages,msg,drain,tabUpdates,tabRemovals,
    setEvents:x=>{events=x;},setPendingCount:x=>{pendingCount=x;},setDelivery:x=>{delivered=x;},
    async poll(){await vm.runInContext("autoPump()",context);}
  };
}
test("disabled by default: no ChatGPT tab touched and exact URL required",async()=>{
 const h=workerHarness();
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.enabled,false);
 await h.poll();assert.equal(h.messages.length,0);
 h.tab.url="https://example.com/c/123456789";
 assert.equal((await h.msg("COACH_AUTO_BIND")).ok,false);
 h.tab.url="https://chatgpt.com/";
 assert.equal((await h.msg("COACH_AUTO_BIND")).ok,false);
 h.tab.url=URL_OK;
 assert.equal((await h.msg("COACH_AUTO_BIND")).ok,true);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.enabled,false);
 assert.equal(h.messages.length,0);
});
test("only authenticated READY_FOR_GPT_REVIEW, one send, stable duplicate suppression",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 await h.msg("COACH_AUTO_BIND");
 h.setEvents([{...EVENT,event_type:"RUNNING"},{...EVENT,operation_id:"../unsafe"},EVENT]);
 assert.equal((await h.msg("COACH_AUTO_ENABLE")).ok,true);
 await h.drain();await h.poll();
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].id,42);
 assert.match(h.messages[0].m.instruction,/APPROVED \/ REWORK \/ BLOCKED/);
 assert.match(h.messages[0].m.instruction,/codex-qa/);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
 await h.poll();assert.equal(h.messages.length,1);
 await h.msg("COACH_AUTO_PAUSE");await h.poll();assert.equal(h.messages.length,1);
});
test("incomplete Sidecar event page never silently delivers a truncated queue",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setPendingCount(51);await h.msg("COACH_AUTO_BIND");
 await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,0);
});
test("old Sidecar lacking workspace_id still notifies, explicitly marking uncertainty",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setEvents([{event_id:13,operation_id:"legacy-task",event_type:"READY_FOR_GPT_REVIEW"}]);
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.messages.length,1);
 assert.match(h.messages[0].m.instruction,/旧版 Sidecar 未返回/);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
});
test("new Sidecar scopes events to its own workspace for exact evidence lookup",()=>{
 const code=readFileSync(join(__dirname,"managed-coach-sidecar.ts"),"utf8");
 assert.match(code,/workspace_id:entry\.workspaceId/);
 assert.match(code,/e\.workspace_id = \?/);
});
test("navigation to different conversation stops delivery without opening tabs",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 await h.msg("COACH_AUTO_BIND");
 h.tab.url=URL_OK.replace("12345678","87654321");
 assert.equal((await h.msg("COACH_AUTO_ENABLE")).ok,false);
 assert.equal(h.messages.length,0);
});
test("unknown DOM outcome becomes needs_attention and is never blindly replayed",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setDelivery({ok:false,reason:"draft"});
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();await h.poll();
 assert.equal(h.messages.length,1);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.needs_attention,1);
});
test("worker recovery preserves in-flight ambiguity and blocks duplicate delivery",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={"ws-qa:codex-qa:12":{state:"in_flight",at:"earlier"}};
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.needs_attention,1);
});
test("leaving the bound conversation explicitly pauses, returning does not auto-resume",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setEvents([]);await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();
 h.tab.url="https://chatgpt.com/c/abcdefabcdefabcd";
 h.tabUpdates[0](42,{url:h.tab.url});
 await h.drain();
 h.tab.url=URL_OK;h.setEvents([EVENT]);await h.poll();
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.enabled,false);
 assert.equal(h.messages.length,0);
 h.tabRemovals[0](42);await h.drain();
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.bound,false);
});
test("a pairing reset revokes the grant in the original worker",()=>{
 const original=readFileSync(join(root,"worker.js"),"utf8");
 assert.match(original,/session.remove\("coachAutoTarget"\)/);
});
test("unpairing sidecar removes ability to send new events",async()=>{
 const h=workerHarness();await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();assert.equal(h.messages.length,0);
});
function domHarness(options={}) {
 const handlers=[];
 const editor={isConnected:true,hidden:false,innerText:options.draft||"",
   textContent:options.draft||"",getAttribute:()=>"true",focus(){}};
 const button={isConnected:true,hidden:false,disabled:!!options.disabled,
   getAttribute:()=>null,click(){if(!options.noClear){editor.innerText="";editor.textContent="";}}};
 const document={
   querySelectorAll(q){if(options.missing)return [];return q.startsWith("#prompt-textarea")?[editor]:
     q==='button[data-testid="send-button"]'?[button]:[];},
   querySelector(q){return options.busy && q.startsWith("[data-testid")?{}:null;},
   createRange(){return {selectNodeContents(){},collapse(){}};},
   execCommand(_cmd,_show,s){editor.innerText=s;editor.textContent=s;return !options.execFail;}
 };
 const window={top:null,getSelection(){return {removeAllRanges(){},addRange(){}}}};
 window.top=window;
 const location={href:options.url||URL_OK};
 const chrome={runtime:{onMessage:{addListener(f){handlers.push(f);}}}};
 const context=vm.createContext({document,window,chrome,location,URL,
   getComputedStyle:()=>({display:"block",visibility:"visible"}),
   setTimeout:(fn)=>fn(),Promise,Error,String,Array,Number});
 vm.runInContext(content,context);
 return {editor,button,location,
   deliver:(url=URL_OK)=>new Promise(resolve=>handlers[0](
     {type:"COACH_AUTO_DELIVER",url,instruction:"请以 Web GPT Coach 身份独立审核测试事件"},null,resolve))};
}
test("content script rejects unrelated tab, existing draft, busy UI and missing controls",async()=>{
 assert.equal((await domHarness({url:"https://evil.example/c/abc"}).deliver()).ok,false);
 assert.match((await domHarness({draft:"用户草稿"}).deliver()).reason,/草稿/);
 assert.match((await domHarness({busy:true}).deliver()).reason,/生成/);
 assert.equal((await domHarness({missing:true}).deliver()).ok,false);
});
test("event to content-script DOM submission: simulated extension end-to-end",async()=>{
 const page=domHarness(),h=workerHarness();
 h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setDelivery((_id,m)=>page.deliver(m.url,m.instruction));
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.messages.length,1);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
});
test("Chrome restart drops per-session target authorization",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setEvents([]);await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();delete h.session.coachAutoTarget;
 h.setEvents([EVENT]);await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.enabled,false);
});
test("content script only confirms composer DOM submission, not completed AI review",async()=>{
 const good=domHarness();const result=await good.deliver();
 assert.equal(result.ok,true);assert.equal(result.submitted,true);
 const uncertain=await domHarness({noClear:true}).deliver();
 assert.equal(uncertain.ok,false);assert.equal(uncertain.uncertain,true);
});
