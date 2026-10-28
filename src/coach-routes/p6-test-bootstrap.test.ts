/** P6 targeted integration gate: a REAL dedicated Sidecar HTTP instance + a
 * test-only loopback bridge + a REAL `POST /route/propose` call that simulates
 * the user's test-extension click. The two-phase bootstrap must:
 *  - observe the proposal it did not create,
 *  - claim it only through the live bridge-session allow gate,
 *  - arm its listener before the fake DSH request reaches `completed`,
 *  - ingest the completion through the existing durable queue,
 *  - hold the same Sidecar open until a delayed Chrome `dom_submitted` ACK.
 * Negative checks: no proposal -> BLOCKED_TEST_BOOTSTRAP; session not allowed ->
 * claim rejected, no route persisted, never armed. The test NEVER calls
 * `ingress.ingest` directly and never fabricates a route or nonce.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startP6TestBootstrap, type P6TestBootstrapPhase, type P6TestBootstrapPhaseEvent } from "./p6-test-bootstrap.js";

const extensionId = "a".repeat(32);
const sessionId = "session-eeeeeeee-5555-4555-8555-555555555555";
const workspaceId = "ws-p6-bootstrap";
const routeUrl = "https://chatgpt.com/c/p6-bootstrap-chat";
const requestId = "p6-bootstrap-request-001";
const bridgeToken = "c".repeat(64);
const pairingToken = "d".repeat(43);
const nonce = "9".repeat(32);
const completionBody = "P6 bootstrap completion body";

async function freePort(): Promise<number> {
  const server = createServer((_req, res) => res.end("busy"));
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { process.exitCode = 1; console.error("FAIL " + name, error); }
}

function makeWorkspace(realRoot: string): string {
  const workspaceRoot = join(realRoot, "workspace");
  mkdirSync(join(workspaceRoot, ".devspace"), { recursive: true });
  const db = new Database(join(workspaceRoot, ".devspace", "coach_loop_spike.sqlite"));
  db.exec("create table events(event_id integer primary key, operation_id text, event_type text, created_at text, payload_json text);" +
    "create table review_decisions(event_id integer primary key);");
  db.close();
  return workspaceRoot;
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface FakeBridge {
  server: ReturnType<typeof createServer>;
  port: number;
  sessionReads: number;
  sessionAllowed: boolean;
  requestVisible: boolean;
  completed: boolean;
}

async function startFakeBridge(realRoot: string): Promise<{ bridge: FakeBridge; stateDir: string }> {
  const stateDir = join(realRoot, "bridge-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const bridge: FakeBridge = {
    server: createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (token !== bridgeToken) { res.writeHead(401); res.end(); return; }
      if (req.url === "/v1/sessions") {
        bridge.sessionReads++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions: [{ sessionId, allowed: bridge.sessionAllowed, running: true }] }));
        return;
      }
      if (req.url === "/v1/requests/" + requestId) {
        if (!bridge.requestVisible) { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          requestId, sessionId, rpcId: "dsh-bridge:" + requestId,
          state: bridge.completed ? "completed" : "executing",
          accepted: true, claimed: bridge.completed, seenUser: bridge.completed,
          messages: bridge.completed ? [{ seq: 5, text: completionBody }] : [],
        }));
        return;
      }
      res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
    }),
    port: 0, sessionReads: 0, sessionAllowed: true, requestVisible: false, completed: false,
  };
  await new Promise<void>((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  bridge.port = (bridge.server.address() as { port: number }).port;
  writePrivateFile(join(stateDir, "auth.json"), JSON.stringify({ token: bridgeToken }));
  writePrivateFile(join(stateDir, "runtime.json"), JSON.stringify({
    protocolVersion: 1, host: "127.0.0.1", port: bridge.port, pid: process.pid,
    instanceId: "p6-bootstrap-test", startedAt: new Date().toISOString(),
  }));
  return { bridge, stateDir };
}

async function waitForPhase(events: P6TestBootstrapPhaseEvent[], phase: string, timeoutMs = 15_000): Promise<P6TestBootstrapPhaseEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find((event) => event.phase === phase);
    if (found) return found;
    if (Date.now() >= deadline)
      throw new Error(`PHASE_TIMEOUT ${phase}; observed: ${events.map((event) => event.phase).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function routeProposalRequest(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/route/propose`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Origin: "chrome-extension://" + extensionId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nonce, tabId: 888, url: routeUrl }),
  });
}

function browserHeaders(token: string, json = false): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    Origin: "chrome-extension://" + extensionId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function persistedRoutes(routeStateDir: string): { routes: unknown[] } {
  return JSON.parse(readFileSync(join(routeStateDir, "routes.json"), "utf8")) as { routes: unknown[] };
}

await check("two-phase bootstrap: real /route/propose click -> live-allow claim -> arm before completion -> durable queue -> delayed dom_submitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-bootstrap-"));
  const realRoot = realpathSync(root);
  const workspaceRoot = makeWorkspace(realRoot);
  const routeStateDir = join(realRoot, "routes");
  const pairingTokenFile = join(realRoot, "pairing-token");
  writePrivateFile(pairingTokenFile, pairingToken + "\n");
  const { bridge, stateDir } = await startFakeBridge(realRoot);
  const sidecarPort = await freePort();
  const events: P6TestBootstrapPhaseEvent[] = [];
  let handle: Awaited<ReturnType<typeof startP6TestBootstrap>> | undefined;
  try {
    handle = await startP6TestBootstrap({
      bridgeStateDir: stateDir, workspaceRoot, workspaceId, routeStateDir,
      port: sidecarPort, pairedExtensionId: extensionId, pairingTokenFile,
      sessionId, requestId, routeWaitMs: 10_000, requestWaitMs: 10_000,
      timeoutMs: 10_000, receiptTimeoutMs: 10_000, pollIntervalMs: 25,
    }, { onPhase: (event) => events.push(event) });

    // Simulate exactly what the user's test-extension click does: POST /route/propose.
    const propose = await routeProposalRequest(sidecarPort, handle.token);
    assert.equal(propose.status, 200);
    const proposal = await propose.json() as { ok: boolean; routeId: string; nonce: string; url: string };
    assert.equal(proposal.ok, true);
    assert.equal(proposal.routeId.startsWith("rt_"), true);

    // The bootstrap may only OBSERVE this proposal; it must never fabricate one.
    const detected = await waitForPhase(events, "PROPOSAL_DETECTED");
    assert.equal(detected.routeId, proposal.routeId);
    assert.equal(detected.canonicalChatUrl, routeUrl);

    await waitForPhase(events, "ROUTE_ACTIVE");
    assert.equal(events.some((event) => event.phase === "LISTENING"), false);
    // The DSH request does not exist yet: no listener may be armed before it appears.
    assert.equal(bridge.requestVisible, false);
    bridge.requestVisible = true;
    const listening = await waitForPhase(events, "LISTENING");
    assert.equal(listening.requestStateAtArm, "executing"); // armed BEFORE completion
    assert.equal(bridge.completed, false);
    bridge.completed = true;

    const monitorDone = await waitForPhase(events, "MONITOR_DONE");
    assert.equal(monitorDone.enqueued, true);
    assert.equal(monitorDone.state, "completed");
    assert.equal(typeof monitorDone.messageId, "string");

    // The fixed wake instruction (rebuilt from identity) is available to Chrome.
    const next = await fetch(`http://127.0.0.1:${sidecarPort}/routes/${proposal.routeId}/next?origination=dsh&limit=1`, {
      headers: browserHeaders(handle.token),
    });
    assert.equal(next.status, 200);
    const nextBody = await next.json() as { messages: { messageId: string; seq: number; contentSha256: string; kind: string; content: string; data: Record<string, unknown> }[] };
    assert.equal(nextBody.messages.length, 1);
    assert.equal(nextBody.messages[0].kind, "DSH_MESSAGE_NOTIFY");
    assert.equal(nextBody.messages[0].content.includes(proposal.routeId), true);
    assert.equal(JSON.stringify(nextBody).includes(completionBody), false);
    const message = nextBody.messages[0];

    // Chrome autoMultiPump ACKs asynchronously; the Sidecar must stay alive.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const ack = await fetch(`http://127.0.0.1:${sidecarPort}/routes/${proposal.routeId}/ack`, {
      method: "POST", headers: browserHeaders(handle.token, true),
      body: JSON.stringify({ messageId: message.messageId, seq: message.seq,
        contentSha256: message.contentSha256, outcome: "dom_submitted" }),
    });
    assert.equal(ack.status, 200);

    await waitForPhase(events, "BROWSER_RECEIPT");
    const outcome = await handle.result;
    assert.equal(outcome.testOnlyBindingClaim, true);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.state, "BROWSER_DOM_SUBMITTED_UNVERIFIED");
    assert.equal(outcome.monitor?.enqueued, true);
    assert.equal(outcome.messageId, message.messageId);
    assert.equal(outcome.requestStateAtArm, "executing");
    assert.equal(outcome.receipt?.state, "BROWSER_DOM_SUBMITTED_UNVERIFIED");

    // Phase order + test-only marker on every line.
    const expected: P6TestBootstrapPhase[] = ["READY_FOR_BINDING", "PROPOSAL_DETECTED", "ROUTE_CLAIMED_TEST_ONLY", "ROUTE_ACTIVE",
      "REQUEST_PRESENT", "LISTENING", "MONITOR_DONE", "BROWSER_RECEIPT"];
    const observed = events.map((event) => event.phase);
    const indexes = expected.map((phase) => observed.indexOf(phase));
    assert.equal(indexes.every((index) => index >= 0), true, "all phases observed: " + observed.join(","));
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes);
    assert.equal(events.every((event) => event.testOnlyBindingClaim === true), true);
    assert.equal(String(events.find((event) => event.phase === "ROUTE_CLAIMED_TEST_ONLY")?.note).includes("TEST_ONLY_BINDING_CLAIM=true"), true);
    // Single-use proposal: it is claimed in the durable route store, not left pending.
    assert.equal(persistedRoutes(routeStateDir).routes.length, 1);
  } finally {
    await handle?.stop();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(routeStateDir, { recursive: true, force: true });
  }
});

await check("bootstrap fails closed with BLOCKED_TEST_BOOTSTRAP when the user never creates a proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-bootstrap-neg-"));
  const realRoot = realpathSync(root);
  const workspaceRoot = makeWorkspace(realRoot);
  const routeStateDir = join(realRoot, "routes");
  const pairingTokenFile = join(realRoot, "pairing-token");
  writePrivateFile(pairingTokenFile, pairingToken + "\n");
  const events: P6TestBootstrapPhaseEvent[] = [];
  let handle: Awaited<ReturnType<typeof startP6TestBootstrap>> | undefined;
  try {
    handle = await startP6TestBootstrap({
      bridgeStateDir: join(realRoot, "unused-bridge-state"), workspaceRoot, workspaceId, routeStateDir,
      port: await freePort(), pairedExtensionId: extensionId, pairingTokenFile,
      sessionId, requestId, routeWaitMs: 300, requestWaitMs: 500,
      timeoutMs: 500, receiptTimeoutMs: 500, pollIntervalMs: 25,
    }, { onPhase: (event) => events.push(event) });
    const outcome = await handle.result;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.state, "BLOCKED_TEST_BOOTSTRAP");
    assert.equal(outcome.code, "PROPOSAL_WAIT_TIMEOUT");
    assert.equal(observedPhase(events, "ROUTE_CLAIMED_TEST_ONLY"), false);
    assert.equal(observedPhase(events, "LISTENING"), false);
    assert.equal(observedPhase(events, "BLOCKED_TEST_BOOTSTRAP"), true);
    assert.equal(persistedRoutes(routeStateDir).routes.length, 0);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(routeStateDir, { recursive: true, force: true });
  }
});

await check("bootstrap claim fails closed when the live bridge session is not allowed: no route, never armed", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-bootstrap-neg2-"));
  const realRoot = realpathSync(root);
  const workspaceRoot = makeWorkspace(realRoot);
  const routeStateDir = join(realRoot, "routes");
  const pairingTokenFile = join(realRoot, "pairing-token");
  writePrivateFile(pairingTokenFile, pairingToken + "\n");
  const { bridge, stateDir } = await startFakeBridge(realRoot);
  bridge.sessionAllowed = false; // live allow check must fail closed
  const events: P6TestBootstrapPhaseEvent[] = [];
  let handle: Awaited<ReturnType<typeof startP6TestBootstrap>> | undefined;
  try {
    handle = await startP6TestBootstrap({
      bridgeStateDir: stateDir, workspaceRoot, workspaceId, routeStateDir,
      port: await freePort(), pairedExtensionId: extensionId, pairingTokenFile,
      sessionId, requestId, routeWaitMs: 10_000, requestWaitMs: 500,
      timeoutMs: 500, receiptTimeoutMs: 500, pollIntervalMs: 25,
    }, { onPhase: (event) => events.push(event) });
    const propose = await routeProposalRequest(handle.port, handle.token);
    assert.equal(propose.status, 200);
    await waitForPhase(events, "PROPOSAL_DETECTED");
    const outcome = await handle.result;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.state, "BLOCKED_TEST_BOOTSTRAP");
    assert.equal(outcome.code, "CLAIM_REJECTED");
    assert.equal(outcome.detail, "ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    assert.equal(bridge.sessionReads >= 1, true); // the live allow gate was really consulted
    assert.equal(observedPhase(events, "ROUTE_CLAIMED_TEST_ONLY"), false);
    assert.equal(observedPhase(events, "REQUEST_PRESENT"), false);
    assert.equal(observedPhase(events, "LISTENING"), false);
    assert.equal(persistedRoutes(routeStateDir).routes.length, 0);
  } finally {
    await handle?.stop();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(routeStateDir, { recursive: true, force: true });
  }
});

function observedPhase(events: P6TestBootstrapPhaseEvent[], phase: string): boolean {
  return events.some((event) => event.phase === phase);
}

console.log("P6_TEST_BOOTSTRAP_TEST_DONE");
