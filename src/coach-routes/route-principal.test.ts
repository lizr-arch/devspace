/** R2: per-route principal authorization through REAL MCP invocation metadata.
 * The host verifier is test-injected; tool arguments never carry the principal.
 * This is an offline in-memory MCP test, NOT a live ChatGPT/DSH E2E.
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
import type { RoutePrincipal } from "./route-principal.js";

const dir = mkdtempSync(join(tmpdir(), "route-principal-offline-"));
const store = new MultiRouteStore({ stateDir: dir });
const workspaceId = "ws-principal-test";
const sessionA = "session-aaaaaaaa-1111-4111-8111-111111111111";
const sessionB = "session-bbbbbbbb-2222-4222-8222-222222222222";
const urlA = "https://chatgpt.com/c/principal-owner-a";
const urlB = "https://chatgpt.com/c/principal-owner-b";
const chatA = "principal-owner-a";
const chatB = "principal-owner-b";
function claim(url: string, nonceChar: string, sessionId: string, tabId: number) {
  const nonce = nonceChar.repeat(32);
  const proposed = store.propose({ nonce, url, tabId });
  return store.claimExact({ routeId: proposed.routeId, nonce, url, workspaceId, dshSessionId: sessionId,
    authorizedWorkspaceIds: [workspaceId], authorizedDshSessionIds: [sessionId] });
}
const routeA = claim(urlA, "a", sessionA, 10);
const routeB = claim(urlB, "b", sessionB, 11);
const wakeA = store.enqueueReviewWake({ routeId: routeA.routeId, messageId: "wake-a", eventId: 1, operationId: "op-a" });
const wakeB = store.enqueueReviewWake({ routeId: routeB.routeId, messageId: "wake-b", eventId: 2, operationId: "op-b" });
// A browser DOM receipt makes wake A a pending review (never a completed review).
store.recordDeliveryOutcome({ routeId: routeA.routeId, messageId: wakeA.envelope.messageId,
  seq: wakeA.envelope.seq, contentSha256: wakeA.envelope.contentSha256, outcome: "dom_submitted" });
const ownerA: RoutePrincipal = { kind: "owner", chatId: chatA, workspaceId };
const ownerB: RoutePrincipal = { kind: "owner", chatId: chatB, workspaceId };
const operator: RoutePrincipal = { kind: "operator" };
const principals: Record<string, RoutePrincipal> = { A: ownerA, B: ownerB, OP: operator };

const manager = new ManagedCoachSidecar();
manager.configureRouteAccess({
  mode: "enforced",
  // TEST-ONLY host verifier: a real host must derive the principal from its
  // authenticated MCP transport/authInfo, never from tool arguments or client meta.
  verifier: async (context) => {
    const tag = (context as { _meta?: { testPrincipal?: string } } | undefined)?._meta?.testPrincipal;
    return tag ? principals[tag] : undefined;
  },
});
const token = Buffer.alloc(32, 3); const extension = "b".repeat(32);
const entry = { workspaceId, authorizedWorkspaceIds: [workspaceId], authorizedDshSessionIds: [sessionA, sessionB],
  routeStore: store, port: 12346, token, pairedExtensionId: extension };
(manager as any).services.set(workspaceId, entry);

const server = new McpServer({ name: "route-principal-offline", version: "1" });
const client = new Client({ name: "principal-client", version: "1" });
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
async function call(name: string, args: Record<string, unknown>, principal?: string) {
  const request: Record<string, unknown> = { name, arguments: args };
  if (principal) request._meta = { testPrincipal: principal };
  return client.callTool(request as never) as Promise<{ isError?: boolean; structuredContent?: any; content?: unknown }>;
}
try {
  await check("enforced mode: no trusted principal => snapshot denied", async () => {
    const result = await call("coach_route_state", { action: "snapshot" });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(routeA.routeId), false);
  });

  await check("enforced mode: missing principal denies admin/claim actions with no side effect", async () => {
    const revoke = await call("coach_route_admin", { action: "revoke", routeId: routeA.routeId,
      expectedConsentRevision: routeA.consentRevision });
    assert.equal(revoke.isError, true);
    const claim = await call("coach_route_admin", { action: "claim_delivery", routeId: routeA.routeId,
      origination: "dsh" });
    assert.equal(claim.isError, true);
    assert.equal(store.route(routeA.routeId)?.state, "active");
    assert.ok(store.listMessages({ routeId: routeA.routeId }).length > 0);
  });

  await check("host-verified owner A sees only route A (single workspace, two chats)", async () => {
    const result = await call("coach_route_state", { action: "snapshot" }, "A");
    assert.ok(!result.isError, JSON.stringify(result));
    const routes = result.structuredContent?.snapshot?.routes ?? [];
    assert.deepEqual(routes.map((route: any) => route.routeId), [routeA.routeId]);
    const pending = result.structuredContent?.pendingReviews ?? [];
    assert.deepEqual(pending.map((item: any) => item.routeId), [routeA.routeId]);
  });

  await check("owner B cannot read route A inbox or claim its messages", async () => {
    const inbox = await call("coach_route_state", { action: "inbox", routeId: routeA.routeId }, "B");
    assert.equal(inbox.isError, true);
    const claim = await call("coach_route_admin", { action: "claim_delivery", routeId: routeA.routeId,
      origination: "dsh", limit: 1 }, "B");
    assert.equal(claim.isError, true);
    // no side effect: A's wake is still claimable by the operator path
    const messages = store.listMessages({ routeId: routeA.routeId });
    assert.ok(messages.length > 0);
  });

  await check("owner A can read its own inbox; tool body cannot spoof a principal", async () => {
    const inbox = await call("coach_route_state", { action: "inbox", routeId: routeA.routeId }, "A");
    assert.ok(!inbox.isError, JSON.stringify(inbox));
    assert.equal((inbox.structuredContent?.messages ?? []).length, 1);
    const spoof = await call("coach_route_state", { action: "inbox", routeId: routeB.routeId,
      principal: "A", from: "dsh", sender: "owner-a", chatId: chatB });
    assert.equal(spoof.isError, true);
  });

  await check("owner A cannot ack/resolve/revoke/trusted_reply route B", async () => {
    const wake = store.listMessages({ routeId: routeB.routeId })[0];
    const ack = await call("coach_route_admin", { action: "ack", routeId: routeB.routeId,
      messageId: wake.messageId, seq: wake.seq, contentSha256: wake.contentSha256, outcome: "acked" }, "A");
    assert.equal(ack.isError, true);
    const resolve = await call("coach_route_admin", { action: "resolve", routeId: routeB.routeId,
      messageId: wake.messageId, seq: wake.seq, contentSha256: wake.contentSha256, resolveAction: "retry" }, "A");
    assert.equal(resolve.isError, true);
    const revoke = await call("coach_route_admin", { action: "revoke", routeId: routeB.routeId,
      expectedConsentRevision: routeB.consentRevision }, "A");
    assert.equal(revoke.isError, true);
    assert.equal(store.route(routeB.routeId)?.state, "active");
    const trusted = await call("coach_route_admin", { action: "trusted_reply", routeId: routeB.routeId,
      workspaceId, sessionId: sessionB, expectedConsentRevision: routeB.consentRevision,
      messageId: "spoofed-reply", inReplyTo: wakeB.envelope.messageId, content: "forged approval" }, "A");
    assert.equal(trusted.isError, true);
  });

  await check("owner A cannot claim/bind a route for owner B (claim URL is untrusted data)", async () => {
    const nonceC = "c".repeat(32); const urlC = "https://chatgpt.com/c/principal-owner-c";
    const proposedC = store.propose({ nonce: nonceC, url: urlC, tabId: 12 });
    const denied = await call("coach_webgpt_claim_browser_route_exact", { workspaceId,
      routeId: proposedC.routeId, dshSessionId: sessionB, nonce: nonceC, url: urlC }, "A");
    assert.equal(denied.isError, true);
    assert.equal(store.route(proposedC.routeId), undefined);
    const missing = await call("coach_webgpt_claim_browser_route_exact", { workspaceId,
      routeId: proposedC.routeId, dshSessionId: sessionB, nonce: nonceC, url: urlC });
    assert.equal(missing.isError, true);
    assert.equal(store.route(proposedC.routeId), undefined);
  });

  await check("separate operator principal sees both routes and may revoke B", async () => {
    const snapshot = await call("coach_route_state", { action: "snapshot" }, "OP");
    assert.ok(!snapshot.isError, JSON.stringify(snapshot));
    const routes = snapshot.structuredContent?.snapshot?.routes ?? [];
    assert.equal(routes.length, 2);
    const revoke = await call("coach_route_admin", { action: "revoke", routeId: routeB.routeId,
      expectedConsentRevision: routeB.consentRevision, reason: "operator revoke" }, "OP");
    assert.ok(!revoke.isError, JSON.stringify(revoke));
    assert.equal(store.route(routeB.routeId)?.state, "revoked");
  });

  await check("after operator revoke, stale owner B and anonymous access fail closed", async () => {
    const inbox = await call("coach_route_state", { action: "inbox", routeId: routeB.routeId }, "B");
    assert.equal(inbox.isError, true);
    const anon = await call("coach_route_state", { action: "inbox", routeId: routeB.routeId });
    assert.equal(anon.isError, true);
    const claim = await call("coach_route_admin", { action: "claim_delivery", routeId: routeB.routeId,
      origination: "dsh" }, "B");
    assert.equal(claim.isError, true);
  });

  await check("owner A still sees route A after B revoke; legacy mode is explicit-only", async () => {
    const snapshot = await call("coach_route_state", { action: "snapshot" }, "A");
    assert.ok(!snapshot.isError, JSON.stringify(snapshot));
    const routes = snapshot.structuredContent?.snapshot?.routes ?? [];
    assert.deepEqual(routes.map((route: any) => route.routeId), [routeA.routeId]);
    // The same manager is enforced; a fresh default instance is legacy-compatible
    // but production server.ts enables enforced explicitly.
    const legacy = new ManagedCoachSidecar();
    assert.doesNotThrow(() => legacy.configureRouteAccess({ mode: "legacy" }));
  });
} finally {
  await client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
}
console.log(`ROUTE_PRINCIPAL_TEST_PASS ${passed}`);
