/**
 * TR-DSH-MULTIROUTE-AND-NAVAL-001 — I1/I2 offline core verification.
 *
 * Real command (recorded in MULTIROUTE_REPORT.md):
 *   node_modules/.bin/tsx src/coach-multiroute.test.ts
 *
 * Covers ACCEPTANCE A-02/A-03 routing and durability semantics without touching
 * any production Sidecar, Chrome profile, launchd service or network endpoint.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_KEY_RE, DSH_SESSION_RE, LEGACY_ID_RE, MESSAGE_ID_RE, MultiRouteStore, ROUTE_ID_RE,
  RouteError, assertNoAuthMaterial, buildReviewWakeInstruction, canonicalChatUrl,
  legacyRouteId, mintRouteId, redactForLog, sha256Hex,
} from "./coach-multiroute.js";

const require = createRequire(import.meta.url);
const gate = require("../coach-browser-extension/multiroute-gate.js") as {
  buildReviewWakeInstruction(input: { routeId: string; messageId: string; eventId: number; operationId: string; workspaceId: string }): string;
  canonicalChatUrl(value: unknown): string | null;
  validateRoute(record: unknown): { ok: boolean; code?: string };
  classifyLegacyRoutes(routes: Record<string, unknown>): { state: string; reason: string }[];
  validateWake(wake: Record<string, unknown>, route: Record<string, unknown>): { ok: boolean; code?: string; instruction?: string };
  decideDelivery(input: Record<string, unknown>): { action: string; code?: string; instruction?: string };
  classifyOutcome(result: Record<string, unknown>): { state: string; reviewed: boolean; retryable?: boolean; code?: string };
  classifyReviewState(input: Record<string, unknown>): { state: string; reviewed: boolean };
};

// ---------------------------------------------------------------------------
// Identities used by the contract / TestOS route
// ---------------------------------------------------------------------------

const WS_A = "ws_58c90da6-696f-4cc3-bb62-c13436cde99c";
const WS_B = "ws_test-b-4cc3-bb62-c13436cde99c";
const WS_C = "ws_test-c-9f87c54cd3e3";
const S1 = "session-0645ad77-b57a-40d6-a2fa-448824ec5007";
const S2 = "session-098d80fb-cf9a-4116-b088-11fe5a9456e0";
const S3 = "session-11111111-2222-4333-8444-555555555555";
const S4 = "session-22222222-3333-4444-8555-666666666666";
const URL_1 = "https://chatgpt.com/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3";
const URL_2 = "https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc";
const URL_3 = "https://chatgpt.com/g/g-abc123/c/87654321-abcd-1234-abcd-123456789abc";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: { name: string; error: unknown }[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    failures.push({ name, error });
    console.error("FAIL " + name + " :: " + (error instanceof Error ? error.message : String(error)));
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "coach-multiroute-"));
}

function clock(start = Date.UTC(2026, 9, 26, 0, 0, 0)) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) { current += ms; },
    set(value: number) { current = value; },
  };
}

function openStore(dir: string, now: () => number, extra: Record<string, unknown> = {}): MultiRouteStore {
  return new MultiRouteStore({ stateDir: dir, now, ...(extra as object) });
}

function expectCode(fn: () => unknown, code: string): RouteError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RouteError, "expected RouteError " + code + " but got " + String(error));
    assert.equal(error.code, code, "expected " + code + " but got " + error.code + " (" + error.message + ")");
    return error;
  }
  throw new Error("expected RouteError " + code + " but the call succeeded");
}

interface BindInput {
  store: MultiRouteStore; url?: string; tabId?: number; workspaceId?: string; dshSessionId?: string;
  authorizedWorkspaceIds?: string[]; authorizedDshSessionIds?: string[];
  replaceRouteId?: string; expectedConsentRevision?: number; nonce?: string;
}
function bind(input: BindInput) {
  const url = input.url ?? URL_1;
  const workspaceId = input.workspaceId ?? WS_A;
  const dshSessionId = input.dshSessionId ?? S1;
  const nonce = input.nonce ?? sha256Hex(String(Math.random())).slice(0, 32);
  const proposal = input.store.propose({ nonce, url, tabId: input.tabId ?? 42 });
  return input.store.claimExact({
    routeId: proposal.routeId, nonce, url, workspaceId, dshSessionId,
    authorizedWorkspaceIds: input.authorizedWorkspaceIds ?? [workspaceId],
    authorizedDshSessionIds: input.authorizedDshSessionIds ?? [dshSessionId],
    ...(input.replaceRouteId ? { replaceRouteId: input.replaceRouteId, expectedConsentRevision: input.expectedConsentRevision } : {}),
  });
}

const nonce = (seed: number) => sha256Hex("nonce-" + seed).slice(0, 32);

// ===========================================================================
// 1. Unguessable route identity & canonical conversation URLs
// ===========================================================================

await check("routeId is a random 256-bit value, unguessable and not derived from any identity", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 256; i++) {
    const id = mintRouteId();
    assert.match(id, ROUTE_ID_RE);
    assert.equal(id.length, 46);
    ids.add(id);
  }
  assert.equal(ids.size, 256, "routeIds must never collide");
  const derived = mintRouteId();
  for (const secret of [WS_A, S1, "6adc5230", "42"]) assert.equal(derived.includes(secret), false);
});

await check("canonicalChatUrl accepts exactly one canonical ChatGPT conversation form", () => {
  assert.equal(canonicalChatUrl(URL_1), URL_1);
  assert.equal(canonicalChatUrl(URL_1 + "/"), URL_1);
  assert.equal(canonicalChatUrl(URL_1 + "?model=auto#frag"), URL_1, "query/hash never fork chat identity");
  assert.equal(canonicalChatUrl(URL_3), URL_3, "team/g-prefixed conversations are supported");
  for (const bad of [
    "http://chatgpt.com/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3",
    "https://evil.example/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3",
    "https://chatgpt.com:8443/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3",
    "https://chatgpt.com/c/short",
    "https://chatgpt.com/c/6adc5230-8bec-83e8-8912-9f87c54cd3e3/extra",
    "https://chatgpt.com/g/g-abc123",
    "not a url", "", null, 42,
  ]) assert.equal(canonicalChatUrl(bad), null, "must reject " + String(bad));
  assert.equal(gate.canonicalChatUrl(URL_1 + "?x=1"), URL_1, "extension gate canonicalisation must agree");
});

await check("the review-wake template is byte-identical in core and Chrome gate", () => {
  const input = { routeId: mintRouteId(), messageId: "wake-0001", eventId: 12, operationId: "codex-qa", workspaceId: WS_A };
  const core = buildReviewWakeInstruction(input);
  const browser = gate.buildReviewWakeInstruction(input);
  assert.equal(core, browser);
  assert.ok(core.startsWith("请以 Web GPT Coach 身份独立审核"));
  assert.ok(core.length <= 1500, "legacy V5 content script caps instructions at 1500 chars");
  assert.ok(core.includes(input.routeId) && core.includes(input.messageId));
});

// ===========================================================================
// 2. Browser challenge + exact-claim negatives (wrong nonce/URL/tab/session)
// ===========================================================================

await check("challenge and exact claim reject every wrong or unauthorized identity", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    expectCode(() => store.propose({ nonce: "zz", url: URL_1, tabId: 42 }), "ROUTE_INVALID_INPUT");
    expectCode(() => store.propose({ nonce: nonce(1), url: "https://evil.example/x", tabId: 42 }), "ROUTE_INVALID_INPUT");
    expectCode(() => store.propose({ nonce: nonce(1), url: URL_1, tabId: 0 }), "ROUTE_INVALID_INPUT");

    // Wrong nonce: never even finds the challenge.
    const p1 = store.propose({ nonce: nonce(2), url: URL_1, tabId: 42 });
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(99), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_PROPOSAL_NOT_FOUND");
    // Wrong routeId / wrong URL for an existing challenge.
    expectCode(() => store.claimExact({
      routeId: mintRouteId(), nonce: nonce(2), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_PROPOSAL_MISMATCH");
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_2, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_PROPOSAL_MISMATCH");
    // Unauthorized workspace / session, and no session consent at all.
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_1, workspaceId: WS_B, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_WORKSPACE_NOT_AUTHORIZED");
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_1, workspaceId: WS_A, dshSessionId: S2,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [],
    }), "ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_1, workspaceId: WS_A, dshSessionId: "session-not-a-real-id",
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_INVALID_INPUT");
    // Expiry.
    c.advance(600_001);
    expectCode(() => store.claimExact({
      routeId: p1.routeId, nonce: nonce(2), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_PROPOSAL_EXPIRED");
    // Fresh exact claim works and is one-shot.
    const p2 = store.propose({ nonce: nonce(3), url: URL_1, tabId: 42 });
    const claimed = store.claimExact({
      routeId: p2.routeId, nonce: nonce(3), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    });
    assert.equal(claimed.state, "active");
    assert.equal(claimed.consentRevision, 1);
    assert.equal(claimed.claimNonceSha256, sha256Hex(nonce(3)));
    assert.equal(JSON.stringify(claimed).includes(nonce(3)), false, "the raw one-time nonce is never persisted");
    expectCode(() => store.claimExact({
      routeId: p2.routeId, nonce: nonce(3), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_PROPOSAL_ALREADY_CLAIMED");

    // Duplicate chat / session / tab bindings are rejected.
    const p3 = store.propose({ nonce: nonce(4), url: URL_1, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p3.routeId, nonce: nonce(4), url: URL_1, workspaceId: WS_A, dshSessionId: S2,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S2],
    }), "ROUTE_CHAT_ALREADY_BOUND");
    const p4 = store.propose({ nonce: nonce(5), url: URL_2, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p4.routeId, nonce: nonce(5), url: URL_2, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
    }), "ROUTE_SESSION_ALREADY_BOUND");
    const p5 = store.propose({ nonce: nonce(6), url: URL_2, tabId: 42 });
    expectCode(() => store.claimExact({
      routeId: p5.routeId, nonce: nonce(6), url: URL_2, workspaceId: WS_A, dshSessionId: S2,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S2],
    }), "ROUTE_TAB_ALREADY_BOUND");
    assert.equal(store.activeRoutes().length, 1, "rejected claims must not mutate the registry");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 3. A-02: 2 DSH sessions => 2 chats in ONE workspace, parallel and isolated
// ===========================================================================

await check("A-02 same workspace: two sessions/two chats run in parallel and never cross", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const a = bind({ store, url: URL_1, tabId: 42, workspaceId: WS_A, dshSessionId: S1 });
    const b = bind({ store, url: URL_2, tabId: 43, workspaceId: WS_A, dshSessionId: S2 });
    assert.notEqual(a.routeId, b.routeId);
    assert.deepEqual(store.workspaceActiveRoutes(WS_A).map((route) => route.dshSessionId).sort(), [S1, S2]);
    assert.equal(store.activeRoutes().length, 2);

    const wakeA = store.enqueueReviewWake({ routeId: a.routeId, messageId: "wake-a-1", eventId: 100, operationId: "codex-a" });
    const wakeB = store.enqueueReviewWake({ routeId: b.routeId, messageId: "wake-b-1", eventId: 200, operationId: "codex-b" });
    assert.equal(wakeA.envelope.seq, 1);
    assert.equal(wakeB.envelope.seq, 1, "each route owns an independent cursor");

    const claimA = store.claimDeliveries({ routeId: a.routeId, origination: "dsh" });
    const claimB = store.claimDeliveries({ routeId: b.routeId, origination: "dsh" });
    assert.equal(claimA.length, 1);
    assert.equal(claimB.length, 1);
    assert.equal(claimA[0].messageId, "wake-a-1");
    assert.equal(claimB[0].messageId, "wake-b-1");
    assert.equal(claimA[0].workspaceId, WS_A);
    assert.equal(claimA[0].dshSessionId, S1);
    assert.equal(claimB[0].dshSessionId, S2);

    // Cross-route ack identity is impossible: route B never sees A's message.
    expectCode(() => store.recordDeliveryOutcome({
      routeId: b.routeId, messageId: "wake-a-1", seq: 1, contentSha256: claimA[0].contentSha256, outcome: "dom_submitted",
    }), "ROUTE_NOT_FOUND");
    // Wrong SHA on the right route fails closed too.
    expectCode(() => store.recordDeliveryOutcome({
      routeId: a.routeId, messageId: "wake-a-1", seq: 1, contentSha256: "f".repeat(64), outcome: "dom_submitted",
    }), "ROUTE_ACK_CONFLICT");

    const ackedA = store.recordDeliveryOutcome({
      routeId: a.routeId, messageId: "wake-a-1", seq: 1, contentSha256: claimA[0].contentSha256, outcome: "dom_submitted",
    });
    assert.equal(ackedA.state, "dom_submitted");
    assert.equal(store.queueStats(a.routeId).ackedThroughSeq, 1);
    assert.equal(store.queueStats(b.routeId).ackedThroughSeq, 0, "route B cursor must stay independent");
    // WebGPT reply on B -> DSH inbox on B only.
    store.enqueueReply({ routeId: b.routeId, messageId: "reply-b-1", content: "B REWORK: add test", inReplyTo: "wake-b-1" });
    assert.equal(store.listMessages({ routeId: a.routeId, origination: "webgpt" }).length, 0);
    assert.equal(store.listMessages({ routeId: b.routeId, origination: "webgpt" }).length, 1);
    store.recordDeliveryOutcome({
      routeId: b.routeId, messageId: "wake-b-1", seq: 1,
      contentSha256: claimB[0].contentSha256, outcome: "dom_submitted",
    });
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 4. A-02: 3 workspaces => 3 chats, simultaneously in both directions
// ===========================================================================

await check("A-02 three workspaces: three exact routes run simultaneously in both directions", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const routes = [
      bind({ store, url: URL_1, tabId: 11, workspaceId: WS_A, dshSessionId: S1 }),
      bind({ store, url: URL_2, tabId: 12, workspaceId: WS_B, dshSessionId: S2 }),
      bind({ store, url: URL_3, tabId: 13, workspaceId: WS_C, dshSessionId: S3 }),
    ];
    assert.deepEqual(routes.map((route) => route.workspaceId), [WS_A, WS_B, WS_C]);
    // Each route sends and receives concurrently.
    for (let i = 0; i < routes.length; i++) {
      store.enqueueReviewWake({ routeId: routes[i].routeId, messageId: "wake-" + i, eventId: 10 + i, operationId: "codex-" + i });
    }
    for (let i = 0; i < routes.length; i++) {
      const [claimed] = store.claimDeliveries({ routeId: routes[i].routeId, origination: "dsh" });
      assert.equal(claimed.messageId, "wake-" + i);
      store.enqueueReply({ routeId: routes[i].routeId, messageId: "reply-" + i, content: "decision " + i, inReplyTo: "wake-" + i });
      store.recordDeliveryOutcome({ routeId: routes[i].routeId, messageId: "wake-" + i, seq: 1, contentSha256: claimed.contentSha256, outcome: "dom_submitted" });
      const [reply] = store.claimDeliveries({ routeId: routes[i].routeId, origination: "webgpt" });
      assert.equal(reply.messageId, "reply-" + i);
      store.recordDeliveryOutcome({ routeId: routes[i].routeId, messageId: "reply-" + i, seq: 2, contentSha256: reply.contentSha256, outcome: "acked" });
    }
    // Cross workspace authority cannot claim another workspace's route identity.
    const p = store.propose({ nonce: nonce(77), url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", tabId: 99 });
    expectCode(() => store.claimExact({
      routeId: p.routeId, nonce: nonce(77), url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workspaceId: WS_A, dshSessionId: S4,
      authorizedWorkspaceIds: [WS_B], authorizedDshSessionIds: [S4],
    }), "ROUTE_WORKSPACE_NOT_AUTHORIZED");
    // A tab is globally unique: the same exact tab cannot serve two workspaces.
    const p2 = store.propose({ nonce: nonce(78), url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", tabId: 11 });
    expectCode(() => store.claimExact({
      routeId: p2.routeId, nonce: nonce(78), url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workspaceId: WS_B, dshSessionId: S4,
      authorizedWorkspaceIds: [WS_B], authorizedDshSessionIds: [S4],
    }), "ROUTE_TAB_ALREADY_BOUND");
    const snapshot = store.snapshot();
    assert.equal(snapshot.routes.filter((route) => route.state === "active").length, 3);
    for (const route of routes) {
      // wake + reply both terminal, contiguous cursor=2
      assert.equal(snapshot.queues[route.routeId].ackedThroughSeq, 2);
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 5. Bidirectional interleaving, dedupe, payload conflict
// ===========================================================================

await check("bidirectional traffic interleaves; duplicate enqueue is idempotent; payload conflicts fail closed", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    const wake = store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 5, operationId: "codex-five" });
    const duplicate = store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 5, operationId: "codex-five" });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.envelope.seq, wake.envelope.seq);
    assert.equal(store.queueStats(route.routeId).lastSeq, 1);
    expectCode(() => store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 6, operationId: "codex-five" }), "ROUTE_PAYLOAD_CONFLICT");

    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome: "dom_submitted" });
    // GPT reply (webgpt -> dsh) lands while the next wake is still queued.
    const reply = store.enqueueReply({ routeId: route.routeId, messageId: "reply-1", content: "REWORK: missing negative test", inReplyTo: "wake-1" });
    assert.equal(reply.envelope.seq, 2);
    const replyDuplicate = store.enqueueReply({ routeId: route.routeId, messageId: "reply-1", content: "REWORK: missing negative test", inReplyTo: "wake-1" });
    assert.equal(replyDuplicate.duplicate, true);
    expectCode(() => store.enqueueReply({ routeId: route.routeId, messageId: "reply-1", content: "different payload", inReplyTo: "wake-1" }), "ROUTE_PAYLOAD_CONFLICT");
    expectCode(() => store.enqueueReply({ routeId: route.routeId, messageId: "reply-2", content: "orphan", inReplyTo: "wake-does-not-exist" }), "ROUTE_NOT_FOUND");
    const [claimedReply] = store.claimDeliveries({ routeId: route.routeId, origination: "webgpt" });
    assert.equal(claimedReply.messageId, "reply-1");
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "reply-1", seq: 2, contentSha256: claimedReply.contentSha256, outcome: "acked" });
    assert.equal(store.queueStats(route.routeId).ackedThroughSeq, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 6. dom_submitted is NOT a completed GPT review
// ===========================================================================

await check("dom_submitted alone never counts as a completed review; only a tracked GPT reply does", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-9", eventId: 9, operationId: "codex-nine" });
    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    const submitted = store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-9", seq: 1, contentSha256: claimed.contentSha256, outcome: "dom_submitted" });
    assert.equal(submitted.state, "dom_submitted");
    const pending = store.pendingReviewWakes();
    assert.equal(pending.length, 1, "a DOM submission must remain an outstanding review");
    assert.equal(pending[0].messageId, "wake-9");
    assert.equal(gate.classifyReviewState({ messageState: "dom_submitted_unverified", hasGptReply: false }).reviewed, false);
    assert.equal(gate.classifyReviewState({ messageState: "dom_submitted", hasGptReply: false }).state, "awaiting_gpt_review");
    store.enqueueReply({ routeId: route.routeId, messageId: "reply-9", content: "APPROVED with evidence", inReplyTo: "wake-9" });
    assert.equal(store.pendingReviewWakes().length, 0, "only the tracked GPT reply closes the review");
    assert.equal(gate.classifyReviewState({ messageState: "dom_submitted", hasGptReply: true }).reviewed, true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 7. Explicit revoke / explicit rebind, consent revision fencing
// ===========================================================================

await check("explicit revoke stops the route; explicit rebind increments consentRevision and fences stale work", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const first = bind({ store, url: URL_1, tabId: 42 });
    expectCode(() => store.revoke({ routeId: first.routeId, expectedConsentRevision: 99 }), "ROUTE_CONSENT_REVISION_MISMATCH");
    // Explicit rebind while the original route is still active: the old route
    // is revoked atomically and the replacement gets the next revision.
    const second = bind({
      store, url: URL_1, tabId: 44, replaceRouteId: first.routeId,
      expectedConsentRevision: first.consentRevision, nonce: nonce(31),
    });
    assert.equal(second.state, "active");
    assert.equal(second.replacedRouteId, first.routeId);
    assert.equal(second.consentRevision, first.consentRevision + 1);
    assert.equal(second.exactTabId, 44, "rebind may move to the exact new tab");
    assert.equal(store.route(first.routeId)?.state, "revoked");
    store.enqueueReviewWake({ routeId: second.routeId, messageId: "wake-y", eventId: 2, operationId: "codex-y" });
    assert.equal(store.queueStats(second.routeId).lastSeq, 1, "the rebound route owns a fresh queue");
    expectCode(() => store.enqueueReviewWake({ routeId: first.routeId, messageId: "wake-x", eventId: 1, operationId: "codex-x" }), "ROUTE_REVOKED");
    expectCode(() => store.claimDeliveries({ routeId: first.routeId, origination: "dsh" }), "ROUTE_REVOKED");
    // Explicit revoke of the replacement; revoke is idempotent.
    const revoked = store.revoke({ routeId: second.routeId, expectedConsentRevision: second.consentRevision, reason: "user clicked unbind" });
    assert.equal(revoked.state, "revoked");
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.consentRevision, second.consentRevision + 1);
    assert.equal(store.revoke({ routeId: second.routeId }).state, "revoked", "revoke is idempotent");
    // A revoke frees the chat for a brand new explicit binding.
    const third = bind({ store, url: URL_1, tabId: 45, dshSessionId: S1, nonce: nonce(32) });
    assert.equal(third.state, "active");
    assert.equal(third.consentRevision, revoked.consentRevision + 1);
    assert.equal(store.activeRoutes().length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("rebind is fenced by chat, workspace and stale consent revision", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const first = bind({ store, url: URL_1, tabId: 42 });
    // A different conversation may never inherit this chat's route.
    const p = store.propose({ nonce: nonce(41), url: URL_2, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p.routeId, nonce: nonce(41), url: URL_2, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
      replaceRouteId: first.routeId, expectedConsentRevision: first.consentRevision,
    }), "ROUTE_CHAT_MISMATCH");
    // Stale expected revision is rejected.
    const p2 = store.propose({ nonce: nonce(42), url: URL_1, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p2.routeId, nonce: nonce(42), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
      replaceRouteId: first.routeId, expectedConsentRevision: first.consentRevision + 5,
    }), "ROUTE_CONSENT_REVISION_MISMATCH");
    // After explicit revoke the old route cannot be replaced (it is not active).
    store.revoke({ routeId: first.routeId });
    const p3 = store.propose({ nonce: nonce(43), url: URL_1, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p3.routeId, nonce: nonce(43), url: URL_1, workspaceId: WS_A, dshSessionId: S1,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S1],
      replaceRouteId: first.routeId, expectedConsentRevision: 2,
    }), "ROUTE_NOT_ACTIVE");
    // A revoke frees the chat for a brand new explicit binding.
    const fresh = bind({ store, url: URL_1, tabId: 43, dshSessionId: S1 });
    assert.equal(fresh.state, "active");
    assert.equal(fresh.consentRevision, 3, "only successful claims consume a consent revision");
    assert.equal(store.activeRoutes().length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 8. Wrong tab / navigation mismatch
// ===========================================================================

await check("wrong tab and navigated conversation are hard mismatches, never silent rebinds", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    assert.equal(store.verifyTab({ routeId: route.routeId, tabId: 42, url: URL_1 }).routeId, route.routeId);
    assert.equal(store.verifyTab({ routeId: route.routeId, tabId: 42, url: URL_1 + "?model=auto" }).routeId, route.routeId);
    expectCode(() => store.verifyTab({ routeId: route.routeId, tabId: 43, url: URL_1 }), "ROUTE_TAB_MISMATCH");
    expectCode(() => store.verifyTab({ routeId: route.routeId, tabId: 42, url: URL_2 }), "ROUTE_CHAT_MISMATCH");
    expectCode(() => store.verifyTab({ routeId: route.routeId, tabId: 42, url: "https://evil.example/c/12345678-abcd-1234-abcd-123456789abc" }), "ROUTE_CHAT_MISMATCH");
    store.revoke({ routeId: route.routeId });
    expectCode(() => store.verifyTab({ routeId: route.routeId, tabId: 42, url: URL_1 }), "ROUTE_REVOKED");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 9. Durable restart recovery: queue, seq, cursor, ACK
// ===========================================================================

await check("restart recovers per-route queue, sequence, cursor and ACK idempotently", () => {
  const dir = tempDir();
  try {
    const c = clock();
    let store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    for (let i = 1; i <= 3; i++) store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-" + i, eventId: i, operationId: "codex-" + i });
    const [claimed1] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed1.contentSha256, outcome: "dom_submitted" });
    assert.equal(store.queueStats(route.routeId).ackedThroughSeq, 1);
    store.close();

    // Simulated crash/restart: a brand new store on the same durable state.
    c.advance(5_000);
    store = openStore(dir, c.now);
    assert.equal(store.route(route.routeId)?.state, "active");
    const stats = store.queueStats(route.routeId);
    assert.deepEqual(stats, {
      queued: 2, delivering: 0, needsAttention: 0, domSubmitted: 1, manualSent: 0, acked: 0,
      ackedThroughSeq: 1, lastSeq: 3,
    });
    // ACK replay after restart stays idempotent.
    const replay = store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed1.contentSha256, outcome: "dom_submitted" });
    assert.equal(replay.state, "dom_submitted");
    const [next] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    assert.equal(next.messageId, "wake-2", "cursor must resume at the first unacknowledged message");
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-2", seq: 2, contentSha256: next.contentSha256, outcome: "dom_submitted" });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-4", eventId: 4, operationId: "codex-4" });
    assert.equal(store.queueStats(route.routeId).lastSeq, 4, "sequence continues after restart");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 10. Half block / corrupt blocks
// ===========================================================================

await check("a torn half block is never read as a message and is repaired without replay", () => {
  const dir = tempDir();
  try {
    const c = clock();
    let store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    store.close();
    const queuePath = join(dir, "routes", route.routeId, "queue.blocks");
    const before = readFileSync(queuePath);
    assert.ok(before.length > 20);
    // Simulate a crash halfway through the next complete frame.
    appendFileSync(queuePath, "BEGIN 1 300\n{\"routeId\":\"rt_partial\",\"seq\":2,\"content\":\"torn");
    const reloaded = openStore(dir, c.now);
    assert.equal(reloaded.listMessages({ routeId: route.routeId }).length, 1, "half block must not appear as a message");
    assert.equal(readFileSync(queuePath).length, before.length, "torn tail is truncated to the last complete END+SHA block");
    reloaded.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-2", eventId: 2, operationId: "codex-2" });
    assert.equal(reloaded.queueStats(route.routeId).lastSeq, 2);
    reloaded.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("checksum corruption and non-tail corruption fail closed instead of guessing", () => {
  const corruptions: [string, (queuePath: string) => void][] = [
    ["END checksum mismatch", (path) => {
      const bytes = Buffer.from(readFileSync(path));
      const endIndex = bytes.indexOf(Buffer.from("\nEND "));
      const hexStart = endIndex + 5;
      const original = bytes.subarray(hexStart, hexStart + 1).toString();
      bytes[hexStart] = (original === "0" ? "1" : "0").charCodeAt(0);
      writeFileSync(path, bytes);
    }],
    ["payload byte flip", (path) => {
      const bytes = Buffer.from(readFileSync(path));
      const begin = bytes.indexOf(Buffer.from("\n")) + 1;
      bytes[begin] = bytes[begin] === 0x7b ? 0x7d : 0x7b;
      writeFileSync(path, bytes);
    }],
    ["missing END trailer", (path) => {
      const bytes = readFileSync(path);
      writeFileSync(path, bytes.subarray(0, bytes.length - 3));
    }],
  ];
  for (const [label, corrupt] of corruptions) {
    const dir = tempDir();
    try {
      const c = clock();
      const store = openStore(dir, c.now);
      const route = bind({ store, url: URL_1, tabId: 42 });
      store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
      store.close();
      corrupt(join(dir, "routes", route.routeId, "queue.blocks"));
      if (label === "missing END trailer") {
        // A truncated tail is indistinguishable from a crash: repairable.
        const reopened = openStore(dir, c.now);
        assert.equal(reopened.listMessages({ routeId: route.routeId }).length, 0, label + ": a torn frame is not a message");
        reopened.close();
      } else {
        // Route journals are validated when first opened: a corrupt block can
        // never be folded into a message.
        const reopened = openStore(dir, c.now);
        assert.throws(() => reopened.listMessages({ routeId: route.routeId }),
          (error: unknown) => error instanceof RouteError && error.code === "ROUTE_QUEUE_CORRUPT", label);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

await check("corrupt registry and cursor fail closed", () => {
  const dir = tempDir();
  try {
    const c = clock();
    // Registry corruption.
    writeFileSync(join(dir, "routes.json"), "{not-json");
    assert.throws(() => openStore(dir, c.now), (error: unknown) => error instanceof RouteError && error.code === "ROUTE_STORE_CORRUPT");
    // Cursor corruption on an otherwise valid store.
    const dir2 = tempDir();
    try {
      const store = openStore(dir2, c.now);
      const route = bind({ store, url: URL_1, tabId: 42 });
      store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
      store.close();
      writeFileSync(join(dir2, "routes", route.routeId, "cursor.json"), "{\"routeId\":");
      const reopened = openStore(dir2, c.now);
      assert.throws(() => reopened.listMessages({ routeId: route.routeId }),
        (error: unknown) => error instanceof RouteError && error.code === "ROUTE_QUEUE_CORRUPT");
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 11. Delivery lease expiry => at-least-once re-claim, never a duplicate submit
// ===========================================================================

await check("disconnect after claim: lease expiry re-claims the same message once, then ACK settles it", () => {
  const dir = tempDir();
  try {
    const c = clock();
    let store = openStore(dir, c.now, { deliveryLeaseMs: 1_000 });
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    const first = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    assert.equal(first.length, 1);
    assert.equal(first[0].attempt, 1);
    assert.equal(store.claimDeliveries({ routeId: route.routeId, origination: "dsh" }).length, 0, "a live lease is not re-claimed");
    store.close();
    // Crash: reopen after the lease expired.
    c.advance(2_000);
    store = openStore(dir, c.now, { deliveryLeaseMs: 1_000 });
    const second = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    assert.equal(second.length, 1, "expired lease is re-delivered");
    assert.equal(second[0].messageId, "wake-1");
    assert.equal(second[0].attempt, 2);
    // The extension must treat the earlier DOM attempt as unsettled -> it
    // resolves needs_attention instead of blindly resubmitting; a single ACK
    // eventually settles the message.
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: second[0].contentSha256, outcome: "dom_submitted" });
    assert.equal(store.queueStats(route.routeId).ackedThroughSeq, 1);
    assert.equal(store.claimDeliveries({ routeId: route.routeId, origination: "dsh" }).length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 12. Ambiguous / user-obstructed outcomes never auto-retry blindly
// ===========================================================================

await check("timeout/draft/busy/navigation/uncertain outcomes require explicit operator resolution", () => {
  const outcomes = ["uncertain", "timeout", "existing_draft", "page_busy", "navigation_mismatch"] as const;
  for (const outcome of outcomes) {
    const dir = tempDir();
    try {
      const c = clock();
      const store = openStore(dir, c.now);
      const route = bind({ store, url: URL_1, tabId: 42 });
      store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
      const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
      const result = store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome });
      assert.equal(result.state, "needs_attention", outcome);
      assert.equal(store.claimDeliveries({ routeId: route.routeId, origination: "dsh" }).length, 0, outcome + ": no blind retry");
      expectCode(() => store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome: "dom_submitted" }), "ROUTE_ACK_CONFLICT");
      // Explicit retry is the only way back into the queue.
      store.resolveAttention({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, action: "retry", reason: "user checked the chat manually" });
      const [retried] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
      assert.equal(retried.attempt, 2, outcome);
      store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: retried.contentSha256, outcome: "dom_submitted" });
      // Once terminal, no further resolve is allowed.
      expectCode(() => store.resolveAttention({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: retried.contentSha256, action: "retry" }), "ROUTE_STATE_TRANSITION_DENIED");
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

await check("an operator can explicitly settle an ambiguous delivery as manual_sent", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome: "page_busy", reason: "Web GPT 正在生成" });
    const manual = store.resolveAttention({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, action: "mark_sent", reason: "用户确认消息已手动发送" });
    assert.equal(manual.state, "manual_sent");
    assert.equal(store.queueStats(route.routeId).ackedThroughSeq, 1);
    assert.equal(store.pendingReviewWakes().length, 1, "manual send still awaits the independent GPT review reply");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("definite not_submitted returns to the queue; manual resolution can settle as manual_sent", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    const queued = store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome: "not_submitted", reason: "找不到唯一的 ChatGPT 编辑器" });
    assert.equal(queued.state, "queued");
    const [retried] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    assert.equal(retried.attempt, 2);
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: retried.contentSha256, outcome: "timeout" });
    // user confirms they submitted manually -> terminal manual_sent, still not a review.
    const manual = store.resolveAttention({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: retried.contentSha256, action: "mark_sent", reason: "手动确认已发送" });
    assert.equal(manual.state, "manual_sent");
    assert.equal(store.pendingReviewWakes().length, 1, "manual send still awaits the GPT reply");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 13. ACK idempotency and conflict
// ===========================================================================

await check("ACK is idempotent per identity and fails closed on any conflicting ack", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    const ack = { routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256 };
    const first = store.recordDeliveryOutcome({ ...ack, outcome: "dom_submitted" });
    const second = store.recordDeliveryOutcome({ ...ack, outcome: "dom_submitted" });
    assert.equal(first.state, second.state);
    expectCode(() => store.recordDeliveryOutcome({ ...ack, outcome: "acked" }), "ROUTE_ACK_CONFLICT");
    expectCode(() => store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 2, contentSha256: claimed.contentSha256, outcome: "dom_submitted" }), "ROUTE_ACK_CONFLICT");
    expectCode(() => store.recordDeliveryOutcome({ ...ack, outcome: "bogus" as never }), "ROUTE_INVALID_INPUT");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 14. Legacy workspace-only routes: preserved, explicit migration, UNROUTABLE
// ===========================================================================

await check("legacy workspace-only routes stay visible, remain UNROUTABLE and migrate only explicitly", () => {
  const dir = tempDir();
  try {
    const c = clock();
    let store = openStore(dir, c.now);
    const legacy = store.importLegacyRoutes([
      { workspaceId: WS_A, url: URL_1, tabId: 42 },
      { workspaceId: WS_A, url: URL_2, tabId: 43 },
    ]);
    assert.equal(legacy.length, 2);
    assert.ok(legacy.every((record) => record.state === "legacy"));
    assert.match(legacy[0].legacyId, LEGACY_ID_RE);
    // Idempotent passive import.
    assert.equal(store.importLegacyRoutes([{ workspaceId: WS_A, url: URL_1, tabId: 42 }]).length, 1);
    assert.equal(store.legacyRoutes().length, 2);
    expectCode(() => store.importLegacyRoutes([{ workspaceId: WS_A, url: "https://chatgpt.com/not-a-chat" }]), "ROUTE_INVALID_INPUT");
    // Even with exactly one exact route in the same workspace, legacy history
    // is never guessed onto it.
    const exact = bind({ store, url: URL_1, tabId: 42, workspaceId: WS_A, dshSessionId: S1 });
    assert.equal(store.workspaceActiveRoutes(WS_A).length, 1);
    const classified = store.classifyLegacyMessage({ workspaceId: WS_A, messageId: "old-msg-1" });
    assert.equal(classified.state, "UNROUTABLE");
    assert.equal(classified.reason, "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION");
    assert.equal(store.classifyLegacyMessage({ legacyId: legacy[0].legacyId }).state, "UNROUTABLE");
    assert.equal(store.classifyLegacyMessage({ legacyId: "legacy-" + "0".repeat(24) }).reason, "UNKNOWN_LEGACY_ROUTE");
    assert.equal(gate.validateRoute({ workspaceId: WS_A, url: URL_1, tabId: 42, enabled: true }).code, "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION");
    const gateLegacy = gate.classifyLegacyRoutes({ [WS_A]: { url: URL_1, tabId: 42, enabled: true } });
    assert.equal(gateLegacy.length, 1);
    assert.equal(gateLegacy[0].state, "UNROUTABLE");
    // Migration must match workspace + conversation exactly.
    const other = bind({ store, url: URL_2, tabId: 43, workspaceId: WS_A, dshSessionId: S2 });
    expectCode(() => store.migrateLegacy({ legacyId: legacy[0].legacyId, targetRouteId: other.routeId }), "ROUTE_LEGACY_MIGRATION_DENIED");
    const migrated = store.migrateLegacy({ legacyId: legacy[0].legacyId, targetRouteId: exact.routeId, expectedConsentRevision: exact.consentRevision });
    assert.equal(migrated.state, "migrated");
    assert.equal(migrated.migratedTo, exact.routeId);
    assert.equal(store.migrateLegacy({ legacyId: legacy[0].legacyId, targetRouteId: exact.routeId }).state, "migrated", "repeat migration is idempotent");
    expectCode(() => store.migrateLegacy({ legacyId: legacy[1].legacyId, targetRouteId: exact.routeId }), "ROUTE_LEGACY_MIGRATION_DENIED");
    // History stays UNROUTABLE even after migration; only new messages use the route.
    assert.equal(store.classifyLegacyMessage({ legacyId: legacy[0].legacyId }).state, "UNROUTABLE");
    store.close();
    // Legacy records survive restart.
    store = openStore(dir, c.now);
    assert.equal(store.legacyRoutes().length, 2);
    assert.equal(store.legacyRoutes().filter((record) => record.state === "migrated").length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 15. Resource limits / anomaly handling fail closed
// ===========================================================================

await check("queue/proposal/route limits fail closed without partial state", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now, { maxQueuedPerRoute: 2, maxProposals: 1 });
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-2", eventId: 2, operationId: "codex-2" });
    expectCode(() => store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-3", eventId: 3, operationId: "codex-3" }), "ROUTE_QUEUE_LIMIT");
    assert.equal(store.queueStats(route.routeId).lastSeq, 2, "a rejected enqueue must not consume a sequence number");
    const p = store.propose({ nonce: nonce(51), url: URL_2, tabId: 43 });
    expectCode(() => store.propose({ nonce: nonce(52), url: URL_3, tabId: 44 }), "ROUTE_LIMIT");
    // The pending proposal is still usable.
    const second = store.claimExact({
      routeId: p.routeId, nonce: nonce(51), url: URL_2, workspaceId: WS_A, dshSessionId: S2,
      authorizedWorkspaceIds: [WS_A], authorizedDshSessionIds: [S2],
    });
    assert.equal(second.state, "active");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("route count limit and unsafe state directory are rejected", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now, { maxRoutes: 1 });
    bind({ store, url: URL_1, tabId: 42, workspaceId: WS_A, dshSessionId: S1 });
    const p = store.propose({ nonce: nonce(61), url: URL_2, tabId: 43 });
    expectCode(() => store.claimExact({
      routeId: p.routeId, nonce: nonce(61), url: URL_2, workspaceId: WS_B, dshSessionId: S2,
      authorizedWorkspaceIds: [WS_B], authorizedDshSessionIds: [S2],
    }), "ROUTE_LIMIT");
    store.close();
    // A symlinked state directory must never be followed.
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    const linkParent = tempDir();
    const link = join(linkParent, "linked-state");
    symlinkSync(dir, link);
    assert.throws(() => openStore(link, c.now), (error: unknown) => error instanceof RouteError && error.code === "ROUTE_STORE_CORRUPT");
    rmSync(linkParent, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("a non-writable state directory surfaces an explicit error and keeps prior state", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.log("SKIP non-writable state directory check (running as root)");
    return;
  }
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    store.close();
    const queuePath = join(store.stateDir, "routes", route.routeId, "queue.blocks");
    chmodSync(queuePath, 0o400);
    try {
      const reopened = openStore(dir, c.now);
      assert.throws(() => reopened.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-2", eventId: 2, operationId: "codex-2" }),
        (error: unknown) => error instanceof RouteError);
    } finally {
      chmodSync(queuePath, 0o600);
    }
    const recovered = openStore(dir, c.now);
    assert.equal(recovered.queueStats(route.routeId).lastSeq, 1, "failed append leaves the durable queue intact");
    recovered.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 16. Transport/log hygiene: no authentication material
// ===========================================================================

await check("durable files and audit logs never contain authentication material", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const token = "A".repeat(43);
    const route = bind({ store, url: URL_1, tabId: 42 });
    store.propose({ nonce: nonce(81), url: URL_2, tabId: 43 });
    store.enqueueReviewWake({ routeId: route.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    const [claimed] = store.claimDeliveries({ routeId: route.routeId, origination: "dsh" });
    store.recordDeliveryOutcome({ routeId: route.routeId, messageId: "wake-1", seq: 1, contentSha256: claimed.contentSha256, outcome: "dom_submitted" });
    store.close();
    const files: string[] = [];
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        if (statSync(child).isDirectory()) walk(child);
        else files.push(child);
      }
    };
    walk(dir);
    assert.ok(files.length >= 4);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(text.includes(token), false, file + " contains the bearer token");
      assert.equal(/Bearer\s+[A-Za-z0-9_-]{16,}/.test(text), false, file + " contains a bearer credential");
      assert.equal(text.includes(nonce(81)), false, file + " contains the raw one-time nonce");
    }
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(audit.length > 0);
    assert.ok(audit.every((entry) => typeof entry.event === "string" && typeof entry.at === "string"));
    assert.ok(audit.some((entry) => entry.event === "route.claimed" && typeof entry.claimNonceSha256 === "string"),
      "claimed-route audit entry must carry a nonce hash (never the raw nonce)");
    assert.ok(audit.some((entry) => entry.event === "route.proposed" && typeof entry.nonceSha256 === "string"));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("secret helpers reject or redact credential material", () => {
  const token = "A".repeat(43);
  expectCode(() => assertNoAuthMaterial({ token }, "metadata"), "ROUTE_INVALID_INPUT");
  expectCode(() => assertNoAuthMaterial({ nested: { authorization: "x" } }, "metadata"), "ROUTE_INVALID_INPUT");
  expectCode(() => assertNoAuthMaterial({ note: "Bearer " + token }, "metadata"), "ROUTE_INVALID_INPUT");
  assert.doesNotThrow(() => assertNoAuthMaterial({ safe: "value", count: 2 }));
  const redacted = redactForLog({ token, authorization: "Bearer " + token, keep: "ok", nested: { secret: token } }) as Record<string, unknown>;
  assert.equal(redacted.token, "[redacted]");
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.keep, "ok");
  assert.equal(JSON.stringify(redacted).includes(token), false);
  assert.ok(AUTH_KEY_RE.test("api_key") && AUTH_KEY_RE.test("authorization") && !AUTH_KEY_RE.test("operation"));
  // Reasons cannot smuggle a credential into durable state/audit records.
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const route = bind({ store, url: URL_1, tabId: 42 });
    expectCode(() => store.revoke({ routeId: route.routeId, reason: "Bearer " + token }), "ROUTE_INVALID_INPUT");
    assert.equal(store.route(route.routeId)?.state, "active");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 17. Snapshot surface (read-only status for MCP/UI, no secrets)
// ===========================================================================

await check("snapshot exposes identities and queue counters without secrets", () => {
  const dir = tempDir();
  try {
    const c = clock();
    const store = openStore(dir, c.now);
    const a = bind({ store, url: URL_1, tabId: 42, dshSessionId: S1 });
    const b = bind({ store, url: URL_2, tabId: 43, workspaceId: WS_B, dshSessionId: S2 });
    store.importLegacyRoutes([{ workspaceId: WS_A, url: URL_3, tabId: 44 }]);
    store.enqueueReviewWake({ routeId: a.routeId, messageId: "wake-1", eventId: 1, operationId: "codex-1" });
    store.propose({ nonce: nonce(91), url: URL_3, tabId: 45 });
    const snapshot = store.snapshot();
    assert.equal(snapshot.consentRevision, 2);
    assert.equal(snapshot.routes.length, 2);
    assert.equal(snapshot.legacy.length, 1);
    assert.equal(snapshot.pendingProposals, 1);
    assert.deepEqual(Object.keys(snapshot.queues).sort(), [a.routeId, b.routeId].sort());
    assert.equal(snapshot.queues[a.routeId].queued, 1);
    assert.equal(snapshot.queues[b.routeId].lastSeq, 0);
    const json = JSON.stringify(snapshot);
    assert.equal(json.includes("claimNonceSha256") && /[a-f0-9]{64}/.test(json), true);
    assert.equal(/Bearer\s/.test(json), false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// Summary
// ===========================================================================

console.log("\nCOACH_MULTIROUTE_CORE_RESULT passed=" + passed + " failed=" + failures.length);
if (failures.length) {
  for (const failure of failures) console.error("FAILED: " + failure.name + " :: " + (failure.error instanceof Error ? failure.error.stack : String(failure.error)));
  process.exit(1);
}
console.log("COACH_MULTIROUTE_CORE_PASS");
