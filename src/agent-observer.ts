/** Bounded, redacted live view of native Codex execution. Never stores prompts or output. */
export type ObserverKind = "start"|"status"|"tool"|"command"|"file-change"|"test"|"end";
export interface ObserverEvent { cursor:number; workspaceId:string; operationId:string; kind:ObserverKind; at:string; phase?:string; status?:string; tool?:string; basename?:string; count?:number; elapsedMs?:number; }
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE=/^[A-Za-z0-9_.:-]{1,64}$/;

/** Pure, intentionally lossy projection of untrusted Codex JSONL. No raw
 * command, output, reasoning, text, tool arguments, path, or arbitrary label
 * is ever returned. The real runner and fixture tests use this SAME parser. */
export function normalizeCodexNativeEvent(workspaceId:string,operationId:string,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return undefined;
  const value=raw as Record<string,unknown>;
  const type=value.type;
  if(typeof type!=="string")return undefined;
  if(type==="thread.started")return {workspaceId,operationId,kind:"start" as ObserverKind,phase:type,status:"RUNNING"};
  if(type==="turn.started")return {workspaceId,operationId,kind:"status" as ObserverKind,phase:type,status:"RUNNING"};
  if(type==="turn.completed")return {workspaceId,operationId,kind:"end" as ObserverKind,phase:type,status:"COMPLETED"};
  if(type==="turn.failed")return {workspaceId,operationId,kind:"end" as ObserverKind,phase:type,status:"FAILED"};
  if(type==="error")return {workspaceId,operationId,kind:"status" as ObserverKind,phase:type,status:"FAILED"};
  if(!["item.started","item.updated","item.completed"].includes(type))return undefined;
  const item=value.item;
  if(!item||typeof item!=="object"||Array.isArray(item))return undefined;
  const itemType=(item as Record<string,unknown>).type;
  const types:Record<string,{kind:ObserverKind;tool:string}>={
    command_execution:{kind:"command",tool:"shell"},
    file_change:{kind:"file-change",tool:"patch"},
    test:{kind:"test",tool:"test"},
    tool_call:{kind:"tool",tool:"tool"},
    mcp_tool_call:{kind:"tool",tool:"mcp"},
    web_search:{kind:"tool",tool:"web"},
  };
  if(typeof itemType!=="string"||!Object.prototype.hasOwnProperty.call(types,itemType))return undefined;
  const result=types[itemType];
  return {workspaceId,operationId,kind:result.kind,tool:result.tool,
    phase:type,status:type==="item.completed"?"COMPLETED":"RUNNING"};
}
export class AgentObserverStore {
  private readonly byWorkspace=new Map<string, ObserverEvent[]>(); private readonly global:ObserverEvent[]=[]; private cursor=0;
  constructor(private readonly maxEvents=2048, private readonly maxWorkspaces=32) {}
  emit(input:{workspaceId:string;operationId:string;kind:ObserverKind;phase?:unknown;status?:unknown;tool?:unknown;basename?:unknown;count?:unknown;elapsedMs?:unknown}): ObserverEvent|undefined {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)) return undefined;
    const clean=(v:unknown)=>typeof v==="string"&&SAFE.test(v)?v:undefined;
    const e:ObserverEvent={cursor:++this.cursor,workspaceId:input.workspaceId,operationId:input.operationId,kind:input.kind,at:new Date().toISOString()};
    const phase=clean(input.phase),status=clean(input.status),tool=clean(input.tool),basename=clean(input.basename);
    if(phase)e.phase=phase;if(status)e.status=status;if(tool)e.tool=tool;if(basename)e.basename=basename;
    if(Number.isSafeInteger(input.count)&&Number(input.count)>=0)e.count=Number(input.count);
    if(Number.isSafeInteger(input.elapsedMs)&&Number(input.elapsedMs)>=0)e.elapsedMs=Number(input.elapsedMs);
    if(!this.byWorkspace.has(e.workspaceId)&&this.byWorkspace.size>=this.maxWorkspaces)this.byWorkspace.delete(this.byWorkspace.keys().next().value!);
    const list=this.byWorkspace.get(e.workspaceId)??[];list.push(e);while(list.length>this.maxEvents)list.shift();this.byWorkspace.set(e.workspaceId,list);
    this.global.push(e);while(this.global.length>this.maxEvents) this.global.shift();return e;
  }
  read(workspaceId:string,cursor=0,limit=100){
    if(!ID.test(workspaceId)||!Number.isSafeInteger(cursor)||cursor<0)return {events:[],nextCursor:cursor,gap:0};
    const list=this.byWorkspace.get(workspaceId)??[], oldest=list[0]?.cursor??this.cursor+1;
    const gap=list.length>0&&cursor<oldest?oldest-cursor-1:0;
    const events=list.filter(e=>e.cursor>cursor).slice(0,Math.min(100,Math.max(1,limit)));
    return {events,nextCursor:events.at(-1)?.cursor??cursor,gap};
  }
  readGlobal(cursor=0,limit=100){
    if (!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1)
      return {events:[],nextCursor:0,gap:0,reset:false};
    // A new server generation has an independent monotonic sequence. If a
    // previously paired panel has a newer cursor, explicitly reset it.
    const reset=cursor>this.cursor;
    return {...this.readList(this.global,reset?0:cursor,limit),reset};
  }
  private readList(list:ObserverEvent[],cursor:number,limit:number){
    const oldest=list[0]?.cursor??this.cursor+1;
    const gap=list.length>0&&cursor<oldest?oldest-cursor-1:0;
    const events=list.filter(e=>e.cursor>cursor).slice(0,Math.min(100,Math.max(1,limit)));
    return {events,nextCursor:events.at(-1)?.cursor??cursor,gap};
  }
}
