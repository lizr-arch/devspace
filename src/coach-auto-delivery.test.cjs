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
  const session={},local={},listeners=[],alarms=[],messages=[],tabUpdates=[],tabRemovals=[],injections=[];
  const tab={id:42,url:URL_OK};
  let events=[EVENT],delivered={ok:true,submitted:true},pendingCount=null;
  let contentReady=true,injectionFailure=false,pingProtocol=5;
  const chrome={
    storage:{
      session:{async get(k){return {[k]:session[k]};},async set(v){Object.assign(session,v);},async remove(k){delete session[k];}},
      local:{async get(k){return {[k]:local[k]};},async set(v){Object.assign(local,v);}}
    },
    tabs:{
      async query(){return [tab];},async get(id){if(id!==42)throw Error("tab_gone");return tab;},
      async sendMessage(id,m){
        if(m.type==="COACH_AUTO_PING_V5"){
          if(!contentReady)throw Error("Receiving end does not exist");
          return {ok:true,protocol:pingProtocol,url:tab.url};
        }
        messages.push({id,m});return typeof delivered==="function"?delivered(id,m):delivered;
      },
      onUpdated:{addListener(f){tabUpdates.push(f);}},
      onRemoved:{addListener(f){tabRemovals.push(f);}}
    },
    scripting:{async executeScript(args){
      injections.push(args);
      if(injectionFailure)throw Error("host permission denied");
      contentReady=true;pingProtocol=5;
    }},
    runtime:{getManifest:()=>({version:"0.3.5"}),onInstalled:{addListener(){}},onStartup:{addListener(){}},
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
  return {session,local,tab,messages,injections,msg,drain,tabUpdates,tabRemovals,
    setEvents:x=>{events=x;},setPendingCount:x=>{pendingCount=x;},setDelivery:x=>{delivered=x;},
    setContentReady:x=>{contentReady=x;},setPingProtocol:x=>{pingProtocol=x;},
    setInjectionFailure:x=>{injectionFailure=x;},
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
 assert.equal(h.messages[0].m.type,"COACH_AUTO_DELIVER_V5");
 assert.match(h.messages[0].m.instruction,/APPROVED \/ REWORK \/ BLOCKED/);
 assert.match(h.messages[0].m.instruction,/codex-qa/);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
 await h.poll();assert.equal(h.messages.length,1);
 await h.msg("COACH_AUTO_PAUSE");await h.poll();assert.equal(h.messages.length,1);
});
test("reloaded extension reinjects script into already-open ChatGPT tab before sending",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setContentReady(false);
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.injections.length,1);
 assert.equal(h.injections[0].target.tabId,42);
 assert.deepEqual(Array.from(h.injections[0].files),["chatgpt-delivery.js"]);
 assert.equal(h.messages.length,1);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
});
test("old content script replies but is rejected by v5 protocol and replaced safely",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setPingProtocol(4); // prior injected V4 script responds to previous version
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.injections.length,1);
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].m.type,"COACH_AUTO_DELIVER_V5");
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
});
test("script injection permission denial never sends and keeps event pending",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setContentReady(false);h.setInjectionFailure(true);
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.injections.length,2);
 assert.equal(h.messages.length,0);
 const state=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(state.summary.pending,1);
 assert.equal(state.summary.needs_attention,0);
 assert.match(state.recent[0].reason,/权限/);
});
test("legacy unknown and scoped records coalesce without replaying uncertain delivery",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={
   "unknown:codex-qa:12":{state:"pending",at:"old"},
   "ws-qa:codex-qa:12":{state:"needs_attention",reason:"找不到唯一的 ChatGPT 编辑器"},
 };
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 const s=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(s.summary.pending,0);assert.equal(s.summary.needs_attention,1);
 assert.equal(s.recent.length,1);
 assert.equal(h.local.coachAutoLedger["unknown:codex-qa:12"].state,"merged");
 assert.equal(h.messages.length,0);
});
test("opening extension popup reconciles scoped and unknown keys even when queue is blocked",async()=>{
 const h=workerHarness();
 h.local.coachAutoLedger={
   "unknown:codex-qa:12":{state:"pending",at:"old"},
   "ws-qa:codex-qa:12":{state:"needs_attention",reason:"旧版脚本的编辑器失败"}
 };
 const state=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(state.version,"0.3.5");
 assert.equal(state.summary.needs_attention,1);
 assert.equal(state.summary.pending,0);
 assert.match(state.blocking,/人工核实/);
 assert.equal(h.local.coachAutoLedger["unknown:codex-qa:12"].state,"merged");
 assert.equal(h.messages.length,0);
});
test("ambiguous workspace matches preserve original ledger identities on offline status",async()=>{
 const h=workerHarness();
 h.local.coachAutoLedger={
   "unknown:codex-qa:12":{state:"pending"},
   "ws-qa:codex-qa:12":{state:"pending"},
   "ws-other:codex-qa:12":{state:"pending"}
 };
 const state=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(state.summary.pending,3);
 assert.equal(h.local.coachAutoLedger["unknown:codex-qa:12"].state,"pending");
});
test("manual Check reports blocker instead of generic success even with a working Sidecar",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={"ws-qa:codex-qa:12":{state:"needs_attention"}};
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");await h.drain();
 const res=await h.msg("COACH_AUTO_PUMP");
 assert.equal(res.ok,true);
 assert.equal(res.state.lastCheck.code,"needs_attention");
 assert.equal(res.state.summary.needs_attention,1);
 assert.equal(h.messages.length,0);
});
test("confirmed legacy sent state suppresses scoped duplicate send",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={"unknown:codex-qa:12":{state:"sent",reason:"DOM 已提交"}};
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,1);
 assert.equal(h.local.coachAutoLedger["ws-qa:codex-qa:12"].state,"sent");
});
test("legacy event identity mismatch never causes cross-task merging",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={"unknown:other-task:12":{state:"needs_attention"}};
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal(h.local.coachAutoLedger["unknown:other-task:12"].state,"needs_attention");
});
test("incomplete Sidecar event page never silently delivers a truncated queue",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setPendingCount(51);await h.msg("COACH_AUTO_BIND");
 await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.equal((await h.msg("COACH_AUTO_STATUS")).state.summary.sent,0);
});
test("user may mark manually sent pending event without an automatic duplicate",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.local.coachAutoLedger={"ws-qa:codex-qa:12":{state:"pending",reason:"准备发送"}};
 const marked=await h.msg("COACH_AUTO_RESOLVE",
   {key:"ws-qa:codex-qa:12",action:"mark_sent"});
 assert.equal(marked.ok,true);
 assert.equal(marked.state.summary.sent,1);
 assert.equal(marked.state.summary.pending,0);
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");
 await h.drain();await h.poll();
 assert.equal(h.messages.length,0);
 assert.match(h.local.coachAutoLedger["ws-qa:codex-qa:12"].reason,/手动发送/);
});
test("pending manual mark never permits a retry without a failed send",async()=>{
 const h=workerHarness();
 h.local.coachAutoLedger={"ws-qa:codex-qa:12":{state:"pending"}};
 const r=await h.msg("COACH_AUTO_RESOLVE",{key:"ws-qa:codex-qa:12",action:"retry"});
 assert.equal(r.ok,false);
 assert.equal(h.local.coachAutoLedger["ws-qa:codex-qa:12"].state,"pending");
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
test("confirmed no-input preflight failure remains pending without blocking later retry",async()=>{
 const h=workerHarness();h.session.coachPairing={port:8765,token:"A".repeat(43)};
 h.setDelivery({ok:false,notSubmitted:true,reason:"找不到唯一的 ChatGPT 编辑器"});
 await h.msg("COACH_AUTO_BIND");await h.msg("COACH_AUTO_ENABLE");await h.drain();await h.poll();
 let s=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(s.summary.pending,1);assert.equal(s.summary.needs_attention,0);
 h.setDelivery({ok:true,submitted:true});
 await h.poll();
 s=(await h.msg("COACH_AUTO_STATUS")).state;
 assert.equal(s.summary.sent,1);assert.equal(s.summary.needs_attention,0);
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
 let buttonChecks=0,clicks=0;
 const editor={isConnected:true,hidden:false,innerText:options.draft||"",
   textContent:options.draft||"",isContentEditable:!options.noEditable,
   getAttribute:name=>name==="contenteditable"&&!options.noEditable?"true":null,
   closest:name=>name==="form"&&options.formSubmit?form:null,focus(){}};
 const extraEditor={...editor,innerText:"",textContent:""};
 const button={isConnected:true,hidden:false,
   get disabled(){return !!options.disabled;},
   getAttribute:()=>null,
   click(){clicks++;if(!options.noClear){editor.innerText="";editor.textContent="";}}};
 const form={querySelectorAll:q=>q==='button[type="submit"]'?[button]:[]};
 const document={
   querySelectorAll(q){
     if(options.missing)return [];
     if(q.startsWith("button[data-testid=\"send-button\"]")){
       buttonChecks++;
       if(options.missingSend||buttonChecks<(options.readyAfterChecks||1)||options.formSubmit)return [];
       return [button];
     }
     const mode=options.editorMode||"legacy";
     if(q.startsWith("#prompt-textarea"))return ["legacy","multi"].includes(mode)?[editor]:[];
     if(q.includes('aria-label="Ask ChatGPT"'))return mode==="multi"?[extraEditor]:
       mode==="labelled"?[editor]:[];
     if(q.includes('aria-label="向 ChatGPT 提问"'))return mode==="chinese"?[editor]:[];
     return [];
   },
   querySelector(q){return options.busy && q.startsWith("[data-testid")?{}:null;},
   createRange(){return {selectNodeContents(){},collapse(){}};},
   execCommand(_cmd,_show,s){
     const actual=options.corruptInsert?s.replace("独立审核","独立审理"):s;
     editor.innerText=options.paragraphRender?actual.replace(/\n/g,"\n\n"):actual;
     editor.textContent=options.paragraphRender?actual.replace(/\n/g,""):actual;
     if(options.delayedEditorReads) {
       let reads=0;
       let committed=actual;
       Object.defineProperty(editor,"innerText",{configurable:true,
         get(){reads++;return reads<=options.delayedEditorReads?"":committed;},
         set(v){committed=v;}});
       Object.defineProperty(editor,"textContent",{configurable:true,
         get(){return reads<=options.delayedEditorReads?"":committed;},
         set(v){committed=v;}});
     }
     return !options.execFail;
   }
 };
 const window={top:null,getSelection(){return {removeAllRanges(){},addRange(){}}}};
 window.top=window;
 const location={href:options.url||URL_OK};
 const chrome={runtime:{onMessage:{addListener(f){handlers.push(f);}}}};
 if(options.oldContentScript)handlers.push((m,_sender,reply)=>{
   if(m?.type==="COACH_AUTO_PING_V4"){reply({ok:true,protocol:4,url:URL_OK});return false;}
   return false;
 });
 const context=vm.createContext({document,window,chrome,location,URL,
   getComputedStyle:()=>({display:"block",visibility:"visible"}),
   setTimeout:(fn)=>fn(),Promise,Error,String,Array,Number});
 vm.runInContext(content,context);
 return {editor,button,location,handlers,context,
   getClicks:()=>clicks,getButtonChecks:()=>buttonChecks,
   ping:()=>new Promise(resolve=>handlers[handlers.length-1]({type:"COACH_AUTO_PING_V5"},null,resolve)),
   reinject:()=>vm.runInContext(content,context),
   deliver:(url=URL_OK,instruction="请以 Web GPT Coach 身份独立审核测试事件")=>
     new Promise(resolve=>handlers[handlers.length-1](
       {type:"COACH_AUTO_DELIVER_V5",url,instruction},null,resolve))};
}
test("content-script ping is read-only and reinjection never duplicates listeners",async()=>{
 const p=domHarness({draft:"用户草稿"});
 const first=await p.ping();
 assert.equal(first.ok,true);assert.equal(first.url,URL_OK);
 assert.equal(first.protocol,5);
 assert.equal(p.editor.innerText,"用户草稿");
 p.reinject();p.reinject();
 assert.equal(p.handlers.length,1);
});
test("new v5 content-script registration coexists with old v4 listener without duplicate send",async()=>{
 const p=domHarness({oldContentScript:true});
 assert.equal(p.handlers.length,2);
 const ping=await p.ping();assert.equal(ping.protocol,5);
 const msg={type:"COACH_AUTO_DELIVER_V5",url:URL_OK,
   instruction:"请以 Web GPT Coach 身份独立审核测试事件"};
 let oldCalled=0;
 const old=p.handlers[0];
 assert.equal(old(msg,null,()=>oldCalled++),false);
 assert.equal(oldCalled,0);
 const res=await new Promise(resolve=>p.handlers[1](msg,null,resolve));
 assert.equal(res.ok,true);assert.equal(res.submitted,true);
 p.reinject();assert.equal(p.handlers.length,2);
});
test("ProseMirror paragraph line breaks do not reject intact multiline review instructions",async()=>{
 const instruction="请以 Web GPT Coach 身份独立审核测试事件\n事件 ID：18\n工作区 ID：ws-test\n任务 ID：test18";
 const page=domHarness({paragraphRender:true});
 const result=await page.deliver(URL_OK,instruction);
 assert.equal(result.submitted,true);
 assert.equal(page.getClicks(),1);
});
test("framework rendering delay is awaited before checking input equality",async()=>{
 const page=domHarness({delayedEditorReads:8});
 const result=await page.deliver();
 assert.equal(result.submitted,true);
 assert.equal(page.getClicks(),1);
});
test("corrupted instruction remains a retained draft; auto-send never clicks",async()=>{
 const page=domHarness({corruptInsert:true});
 const result=await page.deliver();
 assert.equal(result.ok,false);
 assert.match(result.reason,/一致性校验/);
 assert.equal(page.getClicks(),0);
 assert.match(page.editor.innerText,/独立审理/);
});
test("auto-click waits for delayed ChatGPT send control and clicks only once",async()=>{
 const page=domHarness({readyAfterChecks:6});
 const result=await page.deliver();
 assert.equal(result.ok,true);
 assert.equal(result.submitted,true);
 assert.ok(page.getButtonChecks()>=6);
 assert.equal(page.getClicks(),1);
});
test("auto-click accepts a unique submit button only in the same composer form",async()=>{
 const page=domHarness({formSubmit:true});
 const result=await page.deliver();
 assert.equal(result.submitted,true);
 assert.equal(page.getClicks(),1);
});
test("unavailable or disabled send button never clicks and preserves the draft",async()=>{
 for(const options of [{missingSend:true},{disabled:true}]){
   const page=domHarness(options);
   const result=await page.deliver();
   assert.equal(result.ok,false);
   assert.match(result.reason,/发送按钮/);
   assert.equal(page.getClicks(),0);
   assert.match(page.editor.innerText,/独立审核/);
 }
});
test("no auto-click when the user already owns a draft",async()=>{
 const page=domHarness({draft:"用户草稿"});
 const result=await page.deliver();
 assert.equal(result.notSubmitted,true);
 assert.equal(page.getClicks(),0);
 assert.equal(page.editor.innerText,"用户草稿");
});
test("missing composer reports conclusively no submission",async()=>{
 const p=domHarness({missing:true});
 const r=await p.deliver();
 assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);
 assert.equal(p.editor.innerText,"");
});
test("labelled modern ChatGPT composer works, with Chinese locale and deduped selectors",async()=>{
 const a=await domHarness({editorMode:"labelled"}).deliver();
 assert.equal(a.ok,true);assert.equal(a.submitted,true);
 const b=await domHarness({editorMode:"chinese"}).deliver();
 assert.equal(b.ok,true);assert.equal(b.submitted,true);
});
test("competing or non-editable composers fail closed without typing",async()=>{
 const multi=domHarness({editorMode:"multi"});
 assert.match((await multi.deliver()).reason,/唯一/);
 assert.equal(multi.editor.innerText,"");
 const disabled=domHarness({editorMode:"labelled",noEditable:true});
 assert.match((await disabled.deliver()).reason,/唯一/);
 assert.equal(disabled.editor.innerText,"");
});
test("short stop-generation control blocks delivery before typing",async()=>{
 const p=domHarness({busy:true});
 const r=await p.deliver();
 assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);
 assert.equal(p.editor.innerText,"");
});
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
