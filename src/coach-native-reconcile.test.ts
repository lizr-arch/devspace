/**
 * ONEPASS-003-ROLE-005-R2 P0-01/P0-02/P1-06 tests: durable native completion
 * reconciler, frozen TASK continuity in send, and no-reply publish semantics.
 *
 * Verified behavior (all injected; no real CLI/daemon/App/Chrome/A-B-S2):
 *  - a completion delayed past the bounded send observation is later reconciled
 *    from the persisted ledger and published exactly once;
 *  - restart (new reconciler instance) resumes from ledger, not memory;
 *  - two concurrent reconcilers produce one event (publisher/event idempotency);
 *  - corrupt/identity-mismatched/unavailable rollouts and interrupted or double
 *    deliveries never publish a false READY;
 *  - COMPLETED-without-reply stays pending and publishes only after REPLY_VERIFIED;
 *  - UNCERTAIN is never resent (reconciler has no send path);
 *  - identical prompt with a frozen TASK vs read-only is a distinct operation.
 *
 * Run: node --import tsx src/coach-native-reconcile.test.ts
 * Prints: NATIVE_RECONCILE_TEST_PASS <n>
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,unlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {
 sendNativeOutbound,
 readNativeOutboundReceipt,
 NativeOutboundError,
 sha256Hex,
 nativeJournalTaskFields,
 type NativeOutboundReceipt,
} from "./coach-native-outbound.js";
import {
 reconcileNativeOperation,
 listReconcilableOperations,
 startNativeOutboundReconciler,
} from "./coach-native-reconcile.js";

const uid=process.getuid?.()??501;
const BASE=realpathSync(mkdtempSync(join(tmpdir(),"native-reconcile-")));
const HOME=join(BASE,".codex");
const STATE=join(BASE,"state");
const ROOT=join(BASE,"workspace");
const OTHER_ROOT=join(BASE,"other-workspace");
mkdirSync(join(HOME,"sessions","2026","10","24"),{recursive:true,mode:0o700});
mkdirSync(ROOT,{recursive:true,mode:0o700});
mkdirSync(OTHER_ROOT,{recursive:true,mode:0o700});
mkdirSync(STATE,{recursive:true,mode:0o700});

let passed=0;
function check(name:string,fn:()=>void):void{fn();passed++;process.stdout.write("PASS "+name+"\n");}
async function checkAsync(name:string,fn:()=>Promise<void>):Promise<void>{await fn();passed++;process.stdout.write("PASS "+name+"\n");}
async function expectRejectAsync(promise:Promise<unknown>,code:string|RegExp):Promise<NativeOutboundError>{
 try{await promise;}catch(error){
  assert.ok(error instanceof NativeOutboundError,"expected NativeOutboundError, got "+String(error));
  if(typeof code==="string")assert.equal(error.code,code);else assert.match(error.code,code);
  return error;
 }
 throw new Error("expected rejection "+String(code));
}
function expectRejectSync(fn:()=>unknown,code:string|RegExp):NativeOutboundError{
 try{fn();}catch(error){
  assert.ok(error instanceof NativeOutboundError,"expected NativeOutboundError, got "+String(error));
  if(typeof code==="string")assert.equal(error.code,code);else assert.match(error.code,code);
  return error;
 }
 throw new Error("expected rejection "+String(code));
}

/* ------------------------------ fixture helpers ------------------------------ */

const IDENTITY={pid:4242,version:"0.164.0-aarch64-apple-darwin",
 executable:join(HOME,"packages","app-server-daemon","releases","0.164.0-aarch64-apple-darwin","bin","codex"),
 socketPath:join(HOME,"app-server-control","app-server-control.sock"),
 socketRealpath:"/private/tmp/codex-daemon-"+uid+"/"+"a".repeat(64),
 codexHome:resolve(HOME),bootId:"BOOT-1",startSeconds:1792834737};

function rolloutPath(threadId:string):string{
 return join(HOME,"sessions","2026","10","24","rollout-2026-10-24T22-00-00-"+threadId+".jsonl");
}
function metaRecord(threadId:string,root=ROOT):unknown{
 return {type:"session_meta",payload:{id:threadId,session_id:threadId,source:"vscode",cwd:root}};
}
function initThread(threadId:string):string{
 const path=rolloutPath(threadId);
 writeFileSync(path,[metaRecord(threadId)].map(record=>JSON.stringify(record)).join("\n")+"\n",{mode:0o600});
 return path;
}
function appendRecords(threadId:string,records:unknown[]):void{
 appendFileSync(rolloutPath(threadId),records.map(record=>JSON.stringify(record)).join("\n")+"\n",{mode:0o600});
}
function rewriteRollout(threadId:string,records:unknown[]):void{
 writeFileSync(rolloutPath(threadId),records.map(record=>JSON.stringify(record)).join("\n")+"\n",{mode:0o600});
}
const userItem=(turnId:string,itemId:string,text:string)=>({type:"event_msg",payload:{type:"item_completed",turn_id:turnId,
 item:{type:"UserMessage",id:itemId,content:[{type:"text",text}]}}});
const assistantItem=(turnId:string,itemId:string,text:string)=>({type:"event_msg",payload:{type:"item_completed",turn_id:turnId,
 item:{type:"AgentMessage",id:itemId,content:[{type:"text",text}]}}});
const taskStarted=(turnId:string)=>({type:"event_msg",payload:{type:"task_started",turn_id:turnId,root_turn_id:turnId,
 turn_attribution:{turn_id:turnId,turn_trigger:"queue"}}});
const taskComplete=(turnId:string)=>({type:"event_msg",payload:{type:"task_complete",turn_id:turnId,root_turn_id:turnId}});

interface SendHarness {
 queueCalls:Array<{argv:string[];env:Record<string,string|undefined>}>;
 send:(options:{operationId:string;threadId:string;prompt:string;task?:Parameters<typeof sendNativeOutbound>[0]["task"];sandbox?:Parameters<typeof sendNativeOutbound>[0]["sandbox"];observeTimeoutMs?:number;runQueue?:()=>{code:number|null;stdout:string;stderr:string}}) => Promise<NativeOutboundReceipt>;
}
function makeSendHarness():SendHarness{
 const queueCalls:SendHarness["queueCalls"]=[];
 return {
  queueCalls,
  send:async(options)=>{
   let clock=1_000_000;
   return sendNativeOutbound({
    workspaceId:"ws-recon",
    root:ROOT,
    threadId:options.threadId,
    operationId:options.operationId,
    prompt:options.prompt,
    stateDir:STATE,
    codexHome:HOME,
    observeTimeoutMs:options.observeTimeoutMs??20,
    timeoutMs:1_000,
    ...(options.task?{task:options.task}:{}),
    ...(options.sandbox?{sandbox:options.sandbox}:{}),
    deps:{
     pollMs:5,
     inspectDaemon:async()=>IDENTITY,
     verifyOwnership:()=>({threadId:options.threadId,root:ROOT,status:"APP_OWNED"}),
     runtime:{
      now:()=>clock,
      sleep:async(ms)=>{clock+=ms;},
      runQueue:(input)=>{
       queueCalls.push({argv:input.argv,env:input.env});
       const result=options.runQueue?options.runQueue():{code:0,stdout:"Queued message "+randomUUID()+" for thread "+options.threadId+".\n",stderr:""};
       return result;
      },
     },
    },
   });
  },
 };
}

interface Publisher {calls:number;events:Map<string,string>;publish:(receipt:NativeOutboundReceipt)=>Promise<{published:boolean;eventId?:string}>}
function makePublisher():Publisher{
 const events=new Map<string,string>();
 let calls=0;
 return {
  get calls(){return calls;},
  events,
  publish:async(receipt)=>{
   calls+=1;
   const eventId="app:"+sha256Hex(receipt.workspaceId+"\0"+receipt.operationId);
   assert.ok(receipt.state==="REPLY_VERIFIED","only REPLY_VERIFIED may be published");
   assert.ok(typeof receipt.turnId==="string"&&receipt.turnId.length>0);
   assert.ok(typeof receipt.reply==="string"&&receipt.reply.trim().length>0);
   assert.equal(receipt.replySha256,sha256Hex(receipt.reply!));
   if(!events.has(eventId))events.set(eventId,receipt.turnId!);
   return {published:true,eventId};
  },
 };
}

type Mode="never"|"incomplete"|"completed-no-reply"|"reply";
async function createOperation(harness:SendHarness,mode:Mode,options:{operationId?:string;threadId?:string;prompt?:string;task?:Parameters<typeof sendNativeOutbound>[0]["task"];sandbox?:Parameters<typeof sendNativeOutbound>[0]["sandbox"]}={}):Promise<{operationId:string;threadId:string;prompt:string;receipt:NativeOutboundReceipt}>{
 const operationId=options.operationId??"op-"+randomUUID();
 const threadId=options.threadId??randomUUID();
 const prompt=options.prompt??"native reconcile prompt "+operationId;
 initThread(threadId);
 const turnId="turn-"+randomUUID();
 const receipt=await harness.send({
  operationId,threadId,prompt,
  ...(options.task?{task:options.task}:{}),
  ...(options.sandbox?{sandbox:options.sandbox}:{}),
  runQueue:()=>{
   if(mode==="incomplete")appendRecords(threadId,[taskStarted(turnId),userItem(turnId,"u-"+turnId,prompt)]);
   else if(mode==="completed-no-reply")appendRecords(threadId,[taskStarted(turnId),userItem(turnId,"u-"+turnId,prompt),taskComplete(turnId)]);
   else if(mode==="reply")appendRecords(threadId,[taskStarted(turnId),userItem(turnId,"u-"+turnId,prompt),assistantItem(turnId,"a-"+turnId,"reply "+turnId),taskComplete(turnId)]);
   return {code:0,stdout:"Queued message "+randomUUID()+" for thread "+threadId+".\n",stderr:""};
  },
 });
 return {operationId,threadId,prompt,receipt};
}
function completeLater(threadId:string,turnId:string,prompt:string,reply="delayed reply"):void{
 appendRecords(threadId,[taskStarted(turnId),userItem(turnId,"u-"+turnId,prompt),assistantItem(turnId,"a-"+turnId,reply),taskComplete(turnId)]);
}

/* ------------------------------ tests ------------------------------ */

async function main():Promise<void>{
 const harness=makeSendHarness();
 try{
  check("listReconcilableOperations on empty stateDir is empty",()=>{
   assert.deepEqual(listReconcilableOperations(STATE),[]);
  });

  const delayed=await createOperation(harness,"never",{prompt:"DELAYED COMPLETION PROOF"});
  const publisher=makePublisher();
  let intervalHandler:(()=>void)|undefined;
  const cleared:unknown[]=[];
  const reconciler=startNativeOutboundReconciler({
   stateDir:STATE,intervalMs:50,codexHome:HOME,onReceipt:publisher.publish,
   setInterval:(handler,timeout)=>{assert.equal(timeout,100);intervalHandler=handler;return "timer-1";},
   clearInterval:(handle)=>{cleared.push(handle);},
  });

  await checkAsync("delayed completion tick1: ACCEPTED/UNCERTAIN unchanged, no publish",async()=>{
   const before=readNativeOutboundReceipt(STATE,"ws-recon",delayed.operationId)!;
   assert.equal(before.state,"UNCERTAIN");
   assert.equal(before.uncertaintyReason,"OBSERVE_TIMEOUT");
   assert.ok(Array.isArray(before.preObservedTurnIds));
   const processed=await reconciler.tick();
   assert.equal(processed,1);
   assert.equal(publisher.events.size,0);
   assert.equal(publisher.calls,0);
   const after=readNativeOutboundReceipt(STATE,"ws-recon",delayed.operationId)!;
   assert.equal(after.state,"UNCERTAIN");
   assert.equal(after.reviewEventId,undefined);
  });

  await checkAsync("delayed completion tick2 (>observation): promotes REPLY_VERIFIED and publishes once",async()=>{
   const before=readNativeOutboundReceipt(STATE,"ws-recon",delayed.operationId)!;
   const turnId="turn-"+randomUUID();
   completeLater(delayed.threadId,turnId,delayed.prompt);
   const processed=await reconciler.tick();
   const dbg=readNativeOutboundReceipt(STATE,"ws-recon",delayed.operationId)!;
   process.stdout.write("DEBUG2 state="+dbg.state+" turn="+dbg.turnId+" reply="+dbg.reply+"\n");
   const direct=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:delayed.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher.publish}});
   process.stdout.write("DEBUG2 direct="+direct.reason+" state="+direct.receipt.state+"\n");
   assert.equal(processed,1);
   assert.equal(publisher.events.size,1);
   assert.equal(publisher.calls,1);
   const receipt=readNativeOutboundReceipt(STATE,"ws-recon",delayed.operationId)!;
   assert.equal(receipt.state,"REPLY_VERIFIED");
   assert.equal(receipt.turnId,turnId);
   assert.equal(receipt.payloadSha256,sha256Hex(delayed.prompt));
   assert.equal(receipt.reply,"delayed reply");
   assert.equal(receipt.replySha256,sha256Hex("delayed reply"));
   assert.equal(receipt.reviewEventId,"app:"+sha256Hex("ws-recon\0"+delayed.operationId));
   assert.equal(before.state,"UNCERTAIN");
  });

  await checkAsync("restart simulation: new reconciler instance publishes nothing new (ledger cursor)",async()=>{
   const callsBefore=publisher.calls;
   const restarted=startNativeOutboundReconciler({
    stateDir:STATE,intervalMs:1_000,codexHome:HOME,onReceipt:publisher.publish,
    setInterval:()=>"timer-restart",clearInterval:()=>{},
   });
   const processed=await restarted.tick();
   restarted.stop();
   assert.equal(processed,1);
   assert.equal(publisher.calls,callsBefore);
   assert.equal(publisher.events.size,1);
  });

  await checkAsync("two reconcilers racing => exactly one durable event for the operation",async()=>{
   const racing=await createOperation(harness,"never",{prompt:"RACING RECONCILER PROOF"});
   completeLater(racing.threadId,"turn-"+randomUUID(),racing.prompt);
   const publisher2=makePublisher();
   const instanceA=startNativeOutboundReconciler({stateDir:STATE,intervalMs:1_000,codexHome:HOME,onReceipt:publisher2.publish,setInterval:()=>"a",clearInterval:()=>{}});
   const instanceB=startNativeOutboundReconciler({stateDir:STATE,intervalMs:1_000,codexHome:HOME,onReceipt:publisher2.publish,setInterval:()=>"b",clearInterval:()=>{}});
   await Promise.all([instanceA.tick(),instanceB.tick()]);
   instanceA.stop();instanceB.stop();
   assert.equal(publisher2.events.size,1);
   const receipt=readNativeOutboundReceipt(STATE,"ws-recon",racing.operationId)!;
   assert.equal(receipt.state,"REPLY_VERIFIED");
   assert.ok(receipt.reviewEventId);
  });

  await checkAsync("overlapping tick guard: second concurrent tick is a no-op",async()=>{
   const slow=await createOperation(harness,"never",{prompt:"OVERLAP GUARD PROOF"});
   completeLater(slow.threadId,"turn-"+randomUUID(),slow.prompt);
   let release!:()=>void;
   const gate=new Promise<void>(resolveGate=>{release=resolveGate;});
   let publishCalls=0;
   const reconcilerSlow=startNativeOutboundReconciler({
    stateDir:STATE,intervalMs:1_000,codexHome:HOME,
    onReceipt:async()=>{publishCalls+=1;await gate;return {published:true,eventId:"app:"+sha256Hex("x")};},
    setInterval:()=>"slow",clearInterval:()=>{},
   });
   const first=reconcilerSlow.tick();
   const second=reconcilerSlow.tick();
   assert.equal(await second,0,"overlapping tick must return 0");
   release();
   const firstCount=await first;
   assert.ok(firstCount>=1);
   reconcilerSlow.stop();
   assert.equal(publishCalls,1);
  });

  await checkAsync("metadata corruption => state unchanged, no publish",async()=>{
   const corrupt=await createOperation(harness,"never",{prompt:"CORRUPT ROLLOUT PROOF"});
   const path=rolloutPath(corrupt.threadId);
   writeFileSync(path,[JSON.stringify(metaRecord(corrupt.threadId)),'{"broken":',JSON.stringify(userItem("t","u",corrupt.prompt))].join("\n")+"\n",{mode:0o600});
   const publisher3=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:corrupt.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher3.publish}});
   assert.equal(result.published,false);
   assert.equal(publisher3.events.size,0);
   assert.equal(result.receipt.state,"UNCERTAIN");
   assert.match(result.reason,/IDENTITY_UNVERIFIED|ROLLOUT_UNAVAILABLE/);
  });

  await checkAsync("rollout identity mismatch (wrong cwd) => no publish, unchanged",async()=>{
   const mismatch=await createOperation(harness,"never",{prompt:"IDENTITY MISMATCH PROOF"});
   rewriteRollout(mismatch.threadId,[metaRecord(mismatch.threadId,OTHER_ROOT),taskStarted("t"),userItem("t","u",mismatch.prompt)]);
   const publisher4=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:mismatch.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher4.publish}});
   assert.equal(result.published,false);
   assert.equal(publisher4.events.size,0);
   assert.equal(result.receipt.state,"UNCERTAIN");
   assert.match(result.reason,/IDENTITY_UNVERIFIED/);
  });

  await checkAsync("rollout unavailable (daemon/store gone) => state unchanged, no publish",async()=>{
   const missing=await createOperation(harness,"never",{prompt:"UNAVAILABLE ROLLOUT PROOF"});
   unlinkSync(rolloutPath(missing.threadId));
   const publisher5=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:missing.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher5.publish}});
   assert.equal(result.published,false);
   assert.equal(publisher5.events.size,0);
   assert.equal(result.receipt.state,"UNCERTAIN");
   assert.match(result.reason,/IDENTITY_UNVERIFIED/);
  });

  const interrupted=await createOperation(harness,"incomplete",{prompt:"INTERRUPTED TASK PROOF"});
  await checkAsync("interrupted task (task_started without complete) => TURN_OBSERVED only, no publish",async()=>{
   assert.equal(interrupted.receipt.state,"TURN_OBSERVED");
   const publisher6=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:interrupted.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher6.publish}});
   assert.equal(result.receipt.state,"TURN_OBSERVED");
   assert.equal(result.published,false);
   assert.equal(publisher6.events.size,0);
   assert.equal(result.reason,"INCOMPLETE_TURN");
  });

  await checkAsync("double delivery (two new turns, same text) => no publish, state unchanged",async()=>{
   const double=await createOperation(harness,"never",{prompt:"DOUBLE DELIVERY PROOF"});
   appendRecords(double.threadId,[
    taskStarted("t-a"),userItem("t-a","u-a",double.prompt),taskComplete("t-a"),
    taskStarted("t-b"),userItem("t-b","u-b",double.prompt),taskComplete("t-b"),
   ]);
   const publisher7=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:double.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher7.publish}});
   assert.equal(result.published,false);
   assert.equal(result.receipt.state,"UNCERTAIN");
   assert.equal(result.reason,"DOUBLE_DELIVERY");
   assert.equal(publisher7.events.size,0);
  });

  await checkAsync("COMPLETED without reply => no event; publishes only after REPLY_VERIFIED",async()=>{
   const noReply=await createOperation(harness,"completed-no-reply",{prompt:"NO REPLY PROOF"});
   assert.equal(noReply.receipt.state,"COMPLETED");
   const publisher8=makePublisher();
   const first=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:noReply.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher8.publish}});
   assert.equal(first.published,false);
   assert.equal(first.receipt.state,"COMPLETED");
   assert.equal(first.reason,"REPLY_NOT_VERIFIED");
   assert.equal(publisher8.events.size,0);
   appendRecords(noReply.threadId,[assistantItem(noReply.receipt.turnId!,"a-late","late verified reply")]);
   const second=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:noReply.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher8.publish}});
   assert.equal(second.published,true);
   assert.equal(second.receipt.state,"REPLY_VERIFIED");
   assert.equal(second.receipt.reply,"late verified reply");
   assert.equal(second.receipt.replySha256,sha256Hex("late verified reply"));
   assert.equal(publisher8.events.size,1);
  });

  await checkAsync("no publisher configured => state promotes but nothing is published",async()=>{
   const noPublisher=await createOperation(harness,"reply",{prompt:"NO PUBLISHER PROOF"});
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:noPublisher.operationId,stateDir:STATE,codexHome:HOME});
   assert.equal(result.receipt.state,"REPLY_VERIFIED");
   assert.equal(result.published,false);
   assert.equal(result.reason,"NO_PUBLISHER");
  });

  await checkAsync("publisher failure is retried safely on a later tick",async()=>{
   const flaky=await createOperation(harness,"reply",{prompt:"PUBLISH RETRY PROOF"});
   const logs:string[]=[];
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:flaky.operationId,stateDir:STATE,codexHome:HOME,
    deps:{publish:async()=>{throw new Error("store offline");},log:message=>logs.push(message)}});
   assert.equal(result.published,false);
   assert.equal(result.reason,"PUBLISH_FAILED");
   assert.equal(logs.length,1);
   const publisher9=makePublisher();
   const retry=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:flaky.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher9.publish}});
   assert.equal(retry.published,true);
   assert.equal(publisher9.events.size,1);
  });

  await checkAsync("UNCERTAIN is never resent: reconciler has no CLI/queue path",async()=>{
   const never=await createOperation(harness,"never",{prompt:"NEVER RESENT PROOF",operationId:"op-never-resend"});
   const callsBefore=harness.queueCalls.length;
   const publisher10=makePublisher();
   const result=await reconcileNativeOperation({workspaceId:"ws-recon",operationId:never.operationId,stateDir:STATE,codexHome:HOME,deps:{publish:publisher10.publish}});
   assert.equal(result.receipt.state,"UNCERTAIN");
   assert.equal(result.published,false);
   assert.equal(harness.queueCalls.length,callsBefore,"reconciler must never invoke the queue CLI");
   assert.equal(publisher10.events.size,0);
  });

  check("listReconcilableOperations enumerates pending/incomplete ops and excludes BLOCKED",()=>{
   const blocked={state:"BLOCKED",workspaceId:"ws-recon",operationId:"op-blocked",threadId:"t",payloadSha256:sha256Hex("x"),createdAt:1,updatedAt:1};
   writeFileSync(join(STATE,"native-outbound",sha256Hex("ws-recon\0"+"op-blocked")+".json"),JSON.stringify({...blocked,fingerprint:"f"}),{mode:0o600});
   const rows=listReconcilableOperations(STATE);
   assert.ok(rows.length>=1);
   assert.ok(rows.every(row=>row.state!=="BLOCKED"));
   assert.ok(rows.some(row=>row.operationId===delayed.operationId&&row.state==="REPLY_VERIFIED"));
   assert.ok(rows.some(row=>row.operationId===interrupted.operationId&&row.state==="TURN_OBSERVED"));
  });

  await checkAsync("reconcile missing operation throws RECONCILE_OPERATION_NOT_FOUND",async()=>{
   await assert.rejects(
    reconcileNativeOperation({workspaceId:"ws-recon",operationId:"op-does-not-exist",stateDir:STATE,codexHome:HOME}),
    /RECONCILE_OPERATION_NOT_FOUND/,
   );
  });

  await checkAsync("task-continuity-aware send: frozen TASK changes operation identity, invalid/absent task fails closed",async()=>{
   const threadId=randomUUID();initThread(threadId);
   const task={taskPath:".devspace/tasks/R2.md",taskId:"ROLE-005-R2-TASK-1",sha256:sha256Hex("frozen task")};
   assert.deepEqual(nativeJournalTaskFields(task),{taskId:task.taskId,taskSha256:task.sha256});
   const firstOp="op-task-"+randomUUID();
   const first=await harness.send({operationId:firstOp,threadId,prompt:"task continuity prompt",task});
   assert.equal(first.state,"UNCERTAIN");
   const conflict=await harness.send({operationId:firstOp,threadId,prompt:"task continuity prompt"}).catch(error=>error as NativeOutboundError);
   assert.ok(conflict instanceof NativeOutboundError);
   assert.equal(conflict.code,"OPERATION_CONFLICT");
   await expectRejectAsync(harness.send({operationId:"op-invalid-task-"+randomUUID(),threadId,prompt:"x",task:{...task,sha256:"not-a-sha"}}),"TASK_REFERENCE_INVALID");
   await expectRejectAsync(harness.send({operationId:"op-workspace-write-no-task-"+randomUUID(),threadId,prompt:"x",sandbox:"workspace-write"}),"TASK_REQUIRED_FOR_WORKSPACE_WRITE");
  });

  await checkAsync("reconciler tick tolerates malformed ledger rows without throwing",async()=>{
   const logs:string[]=[];
   const brokenDir=join(STATE,"native-outbound");
   const brokenPath=join(brokenDir,"broken-entry.json");
   writeFileSync(brokenPath,"{not-json",{mode:0o600});
   const reconciler2=startNativeOutboundReconciler({
    stateDir:STATE,intervalMs:1_000,codexHome:HOME,onReceipt:async()=>({published:true,eventId:"app:"+sha256Hex("x")}),
    deps:{log:message=>logs.push(message)},
    setInterval:()=>"timer-log",clearInterval:()=>{},
   });
   const processed=await reconciler2.tick();
   reconciler2.stop();
   assert.ok(processed>=0);
   assert.equal(existsSync(brokenPath),true);
  });

  process.stdout.write("NATIVE_RECONCILE_TEST_PASS "+passed+"\n");
 }finally{
  rmSync(BASE,{recursive:true,force:true});
 }
}

await main();
