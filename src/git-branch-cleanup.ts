/**
 * Safe deletion of local Git branches that are provably merged.
 *
 * The only destructive Git command this module can run is `git branch -d` — the
 * *safe* delete, which Git itself refuses unless the branch is fully merged into
 * its upstream or HEAD. There is no fallback: if Git says no, the call fails and
 * explains why. `-D`, forced ref updates, remote branch deletion, tag deletion,
 * `reset --hard`, `clean`, and direct `.git/refs` manipulation are not
 * implemented anywhere in this file, on purpose.
 *
 * Every precondition is re-verified immediately before the delete and again
 * after it, under the same per-repository mutation lock the other Git write
 * tools use, so a decision made from a stale audit cannot delete a branch that
 * has since moved or been checked out.
 */
import { basename } from "node:path";
import { isPathInsideRoot } from "./roots.js";
import {
  assertWorkspaceGitRoot,
  runGit,
  withGitMutationLock,
  gitMutationLockKey,
} from "./git-tools.js";
import { isAncestor, readOptionalGitRef } from "./git-remote.js";
import {
  isProtectedDefaultBranch,
  isSafeAuthorizationBranch,
} from "./git-branch-authorization.js";
import {
  matchesAnyPattern,
  matchesPattern,
} from "./workspace-audit.js";
import type { BranchDeleteVerdict } from "./workspace-lifecycle.js";

export { matchesPattern };

export interface BranchDeleteEligibility {
  branch: string;
  sha: string | null;
  verdict: BranchDeleteVerdict;
  reasons: string[];
  /** Worktree paths that currently have this branch checked out. */
  checkedOutAt: string[];
  mainlineRef: string | null;
  mainlineSha: string | null;
  /** Branch has an upstream on a remote. */
  hasUpstream: boolean;
}

export interface BranchDeleteResult {
  branch: string;
  repositoryRoot: string;
  deletedSha: string;
  previousVerdict: BranchDeleteVerdict;
  mainlineRef: string;
  mainlineShaBefore: string;
  mainlineShaAfter: string;
  headShaBefore: string;
  headShaAfter: string;
  remoteRefsBefore: Record<string, string>;
  remoteRefsAfter: Record<string, string>;
  remoteRefsUnchanged: boolean;
}

export interface BranchCleanupPolicy {
  protectedBranches?: readonly string[];
  protectedBranchPatterns?: readonly string[];
  mainlineRefs?: readonly string[];
}

const DEFAULT_MAINLINE_REFS: readonly string[] = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  "refs/remotes/origin/master",
  "refs/heads/master",
];

/** Branch names that are always protected, whatever the configuration says. */
const ALWAYS_PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Conservative default patterns, applied even when the operator configures no
 * cleanup policy at all.
 *
 * These live here rather than only in the config loader so that every caller —
 * including tests and any future direct caller of this module — gets the same
 * protection. `devspace/integration/*` is deliberately absent: those are the
 * per-worktree branches this lifecycle exists to clean up.
 */
export const DEFAULT_PROTECTED_BRANCH_PATTERNS: readonly string[] = [
  "release/*",
  "hotfix/*",
  "feat/*",
  "feature/*",
  "topic/*",
];

function effectiveProtectedPatterns(policy: BranchCleanupPolicy): string[] {
  return [
    ...new Set([
      ...DEFAULT_PROTECTED_BRANCH_PATTERNS,
      ...(policy.protectedBranchPatterns ?? []),
    ]),
  ];
}

/** Reading the branch state never mutates anything. */
async function readBranchState(input: {
  repositoryRoot: string;
  branchName: string;
  mainlineRefs: readonly string[];
}): Promise<{
  sha: string | null;
  checkedOutAt: string[];
  mainlineRef: string | null;
  mainlineSha: string | null;
  hasUpstream: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
}> {
  const root = input.repositoryRoot;
  const ref = `refs/heads/${input.branchName}`;
  const sha = await readOptionalGitRef(root, ref);
  const { stdout } = await runGit(root, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const checkedOutAt: string[] = [];
  let currentPath: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ") && currentPath) {
      const checkedOutRef = line.slice("branch ".length).trim();
      if (checkedOutRef === ref) checkedOutAt.push(currentPath);
    }
  }
  // The repository root itself is the authoritative report for its own HEAD:
  // `worktree list` can omit a stale registration.
  const currentBranch = (
    await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => ({ stdout: "" }),
    )
  ).stdout.trim();

  let mainlineRef: string | null = null;
  let mainlineSha: string | null = null;
  const candidates: Array<{ ref: string; sha: string }> = [];
  for (const candidate of input.mainlineRefs) {
    const candidateSha = await readOptionalGitRef(root, candidate);
    if (candidateSha) candidates.push({ ref: candidate, sha: candidateSha });
  }
  if (candidates.length === 0) {
    const remoteHead = (
      await runGit(root, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]).catch(() => ({ stdout: "" }))
    ).stdout.trim();
    if (remoteHead) {
      const candidateRef = `refs/remotes/${remoteHead}`;
      const candidateSha = await readOptionalGitRef(root, candidateRef);
      if (candidateSha) {
        candidates.push({ ref: candidateRef, sha: candidateSha });
      }
    }
  }
  // Pick the mainline candidate the branch is *most* contained in.
  //
  // A stale remote-tracking ref (a clone whose `origin/main` was never updated
  // after a later push) must not be able to hide a completed merge behind an
  // unmerged-looking answer. Local refs win ties because they are the
  // operator's actual mainline.
  let bestCount: number | null = null;
  for (const candidate of candidates) {
    const contained = await isAncestor(root, ref, candidate.sha).catch(
      () => undefined,
    );
    const count =
      contained === true
        ? 0
        : await runGit(root, [
            "rev-list",
            "--count",
            `${candidate.sha}..${ref}`,
          ])
            .then((result) => Number(result.stdout.trim()) || 0)
            .catch(() => Number.MAX_SAFE_INTEGER);
    const isLocal = candidate.ref.startsWith("refs/heads/");
    const better =
      bestCount === null ||
      count < bestCount ||
      (count === bestCount &&
        isLocal &&
        mainlineRef !== null &&
        !mainlineRef.startsWith("refs/heads/"));
    if (better) {
      bestCount = count;
      mainlineRef = candidate.ref;
      mainlineSha = candidate.sha;
    }
  }
  const hasUpstream = Boolean(
    (
      await runGit(root, [
        "rev-parse",
        "--abbrev-ref",
        `${input.branchName}@{upstream}`,
      ]).catch(() => ({ stdout: "" }))
    ).stdout.trim(),
  );
  const defaultBranch = (
    await runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(
      () => ({ stdout: "" }),
    )
  ).stdout.trim().replace(/^origin\//, "");

  return {
    sha: sha ?? null,
    checkedOutAt,
    mainlineRef,
    mainlineSha,
    hasUpstream,
    currentBranch: currentBranch || null,
    defaultBranch: defaultBranch || null,
  };
}

/**
 * Read-only eligibility check. Used by the cleanup plan and re-run inside the
 * delete operation.
 */
export async function branchDeleteEligibility(input: {
  workspaceRoot: string;
  branchName: string;
  policy?: BranchCleanupPolicy;
  /**
   * Workspace ids that currently hold a lease or a running job/task/game on the
   * branch's repository. Any entry makes the branch an active dependency.
   */
  activeDependents?: string[];
}): Promise<BranchDeleteEligibility> {
  const policy = input.policy ?? {};
  const reasons: string[] = [];
  const base: BranchDeleteEligibility = {
    branch: input.branchName,
    sha: null,
    verdict: "UNKNOWN",
    reasons,
    checkedOutAt: [],
    mainlineRef: null,
    mainlineSha: null,
    hasUpstream: false,
  };
  if (!isSafeAuthorizationBranch(input.branchName)) {
    reasons.push("the branch name is not a valid local branch name");
    return base;
  }
  let root: string;
  try {
    root = await assertWorkspaceGitRoot(input.workspaceRoot);
  } catch (error) {
    reasons.push(
      `the workspace is not an attached Git repository root: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return base;
  }

  const state = await readBranchState({
    repositoryRoot: root,
    branchName: input.branchName,
    mainlineRefs: policy.mainlineRefs ?? DEFAULT_MAINLINE_REFS,
  });
  base.sha = state.sha;
  base.checkedOutAt = state.checkedOutAt;
  base.mainlineRef = state.mainlineRef;
  base.mainlineSha = state.mainlineSha;
  base.hasUpstream = state.hasUpstream;
  if (!state.sha) {
    reasons.push("the branch does not exist locally");
    base.verdict = "MISSING";
    return base;
  }

  if (input.activeDependents && input.activeDependents.length > 0) {
    reasons.push(
      `workspace(s) ${input.activeDependents.join(", ")} currently have in-flight or running work in this repository`,
    );
    base.verdict = "ACTIVE_DEPENDENCY";
    return base;
  }

  const protectedSet = new Set([
    ...ALWAYS_PROTECTED_BRANCHES,
    ...(policy.protectedBranches ?? []),
    ...(state.defaultBranch ? [state.defaultBranch] : []),
  ]);
  if (protectedSet.has(input.branchName) || isProtectedDefaultBranch(input.branchName)) {
    reasons.push(
      `${input.branchName} is a protected default or release branch and is never deleted`,
    );
    base.verdict = "PROTECTED";
    return base;
  }
  if (matchesAnyPattern(input.branchName, effectiveProtectedPatterns(policy))) {
    reasons.push(
      `${input.branchName} matches a protected branch pattern and is never deleted`,
    );
    base.verdict = "PROTECTED";
    return base;
  }
  if (state.checkedOutAt.length > 0) {
    reasons.push(
      `the branch is checked out in ${state.checkedOutAt.join(", ")}`,
    );
    base.verdict = "CHECKED_OUT";
    return base;
  }
  if (!state.mainlineRef || !state.mainlineSha) {
    reasons.push("no mainline ref could be resolved to prove the merge");
    base.verdict = "UNKNOWN";
    return base;
  }
  const ancestor = await isAncestor(root, state.sha, state.mainlineSha);
  if (!ancestor) {
    reasons.push(
      `${input.branchName} has commits that are not ancestors of ${state.mainlineRef} (${state.mainlineSha})`,
    );
    base.verdict = "NOT_AN_ANCESTOR";
    return base;
  }
  base.verdict = "DELETABLE_MERGED";
  reasons.push(
    `every commit on ${input.branchName} is an ancestor of ${state.mainlineRef}`,
  );
  return base;
}

/**
 * Delete one local branch with `git branch -d`.
 *
 * Fails closed at every step. The returned state proves the delete was narrow:
 * the mainline ref, repository HEAD and every remote-tracking ref are compared
 * before and after.
 */
export async function deleteMergedBranch(input: {
  workspaceRoot: string;
  branchName: string;
  expectedBranchSha: string;
  expectedMainSha: string;
  confirmation: string;
  policy?: BranchCleanupPolicy;
  activeDependents?: string[];
}): Promise<BranchDeleteResult> {
  const policy = input.policy ?? {};
  if (input.confirmation !== input.branchName) {
    throw new Error(
      "GIT_BRANCH_CONFIRMATION_REQUIRED: confirmBranchName must exactly equal branchName.",
    );
  }
  if (!isSafeAuthorizationBranch(input.branchName)) {
    throw new Error(
      `GIT_BRANCH_NAME_INVALID: ${input.branchName} is not a valid local branch name.`,
    );
  }
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const lockKey = await gitMutationLockKey(root);

  return withGitMutationLock(lockKey, async () => {
    // Everything below runs inside the per-repository lock and re-reads live
    // state, so a stale audit can never authorize the delete.
    const before = await branchDeleteEligibility({
      workspaceRoot: root,
      branchName: input.branchName,
      policy,
      activeDependents: input.activeDependents,
    });
    if (before.verdict !== "DELETABLE_MERGED") {
      throw new Error(
        `GIT_BRANCH_DELETE_REFUSED: ${input.branchName} is not deletable (${before.verdict}). ${before.reasons.join("; ")}. Nothing was changed.`,
      );
    }
    if (before.sha !== input.expectedBranchSha) {
      throw new Error(
        `GIT_BRANCH_SHA_MISMATCH: Expected ${input.branchName} at ${input.expectedBranchSha}, found ${before.sha}. Re-inspect before deleting.`,
      );
    }
    if (before.mainlineSha !== input.expectedMainSha) {
      throw new Error(
        `GIT_BRANCH_MAIN_SHA_MISMATCH: Expected ${before.mainlineRef} at ${input.expectedMainSha}, found ${before.mainlineSha}. The mainline moved; re-inspect before deleting.`,
      );
    }
    if (!before.mainlineRef || !before.mainlineSha) {
      throw new Error(
        "GIT_BRANCH_MAINLINE_UNKNOWN: The mainline ref could not be resolved. Refusing to delete.",
      );
    }

    const headBefore = (
      await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    const remoteRefsBefore = await listRemoteRefs(root);
    const statusBefore = (
      await runGit(root, ["status", "--porcelain=v1", "-z"])
    ).stdout;

    // `-d` only. Git refuses unless the branch is merged, which is the second
    // independent guard behind the ancestry check above.
    try {
      await runGit(root, ["branch", "-d", "--", input.branchName]);
    } catch (error) {
      throw new Error(
        `GIT_BRANCH_DELETE_FAILED: git branch -d refused ${input.branchName}: ${
          error instanceof Error ? error.message : String(error)
        }. Forced deletion (-D) is not available; resolve the cause and re-audit.`,
      );
    }

    const after = await branchDeleteEligibility({
      workspaceRoot: root,
      branchName: input.branchName,
      policy,
    });
    if (after.sha !== null) {
      throw new Error(
        `GIT_BRANCH_DELETE_VERIFY_FAILED: ${input.branchName} still resolves to ${after.sha} after deletion.`,
      );
    }
    const mainlineShaAfter = await readOptionalGitRef(root, before.mainlineRef);
    const headShaAfter = (
      await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    const remoteRefsAfter = await listRemoteRefs(root);
    const statusAfter = (
      await runGit(root, ["status", "--porcelain=v1", "-z"])
    ).stdout;
    if (mainlineShaAfter !== before.mainlineSha) {
      throw new Error(
        `GIT_BRANCH_MAIN_MOVED: ${before.mainlineRef} changed during deletion (${before.mainlineSha} -> ${mainlineShaAfter ?? "missing"}). Investigate before continuing.`,
      );
    }
    if (headShaAfter !== headBefore) {
      throw new Error(
        `GIT_BRANCH_HEAD_MOVED: repository HEAD changed during deletion (${headBefore} -> ${headShaAfter}). Investigate before continuing.`,
      );
    }
    const remoteRefsUnchanged = sameRefMap(remoteRefsBefore, remoteRefsAfter);
    if (!remoteRefsUnchanged) {
      throw new Error(
        "GIT_BRANCH_REMOTE_CHANGED: a remote-tracking ref changed during deletion. Investigate before continuing.",
      );
    }
    if (statusAfter !== statusBefore) {
      throw new Error(
        "GIT_BRANCH_WORKTREE_CHANGED: the working tree changed during deletion. Investigate before continuing.",
      );
    }

    return {
      branch: input.branchName,
      repositoryRoot: root,
      deletedSha: before.sha,
      previousVerdict: before.verdict,
      mainlineRef: before.mainlineRef,
      mainlineShaBefore: before.mainlineSha,
      mainlineShaAfter: mainlineShaAfter ?? before.mainlineSha,
      headShaBefore: headBefore,
      headShaAfter,
      remoteRefsBefore,
      remoteRefsAfter,
      remoteRefsUnchanged,
    };
  });
}

async function listRemoteRefs(root: string): Promise<Record<string, string>> {
  const output = (
    await runGit(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/remotes/",
    ])
  ).stdout;
  return Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split("\0");
        return [ref, sha] as const;
      })
      .filter(([ref, sha]) => Boolean(ref && sha)),
  );
}

function sameRefMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/**
 * Every local branch that is a candidate for deletion, with its verdict. Used
 * by the cleanup plan so an operator sees branch state next to worktree state.
 */
export async function listLocalBranchVerdicts(input: {
  workspaceRoot: string;
  policy?: BranchCleanupPolicy;
  limit?: number;
}): Promise<BranchDeleteEligibility[]> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const names = (
    await runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .slice(0, input.limit ?? 200);
  const results: BranchDeleteEligibility[] = [];
  for (const name of names) {
    results.push(
      await branchDeleteEligibility({
        workspaceRoot: root,
        branchName: name,
        policy: input.policy,
      }),
    );
  }
  return results;
}

/** Human-readable repository label, used only for reporting. */
export function repositoryLabel(root: string): string {
  return basename(root);
}

export function isRepositoryRootAllowed(
  root: string,
  allowedRoots: readonly string[],
): boolean {
  return allowedRoots.some((allowed) => isPathInsideRoot(root, allowed));
}
