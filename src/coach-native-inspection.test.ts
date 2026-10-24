/**
 * Tests for the redacted process-inspection helper (G1 hardening after the
 * production PROCESS_INSPECTION_FAILED incident).
 *
 * Fully injected: no real ps/lsof is executed by these tests.
 */
import assert from "node:assert/strict";
import {
  INSPECTION_ATTEMPTS,
  INSPECTION_TIMEOUT_MS,
  inspectCommand,
  isLsofNoMatch,
  type SpawnFn,
} from "./coach-native-inspection.js";

let pass = 0;
let lastArgs: string[] | null = null;

function scripted(results: Array<{ status: number | null; stdout?: string; stderr?: string; errorCode?: string; signal?: string | null }>): SpawnFn {
  let index = 0;
  return (_cmd, args) => {
    lastArgs = args;
    const r = results[Math.min(index++, results.length - 1)];
    return {
      status: r.status,
      signal: r.signal ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: r.errorCode ? { code: r.errorCode, message: "injected" } : null,
    } satisfies import("./coach-native-inspection.js").SpawnResultLike;
  };
}

// 1. clean success, no retry.
{
  const out = inspectCommand("ps_comm", "/bin/ps", ["-axo", "pid=,comm="], {
    spawn: scripted([{ status: 0, stdout: "1 init\n" }]),
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 0);
  assert.equal(out.attempts, 1);
  assert.equal(out.stdout, "1 init\n");
  pass++;
}

// 2. transient timeout then success: retried once, outcome ok.
{
  const out = inspectCommand("ps_command", "/bin/ps", ["-axo", "pid=,ppid=,uid=,command=", "-ww"], {
    spawn: scripted([
      { status: null, errorCode: "ETIMEDOUT" },
      { status: 0, stdout: "1 0 501 init\n" },
    ]),
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(out.timedOut, false, "final attempt succeeded so timedOut reflects last attempt");
  pass++;
}

// 3. persistent ENOBUFS: bounded attempts, redacted diagnostic, no command line.
{
  const out = inspectCommand("ps_command", "/bin/ps", ["-axo", "pid=,ppid=,uid=,command=", "-ww", "SECRET_TOKEN_MARKER"], {
    spawn: scripted([{ status: null, errorCode: "ENOBUFS" }]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, INSPECTION_ATTEMPTS);
  assert.equal(out.errorCode, "ENOBUFS");
  const diag = JSON.parse(out.diagnostic) as Record<string, unknown>;
  assert.equal(diag.substep, "ps_command");
  assert.equal(diag.attempts, INSPECTION_ATTEMPTS);
  assert.equal(diag.errorCode, "ENOBUFS");
  assert.equal(diag.timedOut, false);
  assert.equal(diag.stderrCategory, "EMPTY");
  assert.equal(JSON.stringify(diag).includes("SECRET_TOKEN_MARKER"), false);
  assert.equal(JSON.stringify(diag).includes("/bin/ps"), false);
  assert.equal(out.diagnostic.includes("SECRET_TOKEN_MARKER"), false);
  pass++;
}

// 4. unresolved timeout reports timedOut=true in the redacted diagnostic.
{
  const out = inspectCommand("lsof_lock", "/usr/sbin/lsof", ["-nP", "-F", "p", "/tmp/x.lock"], {
    spawn: scripted([{ status: null, errorCode: "ETIMEDOUT" }]),
  });
  assert.equal(out.ok, false);
  const diag = JSON.parse(out.diagnostic) as Record<string, unknown>;
  assert.equal(diag.timedOut, true);
  assert.equal(diag.substep, "lsof_lock");
  pass++;
}

// 5. nonzero exit is a real failure: one attempt only, no retry.
{
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return { status: 2, signal: null, stdout: "", stderr: "lsof: fatal error", error: null };
  };
  const out = inspectCommand("lsof_text", "/usr/sbin/lsof", ["-a", "-p", "42", "-d", "txt", "-Fn"], { spawn });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 1);
  assert.equal(calls, 1);
  const diag = JSON.parse(out.diagnostic) as Record<string, unknown>;
  assert.equal(diag.status, 2);
  assert.equal(diag.stderrCategory, "OTHER");
  pass++;
}

// 6. lsof status 1 + empty stderr = no-match (not a failure); warning stderr is not no-match.
{
  const noMatch = inspectCommand("lsof_lock", "/usr/sbin/lsof", ["-nP", "-F", "p", "/tmp/x.lock"], {
    spawn: scripted([{ status: 1, stdout: "", stderr: "" }]),
  });
  assert.equal(noMatch.status, 1);
  assert.equal(isLsofNoMatch(noMatch), true);

  const warning = inspectCommand("lsof_lock", "/usr/sbin/lsof", ["-nP", "-F", "p", "/tmp/x.lock"], {
    spawn: scripted([{ status: 1, stdout: "", stderr: "lsof: WARNING: can't stat()" }]),
  });
  assert.equal(isLsofNoMatch(warning), false);
  assert.equal((JSON.parse(warning.diagnostic) as Record<string, unknown>).stderrCategory, "WARNING");
  pass++;
}

// 7. opt-in warning retry: warning stderr on exit 0 retried once then accepted.
{
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return calls === 1
      ? { status: 0, signal: null, stdout: "", stderr: "lsof: WARNING: transient", error: null }
      : { status: 0, signal: null, stdout: "n/usr/bin/x\n", stderr: "", error: null };
  };
  const out = inspectCommand("lsof_text", "/usr/sbin/lsof", ["-a"], { spawn, retryOnStderrWarnings: true });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(out.stdout, "n/usr/bin/x\n");
  pass++;
}

// 8. defaults are conservative (>=10s timeout, >=2 attempts).
assert.ok(INSPECTION_TIMEOUT_MS >= 10_000);
assert.ok(INSPECTION_ATTEMPTS >= 2);
pass++;

process.stdout.write("NATIVE_INSPECTION_TEST_PASS " + pass + "\n");
