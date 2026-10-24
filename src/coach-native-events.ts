/**
 * M2 bridge: publish a verified NativeCodexOutbound delivery into the durable
 * Coach review-event store.
 *
 * Separation of planes (ROLE-005):
 *  - DSH owns code/protocol correctness only; it never sends a native Codex
 *    turn and never reviews one.
 *  - Web GPT calls the MCP tools directly; the tools call this module so the
 *    exact (workspaceId, operationId, threadId, turnId, evidence sha) lands in
 *    `codex_app_review_events`. The already-bound Chrome exact conversation
 *    polls the Coach feed `/events`, which merges those app rows into the
 *    `CODEX_APP_READY_FOR_GPT_REVIEW` event stream. No mailbox or DSH bridge
 *    is involved in that return path.
 *
 * Invariants:
 *  - Only COMPLETED / REPLY_VERIFIED receipts with a real turnId publish an
 *    event; a queue ACCEPTED row or an observed-but-unfinished turn does not.
 *  - The event id is deterministic: app:<sha256(workspaceId\\0operationId)>; it must
 *    match CoachReviewEventStore exactly (which hashes the two-character escape).
 *  - Repeated publication is idempotent (INSERT OR IGNORE + identity check in
 *    CoachReviewEventStore); mismatched identities throw and stop.
 *  - Unknown/UNCERTAIN states are journaled but never promoted to an event.
 */
import { createHash } from "node:crypto";
import type { AppTurnRecord, AppTurnState, CoachReviewEventStore } from "./coach-review-events.js";
import type { NativeOutboundReceipt, NativeOutboundState } from "./coach-native-outbound-types.js";

export const NATIVE_EVENT_PREFIX = "app:";

/** Minimal event-store surface this module needs (real store or a fake in tests). */
export interface NativeEventJournal {
  registerAppTurn(input: {
    workspaceId: string;
    operationId: string;
    workspaceRoot: string;
    threadId: string;
    requestSha256: string;
    taskId: string;
    taskSha256: string;
  }): AppTurnRecord;
  updateAppTurn(input: { workspaceId: string; operationId: string; state: AppTurnState; turnId?: string }): AppTurnRecord;
  getAppTurn(workspaceId: string, operationId: string): AppTurnRecord | undefined;
}

export interface BeginNativeJournalInput {
  workspaceId: string;
  operationId: string;
  workspaceRoot: string;
  threadId: string;
  promptSha256: string;
  taskId: string;
  taskSha256: string;
}

export interface PublishNativeReceiptInput {
  workspaceId: string;
  operationId: string;
  receipt: Pick<NativeOutboundReceipt, "state" | "threadId" | "turnId" | "reply" | "replySha256" | "payloadSha256" | "uncertaintyReason" | "error">;
}

export interface PublishNativeReceiptResult {
  state: AppTurnState;
  published: boolean;
  eventId?: string;
  turnId?: string;
  reason?: string;
}

/** Deterministic native review event id (must match CoachReviewEventStore). */
export function nativeReviewEventId(workspaceId: string, operationId: string): string {
  return NATIVE_EVENT_PREFIX + createHash("sha256").update(workspaceId + "\\0" + operationId).digest("hex");
}

/** Deterministic evidence sha for the durable event (same formula as the store). */
export function nativeReviewEvidenceSha(input: {
  workspaceId: string;
  operationId: string;
  threadId: string;
  turnId: string;
  requestSha256: string;
  taskId: string;
  taskSha256: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        threadId: input.threadId,
        turnId: input.turnId,
        requestSha256: input.requestSha256,
        taskId: input.taskId,
        taskSha256: input.taskSha256,
      }),
    )
    .digest("hex");
}

/**
 * Journal the operation before the outbound attempt so a crash leaves a
 * recoverable PENDING row keyed by the same operationId as the native ledger.
 */
export function beginNativeJournal(journal: NativeEventJournal, input: BeginNativeJournalInput): AppTurnRecord {
  return journal.registerAppTurn({
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    workspaceRoot: input.workspaceRoot,
    threadId: input.threadId,
    requestSha256: input.promptSha256,
    taskId: input.taskId,
    taskSha256: input.taskSha256,
  });
}

function mapReceiptState(state: NativeOutboundState): AppTurnState {
  switch (state) {
    case "UNCERTAIN":
      return "UNCERTAIN";
    case "BLOCKED":
      return "FAILED";
    case "COMPLETED":
    case "REPLY_VERIFIED":
      return "COMPLETED";
    default:
      // PRESEND / ACCEPTED / TURN_OBSERVED are not terminal and must not publish.
      return "PENDING";
  }
}

/**
 * Publish a terminal native receipt into the durable review-event store.
 *
 * COMPLETED and REPLY_VERIFIED require a real turnId; otherwise this throws so
 * an unfinished turn can never masquerade as READY_FOR_GPT_REVIEW. UNCERTAIN /
 * BLOCKED update the journal only. Non-terminal states return published:false.
 */
export function publishNativeReceipt(
  journal: NativeEventJournal,
  input: PublishNativeReceiptInput,
): PublishNativeReceiptResult {
  const receipt = input.receipt;
  if (receipt.threadId !== undefined && typeof receipt.threadId !== "string")
    throw new Error("CODEX_APP_JOURNAL_INVALID");
  const prior = journal.getAppTurn(input.workspaceId, input.operationId);
  if (!prior) throw new Error("CODEX_APP_OPERATION_NOT_FOUND");
  const state = mapReceiptState(receipt.state);
  if (state === "COMPLETED") {
    if (typeof receipt.turnId !== "string" || !receipt.turnId)
      throw new Error("CODEX_APP_TURN_ID_REQUIRED");
    const updated = journal.updateAppTurn({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      state: "COMPLETED",
      turnId: receipt.turnId,
    });
    const eventId = nativeReviewEventId(input.workspaceId, input.operationId);
    if (updated.event_id !== eventId)
      throw new Error("CODEX_APP_EVENT_IDENTITY_CONFLICT");
    return { state: "COMPLETED", published: true, eventId, turnId: receipt.turnId };
  }
  const updated = journal.updateAppTurn({
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    state,
    ...(typeof receipt.turnId === "string" && receipt.turnId ? { turnId: receipt.turnId } : {}),
  });
  return {
    state,
    published: false,
    ...(updated.turn_id ? { turnId: updated.turn_id } : {}),
    reason:
      state === "UNCERTAIN"
        ? (receipt.uncertaintyReason ?? "NATIVE_OUTBOUND_UNCERTAIN")
        : state === "FAILED"
          ? (receipt.error ?? "NATIVE_OUTBOUND_BLOCKED")
          : undefined,
  };
}

/**
 * Read the exact pending event the sidecar / bound Chrome conversation would
 * receive. Used by the receipt MCP tool so Web GPT can fetch the event id and
 * evidence sha it must review, without any DSH intermediary.
 */
export function readNativeReviewEvent(
  store: Pick<CoachReviewEventStore, "listPendingAppEvents">,
  workspaceId: string,
  operationId: string,
): { eventId: string; threadId: string; turnId: string; evidenceSha256: string } | undefined {
  const expected = nativeReviewEventId(workspaceId, operationId);
  const events = store.listPendingAppEvents(workspaceId, 50);
  const found = events.find((event) => event.event_id === expected);
  return found
    ? {
        eventId: found.event_id,
        threadId: found.thread_id,
        turnId: found.turn_id,
        evidenceSha256: found.evidence_sha256,
      }
    : undefined;
}
