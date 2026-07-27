import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveWorkspacePytestInvocation } from "./background-jobs.js";
import {
  type TaskDefinition,
  type TaskManifest,
  loadTaskManifest,
  isTaskApproved,
  checkManifestIntegrity,
  validateAndSubstitute,
  type ParamValidationError,
} from "./task-manifest.js";
import { type AdditionalRoot } from "./roots.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskSessionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stopped"
  | "interrupted";

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
  errors: ParamValidationError[];
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
  errors: ParamValidationError[];
}

export interface TaskSessionResult {
  taskId: string;
  mode: "session";
  sessionId: string;
  status: "running";
  pid: number;
}

// ---------------------------------------------------------------------------
// Task Runner
// ---------------------------------------------------------------------------

const DEFAULT_TASK_TIMEOUT = 600_000; // 10 minutes

export class TaskRunner {
  private sessions = new Map<string, TaskSession>();
  private processes = new Map<string, ChildProcess>();

  async runTask(input: {
    workspaceId: string;
    workspaceRoot: string;
    taskId: string;
    params: Record<string, string>;
    additionalRoots: AdditionalRoot[];
    timeoutSeconds?: number;
  }): Promise<TaskRunResult | TaskSessionResult> {
    const manifest = loadTaskManifest(input.workspaceRoot);
    if (!manifest) {
      throw new Error("TASK_MANIFEST_MISSING: No .devspace/tasks.yaml found.");
    }

    const task = manifest.tasks[input.taskId];
    if (!task) {
      throw new Error(
        `TASK_NOT_FOUND: Task ${input.taskId} not in manifest.`,
      );
    }

    // Validate params
    const allRoots = [
      input.workspaceRoot,
      ...input.additionalRoots.map((r) => r.path),
    ];
    const { command, errors } = validateAndSubstitute(
      task,
      input.params,
      input.workspaceRoot,
      allRoots,
    );
    if (errors.length > 0) {
      throw new Error(
        `TASK_PARAM_ERROR: ${errors.map((e) => `${e.param}: ${e.message}`).join("; ")}`,
      );
    }

    // Resolve runtime
    const runtime = this.resolveRuntime(
      task,
      input.workspaceRoot,
    );

    const fullCommand = [...runtime.prefix, ...command];
    const sessionId = `task_${randomUUID()}`;
    const startedAt = new Date().toISOString();

    const session: TaskSession = {
      sessionId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      mode: task.mode,
      status: "running",
      pid: undefined,
      startedAt,
      stdout: "",
      stderr: "",
      runtime: {
        interpreter: runtime.interpreter,
        environmentSource: runtime.source,
      },
      errors: [],
    };

    if (task.mode === "session") {
      const proc = spawn(fullCommand[0], fullCommand.slice(1), {
        cwd: input.workspaceRoot,
        env: { ...process.env, ...runtime.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      session.pid = proc.pid!;
      this.sessions.set(sessionId, session);
      this.processes.set(sessionId, proc);

      proc.stdout?.on("data", (d: Buffer) => {
        session.stdout += d.toString();
      });
      proc.stderr?.on("data", (d: Buffer) => {
        session.stderr += d.toString();
      });
      proc.on("exit", (code) => {
        session.status = code === 0 ? "succeeded" : "failed";
        session.exitCode = code ?? undefined;
        session.finishedAt = new Date().toISOString();
      });

      return {
        taskId: input.taskId,
        mode: "session",
        sessionId,
        status: "running",
        pid: proc.pid!,
      };
    }

    // Run mode: wait for completion
    const timeoutMs =
      (task.timeout_seconds ?? input.timeoutSeconds ?? 600) * 1000;
    const startTime = performance.now();

    try {
      const result = await this.runAndWait(
        fullCommand[0],
        fullCommand.slice(1),
        input.workspaceRoot,
        runtime.env,
        timeoutMs,
      );

      const durationMs = Math.round(performance.now() - startTime);
      session.status = result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "succeeded"
          : "failed";
      session.exitCode = result.exitCode ?? undefined;
      session.stdout = result.stdout;
      session.stderr = result.stderr;
      session.finishedAt = new Date().toISOString();
      this.sessions.set(sessionId, session);

      return {
        taskId: input.taskId,
        mode: "run",
        sessionId,
        status: session.status,
        exitCode: session.exitCode,
        stdout: session.stdout,
        stderr: session.stderr,
        durationMs,
        runtime: session.runtime,
        errors: [],
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      session.status = "interrupted";
      session.stderr = String(err);
      session.finishedAt = new Date().toISOString();
      this.sessions.set(sessionId, session);

      return {
        taskId: input.taskId,
        mode: "run",
        sessionId,
        status: "interrupted",
        stdout: session.stdout,
        stderr: session.stderr,
        durationMs,
        runtime: session.runtime,
        errors: [],
      };
    }
  }

  getSession(sessionId: string): TaskSession | undefined {
    return this.sessions.get(sessionId);
  }

  stopSession(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;
    try {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5000);
    } catch {
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Runtime resolution
  // -----------------------------------------------------------------------

  private resolveRuntime(
    task: TaskDefinition,
    workspaceRoot: string,
  ): { interpreter: string; prefix: string[]; env: Record<string, string>; source: string } {
    const rt = task.runtime ?? "workspace-python";

    if (rt === "workspace-python") {
      const pytestInv = resolveWorkspacePytestInvocation(workspaceRoot);
      if (pytestInv) {
        return {
          interpreter: pytestInv.executable,
          prefix: [pytestInv.executable],
          env: { VIRTUAL_ENV: pytestInv.venvRoot },
          source: ".venv",
        };
      }
      // Fallback to system python
      return {
        interpreter: "python",
        prefix: ["python"],
        env: {},
        source: "system (no .venv found)",
      };
    }

    // system runtime
    return {
      interpreter: task.command[0],
      prefix: [],
      env: {},
      source: "system",
    };
  }

  private runAndWait(
    executable: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolvePromise) => {
      const proc = spawn(executable, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGKILL");
          resolvePromise({
            stdout,
            stderr: stderr + "\n[TASK TIMED OUT]",
            exitCode: null,
            timedOut: true,
          });
        }
      }, timeoutMs);

      proc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ stdout, stderr, exitCode: code, timedOut: false });
        }
      });
      proc.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({
            stdout,
            stderr: stderr + `\n[TASK ERROR: ${err.message}]`,
            exitCode: null,
            timedOut: false,
          });
        }
      });
    });
  }
}
