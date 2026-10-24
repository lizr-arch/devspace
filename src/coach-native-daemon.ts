/**
 * ONEPASS-003-NATIVE-TX-004 M1 / G1+G2: managed-daemon identity probe, the
 * real/injectable runtime, and the single explicit `codex queue --remote`
 * command builder. This module owns process/lsof/WS probing only; it never
 * sends a message (coach-native-outbound.ts orchestrates the one call).
 */
import {spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {accessSync,existsSync,lstatSync,readFileSync,readlinkSync,realpathSync,statSync,type Stats} from "node:fs";
import {homedir} from "node:os";
import {connect} from "node:net";
import {dirname,join,sep} from "node:path";
import {findCodexRollout} from "./coach-codex-native-continuity.js";
import {inspectCommand,isLsofNoMatch,LSOF_LOCK_MAX_BUFFER,LSOF_TEXT_MAX_BUFFER,PS_COMMAND_MAX_BUFFER,PS_COMM_MAX_BUFFER} from "./coach-native-inspection.js";
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
 const comm=inspectCommand("ps_comm","/bin/ps",["-axo","pid=,comm="],{maxBuffer:PS_COMM_MAX_BUFFER});
 if(!comm.ok||comm.status!==0)throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",comm.diagnostic);
 const cmd=inspectCommand("ps_command","/bin/ps",["-axo","pid=,ppid=,uid=,command=","-ww"],{maxBuffer:PS_COMMAND_MAX_BUFFER});
 if(!cmd.ok||cmd.status!==0)throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",cmd.diagnostic);
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
 const listing=inspectCommand("lsof_lock","/usr/sbin/lsof",["-nP","-F","p",lockPath],{maxBuffer:LSOF_LOCK_MAX_BUFFER});
 if(listing.errorCode||listing.status===null)
  throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",listing.diagnostic);
 if(listing.status===1){
  if(!isLsofNoMatch(listing))throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",listing.diagnostic);
  return [];
 }
 if(listing.status!==0)throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",listing.diagnostic);
 const owners=[...(listing.stdout||"").matchAll(/^p(\d+)$/gm)].map(m=>Number(m[1]));
 return [...new Set(owners.filter(pid=>Number.isInteger(pid)&&pid>0))].sort((a,b)=>a-b);
}

function realLsofTextPaths(pid:number):string[]{
 const result=inspectCommand("lsof_text","/usr/sbin/lsof",["-a","-p",String(pid),"-d","txt","-Fn"],{maxBuffer:LSOF_TEXT_MAX_BUFFER});
 if(result.errorCode||result.status===null)
  throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",result.diagnostic);
 if(result.status===0){
  return (result.stdout||"").split("\n").filter(line=>line.startsWith("n")).map(line=>line.slice(1));
 }
 if(isLsofNoMatch(result))return [];
 throw new NativeOutboundError("PROCESS_INSPECTION_FAILED",result.diagnostic);
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

/**
 * Resolve the Codex CLI to an ABSOLUTE path by default. DevSpace under launchd
 * has PATH=/usr/bin:/bin:/usr/sbin:/sbin, where ~/.local/bin/codex is NOT on
 * PATH. The previous default "codex" made spawnSync fail with ENOENT; that
 * ENOENT was discarded into an opaque CLI_UNCERTAIN — the real cause of the
 * r2 native send failure.
 */
export function resolveCodexBin(opts:{
 env?:NodeJS.ProcessEnv;
 candidates?:string[];
 exists?:(path:string)=>boolean;
 isExecutable?:(path:string)=>boolean;
}={}):string{
 const env=opts.env??process.env;
 const exists=opts.exists??((path:string)=>existsSync(path));
 const isExecutable=opts.isExecutable??((path:string)=>{
  try{const st=statSync(path);if(!st.isFile())return false;accessSync(path,1);return true;}catch{return false;}
 });
 const assertAbsolute=(value:string,code:string,detail:string)=>{
  if(!value.startsWith("/"))throw new NativeOutboundError(code,detail);
 };
 const override=env.CODEX_BIN;
 if(override){
  // Explicit overrides must be trusted absolute executables. A relative value
  // would silently reintroduce PATH lookup (the r2 incident).
  assertAbsolute(override,"CODEX_BIN_OVERRIDE_NOT_ABSOLUTE","CODEX_BIN override must be an absolute path");
  if(!exists(override)||!isExecutable(override))
   throw new NativeOutboundError("CODEX_BIN_OVERRIDE_INVALID","CODEX_BIN override is not an executable regular file");
  return override;
 }
 const candidates=opts.candidates??[join(homedir(),".local","bin","codex"),"/opt/homebrew/bin/codex","/usr/local/bin/codex"];
 for(const candidate of candidates){
  if(typeof candidate!=="string"||!candidate.startsWith("/"))continue;
  try{
   if(exists(candidate)&&isExecutable(candidate))return candidate;
  }catch{}
 }
 // Fail closed: never fall back to a bare PATH name. A missing trusted binary
 // must block BEFORE any spawn (zero CLI calls, terminal BLOCKED).
 throw new NativeOutboundError("CODEX_BINARY_UNAVAILABLE","no trusted absolute Codex CLI executable found");
}

/** Trusted Node.js runtime used for the `<codex>` launcher shebang `#!/usr/bin/env node`. */
export interface NodeRuntime {nodePath:string;nodeDir:string}

export function resolveNodeRuntime(opts:{
 execPath?:string;
 candidates?:string[];
 exists?:(path:string)=>boolean;
 isExecutable?:(path:string)=>boolean;
}={}):NodeRuntime{
 const exists=opts.exists??((path:string)=>existsSync(path));
 const isExecutable=opts.isExecutable??((path:string)=>{
  try{const st=statSync(path);if(!st.isFile())return false;accessSync(path,1);return true;}catch{return false;}
 });
 const accepted=(path:string|undefined):path is string=>{
  if(typeof path!=="string"||!path.startsWith("/"))return false;
  try{return exists(path)&&isExecutable(path);}catch{return false;}
 };
 // The running DevSpace process's own Node is the primary trusted runtime; the
 // absolute candidates cover the service/CLI install locations without ever
 // consulting PATH.
 const primary=opts.execPath??process.execPath;
 if(accepted(primary))return{nodePath:primary,nodeDir:dirname(primary)};
 const candidates=opts.candidates??[
  join(homedir(),".hermes","node","bin","node"),
  join(homedir(),".local","bin","node"),
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
 ];
 for(const candidate of candidates){
  if(accepted(candidate))return{nodePath:candidate,nodeDir:dirname(candidate)};
 }
 throw new NativeOutboundError("NODE_RUNTIME_UNAVAILABLE","no trusted absolute Node.js runtime found for the Codex launcher");
}

function assertNodeRuntime(runtime:{nodePath:string}|undefined):NodeRuntime{
 if(!runtime)return resolveNodeRuntime();
 if(typeof runtime.nodePath!=="string"||!runtime.nodePath.startsWith("/"))
  throw new NativeOutboundError("NODE_RUNTIME_UNTRUSTED","node runtime must be an absolute path");
 let valid=false;
 try{const st=statSync(runtime.nodePath);valid=st.isFile();accessSync(runtime.nodePath,1);}catch{valid=false;}
 if(!valid)throw new NativeOutboundError("NODE_RUNTIME_UNTRUSTED","node runtime is not an executable regular file");
 return{nodePath:runtime.nodePath,nodeDir:dirname(runtime.nodePath)};
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
   const started=Date.now();
   let codexBinary:{name:string;size:number|null;mtimeMs:number|null}|undefined;
   try{
    const st=statSync(input.codexBin);
    codexBinary={name:input.codexBin.split("/").pop()??"codex",size:st.size,mtimeMs:st.mtimeMs};
   }catch{codexBinary=undefined;}
   const result=spawnSync(input.codexBin,input.argv,{
    encoding:"utf8",timeout:input.timeoutMs,maxBuffer:4_000_000,env:input.env as NodeJS.ProcessEnv,
   });
   const elapsedMs=Date.now()-started;
   const stdout=result.stdout??"";
   const stderr=result.stderr??"";
   const stdoutBytes=stdout.length;
   const stderrBytes=stderr.length;
   if(result.error){
    const code=errnoCode(result.error);
    const timedOut=code==="ETIMEDOUT";
    return{code:null,stdout,stderr,error:timedOut?"TIMEOUT":(code??"SPAWN_FAILED"),
     signal:result.signal??null,errnoCode:code??null,timedOut,elapsedMs,stdoutBytes,stderrBytes,
     ...(codexBinary?{codexBinary}:{})};
   }
   return{code:result.status,stdout,stderr,signal:result.signal??null,errnoCode:null,timedOut:false,
    elapsedMs,stdoutBytes,stderrBytes,...(codexBinary?{codexBinary}:{})};
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
 nodeRuntime?:{nodePath:string};
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
 const codexBin=input.codexBin??resolveCodexBin();
 const node=assertNodeRuntime(input.nodeRuntime);
 // The Codex CLI is a JS launcher with `#!/usr/bin/env node`; launchd's
 // PATH=/usr/bin:/bin:/usr/sbin:/sbin has no node, which produced the real
 // `queue exited 127: env: node: No such file or directory`. Give the child a
 // deterministic, explicit trusted PATH instead of inheriting an uncontrolled
 // launchd/shell PATH. No bare/PATH lookup is ever used to resolve the binary.
 const pathDirs=[node.nodeDir,dirname(codexBin),"/usr/bin","/bin","/usr/sbin","/sbin"];
 const PATH=[...new Set(pathDirs)].join(":");
 return {
  codexBin,
  argv,
  env:{...process.env,PATH,CODEX_HOME:input.codexHome},
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
