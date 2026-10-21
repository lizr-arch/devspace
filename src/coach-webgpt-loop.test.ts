import { fixtureTask, fixtureReportSource } from "./coach-contract-fixture.js";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {CoachRealtimeEngine} from "./coach-realtime.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {registerCoachRealtimeTools} from "./server/tools-coach-realtime.js";
import type {ServerContext} from "./server/server-types.js";
import {CoachReviewEventStore} from "./coach-review-events.js";
import {NativeCodexAgentRunner} from "./codex-agent-runner.js";
import {JobResourceLocks} from "./job-resource-locks.js";
import {CoachReviewGate} from "./coach-review-gate.js";
import type {TaskRunner} from "./task-runner.js";

const root=mkdtempSync(join(tmpdir(),"coach-webgpt-cycle-"));
const space=join(root,"workspace"),state=join(root,"state"),mock=join(root,"codex.cjs");
mkdirSync(join(space,".devspace"),{recursive:true});
const yaml="version: 1\ntasks:\n  smoke:\n    mode: run\n    runtime: system\n    command: [\"/usr/bin/true\"]\n";
writeFileSync(join(space,".devspace","tasks.yaml"),yaml);
writeFileSync(mock,[fixtureReportSource,
 'let p="";process.stdin.on("data",b=>p+=b);',
 'process.stdin.on("end",()=>{ fixtureReport(p);',
 'require("node:fs").writeFileSync("deliverable.txt",p.trim());',
 'const tid="11111111-1111-4111-8111-111111111111";',
 'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:tid})+"\\n");',
 'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}})+"\\n");',
 '});'
].join("\n"),{mode:0o700});chmodSync(mock,0o700);
const events=new CoachReviewEventStore(state);
const runner=new NativeCodexAgentRunner({events,nodePath:"/Users/liz/.local/bin/node",
 codexPath:mock,locks:new JobResourceLocks(),
 spawn:(file,args,opts)=>spawn(file,args,opts)});
let tests=0,failNextTest=false;
const task={runTask:async()=>{tests++;return {status:failNextTest?"failed":"succeeded",exitCode:failNextTest?1:0,taskId:"smoke",
  sessionId:"verified-"+tests,stdout:"deterministic pass",stderr:""};}} as unknown as TaskRunner;
const gate=new CoachReviewGate({events,tasks:task,locks:new JobResourceLocks()});
const workspaceId="web-ws";
const ws={root:space,mode:"worktree",worktree:{managed:true},
 approvedTasks:{manifestSha256:createHash("sha256").update(yaml).digest("hex"),taskIds:["smoke"]}};
const options={events,tasks:task,runner:()=>runner,workspaces:{getWorkspace:(id:string)=>{
 if(id!==workspaceId)throw Error("other_workspace");return ws;}} as any,gate,recoveryIntervalMs:30};
const stages=[
 {task:fixtureTask(space,workspaceId),prompt:"stage-zero",testTaskId:"smoke",model:"gpt-6-luna" as const,reasoningEffort:"none" as const,sandbox:"workspace-write" as const},
 {task:fixtureTask(space,workspaceId),prompt:"stage-one",testTaskId:"smoke",model:"gpt-6-luna" as const,reasoningEffort:"none" as const,sandbox:"workspace-write" as const}
];
const initialInput=(operationId:string)=>({task:fixtureTask(space,workspaceId),workspaceId,workspaceRoot:space,operationId,
 prompt:"stage-zero",model:"gpt-6-luna" as const,reasoningEffort:"none" as const,
 sandbox:"workspace-write" as const,timeoutMs:5000});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(pred:()=>boolean,timeout=9000){
 const limit=Date.now()+timeout;
 while(Date.now()<limit){if(pred())return;await sleep(25);}
 throw Error("WEBGPT_CYCLE_TIMEOUT");
}
let engine:CoachRealtimeEngine|undefined;
let mc:McpServer|undefined,client:Client|undefined;
try{
 const first=await runner.run(initialInput("first"));
 assert.equal(first.state,"COMPLETED");
 engine=new CoachRealtimeEngine(state,options);
 const spec={planId:"web-loop",workspaceId,initialOperationId:"first",
   reviewerModel:"gpt-6-luna" as const,reviewerEffort:"none" as const,
   reviewerMode:"webgpt" as const,maxReworks:2,stages};
 ws.mode="checkout";
 await assert.rejects(()=>engine!.register(spec),/MANAGED_WORKTREE_REQUIRED/,
   "never authorize unattended Web GPT writes in an attached main checkout");
 ws.mode="worktree";
 mc=new McpServer({name:"webgpt-coach-mcp-qa",version:"1.0"});
 registerCoachRealtimeTools(mc,{config:{readOnly:false},
   // The MCP connection stays up as DevSpace's durable engine is restarted.
   coachRealtime:{
     register:(v:any)=>engine!.register(v),
     submitWebVerdict:(v:any)=>engine!.submitWebVerdict(v),
   },workspaces:options.workspaces} as unknown as ServerContext);
 client=new Client({name:"webgpt-coach-mcp-qa-client",version:"1.0"});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await mc.connect(b);await client.connect(a);
 const enrolled=await client.callTool({name:"coach_webgpt_register",arguments:{
   planId:spec.planId,workspaceId,initialOperationId:"first",
   reviewerModel:"gpt-6-luna",reviewerEffort:"none",maxReworks:2,stages}});
 assert.equal(enrolled.isError??false,false,JSON.stringify(enrolled));
 await until(()=>engine!.get(spec.planId)?.phase==="AWAITING_WEBGPT");
 await assert.rejects(()=>engine!.register({...spec,planId:"parallel-unsafe"}),/ALREADY_ENROLLED/,
   "one workspace cannot launch two uncoordinated autonomous plans");
 engine.pause(spec.planId);
 assert.equal(engine.get(spec.planId)?.phase,"PAUSED");
 engine.resume(spec.planId);
 await until(()=>engine!.get(spec.planId)?.phase==="AWAITING_WEBGPT");
 await sleep(110);
 assert.equal(engine.get(spec.planId)?.phase,"AWAITING_WEBGPT");
 assert.equal(events.listPending(workspaceId).pending_count,1);
 assert.equal(events.getReview(workspaceId,"first"),undefined);
 assert.equal(tests,0,"unapproved messages must never trigger tests or a local reviewer");
 const ev1=events.getEvidence(workspaceId,"first") as {evidenceSha256:string};
 await assert.rejects(()=>engine!.submitWebVerdict({planId:spec.planId,workspaceId,
  operationId:"first",eventId:first.eventId!,decision:"REWORK",evidenceSha256:"a".repeat(64),
  reason:"Fix the incomplete river crossing update and verify the actual result."}),/MISMATCH/);
 // Recover while waiting for Web GPT; no duplicate child starts.
 await engine.close();engine=undefined;
 engine=new CoachRealtimeEngine(state,options);
 await until(()=>engine!.get(spec.planId)?.phase==="AWAITING_WEBGPT");
 assert.equal(events.getAgentRun(workspaceId,"coach-web-loop-s0-r1"),undefined);
 const webSubmitted=await client.callTool({name:"coach_webgpt_submit_review",arguments:{
  planId:spec.planId,workspaceId,operationId:"first",eventId:first.eventId!,
  decision:"REWORK",evidenceSha256:ev1.evidenceSha256,
  reason:"Fix the incomplete river crossing update and verify the actual result."}});
 assert.equal(webSubmitted.isError??false,false,JSON.stringify(webSubmitted));
 await until(()=>engine!.get(spec.planId)?.currentOperationId==="coach-web-loop-s0-r1" &&
   engine!.get(spec.planId)?.phase==="AWAITING_WEBGPT");
 assert.equal(events.getReview(workspaceId,"first")?.decision,"REWORK");
 const duplicate=await engine.submitWebVerdict({planId:spec.planId,workspaceId,operationId:"first",
   eventId:first.eventId!,decision:"REWORK",evidenceSha256:ev1.evidenceSha256,
   reason:"Fix the incomplete river crossing update and verify the actual result."});
 assert.equal(duplicate.currentOperationId,"coach-web-loop-s0-r1",
   "repeat Web GPT delivery must not restart an already dispatched Codex child");
 const rework=events.getAgentRun(workspaceId,"coach-web-loop-s0-r1")!;
 assert.equal(rework.state,"COMPLETED");
 assert.equal(rework.threadId,first.threadId,"rework resumes native Codex thread");
 const ev2=events.getEvidence(workspaceId,rework.operationId) as {evidenceSha256:string};
 failNextTest=true;
 await assert.rejects(()=>engine!.submitWebVerdict({planId:spec.planId,workspaceId,
   operationId:rework.operationId,eventId:rework.eventId!,decision:"APPROVED",
   evidenceSha256:ev2.evidenceSha256,
   reason:"A model cannot override the independently failing task verification result."}),
   /COACH_REVIEW_TEST_NOT_VERIFIED/);
 assert.equal(events.getReview(workspaceId,rework.operationId),undefined,
   "failed independent test may never create a signed APPROVED receipt");
 failNextTest=false;
 await engine.submitWebVerdict({planId:spec.planId,workspaceId,operationId:rework.operationId,
  eventId:rework.eventId!,decision:"APPROVED",evidenceSha256:ev2.evidenceSha256,
  reason:"Reviewed the corrected code and independently verified the declared deterministic smoke test."});
 await until(()=>engine!.get(spec.planId)?.currentOperationId==="coach-web-loop-s1-r1" &&
   engine!.get(spec.planId)?.phase==="AWAITING_WEBGPT");
 assert.equal(tests,2);
 const third=events.getAgentRun(workspaceId,"coach-web-loop-s1-r1")!;
 const ev3=events.getEvidence(workspaceId,third.operationId) as {evidenceSha256:string};
 await engine.submitWebVerdict({planId:spec.planId,workspaceId,operationId:third.operationId,
  eventId:third.eventId!,decision:"APPROVED",evidenceSha256:ev3.evidenceSha256,
  reason:"Inspected the second-stage artifact and confirmed the permitted smoke test passes."});
 await until(()=>engine!.get(spec.planId)?.phase==="DONE");
 assert.equal(engine.get(spec.planId)?.reworkCount,1);
 assert.equal(tests,3);
 await engine.close();engine=undefined;
 engine=new CoachRealtimeEngine(state,options);
 await sleep(80);
 assert.equal(engine.get(spec.planId)?.phase,"DONE","no replay after a server restart");
 assert.equal(events.getAgentRun(workspaceId,"coach-web-loop-s1-r1")?.state,"COMPLETED");
 // Force a simulated crash after dispatch was committed but before the
 // engine could mark its stage done. A durable matching child may be
 // reconciled, never launched a second time.
 await engine.close();engine=undefined;
 let db=new Database(join(state,"coach-realtime.sqlite"));
 db.prepare("UPDATE realtime_plans SET phase='DISPATCHING' WHERE plan_id=?").run(spec.planId);
 db.close();
 engine=new CoachRealtimeEngine(state,options);
 await until(()=>engine!.get(spec.planId)?.phase==="DONE");
 assert.equal(events.getAgentRun(workspaceId,"coach-web-loop-s1-r1")?.eventId,third.eventId);
 // A separate capped plan must stop on REWORK instead of creating a child.
 const limit=await runner.run(initialInput("limit"));
 const limitSpec={...spec,planId:"web-limit",initialOperationId:"limit",maxReworks:0,stages:[stages[0]]};
 await engine.register(limitSpec);
 await until(()=>engine!.get("web-limit")?.phase==="AWAITING_WEBGPT");
 const limitEv=events.getEvidence(workspaceId,"limit") as {evidenceSha256:string};
 await engine.submitWebVerdict({planId:"web-limit",workspaceId,operationId:"limit",
   eventId:limit.eventId!,decision:"REWORK",evidenceSha256:limitEv.evidenceSha256,
   reason:"Need further changes but the permitted automatic rework budget is already exhausted."});
 await until(()=>engine!.get("web-limit")?.phase==="BLOCKED");
 assert.equal(events.getAgentRun(workspaceId,"coach-web-limit-s0-r1"),undefined);
 // Unknown dispatch outcome after restart must be BLOCKED, never invented.
 await engine.close();engine=undefined;
 db=new Database(join(state,"coach-realtime.sqlite"));
 db.prepare("UPDATE realtime_plans SET phase='DISPATCHING',current_operation='coach-web-limit-s0-r1' WHERE plan_id='web-limit'").run();
 db.close();
 engine=new CoachRealtimeEngine(state,options);
 await until(()=>engine!.get("web-limit")?.phase==="BLOCKED");
 assert.equal(engine.get("web-limit")?.lastError,"unknown_dispatch_outcome_requires_reconciliation");
 assert.equal(events.getAgentRun(workspaceId,"coach-web-limit-s0-r1"),undefined);
 // Unrelated workspace must not claim the same signed completion.
 await assert.rejects(()=>engine!.submitWebVerdict({planId:"web-loop",workspaceId:"different",
   operationId:"first",eventId:first.eventId!,decision:"REWORK",
   evidenceSha256:ev1.evidenceSha256,reason:"Must never replay a past completed stage or cross into another workspace."}),
   /NOT_AWAITING_VERDICT/);
 console.log("WEBGPT_CLOSED_LOOP_REWORK_APPROVE_NEXT_STAGE_RESTART_CAP_CROSS_SCOPE_CRASH_RECOVERY_PASS",
   {tests,stage:engine.get("web-loop")?.stageIndex,reworks:engine.get("web-loop")?.reworkCount});
}finally{
 await client?.close();await mc?.close();
 await engine?.close();
 await runner.close();
 events.close();
 rmSync(root,{recursive:true,force:true});
}
