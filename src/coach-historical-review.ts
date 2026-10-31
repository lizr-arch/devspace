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
  private readonly activePlans: () => HistoricalPlanView[];

  constructor(options: CoachHistoricalReviewOptions) {
    this.events = options.events;
    this.fingerprint = options.fingerprint ?? captureCodexFingerprint;
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

    // 6. Capture the current fingerprint; refuse to guess when unavailable.
    let current: HistoricalFingerprint;
    try {
      current = await this.fingerprint(input.workspaceRoot);
    } catch (error) {
      const wrapped = new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
    if (!current || typeof current.sha !== "string" || !SHA.test(current.sha))
      throw new Error("COACH_HISTORICAL_FINGERPRINT_UNAVAILABLE");

    // 7. Same fingerprint means normal review is required (never bypass it).
    if (current.sha === frozen) throw new Error("COACH_HISTORICAL_REVIEW_NOT_REQUIRED");

    // 8. Persist the archival journal entry only (idempotent / conflict-safe).
    const { receipt, created } = this.events.recordHistoricalReview({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      eventId: input.eventId,
      decision: input.decision,
      reason: input.reason,
      evidenceSha256: input.evidenceSha256,
      frozenFingerprint: frozen,
      currentFingerprint: current.sha,
      drift: 1,
      source: input.source ?? HISTORICAL_REVIEW_SOURCE,
    });
    return { receipt, idempotent: !created };
  }
}
