import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {CoachReviewEventStore} from "./coach-review-events.js";
const root=mkdtempSync(join(tmpdir(),"coach-ack-legacy-"));
const store=new CoachReviewEventStore(join(root,"state"));
const base={operationId:"legacy-ack-op",workspaceId:"ws-ack",threadId:"11111111-1111-4111-8111-111111111111",
  exitCode:0,eventTypes:["thread.started","turn.completed"],inputFingerprint:"1".repeat(64),finalFingerprint:"1".repeat(64),
  gitSummary:"HEAD=deadbee",sourceDiff:"",stdoutSha256:"2".repeat(64),stderrSha256:"3".repeat(64),
  capturedAt:"2026-11-01T00:00:00.000Z",invocation:{sandbox:"read-only",reasoningEffort:"none",resumed:false}};
const evidenceSha256=createHash("sha256").update(JSON.stringify(base)).digest("hex");
const event=store.recordCompletedWithEvidence({workspaceId:"ws-ack",operationId:"legacy-ack-op",
  evidenceSha256,packetJson:JSON.stringify({...base,evidenceSha256})});
try{
  const ack=store.recordWebGptTurnAck({workspaceId:"ws-ack",operationId:"legacy-ack-op",eventId:event.event_id,evidenceSha256}) as any;
  assert.ok(ack);
  assert.equal(ack.delivery_workspace_id,"ws-ack");
  assert.equal(ack.evidence_sha256,evidenceSha256);
  assert.throws(()=>store.recordWebGptTurnAck({workspaceId:"ws-ack",operationId:"wrong",eventId:event.event_id,evidenceSha256}),/COACH_TURN_ACK_SCOPE_MISMATCH/);
  assert.throws(()=>store.recordWebGptTurnAck({workspaceId:"ws-ack",operationId:"legacy-ack-op",eventId:event.event_id,evidenceSha256:"f".repeat(64)}),/COACH_TURN_ACK_SCOPE_MISMATCH/);
  console.log("COACH_LEGACY_TURN_ACK_PASS");
}finally{store.close();rmSync(root,{recursive:true,force:true});}
