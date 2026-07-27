import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, statSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
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
import { TaskError } from "./task-errors.js";
import { type SecretResolver, redactSecrets } from "./secret-resolver.js";

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
  environmentInfo?: EnvironmentInfo;
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
  environmentInfo?: EnvironmentInfo;
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
const VENV_CANDIDATES = [".venv", "venv"];
const DEPENDENCY_LOCK_CANDIDATES = [
  "poetry.lock",
  "Pipfile.lock",
  "requirements-lock.txt",
  "requirements.txt",
];

// ---------------------------------------------------------------------------
// Environment diagnostics types
// ---------------------------------------------------------------------------

export interface EnvironmentInfo {
  resolvedExecutable: string;
  pythonVersion: string | null;
  environmentSource: ".venv" | "venv" | "workspace-config" | "system";
  dependencyLockPath: string | null;
  dependencyLockSha256: string | null;
}

// ---------------------------------------------------------------------------
// Workspace Python environment resolution (standalone export)
// ---------------------------------------------------------------------------

export function resolveWorkspacePythonEnvironment(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): EnvironmentInfo {
  const scriptsDir = platform === "win32" ? "Scripts" : "bin";
  const pythonName = platform === "win32" ? "python.exe" : "python";

  for (const name of VENV_CANDIDATES) {
    const venvRoot = join(workspaceRoot, name);
    const venvScripts = join(venvRoot, scriptsDir);
    const python = join(venvScripts, pythonName);

    if (!existsSync(python)) continue;

    // Reject symlinked venv directories
    try {
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

    // Get Python version via direct exec (no shell)
    let pythonVersion: string | null = null;
    try {
      const versionOutput = execFileSync(python, ["--version"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      // "Python 3.11.9" → "3.11.9"
      const match = versionOutput.match(/Python\s+(\S+)/);
      pythonVersion = match ? match[1] : versionOutput;
    } catch {
      // Python --version failed — still usable but without version info
    }

    // Detect dependency lock file
    let dependencyLockPath: string | null = null;
    let dependencyLockSha256: string | null = null;
    for (const candidate of DEPENDENCY_LOCK_CANDIDATES) {
      const lockPath = join(workspaceRoot, candidate);
      if (existsSync(lockPath) && statSync(lockPath).isFile()) {
        dependencyLockPath = candidate;
        dependencyLockSha256 = createHash("sha256")
          .update(readFileSync(lockPath, "utf8"))
          .digest("hex");
        break;
      }
    }

    return {
      resolvedExecutable: python,
      pythonVersion,
      environmentSource: name as ".venv" | "venv",
      dependencyLockPath,
      dependencyLockSha256,
    };
  }

  // No .venv found — TASK_ENVIRONMENT_UNAVAILABLE for workspace-python runtime
  throw new TaskError({
    code: "TASK_ENVIRONMENT_UNAVAILABLE",
    manifestPath: join(workspaceRoot, ".devspace/tasks.yaml"),
    field: "runtime.venv",
    message: `Workspace requires Python virtual environment but neither .venv nor venv was found at ${workspaceRoot}. Create a venv with 'python -m venv .venv'.`,
    recoverable: true,
  });
}

export class TaskRunner {
  private sessions = new Map<string, TaskSession>();
  private processes = new Map<string, ChildProcess>();
  private secretResolver?: SecretResolver;
  /**
   * Per-session secret values for redaction (keyed by sessionId).
   * Cleared when the session completes. Values are NEVER persisted.
   */
  private sessionSecretValues = new Map<string, string[]>();

  /**
   * Set the SecretResolver for this runner.
   * If unset, tasks declaring secrets will fail with TASK_SECRET_UNAUTHORIZED.
   */
  setSecretResolver(resolver: SecretResolver): void {
    this.secretResolver = resolver;
  }

  async runTask(input: {
    workspaceId: string;
    workspaceRoot: string;
    taskId: string;
    params: Record<string, string>;
    additionalRoots: AdditionalRoot[];
    timeoutSeconds?: number;
  }): Promise<TaskRunResult | TaskSessionResult> {
    const manifest = loadTaskManifest(input.workspaceRoot);

    const task = manifest.tasks[input.taskId];
    if (!task) {
      throw new TaskError({
        code: "TASK_ID_UNKNOWN",
        manifestPath: join(input.workspaceRoot, ".devspace/tasks.yaml"),
        taskId: input.taskId,
        message: `Task ${input.taskId} not found in manifest.`,
        recoverable: true,
      });
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

    // -------------------------------------------------------------------
    // Resolve secret bindings (M3)
    // -------------------------------------------------------------------
    let resolvedSecrets: Map<string, string> = new Map();
    if (task.secrets && task.secrets.length > 0) {
      if (!this.secretResolver) {
        throw new TaskError({
          code: "TASK_SECRET_NOT_AUTHORIZED",
          manifestPath: join(input.workspaceRoot, ".devspace/tasks.yaml"),
          taskId: input.taskId,
          message: `Task ${input.taskId} declares secrets but no SecretResolver is configured.`,
          recoverable: true,
        });
      }
      for (const binding of task.secrets) {
        let secretValue: string;
        try {
          secretValue = this.secretResolver.resolve(binding.secret_ref);
        } catch (err) {
          throw new TaskError({
            code: "TASK_SECRET_UNRESOLVED",
            manifestPath: join(input.workspaceRoot, ".devspace/tasks.yaml"),
            taskId: input.taskId,
            field: `secrets.${binding.secret_ref}`,
            message:
              `Unable to resolve secret '${binding.secret_ref}': ` +
              (err instanceof Error ? err.message : String(err)),
            recoverable: true,
          });
        }
        // Validate target_env is a legal env var name
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.target_env)) {
          throw new TaskError({
            code: "TASK_MANIFEST_SCHEMA_ERROR",
            manifestPath: join(input.workspaceRoot, ".devspace/tasks.yaml"),
            taskId: input.taskId,
            field: `secrets.target_env`,
            message: `Invalid target_env name: '${binding.target_env}'.`,
            recoverable: true,
          });
        }
        resolvedSecrets.set(binding.target_env, secretValue);
      }
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
      environmentInfo: runtime.environmentInfo,
      errors: [],
    };

    if (task.mode === "session") {
      // Merge resolved secrets into child env (NOT global process.env)
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        ...runtime.env,
      };
      for (const [envName, secretValue] of resolvedSecrets) {
        childEnv[envName] = secretValue;
      }

      // Store secret values for redaction on poll (cleared on session complete)
      if (resolvedSecrets.size > 0) {
        this.sessionSecretValues.set(
          sessionId,
          Array.from(resolvedSecrets.values()),
        );
      }

      const proc = spawn(fullCommand[0], fullCommand.slice(1), {
        cwd: input.workspaceRoot,
        env: childEnv as Record<string, string>,
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
        // Clean up secret values — they are no longer needed after exit
        this.sessionSecretValues.delete(sessionId);
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

    // Merge resolved secrets into child env for run mode
    const runEnv: Record<string, string | undefined> = { ...runtime.env };
    for (const [envName, secretValue] of resolvedSecrets) {
      runEnv[envName] = secretValue;
    }

    // Collect secret values for redaction (MUST not leak beyond this scope)
    const secretValuesForRedaction = Array.from(resolvedSecrets.values());

    try {
      const result = await this.runAndWait(
        fullCommand[0],
        fullCommand.slice(1),
        input.workspaceRoot,
        runEnv as Record<string, string>,
        timeoutMs,
      );

      // Redact secrets from stdout/stderr before returning
      const redactedStdout = redactSecrets(result.stdout, secretValuesForRedaction);
      const redactedStderr = redactSecrets(result.stderr, secretValuesForRedaction);

      const durationMs = Math.round(performance.now() - startTime);
      session.status = result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "succeeded"
          : "failed";
      session.exitCode = result.exitCode ?? undefined;
      session.stdout = redactedStdout;
      session.stderr = redactedStderr;
      session.finishedAt = new Date().toISOString();
      this.sessions.set(sessionId, session);

      return {
        taskId: input.taskId,
        mode: "run",
        sessionId,
        status: session.status,
        exitCode: session.exitCode,
        stdout: redactedStdout,
        stderr: redactedStderr,
        durationMs,
        runtime: session.runtime,
        environmentInfo: runtime.environmentInfo,
        errors: [],
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorMsg = String(err);
      const redactedError = redactSecrets(errorMsg, secretValuesForRedaction);

      session.status = "interrupted";
      session.stderr = redactedError;
      session.finishedAt = new Date().toISOString();
      this.sessions.set(sessionId, session);

      return {
        taskId: input.taskId,
        mode: "run",
        sessionId,
        status: "interrupted",
        stdout: redactSecrets(session.stdout, secretValuesForRedaction),
        stderr: redactedError,
        durationMs,
        runtime: session.runtime,
        environmentInfo: runtime.environmentInfo,
        errors: [],
      };
    }
  }

  getSession(sessionId: string): TaskSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Redact secrets from session output before returning
    const secretValues = this.sessionSecretValues.get(sessionId);
    if (secretValues && secretValues.length > 0) {
      return {
        ...session,
        stdout: redactSecrets(session.stdout, secretValues),
        stderr: redactSecrets(session.stderr, secretValues),
      };
    }
    return session;
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
    // Clean up secret values
    this.sessionSecretValues.delete(sessionId);
    return true;
  }

  // -----------------------------------------------------------------------
  // Runtime resolution
  // -----------------------------------------------------------------------

  private resolveRuntime(
    task: TaskDefinition,
    workspaceRoot: string,
  ): {
    interpreter: string;
    prefix: string[];
    env: Record<string, string>;
    source: string;
    environmentInfo?: EnvironmentInfo;
  } {
    const rt = task.runtime ?? "workspace-python";

    if (rt === "workspace-python") {
      // Use enhanced environment resolution — throws TASK_ENVIRONMENT_UNAVAILABLE
      // if no .venv is found; never falls back to system Python.
      const envInfo = resolveWorkspacePythonEnvironment(workspaceRoot);

      const venvScripts = join(
        workspaceRoot,
        envInfo.environmentSource,
        process.platform === "win32" ? "Scripts" : "bin",
      );
      const pathKey = Object.keys(process.env).find(
        (k) => k.toUpperCase() === "PATH",
      ) ?? "PATH";

      return {
        interpreter: envInfo.resolvedExecutable,
        prefix: [envInfo.resolvedExecutable],
        env: {
          VIRTUAL_ENV: join(workspaceRoot, envInfo.environmentSource),
          [pathKey]: [venvScripts, process.env[pathKey] ?? ""].join(delimiter),
        },
        source: envInfo.environmentSource,
        environmentInfo: envInfo,
      };
    }

    // system runtime — use command's first element directly (no shell)
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
