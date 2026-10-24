/**
 * ONEPASS-003-NATIVE-TX-004 M1 / G1+G2: managed-daemon identity probe, the
 * real/injectable runtime, and the single explicit `codex queue --remote`
 * command builder. This module owns process/lsof/WS probing only; it never
 * sends a message (coach-native-outbound.ts orchestrates the one call).
 */
import {spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {lstatSync,readFileSync,readlinkSync,realpathSync,statSync,type Stats} from "node:fs";
import {connect} from "node:net";
import {dirname,join,sep} from "node:path";
import {findCodexRollout} from "./coach-codex-native-continuity.js";
import {
 type FileStatLike,
 type ManagedDaemonIdentity,
 type ManagedProcessInfo,
 type NativeOutboundDeps,
 type NativeOutboundQueueCommand,
 type NativeOutboundRuntime,
 type QueueRunResult,
 NativeOutboundError,
 asDeps,
 assertValidThread,
 defaultCodexHome,
 errnoCode,
 fail,
 realpathOrThrow,
} from "./coach-native-outbound-types.js";

const MANAGED_DAEMON_BIN=/^packages\/app-server-daemon\/releases\/([^/]+)\/bin\/codex$/;
const CANONICAL_SOCKET_TARGET=/^\/private\/tmp\/codex-daemon-(\d+)\/[a-f0-9]{64}$/;

/** daemon.pid shape is owned by Codex; validate defensively instead of trusting it. */
interface DaemonPidFile {
 pid:number;
 processStartTime?:string;
 processIdentity?:{bootId?:string;uniqueId?:number;startSeconds?:number;startMicroseconds?:number};
 executableIdentity?:{digest?:number[];path_digest?:number[]};
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

export const REAL_RUNTIME=makeRealRuntime();
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

export function resolveRuntime(overrides?:Partial<NativeOutboundRuntime>):NativeOutboundRuntime{
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

export function readManagedDaemonIdentitySync(runtime:NativeOutboundRuntime,codexHomeArg:string,socketPathArg:string):SyncIdentity{
 const codexHome=realpathOrThrow(runtime,codexHomeArg,"CODEX_HOME_UNRESOLVABLE");
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

/* ------------------------------------------------------------------ *
 * G2: explicit CLI command construction
 * ------------------------------------------------------------------ */

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

export {depsRuntime};
