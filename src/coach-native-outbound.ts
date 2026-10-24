/**
 * ONEPASS-003-NATIVE-TX-004 M1: safe native Codex App outbound delivery core.
 *
 * This module is the only sanctioned way for DevSpace/Web GPT tooling to ask the
 * ChatGPT App-owned Codex daemon to execute one message on one native thread. It
 * implements the fail-closed contract proven in
 * evidence/onepass-003/queue/CONTRACT.md (G1-G10):
 *
 *  G1  managed-daemon identity: daemon.pid + live process + executable under
 *      <codexHome>/packages/app-server-daemon/releases/<ver>/bin/codex + argv
 *      `app-server ... --managed-daemon` + canonical socket alias/realpath +
 *      WS GET /rpc 101 + exactly one managed daemon.
 *  G2  explicit routing: argv must contain `--remote unix://<canonical realpath>`;
 *      the default (implicit) queue backend is never used.
 *  G4  App ownership: the ChatGPT GUI main process must be present (kernel comm /
 *      argv exact, never a helper substring), the thread writer-lock holder must be
 *      the managed daemon, and the native rollout session_meta id/cwd/source must
 *      match. Unloaded threads without an App-owned writer are BLOCKED; this module
 *      never calls thread/start, thread/resume or turn/start.
 *  G5  cross-process ledger: O_EXCL create under
 *      <stateDir>/native-outbound/<sha256(workspaceId\0operationId)>.json; a second
 *      process with the same operationId never reaches the CLI.
 *  G6/G10 post-send observation: queue exit 0 is only ACCEPTED; the exact user
 *      content sha256 must appear as one new logical turn (multiple projections of
 *      the same turn/item count once) => TURN_OBSERVED; task_started+task_complete
 *      => COMPLETED; assistant reply correlated to that turn => REPLY_VERIFIED.
 *      Timeouts are persisted as UNCERTAIN and are never retried.
 *
 * All side effects go through `NativeOutboundRuntime`, so tests never spawn the
 * real CLI, never touch the real daemon/App, and never write production state.
 * The runtime is injectable per call (`deps.runtime`) and globally for tests
 * (`setNativeOutboundTestRuntime`). Production callers pass no test overrides.
 */
import {createHash,randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
 closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readlinkSync,realpathSync,renameSync,statSync,writeFileSync,
 type Stats,
} from "node:fs";
import {connect} from "node:net";
import {homedir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
import {APP_THREAD_ID,AppBridgeError} from "./coach-app-server-bridge.js";
import {
 findCodexRollout,parseNativeRollout,verifyThreadWriterOwnership,type ProcessInfo,
} from "./coach-codex-native-continuity.js";

/* ------------------------------------------------------------------ *
 * Public state / receipt / error types (API fixed by task-9)
 * ------------------------------------------------------------------ */

export type NativeOutboundState =
 | "PRESEND" | "ACCEPTED" | "TURN_OBSERVED" | "COMPLETED" | "REPLY_VERIFIED" | "UNCERTAIN" | "BLOCKED";

export interface NativeOutboundReceipt {
 state:NativeOutboundState;
 workspaceId:string;
 operationId:string;
 threadId:string;
 payloadSha256:string;
 createdAt:number;
 updatedAt:number;
 queueMessageId?:string;
 queueExitCode?:number;
 turnId?:string;
 userItemId?:string;
 reply?:string;
 replySha256?:string;
 error?:string;
 uncertaintyReason?:string;
}

export class NativeOutboundError extends Error {
 readonly code:string;
 constructor(code:string,message?:string){
  super(message??code);
  this.name="NativeOutboundError";
  this.code=code;
 }
}

/** daemon.pid shape is owned by Codex; validate defensively instead of trusting it. */
interface DaemonPidFile {
 pid:number;
 processStartTime?:string;
 processIdentity?:{bootId?:string;uniqueId?:number;startSeconds?:number;startMicroseconds?:number};
 executableIdentity?:{digest?:number[];path_digest?:number[]};
}

export interface ManagedDaemonIdentity {
 pid:number;
 version:string;
 executable:string;
 socketPath:string;
 socketRealpath:string;
 codexHome:string;
 bootId:string;
 startSeconds:number;
}

/* ------------------------------------------------------------------ *
 * Injectable runtime (tests replace this; production uses the real impl)
 * ------------------------------------------------------------------ */

export interface ManagedProcessInfo {
 pid:number;
 ppid:number;
 uid:number;
 cmd:string;
 comm:string;
}

export interface FileStatLike {
 isSymbolicLink():boolean;
 isFile():boolean;
 isDirectory():boolean;
 isSocket():boolean;
 uid:number;
 mode:number;
 size:number;
 mtimeMs:number;
}

export interface QueueRunResult {
 code:number|null;
 stdout:string;
 stderr:string;
 /** "TIMEOUT" when the CLI did not finish inside the configured timeout. */
 error?:string;
}

export interface NativeOutboundRuntime {
 uid:number;
 listProcesses():ManagedProcessInfo[];
 lockOwnerPids(lockPath:string):number[];
 lsofTextPaths(pid:number):string[];
 readText(path:string):string;
 lstat(path:string):FileStatLike;
 readlink(path:string):string;
 realpath(path:string):string;
 statFile(path:string):{size:number;mtimeMs:number};
 probeWebSocket(socketPath:string):Promise<boolean>;
 runQueue(input:{codexBin:string;argv:string[];env:Record<string,string|undefined>;timeoutMs:number}):QueueRunResult;
 findRollout(threadId:string,codexHome:string):string;
 readRolloutText(path:string):string;
 sleep(ms:number):Promise<void>;
 now():number;
}

export interface NativeOutboundDeps {
 codexHome?:string;
 socketPath?:string;
 codexBin?:string;
 timeoutMs?:number;
 observeTimeoutMs?:number;
 pollMs?:number;
 runtime?:Partial<NativeOutboundRuntime>;
 /** High-level test seams; production leaves these undefined. */
 inspectDaemon?:(opts:{codexHome:string;socketPath:string})=>Promise<ManagedDaemonIdentity>;
 verifyOwnership?:(input:{threadId:string;root:string;codexHome:string;socketPath:string})=>{threadId:string;root:string;status:string};
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const MAX_PROMPT=10_000;
const MANAGED_DAEMON_BIN=/^packages\/app-server-daemon\/releases\/([^/]+)\/bin\/codex$/;
const CANONICAL_SOCKET_TARGET=/^\/private\/tmp\/codex-daemon-(\d+)\/[a-f0-9]{64}$/;
const OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WORKSPACE_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAIN_BIN="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const RANK:Record<string,number>={PRESEND:0,ACCEPTED:1,TURN_OBSERVED:2,COMPLETED:3,REPLY_VERIFIED:4};

export function sha256Hex(value:string|Buffer):string{
 return createHash("sha256").update(value).digest("hex");
}

function defaultCodexHome():string{
 return process.env.CODEX_HOME??join(homedir(),".codex");
}

function fail(code:string,message?:string):never{
 throw new NativeOutboundError(code,message);
}

function errnoCode(error:unknown):string|undefined{
 return (error as NodeJS.ErrnoException|undefined)?.code;
}

function assertValidOperation(workspaceId:string,operationId:string):void{
 if(!WORKSPACE_ID.test(workspaceId))fail("WORKSPACE_ID_INVALID","invalid workspaceId");
 if(!OPERATION_ID.test(operationId))fail("OPERATION_ID_INVALID","invalid operationId");
}

function assertValidThread(threadId:string):void{
 if(!APP_THREAD_ID.test(threadId))fail("THREAD_ID_INVALID","thread id must be a canonical UUID");
}

function realpathOrThrow(runtime:NativeOutboundRuntime,path:string,code:string):string{
 try{return runtime.realpath(path);}catch{return fail(code,"cannot resolve "+path);}
}

/* ------------------------------------------------------------------ *
 * Default real runtime
 * ------------------------------------------------------------------ */

function parsePsField(out:string):Map<number,string>{
 const map=new Map<number,string>();
 for(const line of out.split("\n")){
  if(!line.trim())continue;
  const m=/^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  if(m)map.set(Number(m[1]),m[2]);
 }
 return map;
}

function realListProcesses():ManagedProcessInfo[]{
 const comm=spawnSync("/bin/ps",["-axo","pid=,comm="],{encoding:"utf8",timeout:5000,maxBuffer:4_000_000});
 const cmd=spawnSync("/bin/ps",["-axo","pid=,ppid=,uid=,command=","-ww"],{encoding:"utf8",timeout:5000,maxBuffer:8_000_000});
 if(comm.error||comm.status!==0||cmd.error||cmd.status!==0)throw new NativeOutboundError("PROCESS_INSPECTION_FAILED");
 const commMap=parsePsField(comm.stdout||"");
 const result:ManagedProcessInfo[]=[];
 for(const line of (cmd.stdout||"").split("\n")){
  if(!line.trim())continue;
  const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if(!m)continue;
  const pid=Number(m[1]);
  result.push({pid,ppid:Number(m[2]),uid:Number(m[3]),cmd:m[4],comm:commMap.get(pid)??""});
 }
 return result;
}

function realLsofPids(lockPath:string):number[]{
 const listing=spawnSync("/usr/sbin/lsof",["-nP","-F","p",lockPath],{encoding:"utf8",timeout:5000,maxBuffer:16000});
 if(listing.error||listing.status===null||listing.status===undefined||listing.status>1)
  throw new NativeOutboundError("PROCESS_INSPECTION_FAILED");
 const owners=[...(listing.stdout||"").matchAll(/^p(\d+)$/gm)].map(m=>Number(m[1]));
 return [...new Set(owners.filter(pid=>Number.isInteger(pid)&&pid>0))].sort((a,b)=>a-b);
}

function realLsofTextPaths(pid:number):string[]{
 const result=spawnSync("/usr/sbin/lsof",["-a","-p",String(pid),"-d","txt","-Fn"],{encoding:"utf8",timeout:5000,maxBuffer:1_000_000});
 if(result.error)throw new NativeOutboundError("PROCESS_INSPECTION_FAILED");
 if(result.status===0){
  return (result.stdout||"").split("\n").filter(line=>line.startsWith("n")).map(line=>line.slice(1));
 }
 if(result.status===1&&!(result.stderr||"").trim())return [];
 throw new NativeOutboundError("PROCESS_INSPECTION_FAILED");
}

function realProbeWebSocket(socketPath:string):Promise<boolean>{
 return new Promise(resolveProbe=>{
  const key=randomBytes(16).toString("base64");
  const socket=connect(socketPath);
  let buffer="";
  let settled=false;
  const finish=(ok:boolean)=>{
   if(settled)return;
   settled=true;
   socket.destroy();
   resolveProbe(ok);
  };
  socket.setTimeout(3000,()=>finish(false));
  socket.on("connect",()=>socket.write(
   "GET /rpc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
   "Sec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n"));
  socket.on("data",chunk=>{
   buffer+=chunk.toString("latin1");
   const end=buffer.indexOf("\r\n\r\n");
   if(end<0)return;
   finish(/^HTTP\/1\.[01] 101(?:\s|$)/.test(buffer.split("\r\n")[0]));
  });
  socket.on("error",()=>finish(false));
  socket.on("close",()=>finish(false));
 });
}

function statLike(stat:Stats):FileStatLike{
 return {
  isSymbolicLink:()=>stat.isSymbolicLink(),
  isFile:()=>stat.isFile(),
  isDirectory:()=>stat.isDirectory(),
  isSocket:()=>stat.isSocket(),
  uid:stat.uid,
  mode:stat.mode,
  size:stat.size,
  mtimeMs:stat.mtimeMs,
 };
}

function makeRealRuntime():NativeOutboundRuntime{
 return {
  uid:process.getuid?.()??501,
  listProcesses:realListProcesses,
  lockOwnerPids:realLsofPids,
  lsofTextPaths:realLsofTextPaths,
  readText:path=>readFileSync(path,"utf8"),
  lstat:path=>statLike(lstatSync(path)),
  readlink:path=>readlinkSync(path),
  realpath:path=>realpathSync(path),
  statFile:path=>{const s=statSync(path);return{size:s.size,mtimeMs:s.mtimeMs};},
  probeWebSocket:realProbeWebSocket,
  runQueue:input=>{
   const result=spawnSync(input.codexBin,input.argv,{
    encoding:"utf8",timeout:input.timeoutMs,maxBuffer:4_000_000,env:input.env as NodeJS.ProcessEnv,
   });
   if(result.error){
    const code=errnoCode(result.error);
    return{code:null,stdout:result.stdout??"",stderr:result.stderr??"",error:code==="ETIMEDOUT"?"TIMEOUT":(code??"SPAWN_FAILED")};
   }
   return{code:result.status,stdout:result.stdout??"",stderr:result.stderr??""};
  },
  findRollout:(threadId,codexHome)=>findCodexRollout(threadId,codexHome),
  readRolloutText:path=>readFileSync(path,"utf8"),
  sleep:ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms)),
  now:()=>Date.now(),
 };
}

const REAL_RUNTIME=makeRealRuntime();
const TEST_RUNTIME_KEY="__devspaceNativeOutboundTestRuntime";
interface RuntimeTestState { overrides?:Partial<NativeOutboundRuntime> }

/**
 * Test-only seam: install runtime overrides (process list, lsof, socket probe,
 * queue runner, clock) so unit tests never touch the real daemon/App/CLI.
 * Production code must never call this.
 */
export function setNativeOutboundTestRuntime(overrides?:Partial<NativeOutboundRuntime>):void{
 const holder=globalThis as unknown as Record<string,RuntimeTestState|undefined>;
 holder[TEST_RUNTIME_KEY]=overrides?{overrides}:undefined;
}

function resolveRuntime(overrides?:Partial<NativeOutboundRuntime>):NativeOutboundRuntime{
 const holder=globalThis as unknown as Record<string,RuntimeTestState|undefined>;
 const installed=holder[TEST_RUNTIME_KEY]?.overrides;
 const base=REAL_RUNTIME;
 return {...base,...(installed??{}),...(overrides??{})};
}

function depsRuntime(deps:NativeOutboundDeps|undefined):Partial<NativeOutboundRuntime>|undefined{
 return deps?.runtime;
}

/* ------------------------------------------------------------------ *
 * G1: managed daemon identity
 * ------------------------------------------------------------------ */

function readDaemonPidFile(runtime:NativeOutboundRuntime,path:string):DaemonPidFile{
 let raw:string;
 try{raw=runtime.readText(path);}catch(error){
  if(errnoCode(error)==="ENOENT")fail("DAEMON_PID_MISSING","daemon.pid is missing");
  return fail("DAEMON_PID_UNREADABLE","cannot read daemon.pid");
 }
 let parsed:unknown;
 try{parsed=JSON.parse(raw);}catch{return fail("DAEMON_PID_INVALID","daemon.pid is not JSON");}
 if(!parsed||typeof parsed!=="object")fail("DAEMON_PID_INVALID","daemon.pid is not an object");
 const value=parsed as Record<string,unknown>;
 if(typeof value.pid!=="number"||!Number.isInteger(value.pid)||value.pid<=0)
  fail("DAEMON_PID_INVALID","daemon.pid pid is invalid");
 const procIdentity=value.processIdentity;
 if(!procIdentity||typeof procIdentity!=="object")fail("DAEMON_PID_INVALID","daemon.pid processIdentity missing");
 const ident=procIdentity as Record<string,unknown>;
 if(typeof ident.bootId!=="string"||!ident.bootId)fail("DAEMON_PID_INVALID","daemon.pid bootId missing");
 if(typeof ident.startSeconds!=="number")fail("DAEMON_PID_INVALID","daemon.pid startSeconds missing");
 const executableIdentity=value.executableIdentity;
 if(!executableIdentity||typeof executableIdentity!=="object")fail("DAEMON_PID_INVALID","daemon.pid executableIdentity missing");
 const exec=executableIdentity as Record<string,unknown>;
 for(const key of ["digest","path_digest"] as const){
  const digest=exec[key];
  if(!Array.isArray(digest)||digest.length!==32||digest.some(byte=>typeof byte!=="number"||byte<0||byte>255))
   fail("DAEMON_PID_INVALID","daemon.pid executableIdentity."+key+" must be 32 bytes");
 }
 return {
  pid:value.pid as number,
  ...(typeof value.processStartTime==="string"?{processStartTime:value.processStartTime}:{}),
  processIdentity:{bootId:ident.bootId,startSeconds:ident.startSeconds as number},
  executableIdentity:{digest:exec.digest as number[],path_digest:exec.path_digest as number[]},
 };
}

function managedDaemonShape(process:ManagedProcessInfo,codexHomeReal:string,uid:number):{version:string}|undefined{
 if(process.uid!==uid)return undefined;
 const tokens=process.cmd.trim().split(/\s+/);
 const binary=tokens[0]??"";
 if(!binary.startsWith(codexHomeReal+sep))return undefined;
 const relative=binary.slice(codexHomeReal.length+1);
 const match=MANAGED_DAEMON_BIN.exec(relative);
 if(!match)return undefined;
 if(tokens[1]!=="app-server")return undefined;
 if(!tokens.includes("--managed-daemon"))return undefined;
 return {version:match[1]};
}

interface SyncIdentity {
 pid:number;
 version:string;
 executable:string;
 socketPath:string;
 socketRealpath:string;
 codexHome:string;
 bootId:string;
 startSeconds:number;
}

function assertCanonicalSocket(runtime:NativeOutboundRuntime,socketPath:string,uid:number):string{
 let alias:FileStatLike;
 try{alias=runtime.lstat(socketPath);}catch(error){
  if(errnoCode(error)==="ENOENT")fail("SOCKET_ALIAS_MISSING","canonical socket alias missing");
  return fail("SOCKET_ALIAS_UNSAFE","canonical socket alias unreadable");
 }
 if(alias.uid!==uid)fail("SOCKET_ALIAS_UNSAFE","canonical socket alias owned by another uid");
 if(alias.isSymbolicLink()){
  if(process.platform!=="darwin")fail("SOCKET_ALIAS_UNSAFE","symlink canonical socket is darwin-only");
  let target:string;
  try{target=runtime.readlink(socketPath);}catch{return fail("SOCKET_ALIAS_UNSAFE","cannot read canonical socket link");}
  const match=CANONICAL_SOCKET_TARGET.exec(target);
  if(!match||Number(match[1])!==uid)fail("SOCKET_REALPATH_INVALID","canonical socket link target is not /private/tmp/codex-daemon-<uid>/<64hex>");
  let parent:FileStatLike;
  try{parent=runtime.lstat(dirname(target));}catch{return fail("SOCKET_REALPATH_INVALID","canonical socket target folder missing");}
  if(!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o077)!==0)
   fail("SOCKET_ALIAS_UNSAFE","canonical socket target folder is not private to this uid");
  let targetStat:FileStatLike;
  try{targetStat=runtime.lstat(target);}catch{return fail("SOCKET_REALPATH_INVALID","canonical socket target missing");}
  if(!targetStat.isSocket()||targetStat.uid!==uid||(targetStat.mode&0o077)!==0)
   fail("SOCKET_ALIAS_UNSAFE","canonical socket target is not a private unix socket");
 }else if(!alias.isSocket()){
  fail("SOCKET_ALIAS_UNSAFE","canonical socket path is neither a symlink nor a socket");
 }
 let resolved:string;
 try{resolved=runtime.realpath(socketPath);}catch{return fail("SOCKET_REALPATH_INVALID","cannot realpath canonical socket");}
 let resolvedStat:FileStatLike;
 try{resolvedStat=runtime.lstat(resolved);}catch{return fail("SOCKET_REALPATH_INVALID","realpath target missing");}
 if(!resolvedStat.isSocket()||resolvedStat.uid!==uid||(resolvedStat.mode&0o077)!==0)
  fail("SOCKET_ALIAS_UNSAFE","canonical socket realpath is not a private unix socket");
 if(alias.isSymbolicLink()){
  let target="";
  try{target=runtime.readlink(socketPath);}catch{target="";}
  if(target&&resolved!==target)fail("SOCKET_REALPATH_INVALID","canonical socket realpath does not equal link target");
 }
 return resolved;
}

function readManagedDaemonIdentitySync(runtime:NativeOutboundRuntime,codexHomeArg:string,socketPathArg:string):SyncIdentity{
 const codexHome=realpathOrThrow(runtime,codexHomeArg,"CODEX_HOME_UNRESOLVABLE");
 let homeRequired=true;
 const pidFile=join(codexHome,"app-server-daemon","daemon.pid");
 const pidFileData=readDaemonPidFile(runtime,pidFile);
 const processes=runtime.listProcesses();
 const daemon=processes.find(process=>process.pid===pidFileData.pid);
 if(!daemon)fail("DAEMON_NOT_ALIVE","daemon.pid points at a process that is not running");
 if(daemon.uid!==runtime.uid)fail("DAEMON_UID_MISMATCH","managed daemon runs as another uid");
 const shape=managedDaemonShape(daemon,codexHome,runtime.uid);
 if(!shape)fail("DAEMON_ARGV_MISMATCH","daemon.pid process is not <codexHome>/packages/app-server-daemon/releases/<ver>/bin/codex app-server ... --managed-daemon");
 let executable:string;
 try{executable=runtime.realpath((daemon.cmd.trim().split(/\s+/)[0]??""));}catch{return fail("DAEMON_EXECUTABLE_MISMATCH","managed daemon executable is not resolvable");}
 const sameHome=processes.filter(process=>managedDaemonShape(process,codexHome,runtime.uid)!==undefined);
 if(sameHome.length!==1)fail("DAEMON_NOT_UNIQUE","expected exactly one managed daemon for this CODEX_HOME, found "+sameHome.length);
 const socketPath=socketPathArg;
 const socketRealpath=assertCanonicalSocket(runtime,socketPath,runtime.uid);
 void homeRequired;
 return {
  pid:daemon.pid,
  version:shape.version,
  executable,
  socketPath,
  socketRealpath,
  codexHome,
  bootId:pidFileData.processIdentity?.bootId??"",
  startSeconds:pidFileData.processIdentity?.startSeconds??0,
 };
}

/**
 * G1: prove the live managed daemon identity and that its canonical socket
 * accepts a WebSocket upgrade (HTTP 101). Never launches/kills anything.
 */
export async function inspectManagedDaemon(opts?:{
 codexHome?:string;
 socketPath?:string;
 deps?:unknown;
}):Promise<ManagedDaemonIdentity>{
 const deps=asDeps(opts?.deps);
 const codexHome=opts?.codexHome??deps.codexHome??defaultCodexHome();
 const socketPath=opts?.socketPath??deps.socketPath??join(codexHome,"app-server-control","app-server-control.sock");
 const runtime=resolveRuntime(depsRuntime(deps));
 const identity=readManagedDaemonIdentitySync(runtime,codexHome,socketPath);
 let upgraded=false;
 try{upgraded=await runtime.probeWebSocket(identity.socketRealpath);}catch{upgraded=false;}
 if(!upgraded)fail("SOCKET_NOT_READY","canonical managed-daemon socket did not answer WS GET /rpc 101");
 return identity;
}

function asDeps(value:unknown):NativeOutboundDeps{
 if(value&&typeof value==="object")return value as NativeOutboundDeps;
 return {};
}

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

/* ------------------------------------------------------------------ *
 * G5: cross-process ledger
 * ------------------------------------------------------------------ */

interface LedgerRecord extends NativeOutboundReceipt {
 fingerprint:string;
}

const TERMINAL_STATES:ReadonlySet<NativeOutboundState>=new Set(["COMPLETED","REPLY_VERIFIED","UNCERTAIN","BLOCKED"]);

function ledgerDir(stateDir:string):string{
 return join(stateDir,"native-outbound");
}

function ledgerKey(workspaceId:string,operationId:string):string{
 return sha256Hex(workspaceId+"\0"+operationId);
}

function ledgerPathFor(stateDir:string,workspaceId:string,operationId:string):string{
 return join(ledgerDir(stateDir),ledgerKey(workspaceId,operationId)+".json");
}

/** Ensure the ledger directory itself is a real, private, non-symlink directory. */
function ensureLedgerDir(stateDir:string):string{
 const runtime=REAL_RUNTIME;
 const directory=ledgerDir(stateDir);
 if(!existsSync(directory))mkdirSync(directory,{recursive:true,mode:0o700});
 const stat=runtime.lstat(directory);
 if(stat.isSymbolicLink()||!stat.isDirectory())fail("LEDGER_DIR_UNSAFE","ledger directory must be a real directory");
 const uid=runtime.uid;
 if(stat.uid!==uid)fail("LEDGER_DIR_UNSAFE","ledger directory owned by another uid");
 if((stat.mode&0o077)!==0)fail("LEDGER_DIR_UNSAFE","ledger directory is not private to this uid");
 return directory;
}

function parseLedger(raw:string,workspaceId:string,operationId:string):LedgerRecord{
 let parsed:unknown;
 try{parsed=JSON.parse(raw);}catch{return fail("LEDGER_INVALID","ledger file is not JSON");}
 if(!parsed||typeof parsed!=="object")fail("LEDGER_INVALID","ledger file is not an object");
 const receipt=parsed as Record<string,unknown>;
 if(receipt.workspaceId!==workspaceId||receipt.operationId!==operationId)
  fail("LEDGER_INVALID","ledger does not belong to this workspace/operation");
 if(typeof receipt.state!=="string"||!(receipt.state in {...RANK,UNCERTAIN:9,BLOCKED:9}))
  fail("LEDGER_INVALID","ledger state is invalid");
 if(typeof receipt.fingerprint!=="string"||!receipt.fingerprint)fail("LEDGER_INVALID","ledger fingerprint missing");
 return receipt as unknown as LedgerRecord;
}

function readLedgerRecord(stateDir:string,workspaceId:string,operationId:string):LedgerRecord|undefined{
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 let raw:string;
 try{raw=REAL_RUNTIME.readText(path);}catch(error){
  if(errnoCode(error)==="ENOENT")return undefined;
  return fail("LEDGER_UNREADABLE","ledger unreadable");
 }
 return parseLedger(raw,workspaceId,operationId);
}

/**
 * G5: atomically claim operationId for exactly one process via O_EXCL. A second
 * caller gets `claimed:false` plus the existing receipt; it must never invoke
 * the CLI. Same fingerprint + completed state is the same logical operation.
 */
export function claimOperation(
 stateDir:string,
 workspaceId:string,
 operationId:string,
 fingerprint:string,
):{claimed:true;ledgerPath:string}|{claimed:false;existing:NativeOutboundReceipt}{
 assertValidOperation(workspaceId,operationId);
 if(typeof fingerprint!=="string"||!fingerprint)fail("FINGERPRINT_INVALID","fingerprint must be a non-empty string");
 const directory=ensureLedgerDir(stateDir);
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 const now=REAL_RUNTIME.now();
 const record:LedgerRecord={
  state:"PRESEND",workspaceId,operationId,threadId:"",payloadSha256:"",
  fingerprint,createdAt:now,updatedAt:now,
 };
 let fd:number;
 try{
  fd=openSync(path,"wx",0o600);
 }catch(error){
  if(errnoCode(error)!=="EEXIST")return fail("LEDGER_UNWRITABLE","cannot create ledger");
  const existing=readLedgerRecord(stateDir,workspaceId,operationId);
  if(!existing)return fail("LEDGER_RACE","ledger disappeared during claim");
  return {claimed:false,existing:existing as NativeOutboundReceipt};
 }
 try{writeFileSync(fd,JSON.stringify(record),{mode:0o600});}
 finally{closeSync(fd);}
 void directory;
 return {claimed:true,ledgerPath:path};
}

export function readNativeOutboundReceipt(
 stateDir:string,
 workspaceId:string,
 operationId:string,
):NativeOutboundReceipt|undefined{
 assertValidOperation(workspaceId,operationId);
 const record=readLedgerRecord(stateDir,workspaceId,operationId);
 return record?record as NativeOutboundReceipt:undefined;
}

function writeLedger(stateDir:string,workspaceId:string,operationId:string,patch:Partial<LedgerRecord>,options:{allowTerminal?:boolean}={}):LedgerRecord{
 const path=ledgerPathFor(stateDir,workspaceId,operationId);
 const existing=readLedgerRecord(stateDir,workspaceId,operationId);
 if(!existing)fail("LEDGER_MISSING","ledger missing before write");
 const next=patch.state;
 if(next&&existing.state){
  const currentRank=RANK[existing.state];
  const nextRank=RANK[next];
  const isTerminal=next==="UNCERTAIN"||next==="BLOCKED";
  const allowed=nextRank!==undefined
   ?(currentRank===undefined||nextRank>currentRank)
   :(isTerminal&&(options.allowTerminal??true)&&currentRank!==undefined&&currentRank<2);
  if(!allowed&&next!==existing.state)return existing;
 }else if(!next&&existing.state){
  // pure field update: keep state, still monotonic (never downgrade).
 }
 const merged:LedgerRecord={...existing,...patch,updatedAt:REAL_RUNTIME.now()};
 if(patch.state===undefined)merged.state=existing.state;
 const temp=join(dirname(path),"."+randomBytes(8).toString("hex")+".tmp");
 writeFileSync(temp,JSON.stringify(merged),{mode:0o600});
 renameSync(temp,path);
 return merged;
}

/* ------------------------------------------------------------------ *
 * G2: explicit CLI command construction
 * ------------------------------------------------------------------ */

export interface NativeOutboundQueueCommand {
 codexBin:string;
 argv:string[];
 env:Record<string,string|undefined>;
}

/**
 * G2: build the ONLY allowed CLI invocation. There is no code path that omits
 * `--remote`, and the remote target is the verified canonical socket realpath.
 */
export function buildNativeOutboundQueueCommand(input:{
 codexHome:string;
 socketRealpath:string;
 threadId:string;
 prompt:string;
 codexBin?:string;
}):NativeOutboundQueueCommand{
 assertValidThread(input.threadId);
 if(!input.socketRealpath.startsWith("unix://")&&!input.socketRealpath.startsWith("/"))
  fail("QUEUE_ARGV_MISSING_REMOTE","socket realpath must be an absolute unix path");
 const argv=[
  "queue",
  "--remote","unix://"+input.socketRealpath,
  "--thread",input.threadId,
  "--message",input.prompt,
 ];
 const codexBin=input.codexBin??process.env.CODEX_BIN??"codex";
 return {
  codexBin,
  argv,
  env:{...process.env,CODEX_HOME:input.codexHome},
 };
}

/** Assert that an argv array is the explicit, safe queue invocation (test seam). */
export function assertQueueArgv(argv:string[]):void{
 if(!Array.isArray(argv)||argv[0]!=="queue")fail("QUEUE_ARGV_INVALID","argv must start with queue");
 const remoteAt=argv.indexOf("--remote");
 if(remoteAt<0)fail("QUEUE_ARGV_MISSING_REMOTE","queue argv is missing --remote");
 const remote=argv[remoteAt+1]??"";
 if(!remote.startsWith("unix://")||remote.length<=7)
  fail("QUEUE_ARGV_MISSING_REMOTE","queue --remote must be unix://<absolute socket>");
 if(argv.filter(token=>token==="--remote").length!==1)fail("QUEUE_ARGV_INVALID","exactly one --remote is required");
 const threadAt=argv.indexOf("--thread");
 if(threadAt<0||!argv[threadAt+1])fail("QUEUE_ARGV_INVALID","queue argv is missing --thread");
 const messageAt=argv.indexOf("--message");
 if(messageAt<0||typeof argv[messageAt+1]!=="string")fail("QUEUE_ARGV_INVALID","queue argv is missing --message");
 if(argv.includes("--oss")||argv.includes("-m")||argv.includes("--model")||argv.includes("-i")||argv.includes("--image"))
  fail("QUEUE_ARGV_INVALID","queue argv must not override model/oss/images");
}

/* ------------------------------------------------------------------ *
 * Rollout observation (read-only; multiple projections count once)
 * ------------------------------------------------------------------ */

interface UserDelivery {turnId?:string;itemId?:string;source:"event"|"response";text:string;index:number}
interface ReplyDelivery {turnId?:string;text:string;index:number;source:"event"|"response"}
interface ObservedRollout {
 available:boolean;
 path?:string;
 deliveries:UserDelivery[];
 replies:ReplyDelivery[];
 started:Set<string>;
 completed:Set<string>;
 lineCount:number;
 size:number;
}

interface BaselineObservation {
 path?:string;
 size:number;
 deliveryTurnIds:Set<string>;
 deliveryItemIds:Set<string>;
 started:Set<string>;
 completed:Set<string>;
}

function emptyObservation():ObservedRollout{
 return {available:false,deliveries:[],replies:[],started:new Set(),completed:new Set(),lineCount:0,size:0};
}

function joinedItemText(content:unknown):string{
 if(!Array.isArray(content))return "";
 return content
  .filter(part=>part&&typeof part==="object"&&typeof (part as {text?:unknown}).text==="string")
  .map(part=>String((part as {text:string}).text))
  .join("");
}

function parseRolloutObservation(raw:string,threadId:string,payloadSha256:string):ObservedRollout{
 const endsWithNewline=raw.endsWith("\n");
 const lines=raw.split("\n");
 if(endsWithNewline)lines.pop();
 const deliveries:UserDelivery[]=[];
 const replies:ReplyDelivery[]=[];
 const started=new Set<string>();
 const completed=new Set<string>();
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(!line.trim())continue;
  let record:any;
  try{record=JSON.parse(line);}catch{
   if(!endsWithNewline&&index===lines.length-1)continue;
   return {...emptyObservation(),lineCount:lines.length,size:raw.length};
  }
  const payload=record?.payload;
  if(!payload||typeof payload!=="object")continue;
  if(record.type==="event_msg"){
   if(payload.type==="task_started"&&typeof payload.turn_id==="string"){started.add(payload.turn_id);continue;}
   if(payload.type==="task_complete"&&typeof payload.turn_id==="string"){completed.add(payload.turn_id);continue;}
   if(payload.type==="item_completed"){
    const item=payload.item;
    if(!item||typeof item!=="object"||typeof item.type!=="string")continue;
    const text=joinedItemText(item.content);
    const turnId=typeof payload.turn_id==="string"?payload.turn_id:undefined;
    const itemId=typeof item.id==="string"?item.id:undefined;
    if(item.type==="UserMessage"&&sha256Hex(text)===payloadSha256)
     deliveries.push({...(turnId?{turnId}:{}),...(itemId?{itemId}:{}),source:"event",text,index});
    else if(item.type==="AgentMessage"&&text)
     replies.push({...(turnId?{turnId}:{}),text,index,source:"event"});
   }
  }else if(record.type==="response_item"&&payload.type==="message"&&payload.role==="user"){
   const text=joinedItemText(payload.content);
   if(!text||sha256Hex(text)!==payloadSha256)continue;
   const turnId=typeof payload?.internal_chat_message_metadata_passthrough?.turn_id==="string"
    ?payload.internal_chat_message_metadata_passthrough.turn_id
    :undefined;
   const itemId=typeof payload.id==="string"?payload.id:undefined;
   deliveries.push({...(turnId?{turnId}:{}),...(itemId?{itemId}:{}),source:"response",text,index});
  }else if(record.type==="response_item"&&payload.type==="message"&&payload.role==="assistant"){
   const text=joinedItemText(payload.content);
   if(!text)continue;
   const turnId=typeof payload?.internal_chat_message_metadata_passthrough?.turn_id==="string"
    ?payload.internal_chat_message_metadata_passthrough.turn_id
    :undefined;
   replies.push({...(turnId?{turnId}:{}),text,index,source:"response"});
  }
 }
 return {available:true,deliveries,replies,started,completed,lineCount:lines.length,size:raw.length};
}

function baselineOf(observation:ObservedRollout):BaselineObservation{
 const deliveryTurnIds=new Set<string>(),deliveryItemIds=new Set<string>();
 for(const delivery of observation.deliveries){
  if(delivery.turnId)deliveryTurnIds.add(delivery.turnId);
  if(delivery.itemId)deliveryItemIds.add(delivery.itemId);
 }
 return {
  ...(observation.path?{path:observation.path}:{}),
  size:observation.size,
  deliveryTurnIds,deliveryItemIds,
  started:new Set(observation.started),completed:new Set(observation.completed),
 };
}

function observeRollout(runtime:NativeOutboundRuntime,input:{threadId:string;codexHome:string;payloadSha256:string;cached?:{size:number;observation:ObservedRollout}}):ObservedRollout{
 let path:string;
 try{path=runtime.findRollout(input.threadId,input.codexHome);}catch{
  return emptyObservation();
 }
 let size=0;
 try{size=runtime.statFile(path).size;}catch{return emptyObservation();}
 if(input.cached&&input.cached.size===size)return input.cached.observation;
 let raw:string;
 try{raw=runtime.readRolloutText(path);}catch{return emptyObservation();}
 const observation=parseRolloutObservation(raw,input.threadId,input.payloadSha256);
 return {...observation,available:true,path};
}

/* ------------------------------------------------------------------ *
 * G6/G10: send once, then verify by reading the exact native rollout
 * ------------------------------------------------------------------ */

const QUEUED_MESSAGE=/^Queued message ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) for thread ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.\s*$/m;

function nowOf(runtime:NativeOutboundRuntime):number{
 return runtime.now();
}

/**
 * G2/G4/G5/G6/G10: the only sanctioned outbound path.
 *
 * Order: claim ledger (cross-process) -> G1 identity -> G4 App ownership ->
 * G1 identity again immediately before CLI -> exactly one explicit `codex queue
 * --remote unix://<canonical realpath>` -> ACCEPTED only on exit 0 -> poll the
 * exact native rollout -> TURN_OBSERVED / COMPLETED / REPLY_VERIFIED, with any
 * timeout persisted as UNCERTAIN and never retried.
 */
export async function sendNativeOutbound(input:{
 workspaceId:string;
 root:string;
 threadId:string;
 operationId:string;
 prompt:string;
 stateDir:string;
 codexHome?:string;
 socketPath?:string;
 timeoutMs?:number;
 observeTimeoutMs?:number;
 deps?:NativeOutboundDeps;
}):Promise<NativeOutboundReceipt>{
 assertValidOperation(input.workspaceId,input.operationId);
 assertValidThread(input.threadId);
 if(typeof input.prompt!=="string"||!input.prompt.trim())fail("PROMPT_INVALID","prompt must be non-empty");
 if(input.prompt.length>MAX_PROMPT)fail("PROMPT_TOO_LONG","prompt exceeds "+MAX_PROMPT+" characters");
 const deps=input.deps??{};
 const runtime=resolveRuntime(depsRuntime(deps));
 const codexHome=resolve(input.codexHome??deps.codexHome??defaultCodexHome());
 const root=realpathOrThrow(runtime,input.root,"ROOT_UNRESOLVABLE");
 const payloadSha256=sha256Hex(input.prompt);
 const fingerprint=sha256Hex(JSON.stringify({v:1,workspaceId:input.workspaceId,root,threadId:input.threadId,payloadSha256}));
 const timeoutMs=Math.min(Math.max(input.timeoutMs??deps.timeoutMs??120_000,1_000),600_000);
 const observeTimeoutMs=Math.min(Math.max(input.observeTimeoutMs??deps.observeTimeoutMs??30_000,0),600_000);
 const pollMs=Math.min(Math.max(deps.pollMs??100,10),5_000);

 // G5: exactly one process may claim this operationId.
 const claim=claimOperation(input.stateDir,input.workspaceId,input.operationId,fingerprint);
 if(!claim.claimed){
  const existing=claim.existing as NativeOutboundReceipt&{fingerprint?:string};
  if(existing.fingerprint!==fingerprint)fail("OPERATION_CONFLICT","operationId already used with a different prompt/thread/root");
  if(TERMINAL_STATES.has(existing.state))return existing;
  return fail("OPERATION_IN_PROGRESS","operation "+input.operationId+" is already in progress (state "+existing.state+")");
 }
 let current:NativeOutboundReceipt=readNativeOutboundReceipt(input.stateDir,input.workspaceId,input.operationId)!;
 const persist=(patch:Partial<LedgerRecord>,options?:{allowTerminal?:boolean})=>{
  const merged=writeLedger(input.stateDir,input.workspaceId,input.operationId,
   {threadId:input.threadId,payloadSha256,...patch},options);
  current=merged as NativeOutboundReceipt;
  return merged as NativeOutboundReceipt;
 };
 persist({state:"PRESEND"});

 try{
  const inspect=async():Promise<ManagedDaemonIdentity>=>{
   if(deps.inspectDaemon)return deps.inspectDaemon({codexHome,socketPath:input.socketPath??join(codexHome,"app-server-control","app-server-control.sock")});
   return inspectManagedDaemon({codexHome,socketPath:input.socketPath??join(codexHome,"app-server-control","app-server-control.sock"),deps:{runtime:depsRuntime(deps)}});
  };
  const verify=(()=>{
   if(deps.verifyOwnership)return ():{threadId:string;root:string;status:string}=>deps.verifyOwnership!({threadId:input.threadId,root,codexHome,socketPath:input.socketPath??join(codexHome,"app-server-control","app-server-control.sock")});
   return ():{threadId:string;root:string;status:string}=>verifyNativeAppOwnership({threadId:input.threadId,root,codexHome});
  })();

  // G1 first identity proof, then G4 ownership (both before any CLI spawn).
  const firstIdentity=await inspect();
  let ownership:{threadId:string;root:string;status:string};
  try{ownership=verify();}
  catch(error){
   const code=error instanceof NativeOutboundError?error.code:"BLOCKED_APP_OWNERSHIP";
   persist({state:"BLOCKED",error:code});
   throw error instanceof NativeOutboundError?error:new NativeOutboundError(code,String(error));
  }
  if(ownership.status!=="APP_OWNED"){persist({state:"BLOCKED",error:"BLOCKED_APP_OWNERSHIP"});fail("BLOCKED_APP_OWNERSHIP","native App ownership was not proven");}

  // G1 re-check immediately before the one and only CLI invocation.
  const secondIdentity=await inspect();
  if(secondIdentity.pid!==firstIdentity.pid||secondIdentity.socketRealpath!==firstIdentity.socketRealpath||
     secondIdentity.executable!==firstIdentity.executable||secondIdentity.codexHome!==firstIdentity.codexHome){
   persist({state:"BLOCKED",error:"BLOCKED_DAEMON_REPLACED"});
   fail("BLOCKED_DAEMON_REPLACED","managed daemon identity changed between verification and send");
  }
  if(secondIdentity.codexHome!==codexHome)fail("CODEX_HOME_MISMATCH","managed daemon codexHome does not match the pinned CODEX_HOME");

  const command=buildNativeOutboundQueueCommand({
   codexHome,socketRealpath:secondIdentity.socketRealpath,threadId:input.threadId,prompt:input.prompt,
   ...(deps.codexBin?{codexBin:deps.codexBin}:{}),
  });
  assertQueueArgv(command.argv);

  const baselineObservation=observeRollout(runtime,{threadId:input.threadId,codexHome,payloadSha256});
  const baseline=baselineOf(baselineObservation);

  // Exactly one CLI invocation. No retry on any outcome.
  let run:QueueRunResult;
  try{run=runtime.runQueue({codexBin:command.codexBin,argv:command.argv,env:command.env,timeoutMs});}
  catch(error){
   persist({state:"UNCERTAIN",uncertaintyReason:"CLI_SPAWN_UNCERTAIN",error:error instanceof Error?error.message:String(error)});
   return current;
  }
  if(run.error==="TIMEOUT"||run.code===null){
   persist({state:"UNCERTAIN",uncertaintyReason:run.error==="TIMEOUT"?"CLI_TIMEOUT":"CLI_UNCERTAIN",queueExitCode:run.code??undefined,error:run.stderr.slice(0,2000)});
   return current;
  }
  if(run.code!==0){
   persist({state:"BLOCKED",queueExitCode:run.code,error:(run.stderr||run.stdout||"queue exited "+run.code).slice(0,4000)});
   fail("QUEUE_EXIT_NONZERO","queue exited "+run.code+": "+run.stderr.trim().slice(0,500));
  }
  const match=QUEUED_MESSAGE.exec(run.stdout);
  if(!match){
   // Exit 0 with unparseable stdout can still have persisted a row; never retry.
   persist({state:"ACCEPTED",queueExitCode:0,uncertaintyReason:"QUEUE_ACCEPTED_UNPARSED"});
  }else{
   if(match[2]!==input.threadId){
    persist({state:"UNCERTAIN",queueMessageId:match[1],queueExitCode:0,uncertaintyReason:"QUEUE_THREAD_MISMATCH"});
    fail("QUEUE_THREAD_MISMATCH","CLI queued to a different thread: "+match[2]);
   }
   persist({state:"ACCEPTED",queueMessageId:match[1],queueExitCode:0});
  }

  // G6/G10: bounded, read-only observation of the exact native rollout.
  const deadline=nowOf(runtime)+observeTimeoutMs;
  const maxIterations=Math.max(1,Math.ceil(observeTimeoutMs/Math.max(pollMs,1))+2);
  let cached:{size:number;observation:ObservedRollout}|undefined;
  let lastSeen=current;
  for(let iteration=0;iteration<maxIterations;iteration++){
   const observation=observeRollout(runtime,{threadId:input.threadId,codexHome,payloadSha256,...(cached?{cached}:{})});
   if(observation.available)cached={size:observation.size,observation};

   const newTurnIds=new Set<string>();
   let orphanNew=0;
   let eventItemId:string|undefined;
   let responseItemId:string|undefined;
   let firstNewIndex=Number.MAX_SAFE_INTEGER;
   for(const delivery of observation.deliveries){
    const isNew=delivery.turnId
     ?!baseline.deliveryTurnIds.has(delivery.turnId)
     :!(delivery.itemId&&baseline.deliveryItemIds.has(delivery.itemId));
    if(!isNew)continue;
    if(delivery.turnId)newTurnIds.add(delivery.turnId);else orphanNew+=1;
    firstNewIndex=Math.min(firstNewIndex,delivery.index);
    if(delivery.source==="event"&&delivery.itemId)eventItemId=delivery.itemId;
    if(delivery.source==="response"&&delivery.itemId)responseItemId=delivery.itemId;
   }
   const logicalDeliveries=newTurnIds.size+(newTurnIds.size?0:orphanNew);
   if(logicalDeliveries>1){
    persist({state:"UNCERTAIN",uncertaintyReason:"DOUBLE_DELIVERY",userItemId:eventItemId??responseItemId});
    return current;
   }
   if(logicalDeliveries===1){
    const turnId=[...newTurnIds][0];
    const userItemId=eventItemId??responseItemId;
    lastSeen=persist({state:"TURN_OBSERVED",...(turnId?{turnId}:{}),...(userItemId?{userItemId}:{})});
    const startedNow=turnId?observation.started.has(turnId):false;
    const completedNow=turnId?observation.completed.has(turnId):false;
    if(startedNow&&completedNow)lastSeen=persist({state:"COMPLETED",...(turnId?{turnId}:{})});
    let reply:ReplyDelivery|undefined;
    if(turnId)reply=[...observation.replies].reverse().find(candidate=>candidate.turnId===turnId&&candidate.text.trim());
    else reply=[...observation.replies].reverse().find(candidate=>candidate.index>firstNewIndex&&candidate.text.trim());
    if(reply&&reply.text.trim()){
     lastSeen=persist({state:"REPLY_VERIFIED",reply:reply.text.slice(0,16_384),replySha256:sha256Hex(reply.text),...(turnId?{turnId}:{})});
     return current;
    }
    if(completedNow)return current;
   }
   if(nowOf(runtime)>=deadline)break;
   await runtime.sleep(pollMs);
  }
  if(RANK[lastSeen.state]!==undefined&&RANK[lastSeen.state]>=RANK.TURN_OBSERVED)return current;
  persist({state:"UNCERTAIN",uncertaintyReason:"OBSERVE_TIMEOUT"});
  return current;
 }catch(error){
  if(error instanceof NativeOutboundError){
   // Ensure identity/ownership/daemon failures are persisted as terminal BLOCKED.
   const record=readLedgerRecord(input.stateDir,input.workspaceId,input.operationId);
   const rank=record?RANK[record.state]:undefined;
   if(record&&!TERMINAL_STATES.has(record.state)&&rank!==undefined&&rank<2){
    persist({state:"BLOCKED",error:error.code});
   }
   throw error;
  }
  throw error;
 }
}
