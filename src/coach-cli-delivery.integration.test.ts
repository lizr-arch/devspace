/** Offline protocol test. The child, browser receipt and Web GPT are fixtures;
 * this file NEVER establishes real model/browser acceptance. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import { Server as HttpServer, IncomingMessage } from "node:http";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fixtureTask, fixtureReportSource } from "./coach-contract-fixture.js";
import { readConfined } from "./coach-task-contract.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner, captureCodexFingerprint, type EvidencePacket } from "./codex-agent-runner.js";
import { CoachReviewGate } from "./coach-review-gate.js";
import { CoachRealtimeEngine } from "./coach-realtime.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { createCodexWorkerDispatcher } from "./codex-worker-ipc.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { registerSidecarTools } from "./server/tools-sidecar.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import { registerCodexReviewTools } from "./server/tools-codex-review.js";
import { registerCoachRealtimeTools } from "./server/tools-coach-realtime.js";
import type { TaskRunner } from "./task-runner.js";
import type { ServerContext } from "./server/server-types.js";

const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const root=realpathSync(mkdtempSync(join(tmpdir(),"coach-cli-delivery-")));
const space=join(root,"source"),destination=join(root,"delivery"),state=join(root,"state");
mkdirSync(space);mkdirSync(destination);
execFileSync("/usr/bin/git",["init","-q"],{cwd:space});
const workspaceId="execution-ws",deliveryId="claimed-browser-ws";
const task=fixtureTask(space,workspaceId);
const manifest='version: 1\ntasks:\n  smoke:\n    mode: run\n    runtime: system\n    command: ["/usr/bin/true"]\n';
writeFileSync(join(space,".devspace/tasks.yaml"),manifest);
const fixture=join(root,"codex.cjs");
const thread="11111111-1111-4111-8111-111111111111";
writeFileSync(fixture,[fixtureReportSource,
  'let p="";process.stdin.on("data",c=>p+=c);process.stdin.on("end",()=>{',
  'fixtureReport(p);require("node:fs").writeFileSync("deliverable.txt",p);',
  `console.log(JSON.stringify({type:"thread.started",thread_id:${JSON.stringify(thread)}}));`,
  'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"FIXTURE_COMPLETION"}}));',
  'console.log(JSON.stringify({type:"turn.completed"}));});'
].join("\n"),{mode:0o700});
let events=new CoachReviewEventStore(state);
const invocations:string[][]=[];
const runner=new NativeCodexAgentRunner({events,nodePath:"/Users/liz/.local/bin/node",codexPath:fixture,
  locks:new JobResourceLocks(),spawn:(file,args,opts)=>{invocations.push(args);return spawn(file,args,opts);}});
const manager=new ManagedCoachSidecar(new JobResourceLocks(),events.path);
const tasks={runTask:async()=>({status:"succeeded",exitCode:0,taskId:"smoke",sessionId:"test-proof",stdout:"fixture pass",stderr:""})} as unknown as TaskRunner;
const ws={root:space,mode:"worktree",worktree:{managed:true},approvedTasks:{taskIds:["smoke"],manifestSha256:sha(manifest)}};
const workspaces={getWorkspace:(id:string)=>{
  if(id===workspaceId)return ws;
  if(id===deliveryId)return {root:destination};
  throw new Error("WORKSPACE_NOT_AUTHORIZED");
}};
const dispatcher=createCodexWorkerDispatcher({runner,events,coach:manager,stateDir:state,
  workspaceStore:{getSession:(id:string)=>id===deliveryId?{root:destination}:undefined} as any,
  workerId:"fixture-worker",generation:1,allowedRoots:[root],coachRecovery:{}});
const proxy={
  start:manager.start.bind(manager),stop:manager.stop.bind(manager),status:manager.status.bind(manager),
  getDeliveryReceipt:manager.getDeliveryReceipt.bind(manager),
  claimBrowserRoute:async(workspaceId:string,nonce:string,url:string)=>
    await dispatcher({version:1,token:"dispatcher-fixture",op:"coach_claim",workspaceId,nonce,url}) as boolean,
};
const engine=new CoachRealtimeEngine(state,{events,tasks,runner:()=>runner,workspaces:workspaces as any,recoveryIntervalMs:30});
const gate=new CoachReviewGate({events,tasks,locks:new JobResourceLocks()});
const ctx={config:{readOnly:false},workspaces,managedCoachSidecar:proxy,coachReviewEvents:events,
  coachRealtime:engine,tasks,getNativeCodexRunner:()=>runner} as unknown as ServerContext;
const server=new McpServer({name:"offline-cli-delivery-fixture",version:"1"});
registerSidecarTools(server,ctx);registerCodexAgentTools(server,ctx);
registerCodexReviewTools(server,ctx);registerCoachRealtimeTools(server,ctx);
const client=new Client({name:"offline-reviewer-fixture",version:"1"});
const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
// Explicit transport fixture for restricted environments. Default mode still
// exercises a real TCP listener; this mode calls the SAME HTTP request handler
// with Node IncomingMessages and never opens or authorizes a socket.
const inProcess=process.argv.includes("--in-process-http");
const listeners=new Map<number,HttpServer>();
const originalListen=HttpServer.prototype.listen;
if(inProcess)HttpServer.prototype.listen=function(this:HttpServer,...args:unknown[]){
  const callback=args[args.length-1] as ()=>void;
  listeners.set(Number(args[0]),this);queueMicrotask(callback);return this;
} as typeof originalListen;
const port=inProcess?18765:await new Promise<number>((resolve,reject)=>{
  const listener=createServer();listener.once("error",reject);
  listener.listen(0,"127.0.0.1",()=>{const port=(listener.address() as {port:number}).port;listener.close(()=>resolve(port));});
});
const fetch:typeof globalThis.fetch=inProcess?async(url,options)=>{
  const u=new URL(String(url));const listener=listeners.get(Number(u.port));
  assert.equal(u.hostname,"127.0.0.1");assert.ok(listener);
  const req=new IncomingMessage(new Socket());req.method=options?.method??"GET";req.url=u.pathname+u.search;
  req.headers={host:u.host};new Headers(options?.headers).forEach((v,k)=>{req.headers[k]=v;});
  return await new Promise<Response>(resolve=>{
    let status=0;
    const res={headersSent:false,writeHead(code:number){status=code;this.headersSent=true;},end(body:string){
      resolve({status,ok:status>=200&&status<300,json:async()=>JSON.parse(body),text:async()=>body} as Response);
    }};
    listener.emit("request",req,res);
    if(options?.body)req.push(Buffer.from(String(options.body)));req.push(null);
  });
}:globalThis.fetch;
const extension="bapcebjlgncogfpgbhllioaichcldkbl";
const chatUrl="https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const nonce="0123456789abcdef0123456789abcdef";
const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
const until=async(predicate:()=>boolean)=>{
  const end=Date.now()+8000;
  while(!predicate()){if(Date.now()>end)throw Error("OFFLINE_LOOP_TIMEOUT:"+JSON.stringify(engine.all()));await new Promise(r=>setTimeout(r,25));}
};
const input={workspaceId,operationId:"new-managed-operation",prompt:"fixture initial",task,
  delivery:{workspaceId:deliveryId,nonce},model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write",timeoutMs:5000};
try {
  const pair=await manager.start({workspaceId:deliveryId,workspaceRoot:destination,port,pairedExtensionId:extension});
  events.saveCoachFeedConfig({workspaceId:deliveryId,workspaceRoot:destination,port,pairedExtensionId:extension,observeAllNativeAgents:false});
  const url="http://127.0.0.1:"+port;
  const headers={Authorization:"Bearer "+pair.token,Origin:"chrome-extension://"+extension,"Content-Type":"application/json"};
  const post=(path:string,data:unknown,extra={})=>fetch(url+path,{method:"POST",headers:{...headers,...extra},body:JSON.stringify(data)});
  const feed=async()=>await (await fetch(url+"/events",{headers})).json() as {pending_count:number;events:Array<Record<string,any>>};
  assert.equal((await call("codex_agent_start",input)).isError,true,"unclaimed delivery must not spawn");
  assert.equal(invocations.length,0);
  assert.equal((await post("/bind/start",{nonce,url:chatUrl})).status,200);
  const badClaim=await call("coach_webgpt_claim_browser_route",{workspaceId:deliveryId,nonce,url:chatUrl+"/wrong"});
  assert.equal((badClaim.structuredContent as {claimed?:boolean})?.claimed,false,"async false must not become truthy success");
  const claim=await call("coach_webgpt_claim_browser_route",{workspaceId:deliveryId,nonce,url:chatUrl});
  assert.equal((claim.structuredContent as {claimed?:boolean})?.claimed,true,JSON.stringify(claim));
  assert.equal(events.browserRouteClaim(deliveryId)?.nonce,nonce);
  assert.equal(((await call("coach_webgpt_claim_browser_route",{workspaceId:deliveryId,nonce,url:chatUrl})).structuredContent as {claimed?:boolean})?.claimed,false);
  assert.equal((await call("codex_agent_start",{...input,operationId:"wrong-scope",delivery:{workspaceId:"other",nonce}})).isError,true);
  assert.equal((await call("codex_agent_start",{...input,operationId:"old-nonce",delivery:{workspaceId:deliveryId,nonce:"a".repeat(32)}})).isError,true);
  assert.equal(invocations.length,0);
  assert.equal((await call("codex_agent_start",input)).isError??false,false);
  await until(()=>events.getAgentRun(workspaceId,input.operationId)?.state==="COMPLETED");
  const packet=events.getEvidence(workspaceId,input.operationId) as EvidencePacket;
  const first=events.getAgentRun(workspaceId,input.operationId)!;
  assert.equal(packet.threadId,thread);assert.equal(packet.exitCode,0);
  assert.equal(packet.sourceRoot,space);assert.equal(packet.agentMessages?.[0].text,"FIXTURE_COMPLETION");
  assert.equal(packet.agentMessages?.[0].sha256,sha("FIXTURE_COMPLETION"));
  assert.ok(packet.eventTypes.includes("turn.completed"));assert.match(packet.runnerSourceSha256!,/^[a-f0-9]{64}$/);
  assert.equal((await captureCodexFingerprint(space)).sha,packet.finalFingerprint);
  assert.ok(packet.sourceDiff?.includes("deliverable.txt"));
  const notification=(await feed()).events[0];
  assert.equal(notification.workspace_id,workspaceId,"never spoof execution workspace into browser scope");
  assert.equal(notification.delivery_workspace_id,deliveryId);assert.equal(notification.delivery_nonce,nonce);
  assert.equal(JSON.stringify(notification).includes("FIXTURE_COMPLETION"),false,"notification cannot carry model prose");
  assert.equal((await fetch(url+"/events?workspaceId="+workspaceId,{headers})).status,403);
  assert.equal((await fetch(url+"/events",{headers:{...headers,Authorization:"Bearer invalid"}})).status,401);
  const verdict={workspaceId,operationId:input.operationId,eventId:first.eventId!,evidenceSha256:packet.evidenceSha256};
  assert.equal((await call("coach_webgpt_acknowledge_turn",verdict)).isError,true,"no DOM receipt means no turn acknowledgment");
  await assert.rejects(()=>gate.submit({...verdict,workspaceRoot:space,decision:"REWORK"}),/TURN_ACK_REQUIRED/);
  const receiptIdentity={workspace_id:workspaceId,operation_id:input.operationId,event_id:first.eventId};
  assert.equal((await post("/delivery-receipt",receiptIdentity,{Authorization:"Bearer invalid"})).status,401);
  assert.equal((await post("/delivery-receipt",{...receiptIdentity,workspace_id:deliveryId})).status,404);
  assert.equal((await post("/delivery-receipt",{...receiptIdentity,operation_id:"forged"})).status,404);
  assert.equal((await post("/delivery-receipt",receiptIdentity)).status,200);
  const receipt=manager.getDeliveryReceipt(workspaceId,first.eventId!);
  assert.equal(receipt?.result,"dom_submitted");
  assert.equal(events.webGptTurnAck(workspaceId,first.eventId!),undefined,"DOM alone is no turn proof");
  assert.equal((await call("coach_webgpt_acknowledge_turn",{...verdict,evidenceSha256:"a".repeat(64)})).isError,true);
  assert.equal((await call("coach_webgpt_acknowledge_turn",verdict)).isError??false,false);
  assert.equal((await call("coach_webgpt_acknowledge_turn",verdict)).isError??false,false,"ack is idempotent");
  await assert.rejects(()=>gate.submit({...verdict,workspaceRoot:destination,decision:"REWORK"}),/SOURCE_ROOT_MISMATCH/);
  // Same bytes at a different path cannot stand in for the execution origin.
  const linked=join(root,"linked-report");symlinkSync(join(space,task.taskPath),linked);
  assert.throws(()=>readConfined(root,"linked-report"),/TASK/);
  assert.throws(()=>readConfined(space,"../linked-report"),/TASK/);
  const db=new Database(events.path);
  const original=db.prepare("SELECT packet_json FROM coach_review_evidence WHERE event_id=?").get(first.eventId) as {packet_json:string};
  db.prepare("UPDATE coach_review_evidence SET packet_json=? WHERE event_id=?").run(original.packet_json.replace("FIXTURE_COMPLETION","FORGED_COMPLETION"),first.eventId);
  assert.throws(()=>events.getEvidence(workspaceId,input.operationId),/INTEGRITY/);
  db.prepare("UPDATE coach_review_evidence SET packet_json=? WHERE event_id=?").run(original.packet_json,first.eventId);db.close();
  const mutated={...packet,finalFingerprint:"b".repeat(64)};
  assert.throws(()=>events.recordCompletedWithEvidence({workspaceId,operationId:input.operationId,evidenceSha256:sha(JSON.stringify(mutated)),packetJson:JSON.stringify(mutated)}));
  const content=readFileSync(join(space,"deliverable.txt"));
  writeFileSync(join(space,"deliverable.txt"),"stale dirty source");
  assert.equal((await call("codex_agent_submit_review",{...verdict,decision:"REWORK"})).isError,true,"dirty workspace cannot dispatch");
  writeFileSync(join(space,"deliverable.txt"),content);
  const stage={task,prompt:"fixture initial",testTaskId:"smoke",model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write"};
  const planId="offline-delivery-roundtrip";
  assert.equal((await call("coach_webgpt_register",{planId,workspaceId,initialOperationId:input.operationId,
    reviewerModel:"gpt-6-luna",reviewerEffort:"none",maxReworks:1,maxContinuations:0,stages:[stage]})).isError??false,false);
  await until(()=>engine.get(planId)?.phase==="AWAITING_WEBGPT");
  const review={...verdict,planId,decision:"REWORK",reason:"OFFLINE FIXTURE: correct bounded output in the same session."};
  assert.equal((await call("coach_webgpt_submit_review",review)).isError??false,false);
  const childId="coach-"+planId+"-s0-r1";
  await until(()=>engine.get(planId)?.currentOperationId===childId&&engine.get(planId)?.phase==="AWAITING_WEBGPT");
  assert.equal(invocations.length,2);
  assert.equal(invocations[1][invocations[1].indexOf("resume")+1],thread);
  const second=events.getEvidence(workspaceId,childId) as EvidencePacket;
  assert.deepEqual(second.delivery,packet.delivery);assert.equal(second.threadId,packet.threadId);
  assert.equal(second.invocation.resumed,true);assert.notEqual(second.finalFingerprint,packet.finalFingerprint);
  assert.equal((await call("coach_webgpt_submit_review",review)).isError??false,false);
  assert.equal(invocations.length,2,"duplicate verdict must not replay continuation");
  const child=events.getAgentRun(workspaceId,childId)!;
  assert.equal((await feed()).events.length,1,"second completion generates its own callback");
  const childVerdict={workspaceId,operationId:childId,eventId:child.eventId!,evidenceSha256:second.evidenceSha256};
  assert.equal((await post("/delivery-receipt",{workspace_id:workspaceId,operation_id:childId,event_id:child.eventId})).status,200);
  assert.equal((await call("coach_webgpt_acknowledge_turn",childVerdict)).isError??false,false);
  assert.equal((await call("coach_webgpt_submit_review",{...childVerdict,planId,decision:"APPROVED",reason:"OFFLINE FIXTURE: inspected source and approved deterministic test."})).isError??false,false);
  await until(()=>engine.get(planId)?.phase==="DONE");
  assert.equal(invocations.length,2,"APPROVED never triggers rework");
  assert.equal(events.getReview(workspaceId,childId)?.decision,"APPROVED");
  assert.equal((await feed()).events.length,0);
  // Reproduce event240's protocol failure without reading/writing/replaying it.
  const legacy={workspaceId:"historical-fixture",operationId:"fixture-legacy-packet",threadId:thread};
  const legacySha=sha(JSON.stringify(legacy));
  const old=events.recordCompletedWithEvidence({...legacy,evidenceSha256:legacySha,packetJson:JSON.stringify({...legacy,evidenceSha256:legacySha})});
  events.submitReview({workspaceId:legacy.workspaceId,eventId:old.event_id,decision:"BLOCKED",evidenceSha256:legacySha});
  await assert.rejects(()=>gate.submit({workspaceId:legacy.workspaceId,workspaceRoot:space,operationId:legacy.operationId,eventId:old.event_id,decision:"APPROVED",evidenceSha256:legacySha}),/EVIDENCE_NOT_FOUND/);
  assert.equal(events.getReview(legacy.workspaceId,legacy.operationId)?.decision,"BLOCKED");
  const handmadeBase={...packet,operationId:"handmade-not-managed"};
  const {evidenceSha256:_old,...handmade}=handmadeBase;
  const handmadeSha=sha(JSON.stringify(handmade));
  const forged=events.recordCompletedWithEvidence({workspaceId,operationId:handmade.operationId,evidenceSha256:handmadeSha,packetJson:JSON.stringify({...handmade,evidenceSha256:handmadeSha})});
  await assert.rejects(()=>gate.submit({workspaceId,workspaceRoot:space,operationId:handmade.operationId,eventId:forged.event_id,decision:"REWORK",evidenceSha256:handmadeSha}),/MANAGED_RUN_REQUIRED/);
  assert.equal((await call("codex_agent_start",input)).isError??false,false,"identical start is idempotent");
  assert.equal(invocations.length,2);
  await manager.stop(deliveryId);
  await manager.start({workspaceId:deliveryId,workspaceRoot:destination,port,pairedExtensionId:extension});
  assert.equal((await fetch(url+"/events",{headers})).status,401,"rotated pairing token fails closed");
  await engine.close();await runner.close();await manager.close();
  events.close();events=new CoachReviewEventStore(state);
  assert.ok(events.webGptTurnAck(workspaceId,first.eventId!));
  assert.equal((events.getEvidence(workspaceId,childId) as EvidencePacket).threadId,thread);
  console.log("OFFLINE_CLI_DELIVERY_ROUNDTRIP_PASS (fake CLI, simulated browser receipt, fixture MCP reviewer; NO live acceptance)");
  console.log("HTTP_TRANSPORT="+(inProcess?"IN_PROCESS_HANDLER_FIXTURE (no TCP)":"REAL_LOOPBACK (not real Chrome)"));
} finally {
  await client.close();await server.close();await engine.close().catch(()=>{});
  await runner.close();await manager.close();events.close();rmSync(root,{recursive:true,force:true});
  HttpServer.prototype.listen=originalListen;
}
