"use strict";
// The sidecar bearer remains in session storage; only event identities are persisted.
// Stored "in_flight" is deliberately NOT retried after a worker/browser crash.
const AUTO_SESSION = "coachAutoTarget";
const AUTO_LEDGER = "coachAutoLedger";
const AUTO_ALARM = "coach-auto-delivery";
const AUTO_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AUTO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
let autoBusy = false;

function autoCanonical(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "chatgpt.com" || u.port ||
        !/^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9_-]{8,128}\/?$/.test(u.pathname)) return null;
    return u.origin + u.pathname.replace(/\/$/,"");
  } catch { return null; }
}
async function autoTarget() {
  return (await chrome.storage.session.get(AUTO_SESSION))[AUTO_SESSION] || null;
}
async function autoLedger() {
  const value = (await chrome.storage.local.get(AUTO_LEDGER))[AUTO_LEDGER];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function autoSaveLedger(ledger) {
  await chrome.storage.local.set({[AUTO_LEDGER]: ledger});
}
function autoKey(e) {return (e.workspace_id||"unknown") + ":" + e.operation_id + ":" + e.event_id;}
function autoValid(e) {
  return e && e.event_type === "READY_FOR_GPT_REVIEW" &&
    Number.isSafeInteger(e.event_id) && e.event_id > 0 &&
    (e.workspace_id===undefined || (typeof e.workspace_id === "string" && AUTO_ID.test(e.workspace_id))) &&
    typeof e.operation_id === "string" && AUTO_ID.test(e.operation_id);
}
function autoInstruction(e) {
  return "请以 Web GPT Coach 身份独立审核一项本地 Codex CLI 已完成任务。"+
  "通过 DevSpace MCP 读取真实源码、Git 差异、不可变完成证据和测试结果，不要重复运行该 Codex 任务；"+
  "验证之后仅作 APPROVED / REWORK / BLOCKED 裁决，并在 REWORK 时下发具体修复任务。"+
  "这是审核通知，不代表已经通过验收。"+
  "\n事件 ID："+e.event_id+"\n工作区 ID："+(e.workspace_id||"旧版 Sidecar 未返回；请通过 DevSpace MCP 按任务 ID 查证，若无法唯一匹配则停止") + "\n任务 ID："+e.operation_id;
}
async function autoState() {
  const target=await autoTarget(), ledger=await autoLedger();
  const summary={pending:0,sent:0,needs_attention:0,in_flight:0};
  for(const x of Object.values(ledger))if(x && summary[x.state]!==undefined)summary[x.state]++;
  const recent=Object.entries(ledger).slice(-10).reverse()
    .map(([key,x])=>({key,state:x.state,at:x.at||"",reason:x.reason||""}));
  return {enabled:!!target?.enabled, bound:!!target?.url, url:target?.url||"",
    tabId:target?.tabId??null,summary,recent};
}
async function autoBind() {
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs?.[0];
  const url=autoCanonical(tab?.url);
  if(!Number.isSafeInteger(tab?.id)||!url) return {ok:false,error:"请先打开一个具体的 ChatGPT Coach 对话"};
  await chrome.storage.session.set({[AUTO_SESSION]:{url,tabId:tab.id,enabled:false}});
  return {ok:true,state:await autoState()};
}
async function autoToggle(enabled) {
  const t=await autoTarget();
  if(!t?.url || !Number.isSafeInteger(t?.tabId)) return {ok:false,error:"请先绑定对话"};
  if(enabled) {
    const tab=await chrome.tabs.get(t.tabId).catch(()=>null);
    if(autoCanonical(tab?.url)!==t.url) return {ok:false,error:"原对话标签页已关闭或导航"};
  }
  await chrome.storage.session.set({[AUTO_SESSION]:{...t,enabled:!!enabled}});
  if(enabled) void autoPump();
  return {ok:true,state:await autoState()};
}
async function autoUnbind() {
  await chrome.storage.session.remove(AUTO_SESSION);
  return {ok:true,state:await autoState()};
}
async function autoResolve(key,action) {
  const ledger=await autoLedger(),r=ledger[key];
  if(!r||r.state!=="needs_attention") return {ok:false,error:"仅可处理待人工核实记录"};
  if(action==="mark_sent") ledger[key]={...r,state:"sent",reason:"人工确认已发送",at:new Date().toISOString()};
  else if(action==="retry") ledger[key]={...r,state:"pending",reason:"人工核实未发送后重试",at:new Date().toISOString()};
  else return {ok:false,error:"invalid_action"};
  await autoSaveLedger(ledger);
  if(action==="retry")void autoPump();
  return {ok:true,state:await autoState()};
}
async function autoPump() {
  if(autoBusy)return;
  autoBusy=true;
  try {
    const target=await autoTarget();
    if(!target?.enabled || !autoCanonical(target.url) || !Number.isSafeInteger(target.tabId))return;
    const pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
    if(!pair || !Number.isInteger(pair.port) || pair.port<1 || pair.port>65535 ||
       !AUTO_TOKEN.test(pair.token))return;
    const tab=await chrome.tabs.get(target.tabId).catch(()=>null);
    if(autoCanonical(tab?.url)!==target.url)return; // wrong tab never receives instructions
    const response=await fetch("http://127.0.0.1:"+pair.port+"/events",{
      method:"GET",cache:"no-store",headers:{Authorization:"Bearer "+pair.token}
    });
    if(!response.ok)return;
    const body=await response.json();
    // /events is capped at 50. An incomplete page cannot prove queue completeness.
    // Halt rather than incorrectly treating a partial queue as fully delivered.
    if(!Array.isArray(body.events)||body.events.length>50 ||
       !Number.isSafeInteger(body.pending_count) ||
       body.pending_count < body.events.length || body.pending_count>body.events.length)return;
    const ledger=await autoLedger();
    // In-flight from a prior service-worker lifetime is an unknown outcome.
    for(const [k,r] of Object.entries(ledger)) {
      if(r?.state==="in_flight")ledger[k]={...r,state:"needs_attention",
        at:new Date().toISOString(),reason:"上次投递结果不确定，禁止自动重发"};
    }
    const events=body.events.filter(autoValid).sort((a,b)=>a.event_id-b.event_id);
    for(const e of events) {
      const key=autoKey(e);
      if(!ledger[key] && Object.keys(ledger).length<2048)
        ledger[key]={state:"pending",at:new Date().toISOString(),reason:""};
    }
    await autoSaveLedger(ledger);
    // Never silently truncate deduplication history; manual maintenance is required.
    if(events.some(e=>!ledger[autoKey(e)]))return;
    // Unresolved unknown delivery stops automatic progression, to avoid duplicates.
    if(Object.values(ledger).some(x=>x.state==="needs_attention"))return;
    const candidate=events.find(e=>ledger[autoKey(e)]?.state==="pending");
    if(!candidate)return;
    const key=autoKey(candidate);
    ledger[key]={state:"in_flight",at:new Date().toISOString(),reason:"正在发送"};
    await autoSaveLedger(ledger); // durable BEFORE any DOM action
    // User may have paused or rebound while the network query was in flight.
    const latest=await autoTarget();
    const latestTab=await chrome.tabs.get(target.tabId).catch(()=>null);
    if(!latest?.enabled || latest.tabId!==target.tabId || latest.url!==target.url ||
       autoCanonical(latestTab?.url)!==target.url) {
      ledger[key]={state:"pending",at:new Date().toISOString(),reason:"绑定会话或授权已变化，取消发送"};
      await autoSaveLedger(ledger);
      return;
    }
    let result=null;
    try {
      result=await chrome.tabs.sendMessage(target.tabId,{
        type:"COACH_AUTO_DELIVER",url:target.url,instruction:autoInstruction(candidate)
      });
    }catch{result={ok:false,uncertain:true,reason:"内容脚本不可达"};}
    // Re-read durable state: user may have disabled/unbound while DOM action ran.
    const current=await autoLedger();
    if(current[key]?.state!=="in_flight")return;
    current[key]={state:result?.ok===true && result?.submitted===true ? "sent":"needs_attention",
      at:new Date().toISOString(),
      reason:result?.ok===true && result?.submitted===true ?
      "DOM 已提交（尚不代表 Web GPT 审核完成）":
      String(result?.reason||"DOM 结果不确定，需人工检查").slice(0,120)};
    await autoSaveLedger(current);
  }catch{
    // In-flight marker remains durable and will become needs_attention on next poll.
  }finally{autoBusy=false;}
}
chrome.runtime.onInstalled.addListener(()=>chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5}));
chrome.runtime.onStartup.addListener(()=>chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5}));
chrome.alarms.onAlarm.addListener(a=>{if(a.name===AUTO_ALARM)void autoPump();});
// Leaving the selected chat revokes the active send grant, even if the user navigates back.
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(!change.url)return;
  void autoTarget().then(t=>{
    if(t?.tabId===tabId && autoCanonical(change.url)!==t.url)
      return chrome.storage.session.set({[AUTO_SESSION]:{...t,enabled:false}});
  });
});
chrome.tabs.onRemoved.addListener(tabId=>{
  void autoTarget().then(t=>{
    if(t?.tabId===tabId)return chrome.storage.session.remove(AUTO_SESSION);
  });
});
chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
  const tasks={
    COACH_AUTO_STATUS:()=>autoState().then(state=>({ok:true,state})),
    COACH_AUTO_BIND:autoBind,
    COACH_AUTO_ENABLE:()=>autoToggle(true),
    COACH_AUTO_PAUSE:()=>autoToggle(false),
    COACH_AUTO_UNBIND:autoUnbind,
    COACH_AUTO_PUMP:async()=>{await autoPump();return {ok:true,state:await autoState()};},
    COACH_AUTO_RESOLVE:()=>autoResolve(msg.key,msg.action)
  };
  if(!msg||typeof msg.type!=="string"||!tasks[msg.type])return false;
  void tasks[msg.type]().then(reply).catch(e=>reply({ok:false,error:String(e.message||"internal_error").slice(0,100)}));
  return true;
});
