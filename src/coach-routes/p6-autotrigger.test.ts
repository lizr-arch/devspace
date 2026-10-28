/** P6 targeted integration gate: a dedicated real Sidecar process/HTTP instance
 * + test-only loopback bridge, route already bound, completion arrives AFTER the
 * listener is armed. The test never calls ingress.ingest directly.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MultiRouteStore } from "../coach-multiroute.js";
import { startP6AutoTrigger } from "./p6-autotrigger.js";

const extensionId = "a".repeat(32);
const sessionId = "session-eeeeeeee-5555-4555-8555-555555555555";
const workspaceId = "ws-p6-autotrigger";
const routeUrl = "https://chatgpt.com/c/p6-autotrigger-chat";
const requestId = "p6-auto-request-001";
const routeId = "rt_" + "Z".repeat(43);

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

await check("automatic trigger: completion after listener arm enters the real Sidecar queue and /next", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-auto-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, ".devspace"), { recursive: true });
  const db = new Database(join(workspaceRoot, ".devspace", "coach_loop_spike.sqlite"));
  db.exec("create table events(event_id integer primary key, operation_id text, event_type text, created_at text, payload_json text);" +
    "create table review_decisions(event_id integer primary key);");
  db.close();
  const routeStateDir = join(root, "routes");
  const store = new MultiRouteStore({ stateDir: routeStateDir });
  const nonce = "9".repeat(32);
  const proposal = store.propose({ nonce, url: routeUrl, tabId: 888 });
  const route = store.claimExact({ routeId: proposal.routeId, nonce, url: routeUrl,
    workspaceId, dshSessionId: sessionId, authorizedWorkspaceIds: [workspaceId],
    authorizedDshSessionIds: [sessionId] });
  store.close();

  let completed = false;
  let requestReads = 0;
  const fakeBridge = createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (token !== "c".repeat(64)) { res.writeHead(401); res.end(); return; }
    if (req.url === "/v1/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [{ sessionId, allowed: true, running: true }] }));
      return;
    }
    if (req.url === "/v1/requests/" + requestId) {
      requestReads++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        requestId, sessionId, rpcId: "dsh-bridge:" + requestId,
        state: completed ? "completed" : "executing",
        accepted: true, claimed: completed, seenUser: completed,
        messages: completed ? [{ seq: 5, text: "P6 automatic completion body" }] : [],
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const stateDir = mkdtempSync(join(tmpdir(), "p6-bridge-state-"));
  try {
    await new Promise<void>((resolve) => fakeBridge.listen(0, "127.0.0.1", resolve));
    const bridgePort = (fakeBridge.address() as { port: number }).port;
    const realStateDir = realpathSync(stateDir);
    writeFileSync(join(realStateDir, "auth.json"), JSON.stringify({ token: "c".repeat(64) }), { mode: 0o600 });
    chmodSync(join(realStateDir, "auth.json"), 0o600);
    writeFileSync(join(realStateDir, "runtime.json"), JSON.stringify({ protocolVersion: 1, host: "127.0.0.1",
      port: bridgePort, pid: process.pid, instanceId: "p6-auto-test", startedAt: new Date().toISOString() }), { mode: 0o600 });
    chmodSync(join(realStateDir, "runtime.json"), 0o600);
    const sidecarPort = await freePort();
    const handle = await startP6AutoTrigger({
      bridgeStateDir: realStateDir, workspaceRoot, workspaceId, routeStateDir,
      port: sidecarPort, pairedExtensionId: extensionId, sessionId, routeId: route.routeId,
      requestId, consentRevision: route.consentRevision, timeoutMs: 5_000,
    });
    try {
      // The listener is already armed; complete the DSH request only afterwards.
      completed = true;
      const result = await handle.monitor;
      assert.equal(result.enqueued, true);
      assert.equal(result.state, "completed");
      // Existing Sidecar /next consumes the same queue; no test call to ingest.
      const response = await fetch(`http://127.0.0.1:${sidecarPort}/routes/${route.routeId}/next?origination=dsh&limit=1`, {
        headers: { Authorization: "Bearer " + handle.token, Origin: "chrome-extension://" + extensionId },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { messages: { kind: string; content: string; data: Record<string, unknown> }[] };
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].kind, "DSH_MESSAGE_NOTIFY");
      assert.ok(body.messages[0].content.includes(route.routeId));
      assert.equal(JSON.stringify(body).includes("P6 automatic completion body"), false);
      await handle.stop();
    } finally {
      await handle.stop().catch(() => {});
    }
  } finally {
    await new Promise<void>((resolve) => fakeBridge.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(routeStateDir, { recursive: true, force: true });
  }
});

await check("automatic trigger fails closed before start when the exact route/session binding is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-auto-neg-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, ".devspace"), { recursive: true });
  const db = new Database(join(workspaceRoot, ".devspace", "coach_loop_spike.sqlite"));
  db.exec("create table events(event_id integer primary key, operation_id text, event_type text, created_at text, payload_json text);" +
    "create table review_decisions(event_id integer primary key);");
  db.close();
  const routeStateDir = join(root, "routes");
  try {
    await assert.rejects(startP6AutoTrigger({
      bridgeStateDir: root, workspaceRoot, workspaceId, routeStateDir,
      port: await freePort(), pairedExtensionId: extensionId,
      sessionId: "session-ffffffff-6666-4666-8666-666666666666",
      routeId, requestId, consentRevision: 1, timeoutMs: 500,
    }), /BLOCKED_TEST_BINDING|DSH_BRIDGE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(routeStateDir, { recursive: true, force: true });
  }
});

console.log("P6_AUTOTRIGGER_TEST_DONE");
