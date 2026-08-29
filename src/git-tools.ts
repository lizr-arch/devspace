import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeWorkspaceRelativePath } from "./workspace-paths.js";

import {
  MAX_DIFF_BYTES,
  MAX_GIT_PATHS,
  LOCAL_GIT_TIMEOUT_MS,
  REMOTE_GIT_TIMEOUT_MS,
  MAX_GIT_OUTPUT_BYTES,
  type GitWorkspaceStatus,
  type GitDiffResult,
  type GitFetchResult,
  type GitMergeResult,
  type GitPushResult,
} from "./git-types.js";
import {
  fetchGit,
  mergeGit,
  pushGit,
} from "./git-remote.js";

export {
  MAX_DIFF_BYTES,
  MAX_GIT_PATHS,
  LOCAL_GIT_TIMEOUT_MS,
  REMOTE_GIT_TIMEOUT_MS,
  MAX_GIT_OUTPUT_BYTES,
  type GitWorkspaceStatus,
  type GitDiffResult,
  type GitFetchResult,
  type GitMergeResult,
  type GitPushResult,
  fetchGit,
  mergeGit,
  pushGit,
};

let emptyHooksPath: string | undefined;
const gitMutationTails = new Map<string, Promise<void>>();

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
  await assertNoEffectiveGitFilters(root, normalized);
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

export async function runGit(
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

async function assertNoEffectiveGitFilters(
  root: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;

  const { stdout } = await runGit(root, [
    "check-attr",
    "-z",
    "filter",
    "diff",
    "merge",
    "working-tree-encoding",
    "--",
    ...paths,
  ]);

  const byPath = parseCheckAttrOutput(stdout);
  const filterNames = new Set<string>();
  const diffNames = new Set<string>();
  const mergeNames = new Set<string>();
  const pathsWithWte: string[] = [];

  for (const [path, attrs] of byPath) {
    const filterVal = attrs.get("filter");
    if (filterVal && filterVal !== "unspecified" && filterVal !== "unset") {
      filterNames.add(filterVal);
    }
    const diffVal = attrs.get("diff");
    if (
      diffVal &&
      diffVal !== "unspecified" &&
      diffVal !== "unset" &&
      diffVal !== "set"
    ) {
      diffNames.add(diffVal);
    }
    const mergeVal = attrs.get("merge");
    if (
      mergeVal &&
      mergeVal !== "unspecified" &&
      mergeVal !== "unset" &&
      mergeVal !== "set"
    ) {
      mergeNames.add(mergeVal);
    }
    const wteVal = attrs.get("working-tree-encoding");
    if (wteVal && wteVal !== "unspecified" && wteVal !== "unset") {
      pathsWithWte.push(path);
    }
  }

  if (pathsWithWte.length > 0) {
    throw new Error(
      `GIT_FILTER_REJECTED: Unsupported working-tree-encoding attribute on: ${pathsWithWte.join(", ")}.`,
    );
  }

  if (filterNames.size > 0) {
    for (const name of filterNames) {
      const configured = await runGit(root, [
        "config",
        "--local",
        "--get-regexp",
        `^filter\\.${escapeRegex(name)}\\.(clean|smudge|process)$`,
      ]).catch(() => undefined);
      if (configured?.stdout.trim()) {
        throw new Error(
          `GIT_FILTER_REJECTED: Paths use filter "${name}" which has an executable driver configured. Safe staging does not support external content filters.`,
        );
      }
    }
  }

  if (diffNames.size > 0) {
    for (const name of diffNames) {
      const configured = await runGit(root, [
        "config",
        "--local",
        "--get",
        `diff.${name}.command`,
      ]).catch(() => undefined);
      if (configured?.stdout.trim()) {
        throw new Error(
          `GIT_FILTER_REJECTED: Paths use diff driver "${name}" which has an external command configured. Safe staging does not support external diff drivers.`,
        );
      }
    }
  }

  if (mergeNames.size > 0) {
    for (const name of mergeNames) {
      const configured = await runGit(root, [
        "config",
        "--local",
        "--get",
        `merge.${name}.driver`,
      ]).catch(() => undefined);
      if (configured?.stdout.trim()) {
        throw new Error(
          `GIT_FILTER_REJECTED: Paths use merge driver "${name}" which has an external driver configured. Safe staging does not support external merge drivers.`,
        );
      }
    }
  }
}

function parseCheckAttrOutput(
  output: string,
): Map<string, Map<string, string>> {
  const parts = output.split("\0");
  const result = new Map<string, Map<string, string>>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const path = parts[i];
    const attr = parts[i + 1];
    const info = parts[i + 2];
    if (!path || !attr) continue;
    if (!result.has(path)) result.set(path, new Map());
    result.get(path)!.set(attr, info);
  }
  return result;
}

export async function assertNoExecutableGitFilters(root: string): Promise<void> {
  const configured = await runGit(root, [
    "config",
    "--local",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process)$",
  ]).catch(() => undefined);
  if (configured?.stdout.trim()) {
    throw new Error(
      "GIT_FILTER_REJECTED: Git content filters are not supported by safe write tools.",
    );
  }
}

export async function assertNoExecutableMergeDrivers(root: string): Promise<void> {
  const configured = await runGit(root, [
    "config",
    "--local",
    "--get-regexp",
    "^merge\\..*\\.driver$",
  ]).catch(() => undefined);
  if (configured?.stdout.trim()) {
    throw new Error(
      "GIT_MERGE_DRIVER_REJECTED: Custom Git merge drivers are not supported.",
    );
  }
}

export async function withGitMutationLock<T>(
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

export async function gitMutationLockKey(root: string): Promise<string> {
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

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class GitExecutionError extends Error {
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
