/** Deterministic test fixtures. Never used by production code. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freezeTask, sha256, type TaskReference } from "./coach-task-contract.js";
export const fixtureDocument=`---
schema: DEVSPACE_TASK_V1
task_id: fixture-task
task_type: feature
version: 1
---
## WHY
### PROBLEM
The fixture needs a deterministic developer handoff.
### EVIDENCE
The test runner inspects native stream and filesystem evidence.
### HYPOTHESIS
Pinning full requirements prevents silent handoff drift.
### RATIONALE
Require explicit task authority before any child launch.
## GOAL
G-01: Deliver the deterministic fixture implementation.
## CONTEXT
The test workspace contains no external service dependencies.
## SCOPE
Change only the fixture deliverable.
## IMPLEMENTATION
Read source and produce the fixture output with actual evidence.
## ACCEPTANCE
A-01 -> G-01: The deliverable and immutable evidence are available.
## TEST
Run the deterministic fixture and preserve its actual exit code.
## CONSTRAINTS
Never change the authoritative task or another operation report.
## DONE
All fixture requirements and checks are complete before review.
`;
export function fixtureTask(root:string,workspaceId:string):TaskReference {
  const path=".devspace/coach/tasks/fixture-task/TASK.md";
  mkdirSync(join(root,".devspace/coach/tasks/fixture-task"),{recursive:true});
  if(!existsSync(join(root,path)))writeFileSync(join(root,path),fixtureDocument);
  const ref={workspaceId,taskId:"fixture-task",taskPath:path,version:1,sha256:sha256(readFileSync(join(root,path)))};
  return freezeTask(root,workspaceId,ref);
}
/** JS inserted into a fake Codex child; no model/network calls. */
export const fixtureReportSource=`
function fixtureReport(prompt,status="READY_FOR_REVIEW") {
 const m=/Authoritative task: (.+)\\nVersion: (.+)\\nSHA-256: (.+)\\nWorkspace: (.+)\\nOperation: (.+)\\nStage: (.+)\\n/.exec(prompt);
 if(!m)return;
 const fs=require("node:fs"), crypto=require("node:crypto"), path=require("node:path");
 const dir=path.dirname(m[1]), evidence="fixture-test-output.txt";
 fs.writeFileSync(evidence,"deterministic fixture test exited 0\\n");
 fs.mkdirSync(path.join(dir,"results"),{recursive:true});
 fs.writeFileSync(path.join(dir,"results",m[5]+".json"),JSON.stringify({
 schema:"DEVSPACE_CODEX_REPORT_V1",task_id:path.basename(dir),task_sha256:m[3],operation_id:m[5],stage_id:m[6],status,
 summary:"Fixture execution completed",changes:["fixture deliverable"],test_results:[{command:"fixture check",exit_code:0,evidence_path:evidence,evidence_sha256:crypto.createHash("sha256").update(fs.readFileSync(evidence)).digest("hex")}],
 remaining:status==="IN_PROGRESS"?["complete next fixture step"]:[],issues:[],next_action:"Independent review",evidence_paths:[evidence],
 ...(status==="PLAN_CONFLICT"?{plan_conflict:{assumption:"original assumption",counter_evidence:"actual source",impact:"goal affected",suggested_revision:"revise requirement",safe_to_continue:false}}:{})}));
}
`;
