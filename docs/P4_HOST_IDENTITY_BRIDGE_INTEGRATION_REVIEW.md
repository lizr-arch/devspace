# P4 — ChatGPT session identity and automatic DSH loop integration

Status: **BLOCKED_USER_BINDING** (Stage A security premise fails; P2 offline fix delivered; no real E2E)
Role: DSH local implementer; Web GPT independent reviewer.
Date: 2026-10-26
Worktree: `/Users/liz/.devspace/worktrees/devspace-f4fe618a`
WorkspaceId: `ws_098beee0-a3c0-410d-a8f1-5e4c485f45f3`
Branch: `devspace/integration/devspace-devspace-f4fe618a`
Baseline: `63420a139accaaed7e1395400489cce2d9fd828b` (R3)
Local P4 commit: the commit created after this report (`git log -1`).
No push/merge/deploy; no production Sidecar/Chrome/DSH session, OAuth/tunnel/port
or old conversation was touched.

## 1. Stage A — what the host can actually prove

### 1.1 MCP invocation metadata available today

- `src/server.ts:303-311` wraps `/mcp` with `requireBearerAuth({verifier: oauthProvider, ...})`.
- `src/oauth-provider.ts:293-305` `verifyAccessToken` returns `AuthInfo` with
  `token`, `clientId`, `scopes`, `expiresAt`, `resource`. There is **no user id
  and no ChatGPT conversation id** in this record.
- MCP SDK `streamableHttp.js:131,137` reads `req.auth` and passes it into tool
  handlers as `extra.authInfo`; the latest MCP SDK therefore does deliver
  authenticated **OAuth client** metadata, but not conversation identity.
- `src/server.ts:612-626` additionally validates the OAuth resource; it does not
  establish a chat identity.
- `node_modules/@modelcontextprotocol/sdk/.../server/auth/types.d.ts` confirms
  `AuthInfo` has only token/clientId/scopes/expiresAt/resource.

### 1.2 Why `extra.sessionId` is not a conversation identity

`src/server/express-routes.ts:685,765` calls
`transport.handleRequest(req, res, req.body)`. In stateful mode the MCP SDK
returns a server-generated transport session id; in stateless mode
(`src/server/express-routes.ts:690`) there is no session id at all. A transport
session identifies an MCP connection, not a ChatGPT conversation, and the same
connector/token can serve multiple conversations. It is not a per-conversation
attestation.

### 1.3 `_meta["openai/session"]`

Per the OpenAI developer reference
(`https://developers.openai.com/plugins/reference`), `_meta["openai/session"]`
is **client-provided metadata** for anonymous ChatGPT sessions (2026-01 update).
It is not a signed credential and is explicitly unsuitable for granting owner or
operator authority. Tool arguments and client `_meta` are untrusted data in this
repository.

### 1.4 Browser/Coach binding

The existing exact-route flow (`src/coach-routes/registry.ts` propose/claimExact,
`src/managed-coach-sidecar.ts` claimExactBrowserRoute) does provide:

- a one-time browser nonce and exact canonical ChatGPT URL;
- an exact tab/chat/workspace/DSH session route with consent revision;
- explicit revoke/rebind revisions.

It proves a **human clicked a binding for that canonical URL**, and the route id
is unguessable. It does **not** prove that a later MCP `tools/call` came from
that conversation: bearer tokens are shared by the connector and no
per-conversation authenticated field exists. Making the route id the only
barrier would be a capability, not a verified conversation identity, and would
still allow a different conversation holding the route id to act as the owner.

### 1.5 Conclusion

The Stage A premise required for safe automatic owner authorization — a
trustworthy, unforgeable per-conversation identity from the current host/MCP
path — **does not hold**. The only safe production behavior remains the R3
enforced mode: no trusted principal verifier → sensitive route actions deny.
Per the task instruction, Stage B was stopped rather than implementing an
ineffective `_meta`/chatId/URL substitute. No new DSH/Chrome transport binding
was added, and no automatic round-trip was attempted.

## 2. Delivered code (only the non-blocking P2 fix)

`src/coach-routes/route-principal.ts` `projectSnapshot()` now compares a pending
review's workspace only when the verified owner principal actually carries a
`workspaceId`:

```ts
: (principal.workspaceId === undefined || wake.workspaceId === principal.workspaceId);
```

This fixes the R3 review's P2: a host that can provide only the exact chat id no
longer loses its own `pendingReviews`. A regression was added to
`src/coach-routes/route-principal.test.ts`:
`owner with chatId only still sees its own pendingReviews (no workspaceId P2 regression)`.
Offline principal tests grew from 14 to **15**.

No change was made to `src/coach-routes/delivery.ts`, `BridgeTransport`,
production OAuth, Sidecar/Chrome, or route authorization defaults.

## 3. Tests (real exits in this environment)

Evidence: `docs/evidence/p4/tests.log` (raw), `docs/evidence/p4/source-sha256.txt`.

| command | exit | result |
| --- | ---: | --- |
| `tsc -p tsconfig.json --noEmit` | 0 | clean |
| `npm run test:coach:bridge` | 0 | hostile 13/13, wiring 7/7, principal 15/15 |
| `npm run test:coach:multiroute` | 0 | core 27, loopback 11, extension |
| Chrome 3 suites | 0 | 142/142 |

The test principal is still a test-injected verifier over in-memory MCP metadata
(`_meta.testPrincipal` in tests only); it is **not** real ChatGPT identity and
must never be used in production.

## 4. Blockers and minimum user operations

Blocker: **BLOCKED_USER_BINDING / BLOCKED_REAL_E2E** — the host provides no
authenticated per-conversation identity, so an automatic owner principal cannot
be established without spoofable substitutes. The minimum safe path requires a
future host capability: an authenticated, per-conversation attestation from the
ChatGPT client/MCP transport (signed/opaque and verifiable by DevSpace), plus a
one-time user-click browser binding to that attested conversation. Until then:

1. A user must create/bind two dedicated ChatGPT test conversations and two new
   dedicated DSH test sessions (do not use old session-0645… or the active
   Web GPT conversation).
2. A host adapter must map the authenticated attestation to the canonical chat /
   route revision and be verified against the real transport.
3. Only then can G01–G12 and three unattended rounds be attempted; real E2E is
   currently NOT RUN and not claimed.

## 5. Boundaries / rollback

- Only the P2 fix, its regression, this report and `docs/evidence/p4/` were
  changed; R3 worktree `devspace-a8f30657` and all R1–R3 evidence are frozen.
- No deployment/restart/merge/push; no OAuth/tunnel/port/session change.
- Rollback: `git revert <P4 commit>` or discard this isolated worktree; no
  production state exists to roll back.

Status: **BLOCKED_USER_BINDING** — independent Web GPT review required; not
APPROVED.
