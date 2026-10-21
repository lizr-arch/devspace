"use strict";
// The sidecar bearer remains in session storage; only event identities are persisted.
// Stored "in_flight" is deliberately NOT retried after a worker/browser crash.
const AUTO_SESSION = "coachAutoRoutes";
const AUTO_LEDGER = "coachAutoLedger";
const AUTO_REVOKED = "coachAutoRouteRevoked";
const AUTO_ALARM = "coach-auto-delivery";
// Incremented synchronously when a grant changes: old async tab lookups
// cannot resurrect a previous grant after explicit unbind or unpair.
let autoRouteMutationEpoch=0;
const AUTO_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AUTO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
let autoBusy = false;
const AUTO_LAST_CHECK = "coachAutoLastCheck";
const AUTO_BIND_PENDING = "coachAutoPendingBinds";
const autoVersion = () => chrome.runtime.getManifest?.()?.version || "unknown";
async function autoRecordCheck(code,message) {
  await chrome.storage.session.set({[AUTO_LAST_CHECK]:{
    code,message,at:new Date().toISOString()
  }});
}

function autoCanonical(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "chatgpt.com" || u.port ||
        !/^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9_-]{8,128}\/?$/.test(u.pathname)) return null;
    return u.origin + u.pathname.replace(/\/$/,"");
  } catch { return null; }
}
async function autoTarget() {
  // A persistent revoke marker dominates any legacy or in-flight route write.
  // It is cleared only by a fresh explicit conversation bind.
  if((await chrome.storage.local.get(AUTO_REVOKED))[AUTO_REVOKED]===true)return {};
  return (await chrome.storage.local.get(AUTO_SESSION))[AUTO_SESSION] || {};
}
async function autoLedger() {
  const value = (await chrome.storage.local.get(AUTO_LEDGER))[AUTO_LEDGER];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function autoSaveLedger(ledger) {
  await chrome.storage.local.set({[AUTO_LEDGER]: ledger});
}
function autoKey(e) {return (e.workspace_id||"unknown") + ":" + e.operation_id + ":" + e.event_id;}
// The legacy Sidecar omitted workspace_id. Reconcile identities only after a
// trusted feed supplies the exact same (operation_id, event_id) pair.
// Keep a "merged" audit marker, never silently discard a prior send outcome.
function autoReconcileLegacy(ledger,events) {
  let changed=false;
  for(const e of events) {
    if(!e.workspace_id)continue;
    const oldKey="unknown:"+e.operation_id+":"+e.event_id;
    const newKey=autoKey(e);
    const old=ledger[oldKey];
    if(!old || old.state==="merged" || oldKey===newKey)continue;
    const present=ledger[newKey];
    const risk={"pending":0,"sent":1,"in_flight":2,"needs_attention":3};
    const normalize=x=>x?.state==="in_flight" ?
      {...x,state:"needs_attention",reason:"旧版记录投递结果不确定，请核实"}:x;
    const a=normalize(old), b=normalize(present);
    const winning= !b || (risk[a.state]??3)>(risk[b.state]??3)?a:b;
    ledger[newKey]={...winning,at:winning?.at||new Date().toISOString(),
      reason:winning?.reason||"由旧版无工作区事件记录安全归并"};
    ledger[oldKey]={...old,state:"merged",mergedInto:newKey,
      reason:"旧版标识已归并；原状态："+old.state};
    changed=true;
  }
  return changed;
}
// Passive, exact identity-only migration: no network, no DOM or message send.
// A stored scoped key is already evidence of the same trusted Sidecar identity.
// Ambiguous matches across workspaces stay untouched.
function autoReconcileStored(ledger) {
  const records=Object.keys(ledger);
  const events=[];
  for(const key of records) {
    const m=/^unknown:(.+):([1-9][0-9]*)$/.exec(key);
    if(!m || ledger[key]?.state==="merged")continue;
    const suffix=":"+m[1]+":"+m[2];
    const scoped=records.filter(k=>k!==key&&!k.startsWith("unknown:")&&
      k.endsWith(suffix)&&ledger[k]?.state!=="merged");
    if(scoped.length!==1)continue;
    const workspace=scoped[0].slice(0,-suffix.length);
    if(!AUTO_ID.test(workspace))continue;
    events.push({workspace_id:workspace,operation_id:m[1],event_id:Number(m[2])});
  }
  return autoReconcileLegacy(ledger,events);
}
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
  "请先查询 coach_realtime_status：若当前任务属于 reviewerMode=webgpt 的已批准自动计划，"+
  "必须使用 coach_webgpt_submit_review 提交有证据的裁决与具体原因，由本地调度器安全推进；"+
  "否则使用原有 codex_agent_submit_review。严禁仅输出裁决文字而不写回。"+
  "这是审核通知，不代表已经通过验收。"+
  "\n事件 ID："+e.event_id+"\n工作区 ID："+(e.workspace_id||"旧版 Sidecar 未返回；请通过 DevSpace MCP 按任务 ID 查证，若无法唯一匹配则停止") + "\n任务 ID："+e.operation_id;
}
async function autoState() {
  const routes=await autoTarget(), entries=Object.entries(routes), ledger=await autoLedger();
  if(autoReconcileStored(ledger))await autoSaveLedger(ledger);
  const lastCheck=(await chrome.storage.session.get(AUTO_LAST_CHECK))[AUTO_LAST_CHECK]||null;
  const summary={pending:0,sent:0,needs_attention:0,in_flight:0,receipt_pending:0};
  for(const x of Object.values(ledger)) {
    if(x && summary[x.state]!==undefined)summary[x.state]++;
    if(x?.state==="sent" && x.receiptState==="pending")summary.receipt_pending++;
  }
  const recent=Object.entries(ledger).filter(([,x])=>x?.state!=="merged")
    .slice(-10).reverse()
    .map(([key,x])=>({key,state:x.state,at:x.at||"",reason:x.reason||""}));
  return {enabled:entries.some(([,route])=>!!route?.enabled), bound:entries.length>0,
    url:entries.length===1?entries[0][1]?.url||"":entries.length?entries.length+" 个工作区对话已绑定":"",
    routes:entries.map(([workspaceId,route])=>({workspaceId,url:route?.url||"",enabled:!!route?.enabled,tabReady:Number.isSafeInteger(route?.tabId)})),
    version:autoVersion(),lastCheck,
    pendingBinding:Object.values((await chrome.storage.session.get(AUTO_BIND_PENDING))[AUTO_BIND_PENDING]||{}),
    blocking:summary.needs_attention>0 ?
      "有 "+summary.needs_attention+" 条发送结果待人工核实；只暂停关联工作区，不重发不确定消息":""
    ,summary,recent};
}
async function autoBind(workspaceId) {
  if(typeof workspaceId!=="string"||!AUTO_ID.test(workspaceId))return {ok:false,error:"请输入精确工作区 ID"};
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs?.[0];
  const url=autoCanonical(tab?.url);
  if(!Number.isSafeInteger(tab?.id)||!url) return {ok:false,error:"请先打开一个具体的 ChatGPT Coach 对话"};
  const routes=await autoTarget();
  // A Coach conversation belongs to exactly one explicitly authorized
  // workspace. Reusing it would mix unrelated projects' review histories.
  if(Object.entries(routes).some(([id,r])=>id!==workspaceId&&autoCanonical(r?.url)===url))
    return {ok:false,error:"该 ChatGPT 对话已绑定另一个工作区，请选择独立对话"};
  await autoCancelPendingByUrl(url);
  autoRouteMutationEpoch++;
  routes[workspaceId]={url,tabId:tab.id,enabled:false};
  await chrome.storage.local.set({[AUTO_SESSION]:routes,[AUTO_REVOKED]:false});
  return {ok:true,state:await autoState()};
}
async function autoToggle(enabled,requestedWorkspaceId) {
  const routes=await autoTarget(),workspaceId=requestedWorkspaceId|| (Object.keys(routes).length===1?Object.keys(routes)[0]:null);
  const t=workspaceId?routes[workspaceId]:null;
  if(!t?.url || !Number.isSafeInteger(t?.tabId)) return {ok:false,error:"需先绑定唯一工作区对话"};
  if(enabled) {
    const tab=await chrome.tabs.get(t.tabId).catch(()=>null);
    if(autoCanonical(tab?.url)!==t.url) return {ok:false,error:"原对话标签页已关闭或导航"};
  }
  autoRouteMutationEpoch++;
  routes[workspaceId]={...t,enabled:!!enabled};await chrome.storage.local.set({[AUTO_SESSION]:routes});
  if(enabled) void autoPump();
  return {ok:true,state:await autoState()};
}
// Exactly one user click starts a challenge; the extension cannot infer a
// DevSpace workspace from the ChatGPT tab. Web GPT must claim it over MCP.
async function autoOneClick() {
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs?.[0],url=autoCanonical(tab?.url);
  if(!Number.isSafeInteger(tab?.id)||!url)return {ok:false,error:"请在具体的 ChatGPT 对话中点击一键启用"};
  const existing=await autoTarget();
  if(Object.values(existing).some(route=>autoCanonical(route?.url)===url))
    return {ok:false,error:"此对话已经绑定工作区，请查看现有状态，不要重复绑定"};
  const pendingMap=(await chrome.storage.session.get(AUTO_BIND_PENDING))[AUTO_BIND_PENDING]||{};
  if(Object.values(pendingMap).some(p=>p?.url===url))
    return {ok:false,error:"此对话已有绑定请求等待确认，不得重复发送"};
  if(Object.keys(pendingMap).length>=8)
    return {ok:false,error:"已有八条绑定请求在等待确认，请稍后再试"};
  let pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
  if(!pair||!Number.isInteger(pair.port)||!AUTO_TOKEN.test(pair.token)) {
    const paired=await requestNativePairing(true);
    if(!paired.ok)return {ok:false,error:"本机安全配对失败："+paired.message};
    pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
  }
  if(!pair||!AUTO_TOKEN.test(pair.token))return {ok:false,error:"没有有效的 Sidecar 配对"};
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  const nonce=[...bytes].map(n=>n.toString(16).padStart(2,"0")).join("");
  const response=await fetch("http://127.0.0.1:"+pair.port+"/bind/start",{
    method:"POST",cache:"no-store",
    headers:{Authorization:"Bearer "+pair.token,"Content-Type":"application/json"},
    body:JSON.stringify({nonce,url})
  }).catch(()=>null);
  if(!response?.ok)return {ok:false,error:"Sidecar 尚不支持一键绑定或无法连接"};
  pendingMap[nonce]={nonce,url,tabId:tab.id,createdAt:Date.now(),port:pair.port};
  // A fresh explicit click authorizes this challenge even after prior unbind.
  autoRouteMutationEpoch++;
  await chrome.storage.local.set({[AUTO_REVOKED]:false});
  await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
  // Fresh isolated-world binding handler. Old audit content scripts cannot
  // answer this protocol. No chat history is inspected.
  try {
    await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:false},files:["chatgpt-binding.js"]});
    const prompt="DevSpace Coach 一键绑定请求（由当前对话中的用户点击扩展发起）。"+
      "请使用 DevSpaceMac MCP，先确定你正在管理的精确 workspaceId，"+
      "然后调用 coach_webgpt_claim_browser_route 工具：nonce="+nonce+
      "；url="+url+"。仅当此对话确实已经授权该工作区时才执行，不要猜测、不要使用其他对话的工作区。"+
      "工具返回 claimed=true 后告知用户绑定确认；无需复制任何密钥。";
    const delivered=await chrome.tabs.sendMessage(tab.id,{
      type:"COACH_BIND_REQUEST_V1",url,instruction:prompt
    });
    if(delivered?.ok!==true||delivered.submitted!==true) {
      if(delivered?.notSubmitted===true){
        delete pendingMap[nonce];
        await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
      }
      return {ok:false,error:"绑定请求未确认提交；请先检查目标对话，不会自动重发"};
    }
    return {ok:true,message:"已向当前对话发送绑定请求，等待 Web GPT 独立确认",pending:true};
  } catch {
    return {ok:false,error:"绑定消息投递结果不确定；请检查对话，禁止自动重试"};
  }
}
async function autoBindPoll() {
  const pendingMap=(await chrome.storage.session.get(AUTO_BIND_PENDING))[AUTO_BIND_PENDING]||{};
  const requests=Object.entries(pendingMap);
  if(!requests.length)return {ok:true,state:"idle"};
  const pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
  if(!pair||!AUTO_TOKEN.test(pair.token))
    return {ok:false,error:"等待绑定期间本机配对已失效"};
  const epoch=autoRouteMutationEpoch;
  const routes=await autoTarget();
  let changedRoutes=false,changedPending=false,claimedCount=0;
  for(const [nonce,pending] of requests) {
    if(Date.now()-pending.createdAt>600_000){
      delete pendingMap[nonce];changedPending=true;continue;
    }
    if(pair.port!==pending.port)continue;
    const resp=await fetch("http://127.0.0.1:"+pair.port+
      "/bind/status?nonce="+nonce,{
      method:"GET",cache:"no-store",headers:{Authorization:"Bearer "+pair.token}
    }).catch(()=>null);
    if(!resp?.ok)continue;
    const data=await resp.json().catch(()=>null);
    if(data?.state!=="claimed")continue;
    if(!AUTO_ID.test(data.workspaceId)||data.url!==pending.url)continue;
    const tab=await chrome.tabs.get(pending.tabId).catch(()=>null);
    if(autoCanonical(tab?.url)!==pending.url)continue;
    if(Object.entries(routes).some(([id,r])=>
      id!==data.workspaceId&&autoCanonical(r?.url)===pending.url))continue;
    if(routes[data.workspaceId]&&routes[data.workspaceId].url!==pending.url)continue;
    routes[data.workspaceId]={url:pending.url,tabId:pending.tabId,enabled:true};
    delete pendingMap[nonce];changedRoutes=true;changedPending=true;claimedCount++;
  }
  if(epoch!==autoRouteMutationEpoch ||
     (await chrome.storage.local.get(AUTO_REVOKED))[AUTO_REVOKED]===true)
    return {ok:false,error:"绑定授权已被修改或撤销，拒绝使用过期确认"};
  if(changedRoutes){
    autoRouteMutationEpoch++;
    await chrome.storage.local.set({[AUTO_SESSION]:routes,[AUTO_REVOKED]:false});
  }
  if(changedPending)await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
  return {ok:true,state:claimedCount?"bound":"pending",claimedCount};
}
async function autoCancelPendingByUrl(url) {
  const requests=(await chrome.storage.session.get(AUTO_BIND_PENDING))[AUTO_BIND_PENDING]||{};
  let changed=false;
  for(const [nonce,req] of Object.entries(requests)) {
    if(req?.url===url){delete requests[nonce];changed=true;}
  }
  if(changed)await chrome.storage.session.set({[AUTO_BIND_PENDING]:requests});
  return changed;
}
async function autoCancelPendingForCurrentTab() {
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const url=autoCanonical(tabs?.[0]?.url);
  if(!url)return {ok:false,error:"请先打开需要取消请求的 ChatGPT 对话"};
  autoRouteMutationEpoch++;
  const cancelled=await autoCancelPendingByUrl(url);
  return {ok:true,cancelled,state:await autoState()};
}
// Serializes writes to the challenge map across simultaneous popup clicks and
// background polls; different ChatGPT tabs still progress independently.
let autoBindingQueue=Promise.resolve();
function autoWithBindLock(fn){
  const turn=autoBindingQueue.then(fn);
  autoBindingQueue=turn.catch(()=>{});
  return turn;
}
async function autoUnbind(requestedWorkspaceId) {
  const routes=await autoTarget();
  const workspaceId=requestedWorkspaceId||
    (Object.keys(routes).length===1?Object.keys(routes)[0]:null);
  if(!workspaceId||!routes[workspaceId])
    return {ok:false,error:"请指定要解除的工作区；不会清除其他工作区的绑定"};
  autoRouteMutationEpoch++;
  delete routes[workspaceId];
  if(Object.keys(routes).length) {
    await chrome.storage.local.set({[AUTO_SESSION]:routes,[AUTO_REVOKED]:false});
  } else {
    await chrome.storage.local.set({[AUTO_REVOKED]:true});
    await chrome.storage.local.remove(AUTO_SESSION);
  }
  return {ok:true,state:await autoState()};
}
async function autoResolveRoutes(){
  const epoch=autoRouteMutationEpoch;
  const routes=await autoTarget();let changed=false;
  for(const [workspaceId,target] of Object.entries(routes)){
    if(!target?.url||!autoCanonical(target.url))continue;
    const matches=(await chrome.tabs.query({url:target.url+"*"})).filter(t=>autoCanonical(t.url)===target.url);
    // Preserve the explicitly selected tab even if a second tab opens the same
    // conversation. Never choose arbitrarily when the original tab is gone.
    const pinned=matches.find(t=>t.id===target.tabId);
    const selected=pinned||(matches.length===1?matches[0]:null);
    const next={...target,tabId:selected&&Number.isSafeInteger(selected.id)?selected.id:null};
    if(next.tabId!==target.tabId){routes[workspaceId]=next;changed=true;}
  }
  if(changed && epoch===autoRouteMutationEpoch &&
     (await chrome.storage.local.get(AUTO_REVOKED))[AUTO_REVOKED]!==true)
    await chrome.storage.local.set({[AUTO_SESSION]:routes});
}
// Chrome declarative content scripts do not attach to tabs opened before an
// extension reload. A read-only ping checks readiness BEFORE any submit command.
async function autoReady(tabId,url) {
  const ping=async()=>{
    try {
      const ready=await chrome.tabs.sendMessage(tabId,{type:"COACH_AUTO_PING_V5"});
      return ready?.ok===true && ready.protocol===5 && ready.url===url;
    } catch { return false; }
  };
  if(await ping())return {ok:true};
  const before=await chrome.tabs.get(tabId).catch(()=>null);
  if(autoCanonical(before?.url)!==url)
    return {ok:false,reason:"对话标签页已变化，未发送"};
  try {
    await chrome.scripting.executeScript({
      target:{tabId,allFrames:false},
      files:["chatgpt-delivery.js"]
    });
  } catch {
    return {ok:false,reason:"内容脚本注入失败，请检查 ChatGPT 网站权限"};
  }
  const after=await chrome.tabs.get(tabId).catch(()=>null);
  if(autoCanonical(after?.url)!==url)
    return {ok:false,reason:"脚本加载期间标签页发生变化，未发送"};
  if(!await ping())
    return {ok:false,reason:"内容脚本加载后仍不可达，未发送"};
  return {ok:true};
}
async function autoResolve(key,action) {
  const ledger=await autoLedger(),r=ledger[key];
  if(!r || !["pending","needs_attention"].includes(r.state))
    return {ok:false,error:"仅可处理待发送或待人工核实记录"};
  if(action==="mark_sent") ledger[key]={...r,state:"sent",
    reason:"用户确认消息已在目标对话中手动发送",at:new Date().toISOString()};
  else if(action==="retry" && r.state==="needs_attention")
    ledger[key]={...r,state:"pending",reason:"人工核实未发送后重试",at:new Date().toISOString()};
  else return {ok:false,error:"invalid_action"};
  await autoSaveLedger(ledger);
  if(action==="retry")void autoPump();
  return {ok:true,state:await autoState()};
}
// Receipt upload is never a second ChatGPT send. A server ACK is retryable,
// while the browser's durable "sent" record remains permanently deduplicated.
// Only an actual content-script DOM submission can create a receipt.
async function autoSyncReceipts(pair,ledger) {
  let attempts=0;
  for(const record of Object.values(ledger)) {
    if(record?.state!=="sent" || record.receiptState!=="pending")continue;
    if(++attempts>5)break;
    const identity=record.receiptIdentity;
    if(!identity || !AUTO_ID.test(identity.workspace_id) ||
       !AUTO_ID.test(identity.operation_id) ||
       !Number.isSafeInteger(identity.event_id) || identity.event_id<=0)continue;
    try {
      const response=await fetch("http://127.0.0.1:"+pair.port+"/delivery-receipt",{
        method:"POST",cache:"no-store",
        headers:{Authorization:"Bearer "+pair.token,"Content-Type":"application/json"},
        body:JSON.stringify(identity)
      });
      if(!response.ok)continue;
      const data=await response.json();
      if(data?.ok!==true || data.receipt?.result!=="dom_submitted" ||
         data.receipt.workspace_id!==identity.workspace_id ||
         data.receipt.operation_id!==identity.operation_id ||
         data.receipt.event_id!==identity.event_id)continue;
      record.receiptState="synced";
      record.receiptAt=data.receipt.recorded_at;
      await autoSaveLedger(ledger);
    } catch { /* Keep durable pending receipt. Never re-submit the chat. */ }
  }
}
async function autoPump() {
  if(autoBusy)return;
  autoBusy=true;
  let code="checking",message="正在检查";
  const sendEpoch=autoRouteMutationEpoch;
  try {
    await autoResolveRoutes();
    await autoWithBindLock(autoBindPoll);
    const routes=await autoTarget();
    if(!Object.values(routes).some(t=>t?.enabled)) {
      code="not_enabled";message="未绑定或自动发送已暂停";return;
    }
    const pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
    if(!pair || !Number.isInteger(pair.port) || pair.port<1 || pair.port>65535 ||
       !AUTO_TOKEN.test(pair.token)) {
      code="not_paired";message="未配对有效的 Sidecar 会话";return;
    }
    const response=await fetch("http://127.0.0.1:"+pair.port+"/events",{
      method:"GET",cache:"no-store",headers:{Authorization:"Bearer "+pair.token}
    });
    if(!response.ok) {
      code="sidecar_http";message="Sidecar 请求未通过（HTTP "+response.status+"）";return;
    }
    const body=await response.json();
    // /events is capped at 50. An incomplete page cannot prove queue completeness.
    // Halt rather than incorrectly treating a partial queue as fully delivered.
    if(!Array.isArray(body.events)||body.events.length>50 ||
       !Number.isSafeInteger(body.pending_count) ||
       body.pending_count < body.events.length || body.pending_count>body.events.length) {
      code="invalid_feed";message="Sidecar 队列不完整或格式不匹配，停止发送";return;
    }
    const ledger=await autoLedger();
    // In-flight from a prior service-worker lifetime is an unknown outcome.
    for(const [k,r] of Object.entries(ledger)) {
      if(r?.state==="in_flight")ledger[k]={...r,state:"needs_attention",
        at:new Date().toISOString(),reason:"上次投递结果不确定，禁止自动重发"};
    }
    const events=body.events.filter(autoValid).sort((a,b)=>a.event_id-b.event_id);
    autoReconcileLegacy(ledger,events);
    for(const e of events) {
      const key=autoKey(e);
      if(!ledger[key] && Object.keys(ledger).length<2048)
        ledger[key]={state:"pending",at:new Date().toISOString(),reason:""};
    }
    await autoSaveLedger(ledger);
    await autoSyncReceipts(pair,ledger);
    // Never silently truncate deduplication history; manual maintenance is required.
    if(events.some(e=>!ledger[autoKey(e)])) {
      code="ledger_full";message="事件账本已达到安全上限";return;
    }
    // An uncertain submission blocks only its owning workspace. Legacy
    // unknown-scope records block an exactly matching operation/event until
    // reconciled; they cannot stall independent conversations indefinitely.
    const uncertain=Object.entries(ledger).filter(([,r])=>r?.state==="needs_attention");
    const blockedFor=e=>uncertain.some(([k])=>
      k.startsWith(e.workspace_id+":") ||
      k==="unknown:"+e.operation_id+":"+e.event_id);
    const candidate=events.find(e=>typeof e.workspace_id==="string" && AUTO_ID.test(e.workspace_id) &&
      routes[e.workspace_id]?.enabled && ledger[autoKey(e)]?.state==="pending" &&
      !blockedFor(e));
    if(!candidate) {
      code=uncertain.length?"needs_attention":"no_candidate";
      message=uncertain.length?
        "有发送结果待人工核实；关联工作区已暂停，其它工作区仍可投递":
        "已同步 Sidecar，没有新的待投递事件";return;
    }
    const key=autoKey(candidate);
    const target=routes[candidate.workspace_id];
    // Fail closed on corrupt, manually migrated or legacy duplicate routes,
    // not just on new binding attempts.
    if(target?.url && Object.entries(routes).some(([id,r])=>
      id!==candidate.workspace_id && autoCanonical(r?.url)===autoCanonical(target.url))) {
      code="route_conflict";message="多个工作区绑定了同一对话，已停止自动投递";return;
    }
    if(!target?.enabled || !autoCanonical(target.url) || !Number.isSafeInteger(target.tabId)) {
      code="route_not_authorized";message="该工作区没有明确授权的 ChatGPT 对话";return;
    }
    const tab=await chrome.tabs.get(target.tabId).catch(()=>null);
    if(autoCanonical(tab?.url)!==target.url) {code="wrong_tab";message="已绑定标签页不在原对话";return;}
    // Readiness/injection is safe to repeat: it never edits or submits a message.
    // On failure retain pending rather than converting "definitely not sent"
    // into an ambiguous needs_attention state.
    const prepared=await autoReady(target.tabId,target.url);
    if(!prepared.ok) {
      ledger[key]={state:"pending",at:new Date().toISOString(),reason:prepared.reason};
      await autoSaveLedger(ledger);
      code="content_unreachable";message=prepared.reason;return;
    }
    ledger[key]={state:"in_flight",at:new Date().toISOString(),reason:"正在发送"};
    await autoSaveLedger(ledger); // durable BEFORE any DOM action
    // User may have paused or rebound while the network query was in flight.
    const latestRoutes=await autoTarget(),latest=latestRoutes[candidate.workspace_id];
    const latestTab=await chrome.tabs.get(target.tabId).catch(()=>null);
    if(sendEpoch!==autoRouteMutationEpoch ||
       !latest?.enabled || latest.tabId!==target.tabId || latest.url!==target.url ||
       autoCanonical(latestTab?.url)!==target.url) {
      ledger[key]={state:"pending",at:new Date().toISOString(),reason:"绑定会话或授权已变化，取消发送"};
      await autoSaveLedger(ledger);
      code="grant_changed";message="发送前授权或标签页已变化";return;
    }
    let result=null;
    try {
      result=await chrome.tabs.sendMessage(target.tabId,{
        type:"COACH_AUTO_DELIVER_V5",url:target.url,instruction:autoInstruction(candidate)
      });
    }catch{result={ok:false,uncertain:true,reason:"内容脚本不可达"};}
    // Re-read durable state: user may have disabled/unbound while DOM action ran.
    const current=await autoLedger();
    if(current[key]?.state!=="in_flight")return;
    const submitted=result?.ok===true && result?.submitted===true;
    const definitelyNotSent=result?.ok===false && result?.notSubmitted===true;
    current[key]={state:submitted?"sent":definitelyNotSent?"pending":"needs_attention",
      at:new Date().toISOString(),
      ...(submitted?{receiptState:"pending",
        receiptIdentity:{event_id:candidate.event_id,workspace_id:candidate.workspace_id,
          operation_id:candidate.operation_id}}:{}),
      reason:submitted ? "DOM 已提交（尚不代表 Web GPT 审核完成）" :
      String(result?.reason||"DOM 结果不确定，需人工检查").slice(0,120)};
    await autoSaveLedger(current);
    if(submitted)await autoSyncReceipts(pair,current);
    code=submitted?"dom_submitted":definitelyNotSent?"not_submitted":"needs_attention";
    message=submitted?"网页输入框已提交，仍需确认服务端收到":
      (String(result?.reason||"网页投递结果不确定").slice(0,120));
  }catch{
    code="unexpected_error";message="队列读取或提交异常，保留不确定发送状态";
    // In-flight marker remains durable and will become needs_attention on next poll.
  }finally{
    await autoRecordCheck(code,message).catch(()=>{});
    autoBusy=false;
  }
}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5});void autoResolveRoutes();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5});void autoResolveRoutes();});
chrome.alarms.onAlarm.addListener(a=>{if(a.name===AUTO_ALARM)void autoPump();});
// Leaving the selected chat revokes the active send grant, even if the user navigates back.
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(!change.url)return;
  const epoch=autoRouteMutationEpoch;
  void autoTarget().then(routes=>{
    let changed=false;for(const [id,t] of Object.entries(routes))if(t?.tabId===tabId&&autoCanonical(change.url)!==t.url){routes[id]={...t,tabId:null,enabled:false};changed=true;}
    if(changed && epoch===autoRouteMutationEpoch)
      return chrome.storage.local.set({[AUTO_SESSION]:routes});
  });
});
chrome.tabs.onRemoved.addListener(tabId=>{
  const epoch=autoRouteMutationEpoch;
  void autoTarget().then(routes=>{
    let changed=false;for(const [id,t] of Object.entries(routes))if(t?.tabId===tabId){routes[id]={...t,tabId:null};changed=true;}
    if(changed && epoch===autoRouteMutationEpoch)
      return chrome.storage.local.set({[AUTO_SESSION]:routes});
  });
});
chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
  const tasks={
    COACH_AUTO_STATUS:()=>autoState().then(state=>({ok:true,state})),
    COACH_AUTO_BIND:()=>autoWithBindLock(()=>autoBind(msg.workspaceId)),
    COACH_AUTO_BIND_CANCEL:()=>autoWithBindLock(autoCancelPendingForCurrentTab),
    COACH_AUTO_ONE_CLICK:()=>autoWithBindLock(autoOneClick),
    COACH_AUTO_BIND_CHECK:()=>autoWithBindLock(autoBindPoll),
    COACH_AUTO_ENABLE:()=>autoToggle(true,msg.workspaceId),
    COACH_AUTO_PAUSE:()=>autoToggle(false,msg.workspaceId),
    COACH_AUTO_UNBIND:()=>autoUnbind(msg.workspaceId),
    COACH_AUTO_PUMP:async()=>{await autoPump();return {ok:true,state:await autoState()};},
    COACH_AUTO_RESOLVE:()=>autoResolve(msg.key,msg.action)
  };
  if(!msg||typeof msg.type!=="string"||!tasks[msg.type])return false;
  void tasks[msg.type]().then(reply).catch(e=>reply({ok:false,error:String(e.message||"internal_error").slice(0,100)}));
  return true;
});
