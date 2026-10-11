/**
 * Resource locks for background jobs.
 *
 * The runner registry bounds how many jobs may run at once, but it has no
 * notion of *where* they run. Two `dotnet` jobs in the same workspace are
 * within the concurrency limit and will happily overwrite each other's
 * `obj/`, `bin/` and managed assemblies, which silently invalidates whatever
 * the first one was measuring. A Phase 20 performance number produced under
 * that race is worthless even if it says PASS.
 *
 * Locks are keyed by canonical resource identity, not by job:
 *
 *   - `workspace:<real root>`  — exclusive per workspace for every job that
 *     can write build output. Independent workspaces still run in parallel.
 *   - `godot-project:<real root>` — shared by editor imports and Godot runner
 *     jobs, because both read and write the same `.godot` import cache.
 *   - `game-session:<workspace id>` — one real GUI session per workspace.
 *
 * Lifetime rules that matter:
 *   - a lock is released when the job reaches a TERMINAL state, not when the
 *     helper process happens to exit, so a cancelled or timed-out job cannot
 *     strand a lock;
 *   - spawn failure releases immediately;
 *   - a restart starts with no locks at all, and jobs recovered as
 *     `JOB_INTERRUPTED` are terminal, so nothing survives a crash.
 */
import { realpathSync } from "node:fs";
import type { RunnerName } from "./runner-types.js";

export type ResourceLockKind =
  | "workspace"
  | "godot-project"
  | "game-session"
  | "sidecar-service"
  | "sidecar-endpoint";

export type ResourceLockProvenance = "job" | "sidecar";
export type ResourceLockOwner = RunnerName | "sidecar";

export interface ResourceLockRequest {
  kind: ResourceLockKind;
  /** Filesystem paths are canonicalised; validated sidecar IDs remain literal. */
  value: string;
}

export interface ReadonlySidecarResourceInput {
  serviceName: string;
  port: number;
}

export interface HeldResourceLock extends ResourceLockRequest {
  key: string;
  jobId: string;
  runner: ResourceLockOwner;
  provenance?: ResourceLockProvenance;
  workspaceRoot: string;
  acquiredAt: string;
}

export class ResourceLockBusyError extends Error {
  readonly code = "JOB_RESOURCE_BUSY";
  readonly heldBy: { jobId: string; runner: ResourceLockOwner; acquiredAt: string };
  readonly resource: string;

  constructor(resource: string, holder: HeldResourceLock) {
    super(
      `JOB_RESOURCE_BUSY: ${resource} is already in use by job ${holder.jobId} (${holder.runner}). ` +
        `Concurrent jobs that write the same build outputs or Godot import cache would invalidate each other's results. ` +
        `Wait for it with wait_job, cancel it with cancel_job, or use a separate workspace.`,
    );
    this.name = "ResourceLockBusyError";
    this.resource = resource;
    this.heldBy = {
      jobId: holder.jobId,
      runner: holder.runner,
      acquiredAt: holder.acquiredAt,
    };
  }
}

/** Runners whose invocations can write build output inside a workspace. */
const BUILD_WRITERS: ReadonlySet<RunnerName> = new Set<RunnerName>([
  "dotnet",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "hython",
  "hbatch",
  "blender",
  "pytest",
]);

/** Runners that touch a Godot project's import cache. */
const GODOT_RUNNERS: ReadonlySet<RunnerName> = new Set<RunnerName>([
  "godot",
  "godot-mono",
]);

export class JobResourceLocks {
  private readonly held = new Map<string, HeldResourceLock>();

  /**
   * Compute the resources a job must hold. A job that cannot write anything
   * (and is not a Godot run) takes no lock, so unrelated read-only work stays
   * fully parallel.
   */
  static requestsFor(input: {
    runner: RunnerName;
    workspaceRoot: string;
    godotEditorImport?: boolean;
  }): ResourceLockRequest[] {
    const requests: ResourceLockRequest[] = [];
    if (BUILD_WRITERS.has(input.runner)) {
      requests.push({ kind: "workspace", value: input.workspaceRoot });
    }
    if (GODOT_RUNNERS.has(input.runner) || input.godotEditorImport === true) {
      requests.push({ kind: "godot-project", value: input.workspaceRoot });
    }
    return requests;
  }

  static keyFor(request: ResourceLockRequest): string {
    if (request.kind === "sidecar-service") {
      validateSidecarServiceName(request.value);
      return `${request.kind}:${request.value}`;
    }
    if (request.kind === "sidecar-endpoint") {
      validateSidecarEndpoint(request.value);
      return `${request.kind}:${request.value}`;
    }
    return `${request.kind}:${canonicalResource(request.value)}`;
  }

  static requestsForReadonlySidecar(
    input: ReadonlySidecarResourceInput,
  ): ResourceLockRequest[] {
    validateSidecarServiceName(input.serviceName);
    validateLoopbackPort(input.port);
    return [
      { kind: "sidecar-service", value: input.serviceName },
      { kind: "sidecar-endpoint", value: `127.0.0.1:${input.port}` },
    ];
  }

  /**
   * Acquire every requested resource or nothing at all. Partial acquisition is
   * never left behind, so a rejected job cannot block a later one.
   */
  acquire(input: {
    jobId: string;
    runner: ResourceLockOwner;
    workspaceRoot: string;
    requests: ResourceLockRequest[];
  }): HeldResourceLock[] {
    const keys = input.requests.map((request) => JobResourceLocks.keyFor(request));
    for (const key of keys) {
      const existing = this.held.get(key);
      if (existing && existing.jobId !== input.jobId) {
        throw new ResourceLockBusyError(key, existing);
      }
    }
    const acquired: HeldResourceLock[] = [];
    input.requests.forEach((request, index) => {
      const lock: HeldResourceLock = {
        ...request,
        key: keys[index],
        jobId: input.jobId,
        runner: input.runner,
        // Leave existing job snapshots unchanged; only sidecars carry new metadata.
        ...(request.kind === "sidecar-service" || request.kind === "sidecar-endpoint"
          ? { provenance: "sidecar" as const }
          : {}),
        workspaceRoot: input.workspaceRoot,
        acquiredAt: new Date().toISOString(),
      };
      this.held.set(lock.key, lock);
      acquired.push(lock);
    });
    return acquired;
  }

  /** Idempotent: releasing an unheld or already-released lock is a no-op. */
  release(jobId: string): number {
    let released = 0;
    for (const [key, lock] of [...this.held.entries()]) {
      if (lock.jobId !== jobId) continue;
      this.held.delete(key);
      released += 1;
    }
    return released;
  }

  releaseAll(): void {
    this.held.clear();
  }

  heldByJob(jobId: string): HeldResourceLock[] {
    return [...this.held.values()].filter((lock) => lock.jobId === jobId);
  }

  snapshot(): HeldResourceLock[] {
    return [...this.held.values()];
  }

  isBusy(request: ResourceLockRequest): boolean {
    return this.held.has(JobResourceLocks.keyFor(request));
  }
}

function validateSidecarServiceName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError("Invalid sidecar service name");
  }
}

function validateLoopbackPort(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new TypeError("Invalid loopback port");
  }
}

function validateSidecarEndpoint(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("Invalid sidecar endpoint");
  }
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[1]) > 65535) {
    throw new TypeError("Invalid sidecar endpoint");
  }
}

/**
 * Resolve a path to its real identity so two spellings of the same directory
 * (symlink, `..`, trailing slash) contend for the same lock instead of
 * silently taking different ones.
 */
function canonicalResource(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Process-wide lock registry.
 *
 * `start_job` and `project_task` are two independent execution paths that can
 * touch the same workspace. Giving each its own registry would let a declared
 * build task and a background job overwrite the same `obj/`, `bin/` and managed
 * assembly while both believe they hold the workspace. One shared registry is
 * what makes the exclusion real across both mechanisms.
 */
export const sharedResourceLocks = new JobResourceLocks();

/**
 * Classify a fully-resolved argv into the resources its run must hold.
 *
 * Used by the declared-task path, which knows the resolved absolute executable
 * rather than a runner name. A declared task is treated as a workspace writer
 * unless it is positively identifiable as a Godot invocation, so the default is
 * conservative: serialization is cheaper than a silently invalidated result.
 */
export function requestsForCommand(input: {
  argv: string[];
  workspaceRoot: string;
}): ResourceLockRequest[] {
  const joined = input.argv.join(" ").toLowerCase();
  const requests: ResourceLockRequest[] = [];
  const isGodot = /(^|[\s/])godot(-mono)?([\s]|$)/.test(joined);
  if (isGodot) {
    requests.push({ kind: "godot-project", value: input.workspaceRoot });
    // A Godot C# run can also trigger a build, and the acceptance suites write
    // user:// state and artifacts, so it takes the workspace lock as well.
    requests.push({ kind: "workspace", value: input.workspaceRoot });
    return requests;
  }
  requests.push({ kind: "workspace", value: input.workspaceRoot });
  return requests;
}
