/**
 * Native Codex Desktop continuity: never creates, resumes or writes to a
 * competing app-server. Reads only exact local session IDs and uses official
 * codex://threads/<UUID> navigation for existing App-owned conversations.
 *
 * The persisted rollout format is owned by the Codex client, not DevSpace. It
 * contains two complementary streams for the same conversation:
 *   - event_msg event/item records (canonical turn and item lifecycle)
 *   - response_item model-visible records (message/reasoning/tool calls)
 * We prefer the event_msg item records for conversational text (they exclude
 * synthesized AGENTS.md/environment preamble) and fall back to response_item
 * messages for older rollouts that have no item records. Status is IDLE only
 * when every started turn has a matching completion; anything uncertain is
 * reported as UNKNOWN.
 */
import {spawnSync} from "node:child_process";
import {lstatSync,readFileSync,readdirSync,realpathSync,existsSync} from "node:fs";
import {homedir} from "node:os";
import {join,basename,resolve,sep} from "node:path";
import {APP_THREAD_ID,AppBridgeError} from "./coach-app-server-bridge.js";

const MAX_FILE_BYTES=24_000_000;
const MAX_TEXT=16_384;
const TEXT_ITEM_TYPES=["text","Text","input_text","output_text"];
/** response_item role=user records synthesized by the client, never human turns. */
const SYNTHETIC_USER_PREFIXES=["# AGENTS.md instructions","<environment_context>","<user_instructions>","<turn_aborted>"];
export type NativeRead={thread:{threadId:string;source:"vscode";cwd:string;turns:number;status:"idle"|"unknown"};historyAvailable:true;messages:{role:"user"|"assistant";text:string}[];origin:"local_rollout"};
export interface ProcessInfo{pid:number;ppid:number;uid:number;cmd:string}

function safeDir(path:string):string[]{
 const stat=lstatSync(path),uid=process.getuid?.();
 if(stat.isSymbolicLink()||!stat.isDirectory()||(uid!==undefined&&stat.uid!==uid))throw new AppBridgeError("CODEX_NATIVE_HISTORY_PATH_UNSAFE");
 return readdirSync(path).sort();
}
function scannedDir(path:string):string[]{
 try{return safeDir(path);}catch(e){if(e instanceof AppBridgeError)throw e;throw new AppBridgeError("CODEX_NATIVE_HISTORY_MISSING");}
}
export function findCodexRollout(threadId:string,codexHome=join(homedir(),".codex")):string{
 if(!APP_THREAD_ID.test(threadId))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
 const root=join(codexHome,"sessions");
 const hits:string[]=[];
 for(const year of scannedDir(root).filter(s=>/^\d{4}$/.test(s))){
  for(const month of scannedDir(join(root,year)).filter(s=>/^(0[1-9]|1[0-2])$/.test(s))){
   for(const day of scannedDir(join(root,year,month)).filter(s=>/^(0[1-9]|[12]\d|3[01])$/.test(s))){
    for(const file of scannedDir(join(root,year,month,day)).filter(f=>f.endsWith("-"+threadId+".jsonl"))){
     const path=join(root,year,month,day,file);
     const stat=lstatSync(path);
     if(!stat.isFile()||stat.isSymbolicLink()||(process.getuid?.()!==undefined&&stat.uid!==process.getuid?.()))throw new AppBridgeError("CODEX_NATIVE_HISTORY_PATH_UNSAFE");
     if(stat.size>MAX_FILE_BYTES)throw new AppBridgeError("CODEX_NATIVE_HISTORY_TOO_LARGE");
     hits.push(path);
     if(hits.length>1)throw new AppBridgeError("CODEX_NATIVE_HISTORY_AMBIGUOUS");
    }
   }
  }
 }
 if(!hits.length)throw new AppBridgeError("CODEX_NATIVE_HISTORY_MISSING");
 return hits[0];
}

function itemText(content:unknown):string{
 if(!Array.isArray(content))return "";
 return content.map(c=>{
  if(!c||typeof c!=="object")return "";
  const item=c as {type?:unknown;text?:unknown};
  if(typeof item.type!=="string"||!TEXT_ITEM_TYPES.includes(item.type)||typeof item.text!=="string")return "";
  return item.text;
 }).filter(t=>t.trim().length>0).join("\n").trim();
}

interface ParsedMessage{role:"user"|"assistant";text:string;source:"event"|"response";id?:string}
export function parseNativeRollout(raw:string,threadId:string,root:string):{cwd:string;turns:number;status:"idle"|"unknown";messages:{role:"user"|"assistant";text:string}[]}{
 const endsWithNewline=raw.endsWith("\n");
 const lines=raw.split("\n");
 if(endsWithNewline)lines.pop();
 if(!lines.length||!lines[0].trim())throw new AppBridgeError("CODEX_NATIVE_HISTORY_INVALID");
 let metaRecord:any;
 try{metaRecord=JSON.parse(lines[0]);}catch{throw new AppBridgeError("CODEX_NATIVE_HISTORY_INVALID");}
 if(!metaRecord||typeof metaRecord!=="object"||metaRecord.type!=="session_meta"||
    !metaRecord.payload||typeof metaRecord.payload!=="object"||Array.isArray(metaRecord.payload))
  throw new AppBridgeError("CODEX_NATIVE_HISTORY_INVALID");
 const meta=metaRecord.payload;
 if(meta.id!==threadId||(meta.session_id!==undefined&&meta.session_id!==threadId)||
    meta.source!=="vscode"||typeof meta.cwd!=="string"||!meta.cwd.trim())
  throw new AppBridgeError("CODEX_NATIVE_HISTORY_IDENTITY_INVALID");
 let cwd:string,rootReal:string;
 try{cwd=realpathSync(meta.cwd);rootReal=realpathSync(root);}
 catch{throw new AppBridgeError("CODEX_APP_THREAD_WORKSPACE_MISMATCH");}
 if(cwd!==rootReal)throw new AppBridgeError("CODEX_APP_THREAD_WORKSPACE_MISMATCH");

 const messages:ParsedMessage[]=[];
 const seen=new Set<string>();
 const push=(role:"user"|"assistant",text:string,source:"event"|"response",id?:string)=>{
  const trimmed=text.slice(0,MAX_TEXT);
  if(!trimmed)return;
  const key=id?source+":"+id:source+":"+role+":"+trimmed;
  if(seen.has(key))return;
  seen.add(key);
  messages.push({role,text:trimmed,source,...(id?{id}:{})});
 };
 const started=new Set<string>(),completed=new Set<string>();
 let lastTurn:"started"|"complete"|undefined;
 for(let i=1;i<lines.length;i++){
  const line=lines[i];
  if(!line.trim())continue;
  let record:any;
  try{record=JSON.parse(line);}catch{
   // A live rollout can end in a partially flushed record. Only the final
   // unterminated line may be ignored; corruption elsewhere is refused.
   if(!endsWithNewline&&i===lines.length-1)continue;
   throw new AppBridgeError("CODEX_NATIVE_HISTORY_INVALID");
  }
  if(!record||typeof record!=="object")continue;
  const payload=record.payload;
  if(!payload||typeof payload!=="object")continue;
  if(record.type==="event_msg"){
   if(payload.type==="task_started"&&typeof payload.turn_id==="string"){
    started.add(payload.turn_id);lastTurn="started";
   }else if(payload.type==="task_complete"&&typeof payload.turn_id==="string"){
    completed.add(payload.turn_id);lastTurn="complete";
   }else if(payload.type==="item_completed"){
    const item=payload.item;
    if(!item||typeof item!=="object"||typeof item.type!=="string")continue;
    const text=itemText(item.content);
    const id=typeof item.id==="string"?item.id:undefined;
    if(item.type==="UserMessage")push("user",text,"event",id);
    else if(item.type==="AgentMessage")push("assistant",text,"event",id);
   }
  }else if(record.type==="response_item"&&payload.type==="message"&&typeof payload.role==="string"){
   const text=itemText(payload.content);
   if(!text)continue;
   const id=typeof payload.id==="string"?payload.id:undefined;
   if(payload.role==="user"){
    if(SYNTHETIC_USER_PREFIXES.some(p=>text.startsWith(p)))continue;
    push("user",text,"response",id);
   }else if(payload.role==="assistant"){
    push("assistant",text,"response",id);
   }
  }
 }
 // Prefer lifecycle item records when they carry conversational text for a
 // role; only fall back to raw model-visible messages for that role.
 const hasEvent=(role:"user"|"assistant")=>messages.some(m=>m.role===role&&m.source==="event");
 const selected=messages.filter(m=>m.source==="event"||!hasEvent(m.role));
 const turns=started.size>0?started.size:selected.filter(m=>m.role==="user").length;
 const idle=started.size>0&&lastTurn==="complete"&&[...started].every(t=>completed.has(t));
 return {cwd:meta.cwd,turns,status:idle?"idle":"unknown",messages:selected.map(({role,text})=>({role,text}))};
}

export function readNativeCodexThread(input:{threadId:string;root:string;codexHome?:string;limit?:number}):NativeRead {
 const path=findCodexRollout(input.threadId,input.codexHome);
 const raw=readFileSync(path,"utf8");
 const history=parseNativeRollout(raw,input.threadId,input.root);
 const count=Math.min(Math.max(input.limit??8,1),20);
 return {thread:{threadId:input.threadId,source:"vscode",cwd:history.cwd,turns:history.turns,status:history.status},
  historyAvailable:true,messages:history.messages.slice(-count),origin:"local_rollout"};
}

export function listProcesses():ProcessInfo[]{
 const ps=spawnSync("/bin/ps",["-axo","pid=,ppid=,uid=,command="],{encoding:"utf8",timeout:5000,maxBuffer:2_000_000});
 if(ps.error||ps.status!==0||typeof ps.stdout!=="string")throw new AppBridgeError("CODEX_NATIVE_PROCESS_INSPECTION_FAILED");
 return ps.stdout.split("\n").map(line=>{
  const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  return m?{pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),cmd:m[4]}:null;
 }).filter((v):v is ProcessInfo=>!!v);
}
function lockHolders(lockPath:string):number[]{
 const listing=spawnSync("/usr/sbin/lsof",["-nP","-F","p",lockPath],{encoding:"utf8",timeout:5000,maxBuffer:16000});
 if(listing.error||listing.status===null||listing.status===undefined||listing.status>1)
  throw new AppBridgeError("CODEX_NATIVE_PROCESS_INSPECTION_FAILED");
 const owners=[...(listing.stdout||"").matchAll(/^p(\d+)$/gm)].map(m=>Number(m[1]));
 return [...new Set(owners.filter(pid=>Number.isInteger(pid)&&pid>0))].sort((a,b)=>a-b);
}
const APP_SERVER_BIN=/^packages\/app-server-daemon\/releases\/[0-9A-Za-z._-]+\/bin\/codex$/;
/**
 * A lock holder is accepted only when it is the Codex App-owned managed
 * app-server daemon for this uid, running from this Codex home. Any other
 * holder (a Codex CLI, a stdio app-server, another uid, an unidentifiable
 * process) is a genuinely different writer and is rejected. The lock file is
 * never modified, acquired or deleted.
 */
function isAppOwnedAppServer(process:ProcessInfo,codexHome:string,uid:number|undefined):boolean{
 if(uid===undefined||process.uid!==uid)return false;
 const tokens=process.cmd.trim().split(/\s+/);
 const binary=tokens[0]||"";
 if(!binary.startsWith(codexHome+sep))return false;
 if(!APP_SERVER_BIN.test(binary.slice(codexHome.length+1)))return false;
 if(tokens[1]!=="app-server")return false;
 return tokens.includes("--managed-daemon");
}
export interface ThreadWriterHold{state:"UNLOCKED"|"APP_OWNED";pid?:number}
export function verifyThreadWriterOwnership(input:{
 threadId:string;codexHome?:string;lockPath?:string;processes?:ProcessInfo[];lockOwnerPids?:number[];uid?:number;
}):ThreadWriterHold{
 if(!APP_THREAD_ID.test(input.threadId))throw new AppBridgeError("CODEX_APP_THREAD_ID_INVALID");
 const codexHome=resolve(input.codexHome??join(homedir(),".codex"));
 const lockPath=input.lockPath??join(codexHome,"thread-writer-locks",input.threadId+".lock");
 if(!existsSync(lockPath))return{state:"UNLOCKED"};
 const stat=lstatSync(lockPath);
 const uid=input.uid??process.getuid?.();
 if(stat.isSymbolicLink()||!stat.isFile()||(uid!==undefined&&stat.uid!==uid))
  throw new AppBridgeError("CODEX_NATIVE_THREAD_LOCK_UNSAFE");
 const owners=input.lockOwnerPids??lockHolders(lockPath);
 const unique=[...new Set(owners.filter(pid=>Number.isInteger(pid)&&pid>0))];
 if(!unique.length)return{state:"UNLOCKED"};
 const processes=input.processes??listProcesses();
 const accepted:number[]=[];
 for(const pid of unique){
  const candidate=processes.find(p=>p.pid===pid);
  if(!candidate||!isAppOwnedAppServer(candidate,codexHome,uid))
   throw new AppBridgeError("CODEX_NATIVE_THREAD_HELD_BY_OTHER_APP");
  accepted.push(pid);
 }
 // More than one accepted holder would mean two App-owned writers.
 if(accepted.length!==1)throw new AppBridgeError("CODEX_NATIVE_THREAD_HELD_BY_OTHER_APP");
 return{state:"APP_OWNED",pid:accepted[0]};
}
export interface NativeOpenDeps{
 processes?:ProcessInfo[];
 lockOwnerPids?:number[];
 navigate?:(deepLink:string)=>void;
}
export function openNativeCodexThread(input:{threadId:string;root:string;codexHome?:string},deps:NativeOpenDeps={}):{state:"NAVIGATION_REQUESTED";threadId:string}{
 readNativeCodexThread({...input,limit:1});
 if(process.platform!=="darwin")throw new AppBridgeError("CODEX_NATIVE_OPEN_MAC_ONLY");
 const processes=deps.processes??listProcesses();
 const apps=processes.filter(p=>basename(p.cmd.trim().split(/\s+/)[0]||"")==="ChatGPT"&&p.cmd.includes(".app/Contents/MacOS/ChatGPT"));
 if(apps.length!==1)throw new AppBridgeError("CODEX_NATIVE_APP_NOT_UNIQUE_OR_RUNNING");
 verifyThreadWriterOwnership({threadId:input.threadId,codexHome:input.codexHome,processes,lockOwnerPids:deps.lockOwnerPids});
 const deepLink="codex://threads/"+input.threadId;
 if(deps.navigate){deps.navigate(deepLink);}
 else{
  const result=spawnSync("/usr/bin/open",[deepLink],{encoding:"utf8",timeout:7000,maxBuffer:16000});
  if(result.error||result.status!==0)throw new AppBridgeError("CODEX_NATIVE_DEEPLINK_FAILED");
 }
 return {state:"NAVIGATION_REQUESTED",threadId:input.threadId};
}
