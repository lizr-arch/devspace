"use strict";
const el=id=>document.getElementById(id);
let latest={paired:false,online:false,pending:0,events:[]};
function message(payload){return new Promise((resolve,reject)=>{
  chrome.runtime.sendMessage(payload,response=>{
    if(chrome.runtime.lastError) reject(new Error("extension_not_ready"));
    else resolve(response);
  });
});}
function render(value){
  latest=value||latest;
  el("status").textContent=latest.online ?
    "已连接 · 待审核 "+latest.pending+" 项" :
    (latest.paired ? "已配对但服务不可用" : "尚未配对");
  el("tasks").textContent=latest.events.length ?
    latest.events.map(e=>"#"+e.event_id+" · "+e.operation_id).join("\n") : "无待审核事件";
  el("copy").disabled=!latest.online || !latest.events.length;
}
async function reload(){
  try{
    const state=await message({type:"COACH_STATUS"});
    el("extension-id").textContent=state.extensionId||"—";
    render(state.status);
  }catch{el("feedback").textContent="扩展后台尚未就绪";}
}
el("pair").addEventListener("click",async()=>{
  const port=Number(el("port").value);
  const token=el("token").value.trim();
  el("token").value="";
  try{
    const result=await message({type:"COACH_PAIR",port,token});
    el("feedback").textContent=result.ok ? "配对成功" : "配对失败："+result.message;
  }catch{el("feedback").textContent="配对通信失败";}
  await reload();
});
el("unpair").addEventListener("click",async()=>{
  try{await message({type:"COACH_UNPAIR"});}catch{}
  el("token").value="";await reload();
});
el("refresh").addEventListener("click",async()=>{
  try{render(await message({type:"COACH_REFRESH"}));}
  catch{el("feedback").textContent="刷新失败";}
});
el("copy").addEventListener("click",async()=>{
  const ids=latest.events.map(e=>e.operation_id).join(", ");
  const instruction="请使用 DevSpace MCP 审查已完成待审核事件，读取真实源码、Git 差异、测试证据并作出裁决；不要重复运行已完成的 Agent。任务 ID："+ids;
  try{await navigator.clipboard.writeText(instruction);el("feedback").textContent="已复制，请自行发送到 ChatGPT。";}
  catch{el("feedback").textContent="复制失败，请手动记录事件 ID。";}
});
el("open-panel").addEventListener("click",()=>chrome.sidePanel.open({windowId:chrome.windows.WINDOW_ID_CURRENT}).catch(()=>{}));
void reload();
