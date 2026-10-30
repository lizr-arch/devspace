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
const AUTO_WAKE_ID = /^dsh:[1-9][0-9]{0,18}$/;
// Opaque wake identity produced by the bridge; never mailbox body text.
const AUTO_MESSAGE_ID = /^[a-z0-9-]{16,64}$/;
// Strict per-event instruction. Only the validated opaque messageId is
// embedded; Web GPT must read MAILBOX.md, verify the block's contentSha256,
// and treat peer text as peer content, never as human authorization.
const DSH_WAKE_PREFIX = "请以 Web GPT Coach 身份独立审核。请读取共享信箱 MAILBOX.md 中 messageId=";
const DSH_WAKE_SUFFIX = " 的 DSH wake 块，核对 contentSha256 后按 topic 处理。";

// Deployment glue for the isolated DSH wake sidecar. Only the explicitly
// authorized DSH workspace is routed to this second loopback sidecar; every
// other workspace keeps using the paired production sidecar port. No
// credential is hard-coded here: the existing session bearer is reused.
const DSH_WAKE_SIDECAR_PORT = 8788;
const DSH_WAKE_WORKSPACE = "ws_325cba3d-8620-47a7-ba60-0d65f9be1908";
// 40 pages x 50 = 2000 events, below the 2048-entry delivery ledger cap, so
// a bounded enumeration can never deadlock against the ledger safety limit.
const AUTO_MAX_PAGES = 40;
let autoBusy = false;
const AUTO_LAST_CHECK = "coachAutoLastCheck";
const AUTO_BIND_PENDING = "coachAutoPendingBinds";
// Exact multi-route compatibility layer (TR-DSH-MULTIROUTE-AND-NAVAL-001, I1).
// Additive only: records live under a NEW key so every legacy workspace-only
// record keeps its old semantics until an explicit migration. Absent gate
// (old harnesses) => this whole layer is inert and the legacy flow is intact.
const AUTO_MULTI = "coachMultiRoutes";
const AUTO_MULTI_PENDING = "coachMultiPendingBinds";
const ROUTE_GATE = (typeof DevSpaceRouteGate === "object" && DevSpaceRouteGate) ? DevSpaceRouteGate : null;
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
async function autoMultiRoutes() {
  const value = (await chrome.storage.local.get(AUTO_MULTI))[AUTO_MULTI];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function autoSaveMultiRoutes(routes) {
  await chrome.storage.local.set({[AUTO_MULTI]: routes});
}
async function autoMultiPending() {
  const value = (await chrome.storage.session.get(AUTO_MULTI_PENDING))[AUTO_MULTI_PENDING];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function autoSaveMultiPending(pending) {
  await chrome.storage.session.set({[AUTO_MULTI_PENDING]: pending});
}
function autoMultiCheck(record) {
  if (!ROUTE_GATE) return {ok: false};
  const check = ROUTE_GATE.validateRoute(record);
  return check.ok ? check : {ok: false};
}
function autoMultiLedgerKey(routeId, messageId) {return "route:" + routeId + ":" + messageId;}
async function autoMultiRevoke(routeId) {
  const pair = (await chrome.storage.session.get("coachPairing")).coachPairing;
  const routes = await autoMultiRoutes();
  const route = routes[routeId];
  if (!pair || !AUTO_TOKEN.test(pair.token)) return;
  const consentRevision = Number.isSafeInteger(route?.consentRevision) ? route.consentRevision : undefined;
  try {
    await fetch("http://127.0.0.1:" + pair.port + "/routes/" + routeId + "/revoke", {
      method: "POST", cache: "no-store",
      headers: {Authorization: "Bearer " + pair.token, "Content-Type": "application/json"},
      body: JSON.stringify({...(consentRevision !== undefined ? {expectedConsentRevision: consentRevision} : {}), reason: "user unbind"}),
    });
  } catch { /* Local storage revoke below is authoritative even if Sidecar is offline. */ }
}
async function autoMultiAck(pair, routeId, message, outcome, reason) {
  const allowed = ["dom_submitted", "manual_sent", "acked", "not_submitted", "uncertain", "timeout", "existing_draft", "page_busy", "navigation_mismatch"];
  if (!allowed.includes(outcome)) outcome = "uncertain";
  try {
    await fetch("http://127.0.0.1:" + pair.port + "/routes/" + routeId + "/ack", {
      method: "POST", cache: "no-store",
      headers: {Authorization: "Bearer " + pair.token, "Content-Type": "application/json"},
      body: JSON.stringify({messageId: message.messageId, seq: message.seq,
        contentSha256: message.contentSha256, outcome,
        ...(reason ? {reason: String(reason).slice(0, 160)} : {})}),
    });
  } catch { /* ACK retry is safe: the same identity is idempotent server-side. */ }
}
// One fixed review wake at a time, route-scoped. Never a second chat send for a
// messageId already settled; dom_submitted remains "unverified" by contract.
async function autoMultiPump(pair) {
  const sendEpoch = autoRouteMutationEpoch;
  const routes = await autoMultiRoutes();
  for (const [routeId, record] of Object.entries(routes)) {
    const check = autoMultiCheck(record);
    if (!check.ok || !check.route.enabled) continue;
    const tab = await chrome.tabs.get(check.route.tabId).catch(() => null);
    let response = null;
    try {
      response = await fetch("http://127.0.0.1:" + pair.port + "/routes/" + routeId + "/next?origination=dsh&limit=1", {
        method: "GET", cache: "no-store", headers: {Authorization: "Bearer " + pair.token},
      });
    } catch { return {ok: false, code: "sidecar_unreachable"}; }
    if (!response?.ok) return {ok: false, code: "sidecar_http_" + response?.status};
    const body = await response.json().catch(() => null);
    const message = Array.isArray(body?.messages) ? body.messages[0] : null;
    if (!message) continue;
    const ledger = await autoLedger();
    const key = autoMultiLedgerKey(routeId, message.messageId);
    const decision = ROUTE_GATE.decideDelivery({
      route: check.route, wake: message, tab: {id: tab?.id, url: tab?.url},
      editor: {present: true, draft: false}, busy: false,
      lastState: ledger[key]?.state || "queued",
    });
    if (decision.action !== "submit") {
      ledger[key] = {state: "needs_attention", code: decision.code, at: new Date().toISOString()};
      await autoSaveLedger(ledger);
      await autoMultiAck(pair, routeId, message, "uncertain", decision.code);
      return {ok: true, code: decision.code};
    }
    if (!await ROUTE_GATE.wakeDigestMatches(message, decision.instruction, crypto.subtle)) {
      ledger[key] = {state: "needs_attention", code: "WAKE_DIGEST_MISMATCH", at: new Date().toISOString()};
      await autoSaveLedger(ledger);
      await autoMultiAck(pair, routeId, message, "uncertain", "WAKE_DIGEST_MISMATCH");
      return {ok: true, code: "WAKE_DIGEST_MISMATCH"};
    }
    // Readiness/injection is repeatable and never edits a message by itself.
    const prepared = await autoReady(check.route.tabId, check.route.url);
    if (!prepared.ok) {
      await autoMultiAck(pair, routeId, message, "not_submitted", prepared.reason);
      return {ok: true, code: "content_unreachable", message: prepared.reason};
    }
    ledger[key] = {state: "in_flight", at: new Date().toISOString()};
    await autoSaveLedger(ledger); // durable before any DOM action
    const latest = (await autoMultiRoutes())[routeId];
    const latestTab = await chrome.tabs.get(check.route.tabId).catch(() => null);
    if (sendEpoch !== autoRouteMutationEpoch || !latest?.enabled || latest.tabId !== check.route.tabId ||
        latest.url !== check.route.url || latest.consentRevision !== check.route.consentRevision ||
        ROUTE_GATE.canonicalChatUrl(latestTab?.url) !== check.route.url) {
      ledger[key] = {state: "needs_attention", code: "GRANT_CHANGED", at: new Date().toISOString()};
      await autoSaveLedger(ledger);
      await autoMultiAck(pair, routeId, message, "uncertain", "GRANT_CHANGED");
      return {ok: true, code: "GRANT_CHANGED"};
    }
    let result = null;
    try { result = await chrome.tabs.sendMessage(check.route.tabId, decision.command); }
    catch { result = {ok: false, uncertain: true, reason: "内容脚本不可达"}; }
    const outcome = ROUTE_GATE.classifyOutcome(result);
    ledger[key] = {state: outcome.state, code: outcome.code, reason: outcome.reason || "",
      at: new Date().toISOString()};
    await autoSaveLedger(ledger);
    await autoMultiAck(pair, routeId, message,
      outcome.state === "dom_submitted_unverified" ? "dom_submitted" : "uncertain", outcome.reason);
    return {ok: true, code: outcome.code};
  }
  return {ok: true, code: "no_candidate"};
}
// Bind one exact route only after its Sidecar pending challenge is active AND
// the browser's pinned tab still shows the same canonical conversation.
async function autoMultiBindPoll(pair, epoch) {
  const pending = await autoMultiPending();
  const entries = Object.entries(pending);
  if (!entries.length) return {changed: false, claimed: 0};
  const routes = await autoMultiRoutes();
  let changed = false, claimed = 0;
  for (const [routeId, request] of entries) {
    if (Date.now() - request.createdAt > 600_000) { delete pending[routeId]; changed = true; continue; }
    if (pair.port !== request.port) continue;
    const response = await fetch("http://127.0.0.1:" + pair.port + "/route/status?routeId=" + routeId, {
      method: "GET", cache: "no-store", headers: {Authorization: "Bearer " + pair.token},
    }).catch(() => null);
    if (!response?.ok) continue;
    const data = await response.json().catch(() => null);
    if (data?.state !== "active" || !data.route) continue;
    const check = ROUTE_GATE.validateRoute({...data.route, url: data.route.canonicalChatUrl,
      tabId: data.route.exactTabId});
    if (!check.ok || check.route.routeId !== routeId || check.route.url !== request.url) continue;
    const tab = await chrome.tabs.get(request.tabId).catch(() => null);
    if (ROUTE_GATE.canonicalChatUrl(tab?.url) !== request.url) continue;
    routes[routeId] = {
      routeId, workspaceId: check.route.workspaceId, dshSessionId: check.route.dshSessionId,
      url: request.url, tabId: request.tabId, enabled: true,
      consentRevision: check.route.consentRevision,
    };
    delete pending[routeId];
    changed = true; claimed++;
  }
  if (epoch !== autoRouteMutationEpoch) return {changed: false, claimed: 0};
  if (changed) {
    await autoSaveMultiRoutes(routes);
    await autoSaveMultiPending(pending);
  }
  return {changed, claimed};
}
function autoKey(e) {return (e.workspace_id||"unknown") + ":" + e.operation_id + ":" + e.event_id;}
function autoDeliveryWorkspace(e) {return e.delivery_workspace_id||e.workspace_id;}
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
  if(e?.delivery_workspace_id!==undefined &&
    (!AUTO_ID.test(e.delivery_workspace_id)||typeof e.delivery_nonce!=="string"||!/^[a-f0-9]{32}$/.test(e.delivery_nonce)))return false;
  if(e?.delivery_nonce!==undefined && e.delivery_workspace_id===undefined)return false;
  // DSH mailbox wakes carry a string identity and no review report. They are
  // delivered only to the explicitly bound workspace conversation.
  if(e && e.event_type === "DSH_MAILBOX_WAKE")
    return typeof e.event_id === "string" && /^dsh:[1-9][0-9]{0,18}$/.test(e.event_id) &&
      typeof e.workspace_id === "string" && AUTO_ID.test(e.workspace_id) &&
      typeof e.operation_id === "string" && AUTO_MESSAGE_ID.test(e.operation_id) &&
      typeof e.created_at === "string" && e.created_at.length <= 64;
  if(e?.app_kind==="native_chatgpt_app_codex")return e.event_type==="CODEX_APP_READY_FOR_GPT_REVIEW"&&
    typeof e.event_id==="string"&&/^app:[a-f0-9]{64}$/.test(e.event_id)&&
    typeof e.workspace_id==="string"&&AUTO_ID.test(e.workspace_id)&&
    typeof e.operation_id==="string"&&AUTO_ID.test(e.operation_id)&&
    typeof e.thread_id==="string"&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(e.thread_id)&&
    typeof e.evidence_sha256==="string"&&/^[a-f0-9]{64}$/.test(e.evidence_sha256);
  // Defend against an older Sidecar forwarding every completion as a review.
  const report=e?.report;
  const valid=report?.schema==="DEVSPACE_CODEX_REPORT_CHECK_V1" && report.valid===true &&
    report.code==="REPORT_VALID_UNVERIFIED_CLAIMS" && report.testsIndependentlyVerified===false &&
    typeof report.reportSha256==="string" && /^[a-f0-9]{64}$/.test(report.reportSha256);
  const ready=report===undefined || (valid && report.status==="READY_FOR_REVIEW");
  const conflict=valid && report.status==="PLAN_CONFLICT";
  return e && ((e.event_type === "READY_FOR_GPT_REVIEW" && ready) || (e.event_type === "PLAN_CONFLICT" && conflict)) &&
    Number.isSafeInteger(e.event_id) && e.event_id > 0 &&
    (e.workspace_id===undefined || (typeof e.workspace_id === "string" && AUTO_ID.test(e.workspace_id))) &&
    typeof e.operation_id === "string" && AUTO_ID.test(e.operation_id);
}
function autoInstruction(e) {
  if(e.app_kind==="native_chatgpt_app_codex")return "请以 Web GPT Coach 身份独立审核一项由 ChatGPT App 原生 Codex 完成的任务。"+
    "通过 DevSpace MCP 使用 codex_app_thread_read 读取同一工作区和固定原生线程的真实源码差异与上下文，核对冻结 TASK 及测试；"+
    "completion 和浏览器提交回执都不是批准。请用 codex_app_review 为该事件写入有依据的 APPROVED / REWORK / BLOCKED 裁决。"+
    "REWORK 必须针对同一个固定 App 线程并使用新 operationId，不能启动本地 Codex CLI。"+
    "\n事件 ID："+e.event_id+"\n操作 ID："+e.operation_id+"\n工作区 ID："+e.workspace_id+
    "\n原生 ChatGPT App Codex 线程："+e.thread_id+"\n事件证据 SHA-256："+e.evidence_sha256;
  // Exactly one validated opaque messageId, no mailbox body or content hash.
  if(e.event_type==="DSH_MAILBOX_WAKE")
    return DSH_WAKE_PREFIX + e.operation_id + DSH_WAKE_SUFFIX;
  if(e.event_type==="PLAN_CONFLICT")return "DevSpace Codex 报告 PLAN_CONFLICT，需要 Web GPT 修订已批准的任务。"+
    "请先查询 coach_realtime_status，并通过 DevSpace MCP 读取本操作不可变证据及绑定 TASK/报告，核对具体反证、影响与建议修订。"+
    "这是计划冲突反馈；请明确处理契约修订，不要提交正式 APPROVED / REWORK 审核裁决，也不要自动重启或继续任务。"+
    "\n事件 ID："+e.event_id+"\n工作区 ID："+e.workspace_id+"\n任务 ID："+e.operation_id;
  return "请以 Web GPT Coach 身份独立审核一项本地 Codex CLI 已完成任务。"+
  "通过 DevSpace MCP 读取真实源码、Git 差异、不可变完成证据和测试结果，不要重复运行该 Codex 任务；"+
  "验证之后仅作 APPROVED / REWORK / BLOCKED 裁决，并在 REWORK 时下发具体修复任务。"+
  "请先查询 coach_realtime_status：若当前任务属于 reviewerMode=webgpt 的已批准自动计划，"+
  "必须使用 coach_webgpt_submit_review 提交有证据的裁决与具体原因，由本地调度器安全推进；"+
  "否则使用原有 codex_agent_submit_review。严禁仅输出裁决文字而不写回。"+
  "这是审核通知，不代表已经通过验收。"+
  (e.delivery_workspace_id?"请在本通知实际触发的新 Web GPT 回合中，独立获取原始证据 SHA 后调用 coach_webgpt_acknowledge_turn；若 DOM 回执尚未入库，仅重查回执，禁止重发消息或伪造确认。所有读取和审核使用执行工作区 ID，投递工作区仅用于路由。":"")+
  "\n事件 ID："+e.event_id+"\n工作区 ID："+(e.workspace_id||"旧版 Sidecar 未返回；请通过 DevSpace MCP 按任务 ID 查证，若无法唯一匹配则停止") + "\n任务 ID："+e.operation_id;
}
async function autoState() {
  const routes=await autoTarget(), entries=Object.entries(routes), ledger=await autoLedger();
  const multiRaw=ROUTE_GATE?await autoMultiRoutes():{};
  const multi=Object.entries(multiRaw).filter(([,record])=>autoMultiCheck(record).ok)
    .map(([routeId,record])=>({routeId,workspaceId:record.workspaceId,dshSessionId:record.dshSessionId,
      url:record.url,tabId:record.tabId,enabled:!!record.enabled,consentRevision:record.consentRevision}));
  const multiEnabled=multi.some(route=>route.enabled);
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
  return {enabled:entries.some(([,route])=>!!route?.enabled)||multiEnabled,
    bound:entries.length>0||multi.length>0,
    multiRoutes:multi, multiEnabled,
    pendingRouteBinding:ROUTE_GATE?Object.values(await autoMultiPending()):[],
    url:entries.length===1?entries[0][1]?.url||"":entries.length?entries.length+" 个工作区对话已绑定":"",
    routes:entries.map(([workspaceId,route])=>({workspaceId,url:route?.url||"",enabled:!!route?.enabled,tabReady:Number.isSafeInteger(route?.tabId),grantVerified:typeof route?.nonce==="string" && /^[a-f0-9]{32}$/.test(route.nonce)})),
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
// One explicit user click binds the CURRENT ChatGPT conversation to the fixed
// DSH workspace and enables auto-delivery. No nonce/claim call: this is the
// already-supported local manual bind path consolidated into a single user
// gesture; the active-tab canonical URL is required and nothing is guessed.
async function autoDshOneClick() {
  let pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
  if(!pair || !AUTO_TOKEN.test(pair.token)) {
    const paired=await requestNativePairing(true);
    if(!paired?.ok)return {ok:false,error:"本机安全配对失败："+(paired?.message||"unknown")};
    pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
  }
  if(!pair || !AUTO_TOKEN.test(pair.token))return {ok:false,error:"没有有效的 Sidecar 配对"};
  const bound=await autoBind(DSH_WAKE_WORKSPACE);
  if(!bound?.ok)return {ok:false,error:bound?.error||"绑定失败"};
  const enabled=await autoToggle(true,DSH_WAKE_WORKSPACE);
  if(!enabled?.ok)return {ok:false,error:enabled?.error||"启用失败"};
  void autoPump();
  return {ok:true,message:"已一键绑定并启用当前 ChatGPT 对话（DSH 工作区）",state:await autoState()};
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
// Exact multi-route one-click: the Sidecar mints an unguessable routeId and
// the Web GPT conversation must claim it over MCP with its exact DSH session.
async function autoOneClickExact(tab,pair) {
  if(!ROUTE_GATE)return null;
  // Product fix (P6 consolidation): this function previously read the undeclared
  // `url` from the caller scope; the ReferenceError was swallowed by the caller's
  // catch and silently fell back to the legacy /bind/start path, so the exact
  // /route/propose flow could never be reached.
  const url=autoCanonical(tab?.url);
  if(!url)return null;
  const routes=await autoMultiRoutes();
  if(Object.values(routes).some(route=>route?.url===url))return {ok:false,error:"此对话已绑定精确路由，请查看现有状态"};
  const pending=await autoMultiPending();
  if(Object.keys(pending).length>=8)return {ok:false,error:"已有八条精确绑定请求在等待确认，请稍后再试"};
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  const nonce=[...bytes].map(n=>n.toString(16).padStart(2,"0")).join("");
  let response=null;
  try{
    response=await fetch("http://127.0.0.1:"+pair.port+"/route/propose",{
      method:"POST",cache:"no-store",
      headers:{Authorization:"Bearer "+pair.token,"Content-Type":"application/json"},
      body:JSON.stringify({nonce,url,tabId:tab.id})
    });
  }catch{return null;}
  if(!response?.ok)return null; // Sidecar without multi-route support: legacy flow.
  const data=await response.json().catch(()=>null);
  if(typeof data?.routeId!=="string"||!ROUTE_GATE.ROUTE_ID.test(data.routeId))
    return {ok:false,error:"Sidecar 返回了无效的精确路由标识"};
  pending[data.routeId]={routeId:data.routeId,nonce,url,tabId:tab.id,createdAt:Date.now(),port:pair.port};
  autoRouteMutationEpoch++;
  await chrome.storage.local.set({[AUTO_REVOKED]:false});
  await autoSaveMultiPending(pending);
  try{
    await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:false},files:["chatgpt-binding.js"]});
    const prompt="DevSpace Coach 精确多会话绑定请求（由当前对话中的用户点击扩展发起）。"+
      "请使用 DevSpace MCP 调用 coach_webgpt_claim_browser_route_exact 工具：routeId="+data.routeId+
      "；dshSessionId=你当前真实的 DSH sessionId；nonce="+nonce+"；url="+url+
      "；workspaceId=你正在管理的精确工作区。仅当本对话确实授权该工作区与该 DSH 会话时才执行，"+
      "不要猜测、不要使用其他对话的工作区或会话。工具返回 claimed=true 后告知用户绑定确认。";
    const delivered=await chrome.tabs.sendMessage(tab.id,{
      type:"COACH_BIND_REQUEST_V1",url,instruction:prompt
    });
    if(delivered?.ok!==true||delivered?.submitted!==true){
      if(delivered?.notSubmitted===true){
        delete pending[data.routeId];
        await autoSaveMultiPending(pending);
      }
      return {ok:false,error:"精确绑定请求未确认提交；请先检查目标对话，不会自动重发"};
    }
    return {ok:true,message:"已发送精确多会话绑定请求，等待 Web GPT 独立确认",pending:true,routeId:data.routeId};
  }catch{
    return {ok:false,error:"精确绑定消息投递结果不确定；请检查对话，禁止自动重试"};
  }
}
// Exactly one user click starts a challenge; the extension cannot infer a
// DevSpace workspace from the ChatGPT tab. Web GPT must claim it over MCP.
async function autoOneClick() {
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs?.[0],url=autoCanonical(tab?.url);
  if(!Number.isSafeInteger(tab?.id)||!url)return {ok:false,error:"请在具体的 ChatGPT 对话中点击一键启用"};
  const existing=await autoTarget();
  const currentRoutes=Object.entries(existing).filter(([,route])=>autoCanonical(route?.url)===url);
  // One explicit click can upgrade one legacy route lacking a scoped nonce.
  // Never create parallel claims for an already verified route or ambiguous scopes.
  if(currentRoutes.length>1 || currentRoutes.some(([,route])=>
      typeof route?.nonce==="string" && /^[a-f0-9]{32}$/.test(route.nonce)))
    return {ok:false,error:"此对话已经完成授权，不能重复绑定"};
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
  // Exact multi-route path when the running Sidecar advertises it. Any
  // failure (old Sidecar / older harness) falls through to the legacy flow.
  const exact=await autoOneClickExact(tab,pair);
  if(exact)return exact;
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
  // Failure to load the binding listener occurs before any chat submission:
  // it is definitely unsent and can safely be retried after permissions change.
  try {
    await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:false},files:["chatgpt-binding.js"]});
  } catch {
    delete pendingMap[nonce];
    await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
    return {ok:false,code:"BIND_SCRIPT_UNAVAILABLE",safeRetry:true,
      error:"绑定请求确定未发送：无法加载 ChatGPT 绑定脚本。请检查扩展的 chatgpt.com 网站权限，重新加载扩展后再连接。"};
  }
  // Fresh isolated-world binding handler. Old audit content scripts cannot
  // answer this protocol. No chat history is inspected.
  try {
    const prompt="DevSpace Coach 一键绑定请求（由当前对话中的用户点击扩展发起）。"+
      "请使用 DevSpaceMac MCP，先确定你正在管理的精确 workspaceId，"+
      "然后调用 coach_webgpt_claim_browser_route 工具：nonce="+nonce+
      "；url="+url+"。仅当此对话确实已经授权该工作区时才执行，不要猜测、不要使用其他对话的工作区。"+
      "工具返回 claimed=true 后告知用户绑定确认；无需复制任何密钥。";
    const delivered=await chrome.tabs.sendMessage(tab.id,{
      type:"COACH_BIND_REQUEST_V1",url,instruction:prompt
    });
    if(delivered?.ok!==true||delivered.submitted!==true) {
      // Only a positive notSubmitted=true confirms that the content script did
      // not press Send. Unknown outcomes retain their challenge and must never
      // automatically retry, because the browser may have sent the message.
      const reason=typeof delivered?.reason==="string"?
        delivered.reason.slice(0,180):"浏览器没有返回具体原因";
      if(delivered?.notSubmitted===true){
        delete pendingMap[nonce];
        await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
        return {ok:false,code:"BIND_NOT_SUBMITTED",safeRetry:true,
          error:"绑定请求确定未发送："+reason+"。解决后可再次点击连接。"};
      }
      return {ok:false,code:"BIND_SEND_UNCERTAIN",safeRetry:false,
        error:"绑定消息发送状态不确定："+reason+"。请先检查目标对话及输入框，禁止直接重发。"};
    }
    // Distinguish a verified DOM send from a challenge that was only created.
    pendingMap[nonce]={...pendingMap[nonce],submitted:true};
    await chrome.storage.session.set({[AUTO_BIND_PENDING]:pendingMap});
    return {ok:true,message:"已向当前对话发送绑定请求，等待 Web GPT 独立确认",pending:true};
  } catch {
    return {ok:false,code:"BIND_SEND_UNCERTAIN",safeRetry:false,
      error:"绑定消息发送结果未知，可能已经提交。请先检查对话或草稿，禁止直接重发。"};
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
    routes[data.workspaceId]={url:pending.url,tabId:pending.tabId,enabled:true,nonce};
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
  // Exact multi-route challenges independently confirm through /route/status.
  let exactClaimed=0;
  if(ROUTE_GATE){
    const multi=await autoMultiBindPoll(pair,epoch);
    exactClaimed=multi.claimed;
    if(multi.changed)autoRouteMutationEpoch++;
  }
  const total=claimedCount+exactClaimed;
  return {ok:true,state:total?"bound":"pending",claimedCount:total};
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
async function autoUnbind(requestedWorkspaceId,requestedRouteId) {
  if(requestedRouteId&&ROUTE_GATE){
    if(!ROUTE_GATE.ROUTE_ID.test(requestedRouteId))return {ok:false,error:"routeId 无效"};
    const multi=await autoMultiRoutes();
    if(!multi[requestedRouteId])return {ok:false,error:"未找到该精确路由"};
    autoRouteMutationEpoch++;
    await autoMultiRevoke(requestedRouteId);
    delete multi[requestedRouteId];
    await autoSaveMultiRoutes(multi);
    if(!Object.keys(multi).length)await chrome.storage.local.set({[AUTO_REVOKED]:true});
    return {ok:true,state:await autoState()};
  }
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
  if(ROUTE_GATE){
    const multi=await autoMultiRoutes();let multiChanged=false;
    for(const [routeId,record] of Object.entries(multi)){
      const tab=await chrome.tabs.get(record.tabId).catch(()=>null);
      if(ROUTE_GATE.canonicalChatUrl(tab?.url)!==record.url){
        multi[routeId]={...record,tabId:null,enabled:false};multiChanged=true;
      }
    }
    if(multiChanged&&epoch===autoRouteMutationEpoch)await autoSaveMultiRoutes(multi);
  }
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
      const ready=await chrome.tabs.sendMessage(tabId,{type:"COACH_AUTO_PING_V6"});
      return ready?.ok===true && ready.protocol===6 && ready.url===url;
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
    const eventId=identity?.event_id;
    // Numeric Coach review ids and durable DSH wake ids both carry a real
    // DOM-submitted receipt identity. Anything else is never fabricated.
    const eventIdOk=(Number.isSafeInteger(eventId)&&eventId>0) ||
      (typeof eventId==="string"&&(AUTO_WAKE_ID.test(eventId)||/^app:[a-f0-9]{64}$/.test(eventId)));
    if(!identity || !AUTO_ID.test(identity.workspace_id) ||
       !AUTO_ID.test(identity.operation_id) || !eventIdOk)continue;
    try {
      const receiptPort=typeof eventId==="string"&&AUTO_WAKE_ID.test(eventId)?DSH_WAKE_SIDECAR_PORT:pair.port;
      const response=await fetch("http://127.0.0.1:"+receiptPort+"/delivery-receipt",{
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
// Bounded, identity-verified pagination. One inconsistent page (wrong count,
// duplicate identity, malformed cursor envelope) fails the whole feed closed:
// the extension never treats a truncated queue as fully delivered.
async function autoFetchFeed(pair,portOverride,workspaceFilter) {
  const events=[],seen=new Set(),seenCursors=new Set();
  let cursor=null,expected=null,pages=0,hasMore=true;
  const port=Number.isInteger(portOverride)?portOverride:pair.port;
  const scope=workspaceFilter?"&workspaceId="+encodeURIComponent(workspaceFilter):"";
  while(hasMore) {
    if(++pages>AUTO_MAX_PAGES)return {ok:false,code:"invalid_feed",detail:"max pages"};
    const base="http://127.0.0.1:"+port+"/events?limit=50"+scope;
    const url=cursor===null?base:base+"&cursor="+encodeURIComponent(cursor);
    const response=await fetch(url,{method:"GET",cache:"no-store",
      headers:{Authorization:"Bearer "+pair.token}});
    if(!response.ok)return {ok:false,code:"sidecar_http",status:response.status};
    const body=await response.json().catch(()=>null);
    if(!body||!Array.isArray(body.events)||body.events.length>50||
       !Number.isSafeInteger(body.pending_count)||body.pending_count<0||
       typeof body.has_more!=="boolean"||
       (body.has_more&&typeof body.next_cursor!=="string")||
       (!body.has_more&&body.next_cursor!==null))
      return {ok:false,code:"invalid_feed",detail:"envelope"};
    if(expected===null)expected=body.pending_count;
    else if(body.pending_count!==expected)
      return {ok:false,code:"invalid_feed",detail:"pending_count drifted"};
    for(const event of body.events) {
      if(!event||typeof event!=="object"||
         !((typeof event.event_id==="number")||(typeof event.event_id==="string")))
        return {ok:false,code:"invalid_feed",detail:"identity"};
      const identity=typeof event.event_id+":"+event.event_id;
      if(seen.has(identity))return {ok:false,code:"invalid_feed",detail:"duplicate"};
      seen.add(identity);events.push(event);
    }
    if(events.length>expected)return {ok:false,code:"invalid_feed",detail:"over count"};
    if(body.has_more&&body.events.length===0)
      return {ok:false,code:"invalid_feed",detail:"empty page"};
    hasMore=body.has_more;cursor=body.next_cursor;
    if(hasMore) {
      if(seenCursors.has(cursor))return {ok:false,code:"invalid_feed",detail:"cursor loop"};
      seenCursors.add(cursor);
    }
  }
  if(events.length!==expected)
    return {ok:false,code:"invalid_feed",detail:"incomplete accumulation"};
  return {ok:true,events,pending_count:expected,pages};
}
// Native App versions of the same exact thread: newest pending completion only.
// Audit older events without replay; never modify an uncertain or sent ledger record.
function autoSupersedeOlderNative(ledger,events) {
  const latest=new Map();
  for(const e of events) {
    if(e?.app_kind!=="native_chatgpt_app_codex" ||
       typeof e.workspace_id!=="string" || typeof e.thread_id!=="string" ||
       typeof e.created_at!=="string")continue;
    const group=e.workspace_id+":"+e.thread_id,prior=latest.get(group);
    if(!prior || e.created_at>prior.created_at ||
       (e.created_at===prior.created_at && e.event_id>prior.event_id))latest.set(group,e);
  }
  let changed=false;
  for(const e of events) {
    if(e?.app_kind!=="native_chatgpt_app_codex")continue;
    const group=e.workspace_id+":"+e.thread_id;
    if(!latest.has(group)||latest.get(group)===e)continue;
    const key=autoKey(e),old=ledger[key];
    if(old&&old.state!=="pending")continue;
    ledger[key]={state:"superseded",deliveryWorkspaceId:autoDeliveryWorkspace(e),
      at:new Date().toISOString(),
      reason:"同一原生线程已有更新完成事件；旧通知保留审计，不重发且不冒认批准"};
    changed=true;
  }
  return changed;
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
    const multi=ROUTE_GATE?await autoMultiRoutes():{};
    const multiEnabled=Object.entries(multi).some(([,record])=>autoMultiCheck(record).ok&&record.enabled);
    if(!Object.values(routes).some(t=>t?.enabled)&&!multiEnabled) {
      code="not_enabled";message="未绑定或自动发送已暂停";return;
    }
    const pair=(await chrome.storage.session.get("coachPairing")).coachPairing;
    if(!pair || !Number.isInteger(pair.port) || pair.port<1 || pair.port>65535 ||
       !AUTO_TOKEN.test(pair.token)) {
      code="not_paired";message="未配对有效的 Sidecar 会话";return;
    }
    if(multiEnabled){
      const exact=await autoMultiPump(pair);
      if(exact.code!=="no_candidate"){
        code=exact.code;message=exact.message||("精确路由投递："+exact.code);return;
      }
    }
    if(!Object.values(routes).some(t=>t?.enabled)) {
      code="no_candidate";message="已同步精确路由，没有新的待投递事件";return;
    }
    const feed=await autoFetchFeed(pair);
    if(!feed.ok) {
      if(feed.code==="sidecar_http") {
        code="sidecar_http";message="Sidecar 请求未通过（HTTP "+feed.status+"）";return;
      }
      code="invalid_feed";message="Sidecar 队列不完整或格式不匹配，停止发送";return;
    }
    // The isolated DSH wake sidecar is a second loopback feed. It is optional
    // during rollout: an unreachable override sidecar must never block or
    // invalidate the production Coach feed.
    let dshWakeEvents=[];
    try {
      const dshFeed=await autoFetchFeed(pair,DSH_WAKE_SIDECAR_PORT,DSH_WAKE_WORKSPACE);
      if(dshFeed.ok)dshWakeEvents=dshFeed.events;
    } catch { /* Override sidecar not running (yet). */ }
    const ledger=await autoLedger();
    // In-flight from a prior service-worker lifetime is an unknown outcome.
    for(const [k,r] of Object.entries(ledger)) {
      if(r?.state==="in_flight")ledger[k]={...r,state:"needs_attention",
        at:new Date().toISOString(),reason:"上次投递结果不确定，禁止自动重发"};
    }
    // The feed is already in the Sidecar's stable merged order; filter only
    // after the complete-page count/identity verification above.
    const merged=[...feed.events,...dshWakeEvents];
    const seenMerged=new Set();
    const events=merged.filter(e=>{
      const id=typeof e?.event_id+":"+e?.event_id;
      if(seenMerged.has(id))return false;
      seenMerged.add(id);
      return autoValid(e);
    });
    autoReconcileLegacy(ledger,events);
    autoSupersedeOlderNative(ledger,events);
    for(const e of events) {
      const key=autoKey(e);
      if(!ledger[key] && Object.keys(ledger).length<2048)
        ledger[key]={state:"pending",at:new Date().toISOString(),reason:"",deliveryWorkspaceId:autoDeliveryWorkspace(e)};
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
    const blockedFor=e=>uncertain.some(([k,r])=>
      r.deliveryWorkspaceId===autoDeliveryWorkspace(e) ||
      k.startsWith(e.workspace_id+":") ||
      k==="unknown:"+e.operation_id+":"+e.event_id);
    const coolingFor=e=>Object.values(ledger).some(r=>r?.retryAfter>Date.now()&&
      r.deliveryWorkspaceId===autoDeliveryWorkspace(e));
    const candidate=events.find(e=>typeof e.workspace_id==="string" && AUTO_ID.test(e.workspace_id) &&
      routes[autoDeliveryWorkspace(e)]?.enabled && ledger[autoKey(e)]?.state==="pending" &&
      (!e.delivery_workspace_id||routes[autoDeliveryWorkspace(e)]?.nonce===e.delivery_nonce) &&
      !blockedFor(e) && !coolingFor(e));
    if(!candidate) {
      code=uncertain.length?"needs_attention":"no_candidate";
      message=uncertain.length?
        "有发送结果待人工核实；关联工作区已暂停，其它工作区仍可投递":
        "已同步 Sidecar，没有新的待投递事件";return;
    }
    const key=autoKey(candidate);
    const deliveryWorkspace=autoDeliveryWorkspace(candidate);
    const target=routes[deliveryWorkspace];
    if(candidate.delivery_workspace_id && target?.nonce!==candidate.delivery_nonce){
      code="route_grant_mismatch";message="投递事件不属于此浏览器认领，停止发送";return;
    }
    // Fail closed on corrupt, manually migrated or legacy duplicate routes,
    // not just on new binding attempts.
    if(target?.url && Object.entries(routes).some(([id,r])=>
      id!==deliveryWorkspace && autoCanonical(r?.url)===autoCanonical(target.url))) {
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
    ledger[key]={state:"in_flight",at:new Date().toISOString(),reason:"正在发送",deliveryWorkspaceId:deliveryWorkspace};
    await autoSaveLedger(ledger); // durable BEFORE any DOM action
    // User may have paused or rebound while the network query was in flight.
    const latestRoutes=await autoTarget(),latest=latestRoutes[deliveryWorkspace];
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
        type:"COACH_AUTO_DELIVER_V6",url:target.url,instruction:autoInstruction(candidate)
      });
    }catch{result={ok:false,uncertain:true,reason:"内容脚本不可达"};}
    // Re-read durable state: user may have disabled/unbound while DOM action ran.
    const current=await autoLedger();
    if(current[key]?.state!=="in_flight")return;
    const submitted=result?.ok===true && result?.submitted===true;
    const definitelyNotSent=result?.ok===false && result?.notSubmitted===true;
    // A receipt exists only for a real DOM-submitted send. Numeric Coach review
    // ids and DSH wake ids (dsh:<rowid>) are both acknowledged by exact
    // identity; the ledger key keeps workspace:messageId:dsh:N.
    const receiptEventId=Number.isSafeInteger(candidate.event_id)&&candidate.event_id>0
      ?candidate.event_id:(typeof candidate.event_id==="string"&&AUTO_WAKE_ID.test(candidate.event_id)
        ?candidate.event_id:(typeof candidate.event_id==="string"&&/^app:[a-f0-9]{64}$/.test(candidate.event_id)?candidate.event_id:null));
    current[key]={state:submitted?"sent":definitelyNotSent?"pending":"needs_attention",
      deliveryWorkspaceId:deliveryWorkspace,
      ...(definitelyNotSent && result.busy===true?{retryAfter:Date.now()+60_000}:{}),
      at:new Date().toISOString(),
      ...(submitted&&receiptEventId!==null?{receiptState:"pending",
        receiptIdentity:{event_id:receiptEventId,workspace_id:candidate.workspace_id,
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
// Exact route enable/pause: never moves tabs and never rebinds implicitly.
async function autoToggleMulti(enabled,routeId) {
  if(!ROUTE_GATE||!ROUTE_GATE.ROUTE_ID.test(String(routeId)))
    return {ok:false,error:"routeId 无效"};
  const multi=await autoMultiRoutes();
  const record=multi[routeId];
  if(!record)return {ok:false,error:"未找到该精确路由"};
  if(enabled){
    const tab=await chrome.tabs.get(record.tabId).catch(()=>null);
    if(ROUTE_GATE.canonicalChatUrl(tab?.url)!==record.url)
      return {ok:false,error:"原对话标签页已关闭或导航，请重新显式绑定"};
  }
  autoRouteMutationEpoch++;
  multi[routeId]={...record,enabled:!!enabled};
  await autoSaveMultiRoutes(multi);
  if(enabled)void autoPump();
  return {ok:true,state:await autoState()};
}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5});void autoResolveRoutes();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create(AUTO_ALARM,{periodInMinutes:0.5});void autoResolveRoutes();});
chrome.alarms.onAlarm.addListener(a=>{if(a.name===AUTO_ALARM)void autoPump();});
// Leaving the selected chat revokes the active send grant, even if the user navigates back.
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(!change.url)return;
  const epoch=autoRouteMutationEpoch;
  if(ROUTE_GATE)void autoMultiRoutes().then(multi=>{
    let changed=false;
    for(const [routeId,record] of Object.entries(multi))
      if(record?.tabId===tabId&&ROUTE_GATE.canonicalChatUrl(change.url)!==record.url){
        multi[routeId]={...record,tabId:null,enabled:false};changed=true;
      }
    if(changed&&epoch===autoRouteMutationEpoch)return autoSaveMultiRoutes(multi);
  });
  void autoTarget().then(routes=>{
    let changed=false;for(const [id,t] of Object.entries(routes))if(t?.tabId===tabId&&autoCanonical(change.url)!==t.url){routes[id]={...t,tabId:null,enabled:false};changed=true;}
    if(changed && epoch===autoRouteMutationEpoch)
      return chrome.storage.local.set({[AUTO_SESSION]:routes});
  });
});
chrome.tabs.onRemoved.addListener(tabId=>{
  const epoch=autoRouteMutationEpoch;
  if(ROUTE_GATE)void autoMultiRoutes().then(multi=>{
    let changed=false;
    for(const [routeId,record] of Object.entries(multi))
      if(record?.tabId===tabId){multi[routeId]={...record,tabId:null,enabled:false};changed=true;}
    if(changed&&epoch===autoRouteMutationEpoch)return autoSaveMultiRoutes(multi);
  });
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
    COACH_AUTO_DSH_ONE_CLICK:()=>autoWithBindLock(autoDshOneClick),
    COACH_AUTO_BIND_CHECK:()=>autoWithBindLock(autoBindPoll),
    COACH_AUTO_ENABLE:()=>msg.routeId?autoToggleMulti(true,msg.routeId):autoToggle(true,msg.workspaceId),
    COACH_AUTO_PAUSE:()=>msg.routeId?autoToggleMulti(false,msg.routeId):autoToggle(false,msg.workspaceId),
    COACH_AUTO_UNBIND:()=>autoUnbind(msg.workspaceId,msg.routeId),
    COACH_AUTO_MULTI_STATUS:()=>autoState().then(state=>({ok:true,state})),
    COACH_AUTO_PUMP:async()=>{await autoPump();return {ok:true,state:await autoState()};},
    COACH_AUTO_RESOLVE:()=>autoResolve(msg.key,msg.action)
  };
  if(!msg||typeof msg.type!=="string"||!tasks[msg.type])return false;
  void tasks[msg.type]().then(reply).catch(e=>reply({ok:false,error:String(e.message||"internal_error").slice(0,100)}));
  return true;
});
