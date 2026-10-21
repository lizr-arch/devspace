/** Native child + real Git/non-Git snapshots. No billable model or listening socket. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureTask, fixtureReportSource } from "./coach-contract-fixture.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner, captureCodexFingerprint, captureCodexSourceDiff } from "./codex-agent-runner.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { sha256, reportPath } from "./coach-task-contract.js";

const root=mkdtempSync(join(tmpdir(),"coach-contract-r1-"));
let checks=0;
async function scenario(git:boolean,mode:string,ignored=false){
  const dir=join(root,`${git?"git":"tree"}-${mode}${ignored?"-ignored":""}`),workspace=join(dir,"workspace");
  mkdirSync(workspace,{recursive:true});
  if(git)execFileSync("/usr/bin/git",["init","-q"],{cwd:workspace});
  if(ignored)writeFileSync(join(workspace,".gitignore"),".devspace/coach/tasks/\n");
  const task=fixtureTask(workspace,"ws-r1"),own=reportPath(task,"r1-op"),prefix=own.slice(0,-5)+"/";
  const legacy=".devspace/coach/tasks/fixture-task/results/legacy-cache/old.log";
  mkdirSync(join(workspace,legacy,".."),{recursive:true});writeFileSync(join(workspace,legacy),"preexisting evidence stays intact");
  const before=await captureCodexFingerprint(workspace);
  // Exact failure mechanism: an unscoped inventory must reject .devspace bytes.
  if(git&&!ignored){assert.throws(()=>captureCodexSourceDiff(workspace,{},before.changedFiles),/CODEX_EVIDENCE_SENSITIVE_PATH/);checks++;}
  const script=join(dir,"fixture.cjs");
  writeFileSync(script,fixtureReportSource+`
    let p="";process.stdin.on("data",b=>p+=b);process.stdin.on("end",()=>{
      fixtureReport(p);
      const fs=require("node:fs"),crypto=require("node:crypto"),mode=${JSON.stringify(mode)};
      const own=${JSON.stringify(own)},prefix=${JSON.stringify(prefix)};
      const report=JSON.parse(fs.readFileSync(own,"utf8"));
      if(["proof","unlisted","bad-hash","secret-proof","other-proof"].includes(mode)){
        const path=mode==="other-proof"?own.replace("r1-op.json","other-op.json"):prefix+(mode==="secret-proof"?"secret.txt":"test.log");
        fs.mkdirSync(require("node:path").dirname(path),{recursive:true});
        fs.writeFileSync(path,"RAW_PROOF_CONTENT_MUST_NOT_BE_INLINED\\n");
        if(mode!=="unlisted"){
          report.evidence_paths=[path];report.test_results=[{command:"fixture",exit_code:0,evidence_path:path,evidence_sha256:mode==="bad-hash"?"0".repeat(64):crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")}];
          fs.writeFileSync(own,JSON.stringify(report));
        }
      }
      if(mode==="task-edit")fs.appendFileSync(${JSON.stringify(task.taskPath)},"unauthorized task mutation");
      if(mode==="manifest-edit"){const path=${JSON.stringify(task.taskPath.replace('TASK.md','frozen-v1.json'))};fs.chmodSync(path,0o600);fs.appendFileSync(path,"tampered");}
      if(mode==="other-result")fs.writeFileSync(own.replace("r1-op.json","other-op.json"),"unrelated operation report");
      if(mode==="sensitive")fs.writeFileSync(".devspace/unrelated.txt","sensitive control content");
      if(mode==="symlink-result"){fs.unlinkSync(own);fs.symlinkSync("../../../../../fixture-test-output.txt",own);}
      if(mode==="legacy-edit")fs.appendFileSync(${JSON.stringify(legacy)},"changed");
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n");
    });`,{mode:0o700});
  const events=new CoachReviewEventStore(join(dir,"state"));
  const runner=new NativeCodexAgentRunner({events,nodePath:process.execPath,codexPath:script,locks:new JobResourceLocks(),spawn:(file,args,opts)=>spawn(file,args,opts)});
  try{
    const result=await runner.run({workspaceId:"ws-r1",workspaceRoot:workspace,operationId:"r1-op",task,prompt:"R1 fixture",model:"gpt-6-luna",reasoningEffort:"none",sandbox:"workspace-write"});
    assert.equal(result.exitCode,0);checks++;
    if(mode==="ready"||mode==="proof"){
      assert.equal(result.state,"COMPLETED",result.reason);assert.equal(result.evidenceState,"VERIFIED");assert.equal(result.report?.valid,true);
      const evidence=events.getEvidence("ws-r1","r1-op") as {sourceDiff:string;operationProofs:Array<{path:string;sha256:string}>};
      assert.ok(evidence.operationProofs.some(p=>p.path===own&&p.sha256===sha256(readFileSync(join(workspace,own)))));
      assert.doesNotMatch(JSON.stringify(evidence),/Fixture execution completed|RAW_PROOF_CONTENT_MUST_NOT_BE_INLINED|preexisting evidence stays intact/);
      if(mode==="proof")assert.ok(evidence.operationProofs.some(p=>p.path===prefix+"test.log"&&p.sha256===sha256(readFileSync(join(workspace,prefix,"test.log")))));
      assert.equal(events.listPending("ws-r1").events[0].event_type,"READY_FOR_GPT_REVIEW");checks+=8;
    }else{
      assert.equal(result.state,"FAILED",`${mode}: ${JSON.stringify(result)}`);
      assert.equal(result.failureStage,"evidence");assert.equal(events.getEvidence("ws-r1","r1-op"),undefined);
      assert.equal(events.listPending("ws-r1").pending_count,0);
      if(mode==="sensitive"||mode==="secret-proof")assert.equal(result.reason,"CODEX_EVIDENCE_SENSITIVE_PATH");
      else assert.match(result.reason??"",/CODEX_TASK_CONTROL_MUTATED|TASK_SYMLINK/);
      checks+=5;
    }
    if(mode!=="legacy-edit")assert.equal(readFileSync(join(workspace,legacy),"utf8"),"preexisting evidence stays intact");
  }finally{await runner.close();events.close();}
}
try{
  for(const git of [false,true])for(const mode of ["ready","proof","task-edit","manifest-edit","other-result","sensitive","unlisted","bad-hash","secret-proof","other-proof","symlink-result","legacy-edit"])await scenario(git,mode);
  for(const mode of ["proof","task-edit","other-result","unlisted"])await scenario(true,mode,true);
  console.log("CONTRACT_R1_NATIVE_PROOF_POSITIVE_AND_SENSITIVE_CONTROL_NEGATIVES_PASS",{scenarios:28,checks});
}finally{rmSync(root,{recursive:true,force:true});}
