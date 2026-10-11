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
import { RunnerRegistry } from "./runner-registry.js";
import { parseTaskResult } from "./task-results.js";
import {
  ResourceLockBusyError,
  requestsForCommand,
  sharedResourceLocks,
} from "./job-resource-locks.js";
import {
  captureTaskInputFingerprint,
  compareTaskInputs,
  type TaskInputFingerprint,
} from "./task-fingerprint.js";
import { type RunnerName } from "./runner-types.js";
import { isRunnerName, withDotnetRuntime } from "./runner-validation.js";

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

/** Best-effort runner label for lock diagnostics. */
function taskRunnerLabel(argv: string[]): RunnerName {
  const joined = argv.join(" ").toLowerCase();
  if (/(^|[\s/])godot(-mono)?([\s]|$)/.test(joined)) {
    return joined.includes("godot-mono") || joined.includes("godot_mono")
      ? "godot-mono"
      : "godot";
  }
  for (const name of ["dotnet", "cargo", "npm", "pnpm", "yarn", "bun", "pytest"] as const) {
    if (argv.some((entry) => entry.toLowerCase().endsWith(`/${name}`) || entry === name)) {
      return name;
    }
  }
  return "dotnet";
}

function captureSafely(workspaceRoot: string): TaskInputFingerprint | null {
  try {
    return captureTaskInputFingerprint(workspaceRoot);
  } catch {
    return null;
  }
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
  private readonly bootstrapLocks = new Set<string>();
  private readonly operatorPythonCommand?: readonly [string, ...string[]];
  private readonly workspacePythonResolver: NonNullable<
    TaskRunnerOptions["workspacePythonResolver"]
  >;

  private readonly runners: TaskRunnerOptions["runnerRegistry"];

  constructor(options: TaskRunnerOptions = {}) {
    this.operatorPythonCommand = options.operatorPythonCommand;
    this.workspacePythonResolver =
      options.workspacePythonResolver ?? resolveWorkspacePythonEnvironment;
    this.runners =
      options.runnerRegistry ?? (new RunnerRegistry() as TaskRunnerOptions["runnerRegistry"]);
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
    const runtime = await this.resolveRuntime(task, input.workspaceRoot);

    const fullCommand = runtime.replaceArgv0
      ? [runtime.replaceArgv0, ...command.slice(1)]
      : [...runtime.prefix, ...command];
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

    // Serialize against every other build/test/task that touches this
    // workspace. Two concurrent writers would overwrite each other's obj/,
    // bin/ and managed assembly, and a Phase 20 performance number produced
    // under that race is worthless even when it prints PASS. Independent
    // workspaces keep running in parallel because the lock is keyed per root.
    // A Python bootstrap only creates a virtualenv; it writes no build output,
    // so it must not take the build lock. Doing so would mask the more specific
    // TASK_BOOTSTRAP_CONFLICT with a generic workspace-busy error.
    const lockRequests =
      task.runtime === "operator-python-bootstrap"
        ? []
        : requestsForCommand({
            argv: fullCommand,
            workspaceRoot: input.workspaceRoot,
          });
    // Every exit below runs through this finally: the bootstrap fast path and
    // the error paths previously returned without releasing, which would have
    // blocked the workspace forever.
    try {
    if (task.mode === "session") {
      // A detached session can write the same outputs as a run-mode task, so it
      // holds the identical lock and releases it when the process settles.
      try {
        sharedResourceLocks.acquire({
          jobId: sessionId,
          runner: taskRunnerLabel(fullCommand),
          workspaceRoot: input.workspaceRoot,
          requests: lockRequests,
        });
      } catch (error) {
        if (error instanceof ResourceLockBusyError) {
          throw new Error(`TASK_WORKSPACE_BUSY: ${error.message}`);
        }
        throw error;
      }
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
      // close fires only after stdout/stderr streams have finished; exit can
      // precede a final data chunk. Keep the secret mask until then.
      proc.on("close", (code) => {
        if (session.status === "running") {
          session.status = code === 0 ? "succeeded" : "failed";
        }
        session.exitCode = code ?? undefined;
        session.finishedAt = new Date().toISOString();
        this.processes.delete(sessionId);
        const secrets = this.sessionSecretValues.get(sessionId) ?? [];
        session.stdout = redactSecrets(session.stdout, secrets);
        session.stderr = redactSecrets(session.stderr, secrets);
        // The terminal snapshot is now permanently sanitized, so clearing
        // the in-memory secrets cannot reveal historic output on later polls.
        this.sessionSecretValues.delete(sessionId);
        // A detached session held the workspace for its whole lifetime; the
        // lock must not outlive the process, or the next task would be
        // permanently blocked by a finished run.
        sharedResourceLocks.release(sessionId);
      });
      proc.on("error", () => {
        sharedResourceLocks.release(sessionId);
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
      sharedResourceLocks.acquire({
        jobId: sessionId,
        runner: taskRunnerLabel(fullCommand),
        workspaceRoot: input.workspaceRoot,
        requests: lockRequests,
      });
    } catch (error) {
      if (error instanceof ResourceLockBusyError) {
        throw new Error(
          `TASK_WORKSPACE_BUSY: ${error.message}`,
        );
      }
      throw error;
    }

    // Fingerprint the source and assembly inputs this run will be judged
    // against, so a parallel edit cannot be signed off by a stale result.
    const inputsBefore: TaskInputFingerprint | null = captureSafely(
      input.workspaceRoot,
    );

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

      // Release before returning: the fingerprint must be taken while nothing
      // else can be mid-write, and a held lock would block the next task.
      sharedResourceLocks.release(sessionId);
      const inputsAfter = captureSafely(input.workspaceRoot);
      const inputStability = compareTaskInputs(inputsBefore, inputsAfter);
      const structured = task.result_parser
        ? parseTaskResult({
            parser: task.result_parser,
            output: `${redactedStdout}\n${redactedStderr}`,
            exitCode: effectiveExitCode,
            command: fullCommand,
            timedOut: result.timedOut || session.status === "timed_out",
          })
        : undefined;
      // A run whose inputs moved underneath it can never be used to sign off
      // the new inputs, whatever its own verdict was.
      if (inputStability.status === "changed_during_run" && structured) {
        structured.reasons.push(
          `inputs changed during the run: ${inputStability.changes.join("; ")}`,
        );
        structured.skippedChecks.push(
          "this result does not sign off the changed inputs; re-run the task",
        );
      }

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
        structured,
        inputStability,
      };
    } catch (err) {
      sharedResourceLocks.release(sessionId);
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
      sharedResourceLocks.release(sessionId);
      this.processes.delete(sessionId);
      this.sessionSecretValues.delete(sessionId);
      if (bootstrapContext) {
        this.bootstrapLocks.delete(bootstrapContext.key);
      }
    }
    } finally {
      // Covers the bootstrap fast path and every earlier early return. Release
      // is idempotent, so the inner finally may already have freed it.
      sharedResourceLocks.release(sessionId);
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
    // Keep redaction material until proc.close: buffered output may still
    // arrive after a stop signal. The close handler sanitizes before clearing.
    // The close handler also releases, but an explicit stop must not depend on
    // that callback ordering to free the workspace.
    sharedResourceLocks.release(sessionId);
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

  private async resolveRuntime(
    task: TaskDefinition,
    workspaceRoot: string,
  ): Promise<{
    interpreter: string;
    prefix: string[];
    env: Record<string, string>;
    source: string;
    environmentInfo?: EnvironmentInfo;
    /**
     * When set, argv[0] is replaced by this resolved absolute path instead of
     * being appended to. Without it a declared tool would be spawned as
     * `<abs path> <tool name> ...`, which real CLIs reject (npm reported
     * `Unknown command: "npm"`).
     */
    replaceArgv0?: string;
  }> {
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

    // system runtime — use the command's first element directly (no shell).
    //
    // DevSpace normally runs under launchd, whose minimal PATH is
    // /usr/bin:/bin:/usr/sbin:/sbin. Declared tools such as `dotnet` and
    // `godot-mono` live outside that PATH, so a task naming them would fail to
    // spawn even though the tool is installed. When the first element is a
    // known runner, resolve it through the same RunnerRegistry that backs
    // start_job: that yields an absolute executable plus the augmented
    // environment (dotnet PATH / DOTNET_ROOT for the Godot runners). Anything
    // the registry cannot resolve still falls back to a plain PATH lookup, so
    // behavior for ordinary commands is unchanged.
    const declared = task.command[0];
    if (isRunnerName(declared)) {
      try {
        const resolved = await this.runners!.resolve(declared as RunnerName);
        return {
          interpreter: resolved.executable,
          prefix: [],
          env: { ...resolved.environment } as Record<string, string>,
          source: `system+runner:${declared}`,
          replaceArgv0: resolved.executable,
        };
      } catch (error) {
        throw new TaskError({
          code: "TASK_EXECUTABLE_UNRESOLVED",
          manifestPath: ".devspace/tasks.yaml",
          field: "command[0]",
          message: `Task command resolves to the ${declared} runner, but it is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
          recoverable: true,
        });
      }
    }

    // A declared command may be a project entrypoint script (for example
    // `bash tools/triaregna.sh build`) that itself shells out to dotnet. DevSpace
    // usually runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which
    // does not contain the .NET SDK, so the child would fail even though the SDK
    // is installed. Apply the same dotnet PATH/DOTNET_ROOT augmentation the
    // Godot runners already use. This only prepends discovered SDK directories;
    // it does not add a shell, relax argument validation, or widen the sandbox.
    return {
      interpreter: declared,
      prefix: [],
      env: {
        ...(withDotnetRuntime({ ...process.env }, process.platform) as Record<
          string,
          string
        >),
      },
      source: "system",
    };
  }

  private static captureInputs(workspaceRoot: string): TaskInputFingerprint | null {
    try {
      return captureTaskInputFingerprint(workspaceRoot);
    } catch {
      return null;
    }
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
