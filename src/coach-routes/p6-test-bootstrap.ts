/**
 * P6 test-only TWO-PHASE bootstrap: dedicated Sidecar + real browser proposal ->
 * test-only claim -> exact route activation -> bridge request monitoring ->
 * existing durable ingest -> delayed Chrome DOM receipt.
 *
 * Hard boundaries (see docs/P6_DSH_WEBGPT_WAKE_REVIEW.md):
 *  - Never touches the production Sidecar/port/bridge/Chrome, the production
 *    extension, any old DSH session or the shared mailbox. The caller must pass
 *    a dedicated test workspace, route state dir, port and session.
 *  - The route proposal is only OBSERVED from proposals the *user's* test
 *    extension created through `POST /route/propose` (via the in-process
 *    `pendingRouteProposals()` view). This file never calls `store.propose` and
 *    never fabricates a route/chat URL/nonce.
 *  - TEST_ONLY_BINDING_CLAIM=true: in production the only path allowed to claim
 *    a browser proposal is the authenticated Web GPT MCP tool
 *    `coach_webgpt_claim_browser_route_exact`. This bootstrap exists solely to
 *    exercise the real wake path on a dedicated test setup; the claim still goes
 *    through the same `manager.claimExactBrowserRoute()` gate, including the
 *    Sidecar's live bridge-session `allowed` re-check (fail closed).
 *  - The pairing token is read from a strict private 0600 file; it is never an
 *    argv value, never printed and never written to any output.
 *  - `BROWSER_DOM_SUBMITTED_UNVERIFIED` is a DOM receipt, NOT a model reply.
 *    `REAL_GPT_REPLIED` / `REAL_WAKE_VERIFIED` are never claimed here.
 */
import { ManagedCoachSidecar } from "../managed-coach-sidecar.js";
import type { BridgeRequest } from "./delivery.js";
import { DshBridgeHttpTransport, DshBridgeIngress, type DshBridgeIngressResult } from "./dsh-bridge-ingress.js";
import {
  createBrowserReceiptWaiter, readPrivatePairingToken, type BrowserReceiptResult,
} from "./p6-autotrigger.js";
import { DSH_SESSION_RE, WORKSPACE_ID_RE, type RouteProposal, type RouteRecord } from "./protocol.js";

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const BRIDGE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,96}$/;

export const TEST_ONLY_BINDING_CLAIM = true as const;

export interface P6TestBootstrapOptions {
  /** Private loopback bridge state dir (auth.json + runtime.json). */
  bridgeStateDir: string;
  workspaceRoot: string;
  workspaceId: string;
  /** Durable per-route queue root owned by this dedicated test Sidecar. */
  routeStateDir: string;
  /** Dedicated test Sidecar port (must be free/unused by production). */
  port: number;
  /** Test extension id the dedicated Sidecar is paired with. */
  pairedExtensionId: string;
  /** Strict private 0600 file with a base64url 32-byte pairing token; never argv. */
  pairingTokenFile: string;
  sessionId: string;
  requestId: string;
  /** Wait for the user's test-extension click to create a proposal. */
  routeWaitMs?: number;
  /** Wait for the bridge request to appear before arming the listener. */
  requestWaitMs?: number;
  /** Ingress monitoring timeout AFTER the listener is armed. */
  timeoutMs?: number;
  /** Wait for Chrome's delayed dom_submitted receipt (same Sidecar stays alive). */
  receiptTimeoutMs?: number;
  /** Test-only polling cadence override (default 200ms). */
  pollIntervalMs?: number;
}

export type P6TestBootstrapPhase =
  | "READY_FOR_BINDING"
  | "PROPOSAL_DETECTED"
  | "ROUTE_CLAIMED_TEST_ONLY"
  | "ROUTE_ACTIVE"
  | "REQUEST_PRESENT"
  | "LISTENING"
  | "MONITOR_DONE"
  | "BROWSER_RECEIPT"
  | "BLOCKED_TEST_BOOTSTRAP";

export type P6TestBootstrapPhaseEvent = {
  ok: boolean;
  phase: P6TestBootstrapPhase;
  /** Hard marker: this claim path is test-only; production claim is Web GPT MCP. */
  testOnlyBindingClaim: typeof TEST_ONLY_BINDING_CLAIM;
  at: string;
} & Record<string, unknown>;

export interface P6TestBootstrapHooks {
  /** Called once per phase line, synchronously, for CLI JSON lines and tests. */
  onPhase?: (event: P6TestBootstrapPhaseEvent) => void;
}

export interface P6TestBootstrapOutcome {
  testOnlyBindingClaim: typeof TEST_ONLY_BINDING_CLAIM;
  ok: boolean;
  /** CLI mapping: 0 = dom_submitted; 2 = BLOCKED/TIMEOUT/NEEDS_ATTENTION/acked. */
  exitCode: 0 | 2;
  state: "BROWSER_DOM_SUBMITTED_UNVERIFIED" | "BROWSER_ACKED_UNVERIFIED" |
    "NEEDS_ATTENTION" | "TIMEOUT" | "BLOCKED_TEST_BOOTSTRAP";
  code?: string;
  detail?: string;
  routeId?: string;
  consentRevision?: number;
  /** Bridge request state captured immediately before `waitAndIngest` was armed. */
  requestStateAtArm?: string;
  messageId?: string;
  monitor?: DshBridgeIngressResult;
  receipt?: BrowserReceiptResult;
}

export interface P6TestBootstrapHandle {
  manager: ManagedCoachSidecar;
  /** Sidecar bearer for the *test* extension; never logged by this module. */
  token: string;
  port: number;
  testOnlyBindingClaim: typeof TEST_ONLY_BINDING_CLAIM;
  /** Resolves with the ingress result once armed (or a fail-closed state). */
  monitor: Promise<DshBridgeIngressResult>;
  /** Full pipeline outcome (resolves for phase failures, rejects for internal errors). */
  result: Promise<P6TestBootstrapOutcome>;
  waitForBrowserReceipt: (messageId: string, timeoutMs?: number) => Promise<BrowserReceiptResult>;
  stop: () => Promise<void>;
}

export class P6TestBootstrapConfigError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "P6TestBootstrapConfigError";
  }
}

function configError(code: string): never {
  throw new P6TestBootstrapConfigError(code);
}

function absolutePath(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || value.includes("\u0000"))
    configError(code);
  return value;
}

function positiveMs(value: unknown, code: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86_400_000) configError(code);
  return value as number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 200);
}

function blockedOutcome(code: string, detail?: string): P6TestBootstrapOutcome {
  return {
    testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM, ok: false, exitCode: 2,
    state: "BLOCKED_TEST_BOOTSTRAP", code, ...(detail ? { detail } : {}),
  };
}

/**
 * Start the dedicated test Sidecar, emit READY_FOR_BINDING, then drive the eight
 * phases in the background. `finally` stops the Sidecar after the pipeline ends.
 *
 * Phase failures (no proposal, claim denied, request never appears, bridge
 * stopped/rejected/uncertain, browser receipt timeout/needs_attention) resolve
 * `handle.result` with exitCode 2. Programming/internal errors reject `result`
 * and the CLI maps them to exit code 1. Only `dom_submitted` yields exitCode 0.
 */
export async function startP6TestBootstrap(
  options: P6TestBootstrapOptions,
  hooks?: P6TestBootstrapHooks,
): Promise<P6TestBootstrapHandle> {
  if (!options || typeof options !== "object") configError("P6_TEST_BOOTSTRAP_OPTIONS_REQUIRED");
  const bridgeStateDir = absolutePath(options.bridgeStateDir, "P6_BRIDGE_STATE_DIR_REQUIRED");
  const workspaceRoot = absolutePath(options.workspaceRoot, "P6_WORKSPACE_ROOT_REQUIRED");
  const routeStateDir = absolutePath(options.routeStateDir, "P6_ROUTE_STATE_DIR_REQUIRED");
  const pairingTokenFile = absolutePath(options.pairingTokenFile, "P6_PAIRING_TOKEN_FILE_REQUIRED");
  if (typeof options.workspaceId !== "string" || !WORKSPACE_ID_RE.test(options.workspaceId))
    configError("P6_WORKSPACE_ID_INVALID");
  if (typeof options.sessionId !== "string" || !DSH_SESSION_RE.test(options.sessionId))
    configError("P6_SESSION_ID_INVALID");
  if (typeof options.requestId !== "string" || !BRIDGE_REQUEST_ID_RE.test(options.requestId))
    configError("P6_REQUEST_ID_INVALID");
  if (typeof options.pairedExtensionId !== "string" || !EXTENSION_ID_RE.test(options.pairedExtensionId))
    configError("P6_PAIRED_EXTENSION_ID_INVALID");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    configError("P6_PORT_INVALID");
  const routeWaitMs = positiveMs(options.routeWaitMs, "P6_ROUTE_WAIT_MS_INVALID", 900_000);
  const requestWaitMs = positiveMs(options.requestWaitMs, "P6_REQUEST_WAIT_MS_INVALID", 900_000);
  const timeoutMs = positiveMs(options.timeoutMs, "P6_TIMEOUT_MS_INVALID", 600_000);
  const receiptTimeoutMs = positiveMs(options.receiptTimeoutMs, "P6_RECEIPT_TIMEOUT_MS_INVALID", 300_000);
  const pollIntervalMs = positiveMs(options.pollIntervalMs, "P6_POLL_INTERVAL_MS_INVALID", 200);
  const pairingToken = readPrivatePairingToken(pairingTokenFile); // fail closed before start; never logged
  const transport = new DshBridgeHttpTransport({ stateDir: bridgeStateDir });
  const manager = new ManagedCoachSidecar(undefined, undefined, undefined, transport);
  const workspaceId = options.workspaceId;
  const sessionId = options.sessionId;
  const requestId = options.requestId;

  let started = false;
  try {
    const startedInfo = await manager.start({
      workspaceId,
      workspaceRoot,
      port: options.port,
      pairedExtensionId: options.pairedExtensionId,
      authorizedDshSessionIds: [sessionId],
      authorizedWorkspaceIds: [workspaceId],
      routeStateDir,
      pairingToken,
    });
    started = true;

    const emit = (phase: P6TestBootstrapPhase, ok: boolean, detail: Record<string, unknown> = {}) => {
      hooks?.onPhase?.({
        ok, phase, testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM,
        at: new Date().toISOString(), ...detail,
      });
    };
    emit("READY_FOR_BINDING", true, {
      port: options.port, pairedExtensionId: options.pairedExtensionId,
      workspaceId, sessionId, requestId, routeStateDir, workspaceRoot,
      note: "Dedicated test Sidecar is listening. Waiting for the user's test-extension click (POST /route/propose).",
    });

    let claimedRouteId: string | undefined;
    let claimedConsentRevision: number | undefined;

    // Deferred monitor: resolved by the LISTENING phase, or fail-closed before arm.
    let resolveMonitor!: (result: DshBridgeIngressResult | PromiseLike<DshBridgeIngressResult>) => void;
    let rejectMonitor!: (error: unknown) => void;
    const monitor = new Promise<DshBridgeIngressResult>((resolve, reject) => {
      resolveMonitor = resolve;
      rejectMonitor = reject;
    });
    void monitor.catch(() => { /* Callers may await `result` only; never leak an unhandled rejection. */ });

    const waitForBrowserReceipt = async (messageId: string, waitMs?: number): Promise<BrowserReceiptResult> => {
      if (!claimedRouteId) {
        return { state: "TIMEOUT", messageId, detail: "NO_ROUTE_CLAIMED_YET" };
      }
      return createBrowserReceiptWaiter(manager, claimedRouteId, receiptTimeoutMs)(messageId, waitMs);
    };

    const run = async (): Promise<P6TestBootstrapOutcome> => {
      // ---- phase 2: PROPOSAL_DETECTED (user click only; never fabricated) ----
      const proposalDeadline = Date.now() + routeWaitMs;
      let proposal: RouteProposal | undefined;
      for (;;) {
        const pending = manager.pendingRouteProposals();
        if (pending.length > 0) { proposal = pending[0]; break; }
        if (Date.now() >= proposalDeadline) {
          const outcome = blockedOutcome("PROPOSAL_WAIT_TIMEOUT",
            `no unclaimed /route/propose proposal within ${routeWaitMs}ms (test extension click required)`);
          emit("BLOCKED_TEST_BOOTSTRAP", false, { code: outcome.code, detail: outcome.detail });
          return outcome;
        }
        await delay(pollIntervalMs);
      }
      emit("PROPOSAL_DETECTED", true, {
        routeId: proposal.routeId, canonicalChatUrl: proposal.canonicalChatUrl,
        exactTabId: proposal.exactTabId,
        createdAt: new Date(proposal.createdAt).toISOString(),
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        note: "Observed an unclaimed proposal created by POST /route/propose; it is never fabricated by this harness.",
      });

      // ---- phase 3: ROUTE_CLAIMED_TEST_ONLY ----
      const claim = await manager.claimExactBrowserRoute({
        workspaceId, dshSessionId: sessionId, routeId: proposal.routeId,
        nonce: proposal.nonce, url: proposal.canonicalChatUrl,
      });
      if (!claim.claimed || !claim.route) {
        const code = claim.code ?? "ROUTE_CLAIM_REJECTED";
        const outcome = blockedOutcome("CLAIM_REJECTED", code);
        emit("BLOCKED_TEST_BOOTSTRAP", false, { code: outcome.code, detail: code });
        return outcome;
      }
      claimedRouteId = claim.route.routeId;
      claimedConsentRevision = claim.route.consentRevision;
      emit("ROUTE_CLAIMED_TEST_ONLY", true, {
        routeId: claim.route.routeId, consentRevision: claim.route.consentRevision,
        canonicalChatUrl: claim.route.canonicalChatUrl, exactTabId: claim.route.exactTabId,
        workspaceId, dshSessionId: sessionId,
        note: "TEST_ONLY_BINDING_CLAIM=true; production claim is Web GPT MCP coach_webgpt_claim_browser_route_exact only.",
      });

      // ---- phase 4: ROUTE_ACTIVE (exact session/workspace/revision) ----
      const activeDeadline = Date.now() + Math.max(2_000, pollIntervalMs * 20);
      let activeRoute: RouteRecord | undefined;
      for (;;) {
        activeRoute = manager.routeSnapshot().routes.find((route) => route.routeId === claim.route!.routeId);
        if (activeRoute) break;
        if (Date.now() >= activeDeadline) {
          const outcome = blockedOutcome("ROUTE_ACTIVE_MISSING", "claimed route is absent from the Sidecar snapshot");
          emit("BLOCKED_TEST_BOOTSTRAP", false, { code: outcome.code, detail: outcome.detail });
          return outcome;
        }
        await delay(pollIntervalMs);
      }
      if (activeRoute.state !== "active" || activeRoute.dshSessionId !== sessionId ||
          activeRoute.workspaceId !== workspaceId || activeRoute.consentRevision !== claim.route.consentRevision) {
        const outcome = blockedOutcome("ROUTE_BINDING_MISMATCH",
          `state=${activeRoute.state} session=${activeRoute.dshSessionId === sessionId} ` +
          `workspace=${activeRoute.workspaceId === workspaceId} revision=${activeRoute.consentRevision === claim.route.consentRevision}`);
        emit("BLOCKED_TEST_BOOTSTRAP", false, { code: outcome.code, detail: outcome.detail });
        return outcome;
      }
      emit("ROUTE_ACTIVE", true, {
        routeId: activeRoute.routeId, consentRevision: activeRoute.consentRevision,
        workspaceId: activeRoute.workspaceId, dshSessionId: activeRoute.dshSessionId,
        exactTabId: activeRoute.exactTabId,
      });

      // ---- phase 5: REQUEST_PRESENT (never arm before the request exists) ----
      const requestDeadline = Date.now() + requestWaitMs;
      let requestRecord: BridgeRequest | undefined;
      for (;;) {
        try { requestRecord = await transport.request(requestId); } catch { requestRecord = undefined; }
        if (requestRecord) break;
        if (Date.now() >= requestDeadline) {
          const outcome: P6TestBootstrapOutcome = {
            testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM, ok: false, exitCode: 2,
            state: "TIMEOUT", code: "REQUEST_PRESENT_TIMEOUT",
            detail: `bridge request ${requestId} did not appear within ${requestWaitMs}ms`,
            ...(claimedRouteId ? { routeId: claimedRouteId } : {}),
          };
          emit("BLOCKED_TEST_BOOTSTRAP", false, { code: outcome.code, detail: outcome.detail });
          return outcome;
        }
        await delay(pollIntervalMs);
      }
      emit("REQUEST_PRESENT", true, {
        requestId, state: requestRecord.state,
        sessionId: requestRecord.sessionId, rpcId: requestRecord.rpcId,
        note: "No listener has been armed yet; the request must already exist.",
      });

      // ---- phase 6: LISTENING (arm, then record the request state at arm time) ----
      let requestStateAtArm = requestRecord.state;
      try {
        const atArm = await transport.request(requestId);
        if (atArm) requestStateAtArm = atArm.state;
      } catch { /* Keep the last observed state; ingest below is authoritative. */ }
      const ingress = new DshBridgeIngress({
        delivery: { ingest: (input) => manager.ingestDshReceipt(input) },
        transport, routeId: claim.route.routeId, sessionId, consentRevision: claim.route.consentRevision,
      });
      const monitorResult = ingress.waitAndIngest(requestId, timeoutMs);
      resolveMonitor(monitorResult);
      emit("LISTENING", true, {
        routeId: claim.route.routeId, requestId, requestStateAtArm, timeoutMs,
        note: "Listener armed BEFORE completion; request.state captured at arm time is the 'listen first, finish later' evidence.",
      });

      // ---- phase 7: MONITOR_DONE (existing durable ingest; fail closed otherwise) ----
      let ingested: DshBridgeIngressResult;
      try {
        ingested = await monitorResult;
      } catch (error) {
        const outcome: P6TestBootstrapOutcome = {
          testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM, ok: false, exitCode: 2,
          state: "NEEDS_ATTENTION", code: "MONITOR_INGEST_VERIFY_FAILED", detail: errorDetail(error),
          routeId: claim.route.routeId, consentRevision: claim.route.consentRevision, requestStateAtArm,
        };
        emit("MONITOR_DONE", false, { state: "verify_failed", enqueued: false, detail: outcome.detail });
        return outcome;
      }
      if (!ingested.enqueued) {
        const isTimeout = ingested.state === "timeout" || ingested.state === "not_found";
        const outcome: P6TestBootstrapOutcome = {
          testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM, ok: false, exitCode: 2,
          state: isTimeout ? "TIMEOUT" : "NEEDS_ATTENTION",
          code: "MONITOR_" + ingested.state.toUpperCase(),
          detail: `bridge request ended as ${ingested.state}; never re-sent, never ingested`,
          routeId: claim.route.routeId, consentRevision: claim.route.consentRevision,
          requestStateAtArm, monitor: ingested,
        };
        emit("MONITOR_DONE", false, { state: ingested.state, enqueued: false, detail: outcome.detail });
        return outcome;
      }
      const messageId = ingested.envelope?.messageId;
      if (!messageId) throw new Error("P6_BOOTSTRAP_ENVELOPE_MISSING");
      emit("MONITOR_DONE", true, {
        state: ingested.state, enqueued: ingested.enqueued, duplicate: ingested.duplicate === true,
        messageId, routeId: claim.route.routeId, consentRevision: claim.route.consentRevision,
        requestStateAtArm,
        note: "Completion was ingested through the existing RouteBridgeDelivery sink into the same durable queue.",
      });

      // ---- phase 8: BROWSER_RECEIPT (same Sidecar stays alive) ----
      const receipt = await waitForBrowserReceipt(messageId, receiptTimeoutMs);
      const receiptOk = receipt.state === "BROWSER_DOM_SUBMITTED_UNVERIFIED";
      emit("BROWSER_RECEIPT", receiptOk, {
        receipt, messageId, routeId: claim.route.routeId,
        note: receiptOk
          ? "DOM submit receipt only; this is NOT a model reply (no REAL_GPT_REPLIED claim)."
          : "Browser receipt did not reach dom_submitted; fail closed.",
      });
      const base = {
        testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM,
        routeId: claim.route.routeId, consentRevision: claim.route.consentRevision,
        requestStateAtArm, messageId, monitor: ingested, receipt,
      } as const;
      if (receiptOk) {
        return { ...base, ok: true, exitCode: 0, state: "BROWSER_DOM_SUBMITTED_UNVERIFIED" };
      }
      if (receipt.state === "BROWSER_ACKED_UNVERIFIED")
        return { ...base, ok: false, exitCode: 2, state: "BROWSER_ACKED_UNVERIFIED", code: "BROWSER_ACKED_UNVERIFIED", ...(receipt.detail ? { detail: receipt.detail } : {}) };
      return {
        ...base, ok: false, exitCode: 2,
        state: receipt.state === "NEEDS_ATTENTION" ? "NEEDS_ATTENTION" : "TIMEOUT",
        code: "BROWSER_" + receipt.state,
        ...(receipt.detail ? { detail: receipt.detail } : {}),
      };
    };

    const result: Promise<P6TestBootstrapOutcome> = (async () => {
      try {
        const outcome = await run();
        if (!outcome.ok) {
          // Fail-closed before/without arming: settle the monitor so callers that
          // await it never hang; a real armed monitor has already settled.
          resolveMonitor({ state: outcome.state === "BLOCKED_TEST_BOOTSTRAP" ? "blocked" : outcome.state.toLowerCase(), enqueued: false });
        }
        return outcome;
      } catch (error) {
        try { rejectMonitor(error); } catch { /* monitor already settled or handled */ }
        throw error;
      } finally {
        // Always stop THIS dedicated test Sidecar; never the production one.
        try { await manager.stop(workspaceId); } catch { /* Best-effort shutdown. */ }
      }
    })();
    void result.catch(() => { /* The caller owns `result`; avoid unhandled rejection if it only awaits stop(). */ });

    return {
      manager, token: startedInfo.token, port: options.port,
      testOnlyBindingClaim: TEST_ONLY_BINDING_CLAIM,
      monitor, result,
      waitForBrowserReceipt,
      stop: async () => { try { await manager.stop(workspaceId); } catch { /* Best-effort. */ } },
    };
  } catch (error) {
    if (started) await manager.stop(workspaceId).catch(() => {});
    throw error;
  }
}
