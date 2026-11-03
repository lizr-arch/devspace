/**
 * Tool-facing orchestration for `reclaim_workspace`.
 *
 * Why this is a separate module: the destructive step and the response are two
 * different responsibilities, and the production bug was exactly their
 * interleaving — the handler observed Project Memory *after* the reclaim had
 * already deleted the workspace record, so a successful removal was reported as
 * `WORKSPACE_NOT_FOUND`.
 *
 * Rules encoded here (and covered by workspace-lifecycle-cleanup.test.ts):
 *   1. The record is read before anything happens; a missing record is a
 *      no-mutation answer, not a reason to delete something again.
 *   2. Project Memory is observed BEFORE the mutation. It is a SHADOW record:
 *      its failure is reported, never allowed to change the decision, and never
 *      re-read after the record is gone.
 *   3. The success text and structured result are built only from the value the
 *      reclaim returned — never from a second lookup of a deleted record.
 *   4. Every attempt ends in exactly one of three states, so a caller can tell
 *      "it happened", "nothing happened" and "I cannot tell" apart.
 */
import { formatErrorRemedy } from "./errors.js";
import type { ProjectMemoryAccessObservation } from "./project-memory.js";
import type {
  WorkspaceReclaimOutcome,
  WorktreeRemovalVerification,
} from "./workspaces.js";

/** Project Memory observation that could not be recorded. Never blocks. */
export interface ProjectMemoryObservationFailure {
  mode: "SHADOW";
  outcome: "observation_failed";
  wouldDeny: false;
  error: string;
}

export interface ReclaimToolInput {
  workspaceId: string;
  expectedHeadSha: string;
  confirmWorkspaceId: string;
  projectMemoryReceiptId?: string;
}

/**
 * The slice of the registry this orchestration needs. Keeping it explicit makes
 * the sequencing testable without starting an MCP server.
 */
export interface ReclaimToolWorkspaces {
  storedSession(workspaceId: string): { id: string } | undefined;
  observeProjectMemoryAccess(
    workspaceId: string,
    toolName: string,
    receiptId: string | undefined,
  ): ProjectMemoryAccessObservation;
  reclaimWorkspace(input: {
    workspaceId: string;
    expectedHeadSha: string;
    confirmation: string;
    activeJobIdsForRoot?: (workspaceRoot: string) => string[];
    activeGameSessionIds?: (workspaceId: string, root: string) => string[];
    activeTaskSessionIds?: (workspaceId: string, root: string) => string[];
    othersHolding?: () => number;
  }): Promise<{
    workspaceId: string;
    root: string;
    removed: true;
    branch: string | null;
    headSha: string;
    storeRecordRemoved: boolean;
    lifecycleState: string;
    outcome: "CONFIRMED_SUCCESS";
    verification: WorktreeRemovalVerification;
  }>;
  withExclusiveLease<T>(
    workspaceId: string,
    operation: (workspace: { id: string }, others: () => number) => Promise<T> | T,
  ): Promise<T>;
}

export interface ReclaimToolDeps {
  workspaces: ReclaimToolWorkspaces;
  activeJobIdsForRoot: (workspaceRoot: string) => string[];
  activeGameSessionIds: (workspaceId: string) => string[];
  activeTaskSessionIds: (workspaceId: string) => string[];
}

export interface ReclaimToolResult {
  outcome: WorkspaceReclaimOutcome;
  text: string;
  isError: boolean;
  reclaimed?: {
    workspaceId: string;
    root: string;
    removed: true;
    branch: string | null;
    headSha: string;
    storeRecordRemoved: boolean;
    lifecycleState: string;
  };
  verification?: WorktreeRemovalVerification;
  projectMemory?: ProjectMemoryAccessObservation | ProjectMemoryObservationFailure;
  error?: ReturnType<typeof formatErrorRemedy>["errorPayload"];
}

/** A refusal that provably removed nothing. */
function noMutation(
  message: string,
  projectMemory?: ReclaimToolResult["projectMemory"],
  error?: ReclaimToolResult["error"],
): ReclaimToolResult {
  return {
    outcome: "CONFIRMED_NO_MUTATION",
    isError: true,
    text: `${message}\nOutcome: CONFIRMED_NO_MUTATION. No worktree, branch or workspace record was removed by this call.`,
    ...(projectMemory ? { projectMemory } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Every refusal that `reclaimWorkspace` raises strictly before it touches the
 * filesystem. This is an allowlist on purpose: an error that is not on it is
 * treated as `OUTCOME_UNKNOWN`, because an unrecognised failure may have
 * happened after the worktree was already removed.
 */
const PRE_MUTATION_REFUSALS = [
  "WORKSPACE_RECLAIM_CONFIRMATION_REQUIRED",
  "WORKSPACE_RECLAIM_RECORD_MISSING",
  "WORKSPACE_RECLAIM_NO_RECORD",
  "WORKSPACE_RECLAIM_ACTIVE",
  "WORKSPACE_RECLAIM_NOT_MANAGED_WORKTREE",
  "WORKSPACE_RECLAIM_SESSION_NOT_CLOSED",
  "WORKSPACE_RECLAIM_STALE_RECORD",
  "WORKSPACE_RECLAIM_OUTSIDE_WORKTREE_ROOT",
  "WORKSPACE_RECLAIM_UNSAFE",
  "WORKSPACE_RECLAIM_HEAD_MISMATCH",
  // Only raised when the failed removal was checked and the worktree is
  // provably still present and still registered.
  "WORKSPACE_RECLAIM_FAILED",
] as const;

function isPreMutationRefusal(message: string): boolean {
  return PRE_MUTATION_REFUSALS.some((prefix) =>
    message.startsWith(`${prefix}:`),
  );
}

/** An attempt whose effect on disk cannot be proven either way. */
function unknownOutcome(
  message: string,
  projectMemory?: ReclaimToolResult["projectMemory"],
  error?: ReclaimToolResult["error"],
): ReclaimToolResult {
  return {
    outcome: "OUTCOME_UNKNOWN",
    isError: true,
    text: `${message}\nOutcome: OUTCOME_UNKNOWN. The reclaim ended in a failure that does not prove the worktree is still present. Verify read-only (directory presence, \`git worktree list\`, list_workspaces) before any further action; do not retry blindly.`,
    ...(projectMemory ? { projectMemory } : {}),
    // The outcome, not the message, is what a client must branch on. Give it a
    // stable code so the three states are distinguishable without parsing text.
    error: {
      code: "WORKSPACE_RECLAIM_OUTCOME_UNKNOWN",
      layer: "tool",
      message,
      retryable: false,
      safeToRetry: false,
      recoveryHint:
        "The reclaim may or may not have completed. Verify read-only first: check the worktree directory, `git worktree list`, and list_workspaces(audit=true). Do not retry blindly.",
      nextRecommendedTools: ["list_workspaces", "git_status"],
      ...(error?.details ? { details: error.details } : {}),
    },
  };
}

/**
 * Run one reclaim attempt and describe it honestly.
 *
 * Never throws: the caller (an MCP tool handler) needs a structured answer even
 * when the operation refused, and the three outcomes must survive the transport.
 */
export async function reclaimWorkspaceViaTool(
  deps: ReclaimToolDeps,
  input: ReclaimToolInput,
): Promise<ReclaimToolResult> {
  if (input.confirmWorkspaceId !== input.workspaceId) {
    return noMutation(
      `WORKSPACE_RECLAIM_CONFIRMATION_REQUIRED: confirmWorkspaceId must exactly equal the workspaceId being reclaimed.`,
    );
  }

  // 1. Read the record before touching anything. Reclaim deletes this record on
  //    success, so a missing record is the normal shape of a duplicate call.
  if (!deps.workspaces.storedSession(input.workspaceId)) {
    return noMutation(
      `WORKSPACE_RECLAIM_RECORD_MISSING: No persisted workspace record exists for ${input.workspaceId}. A successful reclaim deletes that record, so this normally means it was already reclaimed (or the id never existed). Nothing was removed by this call. Confirm with list_workspaces(audit=true) and the Git worktree list before doing anything else.`,
    );
  }

  // 2. Observe Project Memory while the record still exists. This is a SHADOW
  //    observation: it holds no lease and cannot change the safety decision.
  let projectMemory: ReclaimToolResult["projectMemory"];
  try {
    projectMemory = deps.workspaces.observeProjectMemoryAccess(
      input.workspaceId,
      "reclaim_workspace",
      input.projectMemoryReceiptId,
    );
  } catch (error) {
    projectMemory = {
      mode: "SHADOW",
      outcome: "observation_failed",
      wouldDeny: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 3. The destructive step, unchanged: same lease, same guards, same
  //    non-forced `git worktree remove` inside reclaimWorkspace.
  try {
    const reclaimed = await deps.workspaces.withExclusiveLease(
      input.workspaceId,
      (workspace, others) =>
        deps.workspaces.reclaimWorkspace({
          workspaceId: workspace.id,
          expectedHeadSha: input.expectedHeadSha,
          confirmation: input.confirmWorkspaceId,
          activeJobIdsForRoot: deps.activeJobIdsForRoot,
          activeGameSessionIds: deps.activeGameSessionIds,
          activeTaskSessionIds: deps.activeTaskSessionIds,
          othersHolding: others,
        }),
    );

    const verification = reclaimed.verification;
    const branchLine = reclaimed.branch
      ? verification.branchPreserved === true
        ? `branch ${reclaimed.branch} preserved at ${verification.branchSha ?? reclaimed.headSha}`
        : verification.branchPreserved === false
          ? `WARNING: branch ${reclaimed.branch} ${
              verification.branchSha === null
                ? "no longer exists"
                : `is now at ${verification.branchSha}`
            } (expected ${reclaimed.headSha})`
          : `branch ${reclaimed.branch} could not be re-read after removal (no branch was touched by this call)`
      : "detached HEAD; no local branch to check";
    const text = [
      `Reclaimed ${reclaimed.workspaceId} at ${reclaimed.root} (HEAD ${reclaimed.headSha}).`,
      "Outcome: CONFIRMED_SUCCESS.",
      `Verified: directory removed; Git no longer registers this path as a worktree; ${branchLine}.`,
      reclaimed.storeRecordRemoved
        ? "Store record removed: true."
        : "WARNING: the worktree was removed, but the workspace record could not be deleted. It will appear as BLOCKED_MISSING in list_workspaces(audit=true) and needs reconciliation.",
      "Nothing else was touched: no branch, commit, remote or other worktree.",
    ].join("\n");

    return {
      outcome: "CONFIRMED_SUCCESS",
      isError: false,
      text,
      reclaimed: {
        workspaceId: reclaimed.workspaceId,
        root: reclaimed.root,
        removed: true,
        branch: reclaimed.branch,
        headSha: reclaimed.headSha,
        storeRecordRemoved: reclaimed.storeRecordRemoved,
        lifecycleState: reclaimed.lifecycleState,
      },
      verification,
      ...(projectMemory ? { projectMemory } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // The record can disappear between the check above and the lease. That is
    // still "nothing was removed by this call", and it must not look like a
    // failed deletion.
    if (
      /^Unknown workspaceId/.test(message) ||
      message.startsWith("WORKSPACE_RECLAIM_RECORD_MISSING:")
    ) {
      return noMutation(
        `WORKSPACE_RECLAIM_RECORD_MISSING: The record for ${input.workspaceId} disappeared before the reclaim started. Nothing was removed by this call.`,
        projectMemory,
      );
    }

    const { message: remedy, errorPayload } = formatErrorRemedy(error);
    if (message.startsWith("WORKSPACE_RECLAIM_OUTCOME_UNKNOWN:")) {
      return unknownOutcome(remedy, projectMemory, errorPayload);
    }
    // Fail closed: only a refusal that is proven to happen before the
    // destructive step may be called a no-mutation. Anything else — including a
    // failure raised after `git worktree remove` succeeded, such as a store
    // write error — is reported as unknown, never as "nothing happened".
    if (isPreMutationRefusal(message)) {
      return noMutation(remedy, projectMemory, errorPayload);
    }
    return unknownOutcome(remedy, projectMemory, errorPayload);
  }
}
