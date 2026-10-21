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
    "已连接 · 待处理 "+latest.pending+" 项" :
    (latest.paired ? "已配对但服务不可用" : "尚未配对");
  el("tasks").textContent=latest.events.length ?
    latest.events.map(e=>"#"+e.event_id+" · "+(e.event_type==="PLAN_CONFLICT"?"计划冲突 · ":"")+e.operation_id).join("\n") : "无待处理事件";
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
el("pair-native").addEventListener("click",async()=>{
  try{const result=await message({type:"COACH_PAIR_NATIVE"});el("feedback").textContent=result.ok?"配对成功":("无法安全配对："+result.message);}
  catch{el("feedback").textContent="本机配对主机不可用；可继续手动配对。";}
  await reload();
});
el("refresh").addEventListener("click",async()=>{
  try{render(await message({type:"COACH_REFRESH"}));}
  catch{el("feedback").textContent="刷新失败";}
});
el("copy").addEventListener("click",async()=>{
  const reviews=latest.events.filter(e=>e.event_type!=="PLAN_CONFLICT").map(e=>e.operation_id).join(", ");
  const conflicts=latest.events.filter(e=>e.event_type==="PLAN_CONFLICT").map(e=>e.operation_id).join(", ");
  const instruction="请先查询 DevSpace MCP coach_realtime_status 并读取对应不可变证据，不要重复运行已完成的 Agent。"+
    (reviews?"独立审核以下任务的真实源码、Git 差异与测试证据并写回有证据的裁决："+reviews+"。":"")+
    (conflicts?"以下任务报告 PLAN_CONFLICT，请核对反证并明确修订契约，不要提交正式审核裁决或自动继续："+conflicts+"。":"");
  try{await navigator.clipboard.writeText(instruction);el("feedback").textContent="已复制，请自行发送到 ChatGPT。";}
  catch{el("feedback").textContent="复制失败，请手动记录事件 ID。";}
});
el("open-panel").addEventListener("click",()=>chrome.sidePanel.open({windowId:chrome.windows.WINDOW_ID_CURRENT}).catch(()=>{}));
void reload();
