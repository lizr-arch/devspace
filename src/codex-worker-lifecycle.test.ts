import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { CodexWorkerClient, CodexWorkerCoachClient, defaultCodexWorkerKey, defaultCodexWorkerSocket, startCodexWorkerService } from "./codex-worker-ipc.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root=mkdtempSync(join(tmpdir(),"devspace-worker-lease-"));
try{
 const store=new CoachReviewEventStore(root);
 const first=store.acquireWorkerLease({workerId:"worker-one",pid:9001,uid:501,lstart:"Mon Oct 14 12:00:00 2026",previousOwnerProvenDead:true});
 assert.equal(first.generation,1);
 store.claimAgentRun({workspaceId:"ws-safe",operationId:"op-safe",requestSha256:"a".repeat(64),workerId:first.workerId,generation:first.generation});
 assert.equal(store.getAgentRun("ws-safe","op-safe")?.workerGeneration,1);
 assert.throws(()=>store.claimAgentRun({workspaceId:"ws-safe",operationId:"op-wrong",requestSha256:"b".repeat(64),workerId:first.workerId,generation:2}),/COACH_WORKER_FENCED/);
 assert.equal(store.heartbeatAgentRun({workspaceId:"ws-safe",operationId:"op-safe",workerId:first.workerId,generation:first.generation}),true);
 const second=store.acquireWorkerLease({workerId:"worker-two",pid:9002,uid:501,lstart:"Mon Oct 14 12:01:00 2026",previousOwnerProvenDead:true});
 assert.equal(second.generation,2);
 assert.equal(store.heartbeatAgentRun({workspaceId:"ws-safe",operationId:"op-safe",workerId:first.workerId,generation:first.generation}),false);
 assert.throws(()=>store.finishAgentRun({workspaceId:"ws-safe",operationId:"op-safe",state:"FAILED",workerId:first.workerId,generation:first.generation}),/COACH_WORKER_FENCED/);
 store.reconcileInterruptedRuns();
 assert.equal(store.getAgentRun("ws-safe","op-safe")?.state,"INTERRUPTED");
 assert.equal(store.hasInterruptedRun("ws-safe"),true);
 assert.throws(()=>store.claimAgentRun({workspaceId:"ws-safe",operationId:"op-safe",requestSha256:"a".repeat(64),workerId:second.workerId,generation:second.generation}),/COACH_AGENT_RUN_ALREADY_RECORDED_NO_REPLAY/);
 assert.equal(store.releaseWorkerLease({workerId:first.workerId,generation:first.generation}),false);
 assert.equal(store.releaseWorkerLease({workerId:second.workerId,generation:second.generation}),true);
 const third=store.acquireWorkerLease({workerId:"worker-three",pid:9003,uid:501,lstart:"Mon Oct 14 12:02:00 2026",previousOwnerProvenDead:true});
 assert.equal(third.generation,3,"fencing generations stay monotonic across graceful lease release");
 store.releaseWorkerLease({workerId:third.workerId,generation:third.generation});
 store.close();
 console.log("worker lease fencing and no-replay quarantine PASS");

 const serviceRoot=join("/tmp",`dswi-${process.pid}`);mkdirSync(serviceRoot,{recursive:true});
 const workspace=join(serviceRoot,"workspace");mkdirSync(workspace);
 const identity={pid:process.pid,uid:process.getuid?.()??-1,lstart:"Wed Oct 14 12:00:00 2026",pgid:process.pid,command:process.argv.join(" ")};
 const inspect=(pid:number)=>pid===process.pid?identity:undefined;
 try {
  const service=await startCodexWorkerService({stateDir:serviceRoot,allowedRoots:[workspace]} as never,{inspectProcess:inspect});
  const client=new CodexWorkerClient(defaultCodexWorkerSocket(serviceRoot),defaultCodexWorkerKey(serviceRoot));
  const health=await client.health();
  assert.equal(health.ready,true);assert.equal(health.workerId,service.workerId);assert.equal(health.generation,1);
  await assert.rejects(()=>startCodexWorkerService({stateDir:serviceRoot,allowedRoots:[workspace]} as never,{inspectProcess:inspect}),/PRIOR_OWNER_STILL_ALIVE/);

  const wsStore=new SqliteWorkspaceStore(serviceRoot);
  wsStore.createSession({id:"ws-coach",root:workspace});wsStore.close?.();
  const portServer=createServer();await new Promise<void>(resolveListen=>portServer.listen(0,"127.0.0.1",()=>resolveListen()));
  const address=portServer.address();assert.ok(address&&typeof address!=="string");const coachPort=address.port;
  await new Promise<void>(resolveClose=>portServer.close(()=>resolveClose()));
  const controlStore=new CoachReviewEventStore(serviceRoot);
  const apiGenerationOne=new CodexWorkerCoachClient(defaultCodexWorkerSocket(serviceRoot),defaultCodexWorkerKey(serviceRoot),controlStore);
  const extensionId="a".repeat(32);
  const paired=await apiGenerationOne.start({workspaceId:"ws-coach",workspaceRoot:workspace,port:coachPort,pairedExtensionId:extensionId,observeAllNativeAgents:true});
  assert.match(paired.token,/^[A-Za-z0-9_-]{43}$/);
  const feedUrl=`http://127.0.0.1:${coachPort}`;
  const authorized=await fetch(feedUrl+"/health",{headers:{Authorization:`Bearer ${paired.token}`}});
  assert.equal(authorized.status,200);
  const receiptEvent=controlStore.recordCompleted({workspaceId:"ws-coach",
    operationId:"worker-browser-delivery",evidenceSha256:"a".repeat(64)});
  const browserReceipt={workspace_id:"ws-coach",operation_id:"worker-browser-delivery",
    event_id:receiptEvent.event_id};
  const receiptResponse=await fetch(feedUrl+"/delivery-receipt",{
    method:"POST",headers:{Authorization:`Bearer ${paired.token}`,
      Origin:`chrome-extension://${extensionId}`,"Content-Type":"application/json"},
    body:JSON.stringify(browserReceipt)});
  assert.equal(receiptResponse.status,200);
  assert.equal((await apiGenerationOne.getDeliveryReceipt("ws-coach",receiptEvent.event_id))?.result,
    "dom_submitted","Worker IPC must expose exactly the signed delivery identity");
  const restartedApi=new CodexWorkerCoachClient(defaultCodexWorkerSocket(serviceRoot),defaultCodexWorkerKey(serviceRoot),controlStore);
  await apiGenerationOne.close();
  assert.equal((await fetch(feedUrl+"/health",{headers:{Authorization:`Bearer ${paired.token}`}})).status,200,"API control client shutdown leaves Coach running");
  const sameFeed=await restartedApi.status("ws-coach");assert.equal(sameFeed?.port,coachPort);assert.equal(sameFeed?.pairedExtensionId,extensionId);
  assert.equal((await restartedApi.getDeliveryReceipt("ws-coach",receiptEvent.event_id))?.operation_id,
    "worker-browser-delivery","API generation change must not lose browser receipts");
  const approvedFeed=await fetch(feedUrl+"/agent/events?cursor=0",{headers:{Authorization:`Bearer ${paired.token}`,Origin:`chrome-extension://${extensionId}`}});
  assert.equal(approvedFeed.status,200,"explicit cross-workspace observer scope is retained");
  assert.equal((await fetch(feedUrl+"/agent/events?cursor=0",{headers:{Authorization:`Bearer ${paired.token}`,Origin:"chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}})).status,403);
  await service.close();
  assert.equal((await import("node:fs")).existsSync(defaultCodexWorkerSocket(serviceRoot)),false);
  const collisionServer=createServer();await new Promise<void>(resolveListen=>collisionServer.listen(coachPort,"127.0.0.1",()=>resolveListen()));
  const restartedWorker=await startCodexWorkerService({stateDir:serviceRoot,allowedRoots:[workspace]} as never,{inspectProcess:inspect});
  assert.equal(restartedWorker.generation,2);
  const recoveredApi=new CodexWorkerCoachClient(defaultCodexWorkerSocket(serviceRoot),defaultCodexWorkerKey(serviceRoot),controlStore);
  const blockedStatus=await recoveredApi.status("ws-coach");assert.equal(blockedStatus?.state,"stopped");assert.equal(blockedStatus?.reason,"COACH_FEED_PORT_IN_USE");
  await new Promise<void>(resolveClose=>collisionServer.close(()=>resolveClose()));
  const recoveryDeadline=Date.now()+8000;let recoveredStatus=await recoveredApi.status("ws-coach");
  while(recoveredStatus?.state!=="running"&&Date.now()<recoveryDeadline){await new Promise(resolveWait=>setTimeout(resolveWait,250));recoveredStatus=await recoveredApi.status("ws-coach");}
  assert.equal(recoveredStatus?.port,coachPort);assert.equal(recoveredStatus?.pairedExtensionId,extensionId);
  assert.equal((await recoveredApi.getDeliveryReceipt("ws-coach",receiptEvent.event_id))?.result,
    "dom_submitted","Worker restart must restore owner-scoped receipts");
  assert.equal((await fetch(feedUrl+"/health",{headers:{Authorization:`Bearer ${paired.token}`}})).status,200,"the same protected token/scope recover after a transient port collision");
  await recoveredApi.stop("ws-coach");assert.equal(await recoveredApi.status("ws-coach"),undefined);
  await recoveredApi.close();await restartedApi.close();controlStore.close();
  await restartedWorker.close();
  console.log("worker private UDS and Coach feed lifecycle/recovery PASS");
 } catch(error) {
  if((error as NodeJS.ErrnoException).code!=="EPERM")throw error;
  console.log("worker private UDS lifecycle NOT RUN: sandbox denies Unix socket listen (EPERM)");
 } finally {rmSync(serviceRoot,{recursive:true,force:true});}
}finally{rmSync(root,{recursive:true,force:true});}
