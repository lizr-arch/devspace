import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureDocument, fixtureTask } from "./coach-contract-fixture.js";
import { parseTask, verifyTask, freezeTask, freezeTaskFile, TaskGateError, sha256, reportPath, prepareTaskResults, type TaskReference } from "./coach-task-contract.js";
import { checkReport } from "./coach-result-contract.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { createCodexWorkerDispatcher } from "./codex-worker-ipc.js";
const root=mkdtempSync(join(tmpdir(),"task-contract-"));
let checks=0;
function rejects(fn:()=>unknown,code:string,keyword?:string){assert.throws(fn,(e:unknown)=>{
 assert.ok(e instanceof TaskGateError);assert.equal(e.diagnostic.schema,"DEVSPACE_TASK_GATE_RESULT_V1");
 assert.equal(e.diagnostic.codex_started,false);assert.equal(e.diagnostic.diagnostics[0].code,code);
 if(keyword)assert.equal(e.diagnostic.diagnostics[0].keyword,keyword);return true;});checks++;}
try{
 assert.equal(parseTask(Buffer.from(fixtureDocument)).taskId,"fixture-task");checks++;
 for(const [field,code] of [["schema","TASK_SCHEMA_INVALID"],["task_id","TASK_ID_INVALID"],["task_type","TASK_TYPE_INVALID"],["version","TASK_VERSION_INVALID"]])
  rejects(()=>parseTask(Buffer.from(fixtureDocument.replace(new RegExp("^"+field+":.*\\n","m"),""))),code,field);
 for(const section of ["WHY","GOAL","CONTEXT","SCOPE","IMPLEMENTATION","ACCEPTANCE","TEST","CONSTRAINTS","DONE"]){
  const changed=fixtureDocument.replace(new RegExp("^## "+section+"\\n[^]*?(?=^## |$(?![^]))","m"),"");
  rejects(()=>parseTask(Buffer.from(changed)),"TASK_SECTION_MISSING",section);
 }
 for(const sub of ["PROBLEM","EVIDENCE","HYPOTHESIS","RATIONALE"]){
  rejects(()=>parseTask(Buffer.from(fixtureDocument.replace(new RegExp("^### "+sub+"\\n[^]*?(?=^### |^## )","m"),""))),"TASK_WHY_MISSING",sub);
 }
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("## TEST","body says TEST"))),"TASK_SECTION_MISSING","TEST");
 rejects(()=>parseTask(Buffer.from(fixtureDocument+"\n## TEST\nRepeated test")),"TASK_DUPLICATE_HEADING","TEST");
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("## TEST","## TESTS"))),"TASK_UNKNOWN_HEADING","TESTS");
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("Run the deterministic fixture and preserve its actual exit code.","TODO: fill this with actual tests"))),"TASK_PLACEHOLDER","TEST");
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("Run the deterministic fixture and preserve its actual exit code.","N/A"))),"TASK_PLACEHOLDER","TEST");
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("A-01 -> G-01", "A-01 -> G-99"))),"TASK_ACCEPTANCE_LINK_INVALID");
 rejects(()=>parseTask(Buffer.from(fixtureDocument.replace("## CONTEXT","G-02: Another uncovered requirement.\n## CONTEXT"))),"TASK_GOAL_UNCOVERED");
 rejects(()=>parseTask(Buffer.from("x".repeat(128*1024+1))),"TASK_TOO_LARGE");
 const task=fixtureTask(root,"ws-one");verifyTask(root,"ws-one",task);verifyTask(root,"ws-one",{sha256:task.sha256,version:task.version,taskPath:task.taskPath,taskId:task.taskId,workspaceId:task.workspaceId});checks+=2;
 const automaticRoot=join(root,"server-freeze");mkdirSync(join(automaticRoot,".devspace/coach/tasks/fixture-task"),{recursive:true});
 writeFileSync(join(automaticRoot,task.taskPath),fixtureDocument);
 rejects(()=>freezeTaskFile(automaticRoot,"ws-auto",{taskId:task.taskId,expectedSha256:"0".repeat(64)}),"TASK_EXPECTED_HASH_MISMATCH","expectedSha256");
 assert.throws(()=>readFileSync(join(automaticRoot,".devspace/coach/tasks/fixture-task/frozen-v1.json")),/ENOENT/);checks++;
 rejects(()=>freezeTaskFile(automaticRoot,"ws-auto",{taskId:task.taskId,version:2}),"TASK_STALE_VERSION","version");
 rejects(()=>freezeTaskFile(automaticRoot,"ws-auto",{taskPath:"../TASK.md"}),"TASK_ID_INVALID");
 rejects(()=>freezeTaskFile(automaticRoot,"ws-auto",{taskId:task.taskId,taskPath:".devspace/coach/tasks/other/TASK.md"}),"TASK_PATH_MISMATCH");
 const automatic=freezeTaskFile(automaticRoot,"ws-auto",{taskId:task.taskId});
 assert.deepEqual(automatic,{...task,workspaceId:"ws-auto"});verifyTask(automaticRoot,"ws-auto",automatic);checks+=2;
 assert.deepEqual(freezeTaskFile(automaticRoot,"ws-auto",{taskPath:task.taskPath,expectedSha256:task.sha256}),automatic);checks++;
 rejects(()=>verifyTask(root,"ws-one"),"TASK_REFERENCE_REQUIRED");
 rejects(()=>verifyTask(root,"ws-two",task),"TASK_WORKSPACE_MISMATCH");
 rejects(()=>verifyTask(root,"ws-one",{...task,taskPath:"../TASK.md"}),"TASK_PATH_MISMATCH");
 rejects(()=>verifyTask(root,"ws-one",{...task,taskId:"other-task"}),"TASK_PATH_MISMATCH");
 symlinkSync(join(root,".devspace/coach/tasks/fixture-task"),join(root,".devspace/coach/tasks/task-alias"));
 rejects(()=>verifyTask(root,"ws-one",{...task,taskId:"task-alias",taskPath:".devspace/coach/tasks/task-alias/TASK.md"}),"TASK_SYMLINK");
 unlinkSync(join(root,".devspace/coach/tasks/task-alias"));
 rejects(()=>verifyTask(root,"ws-one",{...task,version:2}),"TASK_STALE_VERSION");
 rejects(()=>verifyTask(root,"ws-one",{...task,sha256:"a".repeat(64)}),"TASK_STALE_VERSION");
 const file=join(root,task.taskPath);writeFileSync(file,fixtureDocument+"\nChanged contract\n");
 rejects(()=>verifyTask(root,"ws-one",task),"TASK_STALE_VERSION");
 rejects(()=>freezeTask(root,"ws-one",{...task,sha256:sha256(readFileSync(file))}),"TASK_FREEZE_CONFLICT");
 writeFileSync(file,fixtureDocument);unlinkSync(file);writeFileSync(join(root,"outside.md"),fixtureDocument);symlinkSync(join(root,"outside.md"),file);
 rejects(()=>verifyTask(root,"ws-one",task),"TASK_SYMLINK");unlinkSync(file);writeFileSync(file,fixtureDocument);
 const other=join(root,"other-workspace");mkdirSync(join(other,".devspace/coach/tasks/fixture-task"),{recursive:true});
 writeFileSync(join(other,task.taskPath),fixtureDocument);
 const frozen=".devspace/coach/tasks/fixture-task/frozen-v1.json";
 writeFileSync(join(other,frozen),readFileSync(join(root,frozen)));
 rejects(()=>verifyTask(other,"ws-one",task),"TASK_FREEZE_MISMATCH");
 prepareTaskResults(root,task);
 const evidence="test-evidence.log";writeFileSync(join(root,evidence),"actual fixture output\n");
 const report={schema:"DEVSPACE_CODEX_REPORT_V1",task_id:task.taskId,task_sha256:task.sha256,operation_id:"op-one",stage_id:"stage-one",status:"READY_FOR_REVIEW",summary:"Completed fixture",changes:["fixture"],test_results:[{command:"fixture",exit_code:0,evidence_path:evidence,evidence_sha256:sha256(readFileSync(join(root,evidence)))}],remaining:[],issues:[],next_action:"review",evidence_paths:[evidence]};
 const path=join(root,reportPath(task,"op-one"));
 const check=(raw:unknown)=>{writeFileSync(path,typeof raw==="string"?raw:JSON.stringify(raw));return checkReport(root,task,"op-one","stage-one");};
 assert.equal(check(report).valid,true);assert.equal(check(report).testsIndependentlyVerified,false);checks+=2;
 for(const key of Object.keys(report)){const mutation={...report};delete (mutation as any)[key];assert.equal(check(mutation).valid,false,key);checks++;}
 for(const mutation of [{status:"PASS"},{task_id:"wrong"},{task_sha256:"a".repeat(64)},{operation_id:"wrong"},{stage_id:"wrong"},{remaining:["unfinished"]},{test_results:[]},{test_results:[{...report.test_results[0],exit_code:1}]},{evidence_paths:["missing.log"]},{evidence_paths:["../escape"]},{status:"PLAN_CONFLICT"}]){
  assert.equal(check({...report,...mutation}).valid,false,JSON.stringify(mutation));checks++;
 }
 assert.equal(check("{malformed").code,"REPORT_JSON_INVALID");checks++;
 symlinkSync(join(root,evidence),join(root,"evidence-link"));
 assert.equal(check({...report,evidence_paths:["evidence-link"]}).valid,false);checks++;
 for(const field of ["WHY","GOAL","CONTEXT","SCOPE","IMPLEMENTATION","ACCEPTANCE","TEST","CONSTRAINTS","DONE"]){
  if(field==="WHY")continue;
  const empty=fixtureDocument.replace(new RegExp("(^## "+field+"\\n)[^]*?(?=^## |$(?![^]))","m"),"$1");
  rejects(()=>parseTask(Buffer.from(empty)),"TASK_PLACEHOLDER",field);
 }
 const hidden=fixtureDocument.replace("## TEST\nRun the deterministic fixture and preserve its actual exit code.","````\n```\n## TEST\nFake heading inside a still-open fence\n````");
 rejects(()=>parseTask(Buffer.from(hidden)),"TASK_SECTION_MISSING","TEST");
 const events=new CoachReviewEventStore(join(root,"state"));let spawned=0;
 const runner=new NativeCodexAgentRunner({events,nodePath:process.execPath,codexPath:process.execPath,spawn:()=>{spawned++;throw Error("unexpected child");}});
 const input={workspaceId:"ws-one",workspaceRoot:root,operationId:"bypass",prompt:"arbitrary",model:"gpt-6-luna" as const,reasoningEffort:"none" as const,sandbox:"workspace-write" as const};
 rejects(()=>runner.start(input),"TASK_REFERENCE_REQUIRED");assert.equal(spawned,0);checks++;
 rejects(()=>runner.start({...input,internalReview:true}),"TASK_REVIEWER_NOT_READ_ONLY");
 rejects(()=>runner.start({...input,sandbox:"read-only",internalReview:"true"} as any),"TASK_REVIEWER_MODE_INVALID");
 let workerCalled=false;
 const dispatch=createCodexWorkerDispatcher({runner:{start:()=>{workerCalled=true;throw Error("bypass");}},events,workspaceStore:{getSession:()=>({root})},allowedRoots:[realpathSync(root)]} as any);
 await assert.rejects(()=>dispatch({version:1,token:"",op:"start",input} as any),/TASK_REFERENCE_REQUIRED/);assert.equal(spawned,0);assert.equal(workerCalled,false);checks++;
 // Change bytes in an asynchronous fingerprint hook, between boundary gate and spawn.
 const racing=new NativeCodexAgentRunner({events,nodePath:process.execPath,codexPath:process.execPath,
  spawn:()=>{spawned++;throw Error("must not spawn");},fingerprint:async()=>{writeFileSync(file,fixtureDocument+"changed");return {sha:"a".repeat(64),gitSummary:null};}});
 const late=await racing.run({...input,operationId:"late-edit",task});assert.equal(late.state,"FAILED");assert.match(late.reason??"",/TASK_STALE_VERSION/);assert.equal(spawned,0);checks++;
 await racing.close();await runner.close();events.close();
 console.log("TASK_AND_REPORT_CONTRACT_SECURITY_CONTROLS_PASS",{checks});
}finally{rmSync(root,{recursive:true,force:true});}
