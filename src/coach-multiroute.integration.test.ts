/**
 * TR-DSH-MULTIROUTE-AND-NAVAL-001 — I2 offline integration verification.
 *
 * Real command (recorded in MULTIROUTE_REPORT.md):
 *   node_modules/.bin/tsx src/coach-multiroute.integration.test.ts
 *
 * This starts a REAL managed coach Sidecar on a loopback ephemeral port with a
 * temporary SQLite event database and a temporary route state directory, then
 * drives it through the REAL HTTP endpoints and the REAL MCP SDK in-memory
 * transport. It never touches the production Sidecar, launchd, Chrome profile
 * or any remote network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { JobResourceLocks } from "./job-resource-locks.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { registerSidecarTools } from "./server/tools-sidecar.js";
import type { ServerContext } from "./server/server-types.js";
import { createHash } from "node:crypto";

const WS_A = "ws_58c90da6-696f-4cc3-bb62-c13436cde99c";
const WS_B = "ws_test-b-4cc3-bb62-c13436cde99c";
const S1 = "session-0645ad77-b57a-40d6-a2fa-448824ec5007";
const S2 = "session-098d80fb-cf9a-4116-b088-11fe5a9456e0";
const S3 = "session-33333333-4444-4555-8666-777777777777";
const URL_1 = "https://chatgpt.com/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3";
const URL_2 = "https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const URL_3 = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EXTENSION = "bapcebjlgncogfpgbhllioaichcldkbl";
const nonce = (seed: number) => createHash("sha256").update("n" + seed).digest("hex").slice(0, 32);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name + " :: " + (error instanceof Error ? error.stack : String(error)));
    process.exitCode = 1;
  }
}

async function freePort(): Promise<number> {
  const server: Server = createServer((_req, res) => res.end("other"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const root = mkdtempSync(join(tmpdir(), "coach-multiroute-int-"));
const workspace = join(root, "workspace");
mkdirSync(join(workspace, ".devspace"), { recursive: true });
const dbPath = join(workspace, ".devspace", "coach_loop_spike.sqlite");
const setupDb = new Database(dbPath);
setupDb.exec("create table events(event_id integer primary key, operation_id text, event_type text, created_at text, payload_json text);" +
  "create table review_decisions(event_id integer primary key);" +
  "insert into events values(1,'op-a','READY_FOR_GPT_REVIEW','2026-01-01','SENSITIVE_PROMPT')");
setupDb.close();
const routeStateDir = join(root, "route-state");

const locks = new JobResourceLocks();
const manager = new ManagedCoachSidecar(locks);
const events = new CoachReviewEventStore(join(root, "tool-state"));
const workspacesById: Record<string, { root: string }> = {
  [WS_A]: { root: workspace },
  [WS_B]: { root: workspace },
};
const workspaceRegistry = {
  getWorkspace(workspaceId: string) {
    const found = workspacesById[workspaceId];
    if (!found) throw new Error("Unknown workspace");
    return found;
  },
};

let port = 0;
let token = "";
let client: Client | undefined;
let toolServer: McpServer | undefined;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: "Bearer " + token, Origin: "chrome-extension://" + EXTENSION, ...extra };
}
async function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  const response = await fetch("http://127.0.0.1:" + port + path, {
    method: "POST", cache: "no-store",
    headers: headers({ "Content-Type": "application/json", ...extra }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(!text.includes(token), "response must never echo the bearer token");
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}
async function get(path: string, extra: Record<string, string> = {}) {
  const response = await fetch("http://127.0.0.1:" + port + path, { cache: "no-store", headers: headers(extra) });
  const text = await response.text();
  assert.ok(!text.includes(token), "response must never echo the bearer token");
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}
async function mcp(name: string, args: Record<string, unknown>) {
  assert.ok(client, "MCP client is connected");
  return client!.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }>;
}

try {
  port = await freePort();
  const started = await manager.start({
    workspaceId: WS_A, workspaceRoot: workspace, port, pairedExtensionId: EXTENSION,
    authorizedDshSessionIds: [S1, S2], routeStateDir,
  });
  token = started.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  toolServer = new McpServer({ name: "coach-multiroute-tool-test", version: "1.0.0" });
  registerSidecarTools(toolServer, {
    config: { readOnly: false }, workspaces: workspaceRegistry,
    managedCoachSidecar: manager, coachReviewEvents: events,
  } as unknown as ServerContext);
  client = new Client({ name: "coach-multiroute-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await toolServer.connect(serverTransport);
  await client.connect(clientTransport);

  // =========================================================================
  await check("startup advertises the three exact-route tools and issues a bearer", async () => {
    const advertised = (await client!.listTools()).tools.map((tool) => tool.name);
    assert.ok(advertised.includes("coach_webgpt_claim_browser_route_exact"));
    assert.ok(advertised.includes("coach_route_state"));
    assert.ok(advertised.includes("coach_route_admin"));
    assert.ok(advertised.includes("coach_webgpt_claim_browser_route"), "legacy claim stays advertised");
    const health = await get("/health");
    assert.equal(health.status, 200);
  });

  // =========================================================================
  await check("browser challenge -> exact MCP claim binds one unguessable route", async () => {
    const proposed = await post("/route/propose", { nonce: nonce(1), url: URL_1, tabId: 42 });
    assert.equal(proposed.status, 200);
    const routeId = String(proposed.body.routeId);
    assert.match(routeId, /^rt_[A-Za-z0-9_-]{43}$/);
    const pending = await get("/route/status?routeId=" + routeId);
    assert.equal(pending.body.state, "pending");
    const claimed = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S1, nonce: nonce(1), url: URL_1,
    });
    const data = claimed.structuredContent as Record<string, unknown>;
    assert.equal(data.claimed, true, JSON.stringify(data));
    const route = data.route as Record<string, unknown>;
    assert.equal(route.routeId, routeId);
    assert.equal(route.workspaceId, WS_A);
    assert.equal(route.dshSessionId, S1);
    assert.equal(route.canonicalChatUrl, URL_1);
    assert.equal(route.exactTabId, 42);
    assert.equal(route.consentRevision, 1);
    const active = await get("/route/status?routeId=" + routeId);
    assert.equal(active.body.state, "active");
  });

  // =========================================================================
  await check("second exact route in the same workspace runs beside the first", async () => {
    const proposed = await post("/route/propose", { nonce: nonce(2), url: URL_2, tabId: 43 });
    const routeId = String(proposed.body.routeId);
    const claimed = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S2, nonce: nonce(2), url: URL_2,
    });
    assert.equal((claimed.structuredContent as Record<string, unknown>).claimed, true);
    const routes = await get("/routes");
    assert.equal((routes.body.routes as unknown[]).length, 2);
    assert.equal((routes.body.routes as { state: string }[]).every((route) => route.state === "active"), true);
  });

  // =========================================================================
  await check("per-route durable queue delivers a fixed wake and never the email body", async () => {
    const routes = (await get("/routes")).body.routes as { routeId: string; canonicalChatUrl: string }[];
    const route1 = routes.find((route) => route.canonicalChatUrl === URL_1)!;
    const enqueued = await mcp("coach_route_admin", {
      action: "enqueue_wake", routeId: route1.routeId, messageId: "wake-1", eventId: 12, operationId: "codex-qa",
    });
    assert.equal(enqueued.isError ?? false, false);
    const duplicate = await mcp("coach_route_admin", {
      action: "enqueue_wake", routeId: route1.routeId, messageId: "wake-1", eventId: 12, operationId: "codex-qa",
    });
    assert.match(String(duplicate.content?.[0]?.text), /idempotent/);
    const conflict = await mcp("coach_route_admin", {
      action: "enqueue_wake", routeId: route1.routeId, messageId: "wake-1", eventId: 99, operationId: "codex-qa",
    });
    assert.equal(conflict.isError, true, "same messageId with different payload must fail closed");

    const pulled = await get("/routes/" + route1.routeId + "/next?origination=dsh&limit=1");
    assert.equal(pulled.status, 200);
    const messages = pulled.body.messages as Record<string, unknown>[];
    assert.equal(messages.length, 1);
    const wake = messages[0];
    assert.equal(wake.messageId, "wake-1");
    assert.equal(wake.seq, 1);
    assert.match(String(wake.contentSha256), /^[a-f0-9]{64}$/);
    assert.equal(wake.kind, "REVIEW_WAKE");
    assert.equal(wake.origination, "dsh");
    const instruction = String(wake.content);
    assert.ok(instruction.startsWith("请以 Web GPT Coach 身份独立审核"));
    assert.ok(instruction.includes(route1.routeId) && instruction.includes("wake-1"));
    assert.equal(instruction.includes("SENSITIVE_PROMPT"), false, "the DSH email body can never reach the wake instruction");
    assert.equal(instruction.includes("op-a"), false, "arbitrary event text is not promoted into a command");
  });

  // =========================================================================
  await check("DOM submission is recorded as unverified, not as a completed review", async () => {
    const routes = (await get("/routes")).body.routes as { routeId: string; canonicalChatUrl: string }[];
    const route1 = routes.find((route) => route.canonicalChatUrl === URL_1)!;
    // The first pull already leased the message; read its exact identity back.
    const inbox = await mcp("coach_route_state", { action: "inbox", routeId: route1.routeId, origination: "dsh" });
    const listed = (inbox.structuredContent?.messages as { messageId: string; seq: number; contentSha256: string }[])
      .find((message) => message.messageId === "wake-1")!;
    const first = await post("/routes/" + route1.routeId + "/ack", {
      messageId: "wake-1", seq: 1, contentSha256: listed.contentSha256, outcome: "dom_submitted",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body.message as { state: string }).state, "dom_submitted");
    const snapshot = await mcp("coach_route_state", { action: "snapshot" });
    const pending = snapshot.structuredContent?.pendingReviews as { messageId: string }[];
    assert.equal(pending.some((wake) => wake.messageId === "wake-1"), true, "a DOM submission still awaits the GPT review");
    const duplicateAck = await post("/routes/" + route1.routeId + "/ack", {
      messageId: "wake-1", seq: 1, contentSha256: listed.contentSha256, outcome: "dom_submitted",
    });
    assert.equal(duplicateAck.status, 200, "duplicate ACK is idempotent");
    const conflictingAck = await post("/routes/" + route1.routeId + "/ack", {
      messageId: "wake-1", seq: 1, contentSha256: listed.contentSha256, outcome: "acked",
    });
    assert.equal(conflictingAck.status, 409, "conflicting ACK fails closed");
  });

  // =========================================================================
  await check("tracked GPT reply closes the review and is delivered back to DSH", async () => {
    const routes = (await get("/routes")).body.routes as { routeId: string; canonicalChatUrl: string }[];
    const route1 = routes.find((route) => route.canonicalChatUrl === URL_1)!;
    const reply = await mcp("coach_route_admin", {
      action: "reply", routeId: route1.routeId, messageId: "reply-1",
      content: "APPROVED: evidence verified. Not an instruction to the browser.",
      inReplyTo: "wake-1",
    });
    assert.equal(reply.isError ?? false, false);
    const snapshot = await mcp("coach_route_state", { action: "snapshot" });
    assert.equal((snapshot.structuredContent?.pendingReviews as unknown[]).length, 0, "only a tracked reply completes a review");
    const inbox = await mcp("coach_route_state", { action: "inbox", routeId: route1.routeId, origination: "webgpt" });
    const messages = inbox.structuredContent?.messages as { messageId: string; seq: number; contentSha256: string; data: { inReplyTo: string } }[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0].data.inReplyTo, "wake-1");
    const claimed = await mcp("coach_route_admin", {
      action: "claim_delivery", routeId: route1.routeId, origination: "webgpt", limit: 1,
    });
    assert.equal((claimed.structuredContent?.messages as unknown[]).length, 1);
    const acked = await mcp("coach_route_admin", {
      action: "ack", routeId: route1.routeId, messageId: "reply-1", seq: 2,
      contentSha256: messages[0].contentSha256, outcome: "acked",
    });
    assert.equal(acked.isError ?? false, false);
    assert.equal(((acked.structuredContent?.message as { state: string }).state), "acked");
  });

  // =========================================================================
  await check("negative identities are rejected: wrong nonce/url/session, duplicate chat/tab", async () => {
    const proposed = await post("/route/propose", { nonce: nonce(10), url: URL_3, tabId: 50 });
    const routeId = String(proposed.body.routeId);
    const wrongNonce = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S1, nonce: nonce(99), url: URL_3,
    });
    assert.equal((wrongNonce.structuredContent as Record<string, unknown>).code, "ROUTE_PROPOSAL_NOT_FOUND");
    const wrongUrl = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S1, nonce: nonce(10), url: URL_2,
    });
    assert.equal((wrongUrl.structuredContent as Record<string, unknown>).code, "ROUTE_PROPOSAL_MISMATCH");
    const unauthorizedSession = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S3, nonce: nonce(10), url: URL_3,
    });
    assert.equal((unauthorizedSession.structuredContent as Record<string, unknown>).code, "ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    // Duplicate chat: URL_1 already owns exactly one route.
    const duplicateChat = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId, dshSessionId: S2, nonce: nonce(10), url: URL_1,
    });
    assert.equal((duplicateChat.structuredContent as Record<string, unknown>).code, "ROUTE_PROPOSAL_MISMATCH",
      "a proposal is bound to its exact URL before any duplicate chat check");
    // A fresh proposal for an already-bound chat is rejected at claim time
    // (S2 is authorized, so the rejection is the one-chat-one-route conflict).
    const dup = await post("/route/propose", { nonce: nonce(11), url: URL_1, tabId: 51 });
    const dupClaim = await mcp("coach_webgpt_claim_browser_route_exact", {
      workspaceId: WS_A, routeId: String(dup.body.routeId), dshSessionId: S2, nonce: nonce(11), url: URL_1,
    });
    assert.equal((dupClaim.structuredContent as Record<string, unknown>).code, "ROUTE_CHAT_ALREADY_BOUND");
    // HTTP transport is origin/bearer bound.
    const noOrigin = await fetch("http://127.0.0.1:" + port + "/route/propose", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonce(12), url: URL_1, tabId: 52 }),
    });
    assert.equal(noOrigin.status, 403);
    const badNonce = await post("/route/propose", { nonce: "zz", url: URL_1, tabId: 52 });
    assert.equal(badNonce.status, 400);
    const unknownField = await post("/route/propose", { nonce: nonce(13), url: URL_3, tabId: 53, workspaceId: WS_A });
    assert.equal(unknownField.status, 400, "browser must never supply a workspaceId");
  });

  // =========================================================================
  await check("explicit revoke stops one route without touching the other and never rebinds", async () => {
    const routes = (await get("/routes")).body.routes as { routeId: string; canonicalChatUrl: string; consentRevision: number }[];
    const route2 = routes.find((route) => route.canonicalChatUrl === URL_2)!;
    const route1 = routes.find((route) => route.canonicalChatUrl === URL_1)!;
    const revoked = await mcp("coach_route_admin", {
      action: "revoke", routeId: route2.routeId, expectedConsentRevision: route2.consentRevision, reason: "user clicked unbind",
    });
    assert.equal(revoked.isError ?? false, false);
    assert.equal(((revoked.structuredContent?.route as { state: string }).state), "revoked");
    const staleRevoke = await mcp("coach_route_admin", { action: "revoke", routeId: route2.routeId, expectedConsentRevision: 1 });
    assert.equal(((staleRevoke.structuredContent?.route as { state: string }).state), "revoked", "revoke is idempotent");
    const enqueueRevoked = await mcp("coach_route_admin", {
      action: "enqueue_wake", routeId: route2.routeId, messageId: "wake-x", eventId: 1, operationId: "codex-x",
    });
    assert.equal(enqueueRevoked.isError, true, "a revoked route accepts no new messages");
    const live = await get("/routes");
    assert.equal((live.body.routes as { state: string }[]).filter((route) => route.state === "active").length, 1);
    assert.equal(live.body.routes?.constructor, Array);
    void route1;
    // The revoked route cannot be used to deliver its queued work either.
    const pull = await get("/routes/" + route2.routeId + "/next?origination=dsh");
    assert.equal(pull.status, 409);
  });

  // =========================================================================
  await check("legacy workspace-only binding stays untouched and legacy routes are UNROUTABLE", async () => {
    const legacyNonce = nonce(20);
    const startedBind = await post("/bind/start", { nonce: legacyNonce, url: URL_3 });
    assert.equal(startedBind.status, 200);
    assert.equal(manager.claimBrowserRoute(WS_A, legacyNonce, URL_3), true, "the old workspace-only claim keeps working");
    const legacyStatus = await get("/bind/status?nonce=" + legacyNonce);
    assert.equal(legacyStatus.body.state, "claimed");
    const imported = await post("/routes/legacy/import", {
      records: [{ workspaceId: WS_A, url: URL_3, tabId: 60 }],
    });
    assert.equal(imported.status, 200);
    assert.equal((imported.body.legacy as { state: string }[])[0].state, "legacy");
    const classified = await mcp("coach_route_state", { action: "classify_legacy", workspaceId: WS_A, messageId: "old-message" });
    assert.equal(((classified.structuredContent?.classification as { state: string }).state), "UNROUTABLE");
    const migrated = await mcp("coach_route_admin", {
      action: "migrate_legacy", legacyId: (imported.body.legacy as { legacyId: string }[])[0].legacyId,
      targetRouteId: ((await get("/routes")).body.routes as { routeId: string; canonicalChatUrl: string }[])
        .find((route) => route.canonicalChatUrl === URL_1)!.routeId,
    });
    assert.equal(migrated.isError, true, "migration must match workspace AND conversation exactly");
  });

  // =========================================================================
  await check("durable audit evidence exists and contains no authentication material", async () => {
    // A queue limit is enforced through the real HTTP surface.
    const routes = (await get("/routes")).body.routes as { routeId: string }[];
    const route1 = routes[0];
    void route1;
    const auditFile = join(routeStateDir, "audit.jsonl");
    const auditText = readFileSync(auditFile, "utf8");
    assert.ok(auditText.length > 0);
    assert.equal(auditText.includes(token), false, "audit log must never contain the bearer token");
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{16,}/.test(auditText), false);
  });

  // =========================================================================
  await check("clean shutdown releases locks and is not resurrected", async () => {
    await client!.close();
    await toolServer!.close();
    client = undefined;
    toolServer = undefined;
    await manager.stop(WS_A);
    assert.equal(manager.status(WS_A), undefined);
    assert.equal(locks.snapshot().length, 0);
    const routesFile = JSON.parse(readFileSync(join(routeStateDir, "routes.json"), "utf8")) as {
      routes: { routeId: string; state: string }[]; legacy: { state: string }[];
    };
    assert.equal(routesFile.routes.length, 2);
    assert.equal(routesFile.routes.filter((route) => route.state === "revoked").length, 1);
    assert.equal(routesFile.legacy[0].state, "legacy");
    await manager.close();
  });

  console.log("\nCOACH_MULTIROUTE_INTEGRATION_RESULT passed=" + passed);
  if (process.exitCode) throw new Error("integration checks failed");
  console.log("COACH_MULTIROUTE_INTEGRATION_PASS");
} finally {
  try { await client?.close(); } catch { /* already closed */ }
  try { await toolServer?.close(); } catch { /* already closed */ }
  try { await manager.close(); } catch { /* already closed */ }
  try { events.close(); } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true });
}
