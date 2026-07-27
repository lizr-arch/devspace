import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeWorkspaceRelativePath } from "./workspace-paths.js";

const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_GIT_PATHS = 100;
const LOCAL_GIT_TIMEOUT_MS = 30_000;
const REMOTE_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
let emptyHooksPath: string | undefined;
const gitMutationTails = new Map<string, Promise<void>>();

export interface GitWorkspaceStatus {
  headSha: string;
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicts: string[];
  stagedDiffSha256: string;
}

export interface GitDiffResult {
  scope: "head" | "staged" | "unstaged";
  patch: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface GitFetchResult {
  remote: string;
  prune: boolean;
  headSha: string;
  branch?: string;
  refsBefore: Record<string, string>;
  refsAfter: Record<string, string>;
  updatedRefs: Array<{ ref: string; before: string; after: string }>;
  createdRefs: Array<{ ref: string; after: string }>;
  deletedRefs: Array<{ ref: string; before: string }>;
}

export interface GitMergeResult {
  branch: string;
  headBefore: string;
  sourceRef: string;
  sourceSha: string;
  mergeBase: string;
  mode: "ff_only" | "no_ff";
  fastForwardPossible: boolean;
  headAfter: string;
  createdMergeCommit: boolean;
  mergeCommitSha?: string;
  parents: string[];
  changedFiles: string[];
  statusAfter: GitWorkspaceStatus;
}

export interface GitPushResult {
  remote: string;
  destinationBranch: string;
  remoteShaBefore: string;
  localSha: string;
  pushAttempted: boolean;
  pushSucceeded: boolean;
  remoteShaAfter: string;
  remoteContainsLocal: boolean;
  statusAfter: GitWorkspaceStatus;
}

export async function inspectGitStatus(
  workspaceRoot: string,
): Promise<GitWorkspaceStatus> {
  const root = await assertWorkspaceGitRoot(workspaceRoot);
  const headSha = (
    await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).stdout.trim();
  const branchResult = await runGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]).catch(() => undefined);
  const raw = (
    await runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
  ).stdout;
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const conflicts = new Set<string>();
  const entries = raw.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === "?" && y === "?") {
      untracked.add(path);
      continue;
    }
    if (x === "R" || x === "C") {
      const originalPath = entries[index + 1];
      if (originalPath) index += 1;
    }
    if (["U", "A", "D"].includes(x) && ["U", "A", "D"].includes(y)) {
      conflicts.add(path);
      continue;
    }
    if (x !== " " && x !== "?") staged.add(path);
    if (y !== " " && y !== "?") unstaged.add(path);
  }
  const stagedDiff = await rawGitDiff(root, "staged", [], 3);
  return {
    headSha,
    branch: branchResult?.stdout.trim() || undefined,
    clean:
      staged.size === 0 &&
      unstaged.size === 0 &&
      untracked.size === 0 &&
      conflicts.size === 0,
    staged: [...staged].sort(),
    unstaged: [...unstaged].sort(),
    untracked: [...untracked].sort(),
    conflicts: [...conflicts].sort(),
    stagedDiffSha256: sha256(stagedDiff),
  };
}

export async function inspectGitDiff(input: {
  workspaceRoot: string;
  scope?: "head" | "staged" | "unstaged";
  paths?: string[];
  contextLines?: number;
}): Promise<GitDiffResult> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  const scope = input.scope ?? "head";
  const paths = normalizeGitPaths(input.paths ?? []);
  const contextLines = input.contextLines ?? 3;
  if (
    !Number.isInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > 20
  ) {
    throw new Error("GIT_INPUT_INVALID: contextLines must be from 0 to 20.");
  }
  const fullPatch = await rawGitDiff(root, scope, paths, contextLines);
  const bytes = Buffer.byteLength(fullPatch);
  return {
    scope,
    patch:
      bytes <= MAX_DIFF_BYTES
        ? fullPatch
        : Buffer.from(fullPatch).subarray(0, MAX_DIFF_BYTES).toString("utf8"),
    sha256: sha256(fullPatch),
    bytes,
    truncated: bytes > MAX_DIFF_BYTES,
  };
}

export async function stageGitPaths(
  workspaceRoot: string,
  paths: string[],
): Promise<GitWorkspaceStatus> {
  const root = await assertWorkspaceGitRoot(workspaceRoot);
  const normalized = normalizeRequiredGitPaths(paths);
  await assertNoExecutableGitFilters(root);
  await runGit(root, ["add", "-A", "--", ...normalized]);
  return inspectGitStatus(root);
}

export async function unstageGitPaths(
  workspaceRoot: string,
  paths: string[],
): Promise<GitWorkspaceStatus> {
  const root = await assertWorkspaceGitRoot(workspaceRoot);
  const normalized = normalizeRequiredGitPaths(paths);
  await runGit(root, ["restore", "--staged", "--", ...normalized]);
  return inspectGitStatus(root);
}

export async function commitGit(input: {
  workspaceRoot: string;
  message: string;
  expectedStagedDiffSha256: string;
}): Promise<{ headSha: string; status: GitWorkspaceStatus }> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  if (
    input.message.trim().length === 0 ||
    input.message.length > 10_000 ||
    input.message.includes("\0")
  ) {
    throw new Error("GIT_INPUT_INVALID: Commit message is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedStagedDiffSha256)) {
    throw new Error("GIT_INPUT_INVALID: expectedStagedDiffSha256 is invalid.");
  }
  const status = await inspectGitStatus(root);
  if (status.conflicts.length > 0) {
    throw new Error("GIT_CONFLICT: Resolve conflicts before committing.");
  }
  if (status.staged.length === 0) {
    throw new Error("GIT_NOTHING_STAGED: No staged changes to commit.");
  }
  if (status.stagedDiffSha256 !== input.expectedStagedDiffSha256) {
    throw new Error("GIT_STALE_INDEX: Staged content changed after review.");
  }
  await runGit(root, [
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    input.message,
  ]);
  return {
    headSha: (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim(),
    status: await inspectGitStatus(root),
  };
}

export async function manageGitBranch(input: {
  workspaceRoot: string;
  action: "list" | "create" | "switch";
  name?: string;
  checkout?: boolean;
  startPoint?: string;
}): Promise<{
  current?: string;
  currentBranch: string | null;
  detached: boolean;
  branches: string[];
  action: "list" | "create" | "switch";
  branchCreated?: boolean;
  checkedOut?: boolean;
}> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  let branchCreated: boolean | undefined;
  let checkedOut: boolean | undefined;

  if (input.action !== "list") {
    if (!input.name) {
      throw new Error("GIT_INPUT_INVALID: Branch name is required.");
    }
    await runGit(root, ["check-ref-format", "--branch", input.name]);

    if (input.action === "create") {
      const shouldCheckout = input.checkout !== false; // default true
      const startPoint = input.startPoint || "HEAD";
      let branchExists = false;
      try {
        await runGit(root, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${input.name}`,
        ]);
        branchExists = true;
      } catch {
        branchExists = false;
      }

      if (shouldCheckout) {
        if (!branchExists) {
          // Atomic: create + checkout — only creates ref if checkout succeeds.
          await runGit(root, ["switch", "-c", input.name, startPoint]);
          branchCreated = true;
        } else {
          // Branch already exists — switch to it.
          const status = await inspectGitStatus(root);
          if (!status.clean) {
            throw new Error(
              "GIT_DIRTY: Switching branches requires a clean workspace.",
            );
          }
          await assertNoExecutableGitFilters(root);
          await runGit(root, ["switch", "--", input.name]);
          branchCreated = false;
        }
        checkedOut = true;
      } else {
        // checkout=false: create ref only, stay where we are.
        if (branchExists) {
          throw new Error(
            `GIT_BRANCH_EXISTS: Branch ${input.name} already exists.`,
          );
        }
        await runGit(root, ["branch", "--", input.name, startPoint]);
        branchCreated = true;
        checkedOut = false;
      }
    } else {
      // action === "switch"
      const status = await inspectGitStatus(root);
      if (!status.clean) {
        throw new Error(
          "GIT_DIRTY: Switching branches requires a clean workspace.",
        );
      }
      await assertNoExecutableGitFilters(root);
      await runGit(root, ["show-ref", "--verify", `refs/heads/${input.name}`]);
      await runGit(root, ["switch", "--", input.name]);
    }
  }

  const branches = (
    await runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
  ).stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();

  const current = (
    await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => ({ stdout: "", stderr: "" }),
    )
  ).stdout.trim();

  return {
    current: current || undefined,
    currentBranch: current || null,
    detached: !current,
    branches,
    action: input.action,
    branchCreated,
    checkedOut,
  };
}

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

export async function assertWorkspaceGitRoot(
  workspaceRoot: string,
): Promise<string> {
  const canonicalWorkspace = await realpath(workspaceRoot);
  let gitRoot: string;
  try {
    gitRoot = (
      await runGit(canonicalWorkspace, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
  } catch {
    throw new Error("GIT_NOT_REPOSITORY: Workspace is not a Git repository.");
  }
  const canonicalGitRoot = await realpath(gitRoot);
  if (canonicalGitRoot !== canonicalWorkspace) {
    throw new Error(
      "GIT_ROOT_MISMATCH: Git root must equal the workspace root.",
    );
  }
  try {
    await runGit(canonicalGitRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
  } catch {
    throw new Error("GIT_NO_HEAD: Repository must have an existing HEAD.");
  }
  return canonicalGitRoot;
}

async function rawGitDiff(
  root: string,
  scope: "head" | "staged" | "unstaged",
  paths: string[],
  contextLines: number,
): Promise<string> {
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    `--unified=${contextLines}`,
  ];
  if (scope === "staged") args.push("--cached");
  if (scope === "head") args.push("HEAD");
  if (paths.length > 0) args.push("--", ...paths);
  return (await runGit(root, args, 64 * 1024 * 1024)).stdout;
}

function normalizeGitPaths(paths: string[]): string[] {
  if (paths.length > MAX_GIT_PATHS) {
    throw new Error(
      `GIT_INPUT_INVALID: At most ${MAX_GIT_PATHS} paths are allowed.`,
    );
  }
  return [...new Set(paths.map(normalizeWorkspaceRelativePath))];
}

function normalizeRequiredGitPaths(paths: string[]): string[] {
  const normalized = normalizeGitPaths(paths);
  if (normalized.length === 0) {
    throw new Error(
      "GIT_INPUT_INVALID: At least one explicit path is required.",
    );
  }
  return normalized;
}

async function runGit(
  cwd: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024,
  timeoutMs = LOCAL_GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const env = safeGitEnvironment();
    return await spawnGitProcessGroup({
      cwd,
      args: [
        "-c",
        `core.hooksPath=${getEmptyHooksPath()}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "merge.autoStash=false",
        "-c",
        "push.followTags=false",
        "-c",
        "rerere.enabled=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      env,
      maxBuffer,
      timeoutMs,
    });
  } catch (error) {
    const failure = error as Error & {
      stderr?: string;
      stdout?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
      timedOut?: boolean;
    };
    const timedOut = failure.timedOut === true;
    const detail = sanitizeGitOutput(
      String(failure.stderr || failure.stdout || failure.message || ""),
    );
    throw new GitExecutionError({
      message: timedOut
        ? "GIT_TIMEOUT: Git command timed out."
        : `GIT_COMMAND_FAILED: ${detail || "Git command failed."}`,
      stdout: sanitizeGitOutput(String(failure.stdout ?? "")),
      stderr: sanitizeGitOutput(String(failure.stderr ?? "")),
      exitCode: typeof failure.code === "number" ? failure.code : undefined,
      timedOut,
    });
  }
}

function spawnGitProcessGroup(input: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: input.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const terminateProcessGroup = () => {
      if (child.pid && detached) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to killing the direct child if the process group exited.
        }
      }
      child.kill("SIGKILL");
    };

    const capture = (target: Buffer[], chunk: Buffer, isStdout: boolean) => {
      const currentBytes = isStdout ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, input.maxBuffer - currentBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (isStdout) stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (
        !outputLimitExceeded &&
        (stdoutBytes > input.maxBuffer || stderrBytes > input.maxBuffer)
      ) {
        outputLimitExceeded = true;
        terminateProcessGroup();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, false));

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup();
    }, input.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 && !timedOut && !outputLimitExceeded) {
        resolve(result);
        return;
      }
      const error = Object.assign(
        new Error(
          outputLimitExceeded
            ? "Git command output exceeded the configured limit."
            : timedOut
              ? "Git command timed out."
              : `Git command failed with exit code ${String(code)}.`,
        ),
        {
          ...result,
          code: code ?? undefined,
          killed: timedOut || outputLimitExceeded,
          signal: signal ?? undefined,
          timedOut,
        },
      );
      reject(error);
    });
  });
}

async function assertNoExecutableGitFilters(root: string): Promise<void> {
  const configured = await runGit(root, [
    "config",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process)$",
  ]).catch(() => undefined);
  if (configured?.stdout.trim()) {
    throw new Error(
      "GIT_FILTER_REJECTED: Git content filters are not supported by safe write tools.",
    );
  }
}

async function assertNoExecutableMergeDrivers(root: string): Promise<void> {
  const configured = await runGit(root, [
    "config",
    "--get-regexp",
    "^merge\\..*\\.driver$",
  ]).catch(() => undefined);
  if (configured?.stdout.trim()) {
    throw new Error(
      "GIT_MERGE_DRIVER_REJECTED: Custom Git merge drivers are not supported.",
    );
  }
}

async function fetchGitLocked(
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

async function refreshRemoteDestination(
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

async function assertApprovedRemote(
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

async function assertSafeLocalRemoteConfig(
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

function isSafeRemoteUrl(value: string): boolean {
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

async function normalizeSourceRef(
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

async function normalizeDestinationBranch(
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

function isSafeRefText(value: string): boolean {
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

function normalizeExpectedCommitSha(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`GIT_INPUT_INVALID: ${name} must be a full commit SHA.`);
  }
  return value;
}

async function resolveCommit(root: string, ref: string): Promise<string> {
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

async function resolveExactCommit(root: string, ref: string): Promise<string> {
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

async function readOptionalGitRef(
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

async function mergeStateFilesPresent(root: string): Promise<string[]> {
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

async function listRemoteTrackingRefs(
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

async function isAncestor(
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

function assertCleanAttachedWorkspace(status: GitWorkspaceStatus): void {
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

async function withGitMutationLock<T>(
  lockKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = gitMutationTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => tail);
  gitMutationTails.set(lockKey, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (gitMutationTails.get(lockKey) === queued)
      gitMutationTails.delete(lockKey);
  }
}

async function gitMutationLockKey(root: string): Promise<string> {
  const commonDir = (
    await runGit(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).stdout.trim();
  return realpath(commonDir);
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_EXTERNAL_DIFF",
    "GIT_PROXY_COMMAND",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GCM_INTERACTIVE: "Never",
  };
}

function sanitizeGitOutput(value: string): string {
  return Buffer.from(
    value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, "$1[REDACTED]@")
      .replace(
        /([?&](?:access_token|auth|key|password|signature|token)=)[^&\s]+/gi,
        "$1[REDACTED]",
      ),
  )
    .subarray(0, MAX_GIT_OUTPUT_BYTES)
    .toString("utf8")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class GitExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;

  constructor(input: {
    message: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
    timedOut: boolean;
  }) {
    super(input.message);
    this.name = "GitExecutionError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
    this.timedOut = input.timedOut;
  }
}

function getEmptyHooksPath(): string {
  if (emptyHooksPath) return emptyHooksPath;
  emptyHooksPath = mkdtempSync(join(tmpdir(), "devspace-empty-git-hooks-"));
  chmodSync(emptyHooksPath, 0o700);
  return emptyHooksPath;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
