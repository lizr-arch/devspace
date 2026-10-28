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
  pairingToken?: string;
}

export interface P6AutoTriggerHandle {
  manager: ManagedCoachSidecar;
  token: string;
  port: number;
  monitor: Promise<DshBridgeIngressResult>;
  stop: () => Promise<void>;
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
      ...(options.pairingToken ? { pairingToken: options.pairingToken } : {}),
    });
    started = true;
    const snapshot = manager.routeSnapshot!();
    const route = snapshot.routes.find((item) => item.routeId === options.routeId);
    if (!route || route.state !== "active" || route.dshSessionId !== options.sessionId ||
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
    return { manager, token: startedInfo.token, port: options.port,
      monitor, stop: () => manager.stop(options.workspaceId) };
  } catch (error) {
    if (started) await manager.stop(options.workspaceId).catch(() => {});
    throw error;
  }
}
