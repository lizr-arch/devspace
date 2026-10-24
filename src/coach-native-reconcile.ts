/**
 * ONEPASS-003-ROLE-005-R2 P0-01: durable out-of-band completion reconciler.
 *
 * sendNativeOutbound may legitimately return ACCEPTED / TURN_OBSERVED /
 * UNCERTAIN before a real Codex development turn finishes (minutes/hours).
 * This DevSpace-owned reconciler later reads the persisted ledger + the exact
 * native rollout and promotes the receipt monotonically:
 *
 *   ACCEPTED -> TURN_OBSERVED -> COMPLETED -> REPLY_VERIFIED
 *
 * It is strictly read-only (never sends/queues/resumes, never requires the
 * ChatGPT GUI or the writer lock), restart-safe (the ledger is the only cursor),
 * idempotent (publisher callback + persisted reviewEventId), and fail-closed
 * (incomplete/ambiguous/identity-mismatched rollouts leave state unchanged, so
 * no false READY_FOR_GPT_REVIEW event can be published).
 *
 * Publication happens ONLY through the caller-provided `deps.publish` /
 * `startNativeOutboundReconciler({onReceipt})` callback (Lead wires
 * publishNativeReceipt). A receipt is publishable only at REPLY_VERIFIED with
 * an exact reply sha; COMPLETED-without-reply stays pending.
 */
import {
 RANK,
 assertValidOperation,
 defaultCodexHome,
 type NativeOutboundReceipt,
 type NativeOutboundRuntime,
 type NativeOutboundState,
 type LedgerRecord,
} from "./coach-native-outbound-types.js";
import {resolveRuntime} from "./coach-native-daemon.js";
import {
 listNativeOutboundReceipts,
 readLedgerRecord,
 writeLedger,
} from "./coach-native-ledger.js";
import {
 analyzeDeliveries,
 findDeliveryForTurn,
 observeRollout,
 selectReply,
 verifyRolloutIdentity,
 type BaselineObservation,
} from "./coach-native-observe.js";
import {sha256Hex} from "./coach-native-outbound-types.js";

export interface NativeReconcileDeps {
 /** Test seam only; production uses the real read-only runtime. */
 runtime?:Partial<NativeOutboundRuntime>;
 /** Caller-provided publisher (Lead wires publishNativeReceipt). */
 publish?:(receipt:NativeOutboundReceipt)=>Promise<{published:boolean;eventId?:string}>;
 log?:(message:string)=>void;
}

export interface ReconcileNativeOperationInput {
 workspaceId:string;
 operationId:string;
 stateDir:string;
 codexHome?:string;
 socketPath?:string;
 deps?:NativeReconcileDeps;
}

export interface ReconcileNativeOperationResult {
 receipt:NativeOutboundReceipt;
 published:boolean;
 eventId?:string;
 /** Stable diagnostic: why the state was or was not advanced/published. */
 reason:string;
}

export interface ReconcilableOperation {
 workspaceId:string;
 operationId:string;
 state:NativeOutboundState;
 updatedAt:number;
}

const RECONCILABLE_STATES:ReadonlySet<NativeOutboundState>=new Set([
 "PRESEND","ACCEPTED","TURN_OBSERVED","UNCERTAIN","COMPLETED","REPLY_VERIFIED",
]);

function unchanged(receipt:NativeOutboundReceipt,reason:string):ReconcileNativeOperationResult{
 return {receipt,published:false,reason};
}

function rankOf(receipt:NativeOutboundReceipt):number{
 return RANK[receipt.state]??-1;
}

/**
 * Reconcile exactly one persisted operation from the native rollout.
 * Never sends/queues/resumes; missing ledger row throws (list* is the safe
 * enumeration API). Publisher is optional: without it state still promotes but
 * nothing is published.
 */
export async function reconcileNativeOperation(
 input:ReconcileNativeOperationInput,
):Promise<ReconcileNativeOperationResult>{
 assertValidOperation(input.workspaceId,input.operationId);
 const ledger=readLedgerRecord(input.stateDir,input.workspaceId,input.operationId);
 if(!ledger){
  throw new Error("RECONCILE_OPERATION_NOT_FOUND");
 }
 let receipt:NativeOutboundReceipt=ledger as NativeOutboundReceipt;
 if(receipt.state==="BLOCKED"){
  return unchanged(receipt,"BLOCKED");
 }
 const runtime=resolveRuntime(input.deps?.runtime);
 const codexHome=input.codexHome??defaultCodexHome();
 const write=(patch:Partial<LedgerRecord>):NativeOutboundReceipt=>
  writeLedger(input.stateDir,input.workspaceId,input.operationId,patch) as NativeOutboundReceipt;

 // P0-01: read-only identity re-verification (no GUI / no writer lock needed).
 const identity=verifyRolloutIdentity(runtime,{
  threadId:receipt.threadId,
  ...(receipt.workspaceRoot?{root:receipt.workspaceRoot}:{}),
  codexHome,
 });
 if(!identity.ok)return unchanged(receipt,"IDENTITY_UNVERIFIED:"+(identity.reason??"UNKNOWN"));

 const observation=observeRollout(runtime,{
  threadId:receipt.threadId,
  codexHome,
  payloadSha256:receipt.payloadSha256,
 });
 if(!observation.available)return unchanged(receipt,"ROLLOUT_UNAVAILABLE");

 // Locate the exact logical delivery for this operation (projection-deduped).
 let analysis:{logicalDeliveries:number;turnId?:string;userItemId?:string;firstNewIndex:number};
 if(receipt.turnId){
  const known=findDeliveryForTurn(observation,receipt.turnId);
  if(!known)return unchanged(receipt,"TURN_NOT_OBSERVED");
  analysis={logicalDeliveries:1,turnId:known.turnId,firstNewIndex:known.firstNewIndex,...(known.userItemId?{userItemId:known.userItemId}:{})};
 }else{
  const baseline:BaselineObservation={
   deliveryTurnIds:new Set(receipt.preObservedTurnIds??[]),
   deliveryItemIds:new Set(receipt.preObservedItemIds??[]),
   started:new Set(),completed:new Set(),size:0,
  };
  analysis=analyzeDeliveries(observation,baseline);
  if(analysis.logicalDeliveries===0)return unchanged(receipt,"DELIVERY_NOT_OBSERVED");
  if(analysis.logicalDeliveries>1)return unchanged(receipt,"DOUBLE_DELIVERY");
 }

 const turnId=analysis.turnId;
 const userItemId=analysis.userItemId;

 // Monotonic promotion; never downgrade and never publish COMPLETED-no-reply.
 if(turnId&&rankOf(receipt)<RANK.TURN_OBSERVED){
  receipt=write({state:"TURN_OBSERVED",turnId,...(userItemId?{userItemId}:{})});
 }
 const started=turnId?observation.started.has(turnId):false;
 const completed=turnId?observation.completed.has(turnId):false;
 if(turnId&&started&&completed&&rankOf(receipt)<RANK.COMPLETED){
  receipt=write({state:"COMPLETED",turnId});
 }
 const reply=turnId?selectReply(observation,{
  logicalDeliveries:1,turnId,firstNewIndex:analysis.firstNewIndex,
 }):undefined;
 if(turnId&&reply&&reply.trim()&&rankOf(receipt)<RANK.REPLY_VERIFIED){
  receipt=write({state:"REPLY_VERIFIED",turnId,reply:reply.slice(0,16_384),replySha256:sha256Hex(reply)});
 }

 if(receipt.state!=="REPLY_VERIFIED"){
  return unchanged(receipt,receipt.state==="COMPLETED"?"REPLY_NOT_VERIFIED":"INCOMPLETE_TURN");
 }
 if(receipt.reviewEventId){
  return {receipt,published:true,eventId:receipt.reviewEventId,reason:"ALREADY_PUBLISHED"};
 }
 const publish=input.deps?.publish;
 if(!publish)return unchanged(receipt,"NO_PUBLISHER");
 let result:{published:boolean;eventId?:string};
 try{result=await publish(receipt);}catch(error){
  input.deps?.log?.("native reconcile publish failed: "+(error instanceof Error?error.message:String(error)));
  return unchanged(receipt,"PUBLISH_FAILED");
 }
 if(!result.published||!result.eventId)return unchanged(receipt,"PUBLISH_NOT_CONFIRMED");
 receipt=write({reviewEventId:result.eventId});
 return {receipt,published:true,eventId:result.eventId,reason:"PUBLISHED"};
}

/** Enumerate every persisted operation that may still advance or publish. */
export function listReconcilableOperations(stateDir:string):ReconcilableOperation[]{
 return listNativeOutboundReceipts(stateDir)
  .filter(receipt=>RECONCILABLE_STATES.has(receipt.state))
  .map(receipt=>({
   workspaceId:receipt.workspaceId,
   operationId:receipt.operationId,
   state:receipt.state,
   updatedAt:receipt.updatedAt,
  }))
  .sort((a,b)=>a.updatedAt-b.updatedAt||a.operationId.localeCompare(b.operationId));
}

export interface StartNativeOutboundReconcilerOptions {
 stateDir:string;
 intervalMs:number;
 onReceipt:(receipt:NativeOutboundReceipt)=>Promise<{published:boolean;eventId?:string}>;
 codexHome?:string;
 deps?:NativeReconcileDeps;
 now?:()=>number;
 setInterval?:(handler:()=>void,timeout:number)=>unknown;
 clearInterval?:(handle:unknown)=>void;
}

export interface NativeOutboundReconciler {
 stop():void;
 /** One bounded pass over the persisted ledger; returns processed operations. */
 tick():Promise<number>;
}

/**
 * Bounded-poll reconciler. Restart-safe: no in-memory cursor is required, every
 * tick rescans the persisted ledger. Overlapping ticks are single-flighted.
 * Per-operation errors are logged and never thrown out of tick/interval.
 */
export function startNativeOutboundReconciler(
 options:StartNativeOutboundReconcilerOptions,
):NativeOutboundReconciler{
 const log=options.deps?.log??((message:string)=>console.error(message));
 let inFlight=false;
 let stopped=false;
 const setIntervalFn=options.setInterval??((handler,timeout)=>setInterval(handler,timeout));
 const clearIntervalFn=options.clearInterval??((handle)=>clearInterval(handle as ReturnType<typeof setInterval>));

 const tick=async():Promise<number>=>{
  if(stopped||inFlight)return 0;
  inFlight=true;
  let processed=0;
  try{
   for(const operation of listReconcilableOperations(options.stateDir)){
    if(stopped)break;
    try{
     await reconcileNativeOperation({
      stateDir:options.stateDir,
      workspaceId:operation.workspaceId,
      operationId:operation.operationId,
      ...(options.codexHome?{codexHome:options.codexHome}:{}),
      deps:{...(options.deps??{}),publish:options.onReceipt},
     });
     processed+=1;
    }catch(error){
     log("native reconcile failed for "+operation.workspaceId+"/"+operation.operationId+": "+
      (error instanceof Error?error.message:String(error)));
    }
   }
  }finally{
   inFlight=false;
  }
  return processed;
 };

 const intervalMs=Math.max(100,Math.floor(options.intervalMs));
 const timer=setIntervalFn(()=>{void tick();},intervalMs);

 return {
  stop():void{
   stopped=true;
   clearIntervalFn(timer);
  },
  tick,
 };
}
