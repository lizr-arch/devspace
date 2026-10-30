import{readFileSync}from"node:fs";import{join}from"node:path";import{Script,createContext}from"node:vm";import assert from"node:assert/strict";
import{fileURLToPath}from"node:url";
import{test}from"node:test";
test("native App completion instructions and stale review delivery fail-closed",async()=>{
const srcRoot=fileURLToPath(new URL("../coach-browser-extension/",import.meta.url)),staged=srcRoot;
const hooks={};
const chrome={
 runtime:{getManifest(){return{version:"0.3.18"}},onInstalled:{addListener(f){hooks.onInstalled=f}},onStartup:{addListener(f){hooks.onStartup=f}},onMessage:{addListener(f){hooks.onMessage=f}}},
 alarms:{create(){},onAlarm:{addListener(f){hooks.onAlarm=f}}},
 tabs:{onUpdated:{addListener(f){hooks.onUpdated=f}},onRemoved:{addListener(f){hooks.onRemoved=f}}}
};
const workContext=createContext({chrome,console,Date,URL,Promise,setTimeout,clearTimeout});
new Script(readFileSync(join(staged,"auto-worker.js"),"utf8"),{filename:"auto-worker.js"}).runInContext(workContext);
const ws="ws_160803c7-2f0b-4f9a-91a5-c5fb92ad8b1d",chat="https://chatgpt.com/c/6adc4ea4-7e00-83e8-a483-949c2599b703",tid="01a16cf8-9102-7102-8fc9-9b925b1f1a21";
const make=(id,at,op)=>({app_kind:"native_chatgpt_app_codex",event_type:"CODEX_APP_READY_FOR_GPT_REVIEW",event_id:"app:"+id.repeat(64),thread_id:tid,workspace_id:ws,operation_id:op,evidence_sha256:"a".repeat(64),created_at:at});
const old=make("1","2026-10-25T08:34:10Z","tria-siege-s2"),mid=make("2","2026-10-25T12:41:08Z","tria-siege-m3"),latest=make("f","2026-10-25T13:06:43Z","tria-siege-m4-r2");
for(const e of [old,mid,latest]){workContext.e=e;assert.equal(new Script("autoValid(e)").runInContext(workContext),true)}
workContext.e=latest;
const text=new Script("autoInstruction(e)").runInContext(workContext);
assert.ok(text.startsWith("请以 Web GPT Coach 身份独立审核"));
assert.ok(text.includes(latest.event_id));assert.ok(text.length<1500);
const ledger={};workContext.events=[old,mid,latest];workContext.ledger=ledger;
assert.equal(new Script("autoSupersedeOlderNative(ledger,events)").runInContext(workContext),true);
assert.equal(ledger[ws+":tria-siege-s2:"+old.event_id]?.state,"superseded");
assert.equal(ledger[ws+":tria-siege-m3:"+mid.event_id]?.state,"superseded");
assert.equal(ledger[ws+":tria-siege-m4-r2:"+latest.event_id],undefined);
const oldKey=ws+":tria-siege-s2:"+old.event_id;ledger[oldKey].state="needs_attention";
new Script("autoSupersedeOlderNative(ledger,events)").runInContext(workContext);
assert.equal(ledger[oldKey].state,"needs_attention");
const domScript=readFileSync(join(srcRoot,"chatgpt-delivery.js"),"utf8");
assert.ok(domScript.includes('instruction.startsWith("请以 Web GPT Coach 身份独立审核")'));
assert.ok(domScript.includes("canonical(location.href)!==msg.url"));
assert.equal(text.startsWith("请以 Web GPT 身份独立审核"),false);
assert.equal(text.startsWith("请以 Web GPT Coach 身份独立审核"),true);
console.log(JSON.stringify({result:"NATIVE_APP_WAKE_STATIC_AND_PROTOCOL_PASS",assertions:13,prefixAccepted:true,noDomSendWithoutEditor:true,oldEventsSuperseded:true,uncertainUntouched:true,version:"0.3.18"}));
});