import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { CoachHistoricalReview, coarseWorkspaceFingerprint } from "./coach-historical-review.js";
import { CoachReviewGate } from "./coach-review-gate.js";
import { JobResourceLocks } from "./job-resource-locks.js";

/**
 * DEVSPACE-HISTORICAL-REVIEW-001 targeted acceptance.
 * Verifies the archival channel is non-authoritative, fail-closed and additive.
 */
const root = mkdtempSync(join(tmpdir(), "coach-historical-review-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
mkdirSync(join(workspace, ".devspace"));
const state = join(root, "state");
const events = new CoachReviewEventStore(state);

function packetFor(workspaceId: string, operationId: string, finalFingerprint: string) {
  const base = {
    operationId,
    workspaceId,
    threadId: "11111111-1111-4111-8111-111111111111",
    exitCode: 0,
    eventTypes: ["thread.started", "turn.completed"],
    inputFingerprint: finalFingerprint,
    finalFingerprint,
    gitSummary: `HEAD=${finalFingerprint.slice(0, 7)}; status_entries=3; modified_or_untracked=3`,
    sourceDiff: "diff --git a/x b/x\n",
    stdoutSha256: "b".repeat(64),
    stderrSha256: "c".repeat(64),
    capturedAt: "2026-10-21T03:47:55.952Z",
    invocation: { sandbox: "read-only", reasoningEffort: "medium", resumed: false },
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { base, evidenceSha256, packetJson: JSON.stringify({ ...base, evidenceSha256 }) };
}

const drift = "a".repeat(64);
const frozen = "1".repeat(64);
const p = packetFor("ws-hist", "historical-op-219", frozen);
const event = events.recordCompletedWithEvidence({
  workspaceId: "ws-hist",
  operationId: "historical-op-219",
  evidenceSha256: p.evidenceSha256,
  packetJson: p.packetJson,
});
const service = new CoachHistoricalReview({
  events,
  fingerprint: async () => ({ sha: drift, gitSummary: "HEAD=0f3a922; status_entries=19" }),
});

try {
  // 1. Drifted workspace: historical BLOCKED is archived and recorded.
  const first = await service.submit({
    workspaceId: "ws-hist",
    workspaceRoot: workspace,
    operationId: "historical-op-219",
    eventId: event.event_id,
    decision: "BLOCKED",
    evidenceSha256: p.evidenceSha256,
    reason: "Historical read-only task completed but no verifiable deliverable or test evidence was found.",
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.receipt.decision, "BLOCKED");
  assert.equal(first.receipt.drift, 1);
  assert.equal(first.receipt.frozen_fingerprint, frozen);
  assert.equal(first.receipt.current_fingerprint, drift);
  assert.equal(first.receipt.current_fingerprint_algorithm, "full-snapshot-v1");
  assert.equal(first.receipt.event_id, event.event_id);
  assert.equal(first.receipt.operation_id, "historical-op-219");
  assert.equal(first.receipt.source, "codex_agent_submit_historical_review");
  assert.equal(events.listPending("ws-hist").pending_count, 0);
  assert.equal(service.list("ws-hist").length, 1);

  // 1b. Reverse mutual exclusion: once archived, a normal decision is refused.
  assert.throws(
    () => events.submitReview({
      workspaceId: "ws-hist",
      eventId: event.event_id,
      decision: "BLOCKED",
      evidenceSha256: p.evidenceSha256,
    }),
    /COACH_REVIEW_HISTORICAL_ARCHIVED_CONFLICT/,
  );

  // 1c. Identical replay stays idempotent even after further workspace drift
  //     (the current fingerprint is a snapshot, not part of request identity).
  const laterDrift = new CoachHistoricalReview({
    events,
    fingerprint: async () => ({ sha: "c".repeat(64), gitSummary: null }),
  });
  const laterReplay = await laterDrift.submit({
    workspaceId: "ws-hist",
    workspaceRoot: workspace,
    operationId: "historical-op-219",
    eventId: event.event_id,
    decision: "BLOCKED",
    evidenceSha256: p.evidenceSha256,
    reason: "Historical read-only task completed but no verifiable deliverable or test evidence was found.",
  });
  assert.equal(laterReplay.idempotent, true);
  assert.equal(laterReplay.receipt.current_fingerprint, drift,
    "replay must return the originally archived observation");

  // 2. Equal fingerprints must not use (or bypass) the archival path.
  const equalQ = packetFor("ws-equal", "historical-op-equal", frozen);
  const equalEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-equal",
    operationId: "historical-op-equal",
    evidenceSha256: equalQ.evidenceSha256,
    packetJson: equalQ.packetJson,
  });
  const equalService = new CoachHistoricalReview({
    events,
    fingerprint: async () => ({ sha: frozen, gitSummary: null }),
  });
  await assert.rejects(
    () => equalService.submit({
      workspaceId: "ws-equal",
      workspaceRoot: workspace,
      operationId: "historical-op-equal",
      eventId: equalEvent.event_id,
      decision: "BLOCKED",
      evidenceSha256: equalQ.evidenceSha256,
      reason: "Normal review must be used when the frozen fingerprint is unchanged.",
    }),
    /COACH_HISTORICAL_REVIEW_NOT_REQUIRED/,
  );

  // 3. Historical APPROVED is always forbidden.
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: event.event_id,
      decision: "APPROVED" as never,
      evidenceSha256: p.evidenceSha256,
      reason: "Attempting an approval through the archival path must be refused.",
    }),
    /COACH_HISTORICAL_APPROVED_FORBIDDEN/,
  );

  // 4. Wrong workspace / operation / event / SHA are all rejected.
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-other",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: event.event_id,
      decision: "BLOCKED",
      evidenceSha256: p.evidenceSha256,
      reason: "Wrong workspace must not find the immutable evidence packet.",
    }),
    /COACH_HISTORICAL_EVIDENCE_NOT_FOUND/,
  );
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "other-operation",
      eventId: event.event_id,
      decision: "BLOCKED",
      evidenceSha256: p.evidenceSha256,
      reason: "Wrong operation must fail the frozen identity check.",
    }),
    /COACH_HISTORICAL_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: 999999,
      decision: "BLOCKED",
      evidenceSha256: p.evidenceSha256,
      reason: "Unknown event ids must never be archived from caller input alone.",
    }),
    /COACH_HISTORICAL_EVIDENCE_NOT_FOUND/,
  );
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: event.event_id,
      decision: "BLOCKED",
      evidenceSha256: "f".repeat(64),
      reason: "A mismatched evidence digest must be rejected before archiving.",
    }),
    /COACH_HISTORICAL_EVIDENCE_MISMATCH/,
  );

  // 5. Identical replays are idempotent; conflicting replays are rejected.
  const replay = await service.submit({
    workspaceId: "ws-hist",
    workspaceRoot: workspace,
    operationId: "historical-op-219",
    eventId: event.event_id,
    decision: "BLOCKED",
    evidenceSha256: p.evidenceSha256,
    reason: "Historical read-only task completed but no verifiable deliverable or test evidence was found.",
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.receipt.reviewed_at, first.receipt.reviewed_at);
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: event.event_id,
      decision: "REWORK_RECOMMENDED",
      evidenceSha256: p.evidenceSha256,
      reason: "A conflicting second archival decision must be rejected.",
    }),
    /COACH_HISTORICAL_REVIEW_CONFLICT/,
  );

  // 6. Historical REWORK_RECOMMENDED grants no normal REWORK authority:
  //    the normal review table stays empty and start-rework lookup fails.
  const q = packetFor("ws-hist", "historical-op-rework", frozen);
  const reworkEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-hist",
    operationId: "historical-op-rework",
    evidenceSha256: q.evidenceSha256,
    packetJson: q.packetJson,
  });
  const rework = await service.submit({
    workspaceId: "ws-hist",
    workspaceRoot: workspace,
    operationId: "historical-op-rework",
    eventId: reworkEvent.event_id,
    decision: "REWORK_RECOMMENDED",
    evidenceSha256: q.evidenceSha256,
    reason: "Historical evidence suggests rework might be needed, but this grants no authority.",
  });
  assert.equal(rework.receipt.decision, "REWORK_RECOMMENDED");
  assert.equal(events.getReview("ws-hist", "historical-op-rework"), undefined,
    "historical archive must not populate the normal review table");
  const raw = new Database(join(state, "coach-review-events.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const normal = raw.prepare(
      "SELECT count(*) AS n FROM coach_review_decisions d " +
      "JOIN coach_review_events e ON e.event_id=d.event_id WHERE e.operation_id=?",
    ).get("historical-op-rework") as { n: number };
    assert.equal(normal.n, 0, "no normal decision may be created by archival");
    const historical = raw.prepare(
      "SELECT count(*) AS n FROM coach_historical_reviews WHERE operation_id=?",
    ).get("historical-op-rework") as { n: number };
    assert.equal(historical.n, 1);
  } finally {
    raw.close();
  }

  // 6b. A normal review already exists -> archival must refuse to shadow it.
  const normalQ = packetFor("ws-hist", "historical-op-normal", frozen);
  const normalEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-hist",
    operationId: "historical-op-normal",
    evidenceSha256: normalQ.evidenceSha256,
    packetJson: normalQ.packetJson,
  });
  events.submitReview({
    workspaceId: "ws-hist",
    eventId: normalEvent.event_id,
    decision: "BLOCKED",
    evidenceSha256: normalQ.evidenceSha256,
  });
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-normal",
      eventId: normalEvent.event_id,
      decision: "BLOCKED",
      evidenceSha256: normalQ.evidenceSha256,
      reason: "A normal review already exists, so no archival duplicate may be created.",
    }),
    /COACH_HISTORICAL_ALREADY_REVIEWED/,
  );

  // 6c. Tampered immutable evidence is a hard integrity failure, never a "not found".
  const tamperQ = packetFor("ws-tamper", "historical-op-tamper", frozen);
  const tamperEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-tamper",
    operationId: "historical-op-tamper",
    evidenceSha256: tamperQ.evidenceSha256,
    packetJson: tamperQ.packetJson,
  });
  const writable = new Database(join(state, "coach-review-events.sqlite"));
  try {
    writable.prepare("UPDATE coach_review_evidence SET packet_json=? WHERE event_id=?")
      .run("{\"tampered\":true}", tamperEvent.event_id);
  } finally {
    writable.close();
  }
  await assert.rejects(
    () => service.submit({
      workspaceId: "ws-tamper",
      workspaceRoot: workspace,
      operationId: "historical-op-tamper",
      eventId: tamperEvent.event_id,
      decision: "BLOCKED",
      evidenceSha256: tamperQ.evidenceSha256,
      reason: "Corrupted evidence must fail closed with an integrity error.",
    }),
    /COACH_EVIDENCE_INTEGRITY_FAILURE/,
  );

  // 6d. Oversized workspaces fall back to the bounded git coarse algorithm.
  const coarseQ = packetFor("ws-coarse", "historical-op-oversize", frozen);
  const coarseEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-coarse",
    operationId: "historical-op-oversize",
    evidenceSha256: coarseQ.evidenceSha256,
    packetJson: coarseQ.packetJson,
  });
  const coarseService = new CoachHistoricalReview({
    events,
    fingerprint: async () => { throw new Error("CODEX_SNAPSHOT_TOO_MANY_FILES"); },
    coarseFingerprint: () => ({ sha: "d".repeat(64), gitSummary: "HEAD=deadbee; algorithm=git-coarse-v1" }),
  });
  const coarse = await coarseService.submit({
    workspaceId: "ws-coarse",
    workspaceRoot: workspace,
    operationId: "historical-op-oversize",
    eventId: coarseEvent.event_id,
    decision: "BLOCKED",
    evidenceSha256: coarseQ.evidenceSha256,
    reason: "Oversized drift class: full snapshot unavailable, coarse bounded digest archived.",
  });
  assert.equal(coarse.receipt.current_fingerprint_algorithm, "git-coarse-v1");
  assert.equal(coarse.receipt.current_fingerprint, "d".repeat(64));
  assert.equal(coarse.receipt.drift, 1);
  assert.equal(events.getHistoricalReview("ws-coarse", coarseEvent.event_id)?.decision, "BLOCKED");

  // 6e. Coarse fallback fails closed without a trusted Git work tree, and is
  //     deterministic/change-sensitive on a real Git workspace.
  assert.throws(
    () => coarseWorkspaceFingerprint(workspace),
    /COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE/,
    "a plain directory has no trusted git state and must never yield a coarse digest",
  );
  const gitWorkspace = join(root, "git-workspace");
  mkdirSync(gitWorkspace);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: gitWorkspace });
  writeFileSync(join(gitWorkspace, "tracked.txt"), "one\n");
  execFileSync("/usr/bin/git", ["add", "tracked.txt"], { cwd: gitWorkspace });
  execFileSync("/usr/bin/git", ["-c", "user.email=t@example.test", "-c", "user.name=t",
    "commit", "-qm", "init"], { cwd: gitWorkspace });
  const coarseOne = coarseWorkspaceFingerprint(gitWorkspace);
  const coarseAgain = coarseWorkspaceFingerprint(gitWorkspace);
  assert.match(coarseOne.sha, /^[a-f0-9]{64}$/);
  assert.equal(coarseAgain.sha, coarseOne.sha, "coarse digest must be deterministic");
  writeFileSync(join(gitWorkspace, "untracked.txt"), "two\n");
  const coarseChanged = coarseWorkspaceFingerprint(gitWorkspace);
  assert.notEqual(coarseChanged.sha, coarseOne.sha,
    "coarse digest must change when the porcelain status stream changes");

  // 6f. If both the full and the coarse capture fail, archival is refused.
  const failQ = packetFor("ws-nofp", "historical-op-nofp", frozen);
  const failEvent = events.recordCompletedWithEvidence({
    workspaceId: "ws-nofp",
    operationId: "historical-op-nofp",
    evidenceSha256: failQ.evidenceSha256,
    packetJson: failQ.packetJson,
  });
  const noFingerprint = new CoachHistoricalReview({
    events,
    fingerprint: async () => { throw new Error("CODEX_SNAPSHOT_TOO_MANY_FILES"); },
    coarseFingerprint: () => { throw new Error("git status unavailable"); },
  });
  await assert.rejects(
    () => noFingerprint.submit({
      workspaceId: "ws-nofp",
      workspaceRoot: workspace,
      operationId: "historical-op-nofp",
      eventId: failEvent.event_id,
      decision: "BLOCKED",
      evidenceSha256: failQ.evidenceSha256,
      reason: "No trusted current fingerprint means no archive may be created.",
    }),
    /COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE/,
  );

  // 7. An operation owned by an active auto plan must use the plan path.
  const activePlanService = new CoachHistoricalReview({
    events,
    fingerprint: async () => ({ sha: drift, gitSummary: null }),
    activePlans: () => [
      { workspaceId: "ws-hist", currentOperationId: "historical-op-219", phase: "AWAITING_WEBGPT" },
    ],
  });
  await assert.rejects(
    () => activePlanService.submit({
      workspaceId: "ws-hist",
      workspaceRoot: workspace,
      operationId: "historical-op-219",
      eventId: event.event_id,
      decision: "BLOCKED",
      evidenceSha256: p.evidenceSha256,
      reason: "Active plan events must not bypass the plan review interface.",
    }),
    /COACH_HISTORICAL_ACTIVE_PLAN/,
  );

  // 8. Archived events are not redelivered, remain queryable after restart.
  assert.equal(events.listPending("ws-hist").pending_count, 0);
  const reopened = new CoachReviewEventStore(state);
  try {
    assert.equal(reopened.listPending("ws-hist").pending_count, 0);
    assert.equal(reopened.listHistoricalReviews("ws-hist").length, 2);
    assert.equal(reopened.getHistoricalReview("ws-hist", event.event_id)?.decision, "BLOCKED");
    assert.throws(() => reopened.listHistoricalReviews("../x"), /INVALID/);
  } finally {
    reopened.close();
  }

  // 9. Normal review still enforces fingerprint + verified-test gates.
  const events2 = new CoachReviewEventStore(join(root, "state-normal"));
  try {
    const frozenNormal = "9".repeat(64);
    const n = packetFor("ws-normal", "normal-op", frozenNormal);
    const normalEvent = events2.recordCompletedWithEvidence({
      workspaceId: "ws-normal",
      operationId: "normal-op",
      evidenceSha256: n.evidenceSha256,
      packetJson: n.packetJson,
    });
    const tasks = {
      runTask: async () => ({
        taskId: "test", mode: "run", sessionId: "task-1", status: "succeeded",
        exitCode: 0, stdout: "ok", stderr: "", durationMs: 1,
        runtime: { interpreter: "fake", environmentSource: "system" }, errors: [],
      }),
    } as never;
    const gate = new CoachReviewGate({
      events: events2,
      tasks,
      locks: new JobResourceLocks(),
      fingerprint: async () => ({ sha: frozenNormal, gitSummary: null }),
    });
    await assert.rejects(
      () => gate.submit({
        workspaceId: "ws-normal", workspaceRoot: workspace, operationId: "normal-op",
        eventId: normalEvent.event_id, decision: "APPROVED", evidenceSha256: n.evidenceSha256,
      }),
      /COACH_REVIEW_TEST_REQUIRED/,
    );
    await gate.verifyTest({
      workspaceId: "ws-normal", workspaceRoot: workspace, eventId: normalEvent.event_id, taskId: "test",
    });
    const approved = await gate.submit({
      workspaceId: "ws-normal", workspaceRoot: workspace, operationId: "normal-op",
      eventId: normalEvent.event_id, decision: "APPROVED", evidenceSha256: n.evidenceSha256,
    });
    assert.equal((approved as { decision: string }).decision, "APPROVED");
    const staleGate = new CoachReviewGate({
      events: events2,
      tasks,
      locks: new JobResourceLocks(),
      fingerprint: async () => ({ sha: drift, gitSummary: null }),
    });
    const n2 = packetFor("ws-normal", "normal-op-stale", "8".repeat(64));
    const staleEvent = events2.recordCompletedWithEvidence({
      workspaceId: "ws-normal", operationId: "normal-op-stale",
      evidenceSha256: n2.evidenceSha256, packetJson: n2.packetJson,
    });
    await assert.rejects(
      () => staleGate.submit({
        workspaceId: "ws-normal", workspaceRoot: workspace, operationId: "normal-op-stale",
        eventId: staleEvent.event_id, decision: "BLOCKED", evidenceSha256: n2.evidenceSha256,
      }),
      /COACH_REVIEW_STALE_EVIDENCE/,
    );
  } finally {
    events2.close();
  }

  // 10. Archival never mutates the frozen evidence or the workspace.
  const packetBefore = JSON.parse(p.packetJson) as Record<string, unknown>;
  const archivedFirst = events.getHistoricalReview("ws-hist", event.event_id);
  assert.equal(archivedFirst?.evidence_sha256, p.evidenceSha256);
  assert.equal(archivedFirst?.current_fingerprint_algorithm, "full-snapshot-v1");
  const db = new Database(join(state, "coach-review-events.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      "SELECT packet_json FROM coach_review_evidence WHERE event_id=?",
    ).get(event.event_id) as { packet_json: string };
    assert.deepEqual(JSON.parse(row.packet_json), packetBefore);
    const eventRow = db.prepare(
      "SELECT evidence_sha256 FROM coach_review_events WHERE event_id=?",
    ).get(event.event_id) as { evidence_sha256: string };
    assert.equal(eventRow.evidence_sha256, p.evidenceSha256);
  } finally {
    db.close();
  }
  assert.deepEqual(readdirSync(workspace), [".devspace"], "archival must not write workspace files");

  console.log("DEVSPACE_HISTORICAL_REVIEW_001_TARGETED_PASS");
} finally {
  try { events.close(); } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true });
}
