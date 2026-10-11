/**
 * Workspace / Git worktree lifecycle audit.
 *
 * The workspace store accumulates a row per opened session; its legacy `status`
 * column was written `"active"` at creation and never updated, so 100% of rows
 * claimed to be active regardless of reality. This module derives the real
 * state from the filesystem, Git and live runtime activity instead of trusting
 * that column, and it is deliberately conservative: anything it cannot
 * positively prove clean is reported as a risk, never as a reclamation
 * candidate.
 *
 * Nothing here mutates anything. `reclaimable` is a *candidate* flag that
 * requires an explicit caller decision plus an independent re-check.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { inspectGitStatus, runGit } from "./git-tools.js";
import {
  normalizeWorkspaceLifecycleState,
  type WorkspaceCleanupVerdict,
  type WorkspaceLifecycleState,
} from "./workspace-lifecycle.js";

export type WorkspaceAuditLifecycle =
  | "active_session"
  | "idle_session"
  | "closed_session"
  | "git_worktree"
  | "checkout"
  | "missing_directory"
  | "not_a_repository"
  | "orphaned_directory";

export interface WorkspaceAuditRisk {
  code:
    | "uncommitted_changes"
    | "untracked_files"
    | "unmerged_commits"
    | "active_job"
    | "active_game_session"
    | "active_task_session"
    | "active_session"
    | "unpushed_branch"
    | "missing_directory"
    | "ambiguous_ownership"
    | "not_a_worktree"
    | "protected_worktree"
    | "stale_session_record"
    | "foreign_process";
  detail: string;
}

export interface WorkspaceSessionActivityForeign {
  pids: number[];
  commands: string[];
  unknown: boolean;
  reason?: string;
}

/**
 * Live runtime activity observed for one workspace.
 *
 * Every field is an observation, not an inference from `lastUsedAt`. An empty
 * value means "nothing observed holding it", which is what makes a workspace
 * closable and reclaimable.
 */
export interface WorkspaceSessionActivity {
  /** The persisted lifecycle state, or null when no record exists. */
  sessionState: WorkspaceLifecycleState | null;
  /** In-flight DevSpace operations holding this workspace right now. */
  liveLeases: number;
  /** Non-terminal background jobs rooted in this workspace. */
  activeJobIds: string[];
  /** Non-terminal game/engine sessions bound to this workspace. */
  activeGameSessionIds: string[];
  /** Non-terminal task sessions bound to this workspace. */
  activeTaskSessionIds: string[];
  /**
   * Read-only observation of processes whose working directory is this
   * worktree. Absent means "not probed", which the audit reports as unknown
   * rather than free.
   */
  foreignProcesses?: WorkspaceSessionActivityForeign;
  /**
   * The workspace record points at a directory that no longer exists, or at a
   * path Git no longer registers. Such a record can never be reclaimed through
   * the filesystem path and is reported separately.
   */
  staleRecord?: boolean;
}

export function emptySessionActivity(): WorkspaceSessionActivity {
  return {
    sessionState: null,
    liveLeases: 0,
    activeJobIds: [],
    activeGameSessionIds: [],
    activeTaskSessionIds: [],
  };
}

/**
 * External occupancy counts as live activity for the purpose of "may DevSpace
 * touch this?". A worktree with a shell in it is not free even though DevSpace
 * itself holds nothing.
 */
export function hasForeignOccupancy(
  activity: WorkspaceSessionActivity,
): boolean {
  const foreign = activity.foreignProcesses;
  if (!foreign) return false;
  return foreign.pids.length > 0 || foreign.unknown;
}

/**
 * True only when something is *actually* using the workspace: an in-flight
 * operation, a running job, a live engine, or a running task.
 *
 * `sessionState === "active"` deliberately does not set this on its own. That
 * state is persisted, and a service that died mid-request would leave it behind
 * forever. It is reported as a risk by the audit (so callers fail closed) but
 * it is not proof of a live owner.
 */
export function hasLiveActivity(activity: WorkspaceSessionActivity): boolean {
  return (
    activity.liveLeases > 0 ||
    activity.activeJobIds.length > 0 ||
    activity.activeGameSessionIds.length > 0 ||
    activity.activeTaskSessionIds.length > 0
  );
}

/**
 * Everything that makes a workspace unsafe to touch: DevSpace's own work plus
 * work the operator started outside DevSpace.
 */
export function hasAnyOccupancy(activity: WorkspaceSessionActivity): boolean {
  return hasLiveActivity(activity) || hasForeignOccupancy(activity);
}

export interface WorkspaceAudit {
  workspaceId: string | null;
  root: string;
  lifecycle: WorkspaceAuditLifecycle;
  mode: "checkout" | "worktree";
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  managed: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** Directory exists and is a usable workspace. */
  resumable: boolean;
  /** Modified tracked files count. */
  dirtyFileCount: number;
  untrackedFileCount: number;
  /** Commits on this branch that are not on the upstream/mainline. */
  unmergedCommitCount: number;
  /** Ids of non-terminal jobs whose working directory is inside this root. */
  activeJobIds: string[];
  /** Non-terminal game/engine sessions bound to this workspace. */
  activeGameSessionIds: string[];
  /** Non-terminal task sessions bound to this workspace. */
  activeTaskSessionIds: string[];
  /**
   * Read-only observation of processes whose working directory is this
   * worktree. Absent means "not probed", which the audit reports as unknown
   * rather than free.
   */
  foreignProcesses?: WorkspaceSessionActivityForeign;
  /** Persisted lifecycle state of the workspace record, when one exists. */
  sessionState: WorkspaceLifecycleState | null;
  /** In-flight DevSpace operations holding this workspace. */
  liveLeases: number;
  /** True only when something is really using this workspace. */
  hasActiveSession: boolean;
  /** The record exists but its directory/registration is gone. */
  staleRecord: boolean;
  risks: WorkspaceAuditRisk[];
  /** Single, unambiguous cleanup classification. */
  verdict: WorkspaceCleanupVerdict;
  /**
   * Only ever true when every precondition passes. A candidate still requires
   * an explicit confirmation and is re-verified at reclamation time.
   */
  reclaimable: boolean;
  /** Why reclamation is refused, when it is. */
  blockedReasons: string[];
}

export interface WorktreeDirectoryScan {
  worktreeRoot: string;
  directories: string[];
  /** Directories on disk that no workspace record mentions. */
  orphaned: string[];
}

/**
 * Inspect one workspace record. Never throws for a damaged workspace: an
 * unreadable directory becomes a risk, because a caller must not be told a
 * workspace is clean when the truth is unknown.
 */
export async function auditWorkspace(input: {
  workspaceId: string | null;
  root: string;
  mode: "checkout" | "worktree";
  managed: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  activity?: WorkspaceSessionActivity;
  /**
   * Legacy inputs kept for callers that only know "a session exists". They are
   * folded into `activity`; `hasActiveSession: true` means a live owner and
   * blocks the workspace, while mere existence of a record does not.
   */
  hasActiveSession?: boolean;
  activeJobIds?: string[];
  /**
   * Precomputed `git worktree list` result for the owning repository. Passing
   * it avoids re-running Git once per directory when auditing a whole worktree
   * root.
   */
  registeredWorktrees?: Set<string>;
  /**
   * Basename patterns excluded from reclamation for policy reasons (for
   * example a long-lived terrain tooling chain). An excluded path is reported
   * as BLOCKED_PROTECTED, never as a candidate.
   */
  protectedWorktreePatterns?: readonly string[];
}): Promise<WorkspaceAudit> {
  const risks: WorkspaceAuditRisk[] = [];
  const blockedReasons: string[] = [];
  const activity: WorkspaceSessionActivity = input.activity ?? {
    ...emptySessionActivity(),
    liveLeases: input.hasActiveSession ? 1 : 0,
    activeJobIds: input.activeJobIds ?? [],
  };
  let protectedByPolicy = false;

  let exists = false;
  try {
    exists = lstatSync(input.root).isDirectory();
  } catch {
    exists = false;
  }

  let lifecycle: WorkspaceAuditLifecycle;
  let dirtyFileCount = 0;
  let untrackedFileCount = 0;
  let unmergedCommitCount = 0;
  let branch: string | null = null;
  let detached = false;
  let headSha: string | null = null;
  let registered: boolean | null = null;
  let gitReadable = false;

  if (!exists) {
    lifecycle = "missing_directory";
    risks.push({
      code: "missing_directory",
      detail: "The workspace directory no longer exists on disk.",
    });
    blockedReasons.push("the workspace directory is missing");
  } else {
    try {
      const status = await inspectGitStatus(input.root);
      gitReadable = true;
      dirtyFileCount = new Set([...status.staged, ...status.unstaged]).size;
      untrackedFileCount = status.untracked.length;
      branch = status.branch ?? null;
      detached = !status.branch;
      headSha = status.headSha;
      lifecycle = hasAnyOccupancy(activity)
        ? "active_session"
        : activity.sessionState === "closed"
          ? "closed_session"
          : activity.sessionState
            ? "idle_session"
            : input.mode === "worktree"
              ? "git_worktree"
              : "checkout";

      if (input.mode === "worktree") {
        registered =
          input.registeredWorktrees?.has(canonicalPath(input.root)) ??
          (await isRegisteredWorktree(input.root));
        if (!registered) {
          risks.push({
            code: "not_a_worktree",
            detail:
              "Recorded as a managed worktree but Git no longer registers this path as a worktree.",
          });
          blockedReasons.push("the path is no longer a registered Git worktree");
        }
      }

      if (dirtyFileCount > 0) {
        risks.push({
          code: "uncommitted_changes",
          detail: `${dirtyFileCount} tracked file(s) have uncommitted changes.`,
        });
        blockedReasons.push("there are uncommitted changes");
      }
      if (untrackedFileCount > 0) {
        risks.push({
          code: "untracked_files",
          detail: `${untrackedFileCount} untracked file(s) are present.`,
        });
        blockedReasons.push("there are untracked files");
      }

      unmergedCommitCount = await countUnmergedCommits(input.root, branch);
      if (unmergedCommitCount > 0) {
        risks.push({
          code: "unmerged_commits",
          detail: `${unmergedCommitCount} commit(s) on this branch are not reachable from any mainline ref.`,
        });
        blockedReasons.push("the branch has commits that are not merged");
      }
      if (unmergedCommitCount < 0) {
        risks.push({
          code: "ambiguous_ownership",
          detail:
            "Merge status could not be determined, so the worktree must be treated as holding unmerged work.",
        });
        blockedReasons.push("merge status is unknown");
      }
    } catch (error) {
      lifecycle = "not_a_repository";
      risks.push({
        code: "ambiguous_ownership",
        detail: `Git state could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      blockedReasons.push("Git state could not be read");
    }
  }

  // A record whose directory vanished is stale, not merely missing. Reporting
  // it separately is what stops the audit from offering a reclaim it can never
  // perform.
  const staleRecord = Boolean(input.workspaceId) && (!exists || registered === false);
  if (staleRecord) {
    risks.push({
      code: "stale_session_record",
      detail: exists
        ? "The record claims a managed worktree but Git no longer registers that path."
        : "The record points at a path that no longer exists.",
    });
    blockedReasons.push("the workspace record is stale");
  }

  if (activity.foreignProcesses) {
    const foreign = activity.foreignProcesses;
    if (foreign.pids.length > 0) {
      risks.push({
        code: "foreign_process",
        detail: `Process(es) ${foreign.pids.join(", ")} (${
          foreign.commands.join(", ") || "unknown command"
        }) have this worktree as their working directory.`,
      });
      blockedReasons.push(
        `a process started outside DevSpace is working inside it (pid ${foreign.pids.join(", ")})`,
      );
    } else if (foreign.unknown) {
      risks.push({
        code: "ambiguous_ownership",
        detail: `Occupancy by external processes could not be determined: ${
          foreign.reason ?? "the process probe did not run"
        }.`,
      });
      blockedReasons.push("external process occupancy is unknown");
    }
  }

  if (
    input.protectedWorktreePatterns &&
    input.protectedWorktreePatterns.length > 0 &&
    matchesAnyPattern(basenameOf(input.root), input.protectedWorktreePatterns)
  ) {
    protectedByPolicy = true;
    risks.push({
      code: "protected_worktree",
      detail: `The path matches a protected worktree pattern (${input.protectedWorktreePatterns.join(", ")}) and is never a candidate.`,
    });
    blockedReasons.push("the worktree is protected by cleanup policy");
  }

  if (hasLiveActivity(activity)) {
    const holders = [
      activity.liveLeases > 0
        ? `${activity.liveLeases} in-flight DevSpace operation(s)`
        : undefined,
      activity.activeJobIds.length > 0
        ? `job(s) ${activity.activeJobIds.join(", ")}`
        : undefined,
      activity.activeGameSessionIds.length > 0
        ? `game session(s) ${activity.activeGameSessionIds.join(", ")}`
        : undefined,
      activity.activeTaskSessionIds.length > 0
        ? `task session(s) ${activity.activeTaskSessionIds.join(", ")}`
        : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    risks.push({
      code: "active_session",
      detail: `Currently held by ${holders.join("; ")}.`,
    });
    blockedReasons.push("it is in use right now");
  } else if (activity.sessionState === "active" && input.workspaceId) {
    // Persisted `active` with no live owner is the classic leftover of a
    // service restart or an unclean shutdown. Fail closed: report it so the
    // caller inspects instead of assuming the workspace is free.
    risks.push({
      code: "active_session",
      detail:
        'The persisted lifecycle state is "active" but no live operation, job, game session or task holds this workspace. Re-check before treating it as idle.',
    });
    blockedReasons.push(
      "the persisted session state is active without a live owner",
    );
  }
  if (activity.activeJobIds.length > 0) {
    risks.push({
      code: "active_job",
      detail: `Non-terminal job(s) are running in this workspace: ${activity.activeJobIds.join(", ")}.`,
    });
  }
  if (activity.activeGameSessionIds.length > 0) {
    risks.push({
      code: "active_game_session",
      detail: `Live game session(s) are bound to this workspace: ${activity.activeGameSessionIds.join(", ")}.`,
    });
  }
  if (activity.activeTaskSessionIds.length > 0) {
    risks.push({
      code: "active_task_session",
      detail: `Non-terminal task session(s) are bound to this workspace: ${activity.activeTaskSessionIds.join(", ")}.`,
    });
  }
  if (branch && !detached) {
    const pushed = await isBranchFullyPushed(input.root, branch);
    if (pushed === false) {
      risks.push({
        code: "unpushed_branch",
        detail: `Branch ${branch} has commits that are not on its upstream.`,
      });
      blockedReasons.push("the branch has unpushed commits");
    }
  }

  const verdict = verdictFor({
    risks,
    exists,
    gitReadable,
    mode: input.mode,
    managed: input.managed,
    protectedByPolicy,
    hasLive: hasLiveActivity(activity),
    dirtyFileCount,
    untrackedFileCount,
    unmergedCommitCount,
    // A managed worktree always has a persisted record; these fields are only
    // absent for orphan directories that nothing registered.
    hasRecord: Boolean(input.workspaceId) || input.createdAt !== null,
    sessionState: activity.sessionState,
    hasForeign: hasForeignOccupancy(activity),
  });

  return {
    workspaceId: input.workspaceId,
    root: input.root,
    lifecycle,
    mode: input.mode,
    branch,
    detached,
    headSha,
    managed: input.managed,
    createdAt: input.createdAt,
    lastUsedAt: input.lastUsedAt,
    resumable: exists && gitReadable,
    dirtyFileCount,
    untrackedFileCount,
    unmergedCommitCount: Math.max(0, unmergedCommitCount),
    activeJobIds: activity.activeJobIds,
    activeGameSessionIds: activity.activeGameSessionIds,
    activeTaskSessionIds: activity.activeTaskSessionIds,
    sessionState: activity.sessionState,
    liveLeases: activity.liveLeases,
    hasActiveSession: hasLiveActivity(activity),
    staleRecord,
    risks,
    verdict,
    // Derived from the verdict, never recomputed: if the two could disagree,
    // the audit would once again report a worktree as reclaimable while its
    // own classification said otherwise.
    reclaimable: verdict === "SAFE_CANDIDATE",
    blockedReasons,
  };
}

/**
 * Exactly one verdict. Precedence matters: an active workspace is reported as
 * active even if it is also dirty, because "someone is using this" is the fact
 * an operator must act on first.
 */
function verdictFor(input: {
  risks: WorkspaceAuditRisk[];
  exists: boolean;
  gitReadable: boolean;
  mode: "checkout" | "worktree";
  managed: boolean;
  protectedByPolicy: boolean;
  hasLive: boolean;
  dirtyFileCount: number;
  untrackedFileCount: number;
  unmergedCommitCount: number;
  hasRecord: boolean;
  sessionState: WorkspaceLifecycleState | null;
  hasForeign: boolean;
}): WorkspaceCleanupVerdict {
  // "Nothing is there" outranks "could not read it": a record whose directory
  // is gone can never be reclaimed as a worktree, and saying so is more useful
  // than an open-ended unknown.
  if (!input.exists) return "BLOCKED_MISSING";
  if (input.protectedByPolicy) return "BLOCKED_PROTECTED";
  if (!input.managed || input.mode !== "worktree") return "BLOCKED_NOT_MANAGED";
  if (input.risks.some((risk) => risk.code === "stale_session_record")) {
    return "BLOCKED_MISSING";
  }
  if (!input.gitReadable) return "UNKNOWN";
  if (
    input.hasLive ||
    input.hasForeign ||
    input.risks.some(
      (risk) =>
        risk.code === "active_session" ||
        risk.code === "foreign_process" ||
        risk.code === "ambiguous_ownership",
    )
  ) {
    return "BLOCKED_ACTIVE";
  }
  // A registered session whose state cannot be established is never a
  // candidate. An unregistered directory has no session at all, so this rule
  // does not apply to it, and a caller that supplies no state at all is not
  // asserting one.
  if (
    input.hasRecord &&
    input.sessionState !== null &&
    !isSettledSessionState(input.sessionState)
  ) {
    return "BLOCKED_ACTIVE";
  }
  if (input.risks.some((risk) => risk.code === "ambiguous_ownership")) {
    return "UNKNOWN";
  }
  if (input.unmergedCommitCount !== 0) return "BLOCKED_UNMERGED";
  if (input.dirtyFileCount > 0 || input.untrackedFileCount > 0) {
    return "BLOCKED_DIRTY";
  }
  if (input.risks.length > 0) return "UNKNOWN";
  return "SAFE_CANDIDATE";
}

/** Directories under the managed worktree root, including ones with no record. */
export function scanWorktreeDirectories(
  worktreeRoot: string,
  knownRoots: string[],
): WorktreeDirectoryScan {
  let directories: string[] = [];
  try {
    // Every spelling is canonicalised before comparison. On macOS the worktree
    // root is typically reached through the `/var` -> `/private/var` symlink, so
    // comparing a raw `readdir` result with a canonicalised record would report
    // a live, registered worktree as an orphan.
    directories = readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => canonicalPath(join(worktreeRoot, entry.name)));
  } catch {
    directories = [];
  }
  const known = new Set(knownRoots.map((root) => canonicalPath(root)));
  return {
    worktreeRoot: canonicalPath(worktreeRoot),
    directories,
    // These are invisible to every existing tool: they are neither listed by
    // list_workspaces nor removable by anything.
    orphaned: directories.filter((directory) => !known.has(directory)),
  };
}

/**
 * Every path Git currently registers as a worktree for the repository at
 * `repositoryRoot`. Returns null when it cannot be determined, so callers can
 * report "unknown" rather than "not registered".
 */
export async function listRegisteredWorktrees(
  repositoryRoot: string,
): Promise<Set<string> | null> {
  try {
    const { stdout } = await runGit(
      repositoryRoot,
      ["worktree", "list", "--porcelain"],
      4 * 1024 * 1024,
    );
    // Git reports canonical paths, while a directory scan may hand back the
    // symlinked spelling (on macOS /var vs /private/var). Canonicalise both
    // sides or a registered worktree would be misreported as unregistered.
    return new Set(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalPath(line.slice("worktree ".length).trim())),
    );
  } catch {
    return null;
  }
}

async function isRegisteredWorktree(path: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(
      path,
      ["worktree", "list", "--porcelain"],
      4 * 1024 * 1024,
    );
    const target = canonicalPath(path);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => canonicalPath(line.slice("worktree ".length).trim()) === target);
  } catch {
    return false;
  }
}

/**
 * Commits reachable from HEAD but from no mainline ref. Returns -1 when the
 * answer cannot be established, which callers must treat as "assume unmerged".
 *
 * The **minimum** across mainline refs is the answer, not the maximum: work is
 * merged as soon as one mainline ref contains it. Taking the maximum meant a
 * stale `refs/remotes/origin/main` (for example a clone whose remote-tracking
 * ref was never updated after a later push) made completely merged work look
 * permanently unmerged, which silently blocked every reclamation.
 */
async function countUnmergedCommits(
  root: string,
  branch: string | null,
  mainlineRefs: readonly string[] = DEFAULT_MAINLINE_REFS,
): Promise<number> {
  try {
    const available = await runGit(
      root,
      ["for-each-ref", "--format=%(refname)", ...mainlineRefs],
      1024 * 1024,
    );
    const refs = available.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (refs.length === 0) {
      // No mainline ref to compare against. A detached HEAD at a known commit
      // is still ambiguous, so report unknown rather than "merged".
      return branch ? -1 : 0;
    }
    let minimum: number | null = null;
    for (const ref of refs) {
      const { stdout } = await runGit(
        root,
        ["rev-list", "--count", `${ref}..HEAD`],
        1024 * 1024,
      );
      const count = Number(stdout.trim());
      if (!Number.isFinite(count)) return -1;
      minimum = minimum === null ? count : Math.min(minimum, count);
    }
    return minimum ?? -1;
  } catch {
    return -1;
  }
}

const DEFAULT_MAINLINE_REFS: readonly string[] = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  "refs/remotes/origin/master",
  "refs/heads/master",
];

async function isBranchFullyPushed(
  root: string,
  branch: string,
): Promise<boolean | null> {
  try {
    const upstream = await runGit(
      root,
      ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`],
      1024 * 1024,
    );
    const upstreamRef = upstream.stdout.trim();
    if (!upstreamRef) return null;
    const { stdout } = await runGit(
      root,
      ["rev-list", "--count", `${upstreamRef}..HEAD`],
      1024 * 1024,
    );
    return (Number(stdout.trim()) || 0) === 0;
  } catch {
    // No upstream configured: the branch has never been pushed, which is not
    // itself a blocker for reclamation, but it is not "fully pushed" either.
    return null;
  }
}

/** Resolve symlinks so two spellings of one directory compare equal. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function worktreeDirectoryExists(path: string): boolean {
  return existsSync(path);
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Match a basename against simple shell-style patterns supporting `*` and `?`.
 * Deliberately small: cleanup policy patterns are operator-authored and must
 * stay readable, and a full glob engine would invite regex-escaping mistakes.
 */
export function matchesAnyPattern(
  value: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const expression = new RegExp(
    `^${pattern
      .split("")
      .map((character) => {
        if (character === "*") return ".*";
        if (character === "?") return ".";
        return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("")}$`,
  );
  return expression.test(value);
}

export function isSessionActiveState(value: unknown): boolean {
  return normalizeWorkspaceLifecycleState(value) === "active";
}

/**
 * Only `idle` and `closed` positively mean "DevSpace is not holding this".
 * `active`, `closing`, `stale` and `unknown` all fail closed.
 */
export function isSettledSessionState(
  value: WorkspaceLifecycleState | null | undefined,
): boolean {
  return value === "idle" || value === "closed";
}
