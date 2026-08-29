import { isAbsolute, resolve } from "node:path";
import { access } from "node:fs/promises";
import {
  type GitWorkspaceStatus,
  type GitFetchResult,
  type GitMergeResult,
  type GitPushResult,
  LOCAL_GIT_TIMEOUT_MS,
  REMOTE_GIT_TIMEOUT_MS,
  MAX_GIT_OUTPUT_BYTES,
} from "./git-types.js";
import {
  inspectGitStatus,
  assertWorkspaceGitRoot,
  runGit,
  withGitMutationLock,
  gitMutationLockKey,
  assertNoExecutableGitFilters,
  assertNoExecutableMergeDrivers,
  escapeRegex,
  GitExecutionError,
} from "./git-tools.js";

export async function fetchGit(input: {
  workspaceRoot: string;
  approvedRemotes: string[];
  approvedRemoteUrls?: Record<string, string[]>;
  remote?: string;
  prune?: boolean;
  expectedHeadSha?: string;
  timeoutMs?: number;
}): Promise<GitFetchResult> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const lockKey = await gitMutationLockKey(root);
  return withGitMutationLock(lockKey, () => fetchGitLocked(root, input));
}

export async function mergeGit(input: {
  workspaceRoot: string;
  sourceRef: string;
  mode: "ff_only" | "no_ff";
  expectedHeadSha: string;
  commitMessage?: string;
  expectedSourceSha?: string;
  timeoutMs?: number;
}): Promise<GitMergeResult> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const lockKey = await gitMutationLockKey(root);
  return withGitMutationLock(lockKey, async () => {
    const statusBefore = await inspectGitStatus(root);
    assertCleanAttachedWorkspace(statusBefore);
    const staleMergeState = await mergeStateFilesPresent(root);
    if (staleMergeState.length > 0) {
      throw new Error(
        `GIT_REPOSITORY_STATE_INVALID: Stale merge state exists: ${staleMergeState.join(", ")}.`,
      );
    }
    const expectedHeadSha = normalizeExpectedCommitSha(
      input.expectedHeadSha,
      "expectedHeadSha",
    );
    if (statusBefore.headSha !== expectedHeadSha) {
      throw new Error(
        `GIT_EXPECTED_HEAD_MISMATCH: Expected ${expectedHeadSha}, found ${statusBefore.headSha}.`,
      );
    }
    const sourceRef = await normalizeSourceRef(root, input.sourceRef);
    const sourceSha = await resolveCommit(root, sourceRef);
    if (input.expectedSourceSha !== undefined) {
      const expectedSourceSha = normalizeExpectedCommitSha(
        input.expectedSourceSha,
        "expectedSourceSha",
      );
      if (sourceSha !== expectedSourceSha) {
        throw new Error(
          `GIT_SOURCE_SHA_MISMATCH: Expected ${expectedSourceSha}, found ${sourceSha}.`,
        );
      }
    }
    if (input.mode === "no_ff") {
      if (
        !input.commitMessage ||
        input.commitMessage.trim().length === 0 ||
        input.commitMessage.length > 10_000 ||
        input.commitMessage.includes("\0")
      ) {
        throw new Error(
          "GIT_INPUT_INVALID: no_ff requires a non-empty commitMessage.",
        );
      }
    }
    await assertNoExecutableGitFilters(root);
    await assertNoExecutableMergeDrivers(root);
    const mergeBase = (
      await runGit(root, ["merge-base", statusBefore.headSha, sourceSha])
    ).stdout.trim();
    const fastForwardPossible = await isAncestor(
      root,
      statusBefore.headSha,
      sourceSha,
    );
    if (input.mode === "ff_only" && !fastForwardPossible) {
      throw new Error(
        "GIT_FF_NOT_POSSIBLE: Source cannot fast-forward the current HEAD.",
      );
    }

    const args =
      input.mode === "ff_only"
        ? ["merge", "--ff-only", "--no-verify", sourceSha]
        : [
            "merge",
            "--no-ff",
            "--no-verify",
            "--no-gpg-sign",
            sourceSha,
            "-m",
            input.commitMessage!,
          ];
    try {
      await runGit(
        root,
        args,
        MAX_GIT_OUTPUT_BYTES,
        input.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS,
      );
    } catch (error) {
      const conflictStatus = await inspectGitStatus(root).catch(
        () => undefined,
      );
      const mergeHead = await readOptionalGitRef(root, "MERGE_HEAD");
      const conflictedPaths = conflictStatus?.conflicts ?? [];
      if (mergeHead || conflictedPaths.length > 0) {
        let abortError: unknown;
        try {
          await runGit(root, ["merge", "--abort"]);
        } catch (candidate) {
          abortError = candidate;
        }
        const recoveredStatus = await inspectGitStatus(root).catch(
          () => undefined,
        );
        const stillMerging = Boolean(
          await readOptionalGitRef(root, "MERGE_HEAD"),
        );
        const remainingMergeState = await mergeStateFilesPresent(root);
        const recovered =
          !abortError &&
          !stillMerging &&
          remainingMergeState.length === 0 &&
          recoveredStatus?.headSha === statusBefore.headSha &&
          recoveredStatus.clean;
        if (!recovered) {
          throw new Error(
            `GIT_MERGE_ABORT_FAILED: Merge conflict in ${conflictedPaths.join(", ") || "(unknown paths)"}; automatic abort did not restore the clean pre-merge state. Repository state: ${stillMerging || remainingMergeState.length > 0 ? "MERGING" : "UNKNOWN"}.`,
          );
        }
        throw new Error(
          `GIT_MERGE_CONFLICT: Conflicted paths: ${conflictedPaths.join(", ") || "(unknown)"}. Merge HEAD: ${mergeHead ?? "(unknown)"}. Target HEAD ${statusBefore.headSha} and clean index/worktree were restored by git merge --abort.`,
        );
      }
      throw error;
    }

    const statusAfter = await inspectGitStatus(root);
    if (!statusAfter.clean) {
      throw new Error(
        "GIT_MERGE_VERIFY_FAILED: Merge completed but the workspace is not clean.",
      );
    }
    const parents = (
      await runGit(root, [
        "show",
        "-s",
        "--format=%P",
        `${statusAfter.headSha}^{commit}`,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const changedFiles = (
      await runGit(root, [
        "diff",
        "--name-only",
        "-z",
        statusBefore.headSha,
        statusAfter.headSha,
        "--",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
    const createdMergeCommit = parents.length > 1;
    return {
      branch: statusBefore.branch!,
      headBefore: statusBefore.headSha,
      sourceRef,
      sourceSha,
      mergeBase,
      mode: input.mode,
      fastForwardPossible,
      headAfter: statusAfter.headSha,
      createdMergeCommit,
      mergeCommitSha: createdMergeCommit ? statusAfter.headSha : undefined,
      parents,
      changedFiles,
      statusAfter,
    };
  });
}

export async function pushGit(input: {
  workspaceRoot: string;
  approvedRemotes: string[];
  approvedRemoteUrls?: Record<string, string[]>;
  approvedDestinationBranches: string[];
  remote?: string;
  sourceRef?: string;
  destinationBranch: string;
  expectedLocalSha: string;
  expectedRemoteSha: string;
  verifyAncestor?: boolean;
  timeoutMs?: number;
}): Promise<GitPushResult> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const lockKey = await gitMutationLockKey(root);
  return withGitMutationLock(lockKey, async () => {
    const statusBefore = await inspectGitStatus(root);
    assertCleanAttachedWorkspace(statusBefore);
    const remote = await assertApprovedRemote(
      root,
      input.remote ?? "origin",
      input.approvedRemotes,
      input.approvedRemoteUrls,
      true,
    );
    const destinationBranch = await normalizeDestinationBranch(
      root,
      input.destinationBranch,
    );
    if (!input.approvedDestinationBranches.includes(destinationBranch)) {
      throw new Error(
        `GIT_DESTINATION_BRANCH_NOT_APPROVED: Destination branch ${destinationBranch} is not approved.`,
      );
    }
    const sourceRef = await normalizeSourceRef(root, input.sourceRef ?? "HEAD");
    const localSha = await resolveCommit(root, sourceRef);
    if (localSha !== statusBefore.headSha) {
      throw new Error(
        "GIT_SOURCE_NOT_HEAD: Push source must resolve to the current workspace HEAD.",
      );
    }
    const expectedLocalSha = normalizeExpectedCommitSha(
      input.expectedLocalSha,
      "expectedLocalSha",
    );
    if (localSha !== expectedLocalSha) {
      throw new Error(
        `GIT_EXPECTED_LOCAL_SHA_MISMATCH: Expected ${expectedLocalSha}, found ${localSha}.`,
      );
    }
    const expectedRemoteSha = normalizeExpectedCommitSha(
      input.expectedRemoteSha,
      "expectedRemoteSha",
    );

    await fetchGitLocked(root, {
      ...input,
      remote,
      prune: true,
    });
    const statusAfterFetch = await inspectGitStatus(root);
    if (
      statusAfterFetch.headSha !== statusBefore.headSha ||
      !statusAfterFetch.clean
    ) {
      throw new Error(
        "GIT_LOCAL_CHANGED: Workspace changed while verifying the remote.",
      );
    }
    const sourceShaAfterFetch = await resolveCommit(root, sourceRef);
    if (sourceShaAfterFetch !== localSha) {
      throw new Error(
        "GIT_LOCAL_CHANGED: Source ref changed while verifying the remote.",
      );
    }
    const remoteTrackingRef = `refs/remotes/${remote}/${destinationBranch}`;
    const remoteShaBefore = await resolveExactCommit(root, remoteTrackingRef);
    if (remoteShaBefore !== expectedRemoteSha) {
      throw new Error(
        `GIT_REMOTE_CHANGED: Expected ${expectedRemoteSha}, found ${remoteShaBefore}.`,
      );
    }
    if (input.verifyAncestor === false) {
      throw new Error(
        "GIT_INPUT_INVALID: verifyAncestor cannot be disabled by the caller.",
      );
    }
    if (!(await isAncestor(root, expectedRemoteSha, localSha))) {
      throw new Error(
        "GIT_PUSH_NON_FAST_FORWARD: Remote destination is not an ancestor of the local commit.",
      );
    }

    try {
      await runGit(
        root,
        [
          "-c",
          `remote.${remote}.mirror=false`,
          "push",
          "--porcelain",
          "--no-verify",
          `--force-with-lease=refs/heads/${destinationBranch}:${expectedRemoteSha}`,
          "--",
          remote,
          `${localSha}:refs/heads/${destinationBranch}`,
        ],
        MAX_GIT_OUTPUT_BYTES,
        input.timeoutMs ?? REMOTE_GIT_TIMEOUT_MS,
      );
    } catch (error) {
      const remoteAfterFailure = await refreshRemoteDestination(
        root,
        remote,
        destinationBranch,
        input.timeoutMs,
        input.approvedRemoteUrls,
      ).catch(() => undefined);
      if (remoteAfterFailure && remoteAfterFailure !== expectedRemoteSha) {
        throw new Error(
          `GIT_REMOTE_CHANGED: Remote moved from ${expectedRemoteSha} to ${remoteAfterFailure} before the push could complete.`,
        );
      }
      if (error instanceof GitExecutionError && error.timedOut) {
        throw new Error("GIT_TIMEOUT: Timed out while pushing the Git remote.");
      }
      throw new Error("GIT_PUSH_REJECTED: The remote rejected the push.");
    }

    const remoteShaAfter = await refreshRemoteDestination(
      root,
      remote,
      destinationBranch,
      input.timeoutMs,
      input.approvedRemoteUrls,
    );
    const remoteContainsLocal = await isAncestor(
      root,
      localSha,
      remoteShaAfter,
    );
    if (!remoteContainsLocal) {
      throw new Error(
        "GIT_PUSH_VERIFY_FAILED: Remote verification does not contain the pushed local commit.",
      );
    }
    const statusAfter = await inspectGitStatus(root);
    if (statusAfter.headSha !== statusBefore.headSha || !statusAfter.clean) {
      throw new Error(
        "GIT_PUSH_VERIFY_FAILED: Local workspace changed during push.",
      );
    }
    return {
      remote,
      destinationBranch,
      remoteShaBefore,
      localSha,
      pushAttempted: true,
      pushSucceeded: true,
      remoteShaAfter,
      remoteContainsLocal,
      statusAfter,
    };
  });
}

export async function fetchGitLocked(
  root: string,
  input: {
    approvedRemotes: string[];
    approvedRemoteUrls?: Record<string, string[]>;
    remote?: string;
    prune?: boolean;
    expectedHeadSha?: string;
    timeoutMs?: number;
  },
): Promise<GitFetchResult> {
  const statusBefore = await inspectGitStatus(root);
  if (input.expectedHeadSha !== undefined) {
    const expectedHeadSha = normalizeExpectedCommitSha(
      input.expectedHeadSha,
      "expectedHeadSha",
    );
    if (statusBefore.headSha !== expectedHeadSha) {
      throw new Error(
        `GIT_EXPECTED_HEAD_MISMATCH: Expected ${expectedHeadSha}, found ${statusBefore.headSha}.`,
      );
    }
  }
  const remote = await assertApprovedRemote(
    root,
    input.remote ?? "origin",
    input.approvedRemotes,
    input.approvedRemoteUrls,
    false,
  );
  const prune = input.prune ?? true;
  const refsBefore = await listRemoteTrackingRefs(root, remote);
  try {
    await runGit(
      root,
      [
        "fetch",
        prune ? "--prune" : "--no-prune",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        remote,
        `+refs/heads/*:refs/remotes/${remote}/*`,
      ],
      MAX_GIT_OUTPUT_BYTES,
      input.timeoutMs ?? REMOTE_GIT_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof GitExecutionError && error.timedOut) {
      throw new Error("GIT_TIMEOUT: Timed out while fetching the Git remote.");
    }
    throw error;
  }
  const refsAfter = await listRemoteTrackingRefs(root, remote);
  const statusAfter = await inspectGitStatus(root);
  if (
    statusAfter.headSha !== statusBefore.headSha ||
    statusAfter.branch !== statusBefore.branch ||
    statusAfter.clean !== statusBefore.clean ||
    statusAfter.stagedDiffSha256 !== statusBefore.stagedDiffSha256 ||
    JSON.stringify(statusAfter.staged) !==
      JSON.stringify(statusBefore.staged) ||
    JSON.stringify(statusAfter.unstaged) !==
      JSON.stringify(statusBefore.unstaged) ||
    JSON.stringify(statusAfter.untracked) !==
      JSON.stringify(statusBefore.untracked) ||
    JSON.stringify(statusAfter.conflicts) !==
      JSON.stringify(statusBefore.conflicts)
  ) {
    throw new Error(
      "GIT_FETCH_WORKSPACE_CHANGED: Fetch changed the current branch, index, or worktree.",
    );
  }
  const updatedRefs: GitFetchResult["updatedRefs"] = [];
  const createdRefs: GitFetchResult["createdRefs"] = [];
  const deletedRefs: GitFetchResult["deletedRefs"] = [];
  for (const [ref, after] of Object.entries(refsAfter)) {
    const before = refsBefore[ref];
    if (before === undefined) createdRefs.push({ ref, after });
    else if (before !== after) updatedRefs.push({ ref, before, after });
  }
  for (const [ref, before] of Object.entries(refsBefore)) {
    if (refsAfter[ref] === undefined) deletedRefs.push({ ref, before });
  }
  return {
    remote,
    prune,
    headSha: statusAfter.headSha,
    branch: statusAfter.branch,
    refsBefore,
    refsAfter,
    updatedRefs,
    createdRefs,
    deletedRefs,
  };
}

export async function refreshRemoteDestination(
  root: string,
  remote: string,
  destinationBranch: string,
  timeoutMs?: number,
  approvedRemoteUrls?: Record<string, string[]>,
): Promise<string> {
  await fetchGitLocked(root, {
    approvedRemotes: [remote],
    approvedRemoteUrls,
    remote,
    prune: true,
    timeoutMs,
  });
  return resolveExactCommit(
    root,
    `refs/remotes/${remote}/${destinationBranch}`,
  );
}

export async function assertApprovedRemote(
  root: string,
  value: string,
  approvedRemotes: string[],
  approvedRemoteUrls: Record<string, string[]> | undefined,
  forPush: boolean,
): Promise<string> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value) ||
    value.includes("\0")
  ) {
    throw new Error("GIT_REMOTE_INVALID: Remote name is invalid.");
  }
  if (!approvedRemotes.includes(value)) {
    throw new Error(
      `GIT_REMOTE_NOT_APPROVED: Remote ${value} is not approved.`,
    );
  }
  const remotes = (await runGit(root, ["remote"])).stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!remotes.includes(value)) {
    throw new Error(`GIT_REMOTE_NOT_FOUND: Remote ${value} does not exist.`);
  }
  await assertSafeLocalRemoteConfig(root, value);
  const urls = (
    await runGit(root, [
      "remote",
      "get-url",
      "--all",
      ...(forPush ? ["--push"] : []),
      "--",
      value,
    ])
  ).stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (urls.length === 0 || urls.some((url) => !isSafeRemoteUrl(url))) {
    throw new Error(
      "GIT_REMOTE_UNSAFE: Remote uses an unsupported or unsafe URL transport.",
    );
  }
  const expectedUrls = approvedRemoteUrls?.[value];
  if (expectedUrls && urls.some((url) => !expectedUrls.includes(url))) {
    throw new Error(
      "GIT_REMOTE_URL_MISMATCH: Configured remote URL does not match the operator-approved binding.",
    );
  }
  return value;
}

export async function assertSafeLocalRemoteConfig(
  root: string,
  remote: string,
): Promise<void> {
  const unsafe = await runGit(root, [
    "config",
    "--local",
    "--get-regexp",
    `^(core\\.(sshCommand|gitProxy)|credential\\..*|credential\\.helper|include(If)?\\..*|url\\..*\\.insteadOf|remote\\.${escapeRegex(remote)}\\.(uploadpack|receivepack))$`,
  ]).catch(() => undefined);
  if (unsafe?.stdout.trim()) {
    throw new Error(
      "GIT_REMOTE_CONFIG_REJECTED: Repository-local executable or URL rewrite Git configuration is not supported.",
    );
  }
}

export function isSafeRemoteUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    value.startsWith("-") ||
    value.startsWith("ext::")
  ) {
    return false;
  }
  if (/^https:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return (
        !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      );
    } catch {
      return false;
    }
  }
  if (/^file:\/\//i.test(value)) return true;
  if (value.startsWith("/")) return true;
  return false;
}

export async function normalizeSourceRef(
  root: string,
  value: string,
): Promise<string> {
  if (value === "HEAD") return value;
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) return value;
  if (!isSafeRefText(value)) {
    throw new Error("GIT_SOURCE_REF_INVALID: Source ref is invalid.");
  }
  try {
    await runGit(root, ["check-ref-format", "--branch", value]);
  } catch {
    throw new Error("GIT_SOURCE_REF_INVALID: Source ref is invalid.");
  }
  return value;
}

export async function normalizeDestinationBranch(
  root: string,
  value: string,
): Promise<string> {
  if (!isSafeRefText(value)) {
    throw new Error(
      "GIT_DESTINATION_BRANCH_INVALID: Destination branch is invalid.",
    );
  }
  try {
    await runGit(root, ["check-ref-format", "--branch", value]);
  } catch {
    throw new Error(
      "GIT_DESTINATION_BRANCH_INVALID: Destination branch is invalid.",
    );
  }
  return value;
}

export function isSafeRefText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.split("/").some((part) => part.length === 0 || part.startsWith("."))
  );
}

export function normalizeExpectedCommitSha(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`GIT_INPUT_INVALID: ${name} must be a full commit SHA.`);
  }
  return value;
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  try {
    return (
      await runGit(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).stdout.trim();
  } catch {
    throw new Error(
      "GIT_SOURCE_REF_INVALID: Source ref does not resolve to a commit.",
    );
  }
}

export async function resolveExactCommit(root: string, ref: string): Promise<string> {
  try {
    return (
      await runGit(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).stdout.trim();
  } catch {
    throw new Error(
      `GIT_REMOTE_CHANGED: Required remote ref ${ref} is absent.`,
    );
  }
}

export async function readOptionalGitRef(
  root: string,
  ref: string,
): Promise<string | undefined> {
  const result = await runGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ]).catch(() => undefined);
  return result?.stdout.trim() || undefined;
}

export async function mergeStateFilesPresent(root: string): Promise<string[]> {
  const names = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"];
  const present: string[] = [];
  for (const name of names) {
    const path = (
      await runGit(root, ["rev-parse", "--git-path", name])
    ).stdout.trim();
    const absolutePath = isAbsolute(path) ? path : resolve(root, path);
    if (
      await access(absolutePath)
        .then(() => true)
        .catch(() => false)
    ) {
      present.push(name);
    }
  }
  return present;
}

export async function listRemoteTrackingRefs(
  root: string,
  remote: string,
): Promise<Record<string, string>> {
  const output = (
    await runGit(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      `refs/remotes/${remote}/`,
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

export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitExecutionError && error.exitCode === 1)
      return false;
    throw error;
  }
}

export function assertCleanAttachedWorkspace(status: GitWorkspaceStatus): void {
  if (!status.clean) {
    throw new Error(
      `GIT_WORKSPACE_NOT_CLEAN: staged=${status.staged.length}, unstaged=${status.unstaged.length}, untracked=${status.untracked.length}, conflicts=${status.conflicts.length}.`,
    );
  }
  if (!status.branch) {
    throw new Error(
      "GIT_DETACHED_HEAD: Operation requires an attached branch.",
    );
  }
}
