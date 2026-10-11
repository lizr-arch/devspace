/**
 * Read-only detection of foreign processes holding a managed worktree.
 *
 * DevSpace knows about the work it started — jobs, task sessions, game
 * sessions, in-flight tool calls. It cannot see a shell, an editor or a build
 * the operator started by hand inside a worktree. Reclaiming a worktree out
 * from under a running process would be a real, destructive accident, so the
 * lifecycle audit asks the operating system instead of guessing.
 *
 * This module only *reads* process metadata (`lsof`, plus the directory's own
 * mtime as a tie-breaker). It never signals, suspends or kills anything.
 */
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeProcessOccupancy {
  /** Process ids whose working directory is this exact directory. */
  pids: number[];
  /** Command names, redacted of arguments, for reporting only. */
  commands: string[];
  /** True when the probe could not run at all (missing lsof, timeout). */
  unknown: boolean;
  /** Why the probe could not run, when it could not. */
  reason?: string;
}

export interface WorktreeProcessProbe {
  /**
   * Occupancy of one worktree root. Implementations must be read-only and must
   * report `unknown: true` rather than `pids: []` when they cannot tell the
   * difference between "free" and "not checked".
   */
  occupancyOf(path: string): Promise<WorktreeProcessOccupancy>;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  at: number;
  value: WorktreeProcessOccupancy;
}

/**
 * `lsof`-backed probe.
 *
 * Results are cached briefly because the audit asks once per worktree and a
 * whole plan can cover dozens of them.
 */
export class LsofWorktreeProcessProbe implements WorktreeProcessProbe {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly options: {
      timeoutMs?: number;
      cacheTtlMs?: number;
      now?: () => number;
      /**
       * Process names that are DevSpace's own bookkeeping and must not be
       * reported as foreign holders. The MCP server itself always has a handle
       * on directories it is inspecting.
       */
      ignoredCommandPatterns?: RegExp[];
    } = {},
  ) {}

  async occupancyOf(path: string): Promise<WorktreeProcessOccupancy> {
    const now = this.options.now?.() ?? Date.now();
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cached = this.cache.get(path);
    if (cached && now - cached.at < ttl) return cached.value;

    const value = await this.probe(path);
    this.cache.set(path, { at: now, value });
    return value;
  }

  private async probe(path: string): Promise<WorktreeProcessOccupancy> {
    const target = resolve(path);
    let output = "";
    let failed = false;
    let failureReason = "the process probe could not run (is lsof installed?)";
    try {
      const result = await execFileAsync(
        "lsof",
        ["-n", "-F", "pcn", "-a", "-d", "cwd", "+d", target],
        {
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      output = result.stdout;
    } catch (error) {
      const failure = error as {
        code?: unknown;
        killed?: boolean;
        stdout?: string;
        signal?: string;
      };
      if (failure.killed === true) {
        failed = true;
        failureReason = "the process probe timed out";
      } else if (typeof failure.stdout === "string" && failure.stdout.length > 0) {
        // Critical: `lsof` exits 1 *with output* when it found matches for a
        // subset of its filters. Treating a non-zero exit as "nothing found"
        // would report a worktree with a live shell in it as free.
        output = failure.stdout;
      } else if (failure.code === 1 || failure.code === "1") {
        // Exit 1 with no output at all: nothing is using the directory.
        output = "";
      } else {
        failed = true;
      }
    }

    if (failed && output.length === 0) {
      return {
        pids: [],
        commands: [],
        unknown: true,
        reason: failureReason,
      };
    }

    // Only the probe's own helper is ignored. Ignoring all `node` processes
    // would hide a legitimate hand-started Node build in a worktree, and an
    // over-broad ignore list is exactly how a "safe" reclamation turns into a
    // destructive one.
    const ignored = this.options.ignoredCommandPatterns ?? [/^lsof$/];
    const pids: number[] = [];
    const commands: string[] = [];
    let currentPid: number | null = null;
    let currentCommand: string | null = null;
    let sawTargetCwd = false;
    for (const line of output.split("\n")) {
      if (!line) continue;
      const tag = line[0];
      const rest = line.slice(1);
      if (tag === "p") {
        currentPid = Number(rest);
        currentCommand = null;
        continue;
      }
      if (tag === "c") {
        currentCommand = rest.trim();
        continue;
      }
      if (tag !== "n") continue;
      // `+d` reports every directory at or below the target in one pass; only
      // an exact match is the worktree's own working directory.
      const cwd = rest.trim();
      if (cwd !== target) continue;
      sawTargetCwd = true;
      if (currentPid === null || currentPid === process.pid) continue;
      const command = currentCommand;
      if (command !== null && ignored.some((re) => re.test(command))) {
        continue;
      }
      if (!pids.includes(currentPid)) pids.push(currentPid);
      if (command !== null && !commands.includes(command)) {
        commands.push(command);
      }
    }
    if (failed && !sawTargetCwd && output.length === 0) {
      return {
        pids: [],
        commands: [],
        unknown: true,
        reason: failureReason,
      };
    }
    return { pids, commands, unknown: false };
  }
}

/**
 * Directory mtime as a weak, read-only signal that something wrote into the
 * worktree very recently. It never *blocks* a reclamation on its own; it only
 * adds a risk note when the process probe could not run.
 */
export function looksRecentlyTouched(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs < 60_000;
}

export function isDirectWorktreeChild(
  worktreeRoot: string,
  candidatePath: string,
): boolean {
  const normalized = resolve(candidatePath);
  return (
    dirname(normalized) === resolve(worktreeRoot) &&
    basename(normalized).length > 0
  );
}
