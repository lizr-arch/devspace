/**
 * Robust, redacted process-inspection helper used by the native outbound
 * daemon/ownership probes (G1).
 *
 * Production incident (2026-10-24T15:18Z): `codex_app_native_send` failed with
 * the opaque PROCESS_INSPECTION_FAILED while the same ps/lsof commands succeeded
 * interactively. The probe used fixed 5s timeouts / small buffers and did not
 * report which sub-step failed, so a transient spawn timeout or buffer overflow
 * under load was indistinguishable from a real identity failure.
 *
 * This helper keeps the fail-closed identity rules while making transient
 * inspection failures observable and retryable exactly once:
 *  - only spawn-level errors (timeout / ENOBUFS / EAGAIN / EMFILE) are retried;
 *  - a nonzero child exit is never retried (it is a real inspection failure);
 *  - failures carry a redacted diagnostic (sub-step, attempts, exit, signal,
 *    error code, whether it timed out, stderr category, byte counts) and never
 *    include command lines, env values, tokens or file content.
 */
import { spawnSync } from "node:child_process";

export const INSPECTION_TIMEOUT_MS = 15_000;
export const INSPECTION_ATTEMPTS = 2;
export const PS_COMM_MAX_BUFFER = 16_000_000;
export const PS_COMMAND_MAX_BUFFER = 32_000_000;
export const LSOF_LOCK_MAX_BUFFER = 1_000_000;
export const LSOF_TEXT_MAX_BUFFER = 4_000_000;

export interface SpawnResultLike {
  status: number | null;
  signal: string | null;
  stdout: string | null;
  stderr: string | null;
  error: { code?: string; message?: string } | null;
}

export type SpawnFn = (cmd: string, args: string[], opts: { encoding: "utf8"; timeout: number; maxBuffer: number }) => SpawnResultLike;

export interface InspectionOutcome {
  ok: boolean;
  substep: string;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  errorCode: string | null;
  timedOut: boolean;
  attempts: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** Redacted JSON suitable for a public tool error; never contains commandlines. */
  diagnostic: string;
}

const TRANSIENT_ERROR_CODES = new Set(["ETIMEDOUT", "ENOBUFS", "EAGAIN", "EMFILE", "ENFILE", "UV_ETIMEDOUT"]);

function stderrCategory(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "EMPTY";
  if (/permission denied|operation not permitted/i.test(text)) return "PERMISSION";
  if (/warning/i.test(text)) return "WARNING";
  if (/no such file/i.test(text)) return "NOT_FOUND";
  return "OTHER";
}

function redact(substep: string, attempts: number, r: SpawnResultLike | undefined, timedOut: boolean): string {
  const diagnostic = {
    schema: "DEVSPACE_PROCESS_INSPECTION_FAILURE_V1",
    substep,
    attempts,
    timedOut,
    errorCode: r?.error?.code ?? null,
    status: r?.status ?? null,
    signal: r?.signal ?? null,
    stderrCategory: stderrCategory(r?.stderr ?? ""),
    stdoutBytes: (r?.stdout ?? "").length,
    stderrBytes: (r?.stderr ?? "").length,
  };
  return JSON.stringify(diagnostic);
}

/**
 * Run one inspection command with a bounded retry for transient spawn failures.
 * Never throws; callers decide the domain error code and keep fail-closed gates.
 */
export function inspectCommand(
  substep: string,
  cmd: string,
  args: string[],
  opts: {
    spawn?: SpawnFn;
    timeoutMs?: number;
    maxBuffer?: number;
    attempts?: number;
    retryOnStderrWarnings?: boolean;
  } = {},
): InspectionOutcome {
  const spawn: SpawnFn =
    opts.spawn ??
    ((c, a, o) => {
      const r = spawnSync(c, a, { encoding: o.encoding, timeout: o.timeout, maxBuffer: o.maxBuffer });
      return {
        status: r.status,
        signal: r.signal ?? null,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        error: r.error ? { code: (r.error as NodeJS.ErrnoException).code, message: r.error.message } : null,
      };
    });
  const timeoutMs = opts.timeoutMs ?? INSPECTION_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? PS_COMM_MAX_BUFFER;
  const attempts = Math.max(1, opts.attempts ?? INSPECTION_ATTEMPTS);
  let last: SpawnResultLike | undefined;
  let timedOut = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = spawn(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer });
    last = r;
    const errorCode = r.error?.code ?? null;
    timedOut = errorCode === "ETIMEDOUT" || errorCode === "UV_ETIMEDOUT";
    // Sub-step success: clean exit 0, or (for lsof callers) a benign exit 1
    // handled by the caller. A non-empty stderr on exit 0/1 is not a failure by
    // itself unless the caller asks for warning retry.
    const transient = errorCode !== null && TRANSIENT_ERROR_CODES.has(errorCode);
    const retryableWarning = opts.retryOnStderrWarnings && (r.status === 0 || r.status === 1) && stderrCategory(r.stderr ?? "") === "WARNING";
    if (!transient && !retryableWarning) {
      return {
        ok: !r.error && r.status === 0,
        substep,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        status: r.status,
        signal: r.signal ?? null,
        errorCode,
        timedOut,
        attempts: attempt,
        stdoutBytes: (r.stdout ?? "").length,
        stderrBytes: (r.stderr ?? "").length,
        diagnostic: redact(substep, attempt, r, timedOut),
      };
    }
    // transient spawn error: retry once (bounded by attempts)
  }
  return {
    ok: false,
    substep,
    stdout: last?.stdout ?? "",
    stderr: last?.stderr ?? "",
    status: last?.status ?? null,
    signal: last?.signal ?? null,
    errorCode: last?.error?.code ?? null,
    timedOut,
    attempts,
    stdoutBytes: (last?.stdout ?? "").length,
    stderrBytes: (last?.stderr ?? "").length,
    diagnostic: redact(substep, attempts, last, timedOut),
  };
}

/** lsof exit 1 with an empty stderr means "no matching files", not a failure. */
export function isLsofNoMatch(outcome: InspectionOutcome): boolean {
  return outcome.status === 1 && stderrCategory(outcome.stderr) === "EMPTY" && !outcome.errorCode;
}
