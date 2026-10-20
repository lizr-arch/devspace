"use strict";
// Include automatic delivery contracts in the existing Coach test entrypoint.
require("./coach-auto-delivery.test.cjs");
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");
const os=require("node:os");
const {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync}=require("node:fs");
const path=require("node:path");
const extension=path.resolve(__dirname,"../coach-browser-extension");
const manifest=JSON.parse(fs.readFileSync(path.join(extension,"manifest.json"),"utf8"));
const code=fs.readFileSync(path.join(extension,"worker.js"),"utf8");
const token="A".repeat(43);
function harness(){
  const records={};
  const localRecords={};
  const listeners={startup:[],installed:[],alarm:[]};
  const history=[];
  let badge=null,nativeAvailable=false,nativeCalls=0,nativeReply=token,nativeDelay=0,nativeListener;
  const api={
    runtime:{id:"bapcebjlgncogfpgbhllioaichcldkbl",connectNative(){nativeCalls++;if(!nativeAvailable)throw new Error("host_missing");return {
      onMessage:{addListener(fn){nativeListener=fn;}},onDisconnect:{addListener(){}},
      postMessage(){setTimeout(()=>nativeListener({ok:true,port:8765,token:nativeReply}),nativeDelay);}
    };},onInstalled:{addListener(fn){listeners.installed=fn;}},
      onStartup:{addListener(fn){listeners.startup.push(fn);}},onMessage:{addListener(fn){listeners.message=fn;}}},
    alarms:{create(){},onAlarm:{addListener(fn){listeners.alarm.push(fn);}}},
    storage:{session:{
      async get(k){return {[k]:records[k]};},
      async set(o){Object.assign(records,o);},
      async remove(k){delete records[k];}
    },local:{
      async get(k){return {[k]:localRecords[k]};},
      async set(o){Object.assign(localRecords,o);},
      async remove(k){for(const key of (Array.isArray(k)?k:[k]))delete localRecords[key];}
    }},
    action:{async setBadgeText(o){badge=o.text;},async setBadgeBackgroundColor(){}}
  };
  let healthy=true,activeBearer=token;
  const fetch=async(url,options)=>{
    history.push({url,options});
    const authorized=options?.headers?.Authorization==="Bearer "+activeBearer;
    if(url.endsWith("/health"))return {ok:healthy&&authorized,status:healthy&&authorized?200:401,json:async()=>({ok:healthy&&authorized,service:"coach-feed"})};
    if(url.endsWith("/events"))return {ok:healthy&&authorized,status:healthy&&authorized?200:401,json:async()=>({
      pending_count:1,events:[{event_id:2,operation_id:"real-event",workspace_id:"ws-qa",event_type:"READY_FOR_GPT_REVIEW"}]
    })};
    throw new Error("unexpected request");
  };
  const context=vm.createContext({chrome:api,fetch,Date,Error,String,Array,Math,Number,Promise,setTimeout,clearTimeout,importScripts(){}});
  vm.runInContext(code,context);
  const send=payload=>new Promise(resolve=>{
    const ret=listeners.message(payload,{id:api.runtime.id},resolve);
    assert.equal(ret,true);
  });
  return {send,records,localRecords,history,getBadge:()=>badge,setHealthy:v=>healthy=v,setActiveBearer:v=>activeBearer=v,
    setNativeAvailable:v=>nativeAvailable=v,setNativeReply:v=>nativeReply=v,setNativeDelay:v=>nativeDelay=v,
    nativeCalls:()=>nativeCalls,listeners,context,drain:async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));}};
}
test("manifest narrow localhost plus opt-in ChatGPT content script",()=>{
 assert.equal(manifest.manifest_version,3);
 assert.deepEqual(manifest.permissions,["alarms","storage","sidePanel","tabs","scripting","nativeMessaging"]);
 assert.deepEqual(manifest.host_permissions,["http://127.0.0.1/*","https://chatgpt.com/*"]);
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
test("unavailable native host fails closed and leaves manual pairing available",async()=>{
 const h=harness();
 const result=await h.send({type:"COACH_PAIR_NATIVE"});
 assert.equal(result.ok,false);
 assert.match(result.message,/native_host_unavailable/);
 assert.equal(h.records.coachPairing,undefined);
 assert.equal(h.history.length,0);
 const manual=await h.send({type:"COACH_PAIR",port:8765,token});
 assert.equal(manual.ok,true);assert.equal(h.localRecords.coachNativePairingConsent,undefined);
});
test("first explicit native pairing consents to token-free startup recovery and rotation",async()=>{
 const h=harness();h.setNativeAvailable(true);
 h.localRecords.coachAutoRoutes={"ws-qa":{url:"https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc",enabled:true,tabId:42}};
 const result=await h.send({type:"COACH_PAIR_NATIVE"});
 assert.equal(result.ok,true);assert.equal(h.localRecords.coachNativePairingConsent,true);
 assert.equal(JSON.stringify(h.records).includes(token),true,"session pairing stores bearer only in memory storage");
 assert.equal(JSON.stringify(h.localRecords).includes(token),false,"persistent consent and routes contain no bearer");
 const replacement="B".repeat(43);h.setActiveBearer(replacement);h.setNativeReply(replacement);
 for(const startup of h.listeners.startup)startup();await new Promise(r=>setTimeout(r,20));await h.drain();
 assert.equal(h.records.coachPairing.token,replacement);
 assert.equal(h.localRecords.coachNativePairingConsent,true);
 assert.equal(h.localRecords.coachAutoRoutes["ws-qa"].enabled,true,"token rotation keeps prior explicit route consent");
 assert.equal(JSON.stringify(h.records.coachStatus||{}).includes(replacement),false);
 const polled="C".repeat(43);h.records.coachPairing=undefined;h.setActiveBearer(polled);h.setNativeReply(polled);
 for(const alarm of h.listeners.alarm)alarm({name:"coach-poll"});await new Promise(r=>setTimeout(r,20));await h.drain();
 assert.equal(h.records.coachPairing.token,polled,"bounded pairing poll recovers missing session credentials");
});
test("simultaneous native pairing requests share one host request",async()=>{
 const h=harness();h.setNativeAvailable(true);h.setNativeDelay(10);
 const both=await Promise.all([h.send({type:"COACH_PAIR_NATIVE"}),h.send({type:"COACH_PAIR_NATIVE"})]);
 assert.ok(both.every(x=>x.ok));assert.equal(h.nativeCalls(),1);
});
test("unpair cancels a native request already in progress",async()=>{
 const h=harness();h.setNativeAvailable(true);h.setNativeDelay(20);
 const pending=h.send({type:"COACH_PAIR_NATIVE"});
 await new Promise(r=>setTimeout(r,1));
 await h.send({type:"COACH_UNPAIR"});
 await pending;await new Promise(r=>setTimeout(r,25));
 assert.equal(h.records.coachPairing,undefined);
 assert.equal(h.localRecords.coachNativePairingConsent,undefined);
});
test("native host validates exact extension identity and reads only owner-only handoff",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"coach-native-host-"));
 try{
  const handoff=path.join(dir,"coach-current-pairing.json"),host=path.resolve(__dirname,"../src/coach-native-pairing-host.mjs");
  writeFileSync(handoff,JSON.stringify({port:8765,token} ),{mode:0o600});chmodSync(handoff,0o600);
  const request=Buffer.from(JSON.stringify({type:"get_pairing",extensionId:"bapcebjlgncogfpgbhllioaichcldkbl"})),head=Buffer.alloc(4);head.writeUInt32LE(request.length);
  const good=spawnSync(process.execPath,[host,handoff],{input:Buffer.concat([head,request])});
  const n=good.stdout.readUInt32LE(0),response=JSON.parse(good.stdout.subarray(4,4+n).toString());
  assert.equal(response.ok,true);assert.equal(response.token,token);
  const badReq=Buffer.from(JSON.stringify({type:"get_pairing",extensionId:"a".repeat(32)})),badHead=Buffer.alloc(4);badHead.writeUInt32LE(badReq.length);
  const bad=spawnSync(process.execPath,[host,handoff],{input:Buffer.concat([badHead,badReq])});
  const bn=bad.stdout.readUInt32LE(0),denied=JSON.parse(bad.stdout.subarray(4,4+bn).toString());
  assert.equal(denied.ok,false);assert.equal(bad.stdout.toString().includes(token),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("native host installer defaults to config stateDir and honors explicit custom path",async()=>{
 const {resolveStateDir}=await import("../scripts/install-coach-native-host.mjs");
 const home=path.join(os.tmpdir(),"devspace-home");
 assert.equal(resolveStateDir(undefined,home),path.join(home,".local","share","devspace"));
 assert.equal(resolveStateDir("/custom/devspace-state",home),"/custom/devspace-state");
});
test("native host installation uses stable owner-only files, rejects preexisting symlinks",async()=>{
 if(process.platform!=="darwin")return;
 const {installNativeHost}=await import("../scripts/install-coach-native-host.mjs");
 // macOS /var can be a symlink into /private/var; use a canonical
 // test home because the installer intentionally rejects symlinked roots.
 const home=fs.realpathSync(mkdtempSync(path.join(os.tmpdir(),"coach-host-install-")));
 try{
   const state=path.join(home,".local","share","devspace");
   mkdirSync(state,{recursive:true,mode:0o700});
   chmodSync(state,0o700);
   const installed=installNativeHost({home,stateDir:state});
   const host=fs.readFileSync(installed.installedHost,"utf8");
   const original=fs.readFileSync(path.resolve(__dirname,"../src/coach-native-pairing-host.mjs"),"utf8");
   assert.equal(host,original);
   const config=JSON.parse(fs.readFileSync(installed.manifestPath,"utf8"));
   assert.deepEqual(config.allowed_origins,["chrome-extension://bapcebjlgncogfpgbhllioaichcldkbl/"]);
   assert.equal(config.path,installed.launcher);
   assert.equal(fs.lstatSync(installed.installedHost).mode&0o777,0o600);
   assert.equal(fs.lstatSync(installed.manifestPath).mode&0o777,0o600);
   assert.equal(fs.lstatSync(installed.launcher).mode&0o777,0o700);
   assert.match(fs.readFileSync(installed.launcher,"utf8"),/coach-current-pairing\.json/);
   // Make a hostile manifest redirect: installer must refuse, not follow it.
   const other=path.join(home,"trap");writeFileSync(other,"untouched");
   fs.unlinkSync(installed.manifestPath);
   fs.symlinkSync(other,installed.manifestPath);
   assert.throws(()=>installNativeHost({home,stateDir:state}),/COACH_NATIVE_HOST_TARGET_UNSAFE/);
   assert.equal(fs.readFileSync(other,"utf8"),"untouched");
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("unpair clears native pairing consent, saved workspace routes, and session bearer",async()=>{
 const h=harness();
 h.records.coachPairing={port:8765,token};
 h.localRecords.coachNativePairingConsent=true;
 h.localRecords.coachAutoRoutes={"ws-qa":{url:"https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc",enabled:true,tabId:42}};
 const result=await h.send({type:"COACH_UNPAIR"});
 assert.equal(result.ok,true);
 assert.equal(h.records.coachPairing,undefined);
 for(const key of ["coachNativePairingConsent","coachAutoRoutes"])assert.equal(h.localRecords[key],undefined);
 assert.equal(h.localRecords.coachAutoRouteRevoked,true,
   "explicit unpair must persist a revoke marker even if an old callback restores a stale route");
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
 assert.equal(state.extensionId,"bapcebjlgncogfpgbhllioaichcldkbl");
 assert.equal(JSON.stringify(state).includes(token),false);
 const refresh=await h.send({type:"COACH_REFRESH"});
 assert.equal(refresh.events[0].operation_id,"real-event");
 const unpaired=await h.send({type:"COACH_UNPAIR"});
 assert.equal(unpaired.ok,true);
 assert.equal(h.records.coachPairing,undefined);
 assert.equal(h.getBadge(),"P");
});
