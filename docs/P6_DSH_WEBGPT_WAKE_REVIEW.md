# P6 — DSH completion → exact Web GPT conversation wake (one-way)

Status: **IMPLEMENTED_OFFLINE / BLOCKED_TEST_BINDING**
- Offline wiring and focused tests: complete.
- Real DSH completion → real Chrome → real ChatGPT conversation: **NOT RUN**;
  test binding prerequisites are absent.
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

Command results are in `docs/evidence/p6/test.log`:
`tsc exit 0`, ingress 8/8 PASS, existing bridge hostile/wiring/principal
13+7+15 exit 0, multiroute core 27+loopback 11 exit 0.

No fake Chrome DOM or real ChatGPT tab was used. The test-only loopback bridge
is a local test server, not the production bridge.

## 5. Real wake attempt and blockers (E)

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
4. Provide the resulting routeId/revision and a bridge requestId for that new
   session, then run the P6 ingress against a dedicated Sidecar/test state (not
   production). Only after a request is actually completed, accepted, claimed,
   seenUser and non-truncated will the queue accept one fixed wake.
5. Observe four layers separately: bridge completed, queue accepted, Chrome
   dom_submitted, Web GPT actually replying. Only the last observed layer may
   be called REAL_WAKE_VERIFIED by the independent reviewer.

## 6. Verdict / rollback

**IMPLEMENTED_OFFLINE / BLOCKED_TEST_BINDING.** Offline ingress wiring is
complete and tested; no production change/deploy; no real browser wake observed.
Rollback: revert the P6 commit or discard this isolated worktree; no production
state exists to roll back. The P6 worktree is the only write location.
