"use strict";
// The side panel is extension-owned. It never reads ChatGPT's DOM.
const byId=id=>document.getElementById(id);
const state=byId("state"),note=byId("note"),taskList=byId("tasks"),
  eventList=byId("events"),pause=byId("pause"),
  auditSummary=byId("auditSummary"),auditFindings=byId("auditFindings"),
  auditEvidence=byId("auditEvidence");
let cursor=0,paused=false,busy=false,selectedKey="";
const tasks=new Map(),timeline=[];
function el(tag,value,cls){
  const e=document.createElement(tag);
  e.textContent=String(value??"");
  if(cls)e.className=cls;
  return e;
}
function time(s){
  const d=new Date(s);
  return Number.isNaN(d.getTime())?"--:--:--":d.toLocaleTimeString("zh-CN",{hour12:false});
}
function clearAudit(message){
  if(auditSummary)auditSummary.textContent=message;
  auditFindings?.replaceChildren();
  auditEvidence?.replaceChildren();
}
async function showAudit(task){
  const key=task.workspace+"\0"+task.op;
  selectedKey=key;
  clearAudit("正在读取本地审计…");
  try{
    const r=await chrome.runtime.sendMessage({
      type:"COACH_AGENT_AUDIT",workspaceId:task.workspace,operationId:task.op
    });
    if(selectedKey!==key)return;
    if(!r?.ok||!r.snapshot){
      clearAudit("审计不可用："+String(r?.error||"unknown").slice(0,64));
      return;
    }
    const a=r.snapshot;
    const tokens=a.tokenUsage||{};
    const meta=a.dataCoverage||{};
    if(auditSummary)auditSummary.textContent=[
      task.op,"运行结果 "+String(a.status).slice(0,32),
      "耗时 "+Math.round(a.elapsedMs)+"ms",
      "确认完成工具 "+a.confirmedToolCompletions+"/"+a.confirmedToolStarts,
      "输入 Token "+(tokens.input_tokens??"未知"),
      "输出 Token "+(tokens.output_tokens??"未知"),
      "覆盖 "+(meta.complete?"完整":"有限")
    ].join(" · ");
    auditFindings?.replaceChildren();
    const findings=Array.isArray(a.observations)?a.observations.slice(0,16):[];
    if(!findings.length)auditFindings?.append(el("li","未识别到规则性异常；不代表操作一定高效。","muted"));
    for(const f of findings){
      const li=el("li","");
      li.append(el("div",String(f.claim||"未知发现").slice(0,400),"tag"));
      li.append(el("div",String(f.recommendation||"").slice(0,400),"detail"));
      li.append(el("small","证据 "+(Array.isArray(f.evidenceEventIds)?f.evidenceEventIds.slice(0,8).join(","):"无")+
        " · 置信度 "+String(f.confidence||"未知").slice(0,16)));
      auditFindings?.append(li);
    }
    auditEvidence?.replaceChildren();
    const missing=Array.isArray(meta.missingEvidence)?meta.missingEvidence.slice(0,12):[];
    auditEvidence?.append(el("li","证据局限："+(missing.length?missing.join("、"):"未报告")));
    for(const e of (Array.isArray(a.evidenceTimeline)?a.evidenceTimeline.slice(-16):[])){
      auditEvidence?.append(el("li",[
        "#"+String(e.id||"").slice(0,32),String(e.kind||"").slice(0,32),
        String(e.phase||"").slice(0,40),time(e.at)
      ].join(" · ")));
    }
  }catch{
    if(selectedKey===key)clearAudit("审计不可用：本地连接中断");
  }
}
function draw(){
  taskList.replaceChildren();
  const items=[...tasks.values()].sort((a,b)=>b.cursor-a.cursor).slice(0,8);
  if(!items.length)taskList.append(el("li","尚无本地 Codex 事件","muted"));
  for(const t of items){
    const li=el("li",""),row=el("div","","row"),summary=el("div","");
    summary.append(el("div",t.op,"tag"),el("small","工作区 "+t.workspace+" · "+time(t.at)));
    row.append(summary,el("span",t.status,"status"));
    const open=el("button","查看审计");
    open.addEventListener("click",()=>void showAudit(t));
    li.append(row,open);
    taskList.append(li);
  }
  eventList.replaceChildren();
  if(!timeline.length)eventList.append(el("li","等待新事件…","muted"));
  for(const e of timeline){
    const li=el("li",""),top=el("div","","row");
    top.append(el("span",e.kind,"tag"),el("time",time(e.at),"time"));
    li.append(top,el("div",[e.operationId,e.phase,e.status].filter(Boolean).join(" · "),"detail"));
    eventList.append(li);
  }
}
function render(b){
  if(!b||!b.paired){
    state.textContent="未配对";
    note.textContent="请在 COACH 扩展弹窗完成配对。";
    cursor=0;tasks.clear();timeline.length=0;selectedKey="";
    clearAudit("需要重新配对本地 COACH 服务。");
    draw();return;
  }
  if(!b.online){
    state.textContent="服务离线";
    note.textContent="已收集事件保留，恢复连接后自动续读。";return;
  }
  state.textContent="实时观察中";
  if(b.reset||b.gap){
    if(b.reset)cursor=0;
    tasks.clear();timeline.length=0;
  }
  const received=[];
  for(const e of b.events||[]){
    if(!Number.isSafeInteger(e?.cursor)||e.cursor<=cursor||
       typeof e.workspaceId!=="string"||typeof e.operationId!=="string"||
       typeof e.kind!=="string")continue;
    cursor=e.cursor;received.push(e);
    const key=e.workspaceId+"\0"+e.operationId,prev=tasks.get(key);
    const final=e.phase==="runner.finalized";
    const status=final?e.status:(prev?.status??(e.kind==="start"?"RUNNING":"状态未知（历史不完整）"))??"UNKNOWN";
    tasks.set(key,{op:e.operationId,workspace:e.workspaceId,status,at:e.at,cursor});
  }
  if(Number.isSafeInteger(b.nextCursor)&&b.nextCursor>cursor)cursor=b.nextCursor;
  timeline.unshift(...received.reverse());
  if(timeline.length>120)timeline.length=120;
  note.textContent=(b.reset?"服务已重启，已重置游标 · ":"")+
    (b.gap?"历史缺失 "+b.gap+" 条 · ":"")+
    (received.length?"新增 "+received.length+" 条":"暂无新事件")+" · 1.5 秒刷新";
  draw();
}
async function refresh(){
  if(paused||busy)return;
  busy=true;
  try{render(await chrome.runtime.sendMessage({type:"COACH_AGENT_EVENTS",cursor}));}
  catch{state.textContent="扩展暂不可用";}
  finally{busy=false;}
}
pause.addEventListener("click",()=>{
  paused=!paused;pause.textContent=paused?"继续更新":"暂停更新";
  if(paused){state.textContent="已暂停观察";note.textContent="暂停不会停止本地 Codex。";}
  else void refresh();
});
draw();void refresh();
const timer=setInterval(refresh,1500);
window.addEventListener("pagehide",()=>clearInterval(timer));
