import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskSessionStatus =
  "running" | "succeeded" | "failed" | "timed_out" | "stopped" | "interrupted";

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

export interface BootstrapResult {
  outcome: "created" | "unchanged";
  target: ".venv" | "venv";
}

interface WorkspacePythonResolutionOptions {
  allowIncompleteTarget?: ".venv" | "venv";
}

export interface TaskRunnerOptions {
  operatorPythonCommand?: readonly [string, ...string[]];
  workspacePythonResolver?: (
    workspaceRoot: string,
    platform?: NodeJS.Platform,
    options?: WorkspacePythonResolutionOptions,
  ) => EnvironmentInfo;
}

interface BootstrapContext {
  key: string;
  target: ".venv" | "venv";
  targetPath: string;
  markerPath: string;
}

// ---------------------------------------------------------------------------
// Workspace Python environment resolution (standalone export)
// ---------------------------------------------------------------------------

export function resolveWorkspacePythonEnvironment(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  options: WorkspacePythonResolutionOptions = {},
): EnvironmentInfo {
  const scriptsDir = platform === "win32" ? "Scripts" : "bin";
  const pythonName = platform === "win32" ? "python.exe" : "python";

  for (const name of VENV_CANDIDATES) {
    const venvRoot = join(workspaceRoot, name);
    const venvScripts = join(venvRoot, scriptsDir);
    const python = join(venvScripts, pythonName);
    const incompleteMarker = join(venvRoot, ".devspace-bootstrap-incomplete");

    if (!existsSync(python)) continue;
    if (
      existsSync(incompleteMarker) &&
      options.allowIncompleteTarget !== name
    ) {
      continue;
    }

    // Reject symlinked or incomplete venv directories.
    try {
      if (
        lstatSync(venvRoot).isSymbolicLink() ||
        lstatSync(venvScripts).isSymbolicLink() ||
        !statSync(join(venvRoot, "pyvenv.cfg")).isFile() ||
        !statSync(python).isFile()
      ) {
        continue;
      }
    } catch {
      continue;
    }

    // A candidate is usable only when the interpreter starts and reports that
    // sys.prefix is the selected workspace venv. A python-shaped half install
    // must never become the ordinary task runtime.
    let pythonVersion: string;
    try {
      const versionOutput = execFileSync(python, ["--version"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      const match = versionOutput.match(/Python\s+(\S+)/);
      pythonVersion = match ? match[1] : versionOutput;
      const prefixOutput = execFileSync(
        python,
        ["-c", "import os,sys; print(os.path.realpath(sys.prefix))"],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim();
      const expectedPrefix = realpathSync(venvRoot);
      const normalizeCase = (value: string) =>
        platform === "win32" ? value.toLowerCase() : value;
      if (normalizeCase(prefixOutput) !== normalizeCase(expectedPrefix)) {
        continue;
      }
    } catch {
      continue;
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

    try {
      const result = await this.runAndWait(
        fullCommand[0],
        fullCommand.slice(1),
        input.workspaceRoot,
        runEnv as Record<string, string>,
        timeoutMs,
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
      session.status = result.timedOut
        ? "timed_out"
        : effectiveExitCode === 0
          ? "succeeded"
          : "failed";
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

  stopSession(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;
    try {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
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
