/**
 * P6 runnable, test-only automatic trigger.
 *
 * Starts a DEDICATED ManagedCoachSidecar in the same process as the DSH bridge
 * ingress, using the existing Sidecar route store/queue and existing Chrome
 * /routes/:id/next endpoint. It never touches the production Sidecar, port,
 * bridge process, existing DSH sessions or Chrome profiles.
 *
 * The listener is armed before the DSH request completes; no user command is
 * needed after completion. The process exits only when the bridge request is
 * terminal or the bounded timeout expires.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { ManagedCoachSidecar } from "../managed-coach-sidecar.js";
import { DshBridgeHttpTransport, DshBridgeIngress, type DshBridgeIngressResult } from "./dsh-bridge-ingress.js";

export interface P6AutoTriggerOptions {
  bridgeStateDir: string;
  workspaceRoot: string;
  workspaceId: string;
  /** Optional native coach DB; otherwise workspaceRoot/.devspace/coach_loop_spike.sqlite. */
  eventDatabasePath?: string;
  routeStateDir: string;
  port: number;
  pairedExtensionId: string;
  sessionId: string;
  routeId: string;
  requestId: string;
  consentRevision: number;
  timeoutMs?: number;
  receiptTimeoutMs?: number;
  /** Wait this long for the test extension/WebGPT binding to create the route. */
  routeWaitMs?: number;
  /** Private file containing a base64url 32-byte pairing token; never argv. */
  pairingTokenFile?: string;
}

export interface BrowserReceiptResult {
  state: "BROWSER_DOM_SUBMITTED_UNVERIFIED" | "BROWSER_ACKED_UNVERIFIED" | "NEEDS_ATTENTION" | "TIMEOUT";
  messageId: string;
  detail?: string;
}

export interface P6AutoTriggerHandle {
  manager: ManagedCoachSidecar;
  token: string;
  port: number;
  monitor: Promise<DshBridgeIngressResult>;
  /** Keep the same Sidecar alive until Chrome ACKs the exact message or timeout. */
  waitForBrowserReceipt: (messageId: string, timeoutMs?: number) => Promise<BrowserReceiptResult>;
  stop: () => Promise<void>;
}

/**
 * Poll one exact durable-queue messageId until Chrome records a delivery outcome.
 * Shared (exported) by the P6 two-phase test bootstrap so both entry points use
 * the identical receipt semantics: only `dom_submitted` is a successful browser
 * receipt; `manual_sent`/`acked` are explicitly unverified; `needs_attention`
 * and timeout fail closed. This never writes a receipt itself.
 */
export function createBrowserReceiptWaiter(
  manager: Pick<ManagedCoachSidecar, "listRouteMessages">,
  routeId: string,
  defaultTimeoutMs = 120_000,
): (messageId: string, timeoutMs?: number) => Promise<BrowserReceiptResult> {
  return async (messageId, timeoutMs = defaultTimeoutMs) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      let state: string | undefined;
      try {
        const message = (manager.listRouteMessages?.({ routeId, limit: 50 }) ?? [])
          .find((item) => item.messageId === messageId);
        state = message?.state;
      } catch { state = undefined; }
      if (state === "dom_submitted") return { state: "BROWSER_DOM_SUBMITTED_UNVERIFIED", messageId };
      if (state === "manual_sent" || state === "acked") return { state: "BROWSER_ACKED_UNVERIFIED", messageId, detail: state };
      if (state === "needs_attention") return { state: "NEEDS_ATTENTION", messageId, detail: "operator review required; no retry" };
      if (Date.now() >= deadline) return { state: "TIMEOUT", messageId };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
}

/** Strict private pairing-token file read (0600 regular file, own uid, no symlink). */
export function readPrivatePairingToken(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile() || (process.getuid && st.uid !== process.getuid()) ||
      (process.platform !== "win32" && (st.mode & 0o077) !== 0) || realpathSync(path) !== path)
    throw new Error("P6_PAIRING_TOKEN_FILE_UNSAFE");
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("P6_PAIRING_TOKEN_FILE_INVALID");
  return token;
}

/**
 * Fail closed before start if the exact route/session/revision is not already
 * present and active. The route must be created by the normal browser/WebGPT
 * binding flow; this harness never fabricates a route or URL.
 */
export async function startP6AutoTrigger(options: P6AutoTriggerOptions): Promise<P6AutoTriggerHandle> {
  if (!options || typeof options.bridgeStateDir !== "string" || !options.bridgeStateDir.startsWith("/"))
    throw new Error("P6_BRIDGE_STATE_DIR_REQUIRED");
  if (!options.routeStateDir || !options.workspaceRoot)
    throw new Error("P6_DEDICATED_STATE_REQUIRED");
  if (!/^rt_[A-Za-z0-9_-]{43}$/.test(options.routeId) ||
      !/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.sessionId) ||
      !Number.isSafeInteger(options.consentRevision) || options.consentRevision < 1)
    throw new Error("BLOCKED_TEST_BINDING");
  if (!/^[a-p]{32}$/.test(options.pairedExtensionId)) throw new Error("BLOCKED_EXTENSION_BINDING");
  const transport = new DshBridgeHttpTransport({ stateDir: options.bridgeStateDir });
  const manager = new ManagedCoachSidecar(undefined, options.eventDatabasePath, undefined, transport);
  let started = false;
  try {
    const startedInfo = await manager.start({
      workspaceId: options.workspaceId,
      workspaceRoot: options.workspaceRoot,
      port: options.port,
      pairedExtensionId: options.pairedExtensionId,
      authorizedDshSessionIds: [options.sessionId],
      authorizedWorkspaceIds: [options.workspaceId],
      routeStateDir: options.routeStateDir,
      ...(options.pairingTokenFile ? { pairingToken: readPrivatePairingToken(options.pairingTokenFile) } : {}),
    });
    started = true;
    // Two-phase bootstrap: start this dedicated Sidecar first, let the test
    // extension/WebGPT create the exact route, then arm the bridge monitor.
    const routeDeadline = Date.now() + Math.max(0, options.routeWaitMs ?? 0);
    let route;
    for (;;) {
      route = manager.routeSnapshot!().routes.find((item) => item.routeId === options.routeId);
      if (route) break;
      if (Date.now() >= routeDeadline) throw new Error("BLOCKED_TEST_BINDING");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (route.state !== "active" || route.dshSessionId !== options.sessionId ||
        route.workspaceId !== options.workspaceId || route.consentRevision !== options.consentRevision)
      throw new Error("BLOCKED_TEST_BINDING");
    const ingress = new DshBridgeIngress({
      delivery: { ingest: (input) => manager.ingestDshReceipt(input) },
      transport,
      routeId: options.routeId,
      sessionId: options.sessionId,
      consentRevision: options.consentRevision,
    });
    // Arm the observer immediately; completion can happen at any later time.
    const monitor = ingress.waitAndIngest(options.requestId, options.timeoutMs ?? 120_000);
    const waitForBrowserReceipt = createBrowserReceiptWaiter(manager, options.routeId, options.receiptTimeoutMs ?? 120_000);
    return { manager, token: startedInfo.token, port: options.port,
      monitor, waitForBrowserReceipt, stop: () => manager.stop(options.workspaceId) };
  } catch (error) {
    if (started) await manager.stop(options.workspaceId).catch(() => {});
    throw error;
  }
}
