import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { basename, join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { getuid } from "node:process";
import { realpathSync, statSync } from "node:fs";
import { isPathInsideRoot } from "./roots.js";
import { assessGuardian, inspectProcessIdentity } from "./coach-agent-guardian.js";
import { AgentObserverStore } from "./agent-observer.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner, type RunnerInput, type RunnerStatus } from "./codex-agent-runner.js";
import type { ServerConfig } from "./config.js";
import type { CodexAgentControl } from "./codex-agent-control.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { ManagedCoachSidecar, type CoachSidecarStartResult, type CoachSidecarStatus, type DeliveryReceipt } from "./managed-coach-sidecar.js";
import type { ManagedCoachSidecarControl } from "./managed-coach-sidecar.js";

const MAX_MESSAGE=64*1024;
const SOCKET_FILE="codex-worker.sock";
const KEY_FILE="codex-worker.key";
const COACH_KEY_FILE="coach-feed.key";
type RpcRequest=
  | {version:1;token:string;op:"health"}
  | {version:1;token:string;op:"start";input:RunnerInput}
  | {version:1;token:string;op:"status";operationId:string;workspaceId:string}
  | {version:1;token:string;op:"recommendation";operationId:string;workspaceId:string}
  | {version:1;token:string;op:"stop";operationId:string;workspaceId:string}
  | {version:1;token:string;op:"queue";input:{workspaceId:string;operationId:string;expectedRevision:number;selection:{model:string;reasoningEffort:string}}};
type CoachStartInput={workspaceId:string;workspaceRoot:string;port:number;pairedExtensionId?:string;observeAllNativeAgents?:boolean;authorizedWorkspaceIds?:string[]};
type RpcRequestWithCoach=RpcRequest
  | {version:1;token:string;op:"coach_start";input:CoachStartInput}
  | {version:1;token:string;op:"coach_stop";workspaceId:string}
  | {version:1;token:string;op:"coach_status";workspaceId:string}
  | {version:1;token:string;op:"coach_delivery_receipt";workspaceId:string;eventId:number};
type RpcCall=RpcRequestWithCoach extends infer T?T extends RpcRequestWithCoach?Omit<T,"version"|"token">:never:never;

function secretAt(path:string,create:boolean):Buffer {
  const target=resolve(path);
  if(!existsSync(target)&&create){
    mkdirSync(join(target,".."),{recursive:true,mode:0o700});
    const value=randomBytes(32).toString("base64url");
    let fd:number|undefined;
    try{fd=openSync(target,"wx",0o600);writeFileSync(fd,value,{encoding:"utf8"});}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  const st=lstatSync(target);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==(getuid?.()??-1)||(st.mode&0o077)!==0)
    throw new Error("CODEX_WORKER_KEY_PERMISSIONS_UNSAFE");
  const value=readFileSync(target);
  if(value.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(value.toString("utf8")))
    throw new Error("CODEX_WORKER_KEY_INVALID");
  return value;
}

function sameSecret(expected:Buffer,actual:unknown):boolean {
  if(typeof actual!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(actual))return false;
  const candidate=Buffer.from(actual,"utf8");
  return candidate.length===expected.length&&timingSafeEqual(candidate,expected);
}
function errorCode(error:unknown):string {
  const raw=error instanceof Error?error.message:"";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(raw)?raw:"CODEX_WORKER_CALL_FAILED";
}
function coachFailureCode(error:unknown):string {
  const code=error&&typeof error==="object"?String((error as NodeJS.ErrnoException).code??""):"";
  if(code==="EADDRINUSE")return "COACH_FEED_PORT_IN_USE";
  if(code==="EACCES"||code==="EADDRNOTAVAIL")return "COACH_FEED_PORT_UNAVAILABLE";
  if(code==="SQLITE_BUSY"||code==="SQLITE_LOCKED")return "COACH_FEED_DATABASE_BUSY";
  return errorCode(error);
}
function send(socket:Socket,value:unknown):void {
  const text=JSON.stringify(value);
  if(Buffer.byteLength(text)>MAX_MESSAGE){socket.end(JSON.stringify({ok:false,error:"CODEX_WORKER_RESPONSE_TOO_LARGE"}));return;}
  socket.end(text+"\n");
}
function withinAllowedWorkspace(root:string,allowedRoots:string[]):string {
  let canonical:string;
  try{canonical=realpathSync(root);}catch{throw new Error("CODEX_WORKER_WORKSPACE_ROOT_UNAVAILABLE");}
  if(!statSync(canonical).isDirectory()||!allowedRoots.some((allowed)=>isPathInsideRoot(canonical,allowed)))
    throw new Error("CODEX_WORKER_WORKSPACE_NOT_AUTHORIZED");
  return canonical;
}

export function createCodexWorkerDispatcher(input:{runner:NativeCodexAgentRunner;events:CoachReviewEventStore;coach:ManagedCoachSidecar;workspaceStore:SqliteWorkspaceStore;stateDir:string;workerId:string;generation:number;allowedRoots:string[];coachRecovery:{error?:string}}) {
  const authorizeWorkspace=(workspaceId:string,requestedRoot:string):string=>{
    const session=input.workspaceStore.getSession(workspaceId);
    if(!session)throw new Error("CODEX_WORKER_WORKSPACE_NOT_AUTHORIZED");
    const authorized=withinAllowedWorkspace(session.root,input.allowedRoots);
    const requested=withinAllowedWorkspace(requestedRoot,input.allowedRoots);
    if(authorized!==requested)throw new Error("CODEX_WORKER_WORKSPACE_IDENTITY_MISMATCH");
    return authorized;
  };
  return async(request:RpcRequestWithCoach):Promise<unknown>=>{
    switch(request.op){
      case "health": return {ready:true,workerId:input.workerId,generation:input.generation,pid:process.pid,activeRuns:input.events.listRunningAgentRuns().length};
      case "start": {
        if(!request.input||typeof request.input!=="object")throw new Error("CODEX_WORKER_INPUT_INVALID");
        const workspaceRoot=authorizeWorkspace(request.input.workspaceId,request.input.workspaceRoot);
        return input.runner.start({...request.input,workspaceRoot});
      }
      case "status": authorizeWorkspace(request.workspaceId,input.workspaceStore.getSession(request.workspaceId)?.root??"");return input.runner.status(request.operationId,request.workspaceId);
      case "recommendation": authorizeWorkspace(request.workspaceId,input.workspaceStore.getSession(request.workspaceId)?.root??"");return input.runner.getReviewRecommendation(request.operationId,request.workspaceId);
      case "stop": authorizeWorkspace(request.workspaceId,input.workspaceStore.getSession(request.workspaceId)?.root??"");return input.runner.stop(request.operationId,request.workspaceId);
      case "queue": {
        const row=request.input as Parameters<NativeCodexAgentRunner["queueNextSelection"]>[0];
        authorizeWorkspace(row.workspaceId,input.workspaceStore.getSession(row.workspaceId)?.root??"");
        return input.runner.queueNextSelection(row);
      }
      case "coach_start": {
        if(!request.input||typeof request.input!=="object")throw new Error("COACH_FEED_CONFIG_INVALID");
        const workspaceRoot=authorizeWorkspace(request.input.workspaceId,request.input.workspaceRoot);
        const ids=request.input.authorizedWorkspaceIds??[request.input.workspaceId];
        if(!Array.isArray(ids)||ids.length<1||ids.length>8||new Set(ids).size!==ids.length||
           !ids.includes(request.input.workspaceId))throw new Error("COACH_FEED_SCOPE_INVALID");
        // Revalidate every workspace against durable sessions and approved roots.
        for(const id of ids)authorizeWorkspace(id,input.workspaceStore.getSession(id)?.root??"");
        const config={workspaceId:request.input.workspaceId,workspaceRoot,port:request.input.port,
          ...(request.input.pairedExtensionId?{pairedExtensionId:request.input.pairedExtensionId}:{}),
          observeAllNativeAgents:request.input.observeAllNativeAgents===true,
          authorizedWorkspaceIds:ids};
        const saved=input.events.coachFeedConfig();
        if(saved&&(saved.workspaceId!==config.workspaceId||saved.port!==config.port||saved.workspaceRoot!==config.workspaceRoot||
          saved.pairedExtensionId!==config.pairedExtensionId||saved.observeAllNativeAgents!==config.observeAllNativeAgents||
          JSON.stringify([...saved.authorizedWorkspaceIds].sort())!==JSON.stringify([...config.authorizedWorkspaceIds].sort())))
          await input.coach.stop(saved.workspaceId);
        input.events.saveCoachFeedConfig(config);
        const token=secretAt(join(input.stateDir,COACH_KEY_FILE),true).toString("utf8");
        try{const started=await input.coach.start({...config,pairingToken:token});input.coachRecovery.error=undefined;return started;}
        catch(error){input.coachRecovery.error=coachFailureCode(error);throw error;}
      }
      case "coach_stop": {
        const saved=input.events.coachFeedConfig();
        if(saved?.workspaceId===request.workspaceId){
          await input.coach.stop(request.workspaceId);input.events.clearCoachFeedConfig();
          try{const key=join(input.stateDir,COACH_KEY_FILE),st=lstatSync(key);if(st.isFile()&&!st.isSymbolicLink()&&st.uid===(getuid?.()??-1))unlinkSync(key);}catch{/* token absent */}
        }
        return {stopped:true};
      }
      case "coach_delivery_receipt": {
        authorizeWorkspace(request.workspaceId,input.workspaceStore.getSession(request.workspaceId)?.root??"");
        return input.coach.getDeliveryReceipt(request.workspaceId,request.eventId);
      }
      case "coach_status": {
        const current=input.coach.status(request.workspaceId);
        if(current)return current;
        const saved=input.events.coachFeedConfig();
        if(saved?.workspaceId!==request.workspaceId)return undefined;
        return {workspaceId:saved.workspaceId,serviceName:"coach-feed",port:saved.port,state:"stopped",reason:input.coachRecovery.error??"COACH_FEED_NOT_RUNNING",...(saved.pairedExtensionId?{pairedExtensionId:saved.pairedExtensionId}:{})};
      }
      default: throw new Error("CODEX_WORKER_OPERATION_UNSUPPORTED");
    }
  };
}

async function probeExistingSocket(path:string):Promise<"active"|"stale"> {
  return await new Promise((resolveProbe,reject)=>{
    const socket=createConnection(path);
    const timer=setTimeout(()=>{socket.destroy();reject(new Error("CODEX_WORKER_SOCKET_PROBE_TIMEOUT"));},1000);
    socket.once("connect",()=>{clearTimeout(timer);socket.destroy();resolveProbe("active");});
    socket.once("error",(error:NodeJS.ErrnoException)=>{
      clearTimeout(timer);
      if(error.code==="ECONNREFUSED"||error.code==="ENOENT")resolveProbe("stale");else reject(error);
    });
  });
}
function priorWorkerProvenDead(pid:number,uid:number,lstart:string):boolean {
  const observed=inspectProcessIdentity(pid);
  if(observed)return observed.uid!==uid||observed.lstart!==lstart;
  try{process.kill(pid,0);return false;}
  catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}
}

export async function startCodexWorkerService(config:ServerConfig,deps:{inspectProcess?:(pid:number)=>ReturnType<typeof inspectProcessIdentity>}={}):Promise<{close:()=>Promise<void>;socketPath:string;workerId:string;generation:number}> {
  const inspectProcess=deps.inspectProcess??inspectProcessIdentity;
  // Canonicalize the trust roots once. On macOS, /tmp is a symlink to
  // /private/tmp; comparing a realpath workspace against the lexical root
  // would otherwise reject valid workspaces (or encourage weaker checks).
  const allowedRoots=config.allowedRoots.map(root=>realpathSync(root));
  const stateDir=realpathSync(config.stateDir),socketPath=join(stateDir,SOCKET_FILE),keyPath=join(stateDir,KEY_FILE);
  const stateStat=lstatSync(stateDir);
  if(!stateStat.isDirectory()||stateStat.isSymbolicLink()||stateStat.uid!==(getuid?.()??-1))throw new Error("CODEX_WORKER_STATE_DIR_UNSAFE");
  chmodSync(stateDir,0o700);
  if(Buffer.byteLength(socketPath)>100)throw new Error("CODEX_WORKER_SOCKET_PATH_TOO_LONG");
  const token=secretAt(keyPath,true);
  const events=new CoachReviewEventStore(stateDir);
  const prior=events.getWorkerLease();
  let previousOwnerProvenDead=!prior;
  if(prior){
    const observed=inspectProcess(prior.pid);
    previousOwnerProvenDead=observed?observed.uid!==prior.uid||observed.lstart!==prior.lstart:priorWorkerProvenDead(prior.pid,prior.uid,prior.lstart);
    if(!previousOwnerProvenDead){events.close();throw new Error("CODEX_WORKER_PRIOR_OWNER_STILL_ALIVE");}
  }
  const unownedRows=events.listRunningAgentRuns().filter(row=>!prior||row.workerId!==prior.workerId||row.workerGeneration!==prior.generation);
  if(unownedRows.length){events.close();throw new Error("CODEX_WORKER_LEGACY_ACTIVE_RUNS_PRESENT");}
  if(prior){
    for(const row of events.listRunningAgentRuns()){
      const guardian=events.getGuardian(row.workspaceId,row.operationId);
      if(!guardian){events.close();throw new Error("CODEX_WORKER_GUARDIAN_IDENTITY_UNAVAILABLE");}
      const assessment=assessGuardian(guardian);
      if(assessment.kind!="gone"){
        events.close();
        throw new Error(assessment.kind==="alive"?"CODEX_WORKER_PRIOR_GUARDIAN_STILL_ALIVE":"CODEX_WORKER_PRIOR_GUARDIAN_IDENTITY_UNCERTAIN");
      }
    }
  }
  if(existsSync(socketPath)){
    const st=lstatSync(socketPath);
    if(!st.isSocket()||st.uid!==(getuid?.()??-1)||(st.mode&0o077)!==0){events.close();throw new Error("CODEX_WORKER_SOCKET_PATH_UNSAFE");}
    if(await probeExistingSocket(socketPath)==="active"){events.close();throw new Error("CODEX_WORKER_ALREADY_RUNNING");}
    unlinkSync(socketPath);
  }
  const self=inspectProcess(process.pid);
  if(!self||self.uid!==(getuid?.()??-1)){events.close();throw new Error("CODEX_WORKER_PROCESS_IDENTITY_UNKNOWN");}
  const workerId="worker-"+randomUUID();
  const lease=events.acquireWorkerLease({workerId,pid:process.pid,uid:self.uid,lstart:self.lstart,previousOwnerProvenDead});
  // Old RUNNING rows are never replayed. Verify terminal evidence; otherwise
  // preserve them as interrupted/uncertain and let the workspace quarantine gate.
  events.reconcileInterruptedRuns();
  const observer=new AgentObserverStore(2048,32,join(stateDir,"native-agent-observer.sqlite"));
  const workspaceStore=new SqliteWorkspaceStore(stateDir);
  const runner=new NativeCodexAgentRunner({events,observer,auditStore:events,
    nodePath:"/Users/liz/.local/bin/node",codexPath:"/Users/liz/.local/bin/codex",
    workerLease:{workerId,generation:lease.generation}});
  const coach=new ManagedCoachSidecar(undefined,events.path,observer);
  const coachRecovery:{error?:string}={};
  let closing=false,coachRecovering=false;
  const recoverPersistedCoach=async()=>{
    if(closing||coachRecovering)return;
    const persistedCoach=events.coachFeedConfig();
    if(!persistedCoach||coach.status(persistedCoach.workspaceId))return;
    coachRecovering=true;
    try{
      const savedWorkspace=workspaceStore.getSession(persistedCoach.workspaceId);
      if(!savedWorkspace)throw new Error("COACH_FEED_WORKSPACE_UNAVAILABLE");
      const workspaceRoot=withinAllowedWorkspace(savedWorkspace.root,allowedRoots);
      if(workspaceRoot!==withinAllowedWorkspace(persistedCoach.workspaceRoot,allowedRoots))throw new Error("COACH_FEED_WORKSPACE_IDENTITY_MISMATCH");
      for(const id of persistedCoach.authorizedWorkspaceIds){
        const session=workspaceStore.getSession(id);
        if(!session)throw new Error("COACH_FEED_AUTHORIZED_WORKSPACE_MISSING");
        withinAllowedWorkspace(session.root,allowedRoots);
      }
      const pairingToken=secretAt(join(stateDir,COACH_KEY_FILE),false).toString("utf8");
      await coach.start({...persistedCoach,workspaceRoot,pairingToken});coachRecovery.error=undefined;
    }catch(error){coachRecovery.error=coachFailureCode(error);}
    finally{coachRecovering=false;}
  };
  await recoverPersistedCoach();
  const coachRecoveryTimer=setInterval(()=>{void recoverPersistedCoach();},5000);coachRecoveryTimer.unref();
  const dispatch=createCodexWorkerDispatcher({runner,events,coach,workspaceStore,stateDir,workerId,generation:lease.generation,allowedRoots,coachRecovery});
  let connections=0,server:Server;
  const serverClosed=new Promise<void>((resolveClose,rejectClose)=>{
    server=createServer((socket)=>{
      if(closing||connections>=64){send(socket,{ok:false,error:"CODEX_WORKER_DRAINING_OR_BUSY"});return;}
      connections++;socket.setTimeout(10_000,()=>socket.destroy());
      let data=Buffer.alloc(0),handled=false;
      socket.on("data",chunk=>{
        if(handled)return;
        data=Buffer.concat([data,Buffer.from(chunk)]);
        if(data.length>MAX_MESSAGE){handled=true;send(socket,{ok:false,error:"CODEX_WORKER_REQUEST_TOO_LARGE"});return;}
        const newline=data.indexOf(10);if(newline<0)return;
        handled=true;
        if(data.subarray(newline+1).some(byte=>byte!==10&&byte!==13)){send(socket,{ok:false,error:"CODEX_WORKER_INVALID_FRAME"});return;}
        void (async()=>{
          try{
            const request=JSON.parse(data.subarray(0,newline).toString("utf8")) as RpcRequestWithCoach & {token?:unknown};
            if(request.version!==1||!sameSecret(token,request.token))throw new Error("CODEX_WORKER_UNAUTHORIZED");
            const result=await dispatch(request);send(socket,{ok:true,result});
          }catch(error){send(socket,{ok:false,error:errorCode(error)});}
        })();
      });
      socket.once("close",()=>{connections=Math.max(0,connections-1);});
    });
    server.once("error",rejectClose);
    server.listen(socketPath,()=>{
      try{chmodSync(socketPath,0o600);resolveClose();}
      catch(error){rejectClose(error);}
    });
  });
  try { await serverClosed; }
  catch(error) {
    try{server!.close();}catch{/* bind never completed */}
    await runner.close();await coach.close();workspaceStore.close?.();observer.close();events.releaseWorkerLease({workerId,generation:lease.generation});events.close();
    try{const st=lstatSync(socketPath);if(st.isSocket()&&st.uid===(getuid?.()??-1))unlinkSync(socketPath);}catch{/* no socket was created */}
    throw error;
  }
  let stopped=false,leaseLost=false;
  let stopWorker:(()=>Promise<void>)|undefined;
  const heartbeat=setInterval(()=>{
    if(!events.heartbeatWorkerLease({workerId,generation:lease.generation})&&!leaseLost){
      leaseLost=true;closing=true;server.close();
      void stopWorker?.().finally(()=>process.exit(1));
    }
  },5000);heartbeat.unref();
  const close=async()=>{
    if(stopped)return;stopped=true;closing=true;
    server.close();
    clearInterval(coachRecoveryTimer);
    // A controlled Worker stop drains current operations; Guardian remains
    // attached until each result has been journaled and its process group exits.
    while(!leaseLost&&events.listRunningAgentRuns().length>0)await new Promise(resolveWait=>setTimeout(resolveWait,250));
    while(coachRecovering)await new Promise(resolveWait=>setTimeout(resolveWait,25));
    clearInterval(heartbeat);
    await runner.close();
    await coach.close();workspaceStore.close?.();observer.close();events.releaseWorkerLease({workerId,generation:lease.generation});events.close();
    try{const st=lstatSync(socketPath);if(st.isSocket()&&st.uid===(getuid?.()??-1))unlinkSync(socketPath);}catch{/* already removed */}
  };
  stopWorker=close;
  process.once("SIGTERM",()=>{void close().finally(()=>process.exit(0));});
  process.once("SIGINT",()=>{void close().finally(()=>process.exit(0));});
  return {close,socketPath,workerId,generation:lease.generation};
}

export class CodexWorkerClient implements CodexAgentControl {
  private readonly token:Buffer;
  private closing=false;
  constructor(private readonly socketPath:string,keyPath=join(resolve(process.env.DEVSPACE_STATE_DIR??"."),KEY_FILE),private readonly events?:CoachReviewEventStore){
    this.token=secretAt(keyPath,false);
  }
  private async call<T>(request:RpcCall):Promise<T>{
    const payload=Buffer.from(JSON.stringify({version:1,token:this.token.toString("utf8"),...request})+"\n");
    if(payload.length>MAX_MESSAGE)throw new Error("CODEX_WORKER_REQUEST_TOO_LARGE");
    return await new Promise<T>((resolveCall,rejectCall)=>{
      const socket=createConnection(this.socketPath);let result=Buffer.alloc(0),settled=false;
      const done=(error?:Error,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?rejectCall(error):resolveCall(value as T);};
      const timer=setTimeout(()=>done(new Error("CODEX_WORKER_UNAVAILABLE")),10_000);
      socket.once("error",()=>done(new Error("CODEX_WORKER_UNAVAILABLE")));
      socket.on("data",chunk=>{result=Buffer.concat([result,Buffer.from(chunk)]);if(result.length>MAX_MESSAGE)done(new Error("CODEX_WORKER_RESPONSE_TOO_LARGE"));});
      socket.once("end",()=>{
        try{
          const envelope=JSON.parse(result.toString("utf8")) as {ok:boolean;result?:T;error?:string};
          if(!envelope.ok)done(new Error(envelope.error&&/^[A-Z][A-Z0-9_]+$/.test(envelope.error)?envelope.error:"CODEX_WORKER_CALL_FAILED"));
          else done(undefined,envelope.result);
        }catch{done(new Error("CODEX_WORKER_RESPONSE_INVALID"));}
      });
      socket.end(payload);
    });
  }
  start(input:RunnerInput):Promise<RunnerStatus>{return this.call({op:"start",input});}
  async run(input:RunnerInput):Promise<RunnerStatus>{
    let current=await this.start(input);
    while(current.state==="RUNNING"&&!this.closing){
      await new Promise(resolveWait=>setTimeout(resolveWait,500));
      if(this.closing)break;
      current=await this.status(input.operationId,input.workspaceId);
    }
    return current;
  }
  status(operationId:string,workspaceId?:string):Promise<RunnerStatus>{if(!workspaceId)return Promise.reject(new Error("CODEX_WORKSPACE_REQUIRED"));return this.call({op:"status",operationId,workspaceId});}
  getReviewRecommendation(operationId:string,workspaceId:string):Promise<{decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string}|undefined>{return this.call({op:"recommendation",operationId,workspaceId});}
  stop(operationId:string,workspaceId?:string):Promise<boolean>{if(!workspaceId)return Promise.reject(new Error("CODEX_WORKSPACE_REQUIRED"));return this.call({op:"stop",operationId,workspaceId});}
  queueNextSelection(input:Parameters<CodexAgentControl["queueNextSelection"]>[0]):Promise<Awaited<ReturnType<CodexAgentControl["queueNextSelection"]>>>{return this.call({op:"queue",input});}
  activeOperationsForWorkspace(workspaceId:string):string[]{return this.events?.activeAgentOperationsForWorkspace(workspaceId)??[];}
  async close():Promise<void>{this.closing=true;/* API shutdown deliberately does not own or stop the Worker. */}
  async health():Promise<{ready:boolean;workerId:string;generation:number;pid:number;activeRuns:number}>{return this.call({op:"health"});}
  coachStart(input:CoachStartInput):Promise<CoachSidecarStartResult>{return this.call({op:"coach_start",input});}
  coachStop(workspaceId:string):Promise<void>{return this.call({op:"coach_stop",workspaceId}).then(()=>{});}
  coachStatus(workspaceId:string):Promise<CoachSidecarStatus|undefined>{return this.call({op:"coach_status",workspaceId});}
  coachDeliveryReceipt(workspaceId:string,eventId:number):Promise<DeliveryReceipt|undefined>{
    return this.call({op:"coach_delivery_receipt",workspaceId,eventId});
  }
}

export class CodexWorkerCoachClient implements ManagedCoachSidecarControl {
  private readonly worker:CodexWorkerClient;
  constructor(socketPath:string,keyPath:string,private readonly events:CoachReviewEventStore){this.worker=new CodexWorkerClient(socketPath,keyPath,events);}
  start(input:CoachStartInput):Promise<CoachSidecarStartResult>{return this.worker.coachStart(input);}
  stop(workspaceId:string):Promise<void>{return this.worker.coachStop(workspaceId);}
  status(workspaceId:string):Promise<CoachSidecarStatus|undefined>{return this.worker.coachStatus(workspaceId);}
  getDeliveryReceipt(workspaceId:string,eventId:number):Promise<DeliveryReceipt|undefined>{
    return this.worker.coachDeliveryReceipt(workspaceId,eventId);
  }
  activeServiceIdsForRoot(root:string):string[]{return this.events.coachFeedWorkspaceIdsForRoot(root);}
  async close():Promise<void>{/* API lifecycle never stops the independent Worker or Coach Feed. */}
}

export function defaultCodexWorkerSocket(stateDir:string):string{return join(resolve(stateDir),SOCKET_FILE);}
export function defaultCodexWorkerKey(stateDir:string):string{return join(resolve(stateDir),KEY_FILE);}
export function codexWorkerSocketId(stateDir:string):string{return createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0,16);}
