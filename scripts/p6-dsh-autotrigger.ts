#!/usr/bin/env node
/**
 * P6 runnable test-only entry. Starts a DEDICATED Sidecar + bridge watcher in
 * one process. Run with: node --import tsx scripts/p6-dsh-autotrigger.ts ...
 *
 * It never touches the production Sidecar/port/bridge/Chrome and never fabricates
 * a route. The exact route must already exist in --route-state-dir and be bound
 * to the test Chrome extension; otherwise it exits BLOCKED_TEST_BINDING.
 */
import { startP6AutoTrigger } from "../src/coach-routes/p6-autotrigger.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  return index > 0 ? process.argv[index + 1] : undefined;
}
function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error("MISSING_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  return value;
}
function integer(name: string, fallback?: number): number {
  const value = arg(name);
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error("INVALID_ARG_" + name.toUpperCase().replace(/-/g, "_"));
  return Number(value);
}

async function main(): Promise<void> {
  const handle = await startP6AutoTrigger({
    bridgeStateDir: required("bridge-state-dir"),
    workspaceRoot: required("workspace-root"),
    workspaceId: required("workspace-id"),
    routeStateDir: required("route-state-dir"),
    eventDatabasePath: arg("event-db"),
    port: integer("port"),
    pairedExtensionId: required("paired-extension-id"),
    sessionId: required("session-id"),
    routeId: required("route-id"),
    requestId: required("request-id"),
    consentRevision: integer("consent-revision"),
    timeoutMs: integer("timeout-ms", 120_000),
    ...(arg("pairing-token") ? { pairingToken: arg("pairing-token") } : {}),
  });
  console.log(JSON.stringify({ ok: true, phase: "LISTENING", routeId: arg("route-id"),
    port: handle.port, note: "Completion can arrive now; no further command is required." }));
  try {
    const result = await handle.monitor;
    console.log(JSON.stringify({ ok: result.enqueued, phase: "MONITOR_DONE", result }));
    if (!result.enqueued) process.exitCode = 2;
  } finally {
    await handle.stop();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message.slice(0, 300) }));
  process.exitCode = 1;
});
