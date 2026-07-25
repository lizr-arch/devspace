import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
  RUNNER_NAMES,
  RunnerRegistry,
  validateRunnerArguments,
  type RunnerName,
} from "./runner-registry.js";
import { ArtifactLedger, type ArtifactBaseline } from "./artifact-ledger.js";

export const JOB_RUNNERS = RUNNER_NAMES;
export type JobRunner = RunnerName;
export {
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
};

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

export const DEFAULT_POLL_BYTES = 64 * 1024;
export const MAX_POLL_BYTES = 256 * 1024;

interface PersistedJob {
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
  error?: string;
  artifactRoots?: string[];
  artifactStatus: JobArtifactStatus;
  artifactCount: number;
  artifactErrors?: string[];
  artifactBaseline?: ArtifactBaseline;
  captureProfile?: string;
}

interface LiveJob extends PersistedJob {
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
}

export class BackgroundJobManager {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly jobsDir: string;
  private initialized = false;

  constructor(
    private readonly stateDir: string,
    private readonly runners = new RunnerRegistry(),
    private readonly artifacts = new ArtifactLedger(stateDir),
  ) {
    this.jobsDir = join(stateDir, "jobs");
  }

  async start(input: StartJobInput): Promise<JobSnapshot> {
    this.initialize();
    if (this.runningCount() >= MAX_CONCURRENT_JOBS) {
      throw new Error(
        `At most ${MAX_CONCURRENT_JOBS} background jobs may run concurrently.`,
      );
    }
    const definition = this.runners.getDefinition(input.runner);
    if (this.runningCount(input.runner) >= definition.maxConcurrent) {
      throw new Error(
        `At most ${definition.maxConcurrent} ${input.runner} job(s) may run concurrently.`,
      );
    }
    this.runners.validateArguments(input.runner, input.args, {
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workingDirectory,
    });
    const timeoutSeconds =
      input.timeoutSeconds ?? definition.defaultTimeoutSeconds;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > definition.maxTimeoutSeconds
    ) {
      throw new Error(
        `timeoutSeconds must be between 1 and ${definition.maxTimeoutSeconds} for ${input.runner}.`,
      );
    }
    if (input.label !== undefined && input.label.length > 200) {
      throw new Error("Job label must be at most 200 characters.");
    }

    const resolvedRunner = await this.runners.resolve(input.runner);
    const artifactBaseline = input.artifactRoots
      ? this.artifacts.captureBaseline(input.workspaceRoot, input.artifactRoots)
      : undefined;
    const jobId = `job_${randomUUID()}`;
    const job: LiveJob = {
      jobId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workingDirectory,
      runner: input.runner,
      runnerVersion: resolvedRunner.version,
      args: [...input.args],
      label: input.label,
      status: "running",
      startedAt: new Date().toISOString(),
      timeoutSeconds,
      maxOutputBytes: definition.maxOutputBytes,
      outputBytes: 0,
      outputTruncated: false,
      artifactRoots: artifactBaseline?.roots,
      artifactStatus: artifactBaseline ? "pending" : "none",
      artifactCount: 0,
      artifactBaseline,
      captureProfile: input.captureProfile,
    };

    writeFileSync(this.logPath(jobId), "", { mode: 0o600 });
    this.jobs.set(jobId, job);
    this.persist(job);

    try {
      const child = spawn(resolvedRunner.executable, input.args, {
        cwd: input.workingDirectory,
        env: {
          ...process.env,
          ...validatedJobEnvironment(input.environment),
          DEVSPACE_JOB_ID: jobId,
        },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      child.stdout.on("data", (chunk: Buffer | string) =>
        this.appendOutput(job, chunk),
      );
      child.stderr.on("data", (chunk: Buffer | string) =>
        this.appendOutput(job, chunk),
      );
      child.once("error", (error) => {
        job.error = error.message;
      });
      child.once("exit", (code, signal) => {
        this.finalize(job, code, signal);
      });
      job.timeoutHandle = setTimeout(() => {
        if (job.status !== "running") return;
        job.timeoutRequested = true;
        job.status = "cancelling";
        this.persist(job);
        this.terminate(job);
      }, timeoutSeconds * 1000);
    } catch (error) {
      job.status = "failed";
      job.endedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      this.persist(job);
      void this.finalizeArtifacts(job);
      throw error;
    }

    return publicSnapshot(job);
  }

  poll(
    jobId: string,
    offsetBytes = 0,
    maxBytes = DEFAULT_POLL_BYTES,
  ): JobSnapshot {
    this.initialize();
    validateJobId(jobId);
    if (!Number.isInteger(offsetBytes) || offsetBytes < 0) {
      throw new Error("offsetBytes must be a non-negative integer.");
    }
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_POLL_BYTES
    ) {
      throw new Error(`maxBytes must be between 1 and ${MAX_POLL_BYTES}.`);
    }

    const job = this.getJob(jobId);
    const log = existsSync(this.logPath(jobId))
      ? readFileSync(this.logPath(jobId))
      : Buffer.alloc(0);
    const start = Math.min(offsetBytes, log.length);
    const end = Math.min(start + maxBytes, log.length);

    return {
      ...publicSnapshot(job),
      output: log.subarray(start, end).toString("utf8"),
      outputOffsetBytes: start,
      nextOutputOffsetBytes: end,
    };
  }

  cancel(jobId: string): JobSnapshot {
    this.initialize();
    validateJobId(jobId);
    const job = this.getJob(jobId);
    if (isTerminal(job.status)) return publicSnapshot(job);
    if (!job.child) {
      throw new Error(
        "This job is not attached to the current server process and cannot be cancelled.",
      );
    }

    job.cancelRequested = true;
    job.status = "cancelling";
    this.persist(job);
    this.terminate(job);
    return publicSnapshot(job);
  }

  close(): void {
    this.initialize();
    for (const job of this.jobs.values()) {
      if (isTerminal(job.status)) continue;
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      if (job.killHandle) clearTimeout(job.killHandle);
      this.signalProcess(job, "SIGTERM");
      job.status = "interrupted";
      job.endedAt = new Date().toISOString();
      job.error = "DevSpace stopped while the job was running.";
      this.persist(job);
    }
  }

  private initialize(): void {
    if (this.initialized) return;
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.jobsDir, 0o700);

    for (const entry of readdirSync(this.jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          readFileSync(join(this.jobsDir, entry), "utf8"),
        ) as PersistedJob;
        validateJobId(parsed.jobId);
        const job: LiveJob = {
          ...parsed,
          artifactStatus: parsed.artifactStatus ?? "none",
          artifactCount: parsed.artifactCount ?? 0,
        };
        if (job.status === "running" || job.status === "cancelling") {
          job.status = "interrupted";
          job.endedAt = new Date().toISOString();
          job.error = "DevSpace restarted while the job was running.";
          this.persist(job);
        }
        this.jobs.set(job.jobId, job);
        if (
          job.artifactStatus === "pending" &&
          job.artifactBaseline &&
          job.artifactRoots
        ) {
          queueMicrotask(() => {
            void this.finalizeArtifacts(job);
          });
        }
      } catch {
        // Ignore malformed state files rather than trusting unvalidated data.
      }
    }
    this.initialized = true;
  }

  private getJob(jobId: string): LiveJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown jobId: ${jobId}.`);
    return job;
  }

  private runningCount(runner?: JobRunner): number {
    return Array.from(this.jobs.values()).filter(
      (job) =>
        (!runner || job.runner === runner) &&
        (job.status === "running" || job.status === "cancelling"),
    ).length;
  }

  private appendOutput(job: LiveJob, chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining =
      (job.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES) - job.outputBytes;
    if (remaining <= 0) {
      job.outputTruncated = true;
      return;
    }
    const accepted = data.subarray(0, remaining);
    appendFileSync(this.logPath(job.jobId), accepted, { mode: 0o600 });
    job.outputBytes += accepted.length;
    if (accepted.length < data.length) job.outputTruncated = true;
  }

  private terminate(job: LiveJob): void {
    this.signalProcess(job, "SIGTERM");
    job.killHandle = setTimeout(() => {
      if (!isTerminal(job.status)) this.signalProcess(job, "SIGKILL");
    }, 3_000);
  }

  private signalProcess(job: LiveJob, signal: NodeJS.Signals): void {
    const pid = job.child?.pid;
    if (!pid) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall back to the direct child if the process group already changed.
      }
    }
    job.child?.kill(signal);
  }

  private finalize(
    job: LiveJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    if (job.killHandle) clearTimeout(job.killHandle);
    job.exitCode = code ?? undefined;
    job.signal = signal ?? undefined;
    job.endedAt = new Date().toISOString();
    if (job.timeoutRequested) {
      job.status = "timed_out";
    } else if (job.cancelRequested) {
      job.status = "cancelled";
    } else if (code === 0) {
      job.status = "succeeded";
    } else {
      job.status = "failed";
      if (!job.error) {
        job.error = `Process exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
      }
    }
    job.child = undefined;
    this.persist(job);
    void this.finalizeArtifacts(job);
  }

  private persist(job: LiveJob): void {
    const persisted = {
      ...publicSnapshot(job),
      artifactBaseline: job.artifactBaseline,
    };
    const target = this.metadataPath(job.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(persisted, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, target);
  }

  private metadataPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.json`);
  }

  private logPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.log`);
  }

  private async finalizeArtifacts(job: LiveJob): Promise<void> {
    if (
      job.artifactFinalizationStarted ||
      job.artifactStatus !== "pending" ||
      !job.artifactBaseline ||
      !job.artifactRoots
    ) {
      return;
    }
    job.artifactFinalizationStarted = true;
    try {
      const discovered = await this.artifacts.discoverArtifacts({
        workspaceId: job.workspaceId,
        workspaceRoot: job.workspaceRoot,
        jobId: job.jobId,
        runner: job.runner,
        runnerVersion: job.runnerVersion,
        status: job.status,
        artifactRoots: job.artifactRoots,
        baseline: job.artifactBaseline,
      });
      job.artifactCount = discovered.artifacts.length;
      job.artifactErrors =
        discovered.errors.length > 0
          ? discovered.errors.slice(0, 20)
          : undefined;
      job.artifactStatus =
        discovered.errors.length > 0
          ? "error"
          : discovered.completion === "complete"
            ? "complete"
            : "incomplete";
    } catch (error) {
      job.artifactStatus = "error";
      job.artifactErrors = [
        error instanceof Error ? error.message : String(error),
      ];
    } finally {
      job.artifactBaseline = undefined;
      this.persist(job);
    }
  }
}

export function validateJobArguments(runner: JobRunner, args: string[]): void {
  validateRunnerArguments(runner, args);
}

function publicSnapshot(job: LiveJob): PersistedJob {
  return {
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    workspaceRoot: job.workspaceRoot,
    workingDirectory: job.workingDirectory,
    runner: job.runner,
    runnerVersion: job.runnerVersion,
    args: [...job.args],
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    timeoutSeconds: job.timeoutSeconds,
    maxOutputBytes: job.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES,
    exitCode: job.exitCode,
    signal: job.signal,
    outputBytes: job.outputBytes,
    outputTruncated: job.outputTruncated,
    error: job.error,
    artifactRoots: job.artifactRoots ? [...job.artifactRoots] : undefined,
    artifactStatus: job.artifactStatus ?? "none",
    artifactCount: job.artifactCount ?? 0,
    artifactErrors: job.artifactErrors ? [...job.artifactErrors] : undefined,
    captureProfile: job.captureProfile,
  };
}

function validatedJobEnvironment(
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

function isTerminal(status: JobStatus): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(status);
}

function validateJobId(jobId: string): void {
  if (!/^job_[0-9a-f-]{36}$/.test(jobId)) {
    throw new Error("Invalid jobId.");
  }
}
