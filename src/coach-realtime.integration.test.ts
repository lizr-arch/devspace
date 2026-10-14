import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync,chmodSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CoachReviewEventStore} from "./coach-review-events.js";
import {CoachRealtimeEngine, type RealtimeReviewRecommendation} from "./coach-realtime.js";
import {NativeCodexAgentRunner} from "./codex-agent-runner.js";
import {JobResourceLocks} from "./job-resource-locks.js";
import {CoachReviewGate} from "./coach-review-gate.js";
import type { TaskRunner } from "./task-runner.js";

const ROOT=mkdtempSync(join(tmpdir(),"coach-realtime-e2e-"));
const NODE="/Users/liz/.local/bin/node";
const FIXTURE=join(ROOT,"mock-real-codex.cjs");
writeFileSync(FIXTURE,[
'const fs=require("node:fs");',
'let prompt="";process.stdin.on("data",b=>prompt+=b);process.stdin.on("end",()=>{',
'const id="11111111-1111-4111-8111-111111111111";',
'let events=[{type:"thread.started",thread_id:id},{type:"turn.started"}];',
'if(prompt.includes("REVIEW_SENTINEL")){',
' const verdict=prompt.includes("BAD_REVIEW") ? "bad-output" : JSON.stringify({decision:"REWORK",reason:"missing reach continuity"});',
' events.push({type:"item.completed",item:{type:"agent_message",text:verdict}});',
'}',
'events.push({type:"turn.completed",usage:{input_tokens:8,output_tokens:6}});',
'for(const e of events)process.stdout.write(JSON.stringify(e)+"\\n");',
'});'
].join("\n"),{mode:0o700});chmodSync(FIXTURE,0o700);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(test:()=>boolean,limitMs=5000){
 const deadline=Date.now()+limitMs;
 while(Date.now()<deadline){if(test())return;await sleep(25);}
 throw Error("REALTIME_TEST_TIMEOUT");
}
async function suite(){
 const dir=mkdtempSync(join(ROOT,"workspace-"));
 const state=mkdtempSync(join(ROOT,"state-"));
 const events=new CoachReviewEventStore(state);
 mkdirSync(join(dir,".devspace"));
 const yaml="version: 1\ntasks:\n  smoke-test:\n    mode: run\n    runtime: system\n    command: [\"echo\",\"ok\"]\n";
 writeFileSync(join(dir,".devspace","tasks.yaml"),yaml);
 const approvedSha=createHash("sha256").update(yaml).digest("hex");
 const runner=new NativeCodexAgentRunner({events,nodePath:NODE,codexPath:FIXTURE,
   spawn:(file,args,options)=>spawnChild(file,args,options) as any,
   locks:new JobResourceLocks()});
 const wId="workflow-ws";
 const ws={root:dir,approvedTasks:{taskIds:["smoke-test"],manifestSha256:approvedSha}};
 const task={runTask:async()=>{
   return {status:"succeeded",exitCode:0,sessionId:"test-session",taskId:"smoke-test",stdout:"all tests passed",stderr:""};
 }} as unknown as TaskRunner;
 const gate=new CoachReviewGate({events,tasks:task,locks:new JobResourceLocks()});
 const spec={planId:"sample-plan",workspaceId:wId,initialOperationId:"starting-op",
   reviewerModel:"gpt-6-luna" as const,reviewerEffort:"medium" as const,maxReworks:2,
   stages:[
    {prompt:"Fix riverGraph and verify it.",testTaskId:"smoke-test",model:"gpt-6-luna" as const,
     reasoningEffort:"medium" as const,sandbox:"workspace-write" as const},
    {prompt:"Publish the validated riverGraph stage two.",testTaskId:"smoke-test",
     model:"gpt-6.1-sol" as const,reasoningEffort:"high" as const,sandbox:"workspace-write" as const},
   ]};
 const input={workspaceId:wId,workspaceRoot:dir,operationId:"starting-op",prompt:"success",
   model:"gpt-6-luna" as const,reasoningEffort:"medium" as const,
   sandbox:"workspace-write" as const,timeoutMs:5000};
 const r=runner.start(input);assert.equal(r.state,"RUNNING");
 let called=0;
 const engine=new CoachRealtimeEngine(state,{events,tasks:task,runner:()=>runner,
   workspaces:{getWorkspace:(_id:string)=>ws} as any,gate,
   review:async()=>{
     const count=called++;
     return count===0?{decision:"REWORK",reason:"A real gap requires correction"}:
       {decision:"APPROVED",reason:"Verified source and deterministic test"};
   },recoveryIntervalMs:35});
 const plan=engine.register(spec);
 assert.equal(plan.phase,"ACTIVE");
 assert.throws(()=>engine.register({...spec,maxReworks:1}),/PLAN_ID_CONFLICT/);
 await eventually(()=>engine.get("sample-plan")?.phase==="DONE",15000);
 const final=engine.get("sample-plan")!;
 assert.equal(final.stageIndex,1);
 assert.equal(final.reworkCount,1,"rework budget is global across all stages");
 assert.equal(called,3,"must review initial, one rework, and next stage");
 const stage0=events.getReview(wId,"starting-op");
 assert.equal(stage0?.decision,"REWORK");
 const rework=events.getAgentRun(wId,"coach-sample-plan-s0-r1");
 assert.equal(rework?.state,"COMPLETED");
 assert.equal(events.getReview(wId,"coach-sample-plan-s0-r1")?.decision,"APPROVED");
 const second=events.getAgentRun(wId,"coach-sample-plan-s1-r1");
 assert.equal(second?.state,"COMPLETED");
 assert.equal(events.getReview(wId,"coach-sample-plan-s1-r1")?.decision,"APPROVED");
 const old=engine.all().length;
 await sleep(130);
 assert.equal(engine.all().length,old,"no replay after review");
 await engine.close();
 const rebooted=new CoachRealtimeEngine(state,{events,tasks:task,runner:()=>runner,
   workspaces:{getWorkspace:()=>ws} as any,gate,review:async()=>{throw Error("SHOULD_NOT_REVIEW")}});
 await sleep(80);
 assert.equal(rebooted.get("sample-plan")?.phase,"DONE","terminal plan survives restart");
 await rebooted.close();
 await runner.close();events.close();

 // Independent native reviewer format: its reply must be parsed strictly,
 // and must NEVER appear in public native Runner status data.
 const s2=mkdtempSync(join(ROOT,"review-store-"));
 const e2=new CoachReviewEventStore(s2);
 const run2=new NativeCodexAgentRunner({events:e2,nodePath:NODE,codexPath:FIXTURE,
   spawn:(file,args,options)=>spawnChild(file,args,options) as any,
   locks:new JobResourceLocks()});
 const ok=await run2.run({...input,workspaceId:"rev-ws",operationId:"revt-1",
   prompt:"REVIEW_SENTINEL",sandbox:"read-only",internalReview:true});
 assert.equal(ok.state,"COMPLETED");
 assert.equal(run2.getReviewRecommendation("revt-1")?.decision,"REWORK");
 assert.equal("reviewRecommendation" in run2.status("revt-1"),false);
 const bad=await run2.run({...input,workspaceId:"rev-ws",operationId:"revt-2",
   prompt:"REVIEW_SENTINEL BAD_REVIEW",sandbox:"read-only",internalReview:true});
 assert.equal(bad.state,"COMPLETED");
 assert.equal(run2.getReviewRecommendation("revt-2"),undefined);
 await run2.close();e2.close();

 // Fail-closed: a reviewer can recommend approval, but a failed approved
 // test MUST never sign an APPROVED receipt or dispatch another stage.
 const failDir=mkdtempSync(join(ROOT,"failure-workspace-"));
 mkdirSync(join(failDir,".devspace"));
 writeFileSync(join(failDir,".devspace","tasks.yaml"),yaml);
 const failState=mkdtempSync(join(ROOT,"failure-state-"));
 const failEvents=new CoachReviewEventStore(failState);
 const failRunner=new NativeCodexAgentRunner({events:failEvents,nodePath:NODE,codexPath:FIXTURE,
   spawn:(file,args,opts)=>spawnChild(file,args,opts) as any,locks:new JobResourceLocks()});
 const failWs={root:failDir,approvedTasks:{taskIds:["smoke-test"],manifestSha256:approvedSha}};
 const failTasks={runTask:async()=>({status:"failed",exitCode:1,taskId:"smoke-test",
   sessionId:"failure",stdout:"assertion failed",stderr:""})} as unknown as TaskRunner;
 const failedTestGate=new CoachReviewGate({events:failEvents,tasks:failTasks,locks:new JobResourceLocks()});
 const failOp="approval-needs-test";
 failRunner.start({...input,workspaceId:"fail-ws",workspaceRoot:failDir,operationId:failOp});
 const failing=new CoachRealtimeEngine(failState,{events:failEvents,tasks:failTasks,
   runner:()=>failRunner,workspaces:{getWorkspace:()=>failWs} as any,gate:failedTestGate,
   review:async()=>({decision:"APPROVED",reason:"Model believes it is done"}),
   recoveryIntervalMs:35});
 failing.register({...spec,planId:"no-fake-approval",workspaceId:"fail-ws",
   initialOperationId:failOp,stages:[spec.stages[0]]});
 await eventually(()=>failing.get("no-fake-approval")?.phase==="BLOCKED",7000);
 assert.equal(failEvents.getReview("fail-ws",failOp),undefined,"failed test cannot approve");
 assert.match(failing.get("no-fake-approval")?.lastError??"",/COACH_REVIEW_TEST_NOT_VERIFIED/);
 await failing.close();await failRunner.close();failEvents.close();

 // The pinned task manifest is an authorization boundary; changing it
 // after enrollment must block further automatic review and dispatch.
 const pinDir=mkdtempSync(join(ROOT,"pin-workspace-"));
 mkdirSync(join(pinDir,".devspace"));
 writeFileSync(join(pinDir,".devspace","tasks.yaml"),yaml);
 const pinState=mkdtempSync(join(ROOT,"pin-state-"));
 const pinEvents=new CoachReviewEventStore(pinState);
 const pinRunner=new NativeCodexAgentRunner({events:pinEvents,nodePath:NODE,codexPath:FIXTURE,
   spawn:(file,args,opts)=>spawnChild(file,args,opts) as any,locks:new JobResourceLocks()});
 const pinWs={root:pinDir,approvedTasks:{taskIds:["smoke-test"],manifestSha256:approvedSha}};
 const pinOp="manifest-pin-op";
 pinRunner.start({...input,workspaceId:"pin-ws",workspaceRoot:pinDir,operationId:pinOp});
 const pinned=new CoachRealtimeEngine(pinState,{events:pinEvents,tasks:task,
   runner:()=>pinRunner,workspaces:{getWorkspace:()=>pinWs} as any,
   gate:new CoachReviewGate({events:pinEvents,tasks:task,locks:new JobResourceLocks()}),
   review:async()=>({decision:"REWORK",reason:"A further correction is needed"}),
   recoveryIntervalMs:5000});
 pinned.register({...spec,planId:"pinned-approval",workspaceId:"pin-ws",
   initialOperationId:pinOp,stages:[spec.stages[0]]});
 pinned.pause("pinned-approval");
 writeFileSync(join(pinDir,".devspace","tasks.yaml"),yaml+"# mutated after approval\n");
 pinned.resume("pinned-approval");
 await eventually(()=>pinned.get("pinned-approval")?.phase==="BLOCKED",7000);
 assert.equal(pinEvents.getReview("pin-ws",pinOp),undefined,"changed manifest cannot be reviewed");
 await pinned.close();await pinRunner.close();pinEvents.close();
 console.log("COACH_REALTIME_SIGNED_NATIVE_THREE_STAGE_E2E_PASS");
 console.log("COACH_REALTIME_TEST_PROOF_AND_MANIFEST_NEGATIVE_GATES_PASS");
}
try{await suite();}finally{rmSync(ROOT,{recursive:true,force:true})}
