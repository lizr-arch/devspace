# P5 — Chrome Coach event-scoped review receipt: security review and offline prototype

Status: **CONDITIONAL**
- **FEASIBLE_BOUNDED** for *browser-local authorization*: a paired extension
  background + paired local Sidecar can, with an explicit user binding, obtain
  and consume one server-issued challenge for one exact review event/revision.
- **NOT PROVEN / BLOCKED** for *reviewer provenance*: a browser-local receipt is
  not a cryptographic signature of the ChatGPT model's decision; DOM/user/model
  role ambiguity remains.
- **NOT RUN** for *real automated E2E*: no production Sidecar, extension,
  ChatGPT tab, DSH session or real dispatch was touched.

Role: DSH local implementer; Web GPT independent reviewer.
Date: 2026-10-28
Worktree: `/Users/liz/.devspace/worktrees/devspace-37643c54`
WorkspaceId: `ws_41d8d09a-3f9f-4f30-9d2e-1a7dd020886b`
Branch: `devspace/integration/devspace-devspace-37643c54`
Frozen parent: `734b732e67e9c1894eb6d0488e39e36ef719428a` (P4)
Local P5 commit: the commit created after this report (`git log -1`).
No push/merge/deploy, no real Sidecar/Chrome/DSH/OAuth/tunnel/port action.

## 1. Trust boundary (who is actually trusted)

### Trusted for the narrow receipt capability

- The **paired Chrome extension background/service worker** identified by
  `chrome-extension://<pairedExtensionId>` and a pairing bearer token held in
  extension session/background storage. Chrome documents that
  `chrome.storage.session` is not exposed to content scripts by default:
  <https://developer.chrome.com/docs/extensions/reference/api/storage>.
- The **paired local Sidecar** loopback transport: host `127.0.0.1:<port>`,
  origin `chrome-extension://<pairedExtensionId>`, bearer token equality, and
  exact route binding (`src/managed-coach-sidecar.ts:292-325`).
- An **explicit user click** in one exact tab/canonical URL, recorded by the
  existing browser claim/route machinery (nonce, exact tab, chat URL,
  route revision; `src/coach-routes/registry.ts` propose/claimExact;
  `src/managed-coach-sidecar.ts` claim browser route).
- The server-issued high-entropy challenge and the exact route revision/event
  identity bound to it.

### Untrusted

- The ChatGPT **page DOM** and any assistant/user text; a website can render
  anything and the model can be asked to output any string.
- **Content scripts** as security principals. Chrome's messaging security
  guidance treats content-script messages as low trust:
  <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>.
  This repo's background listeners currently ignore `_sender`
  (`coach-browser-extension/auto-worker.js:839`,
  `coach-browser-extension/worker.js:174`); a real implementation must check
  `sender.tab.id` against the bound exact tab and reject content-script
  authority for verdicts.
- **MCP `_meta`, routeId, eventId, nonce, URL, chatId, sender/from** as
  standalone authorization. `_meta["openai/session"]` is client-provided
  metadata per OpenAI's developer reference and is not a signed credential;
  P4/R3 already keep MCP owner route APIs fail-closed without a trusted host
  principal.
- **DSH prompt/body text**; it may be attacker-influenced and is never an
  instruction to the receipt layer.

### Out of scope (recorded, not mitigated)

- Attacker with local root/admin, a compromised extension install/update, or
  control of Chrome itself can forge the local browser context. This design
  reduces accidental/spoofed-message risk, not endpoint compromise.
- A malicious/compromised paired Sidecar is outside the browser receipt's
  authority.

## 2. Why "reviewer provenance" is not the same as browser-local authorization

The receipt only proves: **the paired background transport submitted this fixed
event/revision observation through the paired local Sidecar**. It does not prove:

- that the text came from the assistant rather than the user or injected DOM;
- that a model actually reviewed the evidence;
- that the decision was not steered by a malicious DSH prompt or page script.

The prototype therefore sets `provenance: "BROWSER_LOCAL_UNVERIFIED"`,
`reviewerVerified: false`, `browserAuthorized: true`, and
`requiresUserDispatchAuthorization: true`. No receipt can trigger an automatic
DSH send or APPROVED execution by itself. A separate, explicit user-authorized
dispatch step and (for automation) a future trustworthy reviewer-provenance
mechanism are required.

Reading the assistant reply from the page is deliberately **not** implemented:
the current extension's privacy contract does not grant page chat scraping. If a
future variant reads assistant text, the narrowest data (one reply text or
structured decision) would require separate explicit user consent, a visible
control, and a refusal/degradation path; it still would not become a
cryptographic model signature.

## 3. Threat analysis

| Attack | Result in the prototype | Notes |
| --- | --- | --- |
| Attacker holds routeId/eventId/nonce text | denied without extension-background context | routeId/nonce are not identity; page-data alone cannot submit |
| Same OAuth credential, another GPT conversation | denied by trusted-background transport/context; MCP owner route APIs remain R3 deny | OAuth client does not prove chat; this receipt does not either |
| Wrong tab / URL / workspace / session / event / message / evidence / decision | `CHALLENGE_MISMATCH` | exact binding fields validated |
| Revoked route / newer consent revision | `ROUTE_UNAVAILABLE` / `REVISION_STALE` | checked at issue and consume |
| Expired challenge | `CHALLENGE_EXPIRED` | max TTL 120s |
| Two concurrent claims/challenges for one event revision | first consumed, second `EVENT_ALREADY_REVIEWED` | event key route+revision+eventId |
| Repeated submit same payload | idempotent duplicate result, no second effect | retained receipt for ACK-loss retry |
| Repeated submit different payload/idempotency | `CHALLENGE_ALREADY_CONSUMED` | no second receipt |
| Content script fabricates verdict | `EXTENSION_UNAUTHORIZED` | background context cannot be constructed from page |
| DSH text/prompt injection | fields fixed; injected body ignored; receipt remains non-authoritative | no automatic dispatch |
| Assistant/user role confusion | `reviewerVerified:false`, `requiresUserDispatchAuthorization:true` | provenance is explicitly unverified |
| Extension update/restart | in-memory prototype loses challenges; new authority rejects old challenge | fail-closed, not restart-safe |
| ACK loss before/after external send | prototype has no external send; duplicate retry is idempotent, but durable cross-process consume is **not** implemented | requires a transactional local journal before real use |
| Crash/restart | state loss => old challenge rejected; no replay accepted | durable design required |

## 4. Bounded protocol (prototype)

`src/coach-routes/event-receipt.ts` (new, pure logic, not wired to production):

- `issueChallenge(trustedBackground, {binding, decision, idempotencyKey})`:
  validates extension id/pairing token, exact binding (routeId, consentRevision,
  eventId, messageId, evidenceSha256, workspaceId, dshSessionId, exact tabId,
  canonical chat URL), decision enum, idempotency key, active route/revision;
  returns a server-issued 256-bit random challenge/nonce with TTL.
- `submitReceipt(trustedBackground, submission)`: exact tuple check, TTL,
  one-time consume, event-revision single review, idempotent exact retry,
  conflicting retry denied; returns a receipt with unverified provenance.
- No method dispatches to DSH, sends Codex/Chrome messages, or grants MCP owner
  authority. Production wiring is intentionally absent.

## 5. What a production implementation would still need (not done)

1. Add a Sidecar endpoint and extension background flow that carries the
   challenge/receipt using the existing loopback origin + pairing bearer; verify
   `sender.tab.id` equals the bound exact tab and never expose the token to
   content scripts/prompts.
2. Replace in-memory maps with a transactional durable journal (SQLite in the
   Sidecar state dir) for crash-safe one-time consume/ACK reconciliation; test
   real process restart, not just a new in-memory instance.
3. A visible user gesture/consent to issue the challenge for one event; explicit
   refusal/revocation; challenge display/debug must not leak credentials.
4. If assistant reply reading is desired: separate explicit user permission for
   the narrowest page data, DOM role ambiguity handling, and a hard rule that
   even a verified receipt does not auto-execute an APPROVED dispatch.
5. Real E2E with two dedicated ChatGPT test conversations and two new dedicated
   DSH test sessions, exact tab binding, three unattended rounds; not attempted
   here and still requires explicit user authorization.

## 6. Tests (offline, actual exits)

Prototype test file: `src/coach-routes/event-receipt.test.ts` — 12 checks:
positive receipt; forged contexts; routeId knowledge; field mutations; revoked/
stale revision; expired/unknown challenge; idempotent duplicate vs conflicting
replay; concurrent event review; content-script fake; DSH/body injection;
restart/non-durability fail-closed; strict enum/canonical URL.

| command | exit | result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | TypeScript clean |
| `node --import tsx src/coach-routes/event-receipt.test.ts` | 0 | 12/12 PASS |
| `npm run test:coach:bridge` | 0 | hostile 13 + wiring 7 + principal 15; route behavior unchanged |
| `npm run test:coach:multiroute` | 0 | core 27 + loopback 11 + extension; unchanged |

Raw log: `docs/evidence/p5/test.log`. No Sidecar/Chrome/MCP server/DSH session
was started; no real ChatGPT tab or model was accessed.

## 7. Acceptance gates for any future real rollout

- G-P5-01: challenge binds exact route/revision/event/message/evidence/workspace/
  session/tab/URL; any mismatch denies.
- G-P5-02: high-entropy server challenge, bounded TTL, one-time consume, event
  revision single review; concurrent/replay/different-payload denied.
- G-P5-03: extension background transport only (paired id + loopback origin +
  bearer; exact `sender.tab.id`); content script/page/MCP cannot submit.
- G-P5-04: revoked/rebound route and stale session deny before any external
  action.
- G-P5-05: durable transactional journal survives process restart and ACK loss;
  no blind resend.
- G-P5-06: receipt remains `reviewerVerified:false`; no automatic DSH dispatch,
  no automatic APPROVED execution; separate user authorization required.
- G-P5-07: real E2E only after user creates/binds two dedicated test
  conversations/sessions; no old conversation or production Sidecar touched.

## 8. Verdict / remaining blockers

**CONDITIONAL**: browser-local event authorization is feasible and bounded under
the prototype contract; reviewer provenance is unverified, durable cross-process
consume and production wiring are not implemented, and real automated E2E is
**NOT RUN**. No merge/deploy is implied. R3/P4 worktrees and frozen evidence are
unchanged; no production OAuth/tunnel/Chrome/Sidecar/DSH state was altered.

Rollback: revert the P5 local commit or discard this isolated worktree; nothing
to roll back in production.
