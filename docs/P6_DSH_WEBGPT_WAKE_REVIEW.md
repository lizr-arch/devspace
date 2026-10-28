# P6 — DSH completion → exact Web GPT conversation wake (one-way)

Status: **IMPLEMENTED_OFFLINE_AUTO_TRIGGER / BOOTSTRAP_READY (TEST_ONLY_BINDING_CLAIM) / BLOCKED_TEST_BINDING**
- Offline wiring, runnable automatic entry, single-command two-phase test
  bootstrap and focused tests: complete.
- Real DSH completion → real Chrome → real ChatGPT conversation: **NOT RUN**;
  the bootstrap entry is ready but the real test still needs the user's bridge
  `allow`, an isolated test Chrome/extension harness and a dedicated ChatGPT test
  conversation, so the binding is honestly blocked.
- Four evidence layers are kept distinct: (1) bridge request completed,
  (2) route queue accepted, (3) Chrome DOM submitted, (4) Web GPT actually
  started replying. Only (1)+(2) are demonstrated offline; (3)+(4) were not
  observed and are not claimed.

Role: DSH local implementer; Web GPT independent reviewer.
Date: 2026-10-28
Worktree: `/Users/liz/.devspace/worktrees/devspace-71a9f58a`
WorkspaceId: `ws_aaa3fa66-98be-423b-8ba9-36541d8ee089`
Branch: `devspace/integration/devspace-devspace-71a9f58a`
Parent: `5d6a5ce953de3b01f2c25b3238f5a105bb56ab09` (P5)
Local P6 commit: the commit after this report (`git log -1`).
No merge/push/deploy; no production Sidecar/Chrome/DSH/Codex/OAuth/Tunnel/port,
old session `session-0645ad77…`, existing ChatGPT conversation, TriaRegna or
shared mailbox was touched.

## 1. What already existed (A)

- `RouteBridgeDelivery.ingest()` already independently re-fetches the raw bridge
  receipt, hashes it, requires exact `requestId/sessionId/rpcId=completed/
  accepted/claimed/seenUser/!truncated`, finds the exact seq, and calls
  `store.enqueueDshNotify` (`src/coach-routes/delivery.ts`).
- The Sidecar already exposes the durable route queue and `/routes/:id/next`
  (`src/managed-coach-sidecar.ts:660+`); the Chrome background
  `autoMultiPump` already polls `/next`, rebuilds the fixed wake instruction,
  verifies its digest, checks exact tab/URL/revision and submits once
  (`coach-browser-extension/auto-worker.js:100+`).
- `src/server.ts` currently constructs `ManagedCoachSidecar` **without**
  `bridgeTransport`, and R3 route principal enforcement remains fail-closed.
- Real DSH Session Bridge exposes a private loopback HTTP API:
  `GET /v1/status`, `GET /v1/sessions`, `GET /v1/requests/:id` and
  `POST /v1/messages`, authenticated by a private `auth.json` token and
  `runtime.json` loopback host/port. The CLI documents the same. No bridge CLI
  directory was modified.

Missing link: nothing invoked `RouteBridgeDelivery.ingest` from a real DSH
completion; no bridge transport/ingress existed.

## 2. Implemented offline wiring (B)

New `src/coach-routes/dsh-bridge-ingress.ts`:

- `DshBridgeHttpTransport` implements `BridgeTransport` against the real local
  bridge HTTP API:
  - reads `auth.json`/`runtime.json` with private-file checks (regular file,
    realpath, owner, mode 0600, protocol 1, host exactly `127.0.0.1`, valid
    port/pid/instance);
  - uses `node:http` directly with `agent:false`, no proxy, no redirects, bounded
    response size/time, bearer header never logged;
  - `session`, `receipt` (raw body for SHA), `request`, `wait`;
  - `send` always throws `BLOCKED_P6_ONE_WAY_NO_REPLY`; `authorizeWebGpt` false.
- `DshBridgeIngress`:
  - polls one already-issued request, never creates/re-sends a bridge request;
  - only `state === "completed"` with `accepted && claimed && seenUser &&
    !truncated` and the exact request/session/rpc identity is accepted;
  - computes SHA of the raw receipt and calls the existing
    `RouteBridgeDelivery.ingest` (no second queue, no second Chrome inserter);
  - `waitAndIngest` is a bounded observation loop; stopped/uncertain/rejected
    never enqueue and are never re-sent;
  - DSH source text remains queue `data.sourceBody`; the browser-visible
    `content` is the fixed `enqueueDshNotify` instruction and cannot be changed
    by DSH text;
  - duplicate ingest is idempotent (same deterministic messageId).

No production server wiring was enabled. A real test requires injecting this
transport into a dedicated Sidecar/test process (not the production one); this
was not done because the required test binding is absent.

## 2b. Runnable automatic entry (REWORK)

The component-only gap is closed by `src/coach-routes/p6-autotrigger.ts` and the
single-command runner `scripts/p6-dsh-autotrigger.ts`:

- `startP6AutoTrigger()` starts a **dedicated** `ManagedCoachSidecar` in the
  same process (never the production Sidecar/port), injects the real
  `DshBridgeHttpTransport`, and can start **before** the route exists for a
  two-phase test bootstrap (`--route-wait-ms`). It verifies the exact
  route/session/revision in that Sidecar's route store, then arms
  `DshBridgeIngress.waitAndIngest()` **before** the DSH request completes.
- The watcher polls the bridge request; on completion it calls the existing
  `RouteBridgeDelivery.ingest` through the Sidecar's own sink, so the message
  lands in the same durable route queue. No second queue or DOM inserter is
  created and the existing Chrome `autoMultiPump` consumes the normal
  `/routes/:id/next` response.
- It is test-only opt-in and fails closed before startup if the exact route,
  session, revision or pairing is missing; it does not fabricate a route URL,
  does not touch production and exposes no automatic DSH send/reply.
- Lifecycle: after automatic enqueue, the **same** dedicated Sidecar remains
  alive and `waitForBrowserReceipt()` polls the exact messageId until Chrome
  ACKs `dom_submitted` (or `manual_sent`/`acked`), or a bounded timeout /
  `needs_attention` fails closed. `BROWSER_DOM_SUBMITTED_UNVERIFIED` is not a
  model reply; `REAL_GPT_REPLIED` is never claimed by this harness. The process
  stops the Sidecar only after that receipt or timeout, and never retries or
  emits an ACK itself. It does not bind production ports.
- Pairing secret: no pairing bearer is accepted on argv. Optional
  `--pairing-token-file` reads a private regular file (owner/mode 0600,
  base64url 32-byte token) and never logs it; otherwise the Sidecar generates
  its own token through the normal test pairing/handoff path.

Runnable command (operator supplies the dedicated/test values):

```bash
node --import tsx scripts/p6-dsh-autotrigger.ts \
  --bridge-state-dir /Users/liz/.local/share/dsh-session-bridge \
  --workspace-root <dedicated-test-workspace> \
  --workspace-id ws_aaa3fa66-98be-423b-8ba9-36541d8ee089 \
  --route-state-dir <dedicated-test-workspace>/routes \
  --port <unused-test-port> \
  --paired-extension-id <test-extension-id> \
  --session-id <new-dedicated-dsh-session> \
  --route-id <exactly-bound-route-id> \
  --request-id <bridge-request-id> \
  --consent-revision <route-revision> \
  [--pairing-token-file <private-0600-file>] \
  [--route-wait-ms 120000] [--receipt-timeout-ms 120000]
```

The route must already be created by the normal browser/WebGPT binding flow;
the process is armed before the DSH request finishes, so no user command is
needed after completion.

## 2c. Single-command two-phase test bootstrap (BOOTSTRAP_READY)

The real-wake test is driven by one test-only entry point:
`src/coach-routes/p6-test-bootstrap.ts` (`startP6TestBootstrap()`) and
`scripts/p6-dsh-test-bootstrap.ts` (CLI, one JSON line per phase, synchronous
stdout flush so an operator can `tail -f` the log).

```
node --import tsx scripts/p6-dsh-test-bootstrap.ts \
  --bridge-state-dir /Users/liz/.local/share/dsh-session-bridge \
  --workspace-root <dedicated test workspace> \
  --workspace-id ws_aaa3fa66-98be-423b-8ba9-36541d8ee089 \
  --route-state-dir <dedicated test workspace>/routes \
  --port <unused test port> \
  --paired-extension-id <measured test extension id> \
  --pairing-token-file <private 0600 token file> \
  --session-id <new dedicated DSH session> \
  --request-id <bridge request id> \
  --route-wait-ms 900000 --request-wait-ms 900000 \
  --timeout-ms 600000 --receipt-timeout-ms 300000
```

Phases (every line carries `TEST_ONLY_BINDING_CLAIM=true`):

1. `READY_FOR_BINDING` — a DEDICATED `ManagedCoachSidecar` (its own port, route
   state dir and test event DB, real `DshBridgeHttpTransport` injected) is
   listening; no token is printed.
2. `PROPOSAL_DETECTED` — the bootstrap **observes** an unclaimed proposal that
   the *user's* test-extension click created through `POST /route/propose`
   (in-process `pendingRouteProposals()` view only; it never calls
   `store.propose`, never fabricates a route/URL/nonce).
3. `ROUTE_CLAIMED_TEST_ONLY` — `manager.claimExactBrowserRoute({workspaceId,
   dshSessionId, routeId, nonce, url})`, i.e. the exact same claim gate as the
   Web GPT MCP tool, including the Sidecar's live bridge-session `allowed`
   re-check (fail closed on a non-allowed/unknown session). **Test-only:** in
   production this claim can only be made by
   `coach_webgpt_claim_browser_route_exact`; `TEST_ONLY_BINDING_CLAIM=true` in
   every JSON line and in the final outcome.
4. `ROUTE_ACTIVE` — re-reads the Sidecar snapshot and requires active state plus
   exact workspace/session/consentRevision match.
5. `REQUEST_PRESENT` — polls the real bridge `GET /v1/requests/:requestId` until
   the request exists; it never arms before that.
6. `LISTENING` — arms `DshBridgeIngress.waitAndIngest(requestId)` and records the
   bridge request `state` at arm time as the “listen first, finish later”
   evidence.
7. `MONITOR_DONE` — only `completed` may call the existing
   `manager.ingestDshReceipt` sink (same durable route queue); the result
   reports `enqueued`/`envelope.messageId`. `stopped`/`rejected`/`uncertain`/
   `timeout`/verification failure fail closed and are never re-sent.
8. `BROWSER_RECEIPT` — the SAME Sidecar stays alive while the exported
   `waitForBrowserReceipt` waits for Chrome's delayed ACK:
   `dom_submitted` → `BROWSER_DOM_SUBMITTED_UNVERIFIED` (exit 0);
   `needs_attention`/timeout/`manual_sent`/`acked` fail closed (exit 2).
   `finally` stops only this dedicated test Sidecar.

Exit codes: `0` = `dom_submitted`; `2` = `BLOCKED_TEST_BOOTSTRAP` / `TIMEOUT` /
`NEEDS_ATTENTION` (or acked-but-unverified); `1` = internal error. Invalid or
missing CLI arguments fail closed with exit 2 before any Sidecar starts. Error
output never contains the pairing token.

Minimal additive read-only seam for step 2:
`RouteRegistry.pendingRouteProposals()` (unclaimed, unexpired proposal metadata
copies, oldest first) and `ManagedCoachSidecar.pendingRouteProposals?()` /
implementation. The method is in-process only: it is not exposed over HTTP and
is never called by the production `server.ts`.

## 3. Strict preconditions enforced (C)

- Route must be active/exact revision/workspace/session scope.
- Bridge request must exist, be exact and complete with accepted/claimed/
  seenUser/non-truncated.
- Raw receipt body is hashed by ingress and **independently re-fetched/hashed**
  by `RouteBridgeDelivery.ingest`; a changed second read is rejected.
- Text is data only; fixed wake instruction; no reply/APPROVED path.
- No retry of uncertain/stopped/rejected; no automatic DSH reply.
- R3 principal/owner MCP APIs remain enforced/fail-closed; no WebGPT owner
  identity was fabricated.

## 4. Focused tests (D)

`src/coach-routes/dsh-bridge-ingress.test.ts` — 8 checks:
1. complete trusted receipt enters the durable queue as fixed DSH_MESSAGE_NOTIFY;
2. duplicate ingest idempotent, one queue message;
3. executing/accepted/stopped/uncertain/rejected never enqueue or resend;
4. incomplete/truncated/wrong session/request/rpc/empty messages fail closed;
5. changed second receipt read rejected by independent SHA check;
6. wrong revision and revoked route reject before queueing;
7. DSH prompt/body injection cannot alter the fixed wake content;
8. test-only loopback HTTP bridge validates auth/runtime handling, sessions,
   requests, raw receipt and one-way no-reply.

A second targeted gate `src/coach-routes/p6-autotrigger.test.ts` starts a
dedicated real Sidecar HTTP instance plus a test-only loopback bridge, pre-binds
an exact route, arms the monitor, then completes the fake DSH request and
asserts the existing `/routes/:id/next` returns the fixed DSH message. It
delays Chrome's `/next` and ACK to prove the Sidecar stays alive after
automatic enqueue, checks pre-ACK timeout returns `TIMEOUT`, and checks startup
is BLOCKED when the exact route/session binding is absent. No test calls ingest
directly. Existing ingress tests cover revoked route and wrong revision before
queueing; the Chrome gate tests cover wrong tab/URL.

The third targeted gate `src/coach-routes/p6-test-bootstrap.test.ts` (new, 3
checks) exercises the full two-phase bootstrap against a real dedicated Sidecar
HTTP instance plus a test-only loopback bridge: it creates the proposal with a
real `POST /route/propose` (Bearer from the Sidecar start, test-extension
Origin) — exactly what the test-extension click does — then asserts the bootstrap
observes it, claims it through the live-allow gate, verifies the exact active
route, arms before the fake request reaches `completed` (asserted request state
at arm = `executing`), ingests into the durable queue, exposes the fixed
`DSH_MESSAGE_NOTIFY` via `/routes/:id/next` (no DSH body text leaked), and only
after a delayed `/ack outcome=dom_submitted` returns
`BROWSER_DOM_SUBMITTED_UNVERIFIED`. Negatives: no proposal → exit 2
`BLOCKED_TEST_BOOTSTRAP` (`PROPOSAL_WAIT_TIMEOUT`) with zero routes persisted;
bridge session not allowed → claim rejected fail closed
(`ROUTE_DSH_SESSION_NOT_AUTHORIZED`), zero routes persisted, listener never
armed. The test never calls `ingress.ingest` directly. A CLI fail-closed smoke
(missing/invalid args and a real 300ms no-click run) also exits 2 without
leaking the pairing token.
Command results in `docs/evidence/p6/test.log` (P6 TEST BOOTSTRAP section):
`tsc exit 0`, bootstrap 3/3 PASS, autotrigger 2/2 PASS, ingress 8/8 PASS,
CLI fail-closed smokes exit 2 as designed. Earlier sections: existing bridge
hostile/wiring/principal 13+7+15 exit 0, multiroute core 27+loopback 11 exit 0.

No fake Chrome DOM or real ChatGPT tab was used. The test-only loopback bridge
is a local test server, not the production bridge.

## 5. Real wake attempt and blockers (E)

Two-phase test bootstrap status: implemented and covered by a targeted gate;
the real binding E2E has still **NOT RUN** (no claim/queue/DOM was produced on a
real Chrome/ChatGPT conversation yet).

Bridge read-only inspection on this machine: the allowed sessions are existing
sessions (`session-098d80fb…` active; `session-0645ad77…` old sea-battle;
`session-50595251…` old PING); there is **no newly created dedicated P6 DSH test
session**. No route store/route binding exists for P6 workspace
`ws_aaa3fa66…`; no dedicated ChatGPT test conversation/test extension binding is
present. Per the task's hard gate, no real send was attempted and
`REAL_WAKE_VERIFIED` is **not claimed**.

Minimum user setup required:
1. Create a **new dedicated** DSH session (do not use existing sessions).
2. As the user, explicitly run bridge `allow <new-session-id>` (DSH bridge policy
   is user-owned; the user must do it).
3. Create a **new dedicated ChatGPT test conversation** in the test Chrome
   profile with the test Coach extension; click the exact browser binding
   (canonical URL + nonce + route revision). Do not bind the current/old
   conversation.
4. Single-command two-phase bootstrap: start `scripts/p6-dsh-test-bootstrap.ts`
   **before** clicking the test binding (see section 2c for the exact flags).
   It starts its own dedicated Sidecar; the user's test-extension click creates
   the proposal; the bootstrap observes and claims it test-only, verifies the
   exact active route, waits for the bridge request, arms before completion,
   auto-ingests into the durable queue and keeps the same Sidecar alive until
   Chrome's delayed DOM receipt. Start the DSH bridge request afterwards (or let
   it complete); no second user/Lead command is needed for enqueue+receipt.
   The pairing bearer must come from a private 0600 token file, never argv. If
   the test Sidecar cannot be paired/claimed without production access, the
   bootstrap exits 2 with `BLOCKED_TEST_BOOTSTRAP`.
5. Observe four layers separately: bridge completed, queue accepted, Chrome
   dom_submitted, Web GPT actually replying. Only the last observed layer may
   be called REAL_WAKE_VERIFIED by the independent reviewer.

## 6. Verdict / rollback

**IMPLEMENTED_OFFLINE_AUTO_TRIGGER / BOOTSTRAP_READY (TEST_ONLY_BINDING_CLAIM) /
BLOCKED_TEST_BINDING.** Offline ingress wiring, an in-process automatic trigger
and a single-command two-phase test bootstrap are complete and tested; no
production change/deploy and no real browser wake was observed because the
dedicated test session/ChatGPT/Chrome binding is not yet available. The bootstrap
does not self-certify a wake: layer 3 (`BROWSER_DOM_SUBMITTED_UNVERIFIED`) is a DOM
receipt, and layer 4 (Web GPT actually replying) can only be confirmed by the
user/independent reviewer.
Rollback: revert the P6 commit or discard this isolated worktree; no production
state exists to roll back. The P6 worktree is the only write location.
