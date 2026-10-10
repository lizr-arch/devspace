/**
 * Workspace / Git worktree lifecycle audit.
 *
 * The workspace store accumulates a row per opened session and never removes
 * one; its `status` column is written `"active"` at creation and never updated,
 * so 100% of rows claim to be active regardless of reality. This module derives
 * the real state from the filesystem and Git instead of trusting that column,
 * and it is deliberately conservative: anything it cannot positively prove
 * clean is reported as a risk, never as a reclamation candidate.
 *
 * Nothing here mutates anything. `reclaimable` is a *candidate* flag that
 * requires an explicit caller decision plus an independent re-check.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { inspectGitStatus, runGit } from "./git-tools.js";

export type WorkspaceLifecycleState =
  /** A live in-process session exists for this record. */
  | "active_session"
  /** The directory is a registered Git worktree and is resumable. */
  | "git_worktree"
  /** The directory is a normal checkout and is resumable. */
  | "checkout"
  /** The record points at a directory that no longer exists. */
  | "missing_directory"
  /** The directory exists but has no Git repository at all. */
  | "not_a_repository"
  /** A worktree directory on disk with no corresponding record. */
  | "orphaned_directory";

export interface WorkspaceAuditRisk {
  code:
    | "uncommitted_changes"
    | "untracked_files"
    | "unmerged_commits"
    | "active_job"
    | "active_session"
    | "unpushed_branch"
    | "missing_directory"
    | "ambiguous_ownership"
    | "not_a_worktree";
  detail: string;
}

export interface WorkspaceAudit {
  workspaceId: string | null;
  root: string;
  lifecycle: WorkspaceLifecycleState;
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
  /** True when a live DevSpace session currently owns this root. */
  hasActiveSession: boolean;
  risks: WorkspaceAuditRisk[];
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
  hasActiveSession: boolean;
  activeJobIds: string[];
  /**
   * Precomputed `git worktree list` result for the owning repository. Passing
   * it avoids re-running Git once per directory when auditing a whole worktree
   * root.
   */
  registeredWorktrees?: Set<string>;
}): Promise<WorkspaceAudit> {
  const risks: WorkspaceAuditRisk[] = [];
  const blockedReasons: string[] = [];

  let exists = false;
  try {
    exists = lstatSync(input.root).isDirectory();
  } catch {
    exists = false;
  }

  let lifecycle: WorkspaceLifecycleState;
  let dirtyFileCount = 0;
  let untrackedFileCount = 0;
  let unmergedCommitCount = 0;
  let branch: string | null = null;
  let detached = false;
  let headSha: string | null = null;

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
      dirtyFileCount = new Set([...status.staged, ...status.unstaged]).size;
      untrackedFileCount = status.untracked.length;
      branch = status.branch ?? null;
      detached = !status.branch;
      headSha = status.headSha;
      lifecycle = input.hasActiveSession
        ? "active_session"
        : input.mode === "worktree"
          ? "git_worktree"
          : "checkout";

      if (input.mode === "worktree") {
        const registered =
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
      lifecycle = exists ? "not_a_repository" : "missing_directory";
      risks.push({
        code: "ambiguous_ownership",
        detail: `Git state could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      blockedReasons.push("Git state could not be read");
    }
  }

  if (input.hasActiveSession) {
    risks.push({
      code: "active_session",
      detail: "A live DevSpace session is attached to this workspace.",
    });
    blockedReasons.push("a live session is using it");
  }
  if (input.activeJobIds.length > 0) {
    risks.push({
      code: "active_job",
      detail: `Non-terminal job(s) are running in this workspace: ${input.activeJobIds.join(", ")}.`,
    });
    blockedReasons.push("a background job is running in it");
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
    resumable: exists && lifecycle !== "not_a_repository",
    dirtyFileCount,
    untrackedFileCount,
    unmergedCommitCount: Math.max(0, unmergedCommitCount),
    activeJobIds: input.activeJobIds,
    hasActiveSession: input.hasActiveSession,
    risks,
    reclaimable: risks.length === 0 && exists,
    blockedReasons,
  };
}

/** Directories under the managed worktree root, including ones with no record. */
export function scanWorktreeDirectories(
  worktreeRoot: string,
  knownRoots: string[],
): WorktreeDirectoryScan {
  let directories: string[] = [];
  try {
    directories = readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(worktreeRoot, entry.name));
  } catch {
    directories = [];
  }
  const known = new Set(knownRoots);
  return {
    worktreeRoot,
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
 */
async function countUnmergedCommits(
  root: string,
  branch: string | null,
): Promise<number> {
  const candidates = [
    "refs/remotes/origin/main",
    "refs/heads/main",
    "refs/remotes/origin/master",
    "refs/heads/master",
  ];
  try {
    const available = await runGit(
      root,
      ["for-each-ref", "--format=%(refname)", ...candidates],
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
    let total = 0;
    for (const ref of refs) {
      const { stdout } = await runGit(
        root,
        ["rev-list", "--count", `${ref}..HEAD`],
        1024 * 1024,
      );
      total = Math.max(total, Number(stdout.trim()) || 0);
    }
    return total;
  } catch {
    return -1;
  }
}

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
