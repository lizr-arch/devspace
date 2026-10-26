# DSH-R3 — route visibility projection and workspace-scoped authorization

Status: **READY_FOR_INDEPENDENT_REVIEW**
Role: DSH local implementer; Web GPT independent reviewer.
Date: 2026-10-26
Worktree: `/Users/liz/.devspace/worktrees/devspace-a8f30657`
Branch: `devspace/integration/devspace-devspace-a8f30657`
Baseline: `05a8f34a17c8b822b04bd61165d6f8dca6e6c57a` (R2)
Local R3 commit: the commit created immediately after this report (`git log -1`).
No push/merge/deploy; no Sidecar/Chrome/DSH session or production state was changed.

## 1. Gap 1 — snapshot response projection

R2 filtered `snapshot.routes`, `snapshot.legacy` and `pendingReviews`, but still
spread the original snapshot and therefore returned `snapshot.queues` for every
route (plus global `consentRevision` / `pendingProposals`) to an owner chat.

R3 replaces spread-plus-override with an explicit projection
(`RouteAccessController.projectSnapshot`):

- Owner: only its active routes in its exact chat/workspace; `queues` contains
  exactly those route ids; `legacy = []`; `pendingReviews` filtered to those
  routes; `consentRevision = 0` and `pendingProposals = 0` (global counters are
  not disclosed).
- Workspace-scoped operator: routes/queues/legacy/pending restricted to the
  operator workspace; global counters 0.
- Global operator (host explicitly granted no workspace scope): full snapshot,
  including all queues/legacy/pending/global counters.
- The optional `workspaceId` argument is an additional filter only; it can never
  widen the host-projected visibility.

Test `owner C sees only route C: routes, queues, legacy and counters are projected`
asserts the **complete JSON response** contains no other route/chat/legacy ids and
that `queues` keys exactly equal the visible route ids. The scoped-operator test
does the same for the intersection of two routes in one workspace.

## 2. Gap 2 — workspace-scoped operators

R2 allowed any `operator` for all operator actions. R3 enforces
`operator.workspaceId` everywhere:

| method | rule |
| --- | --- |
| `authorize` | scoped operator requires an exact target in its workspace; snapshot is allowed without target but projection filters; global counters hidden |
| `authorizeClaim` | claimed `workspaceId` must equal the scoped operator workspace |
| `visibleRoutes` | scoped operator only routes in its workspace |
| `canSeeRoute` | scoped operator only its workspace |
| `authorizeWorkspaceAction` (new) | legacy classify/migrate require a workspace target; scoped operator may only target its own workspace; owner denied; global operator requires explicit no-scope host grant |
| `projectSnapshot` | scoped operator never receives other-workspace queues/legacy/pending or global counters |

Tool handlers now use these checks:

- `coach_route_state` snapshot uses `projectRouteSnapshotForPrincipal` only.
- `classify_legacy` resolves the legacy record workspace (or explicit
  workspaceId) and calls `authorizeRouteWorkspaceAction`.
- `migrate_legacy` looks up the legacy and target routes first, rejects a
  cross-workspace target, then calls `authorizeRouteWorkspaceAction`.
- All other route/admin actions continue to authorize against the exact route
  target before any store mutation.
- No target/authority failure produces no queue/state side effect.

## 3. Tests

`src/coach-routes/route-principal.test.ts` now has **14** real in-memory MCP
invocation checks (test-only host verifier; **not** a real ChatGPT identity
proof), including two routes in one workspace, one route in a second workspace
and two legacy records:

1. missing principal denies snapshot/admin/claim with no side effect;
2. owner A snapshot only A;
3. owner B cannot read/claim A;
4. owner A own inbox works; body spoof (`principal/from/sender/chatId`) denied;
5. owner A cannot ack/resolve/revoke/trusted_reply B;
6. owner A cannot bind a route for owner B;
7. owner C sees only C; queues/legacy/counters projected; no A/B ids anywhere;
8. workspace-scoped operator A snapshot = routes/queues/legacy of workspace A only; no global counters, no route C;
9. scoped operator A denied inbox/claim/revoke/bind/classify/migrate for workspace B;
10. scoped operator A allowed inbox/classify/revoke inside its own workspace;
11. global operator sees all routes/queues/legacy and may revoke workspace B;
12. after revoke, stale owner B/C and anonymous access fail closed;
13. owner A still sees only A; `legacy` mode is explicit-only;
14. missing principal/admin and revocation no-side-effect checks.

Existing bridge hostile (13) and wiring (7) suites plus multiroute (core 27 +
loopback 11) and Chrome 142 regressions remain green.

## 4. Real test execution

Evidence: `docs/evidence/dsh-r3/tests.log` (raw command/output, SHA-256 in the
delivery message), `docs/evidence/dsh-r3/source-sha256.txt`.

| command | exit | result |
| --- | ---: | --- |
| `tsc -p tsconfig.json --noEmit` | 0 | clean |
| `npm run test:coach:bridge` | 0 | hostile 13/13, wiring 7/7, principal 14/14 |
| `npm run test:coach:multiroute` | 0 | core 27, loopback 11/11, extension |
| Chrome 3 suites | 0 | 142/142 |

No production/Sidecar/Chrome/session was contacted or restarted.

## 5. Real E2E status and residual blockers

- **BLOCKED_REAL_E2E** remains: the test "principal" comes from a test-injected
  verifier over in-memory MCP metadata. That is **not** a real ChatGPT
  conversation attestation. A real host adapter must derive the principal from an
  authenticated transport/authInfo and provide the exact chat/workspace; until
  then production keeps denying sensitive route actions by default.
- No real G01–G12 run, no deployment, no APPROVED self-signing.
- Sidecar HTTP browser/extension channel remains bearer + origin + workspace
  scope; it is not a ChatGPT-chat MCP principal and was not changed.

## 6. Boundaries / rollback

- Only `src/coach-routes/route-principal.ts`, `src/server/tools-sidecar.ts`,
  `src/managed-coach-sidecar.ts`, `src/codex-worker-ipc.ts`, `src/server.ts`,
  `package.json`, tests and R3 docs/evidence changed. R1/R2 commits and all
  `.devspace` frozen task controls/results remain untouched.
- Rollback: `git revert <R3 commit>` or remove this isolated worktree; no
  production state was created.
- Status: **READY_FOR_INDEPENDENT_REVIEW**, not APPROVED.
