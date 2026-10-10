import { spawnSync, type ChildProcess } from "node:child_process";
import type { ParamValidationError } from "./task-manifest.js";

export type TaskSessionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stopped"
  | "interrupted";

export interface EnvironmentInfo {
  resolvedExecutable: string;
  pythonVersion: string | null;
  environmentSource: ".venv" | "venv" | "workspace-config" | "system";
  dependencyLockPath: string | null;
  dependencyLockSha256: string | null;
}

export interface TaskSession {
  sessionId: string;
  workspaceId: string;
  taskId: string;
  mode: "run" | "session";
  status: TaskSessionStatus;
  pid?: number;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
  runtime: {
    interpreter: string;
    environmentSource: string;
  };
  environmentInfo?: EnvironmentInfo;
  bootstrap?: BootstrapResult;
  errors: ParamValidationError[];
  /** Structured parse of this run's output. Raw stdout/stderr are unaffected. */
  structured?: import("./task-results.js").TaskStructuredResult;
  /** Whether the source/assembly inputs moved while this run executed. */
  inputStability?: import("./task-fingerprint.js").TaskInputStability;
}

export interface TaskRunResult {
  taskId: string;
  mode: "run";
  sessionId: string;
  status: TaskSessionStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  runtime: TaskSession["runtime"];
  environmentInfo?: EnvironmentInfo;
  bootstrap?: BootstrapResult;
  errors: ParamValidationError[];
  /** Structured parse of this run's output. Raw stdout/stderr are unaffected. */
  structured?: import("./task-results.js").TaskStructuredResult;
  /** Whether the source/assembly inputs moved while this run executed. */
  inputStability?: import("./task-fingerprint.js").TaskInputStability;
}

export interface TaskSessionResult {
  taskId: string;
  mode: "session";
  sessionId: string;
  status: "running";
  pid: number;
}

export const DEFAULT_TASK_TIMEOUT = 600_000; // 10 minutes
export const VENV_CANDIDATES = [".venv", "venv"];
export const DEPENDENCY_LOCK_CANDIDATES = [
  "poetry.lock",
  "Pipfile.lock",
  "requirements-lock.txt",
  "requirements.txt",
];

export function terminateProcessTree(proc: ChildProcess): boolean {
  const pid = proc.pid;
  if (!pid || proc.exitCode !== null) return false;

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    if (!result.error && result.status === 0) return true;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      // Fall back to the direct child when process-group termination fails.
    }
  }

  try {
    return proc.kill("SIGKILL");
  } catch {
    return false;
  }
}

export interface BootstrapResult {
  outcome: "created" | "unchanged";
  target: ".venv" | "venv";
}

export interface WorkspacePythonResolutionOptions {
  allowIncompleteTarget?: ".venv" | "venv";
}

export interface TaskRunnerOptions {
  operatorPythonCommand?: readonly [string, ...string[]];
  workspacePythonResolver?: (
    workspaceRoot: string,
    platform?: NodeJS.Platform,
    options?: WorkspacePythonResolutionOptions,
  ) => EnvironmentInfo;
  /**
   * Optional RunnerRegistry used to resolve declared tools (`dotnet`,
   * `godot-mono`, ...) to an absolute executable with an augmented PATH.
   * Injectable so tests can drive resolution without a real toolchain.
   */
  runnerRegistry?: {
    resolve(name: string): Promise<{
      executable: string;
      environment: NodeJS.ProcessEnv;
      version?: string;
    }>;
  };
}

export interface BootstrapContext {
  key: string;
  target: ".venv" | "venv";
  targetPath: string;
  markerPath: string;
}

