# DSH-R2 — per-route principal authorization (P1 rework)

Status: **READY_FOR_INDEPENDENT_REVIEW**
Role: DSH local implementer; Web GPT remains the independent reviewer.
Date: 2026-10-26
Worktree: `/Users/liz/.devspace/worktrees/devspace-a8f30657`
Branch: `devspace/integration/devspace-devspace-a8f30657`
Baseline: `efee92d755135af09762ddbf248981853cc05d65` (R1)
Local R2 commit: the commit created immediately after this report (`git log -1`).
No push, merge, deploy, Sidecar/Chrome/session restart or real E2E was performed.

## 1. Reviewed gaps and chosen fix

Web GPT's R2 findings are accepted as real authorization gaps:

1. `coach_route_state` snapshot returned every route/pending review without a
   trusted caller identity; `inbox` trusted caller-supplied `routeId`.
2. `coach_route_admin` `requireRoute()` only compared an optional `workspaceId`,
   not the calling conversation principal; `revoke`/`migrate_legacy` executed
   before any route check. Random route IDs are not an authorization mechanism
   because snapshot could enumerate them.
3. The host verifier existed only for `trusted_reply`; ordinary route tools did
   not use it.
4. `DSH_MESSAGE_NOTIFY.sourceBody` is retained in the route queue/inbox; any
   cross-conversation MCP read could expose it.

Fix: a fail-closed **per-route access controller** with a host-injected
principal verifier, enforced on both read and write route tools. The principal
is derived only from trusted MCP invocation context (`extra`: authInfo/session
metadata supplied by the host transport); all tool arguments (`chatId`, `url`,
`workspaceId`, `routeId`, `from`, `sender`, `nonce`) remain untrusted data.

## 2. Modes and production default

| mode | behavior | use |
| --- | --- | --- |
| `enforced` | every sensitive action requires a host-verified principal; no verifier => **deny all** | production server (`src/server.ts`) and worker-side Sidecar (`src/codex-worker-ipc.ts`) |
| `legacy` | no principal required; pre-existing V1 behavior | direct local/test instances only; **never** a live ChatGPT/MCP transport |

`ManagedCoachSidecar` defaults to `legacy` so existing direct-construction tests
and V1 consumers remain source-compatible, but both production construction
sites explicitly call `configureRouteAccess({mode:"enforced"})`. The remote
`CodexWorkerCoachClient` rejects all route authorization calls
(`ROUTE_PRINCIPAL_UNAVAILABLE`) instead of forwarding an unverified caller.

Host contract (injectable today, real adapter not yet available):

```ts
type RoutePrincipal =
  | { kind: "owner"; chatId: string; workspaceId?: string }
  | { kind: "operator"; workspaceId?: string };
type RoutePrincipalVerifier =
  (context: unknown, target?: RouteTarget) => Promise<RoutePrincipal | undefined> | RoutePrincipal | undefined;
```

`context` is the MCP handler's invocation metadata (`extra`). A real host must
populate it from an authenticated transport (e.g. MCP `authInfo` / a trusted
session binding), not from tool arguments. When no trusted chat-origin metadata
can be produced, the verifier returns `undefined` and sensitive actions fail
closed; the implementation does not fabricate a ChatGPT conversation identity.

## 3. Action-by-action authorization matrix

`owner` = verified exact ChatGPT conversation whose `chatId` equals the route's
`chatId` (and workspace, if the principal includes one). `operator` = explicit
host-granted admin. `anonymous` = no verified principal.

| surface/action | owner (own route only) | operator | anonymous | notes |
| --- | --- | --- | --- | --- |
| `coach_route_state` snapshot | ALLOW, route list + pendingReviews filtered to own chat/workspace; legacy list hidden | ALLOW, all routes/legacy/pending | DENY | enforced default; no verifier => deny |
| `coach_route_state` inbox | ALLOW only exact owned active route; sourceBody only here | ALLOW | DENY | cross-route/cross-chat denied before read |
| `coach_route_state` classify_legacy | DENY | ALLOW | DENY | legacy administration |
| `coach_route_admin` enqueue_wake | DENY | ALLOW | DENY | DSH trusted ingest uses local adapter, not owner chat |
| `coach_route_admin` reply (legacy) | DENY | ALLOW | DENY | legacy compatibility path is operator-only |
| `coach_route_admin` trusted_reply | ALLOW exact owned active route | ALLOW | DENY | additionally requires bridge receipt/principal verifier |
| `coach_route_admin` claim_delivery | DENY | ALLOW | DENY | browser uses bearer-scoped HTTP, not chat MCP |
| `coach_route_admin` ack / resolve | DENY | ALLOW | DENY | state mutation |
| `coach_route_admin` revoke | DENY | ALLOW | DENY | route required before authorize; no side effect on denial |
| `coach_route_admin` migrate_legacy | DENY | ALLOW | DENY | legacy administration |
| `coach_webgpt_claim_browser_route` | ALLOW only if verified `chatId` equals claimed canonical URL chat | ALLOW | DENY | URL/chat body cannot grant itself |
| `coach_webgpt_claim_browser_route_exact` | ALLOW only if verified `chatId` equals claimed URL; exact route/revision checks unchanged | ALLOW | DENY | denial creates no route |
| Sidecar HTTP `/routes...` | n/a (no MCP chat principal) | paired-extension bearer token + origin + workspace scope | DENY | existing browser/operator channel retained; not a ChatGPT-chat authorization |

All authorization happens **before** the store operation; denials produce no
queue/state side effect. `snapshot` visibility is filtered for owners
(`RouteAccessController.visibleRoutes`): only `active` routes with the owner's
`chatId` (and workspace) and only their pending review wakes. Operators see all,
including revoked/legacy records.

## 4. Code anchors

- `src/coach-routes/route-principal.ts` — `RouteAccessController`,
  `authorize`, `authorizeClaim`, `visibleRoutes`, owner/operator action sets,
  `ROUTE_PRINCIPAL_REQUIRED|FORBIDDEN|INVALID` fail-closed errors.
- `src/coach-routes/protocol.ts` — route principal error codes.
- `src/managed-coach-sidecar.ts` — host wiring point
  `configureRouteAccess`, `authorizeRouteAction`, `authorizeRouteClaim`,
  `visibleRoutesForPrincipal`; `ManagedCoachSidecarControl` interface.
- `src/server/tools-sidecar.ts` — `coach_route_state` snapshot/inbox/
  classify_legacy and every `coach_route_admin` action now await authorization;
  both browser-claim tools verify the claimed chat against the verified owner.
- `src/server.ts` — production server sets `{mode:"enforced"}` (no verifier =>
  deny until host adapter is supplied).
- `src/codex-worker-ipc.ts` — worker-owned Sidecar sets enforced; the remote
  `CodexWorkerCoachClient` fails closed rather than proxying principals.
- `src/coach-routes/route-principal.test.ts` — real in-memory MCP invocation
  tests with A/B owners and an explicit operator.

## 5. Hostile / real-MCP tests

`src/coach-routes/route-principal.test.ts` (real MCP InMemoryTransport, actual
`registerSidecarTools`, test-only host verifier; NOT a live ChatGPT E2E):

1. enforced, no principal => snapshot/admin/claim denied and no route id leaked; denied admin/claim has no side effect.
2. owner A sees only its own route and pending review (single workspace, two chats).
3. owner B cannot read A's inbox or claim A's messages; A's wake remains intact.
4. owner A can read its own inbox; tool-body spoof (`principal`, `from`,
   `sender`, `chatId`) is denied.
5. owner A cannot ack/resolve/revoke/trusted_reply route B; B remains active.
6. owner A cannot claim/bind a new route for owner B; no route is created;
   missing principal is denied.
7. explicit operator sees both routes and may revoke B.
8. after operator revoke, stale owner B and anonymous access fail closed.
9. owner A still sees only A after B revoke; `legacy` is explicit-only.
10. missing principal denies admin/claim actions before any store mutation.

Existing R1 hostile/wiring suites continue to cover sender spoof, forged
`from=dsh`, torn receipts, replay/conflict, ACK loss, crash/SIGKILL, concurrent
adapters, exact-session dispatch and frame corruption.

## 6. Real test run (this environment)

Evidence: `docs/evidence/dsh-r2/tests.log` (raw command/output, SHA-256 in the
delivery message). Commands and actual exit codes:

| command | exit | observed |
| --- | ---: | --- |
| `tsc -p tsconfig.json --noEmit` | 0 | clean |
| `npm run test:coach:bridge` | 0 | hostile 13/13, wiring 7/7, principal 10/10 |
| `npm run test:coach:multiroute` | 0 | core 27, integration/loopback 11/11, extension suite |
| Chrome 3 suites (`node --test …`) | 0 | 142/142 |

No unrelated long regression suite was rerun. No production/Sidecar/Chrome
instance was started, restarted, or contacted.

## 7. Residual blocks and next step

- **BLOCKED_REAL_E2E**: no real authenticated MCP transport/authInfo →
  ChatGPT conversation-id adapter exists in this workspace; the host verifier is
  an injectable contract only. Until that adapter is implemented and explicitly
  authorized, production route actions deny by default. No claim is made that
  the current ChatGPT conversation has been reliably identified.
- Browser Sidecar HTTP remains protected by the paired-extension bearer token,
  origin checks and workspace scope; it is a separate operator/browser channel,
  not per-ChatGPT-chat MCP identity.
- Real G01–G12 remain NOT RUN. Independent Web GPT review is required.

Verdict: **READY_FOR_INDEPENDENT_REVIEW**, not APPROVED.

## 8. Rollback

- Revert the single R2 local commit on this isolated branch, or remove this
  worktree after review.
- R1 commit/evidence and the frozen `.devspace` task controls are untouched.
- No production state exists to roll back because no deployment/restart occurred.
