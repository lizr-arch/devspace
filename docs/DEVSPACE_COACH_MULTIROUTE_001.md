# DevSpace Coach exact multi-route isolation (TR-DSH-MULTIROUTE-AND-NAVAL-001, I1/I2 candidate)

Status: **CANDIDATE / NOT DEPLOYED**. Produced in an isolated git worktree
`/Users/liz/.devspace/worktrees/devspace-multiroute-001`; nothing here has been
installed into the production Chrome profile, launchd coach Sidecar, DevSpace
main worktree or any DSH bridge allowlist. Real Chrome E2E, extension reload,
Sidecar launchd restart and route-scope changes are
`BLOCKED_PENDING_MAINTENANCE_WINDOW` until the user grants a maintenance window.

## Problem

The pre-existing coach path could only bind **one route per workspace**: the
Chrome extension stored `workspaceId -> {url, tabId}` and the Sidecar's
`/bind/start` + `coach_webgpt_claim_browser_route(workspaceId, nonce, url)`
challenge proved a workspace but not an exact DSH session. Two DSH sessions in
the same workspace would collide or be indistinguishable.

## Contract (frozen in code + tests)

1. **Unguessable route identity** — `routeId = "rt_" + base64url(32 random bytes)`
   (256-bit). Never derived from workspace/session/tab/URL. A browser one-click
   asks the Sidecar for a short-lived proposal (10 min TTL, bounded count); only
   an independent Web GPT MCP claim may attach it to real authority.
2. **Exact binding** — one active route stores
   `workspaceId + dshSessionId + canonicalChatUrl + chatId + exactTabId +
   consentRevision + claimNonceSha256`. The raw one-time nonce is never
   persisted or logged.
3. **One chat = one route** — a chat URL can own at most one active route; the
   same rule applies to `(workspaceId, dshSessionId)` and to one exact browser
   tab. Switching requires an explicit revoke or an explicit
   `replaceRouteId + expectedConsentRevision` rebind. There is no silent
   rebinding, no guessing, and no scope expansion without the one-click + MCP
   claim pair.
4. **Same workspace, many sessions** — multiple active routes may share one
   workspace, each with its own queue, cursor and ACK journal.
5. **Durable per-route queue** — under `<stateDir>/routes/<routeId>/`:
   - `queue.blocks` — append-only `BEGIN 1 <len>` / payload / `END <sha256>`
     frames; a torn tail is never read as a message and is truncated only when
     the journal is next opened.
   - `state.blocks` — append-only delivery/ACK transition journal.
   - `cursor.json` — atomic (`tmp` + `fsync` + `rename` + dir `fsync`) cursor
     cache; always rebuilt from the durable journals, never trusted alone.
6. **Envelope** — `routeId, workspaceId, dshSessionId, chatId, messageId, seq,
   contentSha256, kind, origination, state, createdAt, updatedAt, content,
   data`. `seq` is per route and contiguous. `contentSha256` binds the exact
   UTF-8 content.
7. **Dedupe / conflict** — the same `(routeId, messageId)` with the same
   content is idempotent; a different payload fails closed with
   `ROUTE_PAYLOAD_CONFLICT`. ACKs bind `(messageId, seq, contentSha256)` and any
   conflicting terminal ACK fails closed.
8. **At-least-once, no blind duplicate submit** — a delivery claim leases a
   message; an expired lease is re-claimable, but a browser-reported
   `dom_submitted` / `manual_sent` / `acked` is terminal. Ambiguous or
   user-obstructed outcomes (`uncertain`, `timeout`, `existing_draft`,
   `page_busy`, `navigation_mismatch`) become `needs_attention` and require an
   explicit operator `retry` / `mark_sent`.
9. **`dom_submitted` is NOT a completed review** — a `dom_submitted_unverified`
   wake stays in `pendingReviewWakes()` until a tracked GPT reply message
   (`origination=webgpt`, `data.inReplyTo=<wake messageId>`) is enqueued.
10. **Two directions** — `origination=dsh` carries only the fixed review-wake
    instruction, built locally from the identity tuple; `origination=webgpt`
    carries GPT reply text as message data for DSH. The Chrome gate rebuilds the
    wake from `(routeId, messageId, eventId, operationId, workspaceId)` and
    rejects any wake whose wire `content` differs, any `instruction`/`body`/
    `command` field, and any non-`REVIEW_WAKE`/non-`dsh` message.
11. **Legacy compatibility** — old workspace-only browser routes are imported
    passively as `legacy` records and are always `UNROUTABLE`
    (`LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION`). Explicit
    migration requires the same workspace **and** the same canonical chat URL;
    history is never replayed. The old
    `coach_webgpt_claim_browser_route(workspaceId, nonce, url)` tool and
    `/bind/start` challenge keep their original semantics byte-for-byte.
12. **No secrets in state/log/transport** — route audit records carry a nonce
    hash only; durable files and Sidecar responses never contain the bearer
    token. Responses can never be poisoned with authentication material.

## Files

| File | Role |
| --- | --- |
| `src/coach-multiroute.ts` | Transport-free core: identity, registry, framed durable queue, cursor, ACK, legacy migration, audit redaction. |
| `src/coach-multiroute.test.ts` | 27 offline core checks (A-02/A-03). |
| `src/coach-multiroute.integration.test.ts` | 11 loopback HTTP + MCP in-memory checks against a real temporary Sidecar. |
| `coach-browser-extension/multiroute-gate.js` | Pure Chrome gate: identity validation, frozen wake template, delivery decisions, outcome/review classification. |
| `src/coach-multiroute-extension.test.cjs` | 11 gate + wiring checks. |
| `src/managed-coach-sidecar.ts` | Additive exact-route API: `/route/propose`, `/route/status`, `/routes`, `/routes/<id>/next`, `/routes/<id>/ack|resolve|revoke`, `/routes/legacy/import`; manager methods for MCP tools; per-start `authorizedDshSessionIds` consent. |
| `src/server/tools-sidecar.ts` | `coach_webgpt_claim_browser_route_exact` (write), `coach_route_state` (read-only), `coach_route_admin` (write). |
| `src/server/server-helpers.ts`, `src/server/server-types.ts` | Tool exposure / capability / schema revision registration. |
| `coach-browser-extension/worker.js`, `auto-worker.js` | Additive multi-route layer loaded only when `DevSpaceRouteGate` exists; legacy `coachAutoRoutes` flow untouched when no exact route is stored. |
| `coach-browser-extension/package.json` | `{"type":"commonjs"}` so Node tests can require the classic gate script (Chrome ignores it). |

## Operating model (when deployed, after a maintenance window)

1. Start the coach Sidecar with explicit `authorizedDshSessionIds` (bounded 1–8,
   `session-<uuid>` exact ids). Without it, exact claims fail closed with
   `ROUTE_DSH_SESSION_NOT_AUTHORIZED`; already-bound durable routes keep working.
2. In each ChatGPT tab, the user clicks the extension once. The extension asks
   `/route/propose` (routeId + nonce + canonical URL + exact tab id) and sends a
   fixed binding request into that conversation.
3. Web GPT calls `coach_webgpt_claim_browser_route_exact` with the exact
   `routeId/dshSessionId/nonce/url/workspaceId`. Success creates the single
   active route for that chat.
4. The extension pulls queued wakes with
   `GET /routes/<routeId>/next?origination=dsh` and reports outcomes with
   `POST /routes/<routeId>/ack`; DSH consumes GPT replies from the same route
   queue through `coach_route_state` / `coach_route_admin`.
5. Unbind = explicit revoke (`COACH_AUTO_UNBIND` with `routeId`, or
   `coach_route_admin{action:"revoke"}`). Rebinding requires a fresh one-click
   challenge plus `replaceRouteId + expectedConsentRevision`.

## Deployment / rollback (maintenance window required)

Not performed in this candidate. Isolation properties already in place:

- Worktree: `/Users/liz/.devspace/worktrees/devspace-multiroute-001`, branch
  `feature/dsh-multiroute-20261026-010730`, based on `1fa5cf9`.
- The dirty `/Users/liz/agy/devspace` worktree (another agent's 12
  coach-browser-extension WIP files) was never modified; only `git diff` /
  `git show` / `git worktree` read commands were used.
- No push, merge, clean, reset, stash, Sidecar restart, Chrome reload, launchd
  change or global `MAILBOX.md`/old-watcher change.
- Route durable state defaults next to the coach event database
  (`<stateDir>/coach-routes`), mode `0700` dirs / `0600` files, and is created
  only when the exact-route feature is first used.

Rollback: stop the candidate Sidecar, redeploy the previous `dist`/extension
version, and delete the `coach-routes` state directory (it is additive and is
not referenced by the old code). No production database schema was changed;
`coach_feed_config` schema is unchanged (`authorizedDshSessionIds` is per-start
consent only, never persisted, so a supervisor restart fails exact claims closed
instead of silently re-authorizing sessions).

## Known gaps / next steps

- Real Chrome two-tab / two-DSH-session E2E, extension reload, launchd Sidecar
  restart: `BLOCKED_PENDING_MAINTENANCE_WINDOW`.
- `authorizedDshSessionIds` is not persisted through a Sidecar supervisor
  restart (deliberate fail-closed choice); persisting it needs an explicit
  consent record and is left to the deployment review.
- The extension popup/panel UI is untouched (another agent's WIP owns those
  files); the exact-route flow is driven through the existing one-click path and
  can be surfaced in the popup in a follow-up without changing the contract.
- Cross-process single-writer protection relies on the existing one-manager
  Sidecar model; route state is not designed for two Sidecars sharing a
  `coach-routes` directory.
