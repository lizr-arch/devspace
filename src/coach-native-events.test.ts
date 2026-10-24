/**
 * M2 tests: verified native delivery -> durable Coach review event that the
 * already-bound Chrome exact conversation receives through the Coach feed.
 *
 * No daemon/App/Chrome/CLI is touched: a real CoachReviewEventStore on a
 * throwaway SQLite database stands in for the sidecar's event database, and the
 * test additionally runs the sidecar's exact app-event SQL to prove the row is
 * visible to the feed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoachReviewEventStore } from "./coach-review-events.js";
import {
  beginNativeJournal,
  nativeReviewEventId,
  nativeReviewEvidenceSha,
  publishNativeReceipt,
  readNativeReviewEvent,
} from "./coach-native-events.js";
import type { NativeOutboundReceipt, NativeOutboundState } from "./coach-native-outbound-types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const WORKSPACE = "ws_m2_test";
const ROOT = "/tmp/native-m2-root";
const THREAD = "01a16cef-0e26-7660-99f9-03caac52cfdf";
const TURN = "turn-m2-0001";

let pass = 0;
const dir = mkdtempSync(join(tmpdir(), "native-m2-events-"));
const store = new CoachReviewEventStore(dir);
try {
  // 1. Journal before the attempt.
  const journal = beginNativeJournal(store, {
    workspaceId: WORKSPACE,
    operationId: "native-op-1",
    workspaceRoot: ROOT,
    threadId: THREAD,
    promptSha256: sha("first prompt"),
    taskId: "task-1",
    taskSha256: sha("task-1"),
  });
  assert.equal(journal.state, "PENDING");
  pass++;

  // 2. ACCEPTED (queue only) must not publish a review event.
  let receipt: NativeOutboundReceipt = {
    state: "ACCEPTED",
    workspaceId: WORKSPACE,
    operationId: "native-op-1",
    threadId: THREAD,
    payloadSha256: sha("first prompt"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    queueMessageId: "01a16dff-23db-7a52-a5a8-0c23c5e985c6",
  };
  let published = publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-1", receipt });
  assert.equal(published.published, false);
  assert.equal(store.getAppTurn(WORKSPACE, "native-op-1")?.state, "PENDING");
  assert.equal(store.listPendingAppEvents(WORKSPACE).length, 0);
  pass++;

  // 3. COMPLETED without a real turnId must fail closed, not publish.
  receipt = { ...receipt, state: "COMPLETED" };
  assert.throws(
    () => publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-1", receipt }),
    /CODEX_APP_TURN_ID_REQUIRED/,
  );
  assert.equal(store.listPendingAppEvents(WORKSPACE).length, 0);
  pass++;

  // 4. REPLY_VERIFIED with turnId publishes exactly one durable event.
  receipt = { ...receipt, state: "REPLY_VERIFIED", turnId: TURN, reply: "done", replySha256: sha("done") };
  published = publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-1", receipt });
  assert.equal(published.published, true);
  assert.equal(published.eventId, nativeReviewEventId(WORKSPACE, "native-op-1"));
  const events = store.listPendingAppEvents(WORKSPACE);
  assert.equal(events.length, 1);
  const expectedEvidence = nativeReviewEvidenceSha({
    workspaceId: WORKSPACE,
    operationId: "native-op-1",
    threadId: THREAD,
    turnId: TURN,
    requestSha256: sha("first prompt"),
    taskId: "task-1",
    taskSha256: sha("task-1"),
  });
  assert.equal(events[0].thread_id, THREAD);
  assert.equal(events[0].turn_id, TURN);
  assert.equal(events[0].evidence_sha256, expectedEvidence);
  assert.equal(events[0].event_type, "CODEX_APP_READY_FOR_GPT_REVIEW");
  pass++;

  // 5. The real sidecar feed SQL sees the exact app row (no DSH in the path).
  const dbPath = join(dir, "coach-review-events.sqlite");
  const dbExists = (() => {
    try {
      readFileSync(dbPath);
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(dbExists, true);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT e.event_id,e.workspace_id,e.thread_id,e.turn_id,e.evidence_sha256,'CODEX_APP_READY_FOR_GPT_REVIEW' AS event_type " +
          "FROM codex_app_review_events e LEFT JOIN codex_app_review_decisions d ON d.event_id=e.event_id " +
          "WHERE e.workspace_id=? AND d.event_id IS NULL",
      )
      .all(WORKSPACE) as Array<Record<string, string>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "CODEX_APP_READY_FOR_GPT_REVIEW");
    assert.equal(rows[0].thread_id, THREAD);
    assert.equal(rows[0].turn_id, TURN);
    assert.equal(rows[0].evidence_sha256, expectedEvidence);
  } finally {
    db.close();
  }
  pass++;

  // 6. Republishing the same verified receipt is idempotent (one event row).
  published = publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-1", receipt });
  assert.equal(published.published, true);
  assert.equal(store.listPendingAppEvents(WORKSPACE).length, 1);
  pass++;

  // 7. A conflicting turnId for the same operationId stops with identity conflict.
  const conflicting = { ...receipt, state: "COMPLETED" as NativeOutboundState, turnId: "turn-m2-other" };
  assert.throws(
    () => publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-1", receipt: conflicting }),
    /CODEX_APP_EVENT_IDENTITY_CONFLICT/,
  );
  pass++;

  // 8. UNCERTAIN is journaled but never published; never retried/promoted.
  beginNativeJournal(store, {
    workspaceId: WORKSPACE,
    operationId: "native-op-2",
    workspaceRoot: ROOT,
    threadId: THREAD,
    promptSha256: sha("second prompt"),
    taskId: "task-1",
    taskSha256: sha("task-1"),
  });
  const uncertain: NativeOutboundReceipt = {
    state: "UNCERTAIN",
    workspaceId: WORKSPACE,
    operationId: "native-op-2",
    threadId: THREAD,
    payloadSha256: sha("second prompt"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uncertaintyReason: "OBSERVE_TIMEOUT",
  };
  const uncertainResult = publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-2", receipt: uncertain });
  assert.equal(uncertainResult.published, false);
  assert.equal(uncertainResult.state, "UNCERTAIN");
  assert.equal(store.getAppTurn(WORKSPACE, "native-op-2")?.state, "UNCERTAIN");
  assert.equal(store.listPendingAppEvents(WORKSPACE).length, 1, "UNCERTAIN must not add a review event");
  pass++;

  // 9. BLOCKED maps to FAILED journal state and publishes nothing.
  beginNativeJournal(store, {
    workspaceId: WORKSPACE,
    operationId: "native-op-3",
    workspaceRoot: ROOT,
    threadId: THREAD,
    promptSha256: sha("third prompt"),
    taskId: "task-1",
    taskSha256: sha("task-1"),
  });
  const blocked: NativeOutboundReceipt = {
    ...uncertain,
    state: "BLOCKED",
    operationId: "native-op-3",
    payloadSha256: sha("third prompt"),
    error: "BLOCKED_APP_OWNER_REQUIRED",
    turnId: undefined,
  };
  const blockedResult = publishNativeReceipt(store, { workspaceId: WORKSPACE, operationId: "native-op-3", receipt: blocked });
  assert.equal(blockedResult.published, false);
  assert.equal(store.getAppTurn(WORKSPACE, "native-op-3")?.state, "FAILED");
  assert.equal(store.listPendingAppEvents(WORKSPACE).length, 1);
  pass++;

  // 10. Receipt read helper returns the exact event Web GPT must review.
  const view = readNativeReviewEvent(store, WORKSPACE, "native-op-1");
  assert.ok(view);
  assert.equal(view!.eventId, nativeReviewEventId(WORKSPACE, "native-op-1"));
  assert.equal(view!.threadId, THREAD);
  assert.equal(view!.turnId, TURN);
  assert.equal(view!.evidenceSha256, expectedEvidence);
  assert.equal(readNativeReviewEvent(store, WORKSPACE, "native-op-2"), undefined);
  pass++;

  // 11. A review decision on the published event is bound to that evidence sha,
  //     so Web GPT's independent REWORK can only target this exact turn.
  const decision = store.submitAppReview({
    workspaceId: WORKSPACE,
    eventId: view!.eventId,
    decision: "REWORK",
    evidenceSha256: view!.evidenceSha256,
    reason: "independent review: needs one fix",
  });
  assert.equal(decision.decision, "REWORK");
  assert.throws(
    () =>
      store.submitAppReview({
        workspaceId: WORKSPACE,
        eventId: view!.eventId,
        decision: "APPROVED",
        evidenceSha256: sha("wrong evidence"),
        reason: "wrong evidence must not be accepted",
      }),
    /CODEX_APP_REVIEW_EVIDENCE_MISMATCH/,
  );
  const prior = store.getAppEventTask(WORKSPACE, view!.eventId);
  assert.equal(prior?.thread_id, THREAD);
  assert.equal(prior?.decision, "REWORK");
  pass++;

  process.stdout.write("NATIVE_EVENTS_TEST_PASS " + pass + "\n");
} finally {
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
}
