import { execFileSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type RunnerName,
  RUNNER_NAMES,
} from "./runner-registry.js";
import type { ArtifactBaseline } from "./artifact-ledger.js";

export const JOB_RUNNERS = RUNNER_NAMES;
export type JobRunner = RunnerName;

export const DEFAULT_POLL_BYTES = 64 * 1024;
export const MAX_POLL_BYTES = 256 * 1024;
export const DEFAULT_WAIT_SECONDS = 20;
export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_WAIT_OUTPUT_BYTES = 2 * 1024;
export const MAX_WAIT_OUTPUT_BYTES = 8 * 1024;
export const DEFAULT_LIST_JOBS_LIMIT = 10;
export const MAX_LIST_JOBS_LIMIT = 50;

export const VENV_CANDIDATES = [".venv", "venv"];

export interface WorkspacePytestInvocation {
  executable: string;
  argsPrefix: string[];
  venvRoot: string;
  venvScripts: string;
}

export function resolveWorkspacePytestInvocation(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): WorkspacePytestInvocation | undefined {
  for (const name of VENV_CANDIDATES) {
    const venvRoot = join(workspaceRoot, name);
    const venvScripts = join(
      venvRoot,
      platform === "win32" ? "Scripts" : "bin",
    );
    const python = join(
      venvScripts,
      platform === "win32" ? "python.exe" : "python",
    );
    if (!existsSync(python)) continue;

    try {
      // Reject a venv directory that is itself redirected outside the approved
      // workspace. The python launcher may still be a normal system-Python
      // symlink, as created by standard venv tooling.
      if (
        lstatSync(venvRoot).isSymbolicLink() ||
        lstatSync(venvScripts).isSymbolicLink() ||
        !statSync(python).isFile()
      ) {
        continue;
      }
    } catch {
      continue;
    }

    return {
      executable: python,
      argsPrefix: ["-m", "pytest"],
      venvRoot,
      venvScripts,
    };
  }
  return undefined;
}

export type JobStatus =
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type JobArtifactStatus =
  "none" | "pending" | "complete" | "incomplete" | "error";

export type JobErrorCode =
  | "RUNNER_UNAVAILABLE"
  | "JOB_TIMEOUT"
  | "JOB_CANCELLED"
  | "JOB_INTERRUPTED"
  | "BLENDER_FAILED"
  | "HOUDINI_FAILED"
  | "CAPTURE_FAILED"
  | "RUNNER_FAILED";

export interface PersistedJob {
  jobId: string;
  workspaceId: string;
  workspaceRoot: string;
  workingDirectory: string;
  runner: JobRunner;
  runnerVersion?: string;
  args: string[];
  label?: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  exitCode?: number;
  signal?: string;
  outputBytes: number;
  outputTruncated: boolean;
  errorCode?: JobErrorCode;
  error?: string;
  artifactRoots?: string[];
  artifactStatus: JobArtifactStatus;
  artifactCount: number;
  artifactErrors?: string[];
  artifactBaseline?: ArtifactBaseline;
  captureProfile?: string;
  processId?: number;
  processGroupId?: number;
  processPlatform?: NodeJS.Platform;
  processToken?: string;
  processCleanupPending?: boolean;
}

export interface LiveJob extends PersistedJob {
  child?: ChildProcessByStdio<null, Readable, Readable>;
  cancelRequested?: boolean;
  timeoutRequested?: boolean;
  timeoutHandle?: NodeJS.Timeout;
  killHandle?: NodeJS.Timeout;
  artifactFinalizationStarted?: boolean;
}

export interface StartJobInput {
  workspaceId: string;
  workspaceRoot: string;
  workingDirectory: string;
  runner: JobRunner;
  args: string[];
  label?: string;
  timeoutSeconds?: number;
  artifactRoots?: string[];
  captureProfile?: string;
  environment?: Record<string, string>;
}

export interface JobSnapshot extends PersistedJob {
  output?: string;
  outputOffsetBytes?: number;
  nextOutputOffsetBytes?: number;
  outputCursor?: string;
  outputMode?: "range" | "tail";
  outputDiscardedBeforeBytes?: number;
  waitTimedOut?: boolean;
}

export interface ListJobsOptions {
  activeOnly?: boolean;
  limit?: number;
}

export interface BackgroundJobMonitorSnapshot {
  total: number;
  active: number;
  maxConcurrent: number;
  byStatus: Record<JobStatus, number>;
  activeByRunner: Record<JobRunner, number>;
  recentFailures: Array<{
    endedAt: string;
    runner: JobRunner;
    status: Extract<
      JobStatus,
      "failed" | "cancelled" | "timed_out" | "interrupted"
    >;
    errorCode?: JobErrorCode;
  }>;
}

export function failureCode(
  job: Pick<PersistedJob, "runner" | "captureProfile">,
): JobErrorCode {
  if (job.captureProfile) return "CAPTURE_FAILED";
  if (job.runner === "blender") return "BLENDER_FAILED";
  if (job.runner === "hython" || job.runner === "hbatch") {
    return "HOUDINI_FAILED";
  }
  return "RUNNER_FAILED";
}

export function validatedJobEnvironment(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  if (!environment) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      !/^DEVSPACE_CAPTURE_[A-Z0-9_]{1,64}$/.test(key) ||
      typeof value !== "string" ||
      value.length > 4096 ||
      value.includes("\0")
    ) {
      throw new Error("CAPTURE_PROFILE_INVALID: Invalid capture environment.");
    }
    output[key] = value;
  }
  return output;
}

export function isTerminal(status: JobStatus): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(status);
}

export function isSettled(job: LiveJob): boolean {
  return isTerminal(job.status) && job.artifactStatus !== "pending";
}

export function validateWaitArguments(waitSeconds: number, maxBytes: number): void {
  if (
    !Number.isInteger(waitSeconds) ||
    waitSeconds < 1 ||
    waitSeconds > MAX_WAIT_SECONDS
  ) {
    throw new Error(`waitSeconds must be between 1 and ${MAX_WAIT_SECONDS}.`);
  }
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_WAIT_OUTPUT_BYTES
  ) {
    throw new Error(`maxBytes must be between 1 and ${MAX_WAIT_OUTPUT_BYTES}.`);
  }
}

export function encodeOutputCursor(jobId: string, offsetBytes: number): string {
  return `jobc_${Buffer.from(
    JSON.stringify({ jobId, offsetBytes }),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeOutputCursor(
  cursor: string,
  expectedJobId: string,
  logBytes: number,
): number {
  if (!/^jobc_[A-Za-z0-9_-]{1,256}$/.test(cursor)) {
    throw new Error("Invalid outputCursor.");
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor.slice(5), "base64url").toString("utf8"),
    ) as { jobId?: unknown; offsetBytes?: unknown };
    if (
      decoded.jobId !== expectedJobId ||
      !Number.isSafeInteger(decoded.offsetBytes) ||
      (decoded.offsetBytes as number) < 0 ||
      (decoded.offsetBytes as number) > logBytes
    ) {
      throw new Error("mismatch");
    }
    return decoded.offsetBytes as number;
  } catch {
    throw new Error("Invalid outputCursor.");
  }
}

export function processSignalTarget(job: LiveJob): number | undefined {
  const processId = job.processId;
  const processGroupId = job.processGroupId;
  if (
    job.processPlatform !== process.platform ||
    !Number.isSafeInteger(processId) ||
    (processId ?? 0) <= 1
  ) {
    return undefined;
  }
  if (process.platform === "win32") {
    return job.child?.pid === processId ? processId : undefined;
  }
  if (!Number.isSafeInteger(processGroupId) || processGroupId !== processId) {
    return undefined;
  }
  const attachedChildMatches = job.child?.pid === processId;
  if (
    !attachedChildMatches &&
    (!job.processToken ||
      !processGroupContainsToken(processGroupId as number, job.processToken))
  ) {
    return undefined;
  }
  return -(processGroupId as number);
}

export function processGroupContainsToken(
  processGroupId: number,
  processToken: string,
): boolean {
  try {
    const processRows = execFileSync("ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const row of processRows.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
      if (!match || Number(match[2]) !== processGroupId) continue;
      const environment = execFileSync(
        "ps",
        ["eww", "-p", match[1], "-o", "command="],
        {
          encoding: "utf8",
          timeout: 1_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (environment.includes(`DEVSPACE_PROCESS_TOKEN=${processToken}`)) {
        return true;
      }
    }
  } catch {
    // Refuse to signal when process identity cannot be confirmed.
  }
  return false;
}

export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EPERM"
  );
}

export function validateJobId(jobId: string): void {
  if (!/^job_[0-9a-f-]{36}$/.test(jobId)) {
    throw new Error("Invalid jobId.");
  }
}
