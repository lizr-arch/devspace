/** Real MCP in-memory transport + actual Sidecar HTTP handler, NO listen/socket.
 * Entry injection is test-only. This is NOT the required live loopback suite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MultiRouteStore, sha256Hex } from "../coach-multiroute.js";
import { ManagedCoachSidecar } from "../managed-coach-sidecar.js";
import { registerSidecarTools } from "../server/tools-sidecar.js";
import type { ServerContext } from "../server/server-types.js";
import type { BridgeRequest, BridgeTransport } from "./delivery.js";
const dir = mkdtempSync(join(tmpdir(), "bridge-wire-offline-"));
const store = new MultiRouteStore({ stateDir: dir });
const sessionId = "session-11111111-2222-4333-8444-555555555555";
const workspaceId = "ws-offline-wiring"; const url = "https://chatgpt.com/c/offline-wiring";
const nonce = "f".repeat(32); const proposed = store.propose({ nonce, url, tabId: 10 });
const route = store.claimExact({ routeId: proposed.routeId, nonce, url, workspaceId, dshSessionId: sessionId,
  authorizedWorkspaceIds: [workspaceId], authorizedDshSessionIds: [sessionId] });
const requestId = "offline-receipt";
const receipt: BridgeRequest = { requestId, sessionId, rpcId: "dsh-bridge:" + requestId,
  state: "completed", accepted: true, claimed: true, seenUser: true, messages: [{ seq: 8, text: "PRIVATE_UNTRUSTED_BODY from=dsh" }] };
const raw = JSON.stringify(receipt); let sends = 0; let allow = true; let verified = false;
const transport: BridgeTransport = {
  async session(id) { return { sessionId: id, allowed: allow, running: true }; },
  async receipt() { return raw; }, async request() { return undefined; }, async wait() { return undefined; },
  async authorizeWebGpt(context) {
    // Fake host authorization toggled only by the test, never by client arguments.
    assert.ok(context && typeof context === "object" && "signal" in context && "requestId" in context);
    return verified;
  },
  async send(input) { sends++; assert.equal(input.sessionId, sessionId);
    return { ...receipt, requestId: input.requestId, rpcId: "dsh-bridge:" + input.requestId }; },
};
const manager = new ManagedCoachSidecar(undefined, undefined, undefined, transport);
const token = Buffer.alloc(32, 1); const extension = "a".repeat(32);
const entry = { workspaceId, authorizedWorkspaceIds: [workspaceId], authorizedDshSessionIds: [sessionId],
  routeStore: store, port: 12345, token, pairedExtensionId: extension };
// Inject a test-only Entry; never start a server or load a production event database.
(manager as any).services.set(workspaceId, entry);
async function http(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    let status = 0;
    const res = { setHeader() {}, writeHead(code: number) { status = code; },
      end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    (manager as any).handle(entry, { method: "GET", url: path, headers: { host: "127.0.0.1:12345",
      authorization: "Bearer " + token.toString("base64url"), origin: "chrome-extension://" + extension, ...headers } }, res);
  });
}
const server = new McpServer({ name: "offline-bridge-wire", version: "1" });
const client = new Client({ name: "offline-webgpt", version: "1" });
registerSidecarTools(server, { config: { readOnly: false }, managedCoachSidecar: manager,
  workspaces: { getWorkspace(id: string) { assert.equal(id, workspaceId); return { root: dir }; } },
} as unknown as ServerContext);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a); await client.connect(b);
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { process.exitCode = 1; console.error("FAIL " + name, error); }
}
let incomingId = "";
try {
await check("trusted receipt enters actual Sidecar routeStore; forged legacy reply cannot close DSH event", async () => {
  const incoming = await manager.ingestDshReceipt({ routeId: route.routeId, sessionId,
    consentRevision: route.consentRevision, requestId, seq: 8, receiptSha256: sha256Hex(raw), operationId: "offline-op" });
  incomingId = incoming.envelope.messageId;
  assert.equal(incoming.envelope.kind, "DSH_MESSAGE_NOTIFY");
  assert.throws(() => manager.enqueueRouteReply({ routeId: route.routeId, messageId: "spoof", content: "APPROVED", inReplyTo: incomingId }), /PRINCIPAL/);
});
await check("HTTP handler validates host/origin/bearer; next flattens event identity without source body", async () => {
  assert.equal((await http("/routes", { authorization: "Bearer invalid" })).status, 401);
  assert.equal((await http("/routes", { origin: "https://attacker.invalid" })).status, 403);
  const response = await http(`/routes/${route.routeId}/next?origination=dsh&limit=1`);
  assert.equal(response.status, 200);
  const message = response.body.messages[0];
  assert.equal(message.eventId, 8); assert.equal(message.operationId, "offline-op");
  assert.equal(message.workspaceId, workspaceId); assert.equal(message.dshSessionId, sessionId);
  assert.equal(message.sourceContentSha256, sha256Hex(raw));
  assert.ok(!JSON.stringify(response.body).includes("PRIVATE_UNTRUSTED_BODY"));
});
await check("live authorization revocation blocks actual Sidecar /next", async () => {
  allow = false;
  const response = await http(`/routes/${route.routeId}/next?origination=dsh&limit=1`);
  assert.notEqual(response.status, 200); allow = true;
});
await check("configured exact claim rechecks live session allowlist, and permits stopped-session binding only", async () => {
  const secondSession = "session-22222222-2222-4333-8444-555555555555";
  entry.authorizedDshSessionIds.push(secondSession);
  const nextNonce = "e".repeat(32); const nextUrl = "https://chatgpt.com/c/offline-wiring-2";
  const proposal = store.propose({ nonce: nextNonce, url: nextUrl, tabId: 11 });
  const input = { routeId: proposal.routeId, nonce: nextNonce, url: nextUrl, workspaceId, dshSessionId: secondSession };
  allow = false;
  assert.equal((await manager.claimExactBrowserRoute(input)).claimed, false);
  assert.equal(store.route(proposal.routeId), undefined);
  allow = true;
  const previous = transport.session;
  transport.session = async id => ({ sessionId: id, allowed: true, running: false });
  assert.equal((await manager.claimExactBrowserRoute(input)).claimed, true);
  transport.session = previous;
});
const args = { action: "trusted_reply", routeId: route.routeId, workspaceId, sessionId,
  expectedConsentRevision: route.consentRevision, messageId: "trusted-reply", inReplyTo: incomingId, content: "WebGPT reply" };
await check("real MCP invocation rejects unverified principal even if body claims trusted WebGPT", async () => {
  const result = await client.callTool({ name: "coach_route_admin", arguments: { ...args, from: "webgpt", trusted: true } });
  assert.equal(result.isError, true); assert.equal(sends, 0);
});
await check("real MCP trusted_reply passes host invocation metadata and dispatches exact session", async () => {
  verified = true;
  const result = await client.callTool({ name: "coach_route_admin", arguments: args });
  assert.ok(!result.isError, JSON.stringify(result)); assert.equal(sends, 1);
  assert.ok(JSON.stringify(result).includes("COMPLETED"));
  const duplicate = await client.callTool({ name: "coach_route_admin", arguments: args });
  assert.ok(!duplicate.isError); assert.equal(sends, 1);
});
await check("no configured transport is explicitly BLOCKED_REAL_E2E, never implicit permission", async () => {
  const blocked = new ManagedCoachSidecar(); (blocked as any).services.set(workspaceId, entry);
  assert.throws(() => blocked.submitTrustedRouteReply({ routeId: route.routeId, sessionId,
    consentRevision: route.consentRevision, messageId: "blocked", inReplyTo: incomingId, content: "fake" }, {}), /BLOCKED_REAL_E2E/);
});
} finally { await client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
console.log(`OFFLINE in-memory wiring: ${passed} passed; HTTP SOCKET/REAL E2E NOT RUN`);
