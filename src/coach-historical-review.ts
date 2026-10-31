import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { captureCodexFingerprint } from "./codex-agent-runner.js";
import type {
  CoachReviewEventStore,
  HistoricalDecision,
  HistoricalReviewReceipt,
} from "./coach-review-events.js";

const SHA = /^[a-f0-9]{64}$/;
/** Plan phases that still own the operation and must use the plan review path. */
const ACTIVE_PLAN_PHASES = new Set(["ACTIVE", "AWAITING_WEBGPT", "REVIEWING", "DISPATCHING", "PAUSED"]);
export const HISTORICAL_REVIEW_SOURCE = "codex_agent_submit_historical_review";
export const FULL_FINGERPRINT_ALGORITHM = "full-snapshot-v1";
export const COARSE_FINGERPRINT_ALGORITHM = "git-coarse-v1";

/**
 * Bounded fallback fingerprint for workspaces whose full snapshot exceeds the
 * 2000-file / 32MiB evidence caps. It hashes HEAD plus the complete porcelain
 * status stream (paths included) so drift remains detectable without reading
 * every file; the algorithm is recorded in the audit row.
 */
export function coarseWorkspaceFingerprint(root: string): HistoricalFingerprint {
  const run = (...args: string[]) => execFileSync("/usr/bin/git", args, {
    cwd: root, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  }) as Buffer;
  // Fail closed: without a trusted Git work tree, a matching Git root and a
  // readable status stream there is no coarse fingerprint at all. An empty
  // status or an unreadable HEAD must never stand in for a trusted one.
  let inside: string;
  try { inside = run("rev-parse", "--is-inside-work-tree").toString("utf8").trim(); }
  catch {
    throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
  }
  if (inside !== "true") throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
  // The coarse digest must describe EXACTLY this workspace root, not an
  // enclosing repository: normalize both paths and require equality.
  let topLevel: string;
  let workspaceRoot: string;
  try {
    topLevel = realpathSync(run("rev-parse", "--show-toplevel").toString("utf8").trim());
    workspaceRoot = realpathSync(root);
  } catch {
    throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
  }
  if (topLevel !== workspaceRoot) throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
  // A valid committed HEAD is required; corrupted/missing HEAD fails closed
  // instead of being silently treated as an unborn repository.
  let head: string;
  try { head = run("rev-parse", "--verify", "HEAD^{commit}").toString("utf8").trim(); }
  catch { throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE"); }
  // An unreadable status stream is never replaced with an empty one.
  let status: Buffer;
  try { status = run("status", "--porcelain=v1", "-z", "--untracked-files=all"); }
  catch { throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE"); }
  const statusDigest = createHash("sha256").update(status).digest("hex");
  const sha = createHash("sha256")
    .update(COARSE_FINGERPRINT_ALGORITHM + "\0" + head + "\0" + statusDigest)
    .digest("hex");
  return { sha, gitSummary: `HEAD=${head}; algorithm=${COARSE_FINGERPRINT_ALGORITHM}; status_sha256=${statusDigest.slice(0, 16)}` };
}

export interface HistoricalPlanView {
  workspaceId: string;
  currentOperationId: string;
  phase: string;
}
export interface HistoricalFingerprint {
  sha: string;
  gitSummary: string | null;
}
export interface CoachHistoricalReviewOptions {
  events: CoachReviewEventStore;
  /** Injectable for deterministic tests; defaults to the real bounded snapshot. */
  fingerprint?: (root: string) => Promise<HistoricalFingerprint>;
  /** Fallback used only when the full snapshot exceeds its file/byte caps. */
  coarseFingerprint?: (root: string) => HistoricalFingerprint;
  /** Injectable for deterministic tests; defaults to no plans. */
  activePlans?: () => HistoricalPlanView[];
}
export interface HistoricalReviewRequest {
  workspaceId: string;
  workspaceRoot: string;
  operationId: string;
  eventId: number;
  decision: HistoricalDecision;
  evidenceSha256: string;
  reason: string;
  source?: string;
}
export interface HistoricalReviewResult {
  receipt: HistoricalReviewReceipt;
  idempotent: boolean;
}

/**
 * Archival-only review path for completed Codex events whose frozen evidence
 * no longer matches the current (drifted) workspace. It is deliberately
 * non-authoritative: no APPROVED, no scheduler wake, no rework authority, no
 * evidence mutation. Normal review and rework semantics are untouched.
 */
export class CoachHistoricalReview {
  private readonly events: CoachReviewEventStore;
  private readonly fingerprint: (root: string) => Promise<HistoricalFingerprint>;
  private readonly coarseFingerprint: (root: string) => HistoricalFingerprint;
  private readonly activePlans: () => HistoricalPlanView[];

  constructor(options: CoachHistoricalReviewOptions) {
    this.events = options.events;
    this.fingerprint = options.fingerprint ?? captureCodexFingerprint;
    this.coarseFingerprint = options.coarseFingerprint ?? coarseWorkspaceFingerprint;
    this.activePlans = options.activePlans ?? (() => []);
  }

  /** Bounded read of archived historical reviews (queryable audit state). */
  list(workspaceId: string, limit = 50): HistoricalReviewReceipt[] {
    return this.events.listHistoricalReviews(workspaceId, limit);
  }

  async submit(input: HistoricalReviewRequest): Promise<HistoricalReviewResult> {
    // 1. Only non-advancing archival decisions are representable. APPROVED is
    // checked as a raw string so a caller bypassing the tool schema still fails.
    const decisionValue: string = input.decision;
    if (decisionValue === "APPROVED") throw new Error("COACH_HISTORICAL_APPROVED_FORBIDDEN");
    if (decisionValue !== "BLOCKED" && decisionValue !== "REWORK_RECOMMENDED")
      throw new Error("COACH_HISTORICAL_DECISION_INVALID");

    // 2. Never bypass an active auto plan: that event must use the plan path.
    if (this.activePlans().some((plan) =>
      plan.workspaceId === input.workspaceId &&
      plan.currentOperationId === input.operationId &&
      ACTIVE_PLAN_PHASES.has(plan.phase)))
      throw new Error("COACH_HISTORICAL_ACTIVE_PLAN");

    // 3. Re-read and integrity-check the immutable evidence packet.
    let packet: Record<string, unknown> | undefined;
    try {
      packet = this.events.getEvidenceByEvent(input.workspaceId, input.eventId) as
        Record<string, unknown> | undefined;
    } catch (error) {
      // COACH_EVIDENCE_INTEGRITY_FAILURE must never be downgraded to "not found".
      throw error;
    }
    if (!packet) throw new Error("COACH_HISTORICAL_EVIDENCE_NOT_FOUND");

    // 4. Exact identity triple + evidence SHA must match the frozen event.
    if (packet.operationId !== input.operationId) throw new Error("COACH_HISTORICAL_IDENTITY_MISMATCH");
    if (!SHA.test(input.evidenceSha256) || packet.evidenceSha256 !== input.evidenceSha256)
      throw new Error("COACH_HISTORICAL_EVIDENCE_MISMATCH");
    const frozen = packet.finalFingerprint;
    if (typeof frozen !== "string" || !SHA.test(frozen))
      throw new Error("COACH_HISTORICAL_FROZEN_FINGERPRINT_MISSING");

    // 5. A normal review already exists -> archival must not shadow it.
    if (this.events.getReview(input.workspaceId, input.operationId))
      throw new Error("COACH_HISTORICAL_ALREADY_REVIEWED");

    // 6. Idempotent/conflict replay is decided from archival inputs only, before
    //    touching the workspace again. The current fingerprint is a snapshot,
    //    not part of the request identity.
    const existing = this.events.getHistoricalReview(input.workspaceId, input.eventId);
    if (existing) {
      const identical = existing.operation_id === input.operationId &&
        existing.decision === input.decision && existing.reason === input.reason &&
        existing.evidence_sha256 === input.evidenceSha256 &&
        existing.frozen_fingerprint === frozen &&
        existing.source === (input.source ?? HISTORICAL_REVIEW_SOURCE);
      if (!identical) throw new Error("COACH_HISTORICAL_REVIEW_CONFLICT");
      return { receipt: existing, idempotent: true };
    }

    // 7. Capture the current fingerprint. Oversized workspaces (the event-219
    //    failure class) fall back to the bounded git coarse algorithm; any other
    //    capture failure is fail-closed.
    let current: HistoricalFingerprint;
    let algorithm = FULL_FINGERPRINT_ALGORITHM;
    try {
      current = await this.fingerprint(input.workspaceRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CODEX_SNAPSHOT_TOO_MANY_FILES|CODEX_SNAPSHOT_TOO_LARGE/.test(message)) {
        const wrapped = new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
      }
      try { current = this.coarseFingerprint(input.workspaceRoot); }
      catch (coarseError) {
        const wrapped = new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
        (wrapped as Error & { cause?: unknown }).cause = coarseError;
        throw wrapped;
      }
      algorithm = COARSE_FINGERPRINT_ALGORITHM;
    }
    if (!current || typeof current.sha !== "string" || !SHA.test(current.sha))
      throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");

    // 8. Same full fingerprint means normal review is required (never bypass it).
    //    Coarse digests are not comparable to the frozen full snapshot.
    if (algorithm === FULL_FINGERPRINT_ALGORITHM && current.sha === frozen)
      throw new Error("COACH_HISTORICAL_REVIEW_NOT_REQUIRED");

    // 9. Persist the archival journal entry only (idempotent / conflict-safe).
    const { receipt, created } = this.events.recordHistoricalReview({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      eventId: input.eventId,
      decision: input.decision,
      reason: input.reason,
      evidenceSha256: input.evidenceSha256,
      frozenFingerprint: frozen,
      currentFingerprint: current.sha,
      currentFingerprintAlgorithm: algorithm,
      drift: 1,
      source: input.source ?? HISTORICAL_REVIEW_SOURCE,
    });
    return { receipt, idempotent: !created };
  }
}
