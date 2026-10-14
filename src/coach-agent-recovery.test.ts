import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerProjectTaskTool } from "./server/tools-tasks.js";
import { setToolQuarantineGuard } from "./server/server-helpers.js";
import type { ServerContext } from "./server/server-types.js";
const root=mkdtempSync(join(tmpdir(),"coach-b3-recovery-"));
const state=join(root,"state"),fingerprint="a".repeat(64),other="b".repeat(64);
let db=new CoachReviewEventStore(state);
try {
  db.claimAgentRun({workspaceId:"w1",operationId:"crash-before-completion",requestSha256:fingerprint});
  db.claimAgentRun({workspaceId:"w1",operationId:"crash-after-event",requestSha256:other});
  db.claimAgentRun({workspaceId:"w2",operationId:"crash-before-completion",requestSha256:fingerprint});
  const base={
    operationId:"crash-after-event",workspaceId:"w1",threadId:"11111111-1111-4111-8111-111111111111",
    exitCode:0,eventTypes:["thread.started","turn.completed"],inputFingerprint:other,
    finalFingerprint:other,gitSummary:null,sourceDiff:"snapshot",stdoutSha256:fingerprint,
    stderrSha256:fingerprint,capturedAt:new Date().toISOString(),
    invocation:{sandbox:"workspace-write",reasoningEffort:"none",resumed:false}
  };
  const evidenceSha256=createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const event=db.recordCompletedWithEvidence({
    workspaceId:"w1",operationId:"crash-after-event",evidenceSha256,
    packetJson:JSON.stringify({...base,evidenceSha256})
  });
  assert.ok(event.event_id>0);
  db.close();
  db=new CoachReviewEventStore(state);
  const verdict=db.reconcileInterruptedRuns();
  assert.deepEqual(verdict,{interrupted:2,completed:1});
  assert.equal(db.getAgentRun("w1","crash-before-completion")?.state,"INTERRUPTED");
  assert.equal(db.getAgentRun("w1","crash-after-event")?.state,"COMPLETED");
  assert.equal(db.getAgentRun("w1","crash-after-event")?.eventId,event.event_id);
  assert.equal(db.getAgentRun("w2","crash-before-completion")?.state,"INTERRUPTED");
  assert.equal(db.listPending("w1").pending_count,1);
  assert.equal(db.listPending("w2").pending_count,0);
  assert.deepEqual(db.reconcileInterruptedRuns(),{interrupted:0,completed:0});
  assert.throws(()=>db.claimAgentRun({
    workspaceId:"w1",operationId:"crash-before-completion",requestSha256:fingerprint
  }),/NO_REPLAY/);
  assert.throws(()=>db.claimAgentRun({
    workspaceId:"w1",operationId:"crash-before-completion",requestSha256:other
  }),/IDENTITY_CONFLICT/);
  assert.throws(()=>db.finishAgentRun({
    workspaceId:"w1",operationId:"crash-before-completion",state:"COMPLETED",eventId:event.event_id
  }),/NOT_ACTIVE/);
  assert.equal(db.getEvidence("w1","crash-after-event")!==undefined,true);
  assert.equal(db.getEvidence("w2","crash-after-event"),undefined);
  // Normal terminals remain terminal and cannot be manually repeated.
  const stop=db.claimAgentRun({workspaceId:"w1",operationId:"explicit-stop",requestSha256:fingerprint});
  assert.equal(stop.state,"RUNNING");
  assert.equal(db.finishAgentRun({workspaceId:"w1",operationId:"explicit-stop",state:"STOPPED"}).state,"STOPPED");
  assert.throws(()=>db.claimAgentRun({workspaceId:"w1",operationId:"explicit-stop",requestSha256:fingerprint}),/NO_REPLAY/);
  // Open another store instance to prove persistent recovered status; no Codex
  // is spawned and no orphan-PID kill is attempted during this test.
  const reopen=new CoachReviewEventStore(state);
  try {
    assert.equal(reopen.getAgentRun("w1","crash-before-completion")?.state,"INTERRUPTED");
    assert.equal(reopen.getAgentRun("w1","crash-after-event")?.state,"COMPLETED");
  } finally {reopen.close();}
  // An unresolved crash must quarantine subsequent native Agent starts.
  const fake=join(root,"fake-codex.cjs");
  writeFileSync(fake,"process.exit(0)",{mode:0o700});chmodSync(fake,0o700);
  let spawned=false;
  const native=new NativeCodexAgentRunner({events:db,
    nodePath:"/Users/liz/.local/bin/node",codexPath:fake,
    spawn:()=>{spawned=true;throw new Error("SHOULD_NEVER_SPAWN");},
  });
  assert.throws(()=>native.run({workspaceId:"w1",workspaceRoot:root,
    operationId:"new-operation-after-crash",prompt:"test",model:"gpt-6-luna",
    reasoningEffort:"none",sandbox:"workspace-write"}),/QUARANTINED/);
  assert.equal(spawned,false);
  // The existing ordinary project_task tool must also refuse to execute
  // inside a workspace with an unresolved Codex crash.
  let projectTaskCalled=false;
  const context={config:{readOnly:false},coachReviewEvents:db,
    workspaces:{getWorkspace:()=>({root,approvedTasks:{manifestSha256:"x",taskIds:["test"]}})},
    tasks:{runTask:()=>{projectTaskCalled=true;throw new Error("SHOULD_NEVER_RUN");}},
  } as unknown as ServerContext;
  const server=new McpServer({name:"b3-quarantine",version:"1.0"});
  registerProjectTaskTool(server,context);
  setToolQuarantineGuard((workspaceId)=>db.hasInterruptedRun(workspaceId));
  const client=new Client({name:"b3-quarantine-client",version:"1.0"});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await server.connect(right);await client.connect(left);
  try {
    const result=await client.callTool({name:"project_task",arguments:{
      workspaceId:"w1",task:"test"
    }});
    assert.equal(result.isError,true,"unsafe project_task did not block");
    assert.equal(projectTaskCalled,false);
  } finally {
    setToolQuarantineGuard(undefined);
    await client.close();await server.close();
  }
  console.log("COACH006B3_SQLITE_INTERRUPTED_RECONCILE_NO_REPLAY_AND_QUARANTINE_PASS");
} finally {
  db.close();
  rmSync(root,{recursive:true,force:true});
}
