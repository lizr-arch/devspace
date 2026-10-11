"use strict";
// Browser-session-only bearer pairing. No content scripts or ChatGPT automation.
const KEY = "coachPairing";
const STATUS = "coachStatus";
const ALARM = "coach-poll";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

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
      e.operation_id.length <= 128 && e.event_type === "READY_FOR_GPT_REVIEW"
    ).map(e => ({ event_id:e.event_id,operation_id:e.operation_id }));
    const status = { paired:true, online:true, pending:body.pending_count, events,
      port:pair.port, checkedAt:new Date().toISOString(), message:"connected" };
    await saveStatus(status); return status;
  } catch (err) {
    const status = { paired:true, online:false, pending:0, events:[], port:pair.port,
      checkedAt:new Date().toISOString(), message:String(err && err.message || "offline").slice(0,64) };
    await saveStatus(status); return status;
  }
}
async function pairNow(port,token) {
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
  await chrome.storage.session.set({[KEY]:{port,token}});
  const status=await feedCheck();
  return {ok:status.online,message:status.message};
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM,{periodInMinutes:1});
  void feedCheck();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM,{periodInMinutes:1});
  void feedCheck();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if(alarm.name === ALARM) void feedCheck();
});
chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if(message.type === "COACH_PAIR") {
    void pairNow(message.port,message.token).then(sendResponse).catch(()=>sendResponse({ok:false,message:"internal_error"}));
    return true;
  }
  if(message.type === "COACH_REFRESH") {
    void feedCheck().then(sendResponse).catch(()=>sendResponse({paired:true,online:false,pending:0,events:[],message:"refresh_failed"}));
    return true;
  }
  if(message.type === "COACH_STATUS") {
    void chrome.storage.session.get(STATUS).then(o =>
      sendResponse({extensionId:chrome.runtime.id,status:o[STATUS]||{paired:false,online:false,pending:0,events:[]}})
    );
    return true;
  }
  if(message.type === "COACH_UNPAIR") {
    void chrome.storage.session.remove(KEY).then(feedCheck).then(() => sendResponse({ok:true}));
    return true;
  }
  return false;
});
