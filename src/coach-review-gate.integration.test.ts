import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskRunner } from "./task-runner.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { captureCodexFingerprint } from "./codex-agent-runner.js";
import { CoachReviewGate } from "./coach-review-gate.js";
import { registerCodexReviewTools } from "./server/tools-codex-review.js";
import { computeManifestSha256 } from "./task-manifest.js";
import type { ServerContext } from "./server/server-types.js";

const root=mkdtempSync(join(tmpdir(),"coach-b2-adversarial-"));
const workspace=join(root,"project");
mkdirSync(join(workspace,".devspace"),{recursive:true});
const source=join(workspace,"main.ts");
writeFileSync(source,"export const value = 1;\n");
const state=join(root,"state");
const store=new CoachReviewEventStore(state);
const locks=new JobResourceLocks();
const runner=new TaskRunner();
const sha=(txt:string)=>createHash("sha256").update(txt).digest("hex");
const manifest=(cmd:string,other?:string)=>{
  const tasks=[
    "version: 1", "tasks:",
    "  check:", "    mode: run", "    runtime: system", "    timeout_seconds: 20",
    "    command: "+JSON.stringify([process.execPath,"-e",cmd]),
    "  fail:", "    mode: run", "    runtime: system", "    timeout_seconds: 20",
    "    command: "+JSON.stringify([process.execPath,"-e","process.exit(2)"]),
    "  alter:", "    mode: run", "    runtime: system", "    timeout_seconds: 20",
    "    command: "+JSON.stringify([process.execPath,"-e","require('fs').writeFileSync('main.ts','CHANGED')"]),
  ].join("\n")+"\n";
  writeFileSync(join(workspace,".devspace","tasks.yaml"),tasks);
  return computeManifestSha256(workspace)!;
};
let manifestHash=manifest("process.stdout.write('REAL_UNIT_TEST_PASS')");
const startedReworks:Record<string,unknown>[]=[];
const ctx={config:{readOnly:false},tasks:runner,coachReviewEvents:store,
  getNativeCodexRunner:()=>({start:(input:Record<string,unknown>)=>{
    startedReworks.push(input);
    return {operationId:input.operationId,workspaceId:input.workspaceId,state:"RUNNING"};
  }}),workspaces:{
  getWorkspace(id:string) {
    if(id!=="allowed")throw new Error("WORKSPACE_NOT_AUTHORIZED");
    return {root:workspace,approvedTasks:{manifestSha256:manifestHash,taskIds:["check","fail","alter"]}};
  }
}} as unknown as ServerContext;
const server=new McpServer({name:"b2-review-test",version:"1.0"});
registerCodexReviewTools(server,ctx);
const client=new Client({name:"b2-review-client",version:"1.0"});
const [left,right]=InMemoryTransport.createLinkedPair();
await server.connect(right);await client.connect(left);
const gate=new CoachReviewGate({events:store,tasks:runner,locks});
async function completed(operationId:string,workspaceId="allowed"){
 const fp=await captureCodexFingerprint(workspace);
 const base={operationId,workspaceId,threadId:"11111111-1111-4111-8111-111111111111",exitCode:0,
  eventTypes:["thread.started","turn.completed"],inputFingerprint:fp.sha,finalFingerprint:fp.sha,
  gitSummary:fp.gitSummary,sourceDiff:"fixture",stdoutSha256:sha("stdout"),stderrSha256:sha(""),
  capturedAt:new Date().toISOString(),invocation:{sandbox:"workspace-write",reasoningEffort:"none",resumed:false}};
 const evidenceSha256=sha(JSON.stringify(base));
 const event=store.recordCompletedWithEvidence({workspaceId,operationId,evidenceSha256,packetJson:JSON.stringify({...base,evidenceSha256})});
 return {eventId:event.event_id,evidenceSha256,operationId,workspaceId};
}
const args=(info:Awaited<ReturnType<typeof completed>>,decision:"APPROVED"|"REWORK"|"BLOCKED")=>({
  ...info,decision
});
const submit=async(info:Awaited<ReturnType<typeof completed>>,decision:"APPROVED"|"REWORK"|"BLOCKED")=>
 client.callTool({name:"codex_agent_submit_review",arguments:args(info,decision)});
const verify=async(info:Awaited<ReturnType<typeof completed>>,taskId:string)=>
 client.callTool({name:"codex_agent_verify_test",arguments:{workspaceId:info.workspaceId,eventId:info.eventId,taskId}});
try {
 const t1=await completed("first-needs-rework");
 assert.equal((await submit(t1,"APPROVED")).isError,true,"unverified approval accepted");
 const rework=await submit(t1,"REWORK");
 assert.equal(rework.isError??false,false,JSON.stringify(rework));
 assert.equal((await submit(t1,"REWORK")).isError??false,false);
 const resumed=await client.callTool({name:"codex_agent_start_rework",arguments:{
   workspaceId:"allowed",parentOperationId:"first-needs-rework",
   operationId:"rework-child-1",prompt:"Fix the defective code",
   reasoningEffort:"none",sandbox:"workspace-write"
 }});
 assert.equal(resumed.isError??false,false,JSON.stringify(resumed));
 assert.equal(startedReworks.length,1);
 assert.equal(startedReworks[0].parentOperationId,"first-needs-rework");
 assert.equal(startedReworks[0].sessionId,"11111111-1111-4111-8111-111111111111");
 const rejectUnreviewed=await client.callTool({name:"codex_agent_start_rework",arguments:{
   workspaceId:"allowed",parentOperationId:"nonexistent",operationId:"badchild",
   prompt:"unauthorized rework",reasoningEffort:"none",sandbox:"workspace-write"
 }});
 assert.equal(rejectUnreviewed.isError,true);
 assert.equal((await submit(t1,"BLOCKED")).isError,true,"conflicting decision should fail");

 // Stale code must block old review, regardless of decision.
 const old=await completed("stale-after-change");
 writeFileSync(source,"export const value = 2;\n");
 assert.equal((await submit(old,"REWORK")).isError,true,"stale code review accepted");
 assert.equal((await verify(old,"check")).isError,true,"stale code test accepted");

 // Real TaskRunner verifies a current unchanged workspace only.
 const t2=await completed("second-ready");
 assert.equal((await verify(t2,"fail")).isError,true,"failed task accepted");
 assert.equal((await submit(t2,"APPROVED")).isError,true,"failed test allowed approval");
 assert.equal((await verify(t2,"alter")).isError,true,"mutating task accepted as unchanged");
 assert.equal((await submit(t2,"APPROVED")).isError,true);
 // Refresh the code and create a final new operation; testing must not alter it.
 writeFileSync(source,"export const value = 3;\n");
 const final=await completed("third-final-review");
 // Manifest changing invalidates every task approval.
 writeFileSync(join(workspace,".devspace","tasks.yaml"),"version: 1\ntasks: {}\n");
 assert.equal((await verify(final,"check")).isError,true,"changed manifest authorization bypass");
 manifestHash=manifest("process.stdout.write('REAL_UNIT_TEST_PASS')");
 // Note: this test uses non-git fingerprint, which ignores .devspace by design.
 const proof=await verify(final,"check");
 assert.equal(proof.isError??false,false,JSON.stringify(proof));
 assert.equal((await submit(final,"APPROVED")).isError??false,false);
 assert.equal((await verify(final,"check")).isError??false,false,"idempotent test re-executed or rejected");
 const reopened=new CoachReviewEventStore(state);
 try {
  assert.equal(reopened.listPending("allowed").pending_count,2,"stale and failed-verification events must stay pending, without approval");
  assert.equal(reopened.getVerifiedTest(final.eventId)?.task_id,"check");
  assert.equal(reopened.getEvidence("allowed","third-final-review")!==undefined,true);
 } finally {reopened.close();}
 const denied=await client.callTool({name:"codex_agent_verify_test",arguments:{
   workspaceId:"another",eventId:final.eventId,taskId:"check"}});
 assert.equal(denied.isError,true);
 console.log("COACH006B2_REAL_TASK_MCP_THREE_CYCLE_AUDIT_PASS");
} finally {
 await client.close();await server.close();store.close();
 rmSync(root,{recursive:true,force:true});
}
