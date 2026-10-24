/**
 * ONEPASS-003-NATIVE-TX-004 M1 / G4: ChatGPT GUI kernel identity + native
 * thread writer ownership. Fail-closed: no GUI, no App-owned writer lock held
 * by the one managed daemon, or mismatched rollout identity => BLOCKED.
 * This module never creates/resumes a thread and never sends.
 */
import {join} from "node:path";
import {AppBridgeError} from "./coach-app-server-bridge.js";
import {parseNativeRollout,verifyThreadWriterOwnership} from "./coach-codex-native-continuity.js";
import {
 MAIN_BIN,
 type ManagedProcessInfo,
 type NativeOutboundRuntime,
 NativeOutboundError,
 assertValidThread,
 defaultCodexHome,
 fail,
 realpathOrThrow,
} from "./coach-native-outbound-types.js";
import {readManagedDaemonIdentitySync,resolveRuntime} from "./coach-native-daemon.js";

/* ------------------------------------------------------------------ *
 * G4: App GUI identity + App ownership
 * ------------------------------------------------------------------ */

interface GuiProcess {pid:number;identity:"kernel_comm"|"kernel_comm_truncated_vnode"|"argv_fallback";comm:string;command:string}

function classifyGui(runtime:NativeOutboundRuntime,processes:ManagedProcessInfo[]):GuiProcess[]{
 const commExactPath=MAIN_BIN;
 const commTruncated=MAIN_BIN.slice(0,16);
 const trusted:GuiProcess[]=[];
 for(const process of processes){
  const comm=process.comm??"";
  const command=process.cmd??"";
  const argv0=command.trim().split(/\s+/)[0]??"";
  if(comm===commExactPath){trusted.push({pid:process.pid,identity:"kernel_comm",comm,command});continue;}
  if(argv0===MAIN_BIN&&!command.includes("--type=")){trusted.push({pid:process.pid,identity:"argv_fallback",comm,command});continue;}
  if(comm===commTruncated){
   // macOS truncates kernel comm to 16 bytes; confirm through the kernel text vnode.
   let paths:string[];
   try{paths=runtime.lsofTextPaths(process.pid);}catch{
    fail("BLOCKED_APP_GUI_UNVERIFIABLE","cannot confirm truncated ChatGPT GUI kernel comm");
   }
   if(paths.some(path=>path===MAIN_BIN||safeRealpath(runtime,path)===MAIN_BIN)){
    trusted.push({pid:process.pid,identity:"kernel_comm_truncated_vnode",comm,command});
   }
  }
 }
 return trusted.sort((a,b)=>a.pid-b.pid);
}

function safeRealpath(runtime:NativeOutboundRuntime,path:string):string|undefined{
 try{return runtime.realpath(path);}catch{return undefined;}
}

/**
 * G4: the thread may only be used if the ChatGPT GUI main process is present,
 * the sole writer-lock holder is the managed daemon, and the native rollout
 * session_meta id/cwd/source match. Never creates/resumes a thread.
 */
export function verifyNativeAppOwnership(input:{
 threadId:string;
 root:string;
 codexHome?:string;
}):{threadId:string;root:string;status:string}{
 assertValidThread(input.threadId);
 const runtime=resolveRuntime(undefined);
 const codexHome=input.codexHome??defaultCodexHome();
 const root=realpathOrThrow(runtime,input.root,"ROOT_UNRESOLVABLE");
 const identity=readManagedDaemonIdentitySync(runtime,codexHome,join(codexHome,"app-server-control","app-server-control.sock"));

 const processes=runtime.listProcesses();
 const gui=classifyGui(runtime,processes);
 if(gui.length===0)fail("BLOCKED_APP_GUI_ABSENT","ChatGPT App GUI main process is not running");
 if(gui.length>1)fail("BLOCKED_APP_GUI_NOT_UNIQUE","more than one ChatGPT GUI main process");

 const lockPath=join(codexHome,"thread-writer-locks",input.threadId+".lock");
 let holdPid:number|undefined;
 try{
  const hold=verifyThreadWriterOwnership({
   threadId:input.threadId,
   codexHome,
   lockPath,
   processes:processes.map(process=>({pid:process.pid,ppid:process.ppid,uid:process.uid,cmd:process.cmd})),
   lockOwnerPids:runtime.lockOwnerPids(lockPath),
  });
  if(hold.state!=="APP_OWNED"||typeof hold.pid!=="number")
   fail("BLOCKED_APP_OWNER_REQUIRED","thread has no App-owned managed-daemon writer (unloaded thread)");
  holdPid=hold.pid;
 }catch(error){
  if(error instanceof NativeOutboundError)throw error;
  return fail("BLOCKED_THREAD_WRITER_UNVERIFIED","cannot verify thread writer: "+(error instanceof Error?error.message:String(error)));
 }
 if(holdPid!==identity.pid)fail("BLOCKED_FOREIGN_WRITER","thread writer is not the managed daemon pid");

 let rolloutPath:string;
 try{rolloutPath=runtime.findRollout(input.threadId,codexHome);}catch(error){
  if(error instanceof AppBridgeError)return fail(mapRolloutError(error.code),"thread rollout not available");
  return fail("BLOCKED_THREAD_UNREADABLE","thread rollout not available");
 }
 let raw:string;
 try{raw=runtime.readRolloutText(rolloutPath);}catch{return fail("BLOCKED_THREAD_UNREADABLE","thread rollout not readable");}
 try{
  parseNativeRollout(raw,input.threadId,root);
 }catch(error){
  if(error instanceof AppBridgeError)return fail(mapRolloutError(error.code),"thread rollout identity mismatch");
  return fail("BLOCKED_THREAD_UNREADABLE","thread rollout invalid");
 }
 return {threadId:input.threadId,root,status:"APP_OWNED"};
}

function mapRolloutError(code:string):string{
 switch(code){
  case "CODEX_NATIVE_HISTORY_MISSING":return "BLOCKED_THREAD_NOT_LOADED";
  case "CODEX_NATIVE_HISTORY_AMBIGUOUS":return "BLOCKED_THREAD_AMBIGUOUS";
  case "CODEX_NATIVE_HISTORY_TOO_LARGE":return "BLOCKED_THREAD_TOO_LARGE";
  case "CODEX_NATIVE_HISTORY_IDENTITY_INVALID":return "BLOCKED_THREAD_IDENTITY_MISMATCH";
  case "CODEX_APP_THREAD_WORKSPACE_MISMATCH":return "BLOCKED_THREAD_WORKSPACE_MISMATCH";
  case "CODEX_NATIVE_HISTORY_INVALID":return "BLOCKED_THREAD_ROLLOUT_INVALID";
  case "CODEX_APP_THREAD_ID_INVALID":return "THREAD_ID_INVALID";
  default:return "BLOCKED_THREAD_UNREADABLE";
 }
}
