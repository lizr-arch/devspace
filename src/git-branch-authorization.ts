/**
 * Scoped Git branch authorization.
 *
 * The remote write policy historically allowed pushing to any branch named in a
 * static `approvedDestinationBranches` array, with no scope, no expiry and no
 * revocation short of editing the config file and restarting the process. That
 * is both too coarse (one flat list shared by every approved repository) and too
 * permanent.
 *
 * A `GitBranchAuthorization` narrows a grant along three axes:
 *
 *   - SCOPE: it names one exact destination branch and one exact repository
 *     root, so a grant for `devspace/integration/x` in repo A cannot be used in
 *     repo B, and it can never be a wildcard over `feat/*`.
 *   - EXPIRY: `expiresAt` bounds the grant in time. An expired grant stops
 *     working with no operator action.
 *   - REVOCATION: `revokedAt` makes withdrawal explicit and auditable; the
 *     entry stays in the file as a record instead of silently disappearing.
 *
 * Default branches (`main`, `master`) are refused by the static list outright:
 * they can only be reached through an explicit, time-boxed authorization, so a
 * one-off release push cannot quietly become a permanent standing grant.
 */
import { isPathInsideRoot } from "./roots.js";

export interface GitBranchAuthorization {
  branch: string;
  repositoryRoot: string;
  grantedAt: string;
  expiresAt?: string;
  grantedBy?: string;
  note?: string;
  revokedAt?: string;
}

export type BranchAuthorizationVerdict =
  | { authorized: true; authorization: GitBranchAuthorization | null }
  | { authorized: false; reason: string };

/** Branch names that must never be reachable through the static allowlist. */
export const PROTECTED_DEFAULT_BRANCHES: readonly string[] = ["main", "master"];

export function isProtectedDefaultBranch(branch: string): boolean {
  return PROTECTED_DEFAULT_BRANCHES.includes(branch);
}

export function isSafeAuthorizationBranch(branch: string): boolean {
  return (
    typeof branch === "string" &&
    branch.length > 0 &&
    branch.length <= 255 &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.includes("@{") &&
    !/[\s~^:?*[\]\\]/.test(branch) &&
    !branch.endsWith(".lock")
  );
}

/**
 * Decide whether a destination branch may be pushed to, considering the static
 * allowlist first and then scoped authorizations.
 *
 * `now` is injectable so expiry can be tested without waiting.
 */
export function authorizeDestinationBranch(input: {
  destinationBranch: string;
  repositoryRoot: string;
  approvedDestinationBranches: readonly string[];
  authorizations: readonly GitBranchAuthorization[];
  now?: Date;
}): BranchAuthorizationVerdict {
  const now = input.now ?? new Date();
  const branch = input.destinationBranch;

  if (isProtectedDefaultBranch(branch)) {
    // Only an explicit authorization can open a default branch, and it must be
    // scoped to this repository and still valid.
    const scoped = findValidAuthorization(input, branch, now);
    if (scoped) return { authorized: true, authorization: scoped };
    return {
      authorized: false,
      reason: `GIT_DESTINATION_BRANCH_NOT_APPROVED: ${branch} is a protected default branch. Add a scoped, expiring branchAuthorization for this repository instead of listing it in approvedDestinationBranches.`,
    };
  }

  if (input.approvedDestinationBranches.includes(branch)) {
    return { authorized: true, authorization: null };
  }

  const scoped = findValidAuthorization(input, branch, now);
  if (scoped) return { authorized: true, authorization: scoped };

  const expired = input.authorizations.find(
    (entry) => entry.branch === branch && !entry.revokedAt,
  );
  if (expired) {
    return {
      authorized: false,
      reason: `GIT_DESTINATION_BRANCH_NOT_APPROVED: the authorization for ${branch} is expired or scoped to a different repository root.`,
    };
  }
  return {
    authorized: false,
    reason: `GIT_DESTINATION_BRANCH_NOT_APPROVED: Destination branch ${branch} is not approved.`,
  };
}

function findValidAuthorization(
  input: {
    repositoryRoot: string;
    authorizations: readonly GitBranchAuthorization[];
  },
  branch: string,
  now: Date,
): GitBranchAuthorization | null {
  for (const entry of input.authorizations) {
    if (entry.branch !== branch) continue;
    if (entry.revokedAt) continue;
    if (
      !isPathInsideRoot(input.repositoryRoot, entry.repositoryRoot) ||
      !isPathInsideRoot(entry.repositoryRoot, input.repositoryRoot)
    ) {
      continue;
    }
    if (entry.expiresAt && !(now.getTime() < Date.parse(entry.expiresAt))) {
      continue;
    }
    if (Number.isNaN(Date.parse(entry.grantedAt))) continue;
    return entry;
  }
  return null;
}

/** Human-readable state of every authorization, for diagnostics. */
export function describeAuthorizations(
  authorizations: readonly GitBranchAuthorization[],
  now: Date = new Date(),
): Array<{
  branch: string;
  repositoryRoot: string;
  state: "active" | "expired" | "revoked";
  expiresAt: string | null;
  note: string | null;
}> {
  return authorizations.map((entry) => ({
    branch: entry.branch,
    repositoryRoot: entry.repositoryRoot,
    state: entry.revokedAt
      ? "revoked"
      : entry.expiresAt && !(now.getTime() < Date.parse(entry.expiresAt))
        ? "expired"
        : "active",
    expiresAt: entry.expiresAt ?? null,
    note: entry.note ?? null,
  }));
}
