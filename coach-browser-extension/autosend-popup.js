"use strict";
const findAuto = id => document.getElementById(id);
const AUTO_CHAT_URL = /^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9_-]{8,128}\/?$/;
function autoPopupChatUrl(value) {
  try {
    const url = new URL(value);
    if(url.protocol!=="https:"||url.hostname!=="chatgpt.com"||url.port||
       !AUTO_CHAT_URL.test(url.pathname))return null;
    return url.origin+url.pathname.replace(/\/$/,"");
  }catch{return null;}
}
async function autoPopupCurrentUrl() {
  try {
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    return autoPopupChatUrl(tabs?.[0]?.url);
  }catch{return null;}
}
function autoConnectionUI(state,url) {
  const button=findAuto("auto-one-click");
  const label=findAuto("auto-connection-state");
  const hint=findAuto("auto-one-click-status");
  const desc=findAuto("auto-current-chat-note");
  const dot=findAuto("auto-connection-dot");
  const cancel=findAuto("auto-cancel-pending");
  const routes=Array.isArray(state.routes)?state.routes:[];
  const pending=Array.isArray(state.pendingBinding)?state.pendingBinding:[];
  const current=url?routes.find(r=>autoPopupChatUrl(r?.url)===url):null;
  const waitingFor=url?pending.find(r=>autoPopupChatUrl(r?.url)===url):null;
  const waiting=!!waitingFor;
  dot.dataset.state="neutral";
  cancel.hidden=!waiting;
  button.dataset.action="connect";
  button.disabled=false;
  if(!url) {
    label.textContent="请打开具体的 ChatGPT 对话";
    desc.textContent="先切换到要接收 Codex 审核通知的 ChatGPT 对话，再打开本扩展。";
    hint.textContent="观察面板只显示任务记录，不负责绑定。";
    button.textContent="连接当前对话";button.disabled=true;
  } else if(waiting) {
    label.textContent=waitingFor.submitted===true?"正在等待 Web GPT 确认":"绑定消息的发送状态待核实";
    desc.textContent=waitingFor.submitted===true?
      "绑定请求已提交到当前对话，正在等待 Web GPT 确认。":
      "无法确认绑定请求是否已经发送；请先查看目标对话或输入框，防止重复发送。";
    hint.textContent=waitingFor.submitted===true?
      "确认后会自动启用通知，无需再点其他按钮。":
      "如确认既没有消息也没有草稿，可先取消此次待核实请求，再重新连接。";
    button.textContent=waitingFor.submitted===true?"等待确认中":"发送状态待核实";button.disabled=true;
    dot.dataset.state="pending";
  } else if(current?.enabled && current.grantVerified===true) {
    label.textContent="当前对话已授权";
    desc.textContent="已绑定当前标签页。收到 Codex 完成事件后会自动通知此对话。";
    hint.textContent="浏览器提交不等于 Web GPT 审核通过；是否完成请查看审核回执。";
    button.textContent="当前对话已连接";button.disabled=true;
    dot.dataset.state="connected";
  } else if(current?.grantVerified!==true && current) {
    label.textContent="发现旧版连接，需要更新授权";
    desc.textContent="当前对话保留着旧的工作区绑定，但缺少新通信所需的验证。";
    hint.textContent="点击下方按钮会向本对话发起一次新授权，不会自动重放旧消息。";
    button.textContent="更新当前对话连接";
    dot.dataset.state="pending";
  } else if(current) {
    label.textContent="当前对话通知已暂停";
    desc.textContent="工作区与对话已经绑定，通知处于暂停状态。";
    hint.textContent="点击恢复即可继续接收新审核事件。";
    button.textContent="恢复当前对话通知";button.dataset.action="resume";
    dot.dataset.state="pending";
  } else {
    label.textContent="当前对话尚未连接";
    desc.textContent="连接后，Codex 完成任务会自动通知这条对话，由 Web GPT 审核并写回结果。";
    hint.textContent="首次连接会向当前对话发送一条授权确认请求，不读取聊天历史。";
    button.textContent="连接当前对话";
  }
  const other=routes.length-(current?1:0);
  const badge=findAuto("ui-version");
  if(badge)badge.textContent=state.version||chrome.runtime.getManifest().version;
  const legacy=findAuto("auto-workspace");
  if(current && legacy && !legacy.value)legacy.value=current.workspaceId;
  if(other>0 && !current && url)hint.textContent+=" 已有 "+other+" 条其他对话连接，不会受影响。";
}
async function autoStatus() {
  try {
    const result=await chrome.runtime.sendMessage({type:"COACH_AUTO_STATUS"});
    if(!result?.ok || !result.state)throw new Error("extension_not_ready");
    const state=result.state;
    const currentUrl=await autoPopupCurrentUrl();
    autoConnectionUI(state,currentUrl);
    const routes=Array.isArray(state.routes)?state.routes:[];
    const id=findAuto("auto-workspace").value.trim();
    const selected=routes.find(r=>r.workspaceId===id)||(routes.length===1?routes[0]:null);
    const routeList=findAuto("auto-routes");routeList.replaceChildren();
    for(const route of routes) {
      const li=document.createElement("li");
      li.textContent=route.workspaceId+" · "+(route.enabled?"通知已启用":"通知已暂停")+
        " · "+(route.grantVerified?"授权已验证":"旧版授权");
      routeList.append(li);
    }
    findAuto("auto-target").textContent=state.url||"未绑定 ChatGPT 对话";
    findAuto("auto-status").textContent=(selected?(selected.enabled?"已启用":"已暂停"):"未选择工作区")+
      " · 扩展 v"+(state.version||chrome.runtime.getManifest().version);
    findAuto("auto-diagnostic").textContent=state.blocking||
      (state.lastCheck?state.lastCheck.message+"（"+state.lastCheck.code+"）":"尚无投递检查");
    findAuto("auto-count").textContent="记录："+JSON.stringify(state.summary);
    const list=findAuto("auto-list");list.replaceChildren();
    for(const item of state.recent||[]) {
      const li=document.createElement("li");
      li.textContent=item.key+" · "+item.state+" · "+item.reason;
      if(item.state==="pending"||item.state==="needs_attention") {
        const sent=document.createElement("button");
        sent.textContent="确认已手动发送";
        sent.addEventListener("click",()=>{
          if(window.confirm("请先确认消息确实进入对应的 ChatGPT 对话。此操作不会产生 DOM 回执。继续？"))
            void resolveAuto(item.key,"mark_sent");
        });
        li.append(sent);
      }
      if(item.state==="needs_attention") {
        const retry=document.createElement("button");
        retry.textContent="确认未发出后重试";
        retry.addEventListener("click",()=>{
          if(window.confirm("必须先检查 ChatGPT 对话，确认消息尚未发出，否则可能重复发送。继续？"))
            void resolveAuto(item.key,"retry");
        });
        li.append(retry);
      }
      list.append(li);
    }
    findAuto("auto-enable").disabled=!selected||selected.enabled;
    findAuto("auto-pause").disabled=!selected||!selected.enabled;
  }catch{
    const state=findAuto("auto-connection-state");
    state.textContent="扩展后台暂不可用";
    findAuto("auto-connection-dot").dataset.state="error";
    findAuto("auto-one-click").disabled=true;
    findAuto("auto-one-click-status").textContent="请先在 Chrome 扩展程序页面重新加载 DevSpace Coach Watch。";
  }
}
for(const [id,type] of [
 ["auto-bind","COACH_AUTO_BIND"],["auto-enable","COACH_AUTO_ENABLE"],
 ["auto-pause","COACH_AUTO_PAUSE"],["auto-unbind","COACH_AUTO_UNBIND"],
 ["auto-check","COACH_AUTO_PUMP"]
])findAuto(id).addEventListener("click",async()=>{
  try {
    const result=await chrome.runtime.sendMessage({type,workspaceId:findAuto("auto-workspace").value.trim()});
    findAuto("auto-feedback").textContent=!result?.ok?(result?.error||"操作失败"):
      type==="COACH_AUTO_PUMP"?(result.state?.blocking||result.state?.lastCheck?.message||"队列已检查"):"操作成功";
  }catch{findAuto("auto-feedback").textContent="后台通信失败";}
  await autoStatus();
});
async function resolveAuto(key,action){
  try {
    const result=await chrome.runtime.sendMessage({type:"COACH_AUTO_RESOLVE",key,action});
    findAuto("auto-feedback").textContent=result?.ok?"状态已更新":(result?.error||"状态更新失败");
  }catch{findAuto("auto-feedback").textContent="状态更新失败";}
  await autoStatus();
}
findAuto("auto-cancel-pending").addEventListener("click",async()=>{
  const result=await chrome.runtime.sendMessage({type:"COACH_AUTO_BIND_CANCEL"})
    .catch(()=>({ok:false,error:"通信失败"}));
  findAuto("auto-feedback").textContent=result?.ok?
    (result.cancelled?"已取消此对话的待确认绑定":"当前对话没有待确认绑定"):
    (result?.error||"取消失败");
  await autoStatus();
});
findAuto("auto-one-click").addEventListener("click",async()=>{
  const button=findAuto("auto-one-click");
  if(button.disabled)return;
  button.disabled=true;
  const action=button.dataset.action;
  try{
    const currentUrl=await autoPopupCurrentUrl();
    const prior=await chrome.runtime.sendMessage({type:"COACH_AUTO_STATUS"});
    const route=(prior?.state?.routes||[]).find(r=>autoPopupChatUrl(r?.url)===currentUrl);
    const payload=action==="resume"&&route?{type:"COACH_AUTO_ENABLE",workspaceId:route.workspaceId}:
      {type:"COACH_AUTO_ONE_CLICK"};
    const result=await chrome.runtime.sendMessage(payload);
    findAuto("auto-feedback").textContent=result?.ok?"":(result?.error||"连接请求失败");
    if(result?.ok)findAuto("auto-one-click-status").textContent=result?.message||"已请求，等待 Web GPT 确认。";
  }catch{findAuto("auto-feedback").textContent="扩展后台通信失败";}
  await autoStatus();
});
void autoStatus();
