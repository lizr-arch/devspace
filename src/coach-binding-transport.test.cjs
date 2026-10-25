"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const worker=readFileSync(join(__dirname,"../coach-browser-extension/auto-worker.js"),"utf8");
const CHAT="https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const OLD_CHAT="https://chatgpt.com/c/09876543-dcba-1234-abcd-123456789abc";
function env(answer,{injectionFails=false}={}) {
  const session={coachPairing:{port:8765,token:"A".repeat(43)}};
  const existing={"ws-old":{url:OLD_CHAT,tabId:2,enabled:true,nonce:"a".repeat(32)}};
  const local={coachAutoRoutes:existing};
  const store=area=>({
    async get(k){if(typeof k==="string")return {[k]:area[k]};return area;},
    async set(values){Object.assign(area,values);},
    async remove(k){delete area[k];}
  });
  const chrome={
    storage:{session:store(session),local:store(local)},
    tabs:{async query(){return [{id:7,url:CHAT}]},
      async get(){return{id:7,url:CHAT}},
      onUpdated:{addListener(){}},onRemoved:{addListener(){}}
    },
    scripting:{async executeScript(){if(injectionFails)throw Error("No host permission");return[]}},
    runtime:{getManifest(){return{version:"0.3.17"}},
      onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}
    },
    alarms:{create(){},onAlarm:{addListener(){}}}
  };
  chrome.tabs.sendMessage=async()=>{if(answer instanceof Error)throw answer;return answer;};
  const fetch=async()=>({ok:true,json:async()=>({ok:true})});
  const crypto={getRandomValues(array){array.fill(17);return array;}};
  const context=vm.createContext({chrome,fetch,crypto,URL,Date,Number,String,Object,RegExp,Array,Promise,console});
  vm.runInContext(worker,context);
  return {context,session,local,run:()=>vm.runInContext("autoOneClick()",context)};
}
test("definitely not submitted: preserve cause, remove only its pending challenge; allow explicit retry",async()=>{
  const x=env({ok:false,notSubmitted:true,reason:"Web GPT 正在生成"});
  const r=await x.run();
  assert.equal(r.code,"BIND_NOT_SUBMITTED");
  assert.equal(r.safeRetry,true);
  assert.match(r.error,/Web GPT 正在生成/);
  assert.equal(Object.keys(x.session.coachAutoPendingBinds).length,0);
  assert.deepEqual(Object.keys(x.local.coachAutoRoutes),["ws-old"]);
});
test("unknown send result: preserve exact cause, pending challenge, and disallow automatic retry",async()=>{
  const x=env({ok:false,uncertain:true,reason:"发送后编辑器未确认清空"});
  const r=await x.run();
  assert.equal(r.code,"BIND_SEND_UNCERTAIN");
  assert.equal(r.safeRetry,false);
  assert.match(r.error,/发送后编辑器未确认清空/);
  assert.equal(Object.keys(x.session.coachAutoPendingBinds).length,1);
  assert.equal(Object.values(x.session.coachAutoPendingBinds)[0].submitted,undefined);
});
test("confirmed DOM submission: distinguish submitted challenge from provisional server registration",async()=>{
  const x=env({ok:true,submitted:true});
  const r=await x.run();
  assert.equal(r.ok,true);
  assert.equal(Object.values(x.session.coachAutoPendingBinds)[0].submitted,true);
});
test("script injection failure is certainly unsent; pending nonce cleared and permission guidance surfaced",async()=>{
  const x=env({ok:true,submitted:true},{injectionFails:true});
  const r=await x.run();
  assert.equal(r.code,"BIND_SCRIPT_UNAVAILABLE");
  assert.equal(r.safeRetry,true);
  assert.match(r.error,/chatgpt.com 网站权限/);
  assert.equal(Object.keys(x.session.coachAutoPendingBinds).length,0);
});
test("extension message exception is uncertain; never clear nonce and automatically repeat",async()=>{
  const x=env(new Error("message channel closed"));
  const r=await x.run();
  assert.equal(r.code,"BIND_SEND_UNCERTAIN");
  assert.equal(r.safeRetry,false);
  assert.equal(Object.keys(x.session.coachAutoPendingBinds).length,1);
});
