/**
 * ONEPASS-003-NATIVE-TX-004 M1: safe native Codex App outbound delivery core.
 *
 * This file is the orchestrator only. The fail-closed pieces live by ownership
 * (ROLE-005 split):
 *   coach-native-daemon.ts     G1 managed-daemon identity + G2 explicit CLI argv
 *   coach-native-ownership.ts  G4 ChatGPT GUI kernel identity + writer ownership
 *   coach-native-ledger.ts     G5 cross-process O_EXCL ledger / monotonic state
 *   coach-native-observe.ts    G6/G10 read-only native rollout observation
 *   coach-native-outbound-types.ts  shared types, constants, validation helpers
 *
 * Order: claim ledger -> G1 identity -> G4 App ownership -> G1 re-check
 * immediately before the single explicit `codex queue --remote unix://<canonical
 * realpath>` -> ACCEPTED only on exit 0 -> bounded read-only rollout poll ->
 * TURN_OBSERVED/COMPLETED/REPLY_VERIFIED, timeouts persisted as UNCERTAIN with
 * no retry. Never creates/resumes a thread, never uses the implicit backend.
 *
 * All side effects go through the injectable NativeOutboundRuntime, so tests
 * never spawn the real CLI nor touch the daemon/App.
 */
import {join,resolve} from "node:path";
import {
 MAX_PROMPT,
 NativeOutboundError,
 RANK,
 type LedgerRecord,
 type NativeOutboundSandbox,
 type NativeOutboundTaskReference,
 type ManagedDaemonIdentity,
 type NativeOutboundDeps,
 type NativeOutboundReceipt,
 type QueueRunResult,
 assertValidNativeTask,
 assertValidOperation,
 assertValidSandbox,
 assertValidThread,
 defaultCodexHome,
 fail,
 realpathOrThrow,
 sha256Hex,
} from "./coach-native-outbound-types.js";
import {
 assertQueueArgv,
 buildNativeOutboundQueueCommand,
 depsRuntime,
 inspectManagedDaemon,
 resolveRuntime,
} from "./coach-native-daemon.js";
import {verifyNativeAppOwnership} from "./coach-native-ownership.js";
import {
 TERMINAL_STATES,
 claimOperation,
 readLedgerRecord,
 readNativeOutboundReceipt,
 writeLedger,
} from "./coach-native-ledger.js";
import {
 analyzeDeliveries,
 baselineOf,
 observeRollout,
 parseQueuedMessage,
 selectReply,
 selectVerifiedReply,
 type ObservedRollout,
} from "./coach-native-observe.js";

export type {
 LedgerRecord,
 ManagedDaemonIdentity,
 ManagedProcessInfo,
 NativeOutboundDeps,
 NativeOutboundQueueCommand,
 NativeOutboundReceipt,
 NativeOutboundRuntime,
 NativeOutboundState,
 NativeOutboundSandbox,
 NativeOutboundTaskReference,
 FileStatLike,
 QueueRunResult,
} from "./coach-native-outbound-types.js";
export {
 NativeOutboundError,
 assertValidNativeTask,
 assertValidSandbox,
 nativeJournalTaskFields,
 sha256Hex,
} from "./coach-native-outbound-types.js";
export {
 assertQueueArgv,
 buildNativeOutboundQueueCommand,
 inspectManagedDaemon,
 setNativeOutboundTestRuntime,
} from "./coach-native-daemon.js";
export {verifyNativeAppOwnership} from "./coach-native-ownership.js";
export {claimOperation,readNativeOutboundReceipt} from "./coach-native-ledger.js";

/**
 * G2/G4/G5/G6/G10: the only sanctioned outbound path.
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
 /** Optional frozen TASK identity (P0-02); absent => explicit read-only/read-only. */
 task?:NativeOutboundTaskReference;
 sandbox?:NativeOutboundSandbox;
 deps?:NativeOutboundDeps;
}):Promise<NativeOutboundReceipt>{
 assertValidOperation(input.workspaceId,input.operationId);
 assertValidThread(input.threadId);
 if(typeof input.prompt!=="string"||!input.prompt.trim())fail("PROMPT_INVALID","prompt must be non-empty");
 if(input.prompt.length>MAX_PROMPT)fail("PROMPT_TOO_LONG","prompt exceeds "+MAX_PROMPT+" characters");
 const sandbox:NativeOutboundSandbox=input.sandbox??"read-only";
 assertValidSandbox(sandbox);
 if(input.task)assertValidNativeTask(input.task);
 if(sandbox==="workspace-write"&&!input.task)fail("TASK_REQUIRED_FOR_WORKSPACE_WRITE","workspace-write native send requires a frozen task reference");
 const deps=input.deps??{};
 const runtime=resolveRuntime(depsRuntime(deps));
 const codexHome=resolve(input.codexHome??deps.codexHome??defaultCodexHome());
 const root=realpathOrThrow(runtime,input.root,"ROOT_UNRESOLVABLE");
 const payloadSha256=sha256Hex(input.prompt);
 const fingerprint=sha256Hex(JSON.stringify({v:1,workspaceId:input.workspaceId,root,threadId:input.threadId,payloadSha256,
  ...(input.task?{taskId:input.task.taskId,taskSha256:input.task.sha256,sandbox}:{})}));
 const timeoutMs=Math.min(Math.max(input.timeoutMs??deps.timeoutMs??120_000,1_000),600_000);
 const observeTimeoutMs=Math.min(Math.max(input.observeTimeoutMs??deps.observeTimeoutMs??30_000,0),600_000);
 const pollMs=Math.min(Math.max(deps.pollMs??100,10),5_000);
 const socketPath=input.socketPath??join(codexHome,"app-server-control","app-server-control.sock");

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
 persist({state:"PRESEND",workspaceRoot:root,sandbox});

 try{
  const inspect=async():Promise<ManagedDaemonIdentity>=>{
   if(deps.inspectDaemon)return deps.inspectDaemon({codexHome,socketPath});
   return inspectManagedDaemon({codexHome,socketPath,deps:{runtime:depsRuntime(deps)}});
  };
  const verify=():{threadId:string;root:string;status:string}=>{
   if(deps.verifyOwnership)return deps.verifyOwnership({threadId:input.threadId,root,codexHome,socketPath});
   return verifyNativeAppOwnership({threadId:input.threadId,root,codexHome});
  };

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
  const baselineFields={
   preObservedTurnIds:[...baseline.deliveryTurnIds],
   preObservedItemIds:[...baseline.deliveryItemIds],
  };

  // Exactly one CLI invocation. No retry on any outcome.
  let run:QueueRunResult;
  try{run=runtime.runQueue({codexBin:command.codexBin,argv:command.argv,env:command.env,timeoutMs});}
  catch(error){
   persist({state:"UNCERTAIN",uncertaintyReason:"CLI_SPAWN_UNCERTAIN",error:error instanceof Error?error.message:String(error),...baselineFields});
   return current;
  }
  if(run.error==="TIMEOUT"||run.code===null){
   persist({state:"UNCERTAIN",uncertaintyReason:run.error==="TIMEOUT"?"CLI_TIMEOUT":"CLI_UNCERTAIN",queueExitCode:run.code??undefined,error:run.stderr.slice(0,2000),...baselineFields});
   return current;
  }
  if(run.code!==0){
   persist({state:"BLOCKED",queueExitCode:run.code,error:(run.stderr||run.stdout||"queue exited "+run.code).slice(0,4000),...baselineFields});
   fail("QUEUE_EXIT_NONZERO","queue exited "+run.code+": "+run.stderr.trim().slice(0,500));
  }
  const queued=parseQueuedMessage(run.stdout);
  if(!queued){
   // Exit 0 with unparseable stdout can still have persisted a row; never retry.
   persist({state:"ACCEPTED",queueExitCode:0,uncertaintyReason:"QUEUE_ACCEPTED_UNPARSED",...baselineFields});
  }else if(queued.threadId!==input.threadId){
   persist({state:"UNCERTAIN",queueMessageId:queued.messageId,queueExitCode:0,uncertaintyReason:"QUEUE_THREAD_MISMATCH",...baselineFields});
   fail("QUEUE_THREAD_MISMATCH","CLI queued to a different thread: "+queued.threadId);
  }else{
   persist({state:"ACCEPTED",queueMessageId:queued.messageId,queueExitCode:0,...baselineFields});
  }

  // G6/G10: bounded, read-only observation of the exact native rollout.
  const deadline=runtime.now()+observeTimeoutMs;
  const maxIterations=Math.max(1,Math.ceil(observeTimeoutMs/Math.max(pollMs,1))+2);
  let cached:{size:number;observation:ObservedRollout}|undefined;
  let lastSeen=current;
  for(let iteration=0;iteration<maxIterations;iteration++){
   const observation=observeRollout(runtime,{threadId:input.threadId,codexHome,payloadSha256,...(cached?{cached}:{})});
   if(observation.available)cached={size:observation.size,observation};

   const analysis=analyzeDeliveries(observation,baseline);
   if(analysis.logicalDeliveries>1){
    persist({state:"UNCERTAIN",uncertaintyReason:"DOUBLE_DELIVERY",...(analysis.userItemId?{userItemId:analysis.userItemId}:{})});
    return current;
   }
   if(analysis.logicalDeliveries===1){
    const {turnId,userItemId}=analysis;
    lastSeen=persist({state:"TURN_OBSERVED",...(turnId?{turnId}:{}),...(userItemId?{userItemId}:{})});
    const startedNow=turnId?observation.started.has(turnId):false;
    const completedNow=turnId?observation.completed.has(turnId):false;
    if(startedNow&&completedNow)lastSeen=persist({state:"COMPLETED",...(turnId?{turnId}:{})});
    // P0-1: assistant text before task_complete is not a completed reply.
    const reply=selectVerifiedReply(observation,analysis);
    if(reply){
     lastSeen=persist({state:"REPLY_VERIFIED",reply:reply.slice(0,16_384),replySha256:sha256Hex(reply),...(turnId?{turnId}:{})});
     return current;
    }
    if(completedNow)return current;
   }
   if(runtime.now()>=deadline)break;
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
