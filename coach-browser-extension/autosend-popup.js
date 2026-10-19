"use strict";
const findAuto = id => document.getElementById(id);
async function autoStatus() {
  const result = await chrome.runtime.sendMessage({type:"COACH_AUTO_STATUS"});
  if (!result || !result.ok) return;
  const state = result.state;
  findAuto("auto-target").textContent = state.url || "未绑定 ChatGPT 对话";
  findAuto("auto-status").textContent = (state.enabled ? "自动发送已启用" : "自动发送已暂停") + " · 扩展 v" + (state.version || chrome.runtime.getManifest().version);
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
  findAuto("auto-enable").disabled = !state.bound || state.enabled;
  findAuto("auto-pause").disabled = !state.enabled;
}
for (const [id,type] of [
  ["auto-bind","COACH_AUTO_BIND"],["auto-enable","COACH_AUTO_ENABLE"],
  ["auto-pause","COACH_AUTO_PAUSE"],["auto-unbind","COACH_AUTO_UNBIND"],
  ["auto-check","COACH_AUTO_PUMP"]
]) {
  findAuto(id).addEventListener("click",async () => {
    try {
      const result = await chrome.runtime.sendMessage({type});
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
void autoStatus();
