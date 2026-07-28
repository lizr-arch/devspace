import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { existsSync } from "node:fs";
import { isPathInsideRoot } from "./roots.js";
import { TaskError, type TaskErrorCode } from "./task-errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskMode = "run" | "session";

export type TaskRuntime =
  "workspace-python" | "operator-python-bootstrap" | "system";

export interface TaskSecretBinding {
  secret_ref: string;
  target_env: string;
}

export interface TaskParameter {
  type: "string" | "path" | "sha256" | "int";
  required?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
}

export interface TaskDefinition {
  mode: TaskMode;
  command: string[];
  runtime?: TaskRuntime;
  timeout_seconds?: number;
  parameters?: Record<string, TaskParameter>;
  secrets?: TaskSecretBinding[];
}

export interface TaskManifest {
  version: number;
  tasks: Record<string, TaskDefinition>;
}

export interface ApprovedTasks {
  manifestSha256: string;
  taskIds: string[];
}

export interface EnvironmentFingerprint {
  environmentSource: string;
  pythonVersion: string | null;
  dependencyLockSha256: string | null;
  dependencyLockPath: string | null;
}

export interface CapabilityFingerprint {
  manifestSha256: string | null;
  taskIds: string[];
  environment?: EnvironmentFingerprint;
  secretRefs: string[];
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TASKS_FILE = ".devspace/tasks.yaml";

export function loadTaskManifest(workspaceRoot: string): TaskManifest {
  const path = join(workspaceRoot, TASKS_FILE);
  if (!existsSync(path)) {
    throw new TaskError({
      code: "TASK_MANIFEST_NOT_FOUND",
      manifestPath: path,
      message: `Task manifest not found: ${TASKS_FILE}`,
      recoverable: true,
    });
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new TaskError({
      code: "TASK_MANIFEST_YAML_INVALID",
      manifestPath: path,
      message: "Task manifest contains invalid YAML.",
      recoverable: true,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new TaskError({
      code: "TASK_MANIFEST_SCHEMA_ERROR",
      manifestPath: path,
      message: "Task manifest root must be an object.",
      recoverable: true,
    });
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number" || obj.version < 1) {
    throw new TaskError({
      code: "TASK_MANIFEST_SCHEMA_ERROR",
      manifestPath: path,
      field: "version",
      message: "Task manifest version must be a number >= 1.",
      recoverable: true,
    });
  }
  if (!obj.tasks || typeof obj.tasks !== "object") {
    throw new TaskError({
      code: "TASK_MANIFEST_SCHEMA_ERROR",
      manifestPath: path,
      field: "tasks",
      message: "Task manifest requires a 'tasks' map.",
      recoverable: true,
    });
  }

  const tasks: Record<string, TaskDefinition> = {};
  for (const [id, def] of Object.entries(
    obj.tasks as Record<string, unknown>,
  )) {
    if (typeof def !== "object" || def === null) {
      throw new TaskError({
        code: "TASK_MANIFEST_SCHEMA_ERROR",
        manifestPath: path,
        field: `tasks.${id}`,
        message: `Task ${id} must be an object.`,
        recoverable: true,
      });
    }
    const d = def as Record<string, unknown>;
    const mode = d.mode;
    if (mode !== "run" && mode !== "session") {
      throw new TaskError({
        code: "TASK_MANIFEST_SCHEMA_ERROR",
        manifestPath: path,
        taskId: id,
        field: "mode",
        message: `Task ${id}: mode must be 'run' or 'session'.`,
        recoverable: true,
      });
    }
    if (!Array.isArray(d.command) || d.command.length === 0) {
      throw new TaskError({
        code: "TASK_MANIFEST_SCHEMA_ERROR",
        manifestPath: path,
        taskId: id,
        field: "command",
        message: `Task ${id}: command must be a non-empty array.`,
        recoverable: true,
      });
    }
    if (!d.command.every((a: unknown) => typeof a === "string")) {
      throw new TaskError({
        code: "TASK_MANIFEST_SCHEMA_ERROR",
        manifestPath: path,
        taskId: id,
        field: "command",
        message: `Task ${id}: all command elements must be strings.`,
        recoverable: true,
      });
    }

    const runtime = d.runtime;
    if (
      runtime !== undefined &&
      runtime !== "workspace-python" &&
      runtime !== "operator-python-bootstrap" &&
      runtime !== "system"
    ) {
      throw new TaskError({
        code: "TASK_EXECUTOR_UNSUPPORTED",
        manifestPath: path,
        taskId: id,
        field: "runtime",
        message: `Task ${id}: unsupported runtime '${runtime}'.`,
        recoverable: true,
      });
    }

    const timeout = d.timeout_seconds;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || timeout <= 0)
    ) {
      throw new TaskError({
        code: "TASK_MANIFEST_SCHEMA_ERROR",
        manifestPath: path,
        taskId: id,
        field: "timeout_seconds",
        message: `Task ${id}: timeout_seconds must be a positive number.`,
        recoverable: true,
      });
    }

    let parameters: Record<string, TaskParameter> | undefined;
    if (d.parameters) {
      if (typeof d.parameters !== "object" || d.parameters === null) {
        throw new TaskError({
          code: "TASK_MANIFEST_SCHEMA_ERROR",
          manifestPath: path,
          taskId: id,
          field: "parameters",
          message: `Task ${id}: parameters must be an object.`,
          recoverable: true,
        });
      }
      parameters = {};
      for (const [pname, pdef] of Object.entries(
        d.parameters as Record<string, unknown>,
      )) {
        if (typeof pdef !== "object" || pdef === null) {
          throw new TaskError({
            code: "TASK_PARAMETER_SCHEMA_INVALID",
            manifestPath: path,
            taskId: id,
            field: `parameters.${pname}`,
            message: `Task ${id}: parameter ${pname} must be an object.`,
            recoverable: true,
          });
        }
        const pd = pdef as Record<string, unknown>;
        const ptype = pd.type;
        if (
          ptype !== "string" &&
          ptype !== "path" &&
          ptype !== "sha256" &&
          ptype !== "int"
        ) {
          throw new TaskError({
            code: "TASK_PARAMETER_SCHEMA_INVALID",
            manifestPath: path,
            taskId: id,
            field: `parameters.${pname}.type`,
            message: `Task ${id}: parameter ${pname} type must be string, path, sha256, or int.`,
            recoverable: true,
          });
        }
        const param: TaskParameter = { type: ptype };
        if (pd.required !== undefined) {
          if (typeof pd.required !== "boolean") {
            throw new TaskError({
              code: "TASK_PARAMETER_SCHEMA_INVALID",
              manifestPath: path,
              taskId: id,
              field: `parameters.${pname}.required`,
              message: `Task ${id}: parameter ${pname} required must be boolean.`,
              recoverable: true,
            });
          }
          param.required = pd.required;
        }
        if (pd.pattern !== undefined) {
          if (typeof pd.pattern !== "string") {
            throw new TaskError({
              code: "TASK_PARAMETER_SCHEMA_INVALID",
              manifestPath: path,
              taskId: id,
              field: `parameters.${pname}.pattern`,
              message: `Task ${id}: parameter ${pname} pattern must be a string.`,
              recoverable: true,
            });
          }
          param.pattern = pd.pattern;
        }
        if (pd.min !== undefined) {
          if (typeof pd.min !== "number") {
            throw new TaskError({
              code: "TASK_PARAMETER_SCHEMA_INVALID",
              manifestPath: path,
              taskId: id,
              field: `parameters.${pname}.min`,
              message: `Task ${id}: parameter ${pname} min must be a number.`,
              recoverable: true,
            });
          }
          param.min = pd.min;
        }
        if (pd.max !== undefined) {
          if (typeof pd.max !== "number") {
            throw new TaskError({
              code: "TASK_PARAMETER_SCHEMA_INVALID",
              manifestPath: path,
              taskId: id,
              field: `parameters.${pname}.max`,
              message: `Task ${id}: parameter ${pname} max must be a number.`,
              recoverable: true,
            });
          }
          param.max = pd.max;
        }
        parameters[pname] = param;
      }
    }

    if (runtime === "operator-python-bootstrap") {
      const command = d.command as string[];
      const target = command[2];
      if (
        mode !== "run" ||
        command.length !== 3 ||
        command[0] !== "-m" ||
        command[1] !== "venv" ||
        (target !== ".venv" && target !== "venv")
      ) {
        throw new TaskError({
          code: "TASK_MANIFEST_SCHEMA_ERROR",
          manifestPath: path,
          taskId: id,
          field: "command",
          message:
            `Task ${id}: operator-python-bootstrap must be a run task with command ` +
            '["-m", "venv", ".venv"] or ["-m", "venv", "venv"].',
          recoverable: true,
        });
      }
      if (parameters && Object.keys(parameters).length > 0) {
        throw new TaskError({
          code: "TASK_MANIFEST_SCHEMA_ERROR",
          manifestPath: path,
          taskId: id,
          field: "parameters",
          message: `Task ${id}: operator-python-bootstrap does not accept parameters.`,
          recoverable: true,
        });
      }
    }

    // Validate secret bindings
    let secrets: TaskSecretBinding[] | undefined;
    if (d.secrets) {
      if (!Array.isArray(d.secrets)) {
        throw new TaskError({
          code: "TASK_MANIFEST_SCHEMA_ERROR",
          manifestPath: path,
          taskId: id,
          field: "secrets",
          message: `Task ${id}: secrets must be an array.`,
          recoverable: true,
        });
      }
      secrets = [];
      for (let i = 0; i < (d.secrets as unknown[]).length; i++) {
        const sb = (d.secrets as unknown[])[i];
        if (typeof sb !== "object" || sb === null) {
          throw new TaskError({
            code: "TASK_MANIFEST_SCHEMA_ERROR",
            manifestPath: path,
            taskId: id,
            field: `secrets[${i}]`,
            message: `Task ${id}: secrets[${i}] must be an object.`,
            recoverable: true,
          });
        }
        const s = sb as Record<string, unknown>;
        if (typeof s.secret_ref !== "string" || s.secret_ref.length === 0) {
          throw new TaskError({
            code: "TASK_MANIFEST_SCHEMA_ERROR",
            manifestPath: path,
            taskId: id,
            field: `secrets[${i}].secret_ref`,
            message: `Task ${id}: secrets[${i}].secret_ref must be a non-empty string.`,
            recoverable: true,
          });
        }
        if (typeof s.target_env !== "string" || s.target_env.length === 0) {
          throw new TaskError({
            code: "TASK_MANIFEST_SCHEMA_ERROR",
            manifestPath: path,
            taskId: id,
            field: `secrets[${i}].target_env`,
            message: `Task ${id}: secrets[${i}].target_env must be a non-empty string.`,
            recoverable: true,
          });
        }
        secrets.push({
          secret_ref: s.secret_ref as string,
          target_env: s.target_env as string,
        });
      }
    }

    tasks[id] = {
      mode,
      command: d.command as string[],
      runtime: runtime as TaskRuntime | undefined,
      timeout_seconds: timeout as number | undefined,
      parameters,
      secrets,
    };
  }

  return { version: obj.version, tasks };
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export function computeManifestSha256(workspaceRoot: string): string | null {
  const path = join(workspaceRoot, TASKS_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Approval check
// ---------------------------------------------------------------------------

export function isTaskApproved(
  taskId: string,
  approved: ApprovedTasks,
): boolean {
  return approved.taskIds.includes(taskId);
}

export function checkManifestIntegrity(
  workspaceRoot: string,
  approved: ApprovedTasks,
): boolean {
  const current = computeManifestSha256(workspaceRoot);
  return current === approved.manifestSha256;
}

// ---------------------------------------------------------------------------
// Capability Fingerprint
// ---------------------------------------------------------------------------

export function computeEnvironmentFingerprint(input: {
  environmentSource: string;
  pythonVersion: string | null;
  dependencyLockPath: string | null;
  dependencyLockSha256: string | null;
}): EnvironmentFingerprint {
  return {
    environmentSource: input.environmentSource,
    pythonVersion: input.pythonVersion,
    dependencyLockSha256: input.dependencyLockSha256,
    dependencyLockPath: input.dependencyLockPath,
  };
}

export function computeCapabilityFingerprint(input: {
  manifestSha256: string | null;
  taskIds: string[];
  secretRefs?: string[];
  environment?: {
    environmentSource: string;
    pythonVersion: string | null;
    dependencyLockPath: string | null;
    dependencyLockSha256: string | null;
  };
}): CapabilityFingerprint {
  return {
    manifestSha256: input.manifestSha256,
    taskIds: [...input.taskIds],
    secretRefs: [...(input.secretRefs ?? [])],
    environment: input.environment
      ? computeEnvironmentFingerprint(input.environment)
      : undefined,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Parameter validation & substitution
// ---------------------------------------------------------------------------

export interface ParamValidationError {
  param: string;
  message: string;
}

export function validateAndSubstitute(
  task: TaskDefinition,
  params: Record<string, string>,
  workspaceRoot: string,
  allowedRoots: string[],
): { command: string[]; errors: ParamValidationError[] } {
  const errors: ParamValidationError[] = [];
  const subst = new Map<string, string>();

  // Validate provided params against declared parameters
  for (const [name, value] of Object.entries(params)) {
    const def = task.parameters?.[name];
    if (!def) {
      errors.push({ param: name, message: `Undeclared parameter: ${name}` });
      continue;
    }
    switch (def.type) {
      case "string":
        subst.set(name, value);
        break;
      case "path":
        if (
          !isPathInsideRoot(value, workspaceRoot) &&
          !allowedRoots.some((r) => isPathInsideRoot(value, r))
        ) {
          errors.push({
            param: name,
            message: `Path parameter ${name} is outside allowed roots: ${value}`,
          });
        } else {
          subst.set(name, value);
        }
        break;
      case "sha256":
        if (!/^[0-9a-f]{64}$/.test(value)) {
          errors.push({
            param: name,
            message: `SHA-256 parameter ${name} must be 64 hex chars: ${value}`,
          });
        } else {
          subst.set(name, value);
        }
        break;
      case "int":
        const num = Number(value);
        if (!Number.isInteger(num)) {
          errors.push({
            param: name,
            message: `Int parameter ${name} is not an integer: ${value}`,
          });
        } else if (def.min !== undefined && num < def.min) {
          errors.push({
            param: name,
            message: `${name} must be >= ${def.min}`,
          });
        } else if (def.max !== undefined && num > def.max) {
          errors.push({
            param: name,
            message: `${name} must be <= ${def.max}`,
          });
        } else {
          subst.set(name, value);
        }
        break;
    }
  }

  // Check required params
  if (task.parameters) {
    for (const [name, def] of Object.entries(task.parameters)) {
      if (def.required && !subst.has(name)) {
        errors.push({
          param: name,
          message: `Required parameter ${name} is missing`,
        });
      }
    }
  }

  // Substitute
  const command = task.command.map((arg) => {
    return arg.replace(/\$\{(\w+)\}/g, (_match, name) => {
      return subst.get(name) ?? `\${${name}}`;
    });
  });

  return { command, errors };
}
