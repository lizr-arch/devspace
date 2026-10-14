import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
/** Bounded, redacted live view of native Codex execution. Never stores prompts or output. */
export type ObserverKind = "start"|"status"|"tool"|"command"|"file-change"|"test"|"end";
export interface ObserverEvent { cursor:number; workspaceId:string; operationId:string; kind:ObserverKind; at:string; phase?:string; status?:string; tool?:string; actionId?:string; inputHash?:string; sourceMutation?:boolean; basename?:string; count?:number; elapsedMs?:number; }
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
  // A native error may be a recoverable retry. The verified final state
  // comes from turn completion + process exit, not this intermediate event.
  if(type==="error")return {workspaceId,operationId,kind:"status" as ObserverKind,phase:type,status:"RETRYING"};
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
  const data=item as Record<string,unknown>;
  const nativeId=data.id;
  const normalizedId=typeof nativeId==="string"?nativeId:
    Number.isSafeInteger(nativeId)&&Number(nativeId)>=0?String(nativeId):undefined;
  // Native item identity is only for the PRIVATE audit correlation path. The
  // AgentObserverStore deliberately drops it from the public live feed.
  const actionId=normalizedId && ID.test(normalizedId) ? normalizedId : undefined;
  const command=data.command;
  const inputHash=type==="item.started" && itemType==="command_execution" &&
    typeof command==="string" && command.length>0 && command.length<=32768
    ? createHash("sha256").update(command).digest("hex") : undefined;
  return {workspaceId,operationId,kind:result.kind,tool:result.tool,actionId,inputHash,
    sourceMutation:type==="item.completed" && itemType==="file_change" && data.status!=="failed",
    phase:type,status:type==="item.completed"?"COMPLETED":"RUNNING"};
}
export class AgentObserverStore {
  private readonly byWorkspace=new Map<string, ObserverEvent[]>(); private readonly global:ObserverEvent[]=[]; private cursor=0;
  private readonly db?:Database.Database;
  constructor(private readonly maxEvents=2048, private readonly maxWorkspaces=32, databasePath?:string) {
    if(databasePath){
      const target=resolve(databasePath),parent=dirname(target);
      mkdirSync(parent,{recursive:true,mode:0o700});
      const canonicalTarget=join(realpathSync(parent),basename(target));
      try{if(realpathSync(canonicalTarget)!==canonicalTarget||!statSync(canonicalTarget).isFile())throw new Error("COACH_OBSERVER_DATABASE_PATH_UNSAFE");}
      catch(error){if(!(error instanceof Error&&"code" in error&&(error as NodeJS.ErrnoException).code==="ENOENT"))throw error;}
      this.db=new Database(canonicalTarget);
      this.db.pragma("journal_mode = WAL");this.db.pragma("busy_timeout = 10000");
      this.db.exec("CREATE TABLE IF NOT EXISTS native_agent_observer_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS native_agent_observer_workspace_cursor ON native_agent_observer_events(workspace_id,cursor)");
      chmodSync(canonicalTarget,0o600);chmodSync(realpathSync(parent),0o700);
      this.cursor=Number((this.db.prepare("SELECT coalesce(max(cursor),0) AS cursor FROM native_agent_observer_events").get() as {cursor:number}).cursor);
    }
  }
  emit(input:{workspaceId:string;operationId:string;kind:ObserverKind;phase?:unknown;status?:unknown;tool?:unknown;basename?:unknown;count?:unknown;elapsedMs?:unknown}): ObserverEvent|undefined {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)) return undefined;
    const clean=(v:unknown)=>typeof v==="string"&&SAFE.test(v)?v:undefined;
    const e:ObserverEvent={cursor:0,workspaceId:input.workspaceId,operationId:input.operationId,kind:input.kind,at:new Date().toISOString()};
    const phase=clean(input.phase),status=clean(input.status),tool=clean(input.tool),basename=clean(input.basename);
    if(phase)e.phase=phase;if(status)e.status=status;if(tool)e.tool=tool;if(basename)e.basename=basename;
    if(Number.isSafeInteger(input.count)&&Number(input.count)>=0)e.count=Number(input.count);
    if(Number.isSafeInteger(input.elapsedMs)&&Number(input.elapsedMs)>=0)e.elapsedMs=Number(input.elapsedMs);
    if(this.db){
      this.db.transaction(()=>{
        const inserted=this.db!.prepare("INSERT INTO native_agent_observer_events(workspace_id,operation_id,event_json) VALUES (?,?,?)").run(e.workspaceId,e.operationId,"{}");
        e.cursor=Number(inserted.lastInsertRowid);this.cursor=e.cursor;
        this.db!.prepare("UPDATE native_agent_observer_events SET event_json=? WHERE cursor=?").run(JSON.stringify(e),e.cursor);
        this.db!.exec("DELETE FROM native_agent_observer_events WHERE cursor <= (SELECT coalesce(max(cursor),0)-32768 FROM native_agent_observer_events)");
      }).immediate();
    }else e.cursor=++this.cursor;
    if(!this.byWorkspace.has(e.workspaceId)&&this.byWorkspace.size>=this.maxWorkspaces)this.byWorkspace.delete(this.byWorkspace.keys().next().value!);
    const list=this.byWorkspace.get(e.workspaceId)??[];list.push(e);while(list.length>this.maxEvents)list.shift();this.byWorkspace.set(e.workspaceId,list);
    this.global.push(e);while(this.global.length>this.maxEvents) this.global.shift();return e;
  }
  read(workspaceId:string,cursor=0,limit=100){
    if(!ID.test(workspaceId)||!Number.isSafeInteger(cursor)||cursor<0||
       !Number.isSafeInteger(limit)||limit<1)
      return {events:[],nextCursor:0,gap:0,reset:false};
    // The observer is in memory. A new DevSpace boot restarts its sequence.
    // A Web GPT client resuming with its previous boot cursor must resync.
    if(this.db){
      const newest=Number((this.db.prepare("SELECT coalesce(max(cursor),0) AS cursor FROM native_agent_observer_events").get() as {cursor:number}).cursor);
      const reset=cursor>newest,requested=reset?0:cursor;
      const oldest=this.db.prepare("SELECT min(cursor) AS cursor FROM native_agent_observer_events WHERE workspace_id=?").get(workspaceId) as {cursor:number|null};
      const first=oldest.cursor??newest+1;
      const gap=oldest.cursor!==null&&requested<first-1?first-requested-1:0;
      const rows=this.db.prepare("SELECT event_json FROM native_agent_observer_events WHERE workspace_id=? AND cursor>? ORDER BY cursor LIMIT ?").all(workspaceId,requested,Math.min(100,limit)) as {event_json:string}[];
      const events=rows.map(row=>JSON.parse(row.event_json) as ObserverEvent);
      return {events,nextCursor:events.at(-1)?.cursor??requested,gap,reset};
    }
    const reset=cursor>this.cursor,requested=reset?0:cursor;
    const list=this.byWorkspace.get(workspaceId)??[],oldest=list[0]?.cursor??this.cursor+1;
    const gap=list.length>0&&requested<oldest?oldest-requested-1:0;
    const events=list.filter(e=>e.cursor>requested).slice(0,Math.min(100,limit));
    return {events,nextCursor:events.at(-1)?.cursor??requested,gap,reset};
  }
  readGlobal(cursor=0,limit=100){
    if (!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1)
      return {events:[],nextCursor:0,gap:0,reset:false};
    // A new server generation has an independent monotonic sequence. If a
    // previously paired panel has a newer cursor, explicitly reset it.
    if(this.db){
      const newest=Number((this.db.prepare("SELECT coalesce(max(cursor),0) AS cursor FROM native_agent_observer_events").get() as {cursor:number}).cursor);
      const reset=cursor>newest,requested=reset?0:cursor;
      const oldest=Number((this.db.prepare("SELECT coalesce(min(cursor),0) AS cursor FROM native_agent_observer_events").get() as {cursor:number}).cursor);
      const gap=oldest>0&&requested<oldest-1?oldest-requested-1:0;
      const rows=this.db.prepare("SELECT event_json FROM native_agent_observer_events WHERE cursor>? ORDER BY cursor LIMIT ?").all(requested,Math.min(100,limit)) as {event_json:string}[];
      const events=rows.map(row=>JSON.parse(row.event_json) as ObserverEvent);
      return {events,nextCursor:events.at(-1)?.cursor??requested,gap,reset};
    }
    const reset=cursor>this.cursor;
    return {...this.readList(this.global,reset?0:cursor,limit),reset};
  }
  close():void{this.db?.close();}
  latestCursor():number {
    if(!this.db)return this.cursor;
    return Number((this.db.prepare("SELECT coalesce(max(cursor),0) AS cursor FROM native_agent_observer_events").get() as {cursor:number}).cursor);
  }
  private readList(list:ObserverEvent[],cursor:number,limit:number){
    const oldest=list[0]?.cursor??this.cursor+1;
    const gap=list.length>0&&cursor<oldest?oldest-cursor-1:0;
    const events=list.filter(e=>e.cursor>cursor).slice(0,Math.min(100,Math.max(1,limit)));
    return {events,nextCursor:events.at(-1)?.cursor??cursor,gap};
  }
}
