/**
 * ONEPASS-003-NATIVE-TX-004 M1 tests: NativeCodexOutbound core.
 *
 * Fully injected: no real `codex` CLI, no daemon, no ChatGPT App, no Chrome, no
 * production state. Identity/GUI/writer observations and the CLI runner come
 * from fake runtimes; only rollouts/ledgers are real temp files.
 *
 * Run: node --import tsx src/coach-native-outbound.test.ts
 * Success prints: NATIVE_OUTBOUND_TEST_PASS <n>
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,truncateSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
 NativeOutboundError,
 assertQueueArgv,
 buildNativeOutboundQueueCommand,
 claimOperation,
 inspectManagedDaemon,
 readNativeOutboundReceipt,
 sendNativeOutbound,
 setNativeOutboundTestRuntime,
 verifyNativeAppOwnership,
 type FileStatLike,
 type ManagedProcessInfo,
 type NativeOutboundDeps,
 type NativeOutboundRuntime,
} from "./coach-native-outbound.js";
import {findCodexRollout} from "./coach-codex-native-continuity.js";

const uid=process.getuid?.()??501;
const MODULE_URL=new URL("./coach-native-outbound.ts",import.meta.url).href;
const REPO_ROOT=resolve(fileURLToPath(new URL("..",import.meta.url)));
const MAIN_BIN="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";

const BASE=realpathSync(mkdtempSync(join(tmpdir(),"native-outbound-")));
const HOME=join(BASE,".codex");
const WORK=join(BASE,"workspace");
const OTHER_WORK=join(BASE,"other-workspace");
mkdirSync(join(HOME,"sessions","2026","10","24"),{recursive:true,mode:0o700});
mkdirSync(WORK,{recursive:true,mode:0o700});
mkdirSync(OTHER_WORK,{recursive:true,mode:0o700});

const THREAD_A="01a16dff-ed1d-7073-a92f-3b2b408a79d9";
const THREAD_B="01a16e00-1111-7222-8333-944455556666";

function check(name:string,fn:()=>void):void{fn();passed++;process.stdout.write("PASS "+name+"\n");}
async function checkAsync(name:string,fn:()=>Promise<void>):Promise<void>{await fn();passed++;process.stdout.write("PASS "+name+"\n");}
let passed=0;

function enoent():Error{const error=new Error("ENOENT") as NodeJS.ErrnoException;error.code="ENOENT";return error;}

interface DaemonWorld {
 home:string;
 pid:number;
 version:string;
 bin:string;
 alias:string;
 target:string;
 processes:ManagedProcessInfo[];
 runtime:Partial<NativeOutboundRuntime>;
 files:Map<string,string>;
 stats:Map<string,FileStatLike>;
 realpaths:Map<string,string>;
}
interface WorldOptions {
 home?:string;
 pid?:number;
 version?:string;
 managed?:boolean;
 daemonAlive?:boolean;
 processUid?:number;
 secondDaemon?:boolean;
 wsOk?:boolean;
 socketTarget?:string;
 aliasRealpathMismatch?:boolean;
 pidFileRaw?:string|null;
 parentMode?:number;
 executableRealpathFails?:boolean;
 extraProcesses?:ManagedProcessInfo[];
}
function makeDaemonWorld(options:WorldOptions={}):DaemonWorld{
 const home=options.home??HOME;
 const pid=options.pid??4242;
 const version=options.version??"0.164.0-aarch64-apple-darwin";
 const bin=join(home,"packages","app-server-daemon","releases",version,"bin","codex");
 const alias=join(home,"app-server-control","app-server-control.sock");
 const target=options.socketTarget??("/private/tmp/codex-daemon-"+uid+"/"+"a".repeat(64));
 const processUid=options.processUid??uid;
 const cmd=(options.managed===false?"<bin> app-server --listen stdio://":"<bin> app-server --remote-control --listen unix:// --analytics-default-enabled --managed-daemon").replace("<bin>",bin);
 const daemon:ManagedProcessInfo={pid,ppid:1,uid:processUid,cmd,comm:bin};
 const processes:ManagedProcessInfo[]=[];
 if(options.daemonAlive!==false)processes.push(daemon);
 if(options.secondDaemon)processes.push({...daemon,pid:pid+1});
 if(options.extraProcesses)processes.push(...options.extraProcesses);

 const pidFile=join(home,"app-server-daemon","daemon.pid");
 const pidFileRaw=options.pidFileRaw===undefined
  ?JSON.stringify({pid,processStartTime:"x",processIdentity:{bootId:"BOOT-1",uniqueId:1,startSeconds:1792834737},
    executableIdentity:{digest:new Array(32).fill(1),path_digest:new Array(32).fill(2)}})
  :options.pidFileRaw;
 const files=new Map<string,string>();
 if(pidFileRaw!==null)files.set(pidFile,pidFileRaw);
 const stats=new Map<string,FileStatLike>();
 const realpaths=new Map<string,string>();
 const realpathOf=(path:string,stat:FileStatLike)=>stat;
 stats.set(alias,{isSymbolicLink:()=>true,isFile:()=>false,isDirectory:()=>false,isSocket:()=>false,uid:processUid,mode:0o755,size:0,mtimeMs:1});
 stats.set(bin,{isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false,isSocket:()=>false,uid,mode:0o755,size:1,mtimeMs:1});
 stats.set(home,{isSymbolicLink:()=>false,isFile:()=>false,isDirectory:()=>true,isSocket:()=>false,uid,mode:0o700,size:0,mtimeMs:1});
 stats.set(target,{isSymbolicLink:()=>false,isFile:()=>false,isDirectory:()=>false,isSocket:()=>true,uid,mode:0o600,size:0,mtimeMs:1});
 stats.set(join("/private/tmp","codex-daemon-"+uid),{isSymbolicLink:()=>false,isFile:()=>false,isDirectory:()=>true,isSocket:()=>false,uid,mode:options.parentMode??0o700,size:0,mtimeMs:1});
 realpaths.set(home,home);
 realpaths.set(bin,bin);
 realpaths.set(alias,options.aliasRealpathMismatch?join(home,"different-socket"):target);
 realpaths.set(target,target);
 const runtime:Partial<NativeOutboundRuntime>={
  uid,
  readText:path=>{const value=files.get(path);if(value===undefined)throw enoent();return value;},
  lstat:path=>{const value=stats.get(path);if(value===undefined)throw enoent();return value;},
  readlink:path=>{if(path===alias)return target;throw enoent();},
  realpath:path=>{if(options.executableRealpathFails&&path===bin)throw enoent();const value=realpaths.get(path);if(value!==undefined)return value;return realpathSync(path);},
  listProcesses:()=>processes,
  probeWebSocket:async()=>options.wsOk!==false,
 };
 return {home,pid,version,bin,alias,target,processes,runtime,files,stats,realpaths};
}
function withWorld<T>(world:DaemonWorld,fn:()=>T):T{
 setNativeOutboundTestRuntime(world.runtime);
 try{return fn();}finally{setNativeOutboundTestRuntime(undefined);}
}
async function expectReject(promise:Promise<unknown>,code:string|RegExp):Promise<NativeOutboundError>{
 try{await promise;}catch(error){
  assert.ok(error instanceof NativeOutboundError,"expected NativeOutboundError, got "+(error instanceof Error?error.constructor.name+":"+error.message:String(error)));
  if(typeof code==="string")assert.equal(error.code,code);else assert.match(error.code,code);
  return error;
 }
 throw new Error("expected rejection "+(code instanceof RegExp?code.source:code));
}
function expectSyncReject(fn:()=>unknown,code:string|RegExp):NativeOutboundError{
 try{fn();}catch(error){
  assert.ok(error instanceof NativeOutboundError,"expected NativeOutboundError, got "+(error instanceof Error?error.constructor.name+":"+error.message:String(error)));
  if(typeof code==="string")assert.equal(error.code,code);else assert.match(error.code,code);
  return error;
 }
 throw new Error("expected rejection "+(code instanceof RegExp?code.source:code));
}

/* ------------------------------- rollout helpers ------------------------------- */

interface RolloutFixture {path:string;raw:string}
function rolloutPath(threadId:string,home=HOME):string{
 return join(home,"sessions","2026","10","24","rollout-2026-10-24T21-00-00-"+threadId+".jsonl");
}
function writeRollout(threadId:string,records:unknown[],home=HOME,root=WORK):RolloutFixture{
 const path=rolloutPath(threadId,home);
 const meta={type:"session_meta",payload:{id:threadId,source:"vscode",cwd:root,session_id:threadId}};
 const raw=[meta,...records].map(record=>JSON.stringify(record)).join("\n")+"\n";
 writeFileSync(path,raw,{mode:0o600});
 return {path,raw};
}
const userText=(turnId:string,itemId:string,text:string,threadId=THREAD_A)=>({
 type:"event_msg",payload:{type:"item_completed",thread_id:threadId,turn_id:turnId,
  item:{type:"UserMessage",id:itemId,content:[{type:"text",text}]}}});
const assistantText=(turnId:string,itemId:string,text:string)=>({
 type:"event_msg",payload:{type:"item_completed",turn_id:turnId,
  item:{type:"AgentMessage",id:itemId,content:[{type:"text",text}]}}});
const responseUserProjection=(turnId:string,messageId:string,text:string)=>({
 type:"response_item",payload:{type:"message",id:messageId,role:"user",content:[{type:"input_text",text}],
  internal_chat_message_metadata_passthrough:{turn_id:turnId}}});
const taskStarted=(turnId:string)=>({type:"event_msg",payload:{type:"task_started",turn_id:turnId,root_turn_id:turnId,
 turn_attribution:{turn_id:turnId,turn_trigger:"queue"}}});
const taskComplete=(turnId:string)=>({type:"event_msg",payload:{type:"task_complete",turn_id:turnId,root_turn_id:turnId,last_agent_message:"ok"}});

function writeLock(threadId:string,home=HOME):string{
 const directory=join(home,"thread-writer-locks");
 mkdirSync(directory,{recursive:true,mode:0o700});
 const path=join(directory,threadId+".lock");
 writeFileSync(path,"",{mode:0o600});
 return path;
}

const GUI_PROCESS:ManagedProcessInfo={pid:900,ppid:1,uid,cmd:MAIN_BIN,comm:MAIN_BIN};
const GUI_HELPER:ManagedProcessInfo={pid:901,ppid:900,uid,
 cmd:"/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper --type=renderer",
 comm:"ChatGPT Helper"};

/* ------------------------------- fake identity for send ------------------------------- */

function fakeIdentity(world:DaemonWorld){
 return {
  pid:world.pid,version:world.version,executable:world.bin,socketPath:world.alias,socketRealpath:world.target,
  codexHome:resolve(world.home),bootId:"BOOT-1",startSeconds:1792834737,
 };
}

/* ------------------------------- tests ------------------------------- */

async function main():Promise<void>{
 const worlds:DaemonWorld[]=[];
 try{

  /* ---- G1: inspectManagedDaemon identity ---- */
  await checkAsync("G1 identity: managed daemon accepted (pid/version/executable/socket/bootId)",async()=>{
   const world=makeDaemonWorld({version:"9.9.9-test"});
   const identity=await inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}});
   assert.equal(identity.pid,4242);
   assert.equal(identity.version,"9.9.9-test");
   assert.equal(identity.executable,world.bin);
   assert.equal(identity.socketPath,world.alias);
   assert.equal(identity.socketRealpath,world.target);
   assert.equal(identity.codexHome,world.home);
   assert.equal(identity.bootId,"BOOT-1");
   assert.equal(identity.startSeconds,1792834737);
  });

  await checkAsync("G1 identity: missing daemon.pid blocked",async()=>{
   const world=makeDaemonWorld({pidFileRaw:null});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_PID_MISSING");
  });
  await checkAsync("G1 identity: malformed daemon.pid blocked",async()=>{
   for(const raw of ["not json","{}",JSON.stringify({pid:0}),JSON.stringify({pid:4242}),
    JSON.stringify({pid:4242,processIdentity:{bootId:"b",startSeconds:1},executableIdentity:{digest:[1,2],path_digest:new Array(32).fill(1)}})]){
    const world=makeDaemonWorld({pidFileRaw:raw});
    await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_PID_INVALID");
   }
  });
  await checkAsync("G1 identity: daemon.pid not alive blocked",async()=>{
   const world=makeDaemonWorld({daemonAlive:false});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_NOT_ALIVE");
  });
  await checkAsync("G1 identity: wrong uid blocked",async()=>{
   const world=makeDaemonWorld({processUid:uid+1});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_UID_MISMATCH");
  });
  await checkAsync("G1 identity: non-managed-daemon argv blocked (no --managed-daemon)",async()=>{
   const world=makeDaemonWorld({managed:false});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_ARGV_MISMATCH");
  });
  await checkAsync("G1 identity: executable outside releases/<ver>/bin/codex blocked",async()=>{
   const world=makeDaemonWorld();
   world.processes.push({pid:777,ppid:1,uid,cmd:join(world.home,"other-codex","codex")+" app-server --managed-daemon",comm:"other"});
   world.processes[0]={...world.processes[0],cmd:join(world.home,"other-codex","codex")+" app-server --managed-daemon"};
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_ARGV_MISMATCH");
  });
  await checkAsync("G1 identity: two managed daemons blocked (second writer)",async()=>{
   const world=makeDaemonWorld({secondDaemon:true});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"DAEMON_NOT_UNIQUE");
  });
  await checkAsync("G1 identity: canonical socket alias missing blocked",async()=>{
   const world=makeDaemonWorld();
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:join(world.home,"missing.sock"),deps:{runtime:world.runtime}}),"SOCKET_ALIAS_MISSING");
  });
  await checkAsync("G1 identity: non-canonical socket target blocked",async()=>{
   const world=makeDaemonWorld({socketTarget:"/tmp/not-a-codex-daemon/socket"});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"SOCKET_REALPATH_INVALID");
  });
  await checkAsync("G1 identity: realpath/link mismatch blocked",async()=>{
   const world=makeDaemonWorld({aliasRealpathMismatch:true});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"SOCKET_REALPATH_INVALID");
  });
  await checkAsync("G1 identity: world-readable socket parent blocked",async()=>{
   const world=makeDaemonWorld({parentMode:0o755});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"SOCKET_ALIAS_UNSAFE");
  });
  await checkAsync("G1 identity: WS non-101 blocked",async()=>{
   const world=makeDaemonWorld({wsOk:false});
   await expectReject(inspectManagedDaemon({codexHome:world.home,socketPath:world.alias,deps:{runtime:world.runtime}}),"SOCKET_NOT_READY");
  });

  /* ---- G4: App ownership ---- */
  const ownershipWorld=(options:{gui?:ManagedProcessInfo[];lock?:boolean;holderPids?:number[];threadId?:string}={}):DaemonWorld=>{
   const world=makeDaemonWorld({extraProcesses:options.gui??[GUI_PROCESS]});
   if(options.lock!==false)writeLock(options.threadId??THREAD_A,world.home);
   world.runtime.lockOwnerPids=()=>options.holderPids??[world.pid];
   return world;
  };

  check("G4 ownership: App GUI + managed-daemon writer + matching rollout => APP_OWNED",()=>{
   writeRollout(THREAD_A,[taskStarted("t1"),userText("t1","u1","hello"),assistantText("t1","a1","hi"),taskComplete("t1")]);
   const world=ownershipWorld({});
   const result=withWorld(world,()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}));
   assert.deepEqual(result,{threadId:THREAD_A,root:WORK,status:"APP_OWNED"});
  });
  check("G4 ownership: no ChatGPT GUI => BLOCK",()=>{
   const world=ownershipWorld({gui:[]});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_APP_GUI_ABSENT"));
  });
  check("G4 ownership: helper process substring is not the GUI => BLOCK",()=>{
   const world=ownershipWorld({gui:[GUI_HELPER]});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_APP_GUI_ABSENT"));
  });
  check("G4 ownership: two GUI main processes => BLOCK",()=>{
   const world=ownershipWorld({gui:[GUI_PROCESS,{...GUI_PROCESS,pid:902}]});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_APP_GUI_NOT_UNIQUE"));
  });
  check("G4 ownership: unloaded thread (no App writer lock) => BLOCK, never thread/start",()=>{
   writeRollout(THREAD_A,[taskStarted("t1"),userText("t1","u1","hello"),taskComplete("t1")]);
   const world=ownershipWorld({lock:false,holderPids:[]});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_APP_OWNER_REQUIRED"));
  });
  check("G4 ownership: second managed daemon / foreign writer => BLOCK",()=>{
   const world=makeDaemonWorld({secondDaemon:true,extraProcesses:[GUI_PROCESS]});
   writeLock(THREAD_A,world.home);
   world.runtime.lockOwnerPids=()=>[world.pid+1];
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),/DAEMON_NOT_UNIQUE|BLOCKED_FOREIGN_WRITER/));
  });
  check("G4 ownership: writer lock held by a CLI/stdin app-server => BLOCK",()=>{
   const world=ownershipWorld({});
   const cli:ManagedProcessInfo={pid:777,ppid:1,uid,
    cmd:"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://",
    comm:"codex"};
   world.processes.push(cli);
   world.runtime.lockOwnerPids=()=>[cli.pid];
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_THREAD_WRITER_UNVERIFIED"));
  });
  check("G4 ownership: rollout wrong cwd => BLOCK",()=>{
   writeRollout(THREAD_A,[taskStarted("t1"),userText("t1","u1","hello")],HOME,OTHER_WORK);
   const world=ownershipWorld({});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:THREAD_A,root:WORK,codexHome:world.home}),"BLOCKED_THREAD_WORKSPACE_MISMATCH"));
  });
  check("G4 ownership: rollout wrong thread id => BLOCK",()=>{
   // The file name matches the requested thread but session_meta.id is another thread.
   const requested="01a16e14-aaaa-7bbb-8ccc-ddddeeeeffff";
   writeFileSync(rolloutPath(requested),
    JSON.stringify({type:"session_meta",payload:{id:THREAD_B,source:"vscode",cwd:WORK}})+"\n",{mode:0o600});
   const world=ownershipWorld({threadId:requested});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:requested,root:WORK,codexHome:world.home}),"BLOCKED_THREAD_IDENTITY_MISMATCH"));
   // restore a valid THREAD_A rollout for the remaining tests
   writeRollout(THREAD_A,[taskStarted("t0"),userText("t0","u0","earlier"),taskComplete("t0")]);
  });
  check("G4 ownership: App-owned lock but rollout missing => BLOCKED_THREAD_NOT_LOADED",()=>{
   const missingThread="01a16e11-2222-7333-8444-955566667777";
   const world=ownershipWorld({threadId:missingThread});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:missingThread,root:WORK,codexHome:world.home}),"BLOCKED_THREAD_NOT_LOADED"));
  });
  check("G4 ownership: rollout over native reader size limit => BLOCKED_THREAD_TOO_LARGE",()=>{
   const largeThread="01a16e12-3333-7444-8555-966677778888";
   const path=rolloutPath(largeThread);
   writeFileSync(path,JSON.stringify({type:"session_meta",payload:{id:largeThread,source:"vscode",cwd:WORK}})+"\n",{mode:0o600});
   truncateSync(path,24_000_001);
   const world=ownershipWorld({threadId:largeThread});
   withWorld(world,()=>expectSyncReject(()=>verifyNativeAppOwnership({threadId:largeThread,root:WORK,codexHome:world.home}),"BLOCKED_THREAD_TOO_LARGE"));
  });
  check("G4 ownership: 14MB native rollout accepted by findCodexRollout (reader path explicit)",()=>{
   const bigThread="01a16e13-4444-7555-8666-977788889999";
   const path=rolloutPath(bigThread);
   writeFileSync(path,JSON.stringify({type:"session_meta",payload:{id:bigThread,source:"vscode",cwd:WORK}})+"\n",{mode:0o600});
   truncateSync(path,14_000_000);
   assert.equal(findCodexRollout(bigThread,HOME),path);
  });

  /* ---- G5: ledger / claim ---- */
  const STATE_DIR=join(BASE,"state-main");mkdirSync(STATE_DIR,{recursive:true,mode:0o700});
  check("G5 claim: first claim wins, ledger 0600, second same-ID claim sees PRESEND",()=>{
   const fingerprint="fp-1";
   const first=claimOperation(STATE_DIR,"ws1","op-1",fingerprint);
   assert.equal(first.claimed,true);
   if(!first.claimed)throw new Error("unreachable");
   const mode=statSync(first.ledgerPath).mode&0o777;
   assert.equal(mode,0o600);
   assert.ok(first.ledgerPath.startsWith(join(STATE_DIR,"native-outbound")));
   const second=claimOperation(STATE_DIR,"ws1","op-1",fingerprint);
   assert.equal(second.claimed,false);
   if(second.claimed)throw new Error("unreachable");
   assert.equal(second.existing.state,"PRESEND");
   assert.equal(second.existing.workspaceId,"ws1");
   assert.equal(second.existing.operationId,"op-1");
   const receipt=readNativeOutboundReceipt(STATE_DIR,"ws1","op-1");
   assert.equal(receipt?.state,"PRESEND");
   assert.equal(readNativeOutboundReceipt(STATE_DIR,"ws1","op-unknown"),undefined);
   assert.throws(()=>claimOperation(STATE_DIR,"bad workspace","op-2","fp"),/WORKSPACE_ID_INVALID|NativeOutbound/);
  });
  await checkAsync("G5 claim: cross-process race => at most one CLI-entering claimant",async()=>{
   const raceDir=join(BASE,"state-race");mkdirSync(raceDir,{recursive:true,mode:0o700});
   const operationId="op-race";
   const code=`
const {claimOperation}=await import(${JSON.stringify(MODULE_URL)});
const result=claimOperation(${JSON.stringify(raceDir)},"wsR",${JSON.stringify(operationId)},"fp-race");
process.stdout.write(JSON.stringify(result));
`;
   const runChild=()=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolveChild,rejectChild)=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:REPO_ROOT,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk.toString();});
    child.stderr.on("data",chunk=>{stderr+=chunk.toString();});
    child.on("error",rejectChild);
    child.on("exit",code=>resolveChild({code,stdout,stderr}));
   });
   const [first,second]=await Promise.all([runChild(),runChild()]);
   for(const result of [first,second]){
    assert.equal(result.code,0,"child failed: "+result.stderr);
    const parsed=JSON.parse(result.stdout) as {claimed:boolean};
    assert.equal(typeof parsed.claimed,"boolean");
   }
   const claimed=[first,second].filter(result=>(JSON.parse(result.stdout) as {claimed:boolean}).claimed);
   assert.equal(claimed.length,1);
   assert.equal(readNativeOutboundReceipt(raceDir,"wsR",operationId)?.state,"PRESEND");
  });

  /* ---- G2: explicit argv only ---- */
  check("G2 argv: explicit --remote unix://<canonical realpath> is always present",()=>{
   const command=buildNativeOutboundQueueCommand({codexHome:HOME,socketRealpath:"/private/tmp/codex-daemon-501/abc",threadId:THREAD_A,prompt:"hello",codexBin:"/fake/codex"});
   assert.equal(command.codexBin,"/fake/codex");
   assert.deepEqual(command.argv,["queue","--remote","unix:///private/tmp/codex-daemon-501/abc","--thread",THREAD_A,"--message","hello"]);
   assert.equal(command.env.CODEX_HOME,HOME);
   assertQueueArgv(command.argv);
   expectSyncReject(()=>assertQueueArgv(["queue","--thread",THREAD_A,"--message","hello"]),"QUEUE_ARGV_MISSING_REMOTE");
   expectSyncReject(()=>assertQueueArgv(["queue","--remote","ws://localhost:1234","--thread",THREAD_A,"--message","x"]),"QUEUE_ARGV_MISSING_REMOTE");
   expectSyncReject(()=>assertQueueArgv(["queue","--remote","unix:///a","--thread",THREAD_A,"--message","x","--oss"]),"QUEUE_ARGV_INVALID");
  });

  /* ---- send flow fixtures ---- */
  const sendHome=join(BASE,"send-home");
  mkdirSync(join(sendHome,"sessions","2026","10","24"),{recursive:true,mode:0o700});
  const sendWorld=makeDaemonWorld({home:sendHome,extraProcesses:[GUI_PROCESS]});
  writeLock(THREAD_A,sendHome);
  sendWorld.runtime.lockOwnerPids=()=>[sendWorld.pid];
  const sendIdentity=fakeIdentity(sendWorld);
  let queueCalls:Array<{codexBin:string;argv:string[];env:Record<string,string|undefined>;timeoutMs:number}>=[];

  const makeDeps=(options:{
   runQueue?:(input:{codexBin:string;argv:string[];env:Record<string,string|undefined>;timeoutMs:number})=>{code:number|null;stdout:string;stderr:string;error?:string};
   inspectDaemon?:(opts:{codexHome:string;socketPath:string})=>Promise<ReturnType<typeof fakeIdentity>>;
   verifyOwnership?:(input:{threadId:string;root:string;codexHome:string;socketPath:string})=>{threadId:string;root:string;status:string};
   observeTimeoutMs?:number;pollMs?:number;
  }={}):NativeOutboundDeps=>{
   let now=1_000_000;
   queueCalls=[];
   return {
    codexHome:sendHome,
    observeTimeoutMs:options.observeTimeoutMs??200,
    pollMs:options.pollMs??5,
    inspectDaemon:options.inspectDaemon??(async()=>sendIdentity),
    verifyOwnership:options.verifyOwnership??(()=>({threadId:THREAD_A,root:WORK,status:"APP_OWNED"})),
    runtime:{
     now:()=>now,
     sleep:async(ms)=>{now+=ms;},
     runQueue:(input)=>{
      queueCalls.push(input);
      if(options.runQueue)return options.runQueue(input);
      return {code:0,stdout:"",stderr:""};
     },
    },
   };
  };
  const append = (records:unknown[])=>{const current=readFileSync(rolloutPath(THREAD_A,sendHome),"utf8");
   writeFileSync(rolloutPath(THREAD_A,sendHome),current+records.map(record=>JSON.stringify(record)).join("\n")+"\n",{mode:0o600});};
  const baseRecords=[taskStarted("t0"),userText("t0","u0","earlier unrelated message"),assistantText("t0","a0","earlier reply"),taskComplete("t0")];
  writeRollout(THREAD_A,baseRecords,sendHome);

  await checkAsync("G10 send: exit0 ACCEPTED -> TURN_OBSERVED -> COMPLETED -> REPLY_VERIFIED (explicit argv)",async()=>{
   const prompt="ONEPASS003 native outbound proof message 001";
   const payloadSha=(await import("node:crypto")).createHash("sha256").update(prompt).digest("hex");
   const deps=makeDeps({runQueue:()=>{
    append([
     taskStarted("t1"),
     responseUserProjection("t1","msg_resp_1",prompt),
     userText("t1","item_evt_1",prompt),
     assistantText("t1","agent_evt_1","DEVSPACE_NATIVE_OUTBOUND_ACK"),
     taskComplete("t1"),
    ]);
    return {code:0,stdout:"Queued message 01a16e14-5555-7666-8777-98889999aaaa for thread "+THREAD_A+".\n",stderr:""};
   }});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-1",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"REPLY_VERIFIED");
   assert.equal(receipt.workspaceId,"ws-send");
   assert.equal(receipt.threadId,THREAD_A);
   assert.equal(receipt.payloadSha256,payloadSha);
   assert.equal(receipt.queueMessageId,"01a16e14-5555-7666-8777-98889999aaaa");
   assert.equal(receipt.queueExitCode,0);
   assert.equal(receipt.turnId,"t1");
   assert.ok(receipt.userItemId);
   assert.equal(receipt.reply,"DEVSPACE_NATIVE_OUTBOUND_ACK");
   assert.equal(receipt.replySha256,(await import("node:crypto")).createHash("sha256").update("DEVSPACE_NATIVE_OUTBOUND_ACK").digest("hex"));
   assert.equal(queueCalls.length,1);
   const argv=queueCalls[0].argv;
   assert.equal(argv[0],"queue");
   const remoteAt=argv.indexOf("--remote");
   assert.ok(remoteAt>=0);
   assert.equal(argv[remoteAt+1],"unix://"+sendIdentity.socketRealpath);
   assert.equal(argv[argv.indexOf("--thread")+1],THREAD_A);
   assert.equal(argv[argv.indexOf("--message")+1],prompt);
   assert.equal(queueCalls[0].env.CODEX_HOME,sendHome);
   const persisted=readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-1");
   assert.equal(persisted?.state,"REPLY_VERIFIED");
  });

  await checkAsync("G5/G10 idempotency: same operationId returns completed receipt without a second CLI call",async()=>{
   const prompt="ONEPASS003 native outbound proof message 001";
   const deps=makeDeps({runQueue:()=>{throw new Error("must not be called");}});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-1",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"REPLY_VERIFIED");
   assert.equal(queueCalls.length,0);
  });
  await checkAsync("G5 conflict: same operationId with a different prompt is refused",async()=>{
   const deps=makeDeps({});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-1",prompt:"different prompt",stateDir:STATE_DIR,deps}),"OPERATION_CONFLICT");
   assert.equal(queueCalls.length,0);
  });
  await checkAsync("G5 in-progress: a claimed but unfinished operation is refused (no CLI spawn)",async()=>{
   claimOperation(STATE_DIR,"ws-send","send-op-inflight","fp-inflight");
   const deps=makeDeps({});
   // Fingerprint differs from the presend one, so this is a conflict; a matching
   // fingerprint takes the OPERATION_IN_PROGRESS path.
   const {sha256Hex}=await import("./coach-native-outbound.js");
   const fingerprint=sha256Hex(JSON.stringify({v:1,workspaceId:"ws-send",root:WORK,threadId:THREAD_A,payloadSha256:sha256Hex("inflight prompt")}));
   const ledger=join(STATE_DIR,"native-outbound",sha256Hex("ws-send"+"\0"+"send-op-inflight")+".json");
   const parsed=JSON.parse(readFileSync(ledger,"utf8"));
   parsed.fingerprint=fingerprint;
   writeFileSync(ledger,JSON.stringify(parsed),{mode:0o600});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-inflight",prompt:"inflight prompt",stateDir:STATE_DIR,deps}),"OPERATION_IN_PROGRESS");
   assert.equal(queueCalls.length,0);
  });

  await checkAsync("G10 observation: two projections of the same turn count once (not DOUBLE_DELIVERY)",async()=>{
   const prompt="ONEPASS003 projections proof 002";
   const deps=makeDeps({runQueue:()=>{
    append([
     taskStarted("t2"),
     responseUserProjection("t2","msg_resp_2",prompt),
     userText("t2","item_evt_2",prompt),
     responseUserProjection("t2","msg_resp_2b",prompt),
     taskComplete("t2"),
    ]);
    return {code:0,stdout:"Queued message 01a16e15-6666-7777-8888-9999aaaabbbb for thread "+THREAD_A+".\n",stderr:""};
   }});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-2",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"COMPLETED");
   assert.equal(receipt.turnId,"t2");
  });

  await checkAsync("G10 timeout: exit0 but never observed => UNCERTAIN persisted, no retry",async()=>{
   const prompt="ONEPASS003 never executed proof 003";
   const deps=makeDeps({observeTimeoutMs:20,pollMs:5,runQueue:()=>({
    code:0,stdout:"Queued message 01a16e16-7777-7888-8999-aaaabbbbcccc for thread "+THREAD_A+".\n",stderr:"",
   })});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-3",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"UNCERTAIN");
   assert.equal(receipt.uncertaintyReason,"OBSERVE_TIMEOUT");
   assert.equal(receipt.queueMessageId,"01a16e16-7777-7888-8999-aaaabbbbcccc");
   assert.equal(queueCalls.length,1);
   const depsAgain=makeDeps({runQueue:()=>{throw new Error("must not retry");}});
   const again=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-3",prompt,stateDir:STATE_DIR,deps:depsAgain});
   assert.equal(again.state,"UNCERTAIN");
   assert.equal(queueCalls.length,0);
  });

  await checkAsync("G2 queue exit nonzero => BLOCKED receipt, single failed call, no retry",async()=>{
   const prompt="ONEPASS003 queue reject proof 004";
   const deps=makeDeps({runQueue:()=>({code:2,stdout:"",stderr:"Error: failed to queue session message: no rollout found"})});
   const error=await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-4",prompt,stateDir:STATE_DIR,deps}),"QUEUE_EXIT_NONZERO");
   assert.match(error.message,/no rollout found/);
   assert.equal(queueCalls.length,1);
   const receipt=readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-4");
   assert.equal(receipt?.state,"BLOCKED");
   assert.equal(receipt?.queueExitCode,2);
  });

  await checkAsync("G10 wrong thread in CLI stdout => UNCERTAIN + QUEUE_THREAD_MISMATCH (no retry)",async()=>{
   const prompt="ONEPASS003 wrong thread proof 005";
   const deps=makeDeps({runQueue:()=>({code:0,stdout:"Queued message 01a16e17-8888-7999-8aaa-bbbbccccdddd for thread "+THREAD_B+".\n",stderr:""})});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-5",prompt,stateDir:STATE_DIR,deps}),"QUEUE_THREAD_MISMATCH");
   assert.equal(queueCalls.length,1);
   const receipt=readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-5");
   assert.equal(receipt?.state,"UNCERTAIN");
  });

  await checkAsync("G10 same text, different operationIds => two accepted rows (no content dedupe)",async()=>{
   const prompt="ONEPASS003 duplicate text proof 006";
   let turn=0;
   const deps=makeDeps({runQueue:()=>{
    turn+=1;
    append([taskStarted("d"+turn),userText("d"+turn,"du"+turn,prompt),assistantText("d"+turn,"da"+turn,"reply "+turn),taskComplete("d"+turn)]);
    return {code:0,stdout:"Queued message 01a16e18-9999-7aaa-8bbb-ccccddddeeee for thread "+THREAD_A+".\n",stderr:""};
   }});
   const first=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-6a",prompt,stateDir:STATE_DIR,deps});
   const second=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-6b",prompt,stateDir:STATE_DIR,deps});
   assert.equal(first.state,"REPLY_VERIFIED");
   assert.equal(second.state,"REPLY_VERIFIED");
   assert.equal(queueCalls.length,2);
   assert.notEqual(first.operationId,second.operationId);
   assert.equal(first.payloadSha256,second.payloadSha256);
  });

  await checkAsync("G10 CLI timeout => UNCERTAIN persisted as CLI_TIMEOUT, single call, no retry",async()=>{
   const prompt="ONEPASS003 cli timeout proof 010";
   const deps=makeDeps({runQueue:()=>({code:null,stdout:"",stderr:"",error:"TIMEOUT"})});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-10",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"UNCERTAIN");
   assert.equal(receipt.uncertaintyReason,"CLI_TIMEOUT");
   assert.equal(queueCalls.length,1);
   assert.equal(readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-10")?.state,"UNCERTAIN");
  });

  await checkAsync("G10 exit0 unparseable stdout => ACCEPTED then UNCERTAIN, never retried",async()=>{
   const prompt="ONEPASS003 unparseable stdout proof 011";
   const deps=makeDeps({observeTimeoutMs:15,pollMs:5,runQueue:()=>({code:0,stdout:"not a queued message",stderr:""})});
   const receipt=await sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-11",prompt,stateDir:STATE_DIR,deps});
   assert.equal(receipt.state,"UNCERTAIN");
   assert.equal(receipt.uncertaintyReason,"OBSERVE_TIMEOUT");
   assert.equal(receipt.queueExitCode,0);
   assert.equal(queueCalls.length,1);
  });

  await checkAsync("G1/G4 send: managed daemon replaced between checks => BLOCKED, zero CLI spawn",async()=>{
   const prompt="ONEPASS003 daemon replaced proof 007";
   let inspectCount=0;
   const deps=makeDeps({inspectDaemon:async()=>{
    inspectCount+=1;
    const base=fakeIdentity(sendWorld);
    return inspectCount===1?base:{...base,pid:base.pid+5};
   }});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-7",prompt,stateDir:STATE_DIR,deps}),"BLOCKED_DAEMON_REPLACED");
   assert.equal(queueCalls.length,0);
   assert.equal(readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-7")?.state,"BLOCKED");
  });

  await checkAsync("G1 send: identity failure => BLOCKED receipt, zero CLI spawn",async()=>{
   const prompt="ONEPASS003 identity failure proof 008";
   const deps=makeDeps({inspectDaemon:async()=>{throw new NativeOutboundError("DAEMON_NOT_ALIVE","daemon gone");}});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-8",prompt,stateDir:STATE_DIR,deps}),"DAEMON_NOT_ALIVE");
   assert.equal(queueCalls.length,0);
   assert.equal(readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-8")?.state,"BLOCKED");
  });

  await checkAsync("G4 send: no App GUI => BLOCKED receipt, zero CLI spawn",async()=>{
   const prompt="ONEPASS003 no GUI proof 009";
   const deps=makeDeps({verifyOwnership:()=>{throw new NativeOutboundError("BLOCKED_APP_GUI_ABSENT","no GUI");}});
   await expectReject(sendNativeOutbound({workspaceId:"ws-send",root:WORK,threadId:THREAD_A,operationId:"send-op-9",prompt,stateDir:STATE_DIR,deps}),"BLOCKED_APP_GUI_ABSENT");
   assert.equal(queueCalls.length,0);
   assert.equal(readNativeOutboundReceipt(STATE_DIR,"ws-send","send-op-9")?.state,"BLOCKED");
  });

  await checkAsync("G10 atomic receipts: no temp files left behind, terminal states monotonic",async()=>{
   const ledgerDirectory=join(STATE_DIR,"native-outbound");
   const leftovers=readdirSync(ledgerDirectory).filter(name=>name.endsWith(".tmp"));
   assert.deepEqual(leftovers,[]);
   const receiptPath=join(ledgerDirectory,(await import("./coach-native-outbound.js")).sha256Hex("ws-send"+"\0"+"send-op-1")+".json");
   assert.equal(statSync(receiptPath).mode&0o777,0o600);
   const stored=JSON.parse(readFileSync(receiptPath,"utf8")) as {state:string};
   assert.equal(stored.state,"REPLY_VERIFIED");
  });

  process.stdout.write("NATIVE_OUTBOUND_TEST_PASS "+passed+"\n");
 }finally{
  setNativeOutboundTestRuntime(undefined);
  rmSync(BASE,{recursive:true,force:true});
 }
}

await main();
