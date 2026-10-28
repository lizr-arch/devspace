#!/usr/bin/env node
/**
 * P6 test-only single-command two-phase bootstrap CLI. Run with:
 *   node --import tsx scripts/p6-dsh-test-bootstrap.ts \
 *     --bridge-state-dir /Users/liz/.local/share/dsh-session-bridge \
 *     --workspace-root /Users/liz/agy/P6-WAKE-TEST/workspace \
 *     --workspace-id ws_aaa3fa66-98be-423b-8ba9-36541d8ee089 \
 *     --route-state-dir /Users/liz/agy/P6-WAKE-TEST/state/route-state \
 *     --port 47833 \
 *     --paired-extension-id <real test extension id> \
 *     --pairing-token-file /Users/liz/agy/P6-WAKE-TEST/state/pairing-token \
 *     --session-id session-d197708f-5ef9-4f4e-a884-2869f29da56d \
 *     --request-id p6-wake-real-20261028-001 \
 *     --route-wait-ms 900000 --request-wait-ms 900000 \
 *     --timeout-ms 600000 --receipt-timeout-ms 300000
 *
 * Every phase is one JSON line written synchronously (`fs.writeSync(1, ...)`) so
 * an operator can `tail -f` the log. Output always carries
 * `TEST_ONLY_BINDING_CLAIM=true`: this claim path is test-only; in production the
 * only allowed claimant is the authenticated Web GPT MCP tool
 * `coach_webgpt_claim_browser_route_exact`. The pairing token is read from a
 * private 0600 file and is never printed.
 *
 * Exit codes: 0 = Chrome dom_submitted; 2 = BLOCKED_TEST_BOOTSTRAP / TIMEOUT /
 * NEEDS_ATTENTION / acked-but-unverified; 1 = internal error.
 */
import { writeSync } from "node:fs";
import {
  P6TestBootstrapConfigError, startP6TestBootstrap, type P6TestBootstrapPhaseEvent,
} from "../src/coach-routes/p6-test-bootstrap.ts";

const ARG_RE = /^--[a-z][a-z0-9-]*$/;

function writeLine(value: Record<string, unknown>): void {
  writeSync(1, JSON.stringify(value) + "\n"); // synchronous: immediately visible to tail -f
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new P6TestBootstrapConfigError("MISSING_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  return value;
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new P6TestBootstrapConfigError("MISSING_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  return value;
}

function integer(name: string, fallback?: number): number {
  const value = arg(name);
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new P6TestBootstrapConfigError("INVALID_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new P6TestBootstrapConfigError("INVALID_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  return parsed;
}

function assertKnownArgs(): void {
  // Only flag tokens are validated; their values (paths, ids, integers) follow them.
  for (let index = 2; index < process.argv.length; index++) {
    const token = process.argv[index];
    if (!token.startsWith("--")) continue;
    if (!ARG_RE.test(token))
      throw new P6TestBootstrapConfigError("INVALID_ARGV", "arguments must be --kebab-case flags");
  }
}

async function main(): Promise<void> {
  assertKnownArgs();
  const handle = await startP6TestBootstrap({
    bridgeStateDir: required("bridge-state-dir"),
    workspaceRoot: required("workspace-root"),
    workspaceId: required("workspace-id"),
    routeStateDir: required("route-state-dir"),
    port: integer("port"),
    pairedExtensionId: required("paired-extension-id"),
    pairingTokenFile: required("pairing-token-file"),
    sessionId: required("session-id"),
    requestId: required("request-id"),
    routeWaitMs: integer("route-wait-ms", 900_000),
    requestWaitMs: integer("request-wait-ms", 900_000),
    timeoutMs: integer("timeout-ms", 600_000),
    receiptTimeoutMs: integer("receipt-timeout-ms", 300_000),
  }, {
    onPhase: (event: P6TestBootstrapPhaseEvent) => writeLine(event),
  });
  try {
    const outcome = await handle.result;
    writeLine({ phase: "DONE", testOnlyBindingClaim: true, ...outcome });
    process.exitCode = outcome.exitCode;
  } finally {
    await handle.stop();
  }
}

main().catch((error: unknown) => {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  if (error instanceof P6TestBootstrapConfigError) {
    writeLine({
      ok: false, phase: "BLOCKED_TEST_BOOTSTRAP", testOnlyBindingClaim: true,
      code: error.code, detail: message,
    });
    process.exitCode = 2; // invalid/missing arguments fail closed, never start a Sidecar
  } else {
    process.stderr.write(JSON.stringify({ ok: false, phase: "ERROR", detail: message }) + "\n");
    process.exitCode = 1; // internal error
  }
});
