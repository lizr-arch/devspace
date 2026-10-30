/**
 * P0-03 fix: keep the isolated wake sidecar's read-only event snapshot in sync
 * with the live DevSpace Coach event store.
 *
 * Route problem this solves (route-audit REPORT.md): the 8788 wake sidecar holds
 * `<snapshotDir>/coach-review-events.sqlite` open read-only and the bound Chrome
 * conversation polls that sidecar. Native review events are written to the live
 * DevSpace store by CoachReviewEventStore, i.e. a DIFFERENT file. Without a
 * refresh the browser route can never see them.
 *
 * Design constraints:
 *  - The live store is only ever opened READ-ONLY (`file:<path>?mode=ro`).
 *  - The snapshot is rewritten in place (sqlite `.backup`), which route-audit T2
 *    proved is observed by the already-running sidecar without a restart.
 *  - Never point the sidecar at the production directory: ManagedCoachSidecar
 *    derives writable receipt/wake/handoff files from dirname(native db).
 *  - Never throws from the polling loop; failures are recorded and retried on
 *    the next tick; freshness is observable so health checks can fail closed.
 *  - Only `codex_app_*`/coach_review_events rows are copied wholesale; there is
 *    no message content, no token, no auth material in this path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export interface SnapshotRefreshResult {
  ok: boolean;
  at: string;
  sourcePath: string;
  snapshotPath: string;
  sourceMtimeMs: number | null;
  snapshotMtimeMs: number | null;
  lagMs: number | null;
  durationMs: number;
  checkpoint?: "OK" | "FAILED" | "SKIPPED";
  error?: string;
}

export interface SnapshotRefresherStatus {
  running: boolean;
  intervalMs: number;
  last: SnapshotRefreshResult | null;
  consecutiveFailures: number;
  totalRefreshes: number;
  totalFailures: number;
}

export interface SnapshotRuntime {
  run: (argv: string[], opts: { timeoutMs: number }) => { status: number | null; stdout: string; stderr: string; error?: Error | null };
  statMtimeMs: (path: string) => number | null;
  exists: (path: string) => boolean;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  log: (line: string) => void;
}

export const DEFAULT_REFRESH_INTERVAL_MS = 3_000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
/** Snapshot older than this is considered stale for route health. */
export const DEFAULT_STALE_AFTER_MS = 15_000;

const REAL_RUNTIME: SnapshotRuntime = {
  run: (argv, opts) => {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: 1_000_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
  },
  statMtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  log: (line) => console.warn(line),
};

function resolveRuntime(overrides?: Partial<SnapshotRuntime>): SnapshotRuntime {
  return { ...REAL_RUNTIME, ...(overrides ?? {}) };
}

/** Quote for the sqlite3 CLI double-quoted string context. */
export function quoteSqlitePath(path: string): string {
  return '"' + path.replace(/"/g, '""') + '"';
}

/** Build the read-only `.backup` invocation (source never opened writable). */
export function buildSnapshotRefreshArgv(sourcePath: string, snapshotPath: string): string[] {
  if (!sourcePath.startsWith("/") || !snapshotPath.startsWith("/"))
    throw new Error("SNAPSHOT_PATH_NOT_ABSOLUTE");
  if (sourcePath === snapshotPath) throw new Error("SNAPSHOT_SOURCE_EQUALS_TARGET");
  if (/[\0\n\r]/.test(sourcePath) || /[\0\n\r]/.test(snapshotPath))
    throw new Error("SNAPSHOT_PATH_INVALID");
  return ["/usr/bin/sqlite3", `file:${sourcePath}?mode=ro`, `.backup ${quoteSqlitePath(snapshotPath)}`];
}

/**
 * Refresh the snapshot once. Synchronous and bounded; the caller decides whether
 * a missing snapshot should be created (`createIfMissing`, default true) or a
 * missing target should be an error (strict mode).
 */
export function refreshNativeEventSnapshot(
  input: { sourcePath: string; snapshotPath: string; timeoutMs?: number; allowCreate?: boolean; checkpointTarget?: boolean },
  deps: Partial<SnapshotRuntime> = {},
): SnapshotRefreshResult {
  const rt = resolveRuntime(deps);
  const started = rt.now();
  const base = {
    at: new Date(started).toISOString(),
    sourcePath: input.sourcePath,
    snapshotPath: input.snapshotPath,
  };
  if (!rt.exists(input.sourcePath))
    return { ...base, ok: false, sourceMtimeMs: null, snapshotMtimeMs: null, lagMs: null, durationMs: rt.now() - started, error: "SOURCE_DATABASE_MISSING" };
  const allowCreate = input.allowCreate !== false;
  if (!allowCreate && !rt.exists(input.snapshotPath))
    return { ...base, ok: false, sourceMtimeMs: null, snapshotMtimeMs: null, lagMs: null, durationMs: rt.now() - started, error: "SNAPSHOT_DATABASE_MISSING" };
  let argv: string[];
  try {
    argv = buildSnapshotRefreshArgv(input.sourcePath, input.snapshotPath);
  } catch (error) {
    return { ...base, ok: false, sourceMtimeMs: null, snapshotMtimeMs: null, lagMs: null, durationMs: rt.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
  const r = rt.run(argv, { timeoutMs: input.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS });
  const sourceMtimeMs = rt.statMtimeMs(input.sourcePath);
  const snapshotMtimeMs = rt.statMtimeMs(input.snapshotPath);
  const lagMs = sourceMtimeMs !== null && snapshotMtimeMs !== null ? Math.max(0, sourceMtimeMs - snapshotMtimeMs) : null;
  if (r.error)
    return { ...base, ok: false, sourceMtimeMs, snapshotMtimeMs, lagMs, durationMs: rt.now() - started, error: `spawn_error:${r.error.message}` };
  if (r.status !== 0)
    return { ...base, ok: false, sourceMtimeMs, snapshotMtimeMs, lagMs, durationMs: rt.now() - started, error: `sqlite_backup_exit_${r.status}:${(r.stderr || "").trim().slice(0, 300)}` };
  if (!rt.exists(input.snapshotPath))
    return { ...base, ok: false, sourceMtimeMs, snapshotMtimeMs, lagMs, durationMs: rt.now() - started, error: "SNAPSHOT_MISSING_AFTER_BACKUP" };
  // The target file may already be in WAL mode; sqlite `.backup` can leave the
  // new pages in the target WAL, which keeps the main file's mtime stale and
  // lets the WAL grow on every refresh. Truncate it in place so the running
  // read-only sidecar sees the fresh pages and freshness mtime advances.
  const checkpoint = input.checkpointTarget === false
    ? "SKIPPED"
    : (() => {
        const cp = rt.run(["/usr/bin/sqlite3", input.snapshotPath, "PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);"], {
          timeoutMs: input.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
        });
        return !cp.error && cp.status === 0 ? "OK" : "FAILED";
      })();
  const snapshotMtimeAfter = rt.statMtimeMs(input.snapshotPath);
  const lagAfter = sourceMtimeMs !== null && snapshotMtimeAfter !== null ? Math.max(0, sourceMtimeMs - snapshotMtimeAfter) : null;
  return { ...base, ok: true, sourceMtimeMs, snapshotMtimeMs: snapshotMtimeAfter, lagMs: lagAfter, durationMs: rt.now() - started, checkpoint };
}

/** Read-only freshness view used by health/preflight (no writes). */
export function snapshotFreshness(
  input: { sourcePath: string; snapshotPath: string; staleAfterMs?: number },
  deps: Partial<SnapshotRuntime> = {},
): { fresh: boolean; reason?: string; staleAfterMs: number; sourceMtimeMs: number | null; snapshotMtimeMs: number | null; lagMs: number | null; snapshotRows?: number } {
  const rt = resolveRuntime(deps);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const sourceMtimeMs = rt.statMtimeMs(input.sourcePath);
  const snapshotMtimeMs = rt.statMtimeMs(input.snapshotPath);
  if (sourceMtimeMs === null) return { fresh: false, reason: "SOURCE_DATABASE_MISSING", staleAfterMs, sourceMtimeMs, snapshotMtimeMs, lagMs: null };
  if (snapshotMtimeMs === null) return { fresh: false, reason: "SNAPSHOT_DATABASE_MISSING", staleAfterMs, sourceMtimeMs, snapshotMtimeMs, lagMs: null };
  const lagMs = Math.max(0, sourceMtimeMs - snapshotMtimeMs);
  if (lagMs > staleAfterMs) return { fresh: false, reason: `SNAPSHOT_LAG_${lagMs}MS`, staleAfterMs, sourceMtimeMs, snapshotMtimeMs, lagMs };
  return { fresh: true, staleAfterMs, sourceMtimeMs, snapshotMtimeMs, lagMs };
}

/**
 * Resident refresher for the DevSpace service (activated by
 * `DEVSPACE_NATIVE_EVENT_SNAPSHOT_PATH`). Restart-safe: no in-memory cursor is
 * needed; every tick re-reads both files. Single-flight so a slow `.backup` can
 * never overlap the next tick.
 */
export function startNativeEventSnapshotRefresher(opts: {
  sourcePath: string;
  snapshotPath: string;
  intervalMs?: number;
  timeoutMs?: number;
  deps?: Partial<SnapshotRuntime>;
}): { tick: () => Promise<SnapshotRefreshResult>; stop: () => void; status: () => SnapshotRefresherStatus } {
  const rt = resolveRuntime(opts.deps);
  const intervalMs = Math.max(500, opts.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
  let last: SnapshotRefreshResult | null = null;
  let inFlight = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let totalRefreshes = 0;
  let totalFailures = 0;
  const tick = async (): Promise<SnapshotRefreshResult> => {
    if (stopped) return { ...emptyResult(opts, rt), ok: false, error: "REFRESHER_STOPPED" };
    if (inFlight) return last ?? { ...emptyResult(opts, rt), ok: false, error: "REFRESH_IN_PROGRESS" };
    inFlight = true;
    try {
      const result = refreshNativeEventSnapshot(
        { sourcePath: opts.sourcePath, snapshotPath: opts.snapshotPath, timeoutMs: opts.timeoutMs },
        opts.deps,
      );
      last = result;
      totalRefreshes++;
      if (result.ok) consecutiveFailures = 0;
      else {
        consecutiveFailures++;
        totalFailures++;
        rt.log(JSON.stringify({ event: "native_event_snapshot_refresh_failed", error: result.error, consecutiveFailures }));
      }
      return result;
    } finally {
      inFlight = false;
    }
  };
  const handle = rt.setInterval(() => {
    void tick().catch((error) => {
      consecutiveFailures++;
      totalFailures++;
      rt.log(JSON.stringify({ event: "native_event_snapshot_refresh_threw", error: error instanceof Error ? error.message : String(error) }));
    });
  }, intervalMs);
  void tick().catch(() => undefined);
  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      rt.clearInterval(handle);
    },
    status: () => ({ running: !stopped, intervalMs, last, consecutiveFailures, totalRefreshes, totalFailures }),
  };
}

function emptyResult(opts: { sourcePath: string; snapshotPath: string }, rt: SnapshotRuntime): SnapshotRefreshResult {
  return {
    ok: false,
    at: new Date(rt.now()).toISOString(),
    sourcePath: opts.sourcePath,
    snapshotPath: opts.snapshotPath,
    sourceMtimeMs: null,
    snapshotMtimeMs: null,
    lagMs: null,
    durationMs: 0,
  };
}
