import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import type { Readable } from "node:stream";
import {
  createRunnerSpawnSpec,
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

import {
  JOB_RUNNERS,
  type JobRunner,
  DEFAULT_POLL_BYTES,
  MAX_POLL_BYTES,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  DEFAULT_WAIT_OUTPUT_BYTES,
  MAX_WAIT_OUTPUT_BYTES,
  DEFAULT_LIST_JOBS_LIMIT,
  MAX_LIST_JOBS_LIMIT,
  VENV_CANDIDATES,
  type WorkspacePytestInvocation,
  resolveWorkspacePytestInvocation,
  type JobStatus,
  type JobArtifactStatus,
  type JobErrorCode,
  type PersistedJob,
  type LiveJob,
  type StartJobInput,
  type JobSnapshot,
  type ListJobsOptions,
  type BackgroundJobMonitorSnapshot,
  failureCode,
  validatedJobEnvironment,
  isTerminal,
  isSettled,
  validateWaitArguments,
  encodeOutputCursor,
  decodeOutputCursor,
  processSignalTarget,
  processGroupContainsToken,
  isPermissionError,
  validateJobId,
} from "./background-jobs-types.js";

export {
  JOB_RUNNERS,
  type JobRunner,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
  DEFAULT_POLL_BYTES,
  MAX_POLL_BYTES,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  DEFAULT_WAIT_OUTPUT_BYTES,
  MAX_WAIT_OUTPUT_BYTES,
  DEFAULT_LIST_JOBS_LIMIT,
  MAX_LIST_JOBS_LIMIT,
  type WorkspacePytestInvocation,
  resolveWorkspacePytestInvocation,
  type JobStatus,
  type JobArtifactStatus,
  type JobErrorCode,
  type StartJobInput,
  type JobSnapshot,
  type ListJobsOptions,
  type BackgroundJobMonitorSnapshot,
};

export class BackgroundJobManager {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly jobsDir: string;
  private initialized = false;
  private closed = false;

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

    const workspacePytest =
      input.runner === "pytest"
        ? resolveWorkspacePytestInvocation(
            input.workspaceRoot,
            process.platform,
          )
        : undefined;
    const resolvedRunner = workspacePytest
      ? await this.runners.resolveExecutable(
          input.runner,
          workspacePytest.executable,
          [...workspacePytest.argsPrefix, "--version"],
        )
      : await this.runners.resolve(input.runner);
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
      const processToken = randomUUID();

      let executable = resolvedRunner.executable;
      let args = input.args;
      const env: Record<string, string> = {
        ...resolvedRunner.environment,
        ...validatedJobEnvironment(input.environment),
        DEVSPACE_JOB_ID: jobId,
        DEVSPACE_PROCESS_TOKEN: processToken,
      };

      if (workspacePytest) {
        executable = workspacePytest.executable;
        args = [...workspacePytest.argsPrefix, ...input.args];
        env.VIRTUAL_ENV = workspacePytest.venvRoot;
        const pathKey =
          Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
        env[pathKey] = [workspacePytest.venvScripts, env[pathKey] ?? ""].join(
          delimiter,
        );
      }

      const invocation = createRunnerSpawnSpec(executable, args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: input.workingDirectory,
        env,
        detached: process.platform !== "win32",
        shell: invocation.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      if (child.pid) {
        job.processId = child.pid;
        job.processGroupId =
          process.platform === "win32" ? undefined : child.pid;
        job.processPlatform = process.platform;
        job.processToken = processToken;
        job.processCleanupPending = true;
        this.persist(job);
      }
      child.stdout.on("data", (chunk: Buffer | string) =>
        this.appendOutput(job, chunk),
      );
      child.stderr.on("data", (chunk: Buffer | string) =>
        this.appendOutput(job, chunk),
      );
      child.once("error", (error) => {
        job.errorCode = failureCode(job);
        job.error = `${job.errorCode}: ${error.message}`;
        if (!child.pid && !isTerminal(job.status)) {
          this.finalizeSpawnFailure(job);
        }
      });
      child.once("exit", (code, signal) => {
        this.finalize(job, code, signal);
      });
      job.timeoutHandle = setTimeout(() => {
        if (job.status !== "running") return;
        job.timeoutRequested = true;
        job.status = "cancelling";
        this.persist(job);
        this.notifyWaiters(job.jobId);
        this.terminate(job);
      }, timeoutSeconds * 1000);
    } catch (error) {
      job.status = "failed";
      job.endedAt = new Date().toISOString();
      job.errorCode = failureCode(job);
      const reason = error instanceof Error ? error.message : String(error);
      job.error = `${job.errorCode}: ${reason}`;
      this.persist(job);
      void this.finalizeArtifacts(job);
      this.notifyWaiters(job.jobId);
      throw error;
    }

    return snapshotWithCursor(job);
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
      outputCursor: encodeOutputCursor(jobId, end),
      outputMode: "range",
    };
  }

  async wait(
    jobId: string,
    outputCursor?: string,
    waitSeconds = DEFAULT_WAIT_SECONDS,
    maxBytes = DEFAULT_WAIT_OUTPUT_BYTES,
  ): Promise<JobSnapshot> {
    this.initialize();
    validateJobId(jobId);
    validateWaitArguments(waitSeconds, maxBytes);

    const initialLogBytes = this.logBytes(jobId);
    const cursorOffset =
      outputCursor === undefined
        ? 0
        : decodeOutputCursor(outputCursor, jobId, initialLogBytes);
    const deadline = Date.now() + waitSeconds * 1000;
    let waitTimedOut = false;

    while (!isSettled(this.getJob(jobId))) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        waitTimedOut = true;
        break;
      }
      if (!(await this.waitForChange(jobId, remainingMs))) {
        waitTimedOut = true;
        break;
      }
    }

    return this.tailSnapshot(
      this.getJob(jobId),
      cursorOffset,
      maxBytes,
      waitTimedOut,
    );
  }

  list(workspaceId: string, options: ListJobsOptions = {}): JobSnapshot[] {
    this.initialize();
    const limit = options.limit ?? DEFAULT_LIST_JOBS_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_JOBS_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_LIST_JOBS_LIMIT}.`);
    }
    return Array.from(this.jobs.values())
      .filter(
        (job) =>
          job.workspaceId === workspaceId &&
          (!options.activeOnly || !isTerminal(job.status)),
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map((job) => snapshotWithCursor(job));
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
    this.notifyWaiters(job.jobId);
    this.terminate(job);
    return snapshotWithCursor(job);
  }

  monitorSnapshot(): BackgroundJobMonitorSnapshot {
    this.initialize();
    const byStatus = Object.fromEntries(
      [
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "interrupted",
      ].map((status) => [status, 0]),
    ) as Record<JobStatus, number>;
    const activeByRunner = Object.fromEntries(
      JOB_RUNNERS.map((runner) => [runner, 0]),
    ) as Record<JobRunner, number>;
    for (const job of this.jobs.values()) {
      byStatus[job.status] += 1;
      if (job.status === "running" || job.status === "cancelling") {
        activeByRunner[job.runner] += 1;
      }
    }
    return {
      total: this.jobs.size,
      active: this.runningCount(),
      maxConcurrent: MAX_CONCURRENT_JOBS,
      byStatus,
      activeByRunner,
      recentFailures: Array.from(this.jobs.values())
        .filter(
          (
            job,
          ): job is LiveJob & {
            endedAt: string;
            status: Extract<
              JobStatus,
              "failed" | "cancelled" | "timed_out" | "interrupted"
            >;
          } =>
            Boolean(job.endedAt) &&
            ["failed", "cancelled", "timed_out", "interrupted"].includes(
              job.status,
            ),
        )
        .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
        .slice(0, 10)
        .map((job) => ({
          endedAt: job.endedAt,
          runner: job.runner,
          status: job.status,
          errorCode: job.errorCode,
        })),
    };
  }

  close(): void {
    this.initialize();
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (isTerminal(job.status) && !job.processCleanupPending) continue;
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      if (!isTerminal(job.status)) {
        job.status = "interrupted";
        job.endedAt = new Date().toISOString();
        job.errorCode = "JOB_INTERRUPTED";
        job.error =
          "JOB_INTERRUPTED: DevSpace stopped while the job was running.";
      }
      this.beginProcessCleanup(job);
      this.persist(job);
      this.notifyWaiters(job.jobId);
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
        const wasRunning =
          job.status === "running" || job.status === "cancelling";
        if (wasRunning) {
          job.status = "interrupted";
          job.endedAt = new Date().toISOString();
          job.errorCode = "JOB_INTERRUPTED";
          job.error =
            "JOB_INTERRUPTED: DevSpace restarted while the job was running.";
        }
        this.jobs.set(job.jobId, job);
        if (wasRunning || job.processCleanupPending) {
          this.beginProcessCleanup(job);
        }
        this.persist(job);
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
    if (this.closed) return;
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
    this.beginProcessCleanup(job);
  }

  private beginProcessCleanup(job: LiveJob): void {
    if (!job.processCleanupPending) return;
    if (job.killHandle) clearTimeout(job.killHandle);
    if (!this.signalPersistedProcess(job, "SIGTERM")) {
      this.completeProcessCleanup(job);
      return;
    }
    job.killHandle = setTimeout(() => {
      job.killHandle = undefined;
      this.forceProcessCleanup(job, 0);
    }, 3_000);
  }

  private forceProcessCleanup(job: LiveJob, attempt: number): void {
    this.signalPersistedProcess(job, "SIGKILL");
    if (!this.persistedProcessAlive(job)) {
      this.completeProcessCleanup(job);
      this.persist(job);
      return;
    }
    if (attempt >= 19) {
      job.error = `${job.error ?? "JOB_INTERRUPTED:"} Process-group cleanup could not be confirmed.`;
      this.persist(job);
      return;
    }
    job.killHandle = setTimeout(() => {
      job.killHandle = undefined;
      this.forceProcessCleanup(job, attempt + 1);
    }, 50);
  }

  private completeProcessCleanup(job: LiveJob): void {
    if (job.killHandle) clearTimeout(job.killHandle);
    job.killHandle = undefined;
    job.processCleanupPending = false;
    job.processId = undefined;
    job.processGroupId = undefined;
    job.processPlatform = undefined;
    job.processToken = undefined;
  }

  private signalPersistedProcess(
    job: LiveJob,
    signal: NodeJS.Signals,
  ): boolean {
    const target = processSignalTarget(job);
    if (target === undefined) return false;
    if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill.exe",
        ["/PID", String(target), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      return !result.error && result.status === 0;
    }
    try {
      process.kill(target, signal);
      return true;
    } catch (error) {
      return isPermissionError(error);
    }
  }

  private persistedProcessAlive(job: LiveJob): boolean {
    const target = processSignalTarget(job);
    if (target === undefined) return false;
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return isPermissionError(error);
    }
  }

  private finalize(
    job: LiveJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    job.exitCode = code ?? undefined;
    job.signal = signal ?? undefined;
    job.endedAt = new Date().toISOString();
    if (job.status === "interrupted") {
      job.errorCode = "JOB_INTERRUPTED";
      job.error ??=
        "JOB_INTERRUPTED: DevSpace stopped while the job was running.";
    } else if (job.timeoutRequested) {
      job.status = "timed_out";
      job.errorCode = "JOB_TIMEOUT";
      job.error = `JOB_TIMEOUT: Process exceeded ${job.timeoutSeconds} seconds.`;
    } else if (job.cancelRequested) {
      job.status = "cancelled";
      job.errorCode = "JOB_CANCELLED";
      job.error = "JOB_CANCELLED: Job was cancelled by the client.";
    } else if (code === 0) {
      job.status = "succeeded";
    } else {
      job.status = "failed";
      job.errorCode = failureCode(job);
      if (!job.error) {
        job.error = `${job.errorCode}: Process exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
      }
    }
    job.child = undefined;
    if (this.closed && job.status === "interrupted") {
      this.completeProcessCleanup(job);
      this.notifyWaiters(job.jobId);
      return;
    }
    if (this.persistedProcessAlive(job)) {
      this.beginProcessCleanup(job);
    } else {
      this.completeProcessCleanup(job);
    }
    this.persist(job);
    this.notifyWaiters(job.jobId);
    void this.finalizeArtifacts(job);
  }

  private finalizeSpawnFailure(job: LiveJob): void {
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    job.timeoutHandle = undefined;
    job.status = "failed";
    job.endedAt = new Date().toISOString();
    job.child = undefined;
    this.completeProcessCleanup(job);
    this.persist(job);
    this.notifyWaiters(job.jobId);
    void this.finalizeArtifacts(job);
  }

  private persist(job: LiveJob): void {
    const persisted = {
      ...publicSnapshot(job),
      artifactBaseline: job.artifactBaseline,
      processId: job.processId,
      processGroupId: job.processGroupId,
      processPlatform: job.processPlatform,
      processToken: job.processToken,
      processCleanupPending: job.processCleanupPending,
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
      this.notifyWaiters(job.jobId);
    }
  }

  private logBytes(jobId: string): number {
    return existsSync(this.logPath(jobId))
      ? statSync(this.logPath(jobId)).size
      : 0;
  }

  private tailSnapshot(
    job: LiveJob,
    cursorOffset: number,
    maxBytes: number,
    waitTimedOut: boolean,
  ): JobSnapshot {
    const log = existsSync(this.logPath(job.jobId))
      ? readFileSync(this.logPath(job.jobId))
      : Buffer.alloc(0);
    const requestedStart = Math.min(cursorOffset, log.length);
    const start = Math.max(requestedStart, log.length - maxBytes);
    return {
      ...publicSnapshot(job),
      output: log.subarray(start).toString("utf8"),
      outputOffsetBytes: start,
      nextOutputOffsetBytes: log.length,
      outputCursor: encodeOutputCursor(job.jobId, log.length),
      outputMode: "tail",
      outputDiscardedBeforeBytes:
        start > requestedStart ? start - requestedStart : undefined,
      waitTimedOut,
    };
  }

  private async waitForChange(
    jobId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return await new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const listeners = this.waiters.get(jobId) ?? new Set<() => void>();
      let timeout: NodeJS.Timeout;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        listeners.delete(onChange);
        if (listeners.size === 0) this.waiters.delete(jobId);
        resolvePromise(changed);
      };
      const onChange = () => finish(true);
      listeners.add(onChange);
      this.waiters.set(jobId, listeners);
      timeout = setTimeout(() => finish(false), timeoutMs);
      if (isSettled(this.getJob(jobId))) queueMicrotask(onChange);
    });
  }

  private notifyWaiters(jobId: string): void {
    const listeners = this.waiters.get(jobId);
    if (!listeners) return;
    this.waiters.delete(jobId);
    for (const listener of listeners) listener();
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
    errorCode: job.errorCode,
    error: job.error,
    artifactRoots: job.artifactRoots ? [...job.artifactRoots] : undefined,
    artifactStatus: job.artifactStatus ?? "none",
    artifactCount: job.artifactCount ?? 0,
    artifactErrors: job.artifactErrors ? [...job.artifactErrors] : undefined,
    captureProfile: job.captureProfile,
  };
}

function snapshotWithCursor(job: LiveJob): JobSnapshot {
  return {
    ...publicSnapshot(job),
    outputCursor: encodeOutputCursor(job.jobId, job.outputBytes),
  };
}


