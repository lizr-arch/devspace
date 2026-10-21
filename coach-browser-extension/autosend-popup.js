"use strict";
const findAuto = id => document.getElementById(id);
async function autoStatus() {
  const result = await chrome.runtime.sendMessage({type:"COACH_AUTO_STATUS"});
  if (!result || !result.ok) return;
  const state = result.state;
  const pending=state.pendingBinding;
  findAuto("auto-one-click-status").textContent=pending.length?
    ("已有 "+pending.length+" 条对话等待绑定确认；后台每 30 秒检查，不重复发送。"):
    "每条新对话首次点击一次，其后自动恢复；无需手动输入工作区 ID。";
  const selectedId=findAuto("auto-workspace").value.trim();
  const selectedRoute=state.routes.find(r=>r.workspaceId===selectedId)||
    (state.routes.length===1?state.routes[0]:null);
  const routeList=findAuto("auto-routes");routeList.replaceChildren();
  for(const route of state.routes) {
    const li=document.createElement("li");
    li.textContent=route.workspaceId+" · "+(route.enabled?"已启用":"已暂停")+
      " · "+(route.tabReady?"标签页已记录":"标签页需恢复");
    routeList.append(li);
  }
  findAuto("auto-target").textContent = state.url || "未绑定 ChatGPT 对话";
  findAuto("auto-status").textContent = (selectedRoute ?
    (selectedRoute.enabled ? "当前工作区已启用" : "当前工作区已暂停") :
    (state.routes.length?state.routes.length+" 个工作区已绑定":"尚未绑定工作区"))+
    " · 扩展 v" + (state.version || chrome.runtime.getManifest().version);
  findAuto("auto-diagnostic").textContent = state.blocking || (state.lastCheck ?
    ("最近检查：" + state.lastCheck.message + "（" + state.lastCheck.code + "）") :
    "还没有运行队列检查");
  findAuto("auto-count").textContent = JSON.stringify(state.summary);
  const list = findAuto("auto-list");
  list.replaceChildren();
  for (const item of state.recent) {
    const li = document.createElement("li");
    li.textContent = item.key + " " + item.state + " " + item.reason;
    if (item.state === "pending" || item.state === "needs_attention") {
      const sent = document.createElement("button");
      sent.textContent = "确认已手动发送";
      sent.addEventListener("click", () => {
        if(window.confirm("只有确认这条审核通知已经进入绑定的 ChatGPT 对话时才标记已发送。否则会漏掉审核。继续？"))
          void resolveAuto(item.key, "mark_sent");
      });
      li.append(sent);
    }
    if (item.state === "needs_attention") {
      const retry = document.createElement("button");
      retry.textContent = "确认未发出，重试";
      retry.addEventListener("click", () => {
        if (window.confirm("必须先检查绑定的 ChatGPT 对话，确认消息没有发出。否则可能重复发送。继续？"))
          void resolveAuto(item.key, "retry");
      });
      li.append(retry);
    }
    list.append(li);
  }
  const selected=selectedRoute;
  findAuto("auto-enable").disabled = !selected || selected.enabled;
  findAuto("auto-pause").disabled = !selected || !selected.enabled;
}
for (const [id,type] of [
  ["auto-bind","COACH_AUTO_BIND"],["auto-enable","COACH_AUTO_ENABLE"],
  ["auto-pause","COACH_AUTO_PAUSE"],["auto-unbind","COACH_AUTO_UNBIND"],
  ["auto-check","COACH_AUTO_PUMP"]
]) {
  findAuto(id).addEventListener("click",async () => {
    try {
      const result = await chrome.runtime.sendMessage({type,workspaceId:findAuto("auto-workspace").value.trim()});
      findAuto("auto-feedback").textContent = !result.ok ? (result.error || "操作失败") :
        type==="COACH_AUTO_PUMP" ?
        (result.state?.blocking || result.state?.lastCheck?.message || "已检查队列") : "操作成功";
      await autoStatus();
    } catch {
      findAuto("auto-feedback").textContent = "后台通信失败";
    }
  });
}
async function resolveAuto(key,action) {
  try {
    const result = await chrome.runtime.sendMessage({type:"COACH_AUTO_RESOLVE",key,action});
    findAuto("auto-feedback").textContent = result?.ok ? "状态已更新" : (result?.error || "状态更新失败");
  } catch {
    findAuto("auto-feedback").textContent = "状态更新失败";
  }
  await autoStatus();
}
findAuto("auto-cancel-pending").addEventListener("click",async()=>{
  const result=await chrome.runtime.sendMessage({type:"COACH_AUTO_BIND_CANCEL"})
    .catch(()=>({ok:false,error:"通信失败"}));
  findAuto("auto-one-click-status").textContent=result?.ok?
    (result.cancelled?"已取消此对话的待确认绑定":"该对话没有待确认绑定"):
    (result?.error||"取消失败");
  await autoStatus();
});
findAuto("auto-one-click").addEventListener("click",async()=>{
  const button=findAuto("auto-one-click");
  button.disabled=true;
  try {
    const result=await chrome.runtime.sendMessage({type:"COACH_AUTO_ONE_CLICK"});
    findAuto("auto-one-click-status").textContent=result?.ok?
      result.message:(result?.error||"一键绑定失败");
  }catch{findAuto("auto-one-click-status").textContent="扩展后台通信失败";}
  finally{button.disabled=false;await autoStatus();}
});
void autoStatus();
