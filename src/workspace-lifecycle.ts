/**
 * Workspace session lifecycle vocabulary and cleanup verdicts.
 *
 * The lifecycle state answers exactly one question: *is DevSpace currently
 * holding this workspace open for someone?* It is deliberately not derived from
 * `lastUsedAt`. A workspace touched an hour ago by a finished request is `idle`,
 * not `active`; a workspace whose state cannot be established is `unknown` and
 * every mutating decision must fail closed on it.
 */

export const WORKSPACE_LIFECYCLE_STATES = [
  /**
   * At least one in-flight DevSpace operation is holding this workspace right
   * now. Only a real acquire/release lease produces this — never a cache hit.
   */
  "active",
  /** Known to DevSpace, no in-flight operation, no running work. Safe to close. */
  "idle",
  /** A close is in progress; further closes are refused until it settles. */
  "closing",
  /** Closed on purpose. The record survives so history and metadata are kept. */
  "closed",
  /** The record exists but its directory or Git identity is no longer credible. */
  "stale",
  /** Cannot be established. Treated as unsafe everywhere. */
  "unknown",
] as const;

export type WorkspaceLifecycleState = (typeof WORKSPACE_LIFECYCLE_STATES)[number];

const LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(
  WORKSPACE_LIFECYCLE_STATES,
);

export function isWorkspaceLifecycleState(
  value: unknown,
): value is WorkspaceLifecycleState {
  return typeof value === "string" && LIFECYCLE_STATE_SET.has(value);
}

export function normalizeWorkspaceLifecycleState(
  value: unknown,
): WorkspaceLifecycleState {
  return isWorkspaceLifecycleState(value) ? value : "unknown";
}

/**
 * Single cleanup verdict per workspace.
 *
 * Exactly one of these is reported so an operator never has to reconcile
 * several booleans. `SAFE_CANDIDATE` is a *candidate*: it still requires an
 * explicit, SHA-pinned call to `reclaim_workspace`, which re-verifies
 * everything from scratch.
 */
export const WORKSPACE_CLEANUP_VERDICTS = [
  "SAFE_CANDIDATE",
  "BLOCKED_ACTIVE",
  "BLOCKED_DIRTY",
  "BLOCKED_UNMERGED",
  "BLOCKED_PROTECTED",
  "BLOCKED_NOT_MANAGED",
  "BLOCKED_MISSING",
  "UNKNOWN",
] as const;

export type WorkspaceCleanupVerdict =
  (typeof WORKSPACE_CLEANUP_VERDICTS)[number];

/**
 * Whether a local branch is eligible for `git_delete_merged_branch`.
 *
 * `PROTECTED` is a policy refusal (main/master/default/release branches and
 * branches still under development). `NOT_AN_ANCESTOR` means the branch holds
 * commits that are not in the confirmed mainline, which must never be deleted
 * automatically even when a remote copy exists.
 */
export const BRANCH_DELETE_VERDICTS = [
  "DELETABLE_MERGED",
  "PROTECTED",
  "NOT_AN_ANCESTOR",
  "CHECKED_OUT",
  "ACTIVE_DEPENDENCY",
  "MISSING",
  "UNKNOWN",
] as const;

export type BranchDeleteVerdict = (typeof BRANCH_DELETE_VERDICTS)[number];
