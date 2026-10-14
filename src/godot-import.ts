import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { GODOT_IMPORT_MIN_TIMEOUT_SECONDS } from "./config.js";
import {
  GODOT_EDITOR_IMPORT_ARGUMENT_POLICY,
  GODOT_EDITOR_IMPORT_ARGS,
} from "./runner-validation.js";
import { isPathInsideRoot } from "./roots.js";
import { inspectGitStatus } from "./git-tools.js";
import { MAX_JOB_OUTPUT_BYTES } from "./runner-registry.js";
import { MAX_WAIT_SECONDS } from "./background-jobs-types.js";
import type { BackgroundJobManager, JobSnapshot } from "./background-jobs.js";
import type { RunnerRegistry } from "./runner-registry.js";
import type { Workspace } from "./workspace-types.js";

export const GODOT_IMPORT_PROJECT_FILE = "project.godot";

export interface GodotImportProject {
  root: string;
  projectFile: string;
  policyRoot: string;
  mode: Workspace["mode"];
  sourceRoot?: string;
  managedWorktree: boolean;
  branch: string | null;
  headSha: string;
  cleanBefore: boolean;
  dirtyTrackedBefore: string[];
  untrackedBefore: string[];
}

export interface GodotImportErrorCensus {
  errorCount: number;
  errorLines: string[];
  importFailureCount: number;
  importFailureLines: string[];
  scriptErrorCount: number;
  scriptErrorLines: string[];
  truncated: boolean;
}

export interface GodotImportAfterState {
  headSha: string;
  branch: string | null;
  clean: boolean;
  dirtyTracked: string[];
  untracked: string[];
  headUnchanged: boolean;
  branchUnchanged: boolean;
  trackedFilesUnchanged: boolean;
  /** Untracked paths that did not exist before the import. */
  newUntrackedPaths: string[];
  /**
   * Import output written outside the `.godot/` import cache. Godot writes
   * `.uid` sidecar files next to scripts and shaders; they are new untracked
   * files, never edits to tracked files, and must be reviewed by the operator.
   */
  generatedOutsideImportCache: string[];
}

export interface GodotImportRecordSnapshot {
  jobId: string;
  workspaceId: string;
  projectRoot: string;
  projectKey: string;
  projectFile: string;
  startedAt: string;
  settledAt?: string;
  status: "running" | "settled";
  timeoutSeconds: number;
  engineVersion?: string;
  executable: string;
  args: string[];
  argumentPolicy: string;
  headShaBefore: string;
  branchBefore: string | null;
  dirtyTrackedBefore: string[];
  untrackedBefore: string[];
  managedWorktree: boolean;
  mode: Workspace["mode"];
  sourceRoot?: string;
  cleanBefore: boolean;
}

export interface GodotImportRunResult {
  import: GodotImportRecordSnapshot;
  job: JobSnapshot;
  census?: GodotImportErrorCensus;
  after?: GodotImportAfterState;
  anomaly?: string;
}

const MAX_REPORTS = 64;
const MAX_CENSUS_LINES = 40;

/**
 * Tracks in-flight Godot editor imports per canonical project root so two
 * concurrent imports of the same project can never run simultaneously, and
 * keeps a bounded record of recent imports so a caller can re-read a bounded
 * report by job id after a client interruption.
 */
export class GodotImportRegistry {
  private readonly active = new Map<string, GodotImportRecordSnapshot>();
  private readonly reports = new Map<string, GodotImportRecordSnapshot>();

  activeForProject(
    projectKey: string,
  ): GodotImportRecordSnapshot | undefined {
    return copyRecord(this.active.get(projectKey));
  }

  begin(record: GodotImportRecordSnapshot): void {
    const existing = this.active.get(record.projectKey);
    if (existing) {
      throw new Error(
        `GODOT_IMPORT_ALREADY_RUNNING: Project ${record.projectRoot} already has a Godot import job in flight (${existing.jobId}). Wait for it with wait_job before starting another.`,
      );
    }
    this.active.set(record.projectKey, record);
    this.reports.set(record.jobId, record);
    this.pruneReports();
  }

  get(jobId: string): GodotImportRecordSnapshot | undefined {
    return copyRecord(this.reports.get(jobId));
  }

  /** Drops active locks whose backing background job already settled. */
  sweep(jobs: BackgroundJobManager): GodotImportRecordSnapshot[] {
    const settled: GodotImportRecordSnapshot[] = [];
    if (this.active.size === 0) return settled;
    for (const [projectKey, record] of [...this.active.entries()]) {
      const status = jobStatus(jobs, record.jobId);
      if (status === undefined || isTerminalJobStatus(status)) {
        this.settle(record.jobId);
        settled.push(copyRecord(record)!);
        void projectKey;
      }
    }
    return settled;
  }

  /** Releases one specific job's lock after the caller observed it settle. */
  release(jobId: string): void {
    this.settle(jobId);
  }

  private settle(jobId: string): void {
    const record = this.reports.get(jobId);
    if (!record) return;
    if (record.status !== "settled") {
      record.status = "settled";
      record.settledAt = new Date().toISOString();
      this.reports.set(jobId, record);
    }
    if (this.active.get(record.projectKey)?.jobId === jobId) {
      this.active.delete(record.projectKey);
    }
  }

  private pruneReports(): void {
    if (this.reports.size <= MAX_REPORTS) return;
    for (const [jobId, record] of [...this.reports.entries()]) {
      if (this.reports.size <= MAX_REPORTS) break;
      if (record.status === "running") continue;
      this.reports.delete(jobId);
    }
  }
}

function copyRecord(
  record: GodotImportRecordSnapshot | undefined,
): GodotImportRecordSnapshot | undefined {
  if (!record) return undefined;
  return {
    ...record,
    args: [...record.args],
    dirtyTrackedBefore: [...record.dirtyTrackedBefore],
    untrackedBefore: [...record.untrackedBefore],
  };
}

function jobStatus(
  jobs: BackgroundJobManager,
  jobId: string,
): JobSnapshot["status"] | undefined {
  try {
    return jobs.poll(jobId, 0, 1).status;
  } catch {
    return undefined;
  }
}

export function isTerminalJobStatus(status: JobSnapshot["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

export function godotProjectKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

function projectFromRecord(
  record: GodotImportRecordSnapshot,
): GodotImportProject {
  return {
    root: record.projectRoot,
    projectFile: record.projectFile,
    policyRoot: record.sourceRoot ?? record.projectRoot,
    mode: record.mode,
    sourceRoot: record.sourceRoot,
    managedWorktree: record.managedWorktree,
    branch: record.branchBefore,
    headSha: record.headShaBefore,
    cleanBefore: record.cleanBefore,
    dirtyTrackedBefore: [...record.dirtyTrackedBefore],
    untrackedBefore: [...record.untrackedBefore],
  };
}

/**
 * Resolves and validates the Godot import policy for one workspace. The
 * project root is always the workspace root: `godot_import` accepts no path
 * argument, so there is no caller-controlled path to traverse or symlink.
 */
export async function resolveGodotImportProject(
  config: ServerConfig,
  workspace: Pick<Workspace, "root" | "mode" | "sourceRoot" | "worktree">,
): Promise<GodotImportProject> {
  if (!config.godotImport.enabled) {
    throw new Error(
      "GODOT_IMPORT_POLICY_DISABLED: The operator Godot import policy is disabled.",
    );
  }
  const policyRoot = workspace.sourceRoot ?? workspace.root;
  if (!config.godotImport.approvedProjectRoots.includes(policyRoot)) {
    throw new Error(
      "GODOT_PROJECT_NOT_APPROVED: Workspace project is not approved for Godot import.",
    );
  }

  const rawRoot = resolve(workspace.root);
  const rootStat = safeLstat(rawRoot);
  if (!rootStat?.isDirectory()) {
    throw new Error(
      "GODOT_PROJECT_NOT_FOUND: Workspace root is not a directory.",
    );
  }
  const root = realpathSync(rawRoot);
  const projectFile = join(root, GODOT_IMPORT_PROJECT_FILE);
  const projectStat = safeLstat(projectFile);
  if (!projectStat?.isFile()) {
    throw new Error(
      `GODOT_PROJECT_NOT_FOUND: ${GODOT_IMPORT_PROJECT_FILE} was not found at the workspace root.`,
    );
  }
  const canonicalProjectFile = realpathSync(projectFile);
  if (!isPathInsideRoot(canonicalProjectFile, root)) {
    throw new Error(
      "GODOT_PROJECT_ESCAPE: project.godot resolves outside the workspace root.",
    );
  }

  const status = await inspectGitStatus(root);
  const managedWorktree =
    workspace.mode === "worktree" && workspace.worktree?.managed === true;
  if (!managedWorktree && !status.clean) {
    throw new Error(
      `GODOT_IMPORT_WORKSPACE_NOT_TRUSTED: A non-managed checkout must be clean before an editor import. staged=${status.staged.length}, unstaged=${status.unstaged.length}, untracked=${status.untracked.length}, conflicts=${status.conflicts.length}.`,
    );
  }

  return {
    root,
    projectFile: canonicalProjectFile,
    policyRoot,
    mode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
    managedWorktree,
    branch: status.branch ?? null,
    headSha: status.headSha,
    cleanBefore: status.clean,
    dirtyTrackedBefore: [...status.staged, ...status.unstaged].sort(),
    untrackedBefore: [...status.untracked].sort(),
  };
}

export function godotImportTimeoutSeconds(
  config: ServerConfig,
  requested: number | undefined,
): number {
  const value = requested ?? config.godotImport.defaultTimeoutSeconds;
  if (
    !Number.isInteger(value) ||
    value < GODOT_IMPORT_MIN_TIMEOUT_SECONDS ||
    value > config.godotImport.maxTimeoutSeconds
  ) {
    throw new Error(
      `GODOT_IMPORT_INPUT_INVALID: timeoutSeconds must be between ${GODOT_IMPORT_MIN_TIMEOUT_SECONDS} and ${config.godotImport.maxTimeoutSeconds}.`,
    );
  }
  return value;
}

export async function startGodotImport(input: {
  config: ServerConfig;
  workspace: Pick<
    Workspace,
    "id" | "root" | "mode" | "sourceRoot" | "worktree"
  >;
  jobs: BackgroundJobManager;
  runners: RunnerRegistry;
  registry: GodotImportRegistry;
  timeoutSeconds?: number;
  waitSeconds?: number;
}): Promise<GodotImportRunResult> {
  const {
    config,
    workspace,
    jobs,
    runners,
    registry,
    timeoutSeconds,
    waitSeconds,
  } = input;

  registry.sweep(jobs);
  const project = await resolveGodotImportProject(config, workspace);
  const projectKey = godotProjectKey(project.root);
  const active = registry.activeForProject(projectKey);
  if (active) {
    throw new Error(
      `GODOT_IMPORT_ALREADY_RUNNING: Project ${project.root} already has a Godot import job in flight (${active.jobId}). Wait for it with wait_job before starting another.`,
    );
  }

  const resolvedRunner = await runners.resolve(config.godotImport.runner);
  const effectiveTimeout = godotImportTimeoutSeconds(config, timeoutSeconds);
  const args = [...GODOT_EDITOR_IMPORT_ARGS];

  const job = await jobs.start({
    workspaceId: workspace.id,
    workspaceRoot: project.root,
    workingDirectory: project.root,
    runner: config.godotImport.runner,
    args,
    label: "godot-import",
    timeoutSeconds: effectiveTimeout,
    godotEditorImport: true,
  });

  registry.begin({
    jobId: job.jobId,
    workspaceId: workspace.id,
    projectRoot: project.root,
    projectKey,
    projectFile: project.projectFile,
    startedAt: job.startedAt,
    status: "running",
    timeoutSeconds: effectiveTimeout,
    engineVersion: resolvedRunner.version,
    executable: resolvedRunner.executable,
    args,
    argumentPolicy: GODOT_EDITOR_IMPORT_ARGUMENT_POLICY,
    headShaBefore: project.headSha,
    branchBefore: project.branch,
    dirtyTrackedBefore: [...project.dirtyTrackedBefore],
    untrackedBefore: [...project.untrackedBefore],
    managedWorktree: project.managedWorktree,
    mode: project.mode,
    sourceRoot: project.sourceRoot,
    cleanBefore: project.cleanBefore,
  });

  return finishGodotImportReport({
    jobs,
    registry,
    jobId: job.jobId,
    waitSeconds,
  });
}

/**
 * Waits (bounded) for an already tracked import job, then produces the bounded
 * report: exit code, Godot ERROR census, import-failure census, and the
 * tracked-file / Git-reference comparison required by the import policy.
 */
export async function finishGodotImportReport(input: {
  jobs: BackgroundJobManager;
  registry: GodotImportRegistry;
  jobId: string;
  waitSeconds?: number;
}): Promise<GodotImportRunResult> {
  const { jobs, registry, jobId, waitSeconds } = input;
  const recordBefore = registry.get(jobId);
  if (!recordBefore) {
    throw new Error(
      `GODOT_IMPORT_JOB_UNKNOWN: ${jobId} was not started by godot_import.`,
    );
  }
  const project = projectFromRecord(recordBefore);

  const effectiveWait = Math.max(0, Math.min(waitSeconds ?? 1, 600));
  let job = jobs.poll(jobId, 0, 1);
  if (!isTerminalJobStatus(job.status) && effectiveWait > 0) {
    // `BackgroundJobManager.wait` caps a single wait at MAX_WAIT_SECONDS (30),
    // so a longer bounded wait is expressed as consecutive slices.
    const deadline = Date.now() + effectiveWait * 1000;
    while (!isTerminalJobStatus(job.status)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const sliceSeconds = Math.max(
        1,
        Math.min(MAX_WAIT_SECONDS, Math.ceil(remainingMs / 1000)),
      );
      job = await jobs.wait(jobId, undefined, sliceSeconds, 8 * 1024);
    }
  }
  if (isTerminalJobStatus(job.status)) {
    registry.release(jobId);
  }

  const census = isTerminalJobStatus(job.status)
    ? censusGodotImportLog(jobs.readLogFromStart(jobId))
    : undefined;

  let after: GodotImportAfterState | undefined;
  let anomaly: string | undefined;
  if (isTerminalJobStatus(job.status)) {
    const status = await inspectGitStatus(project.root);
    const dirtyTracked = [...status.staged, ...status.unstaged].sort();
    const untracked = [...status.untracked].sort();
    const trackedFilesUnchanged =
      JSON.stringify(dirtyTracked) ===
      JSON.stringify(project.dirtyTrackedBefore);
    const beforeUntracked = new Set(project.untrackedBefore);
    const newUntrackedPaths = untracked.filter(
      (path) => !beforeUntracked.has(path),
    );
    after = {
      headSha: status.headSha,
      branch: status.branch ?? null,
      clean: status.clean,
      dirtyTracked,
      untracked,
      headUnchanged: status.headSha === project.headSha,
      branchUnchanged: (status.branch ?? null) === project.branch,
      trackedFilesUnchanged,
      newUntrackedPaths,
      generatedOutsideImportCache: newUntrackedPaths.filter(
        (path) => !path.startsWith(".godot/") && path !== ".godot",
      ),
    };
    if (!after.headUnchanged || !after.branchUnchanged) {
      anomaly =
        "GODOT_IMPORT_CHANGED_GIT_REFERENCES: The import changed HEAD or the checked-out branch. Stop automatic follow-up work and inspect the workspace.";
    } else if (!trackedFilesUnchanged) {
      anomaly =
        "GODOT_IMPORT_MODIFIED_TRACKED_FILES: The import modified tracked files. Stop automatic follow-up work, inspect the diff, and do not auto-revert.";
    }
  }

  return {
    import: registry.get(jobId)!,
    job: boundedJob(job),
    census,
    after,
    anomaly,
  };
}

export function boundedJob(job: JobSnapshot): JobSnapshot {
  const { output, ...rest } = job;
  return { ...rest, output: output?.slice(-2000) };
}

export function censusGodotImportLog(log: string): GodotImportErrorCensus {
  const text = stripAnsi(log);
  const lines = text.split(/\r?\n/);
  const errorLines: string[] = [];
  const importFailureLines: string[] = [];
  const scriptErrorLines: string[] = [];
  let errorCount = 0;
  let importFailureCount = 0;
  let scriptErrorCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (isScriptErrorLine(line)) {
      scriptErrorCount += 1;
      pushBounded(scriptErrorLines, line);
      continue;
    }
    if (isErrorLine(line)) {
      errorCount += 1;
      pushBounded(errorLines, line);
      continue;
    }
    if (isImportFailureLine(line)) {
      importFailureCount += 1;
      pushBounded(importFailureLines, line);
    }
  }

  return {
    errorCount,
    errorLines,
    importFailureCount,
    importFailureLines,
    scriptErrorCount,
    scriptErrorLines,
    truncated:
      errorCount > errorLines.length ||
      importFailureCount > importFailureLines.length ||
      scriptErrorCount > scriptErrorLines.length,
  };
}

function pushBounded(target: string[], line: string): void {
  if (target.length >= MAX_CENSUS_LINES) return;
  target.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
}

function isErrorLine(line: string): boolean {
  return /^(?:ERROR|FATAL|CRITICAL):/i.test(line) || /\bERROR:/.test(line);
}

function isScriptErrorLine(line: string): boolean {
  return /^(?:SCRIPT ERROR|USER ERROR|USER SCRIPT ERROR):/i.test(line);
}

function isImportFailureLine(line: string): boolean {
  return (
    /Failed to (?:load|open|import|parse|compile|instantiate)/i.test(line) ||
    /Cannot open file/i.test(line) ||
    /Error importing/i.test(line) ||
    /Failed loading resource/i.test(line) ||
    /No loader found for resource/i.test(line)
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
