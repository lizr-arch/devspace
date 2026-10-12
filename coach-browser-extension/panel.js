"use strict";
const byId=id=>document.getElementById(id);
const state=byId("state"),note=byId("note"),taskList=byId("tasks"),eventList=byId("events"),pause=byId("pause");
let cursor=0,paused=false,busy=false;
const tasks=new Map(),timeline=[];
function el(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
function time(s){const d=new Date(s);return Number.isNaN(d.getTime())?"--:--:--":d.toLocaleTimeString("zh-CN",{hour12:false});}
function draw(){
  taskList.replaceChildren();
  const items=[...tasks.values()].sort((a,b)=>b.cursor-a.cursor).slice(0,8);
  if(!items.length)taskList.append(el("li","尚无本地 Codex 事件","muted"));
  for(const t of items){
    const li=el("li",""),row=el("div","","row"),summary=el("div","");
    summary.append(el("div",t.op,"tag"),el("small","工作区 "+t.workspace+" · "+time(t.at)));
    row.append(summary,el("span",t.status,"status"));li.append(row);taskList.append(li);
  }
  eventList.replaceChildren();
  if(!timeline.length)eventList.append(el("li","等待新事件…","muted"));
  for(const e of timeline){const li=el("li",""),top=el("div","","row");
    top.append(el("span",e.kind,"tag"),el("time",time(e.at),"time"));
    li.append(top,el("div",[e.operationId,e.phase,e.status].filter(Boolean).join(" · "),"detail"));
    eventList.append(li);
  }
}
function render(b){
  if(!b||!b.paired){state.textContent="未配对";note.textContent="请在 COACH 扩展弹窗完成配对。";cursor=0;tasks.clear();timeline.length=0;draw();return;}
  if(!b.online){state.textContent="服务离线";note.textContent="已收集事件保留，恢复连接后自动续读。";return;}
  state.textContent="实时观察中";
  // A lost segment may contain a terminal event; never retain stale RUNNING
  // summaries or claim a task is still alive after a retention gap.
  if(b.reset||b.gap){if(b.reset)cursor=0;tasks.clear();timeline.length=0;}
  const received=[];
  for(const e of b.events||[]){
    if(!Number.isSafeInteger(e?.cursor)||e.cursor<=cursor||typeof e.workspaceId!=="string"||typeof e.operationId!=="string"||typeof e.kind!=="string")continue;
    cursor=e.cursor;received.push(e);
    const key=e.workspaceId+"\0"+e.operationId,prev=tasks.get(key);
    const final=e.phase==="runner.finalized";
    const status=final?e.status:(prev?.status??(e.kind==="start"?"RUNNING":"状态未知（历史不完整）"))??"UNKNOWN";
    tasks.set(key,{op:e.operationId,workspace:e.workspaceId,status,at:e.at,cursor});
  }
  if(Number.isSafeInteger(b.nextCursor)&&b.nextCursor>cursor)cursor=b.nextCursor;
  timeline.unshift(...received.reverse());if(timeline.length>120)timeline.length=120;
  note.textContent=(b.reset?"服务已重启，已重置游标 · ":"")+(b.gap?"历史缺失 "+b.gap+" 条 · ":"")+(received.length?"新增 "+received.length+" 条":"暂无新事件")+" · 1.5 秒刷新";
  draw();
}
async function refresh(){if(paused||busy)return;busy=true;try{render(await chrome.runtime.sendMessage({type:"COACH_AGENT_EVENTS",cursor}));}catch{state.textContent="扩展暂不可用";}finally{busy=false;}}
pause.addEventListener("click",()=>{paused=!paused;pause.textContent=paused?"继续更新":"暂停更新";if(paused){state.textContent="已暂停观察";note.textContent="暂停不会停止本地 Codex。";}else void refresh();});
draw();void refresh();const timer=setInterval(refresh,1500);window.addEventListener("pagehide",()=>clearInterval(timer));