import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { normalizeWorkspaceRelativePath } from "./workspace-paths.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_GIT_PATHS = 100;

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
}): Promise<{
  current?: string;
  branches: string[];
  action: "list" | "create" | "switch";
}> {
  const root = await assertWorkspaceGitRoot(input.workspaceRoot);
  if (input.action !== "list") {
    if (!input.name) {
      throw new Error("GIT_INPUT_INVALID: Branch name is required.");
    }
    await runGit(root, ["check-ref-format", "--branch", input.name]);
    if (input.action === "create") {
      await runGit(root, ["branch", "--", input.name, "HEAD"]);
    } else {
      const status = await inspectGitStatus(root);
      if (!status.clean) {
        throw new Error(
          "GIT_DIRTY: Switching branches requires a clean workspace.",
        );
      }
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
    branches,
    action: input.action,
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
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error
        ? String((error as Error & { stderr?: string }).stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`GIT_COMMAND_FAILED: ${detail || "Git command failed."}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
