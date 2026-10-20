"use strict";
// Browser-session-only bearer pairing. ChatGPT delivery remains separately opt-in.
const KEY = "coachPairing";
const STATUS = "coachStatus";
const ALARM = "coach-poll";
const NATIVE_CONSENT = "coachNativePairingConsent";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;
let nativePairingPromise;
let nativePairingGeneration=0;

async function badge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}
async function pairing() {
  const record = await chrome.storage.session.get(KEY);
  return record[KEY] || null;
}
async function saveStatus(status) {
  await chrome.storage.session.set({ [STATUS]: status });
  await badge(status.online ? (status.pending ? String(Math.min(99, status.pending)) : "") :
    (status.paired ? "!" : "P"), status.paired ? "#285e97" : "#9a6b19");
}
async function feedCheck() {
  const pair = await pairing();
  if (!pair || !validPort(pair.port) || !TOKEN.test(pair.token)) {
    const status = { paired:false, online:false, pending:0, events:[], message:"pairing_required" };
    await saveStatus(status);
    return status;
  }
  try {
    const endpoint = "http://127.0.0.1:" + pair.port + "/events";
    const response = await fetch(endpoint, {
      method:"GET",cache:"no-store",headers:{ Authorization:"Bearer " + pair.token }
    });
    if (!response.ok) throw new Error("http_" + response.status);
    const body = await response.json();
    if (!Number.isSafeInteger(body.pending_count) || body.pending_count < 0 ||
        !Array.isArray(body.events) || body.events.length > 50) throw new Error("invalid_feed");
    const events = body.events.filter(e => Number.isSafeInteger(e.event_id) &&
      e.event_id > 0 && typeof e.operation_id === "string" &&
      e.operation_id.length <= 128 && e.event_type === "READY_FOR_GPT_REVIEW" &&
      typeof e.workspace_id==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(e.workspace_id)
    ).map(e => ({ event_id:e.event_id,operation_id:e.operation_id,workspace_id:e.workspace_id }));
    const status = { paired:true, online:true, pending:body.pending_count, events,
      port:pair.port, checkedAt:new Date().toISOString(), message:"connected" };
    await saveStatus(status); return status;
  } catch (err) {
    const status = { paired:true, online:false, pending:0, events:[], port:pair.port,
      checkedAt:new Date().toISOString(), message:String(err && err.message || "offline").slice(0,64) };
    await saveStatus(status); return status;
  }
}
async function observer(cursor=0) {
  const pair=await pairing();
  if(!pair||!validPort(pair.port)||!TOKEN.test(pair.token))
    return {paired:false,online:false,events:[],nextCursor:cursor,gap:0,reset:false};
  try {
    const r=await fetch("http://127.0.0.1:"+pair.port+"/agent/events?cursor="+encodeURIComponent(cursor),{
      method:"GET",cache:"no-store",headers:{Authorization:"Bearer "+pair.token}
    });
    if(!r.ok)throw new Error("offline");
    const b=await r.json();
    if(!Array.isArray(b.events)||b.events.length>100||
       !Number.isSafeInteger(b.nextCursor)||b.nextCursor<0||
       !Number.isSafeInteger(b.gap)||b.gap<0||typeof b.reset!=="boolean")
      throw new Error("invalid_feed");
    return {paired:true,online:true,events:b.events,nextCursor:b.nextCursor,gap:b.gap,reset:b.reset};
  } catch {return {paired:true,online:false,events:[],nextCursor:cursor,gap:0,reset:false};}
}
async function audit(workspaceId,operationId) {
  const pair=await pairing();
  if(!pair||!validPort(pair.port)||!TOKEN.test(pair.token))
    return {ok:false,error:"pairing_required"};
  const id=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  if(typeof workspaceId!=="string"||typeof operationId!=="string"||
     !id.test(workspaceId)||!id.test(operationId))
    return {ok:false,error:"invalid_scope"};
  try {
    const r=await fetch("http://127.0.0.1:"+pair.port+
      "/agent/audit?workspaceId="+encodeURIComponent(workspaceId)+
      "&operationId="+encodeURIComponent(operationId),{
        method:"GET",headers:{Authorization:"Bearer "+pair.token},cache:"no-store"
      });
    if(!r.ok)return {ok:false,error:"http_"+r.status};
    if(!(r.headers.get("content-type")||"").startsWith("application/json"))
      return {ok:false,error:"invalid_mime"};
    const raw=await r.text();
    if(raw.length>64*1024)return {ok:false,error:"oversized_audit"};
    const b=JSON.parse(raw),a=b?.snapshot;
    if(!a||a.version!==1||a.identity?.workspaceId!==workspaceId||
       a.identity?.operationId!==operationId||
       !["COMPLETED","FAILED","STOPPED","INTERRUPTED","UNKNOWN"].includes(a.status)||
       !Number.isSafeInteger(a.elapsedMs)||a.elapsedMs<0||
       !Number.isSafeInteger(a.confirmedToolStarts)||a.confirmedToolStarts<0||
       !Number.isSafeInteger(a.confirmedToolCompletions)||a.confirmedToolCompletions<0||
       !Array.isArray(a.observations)||a.observations.length>16||
       !a.dataCoverage||typeof a.dataCoverage.complete!=="boolean"||
       !Array.isArray(a.dataCoverage.missingEvidence)||a.dataCoverage.missingEvidence.length>24||
       !a.tokenUsage||typeof a.tokenUsage!=="object"||
       !Array.isArray(a.evidenceTimeline)||a.evidenceTimeline.length>120)
      return {ok:false,error:"invalid_audit"};
    return {ok:true,snapshot:a};
  } catch { return {ok:false,error:"offline"}; }
}
async function pairNow(port,token,generation=nativePairingGeneration) {
  if (!validPort(port) || typeof token !== "string" || !TOKEN.test(token)) {
    return { ok:false, message:"invalid_pairing_parameters" };
  }
  // Verify the provided bearer token BEFORE writing it to browser session storage.
  try {
    const resp = await fetch("http://127.0.0.1:" + port + "/health", {
      method:"GET",cache:"no-store",headers:{Authorization:"Bearer " + token}
    });
    if (!resp.ok) return {ok:false,message:"pairing_rejected_" + resp.status};
    const body = await resp.json();
    if (body.ok !== true || body.service !== "coach-feed") return {ok:false,message:"not_coach_feed"};
  } catch {
    return {ok:false,message:"bridge_unreachable"};
  }
  if(generation!==nativePairingGeneration)return {ok:false,message:"pairing_cancelled"};
  // Pairing only authenticates the feed. Workspace routes remain separately consented.
  await chrome.storage.session.set({[KEY]:{port,token}});
  const status=await feedCheck();
  return {ok:status.online,message:status.message};
}
async function requestNativePairing(explicit=false) {
  if(nativePairingPromise)return nativePairingPromise;
  const generation=nativePairingGeneration;
  nativePairingPromise=(async()=>{
    try {
      if(chrome.runtime.id!=="bapcebjlgncogfpgbhllioaichcldkbl")return {ok:false,message:"native_pairing_unavailable"};
      const host=chrome.runtime.connectNative("com.devspace.coach_pairing");
      const result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("native_host_unavailable")),5000);
        host.onMessage.addListener(value=>{clearTimeout(timer);resolve(value);});
        host.onDisconnect.addListener(()=>{clearTimeout(timer);reject(new Error("native_host_unavailable"));});
        host.postMessage({type:"get_pairing",extensionId:chrome.runtime.id});
      });
      if(!result?.ok || !validPort(result.port) || !TOKEN.test(result.token))return {ok:false,message:"native_pairing_unavailable"};
      if(generation!==nativePairingGeneration)return {ok:false,message:"pairing_cancelled"};
      const paired=await pairNow(result.port,result.token,generation);
      if(generation!==nativePairingGeneration)return {ok:false,message:"pairing_cancelled"};
      if(paired.ok)await chrome.storage.local.set({[NATIVE_CONSENT]:true});
      return paired;
    }catch{return {ok:false,message:"native_host_unavailable_use_manual_pairing"};}
  })();
  try{return await nativePairingPromise;}
  finally{nativePairingPromise=undefined;}
}
async function recoverNativePairing() {
  const consent=(await chrome.storage.local.get(NATIVE_CONSENT))[NATIVE_CONSENT]===true;
  const status=await feedCheck();
  if(consent&&!status.online)await requestNativePairing(false);
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM,{periodInMinutes:1});
  void recoverNativePairing();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM,{periodInMinutes:1});
  void recoverNativePairing();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if(alarm.name === ALARM) void recoverNativePairing();
});
chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if(message.type === "COACH_PAIR") {
    const generation=nativePairingGeneration;
    void pairNow(message.port,message.token,generation).then(sendResponse).catch(()=>sendResponse({ok:false,message:"internal_error"}));
    return true;
  }
  if(message.type === "COACH_PAIR_NATIVE") {
    void requestNativePairing(true).then(sendResponse);
    return true;
  }
  if(message.type === "COACH_REFRESH") {
    void feedCheck().then(sendResponse).catch(()=>sendResponse({paired:true,online:false,pending:0,events:[],message:"refresh_failed"}));
    return true;
  }
  if(message.type === "COACH_AGENT_EVENTS") { void observer(Number.isSafeInteger(message.cursor)?message.cursor:0).then(sendResponse).catch(()=>sendResponse({paired:true,online:false,events:[]})); return true; }
  if(message.type === "COACH_AGENT_AUDIT") { void audit(message.workspaceId,message.operationId).then(sendResponse).catch(()=>sendResponse({ok:false,error:"unavailable"})); return true; }
  if(message.type === "COACH_STATUS") {
    void chrome.storage.session.get(STATUS).then(o =>
      sendResponse({extensionId:chrome.runtime.id,status:o[STATUS]||{paired:false,online:false,pending:0,events:[]}})
    );
    return true;
  }
  if(message.type === "COACH_UNPAIR") {
    nativePairingGeneration++;
    // Immediately invalidate in-flight asynchronous route restoration before
    // asynchronously revoking the bearer and persistent grants.
    if(typeof autoRouteMutationEpoch==="number")autoRouteMutationEpoch++;
    void (async()=>{
      try {
        await chrome.storage.local.set({coachAutoRouteRevoked:true});
        await chrome.storage.session.remove(KEY);
        await chrome.storage.session.remove("coachAutoTarget");
        await chrome.storage.local.remove([NATIVE_CONSENT,"coachAutoRoutes"]);
        await feedCheck();
        return {ok:true};
      }catch{return {ok:false,message:"unpair_incomplete"};}
    })().then(sendResponse);
    return true;
  }
  return false;
});
importScripts("auto-worker.js");
