import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

import {
  type TaskSessionStatus,
  type EnvironmentInfo,
  type TaskSession,
  type TaskRunResult,
  type TaskSessionResult,
  type BootstrapResult,
  type TaskRunnerOptions,
  type BootstrapContext,
  type WorkspacePythonResolutionOptions,
  DEFAULT_TASK_TIMEOUT,
  VENV_CANDIDATES,
  DEPENDENCY_LOCK_CANDIDATES,
  terminateProcessTree,
} from "./task-runner-types.js";
import { resolveWorkspacePythonEnvironment } from "./task-runner-environment.js";

export {
  type TaskSessionStatus,
  type EnvironmentInfo,
  type TaskSession,
  type TaskRunResult,
  type TaskSessionResult,
  type BootstrapResult,
  type TaskRunnerOptions,
  terminateProcessTree,
  resolveWorkspacePythonEnvironment,
};

export class TaskRunner {
  private sessions = new Map<string, TaskSession>();
  private processes = new Map<string, ChildProcess>();
  private secretResolver?: SecretResolver;
  /**
   * Per-session secret values for redaction (keyed by sessionId).
   * Cleared when the session completes. Values are NEVER persisted.
   */
  private sessionSecretValues = new Map<string, string[]>();
  private readonly bootstrapLocks = new Set<string>();
  private readonly operatorPythonCommand?: readonly [string, ...string[]];
  private readonly workspacePythonResolver: NonNullable<
    TaskRunnerOptions["workspacePythonResolver"]
  >;

  constructor(options: TaskRunnerOptions = {}) {
    this.operatorPythonCommand = options.operatorPythonCommand;
    this.workspacePythonResolver =
      options.workspacePythonResolver ?? resolveWorkspacePythonEnvironment;
  }

  /**
   * Set the SecretResolver for this runner.
   * If unset, tasks declaring secrets will fail with TASK_SECRET_UNAUTHORIZED.
   */
  setSecretResolver(resolver: SecretResolver): void {
    this.secretResolver = resolver;
  }

  getOperatorPythonBootstrapStatus(): {
    configured: boolean;
    available: boolean;
  } {
    return {
      configured: Boolean(this.operatorPythonCommand),
      available: this.isOperatorPythonAvailable(),
    };
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
    if (
      task.runtime === "operator-python-bootstrap" &&
      Object.keys(input.params).length > 0
    ) {
      throw new TaskError({
        code: "TASK_PARAMETER_SCHEMA_INVALID",
        manifestPath: join(input.workspaceRoot, ".devspace/tasks.yaml"),
        taskId: input.taskId,
        field: "params",
        message: `Task ${input.taskId}: operator-python-bootstrap does not accept caller parameters.`,
        recoverable: true,
      });
    }

    // Validate params
    const allRoots = [
      { path: input.workspaceRoot, access: "read_write" as const },
      ...input.additionalRoots.map((root) => ({
        path: root.path,
        access:
          root.access === "read_only"
            ? ("read_only" as const)
            : ("read_write" as const),
      })),
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
    const runtime = this.resolveRuntime(task, input.workspaceRoot);

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
        detached: process.platform !== "win32",
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
        if (session.status === "running") {
          session.status = code === 0 ? "succeeded" : "failed";
        }
        session.exitCode = code ?? undefined;
        session.finishedAt = new Date().toISOString();
        this.processes.delete(sessionId);
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
    const bootstrapTarget =
      task.runtime === "operator-python-bootstrap"
        ? (command[2] as ".venv" | "venv")
        : undefined;
    let bootstrapContext: BootstrapContext | undefined;

    if (bootstrapTarget) {
      const prepared = this.prepareBootstrap(
        input.workspaceRoot,
        bootstrapTarget,
        input.taskId,
      );
      if (prepared.outcome === "unchanged") {
        const durationMs = Math.round(performance.now() - startTime);
        session.status = "succeeded";
        session.exitCode = 0;
        session.finishedAt = new Date().toISOString();
        session.environmentInfo = prepared.environmentInfo;
        session.bootstrap = {
          outcome: "unchanged",
          target: bootstrapTarget,
        };
        this.sessions.set(sessionId, session);
        return {
          taskId: input.taskId,
          mode: "run",
          sessionId,
          status: "succeeded",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs,
          runtime: session.runtime,
          environmentInfo: prepared.environmentInfo,
          bootstrap: session.bootstrap,
          errors: [],
        };
      }
      bootstrapContext = prepared.context;
    }

    this.sessions.set(sessionId, session);
    if (secretValuesForRedaction.length > 0) {
      this.sessionSecretValues.set(sessionId, secretValuesForRedaction);
    }

    try {
      const result = await this.runAndWait(
        fullCommand[0],
        fullCommand.slice(1),
        input.workspaceRoot,
        runEnv as Record<string, string>,
        timeoutMs,
        {
          onSpawn: (proc) => {
            session.pid = proc.pid;
            this.processes.set(sessionId, proc);
          },
          onStdout: (output) => {
            session.stdout += output;
          },
          onStderr: (output) => {
            session.stderr += output;
          },
          onSettled: () => {
            this.processes.delete(sessionId);
          },
        },
      );
      let effectiveExitCode = result.exitCode;
      let bootstrapDiagnostic = "";
      let environmentInfo = runtime.environmentInfo;
      if (bootstrapContext) {
        if (!result.timedOut && result.exitCode === 0) {
          try {
            const resolved = this.workspacePythonResolver(
              input.workspaceRoot,
              process.platform,
              { allowIncompleteTarget: bootstrapContext.target },
            );
            if (resolved.environmentSource !== bootstrapContext.target) {
              throw new Error("created environment did not match target");
            }
            unlinkSync(bootstrapContext.markerPath);
            environmentInfo = this.workspacePythonResolver(
              input.workspaceRoot,
              process.platform,
            );
            session.bootstrap = {
              outcome: "created",
              target: bootstrapContext.target,
            };
          } catch {
            effectiveExitCode = 1;
            bootstrapDiagnostic =
              "\n[TASK BOOTSTRAP VALIDATION FAILED: created environment was quarantined]";
            this.cleanupFailedBootstrap(bootstrapContext);
          }
        } else {
          bootstrapDiagnostic =
            "\n[TASK BOOTSTRAP FAILED: incomplete environment was removed or quarantined]";
          this.cleanupFailedBootstrap(bootstrapContext);
        }
      }

      // Redact secrets from stdout/stderr before returning
      const redactedStdout = redactSecrets(
        this.sanitizeOperatorPath(result.stdout),
        secretValuesForRedaction,
      );
      const redactedStderr = redactSecrets(
        this.sanitizeOperatorPath(result.stderr + bootstrapDiagnostic),
        secretValuesForRedaction,
      );

      const durationMs = Math.round(performance.now() - startTime);
      if (session.status !== "stopped") {
        session.status = result.timedOut
          ? "timed_out"
          : effectiveExitCode === 0
            ? "succeeded"
            : "failed";
      }
      session.exitCode = effectiveExitCode ?? undefined;
      session.stdout = redactedStdout;
      session.stderr = redactedStderr;
      session.finishedAt = new Date().toISOString();
      session.environmentInfo = environmentInfo;
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
        environmentInfo,
        bootstrap: session.bootstrap,
        errors: [],
      };
    } catch (err) {
      if (bootstrapContext) this.cleanupFailedBootstrap(bootstrapContext);
      const durationMs = Math.round(performance.now() - startTime);
      const errorMsg = this.sanitizeOperatorPath(String(err));
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
    } finally {
      this.processes.delete(sessionId);
      this.sessionSecretValues.delete(sessionId);
      if (bootstrapContext) {
        this.bootstrapLocks.delete(bootstrapContext.key);
      }
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

  listSessions(workspaceId: string, limit = 20): TaskSession[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    return Array.from(this.sessions.values())
      .filter((session) => session.workspaceId === workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, boundedLimit)
      .map((session) => this.getSession(session.sessionId)!)
      .filter(Boolean);
  }

  async waitSession(
    sessionId: string,
    waitMs: number,
  ): Promise<TaskSession | undefined> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let session = this.getSession(sessionId);
    while (session?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
      );
      session = this.getSession(sessionId);
    }
    return session;
  }

  stopSession(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;
    const stopped = terminateProcessTree(proc);
    if (!stopped) return false;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "stopped";
      session.finishedAt = new Date().toISOString();
    }
    this.sessionSecretValues.delete(sessionId);
    return true;
  }

  // -----------------------------------------------------------------------
  // Runtime resolution
  // -----------------------------------------------------------------------

  private prepareBootstrap(
    workspaceRoot: string,
    target: ".venv" | "venv",
    taskId: string,
  ):
    | { outcome: "unchanged"; environmentInfo: EnvironmentInfo }
    | { outcome: "create"; context: BootstrapContext } {
    const targetPath = join(workspaceRoot, target);
    const markerPath = join(targetPath, ".devspace-bootstrap-incomplete");
    const key = `${workspaceRoot}\0${target}`;
    if (this.bootstrapLocks.has(key)) {
      throw new TaskError({
        code: "TASK_BOOTSTRAP_CONFLICT",
        taskId,
        field: "runtime.venv",
        message: `Workspace Python bootstrap is already running for ${target}.`,
        recoverable: true,
      });
    }
    this.bootstrapLocks.add(key);

    try {
      if (existsSync(targetPath)) {
        try {
          const environmentInfo = this.workspacePythonResolver(
            workspaceRoot,
            process.platform,
          );
          if (environmentInfo.environmentSource === target) {
            this.bootstrapLocks.delete(key);
            return { outcome: "unchanged", environmentInfo };
          }
        } catch {
          // Existing invalid targets remain untouched and are never adopted.
        }
        throw new TaskError({
          code: "TASK_BOOTSTRAP_CONFLICT",
          taskId,
          field: "runtime.venv",
          message: `Bootstrap target ${target} already exists but is not a valid workspace virtual environment.`,
          recoverable: true,
        });
      }

      mkdirSync(targetPath);
      writeFileSync(
        markerPath,
        JSON.stringify({
          schemaVersion: 1,
          target,
          state: "incomplete",
        }) + "\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      return {
        outcome: "create",
        context: { key, target, targetPath, markerPath },
      };
    } catch (error) {
      this.bootstrapLocks.delete(key);
      if (
        error instanceof TaskError &&
        error.code === "TASK_BOOTSTRAP_CONFLICT"
      ) {
        throw error;
      }
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // A remaining marker keeps any partial target quarantined.
      }
      throw new TaskError({
        code: "TASK_BOOTSTRAP_FAILED",
        taskId,
        field: "runtime.venv",
        message: `Unable to initialize bootstrap target ${target}.`,
        recoverable: true,
      });
    }
  }

  private cleanupFailedBootstrap(context: BootstrapContext): void {
    try {
      rmSync(context.targetPath, { recursive: true, force: true });
      return;
    } catch {
      // Keep or recreate the marker so normal tasks cannot adopt a half venv.
    }
    try {
      mkdirSync(context.targetPath, { recursive: true });
      writeFileSync(context.markerPath, "incomplete\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // The resolver additionally requires pyvenv.cfg and a healthy prefix.
    }
  }

  private sanitizeOperatorPath(value: string): string {
    const executable = this.operatorPythonCommand?.[0];
    return executable
      ? value.split(executable).join("[OPERATOR_PYTHON]")
      : value;
  }

  private isOperatorPythonAvailable(): boolean {
    const operatorCommand = this.operatorPythonCommand;
    if (!operatorCommand) return false;
    try {
      if (!statSync(operatorCommand[0]).isFile()) return false;
      accessSync(operatorCommand[0], constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

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
      const envInfo = this.workspacePythonResolver(workspaceRoot);

      const venvScripts = join(
        workspaceRoot,
        envInfo.environmentSource,
        process.platform === "win32" ? "Scripts" : "bin",
      );
      const pathKey =
        Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ??
        "PATH";

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

    if (rt === "operator-python-bootstrap") {
      const operatorCommand = this.operatorPythonCommand;
      if (!operatorCommand || !this.isOperatorPythonAvailable()) {
        throw new TaskError({
          code: "TASK_BOOTSTRAP_UNAVAILABLE",
          field: "runtime.operatorPython",
          message:
            "Workspace Python bootstrap is unavailable because the operator interpreter is not configured or executable.",
          recoverable: true,
        });
      }
      return {
        interpreter: "operator-python-bootstrap",
        prefix: [...operatorCommand],
        env: {},
        source: "operator-python-bootstrap",
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
    lifecycle?: {
      onSpawn?: (proc: ChildProcess) => void;
      onStdout?: (output: string) => void;
      onStderr?: (output: string) => void;
      onSettled?: () => void;
    },
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
        detached: process.platform !== "win32",
      });
      lifecycle?.onSpawn?.(proc);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          terminateProcessTree(proc);
          lifecycle?.onSettled?.();
          resolvePromise({
            stdout,
            stderr: stderr + "\n[TASK TIMED OUT]",
            exitCode: null,
            timedOut: true,
          });
        }
      }, timeoutMs);

      proc.stdout?.on("data", (d: Buffer) => {
        const output = d.toString();
        stdout += output;
        lifecycle?.onStdout?.(output);
      });
      proc.stderr?.on("data", (d: Buffer) => {
        const output = d.toString();
        stderr += output;
        lifecycle?.onStderr?.(output);
      });
      proc.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          lifecycle?.onSettled?.();
          resolvePromise({ stdout, stderr, exitCode: code, timedOut: false });
        }
      });
      proc.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          lifecycle?.onSettled?.();
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
