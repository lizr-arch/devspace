import Database from "better-sqlite3";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureTask, fixtureReportSource } from "./coach-contract-fixture.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner, captureCodexFingerprint } from "./codex-agent-runner.js";
import { CoachRealtimeEngine } from "./coach-realtime.js";
import { CoachReviewGate } from "./coach-review-gate.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { sha256 } from "./coach-task-contract.js";
const root=mkdtempSync(join(tmpdir(),"coach-contract-e2e-"));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean){const end=Date.now()+6000;while(Date.now()<end){if(check())return;await sleep(20);}throw Error("CONTRACT_E2E_TIMEOUT");}
let checks=0;
async function scenario(mode:string){
 const dir=join(root,mode),state=join(dir,"state"),workspace=join(dir,"workspace");mkdirSync(workspace,{recursive:true});mkdirSync(state);
 const task=fixtureTask(workspace,"ws");
 const yaml='version: 1\ntasks:\n  smoke:\n    mode: run\n    runtime: system\n    command: ["/usr/bin/true"]\n';
 writeFileSync(join(workspace,".devspace/tasks.yaml"),yaml);
 const script=join(dir,"fake.cjs");
 writeFileSync(script,fixtureReportSource+`
 let p="";process.stdin.on("data",b=>p+=b);process.stdin.on("end",()=>{
 const mode=${JSON.stringify(mode)};
 const first=p.includes("Operation: initial\\n");
 if(mode!=="missing" && !(mode==="repair" && first))fixtureReport(p,mode==="cap"?"IN_PROGRESS":mode==="conflict"?"PLAN_CONFLICT":mode==="progress" && first?"IN_PROGRESS":"READY_FOR_REVIEW");
 if(mode==="control-edit")require("node:fs").appendFileSync(${JSON.stringify(task.taskPath)},"unauthorized mutation");
 process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n");
 });`,{mode:0o700});
 const events=new CoachReviewEventStore(state);let launches=0,tests=0;
 const runner=new NativeCodexAgentRunner({events,nodePath:process.execPath,codexPath:script,locks:new JobResourceLocks(),spawn:(file,args,opts)=>{launches++;return spawn(file,args,opts);}});
 const tasks={runTask:async()=>{tests++;return {status:"succeeded",exitCode:0,taskId:"smoke",sessionId:"smoke",stdout:"passed",stderr:""};}} as any;
 const gate=new CoachReviewGate({events,tasks,locks:new JobResourceLocks()});
 let engine:CoachRealtimeEngine|undefined;
 try{
  const initial=await runner.run({workspaceId:"ws",workspaceRoot:workspace,operationId:"initial",prompt:"implement fixture",task,model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write"});
  assert.equal(initial.exitCode,0);checks++;
  if(mode==="control-edit"){assert.equal(initial.state,"FAILED");assert.equal(initial.reason,"CODEX_TASK_CONTROL_MUTATED");assert.equal(events.getEvidence("ws","initial"),undefined);checks+=3;return;}
  assert.equal(initial.state,"COMPLETED");assert.ok(initial.eventId);checks+=2;
  const deliverable=initial.report?.valid&&["READY_FOR_REVIEW","PLAN_CONFLICT"].includes(initial.report.status!);
  assert.equal(events.listPending("ws").pending_count,deliverable?1:0);
  if(deliverable)assert.equal(events.listPending("ws").events[0].report?.code,initial.report?.code);checks++;
  // Exercise the production bearer-authorized feed handler without opening a socket.
  const db=new Database(events.path,{readonly:true});
  try{
    const sidecar=new ManagedCoachSidecar(undefined,events.path);
    let httpStatus=0,body="";const token=Buffer.alloc(32,7);
    (sidecar as any).handle({workspaceId:"ws",authorizedWorkspaceIds:["ws"],port:12345,token,database:db},
      {headers:{host:"127.0.0.1:12345",authorization:"Bearer "+token.toString("base64url")},method:"GET",url:"/events"},
      {setHeader:()=>{},writeHead:(code:number)=>{httpStatus=code;},end:(text:string)=>{body=text;}});
    assert.equal(httpStatus,200);assert.equal(JSON.parse(body).pending_count,deliverable?1:0);
    if(deliverable){assert.equal(JSON.parse(body).events[0].report.code,initial.report?.code);assert.equal(JSON.parse(body).events[0].event_type,mode==="conflict"?"PLAN_CONFLICT":"READY_FOR_GPT_REVIEW");}
    assert.doesNotMatch(body,/Fixture execution completed|fixture check/);checks+=3;
  }finally{db.close();}
  if(mode==="repair"||mode==="missing"){
   assert.equal(initial.report?.valid,false);assert.equal(initial.reason,"CODEX_REPORT_PROTOCOL_ERROR");
   assert.equal(initial.reviewState,"REVIEW_BLOCKED");assert.equal(initial.evidenceState,"VERIFIED");
   // Invalid report cannot earn APPROVED even with a real independent test proof.
   await gate.verifyTest({workspaceId:"ws",workspaceRoot:workspace,eventId:initial.eventId!,taskId:"smoke"});
   await assert.rejects(()=>gate.submit({workspaceId:"ws",workspaceRoot:workspace,operationId:"initial",eventId:initial.eventId!,decision:"APPROVED",evidenceSha256:initial.evidenceSha256!}),/REPORT_NOT_READY/);checks+=5;
  }
  const dependencies={events,tasks,runner:()=>runner,workspaces:{getWorkspace:()=>({root:workspace,mode:"worktree",worktree:{managed:true},approvedTasks:{taskIds:["smoke"],manifestSha256:sha256(yaml)}})} as any,gate,recoveryIntervalMs:20};
  engine=new CoachRealtimeEngine(state,dependencies);
  const spec={planId:"contract-plan",workspaceId:"ws",initialOperationId:"initial",reviewerModel:"gpt-6-luna" as const,reviewerEffort:"none" as const,reviewerMode:"webgpt" as const,maxReworks:1,
    stages:[{task,prompt:"fixture implementation",testTaskId:"smoke",model:"gpt-6-luna" as const,reasoningEffort:"none" as const,sandbox:"workspace-write" as const}]};
  await assert.rejects(()=>engine!.register({...spec,planId:"legacy-new",stages:[{...spec.stages[0],task:undefined}]}),/TASK_REFERENCE_REQUIRED/);checks++;
  await engine.register(spec);
  const phase=mode==="conflict"||mode==="cap"||mode==="missing"?"BLOCKED":"AWAITING_WEBGPT";
  await until(()=>engine!.get(spec.planId)?.phase===phase);
  const plan=engine.get(spec.planId)!;
  assert.equal(plan.reworkCount,0);assert.equal(events.getReview("ws","initial"),undefined);checks+=2;
  if(mode==="conflict"){assert.match(plan.lastError??"",/PLAN_CONFLICT/);assert.equal(launches,1);checks+=2;}
  if(mode==="cap"||mode==="missing"){assert.equal(launches,4);assert.match(plan.lastError??"",/maximum_development_continuations_reached/);checks+=2;}
  if(mode==="progress"||mode==="repair"){
   assert.equal(launches,2);const op=plan.currentOperationId;const child=runner.status(op,"ws");
   assert.equal(child.report?.status,"READY_FOR_REVIEW");assert.equal(child.report?.testsIndependentlyVerified,false);checks+=3;
   const prior=events.getEvidence("ws","initial") as any;
   assert.equal(prior.report.status,mode==="progress"?"IN_PROGRESS":undefined);checks++;
   await engine.close();engine=new CoachRealtimeEngine(state,dependencies);await sleep(120);
   assert.equal(engine.get(spec.planId)?.currentOperationId,op);assert.equal(launches,2);checks+=2;
   const packet=events.getEvidence("ws",op) as any;
   await engine.submitWebVerdict({planId:spec.planId,workspaceId:"ws",operationId:op,eventId:child.eventId!,decision:"APPROVED",evidenceSha256:packet.evidenceSha256,reason:"Independent fixture code inspection and approved deterministic test succeeded."});
   await until(()=>engine!.get(spec.planId)?.phase==="DONE");assert.equal(events.getReview("ws",op)?.decision,"APPROVED");checks++;
  }
  if(mode==="ready"){
   assert.equal(launches,1);assert.equal(tests,0);checks+=2;
   // Tampering between completion and review is rejected, including task bytes.
   writeFileSync(join(workspace,task.taskPath),readFileSync(join(workspace,task.taskPath),"utf8")+"changed");
   await assert.rejects(()=>engine!.submitWebVerdict({planId:spec.planId,workspaceId:"ws",operationId:"initial",eventId:initial.eventId!,decision:"APPROVED",evidenceSha256:initial.evidenceSha256!,reason:"This stale review must fail before any approval or next stage."}),/STALE|TASK_/);checks++;
  }
 }finally{await engine?.close();await runner.close();events.close();}
}
async function historical(){
 const dir=join(root,"historical"),workspace=join(dir,"workspace"),state=join(dir,"state");mkdirSync(join(workspace,".devspace"),{recursive:true});mkdirSync(state);
 const yaml='version: 1\ntasks:\n  smoke:\n    mode: run\n    runtime: system\n    command: ["/usr/bin/true"]\n';writeFileSync(join(workspace,".devspace/tasks.yaml"),yaml);
 const events=new CoachReviewEventStore(state);let launches=0;
 const runner=new NativeCodexAgentRunner({events,nodePath:process.execPath,codexPath:process.execPath,spawn:()=>{launches++;throw Error("legacy must not launch");}});
 const tasks={runTask:async()=>({status:"succeeded",exitCode:0,taskId:"smoke",sessionId:"smoke",stdout:"passed",stderr:""})} as any;
 const engine=new CoachRealtimeEngine(state,{events,tasks,runner:()=>runner,workspaces:{getWorkspace:()=>({root:workspace})} as any,gate:new CoachReviewGate({events,tasks,locks:new JobResourceLocks()}),recoveryIntervalMs:20});
 const db=new Database(join(state,"coach-realtime.sqlite"));
 try{
  for(const decision of ["APPROVED","REWORK"] as const){
   const op="legacy-"+decision.toLowerCase(),planId=op;
   const fp=await captureCodexFingerprint(workspace);
   const base={operationId:op,workspaceId:"ws",threadId:"11111111-1111-4111-8111-111111111111",exitCode:0,eventTypes:["thread.started","turn.completed"],inputFingerprint:fp.sha,finalFingerprint:fp.sha,gitSummary:fp.gitSummary,sourceDiff:"",stdoutSha256:sha256(""),stderrSha256:sha256(""),capturedAt:new Date().toISOString(),invocation:{sandbox:"workspace-write",reasoningEffort:"none",resumed:false}};
   const digest=sha256(JSON.stringify(base));events.claimAgentRun({workspaceId:"ws",operationId:op,requestSha256:sha256(op)});
   const ev=events.recordCompletedWithEvidence({workspaceId:"ws",operationId:op,evidenceSha256:digest,packetJson:JSON.stringify({...base,evidenceSha256:digest})});
   events.finishAgentRun({workspaceId:"ws",operationId:op,state:"COMPLETED",eventId:ev.event_id,threadId:base.threadId});
   const spec={planId,workspaceId:"ws",initialOperationId:op,reviewerMode:"webgpt",reviewerModel:"gpt-6-luna",reviewerEffort:"none",maxReworks:1,approvedManifestSha256:sha256(yaml),stages:[{prompt:"historical prompt",testTaskId:"smoke",model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write"}]};
   db.prepare("INSERT INTO realtime_plans VALUES(?,?,?,?,?,?,?,?,?,?)").run(planId,"ws",workspace,JSON.stringify(spec),op,"ACTIVE",0,0,null,new Date().toISOString());
   engine.wake(planId);await until(()=>engine.get(planId)?.phase==="AWAITING_WEBGPT");
   await engine.submitWebVerdict({planId,workspaceId:"ws",operationId:op,eventId:ev.event_id,evidenceSha256:digest,decision,reason:"Historical evidence remains reviewable but new legacy developer children are forbidden."});
   await until(()=>engine.get(planId)?.phase===(decision==="APPROVED"?"DONE":"BLOCKED"));
   if(decision==="REWORK")assert.match(engine.get(planId)?.lastError??"",/TASK_REFERENCE_REQUIRED/);
   assert.equal(events.getReview("ws",op)?.decision,decision);assert.equal(launches,0);checks+=3;
  }
 }finally{db.close();await engine.close();await runner.close();events.close();}
}
try{
 await historical();
 for(const mode of ["progress","repair","cap","missing","conflict","ready","control-edit"])await scenario(mode);
 console.log("CONTRACT_NATIVE_COACH_PROGRESS_REPAIR_CAP_CONFLICT_REVIEW_SECURITY_E2E_PASS",{checks});
}finally{rmSync(root,{recursive:true,force:true});}
