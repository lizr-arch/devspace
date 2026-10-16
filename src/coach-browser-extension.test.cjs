"use strict";
// Include automatic delivery contracts in the existing Coach test entrypoint.
require("./coach-auto-delivery.test.cjs");
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const extension=path.resolve(__dirname,"../coach-browser-extension");
const manifest=JSON.parse(fs.readFileSync(path.join(extension,"manifest.json"),"utf8"));
const code=fs.readFileSync(path.join(extension,"worker.js"),"utf8");
const token="A".repeat(43);
function harness(){
  const records={};
  const listeners={};
  const history=[];
  let badge=null;
  const api={
    runtime:{id:"a".repeat(32),onInstalled:{addListener(fn){listeners.installed=fn;}},
      onStartup:{addListener(fn){listeners.startup=fn;}},onMessage:{addListener(fn){listeners.message=fn;}}},
    alarms:{create(){},onAlarm:{addListener(fn){listeners.alarm=fn;}}},
    storage:{session:{
      async get(k){return {[k]:records[k]};},
      async set(o){Object.assign(records,o);},
      async remove(k){delete records[k];}
    }},
    action:{async setBadgeText(o){badge=o.text;},async setBadgeBackgroundColor(){}}
  };
  let healthy=true;
  const fetch=async(url,options)=>{
    history.push({url,options});
    if(url.endsWith("/health"))return {ok:healthy,status:healthy?200:401,json:async()=>({ok:healthy,service:"coach-feed"})};
    if(url.endsWith("/events"))return {ok:true,status:200,json:async()=>({
      pending_count:1,events:[{event_id:2,operation_id:"real-event",event_type:"READY_FOR_GPT_REVIEW"}]
    })};
    throw new Error("unexpected request");
  };
  const context=vm.createContext({chrome:api,fetch,Date,Error,String,Array,Math,Number,Promise,importScripts(){}});
  vm.runInContext(code,context);
  const send=payload=>new Promise(resolve=>{
    const ret=listeners.message(payload,{id:api.runtime.id},resolve);
    assert.equal(ret,true);
  });
  return {send,records,history,getBadge:()=>badge,setHealthy:v=>healthy=v,context};
}
test("manifest narrow localhost plus opt-in ChatGPT content script",()=>{
 assert.equal(manifest.manifest_version,3);
 assert.deepEqual(manifest.permissions,["alarms","storage","sidePanel","tabs"]);
 assert.deepEqual(manifest.host_permissions,["http://127.0.0.1/*"]);
 assert.deepEqual(manifest.content_scripts[0].matches,["https://chatgpt.com/*"]);
 assert.equal(manifest.content_scripts[0].js[0],"chatgpt-delivery.js");
 assert.match(code,/importScripts\("auto-worker.js"\)/);
});
test("no token means no fetch and explicit pairing required",async()=>{
 const h=harness();
 await vm.runInContext("feedCheck()",h.context);
 assert.equal(h.history.length,0);
 assert.equal(h.getBadge(),"P");
});
test("bad token rejected without persisting or fetching",async()=>{
 const h=harness();
 const result=await h.send({type:"COACH_PAIR",port:8765,token:"not-a-token"});
 assert.equal(result.ok,false);
 assert.equal(h.records.coachPairing,undefined);
 assert.equal(h.history.length,0);
});
test("HTTP authorization failure rejected without storing token",async()=>{
 const h=harness();h.setHealthy(false);
 const result=await h.send({type:"COACH_PAIR",port:8765,token});
 assert.equal(result.ok,false);
 assert.equal(h.records.coachPairing,undefined);
});
test("explicit pair, scoped localhost requests, UI status hides token",async()=>{
 const h=harness();
 const result=await h.send({type:"COACH_PAIR",port:8765,token});
 assert.equal(result.ok,true);
 assert.equal(h.records.coachPairing.token,token);
 assert.equal(h.records.coachStatus.pending,1);
 assert.equal(h.getBadge(),"1");
 assert.ok(h.history.every(x=>x.url.startsWith("http://127.0.0.1:8765/")));
 assert.ok(h.history.every(x=>x.options.headers.Authorization==="Bearer "+token));
 const state=await h.send({type:"COACH_STATUS"});
 assert.equal(state.extensionId,"a".repeat(32));
 assert.equal(JSON.stringify(state).includes(token),false);
 const refresh=await h.send({type:"COACH_REFRESH"});
 assert.equal(refresh.events[0].operation_id,"real-event");
 const unpaired=await h.send({type:"COACH_UNPAIR"});
 assert.equal(unpaired.ok,true);
 assert.equal(h.records.coachPairing,undefined);
 assert.equal(h.getBadge(),"P");
});
