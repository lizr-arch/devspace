import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";

const root=mkdtempSync(join(tmpdir(),"coach006b1-real-codex-"));
const workspace=mkdtempSync(join(root,"workspace-"));
const state=join(root,"state");
const events=new CoachReviewEventStore(state);
const runner=new NativeCodexAgentRunner({
  events,nodePath:"/Users/liz/.local/bin/node",
  codexPath:"/Users/liz/.local/bin/codex",
});
try {
  const input={
    workspaceId:"b1-real-smoke",
    workspaceRoot:workspace,
    operationId:"b1-real-codex-readonly-handshake",
    prompt:"Return exactly COACH_B1_REAL_OK. Do not invoke any tools, run shell commands, create files, or change settings.",
    model:"gpt-6-luna" as const,
    reasoningEffort:"none" as const,
    sandbox:"read-only" as const,
    timeoutMs:120000,
  };
  const status=await runner.run(input);
  assert.equal(status.state,"COMPLETED",JSON.stringify(status));
  assert.ok(status.threadId?.match(/^[0-9a-f-]{36}$/));
  assert.ok(status.eventId && status.eventId>0);
  const evidence=events.getEvidence(input.workspaceId,input.operationId) as
    {evidenceSha256:string; inputFingerprint:string; finalFingerprint:string;
      eventTypes:string[]; tokenUsage?:unknown}|undefined;
  assert.ok(evidence);
  assert.equal(evidence.evidenceSha256,status.evidenceSha256);
  assert.equal(evidence.finalFingerprint,evidence.inputFingerprint,"read-only handshake must leave scratch workspace unchanged");
  assert.ok(evidence.eventTypes.includes("turn.completed"));
  assert.equal(events.listPending(input.workspaceId).pending_count,1);
  // A second real Codex CLI invocation resumes the SAME UUIDv7 session.
  const continued=await runner.run({...input,
    operationId:"b1-real-codex-resume-handshake",
    sessionId:status.threadId,
    prompt:"Return exactly COACH_B1_RESUME_OK. Do not use any tools or modify files.",
  });
  assert.equal(continued.state,"COMPLETED",JSON.stringify(continued));
  assert.equal(continued.threadId,status.threadId,
    "Codex exec resume must retain exact session identity");
  assert.equal(events.listPending(input.workspaceId).pending_count,2);
  const restored=new CoachReviewEventStore(state);
  try {
    assert.deepEqual(restored.getEvidence(input.workspaceId,input.operationId),evidence);
    assert.equal((restored.getEvidence(input.workspaceId,"b1-real-codex-resume-handshake") as
      {threadId:string}).threadId,status.threadId);
  } finally {restored.close();}
  console.log(JSON.stringify({
    result:"COACH006B1_REAL_CODEX_END_TO_END_PASS",
    threadId:status.threadId,
    eventId:status.eventId,
    elapsedMs:status.elapsedMs,
    tokenUsage:status.tokenUsage,
    evidenceSha256:status.evidenceSha256,
    resumedSameThread:continued.threadId===status.threadId,
    resumeEventId:continued.eventId,
    scratchModified:false,
    productionTouched:false,
  }));
} finally {
  await runner.close();
  events.close();
  rmSync(root,{recursive:true,force:true});
}
