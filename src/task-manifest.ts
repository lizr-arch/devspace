import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { existsSync } from "node:fs";
import { isPathInsideRoot } from "./roots.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskMode = "run" | "session";

export type TaskRuntime = "workspace-python" | "system";

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
}

export interface TaskManifest {
  version: number;
  tasks: Record<string, TaskDefinition>;
}

export interface ApprovedTasks {
  manifestSha256: string;
  taskIds: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TASKS_FILE = ".devspace/tasks.yaml";

export function loadTaskManifest(workspaceRoot: string): TaskManifest | null {
  const path = join(workspaceRoot, TASKS_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number" || obj.version < 1) return null;
  if (!obj.tasks || typeof obj.tasks !== "object") return null;

  const tasks: Record<string, TaskDefinition> = {};
  for (const [id, def] of Object.entries(
    obj.tasks as Record<string, unknown>,
  )) {
    if (typeof def !== "object" || def === null) return null;
    const d = def as Record<string, unknown>;
    const mode = d.mode;
    if (mode !== "run" && mode !== "session") return null;
    if (!Array.isArray(d.command) || d.command.length === 0) return null;
    if (!d.command.every((a: unknown) => typeof a === "string")) return null;

    const runtime = d.runtime;
    if (
      runtime !== undefined &&
      runtime !== "workspace-python" &&
      runtime !== "system"
    )
      return null;

    const timeout = d.timeout_seconds;
    if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0))
      return null;

    let parameters: Record<string, TaskParameter> | undefined;
    if (d.parameters) {
      if (typeof d.parameters !== "object" || d.parameters === null)
        return null;
      parameters = {};
      for (const [pname, pdef] of Object.entries(
        d.parameters as Record<string, unknown>,
      )) {
        if (typeof pdef !== "object" || pdef === null) return null;
        const pd = pdef as Record<string, unknown>;
        const ptype = pd.type;
        if (
          ptype !== "string" &&
          ptype !== "path" &&
          ptype !== "sha256" &&
          ptype !== "int"
        )
          return null;
        const param: TaskParameter = { type: ptype };
        if (pd.required !== undefined) {
          if (typeof pd.required !== "boolean") return null;
          param.required = pd.required;
        }
        if (pd.pattern !== undefined) {
          if (typeof pd.pattern !== "string") return null;
          param.pattern = pd.pattern;
        }
        if (pd.min !== undefined) {
          if (typeof pd.min !== "number") return null;
          param.min = pd.min;
        }
        if (pd.max !== undefined) {
          if (typeof pd.max !== "number") return null;
          param.max = pd.max;
        }
        parameters[pname] = param;
      }
    }

    tasks[id] = {
      mode,
      command: d.command as string[],
      runtime: runtime as TaskRuntime | undefined,
      timeout_seconds: timeout as number | undefined,
      parameters,
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
