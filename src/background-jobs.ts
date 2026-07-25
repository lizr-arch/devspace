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
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

export const JOB_RUNNERS = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "dotnet",
  "cargo",
  "pytest",
  "godot",
  "godot-mono",
] as const;
export type JobRunner = (typeof JOB_RUNNERS)[number];

export type JobStatus =
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export const DEFAULT_JOB_TIMEOUT_SECONDS = 15 * 60;
export const MAX_JOB_TIMEOUT_SECONDS = 60 * 60;
export const MAX_JOB_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_POLL_BYTES = 64 * 1024;
export const MAX_POLL_BYTES = 256 * 1024;

interface PersistedJob {
  jobId: string;
  workspaceId: string;
  workspaceRoot: string;
  workingDirectory: string;
  runner: JobRunner;
  args: string[];
  label?: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  timeoutSeconds: number;
  exitCode?: number;
  signal?: string;
  outputBytes: number;
  outputTruncated: boolean;
  error?: string;
}

interface LiveJob extends PersistedJob {
  child?: ChildProcessByStdio<null, Readable, Readable>;
  cancelRequested?: boolean;
  timeoutRequested?: boolean;
  timeoutHandle?: NodeJS.Timeout;
  killHandle?: NodeJS.Timeout;
}

export interface StartJobInput {
  workspaceId: string;
  workspaceRoot: string;
  workingDirectory: string;
  runner: JobRunner;
  args: string[];
  label?: string;
  timeoutSeconds?: number;
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
  private readonly executableCache = new Map<JobRunner, string>();

  constructor(private readonly stateDir: string) {
    this.jobsDir = join(stateDir, "jobs");
  }

  async start(input: StartJobInput): Promise<JobSnapshot> {
    this.initialize();
    if (this.runningCount() >= MAX_CONCURRENT_JOBS) {
      throw new Error(
        `At most ${MAX_CONCURRENT_JOBS} background jobs may run concurrently.`,
      );
    }
    validateJobArguments(input.runner, input.args);
    const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_JOB_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `timeoutSeconds must be between 1 and ${MAX_JOB_TIMEOUT_SECONDS}.`,
      );
    }
    if (input.label !== undefined && input.label.length > 200) {
      throw new Error("Job label must be at most 200 characters.");
    }

    const executable = await this.resolveExecutable(input.runner);
    const jobId = `job_${randomUUID()}`;
    const job: LiveJob = {
      jobId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workingDirectory,
      runner: input.runner,
      args: [...input.args],
      label: input.label,
      status: "running",
      startedAt: new Date().toISOString(),
      timeoutSeconds,
      outputBytes: 0,
      outputTruncated: false,
    };

    writeFileSync(this.logPath(jobId), "", { mode: 0o600 });
    this.jobs.set(jobId, job);
    this.persist(job);

    try {
      const child = spawn(executable, input.args, {
        cwd: input.workingDirectory,
        env: process.env,
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
        const job: LiveJob = { ...parsed };
        if (job.status === "running" || job.status === "cancelling") {
          job.status = "interrupted";
          job.endedAt = new Date().toISOString();
          job.error = "DevSpace restarted while the job was running.";
          this.persist(job);
        }
        this.jobs.set(job.jobId, job);
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

  private runningCount(): number {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === "running" || job.status === "cancelling",
    ).length;
  }

  private appendOutput(job: LiveJob, chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_JOB_OUTPUT_BYTES - job.outputBytes;
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
  }

  private persist(job: LiveJob): void {
    const persisted = publicSnapshot(job);
    const target = this.metadataPath(job.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(persisted, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, target);
  }

  private async resolveExecutable(runner: JobRunner): Promise<string> {
    const cached = this.executableCache.get(runner);
    if (cached) return cached;

    for (const candidate of executableCandidates(runner)) {
      try {
        await access(candidate);
        this.executableCache.set(runner, candidate);
        return candidate;
      } catch {
        // Try the next fixed candidate.
      }
    }

    const discovered = await discoverFromLoginShell(runner);
    this.executableCache.set(runner, discovered);
    return discovered;
  }

  private metadataPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.json`);
  }

  private logPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.log`);
  }
}

export function validateJobArguments(runner: JobRunner, args: string[]): void {
  if (!Array.isArray(args) || args.length === 0 || args.length > 128) {
    throw new Error("Job args must contain between 1 and 128 arguments.");
  }
  for (const argument of args) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > 4096 ||
      argument.includes("\0") ||
      argument.includes("\n") ||
      argument.includes("\r")
    ) {
      throw new Error("Job arguments must be non-empty, single-line strings.");
    }
    rejectExternalPathArgument(argument);
  }

  const action = args[0];
  const allowedActions: Partial<Record<JobRunner, string[]>> = {
    npm: ["test", "run"],
    pnpm: ["test", "run", "build", "check", "lint", "typecheck"],
    yarn: ["test", "run", "build", "check", "lint", "typecheck"],
    bun: ["test", "run", "build"],
    dotnet: ["build", "test", "format"],
    cargo: ["build", "test", "check", "clippy", "fmt"],
  };
  const allowed = allowedActions[runner];
  if (allowed && !allowed.includes(action)) {
    throw new Error(
      `${runner} jobs only allow these actions: ${allowed.join(", ")}.`,
    );
  }
  if (runner === "npm" && action === "run" && !args[1]) {
    throw new Error("npm run jobs require a script name.");
  }
  if (
    (runner === "godot" || runner === "godot-mono") &&
    !args.includes("--headless")
  ) {
    throw new Error(`${runner} jobs must include --headless.`);
  }
  if (
    (runner === "godot" || runner === "godot-mono") &&
    args.includes("--editor")
  ) {
    throw new Error(`${runner} background jobs cannot open the editor.`);
  }
}

function rejectExternalPathArgument(argument: string): void {
  const candidate = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : argument;
  if (
    isAbsolute(candidate) ||
    candidate.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `Job arguments may not reference absolute or parent paths: ${argument}`,
    );
  }
}

function executableCandidates(runner: JobRunner): string[] {
  const home = homedir();
  const common: Partial<Record<JobRunner, string[]>> = {
    npm: [
      join(home, ".hermes", "node", "bin", "npm"),
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
    ],
    pnpm: [
      join(home, ".hermes", "node", "bin", "pnpm"),
      "/opt/homebrew/bin/pnpm",
    ],
    yarn: [
      join(home, ".hermes", "node", "bin", "yarn"),
      "/opt/homebrew/bin/yarn",
    ],
    bun: [join(home, ".bun", "bin", "bun"), "/opt/homebrew/bin/bun"],
    dotnet: ["/usr/local/share/dotnet/dotnet", "/opt/homebrew/bin/dotnet"],
    cargo: [join(home, ".cargo", "bin", "cargo"), "/opt/homebrew/bin/cargo"],
    pytest: ["/opt/homebrew/bin/pytest", "/usr/local/bin/pytest"],
    godot: [
      "/Applications/Godot.app/Contents/MacOS/Godot",
      "/opt/homebrew/bin/godot",
    ],
    "godot-mono": [
      "/Applications/Godot_mono.app/Contents/MacOS/Godot",
      "/Applications/Godot Mono.app/Contents/MacOS/Godot",
      "/opt/homebrew/bin/godot-mono",
    ],
  };
  return common[runner] ?? [];
}

async function discoverFromLoginShell(runner: JobRunner): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/zsh", ["-lic", `command -v -- ${runner}`], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      const candidate = stdout.trim().split(/\r?\n/).at(-1) ?? "";
      if (
        code !== 0 ||
        !candidate ||
        !isAbsolute(candidate) ||
        basename(candidate).length === 0
      ) {
        rejectPromise(
          new Error(
            `Unable to locate ${runner}. Install it or make it available in the login shell PATH.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolvePromise(resolve(candidate));
    });
  });
}

function publicSnapshot(job: LiveJob): PersistedJob {
  return {
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    workspaceRoot: job.workspaceRoot,
    workingDirectory: job.workingDirectory,
    runner: job.runner,
    args: [...job.args],
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    timeoutSeconds: job.timeoutSeconds,
    exitCode: job.exitCode,
    signal: job.signal,
    outputBytes: job.outputBytes,
    outputTruncated: job.outputTruncated,
    error: job.error,
  };
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
