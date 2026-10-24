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
 *  - ONLY a REPLY_VERIFIED receipt with a real turnId, non-empty reply text and
 *    matching replySha256 publishes an event (P1-06). A COMPLETED receipt without
 *    a verified reply stays PENDING/turn-observed and can publish later when the
 *    reply arrives; a queue ACCEPTED row or unfinished turn never publishes.
 *  - The event id is deterministic: app:<sha256(workspaceId\\0operationId)>; it must
 *    match CoachReviewEventStore exactly (which hashes the two-character escape).
 *  - Repeated publication is idempotent (INSERT OR IGNORE + identity check in
 *    CoachReviewEventStore); mismatched identities throw and stop.
 *  - Unknown/UNCERTAIN states are journaled but never promoted to an event.
 */
import { createHash } from "node:crypto";
import type { AppTurnRecord, AppTurnState, CoachReviewEventStore } from "./coach-review-events.js";
import {
  TASK_SHA256,
  sha256Hex,
  type NativeOutboundReceipt,
  type NativeOutboundState,
  type NativeOutboundTaskReference,
} from "./coach-native-outbound-types.js";

export const NATIVE_EVENT_PREFIX = "app:";

export type { NativeOutboundTaskReference } from "./coach-native-outbound-types.js";
export { nativeJournalTaskFields } from "./coach-native-outbound-types.js";

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
    default:
      // PRESEND / ACCEPTED / TURN_OBSERVED / COMPLETED are not publishable states.
      return "PENDING";
  }
}

/**
 * Publish a verified native receipt into the durable review-event store.
 *
 * P1-06: exactly ONE state may publish a READY_FOR_GPT_REVIEW event —
 * REPLY_VERIFIED with a real turnId, non-empty reply and replySha256 equal to
 * sha256(reply). COMPLETED-without-reply is journaled as PENDING (with the
 * observed turnId) and can be published later once the reply arrives.
 * UNCERTAIN / BLOCKED update the journal only; non-terminal states are no-ops.
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
  const state = receipt.state;

  if (state === "REPLY_VERIFIED") {
    if (typeof receipt.turnId !== "string" || !receipt.turnId)
      throw new Error("CODEX_APP_TURN_ID_REQUIRED");
    if (typeof receipt.reply !== "string" || !receipt.reply.trim())
      throw new Error("NATIVE_REPLY_REQUIRED");
    if (typeof receipt.replySha256 !== "string" || !TASK_SHA256.test(receipt.replySha256))
      throw new Error("NATIVE_REPLY_SHA_REQUIRED");
    if (receipt.replySha256 !== sha256Hex(receipt.reply))
      throw new Error("NATIVE_REPLY_SHA_MISMATCH");
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

  if (state === "COMPLETED") {
    if (typeof receipt.turnId !== "string" || !receipt.turnId)
      throw new Error("CODEX_APP_TURN_ID_REQUIRED");
    // Reply not verified: keep PENDING (turn-observed) so a later
    // REPLY_VERIFIED can publish monotonically. Never create a READY event.
    const updated = journal.updateAppTurn({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      state: "PENDING",
      turnId: receipt.turnId,
    });
    return {
      state: updated.state,
      published: false,
      turnId: receipt.turnId,
      reason: "NATIVE_REPLY_NOT_VERIFIED",
    };
  }

  const journalState = mapReceiptState(state);
  const updated = journal.updateAppTurn({
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    state: journalState,
    ...(typeof receipt.turnId === "string" && receipt.turnId ? { turnId: receipt.turnId } : {}),
  });
  return {
    state: journalState,
    published: false,
    ...(updated.turn_id ? { turnId: updated.turn_id } : {}),
    reason:
      journalState === "UNCERTAIN"
        ? (receipt.uncertaintyReason ?? "NATIVE_OUTBOUND_UNCERTAIN")
        : journalState === "FAILED"
          ? (receipt.error ?? "NATIVE_OUTBOUND_BLOCKED")
          : undefined,
  };
}

export type NativeContinuityReason =
  | "MATCH"
  | "NO_JOURNAL"
  | "TASK_MISMATCH"
  | "TASK_REFERENCE_INVALID";

export interface NativeTaskContinuity {
  taskId: string;
  taskSha256: string;
  matches: boolean;
  reason: NativeContinuityReason;
}

/**
 * P0-02: validate exact frozen-TASK continuity for an operation journal row.
 * `native_rework` must use this before queueing: same taskId + same sha256;
 * a missing task means the explicit read-only/read-only scenario.
 */
export function describeNativeTaskContinuity(
  journal: NativeEventJournal,
  workspaceId: string,
  operationId: string,
  task?: NativeOutboundTaskReference,
): NativeTaskContinuity {
  if (task) {
    const valid =
      typeof task.taskId === "string" &&
      task.taskId.length > 0 &&
      TASK_SHA256.test(task.sha256 ?? "");
    if (!valid) {
      return {
        taskId: typeof task.taskId === "string" ? task.taskId : "",
        taskSha256: typeof task.sha256 === "string" ? task.sha256 : "",
        matches: false,
        reason: "TASK_REFERENCE_INVALID",
      };
    }
  }
  const prior = journal.getAppTurn(workspaceId, operationId);
  if (!prior) {
    return {
      taskId: task?.taskId ?? "read-only",
      taskSha256: task?.sha256 ?? sha256Hex("read-only"),
      matches: false,
      reason: "NO_JOURNAL",
    };
  }
  if (!task) {
    const readOnly = prior.task_id === "read-only" && prior.task_sha256 === sha256Hex("read-only");
    return {
      taskId: prior.task_id,
      taskSha256: prior.task_sha256,
      matches: readOnly,
      reason: readOnly ? "MATCH" : "TASK_MISMATCH",
    };
  }
  const matches = prior.task_id === task.taskId && prior.task_sha256 === task.sha256;
  return {
    taskId: prior.task_id,
    taskSha256: prior.task_sha256,
    matches,
    reason: matches ? "MATCH" : "TASK_MISMATCH",
  };
}

/** Fail-closed variant for native_rework wiring (wrong task id/sha must fail). */
export function assertNativeTaskContinuity(
  journal: NativeEventJournal,
  workspaceId: string,
  operationId: string,
  task?: NativeOutboundTaskReference,
): NativeTaskContinuity {
  const continuity = describeNativeTaskContinuity(journal, workspaceId, operationId, task);
  if (!continuity.matches) throw new Error("CODEX_APP_REWORK_TASK_MISMATCH");
  return continuity;
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
