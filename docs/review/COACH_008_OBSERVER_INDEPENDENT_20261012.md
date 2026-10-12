# COACH-008 / Agent Observer MVP — independent review

Date: 2026-10-12  
Reviewer: independent Codex security/product review thread  
Verdict: **REWORK_REQUIRED**

This review inspected the actual worktree diff and untracked source. I did not rerun tests, start DevSpace, pair an extension, or use real Chrome. The review is therefore evidence from source and existing tests only; it is not a self-approval or a browser acceptance report.

## What is substantively implemented

- `NativeCodexAgentRunner.execute` uses `codex exec --json` and parses one JSON object per stdout line (`src/codex-agent-runner.ts:393-467`). Observer emission is allowlisted to `thread.started`, `turn.started/completed/failed`, and `item.started/updated/completed`; arbitrary event names and raw payload fields are not forwarded (`:421-434`). Prompts, stdout/stderr, reasoning, command strings/arguments, and paths are not copied into observer fields. The authoritative runner result is emitted in `finally` after evidence/journal finalization (`:572-597`), which is the correct lifecycle source for the terminal state.
- The implementation does not observe arbitrary local Codex processes. It observes only native Codex runs launched by this DevSpace server (`src/server.ts:329-343`, `src/codex-agent-runner.ts:487-489`). This is an important product limitation: the requested real-time local-CLI observation is currently “DevSpace-native Codex runs only,” not external CLI sessions.
- `AgentObserverStore` is memory-only and bounded (`src/agent-observer.ts:6-19`): 2,048 global events, 32 workspace buckets, monotonic cursors, field allowlisting, gap reporting, and restart reset (`:21-40`). The sidecar binds to `127.0.0.1`, checks the exact Host, bearer token, paired extension Origin, method, query, and cursor (`src/managed-coach-sidecar.ts:126-148`). The extension uses session storage for the token and text-only DOM rendering (`coach-browser-extension/worker.js:51-66`, `coach-browser-extension/panel.js:6-24`).
- Popup-to-side-panel wiring exists (`coach-browser-extension/manifest.json:5-22`, `popup.html:23`, `popup.js:50`) and the panel tracks operation keys as `workspaceId + operationId`, including terminal `runner.finalized` states (`panel.js:25-42`). Untrusted response values are rendered via `textContent`, not HTML.

## Release blockers and prioritized fixes

### P1 — cross-workspace authorization is broader than the pairing model

`GET /agent/events` calls `observer.readGlobal(cursor)` and returns events for every workspace in the same server (`src/managed-coach-sidecar.ts:138-148`; `src/agent-observer.ts:28-34`). The token is issued by a sidecar started with one `workspaceId` (`managed-coach-sidecar.ts:61-114`), but there is no explicit admin permission, user confirmation, workspace filter, or response disclosure that the token is an aggregated cross-worktree feed. The integration test treats cross-workspace visibility as expected (`src/agent-observer.integration.test.ts:26-61`), but does not establish that this is an acceptable authorization contract.

Choose and document one contract before release: (a) make the endpoint per-workspace and enforce the paired workspace, or (b) make it explicitly admin-aggregated with an explicit pairing/consent surface and tests proving that all workspaces visible to the server are intentionally in scope. As written, a token obtained for one workspace silently reveals operation identities/statuses from sibling worktrees.

### P1 — parser contract is not tested at the observer boundary

The runner’s existing tests cover completion/failure/timeout behavior, but the new observer injection is not exercised by `src/codex-agent-runner.test.ts`; the new observer tests only inject already-sanitized events directly (`src/agent-observer.test.ts:4-7`, `src/agent-observer.integration.test.ts:26-31`). There is no test proving that top-level command/prompt/reasoning-like events, unknown item types, malicious nested fields, malformed JSON, split UTF-8 lines, `error`, or item lifecycle events produce exactly the intended observer output and never leak content. Also, `type === "error"` is handled in the classification branches (`codex-agent-runner.ts:427-433`) but is excluded by the preceding allowlist regex (`:424`), so that branch is unreachable. Add fixture-driven parser tests with assertions on exact emitted events and exact absence of raw content.

### P1 — browser resync behavior is incomplete for a detected gap

The panel reports `gap`, but on a gap it does not resync task state or request a fresh baseline; it simply advances its cursor and retains the existing task map (`coach-browser-extension/panel.js:29-42`). After enough event churn, a task can disappear from the bounded server history while the panel continues displaying stale last-known status. Define the intended gap behavior (clear and show “history incomplete,” or provide a server-side snapshot) and test it. Restart reset is handled, but only at the in-memory feed level (`agent-observer.ts:31-34`), not as a complete UI-state acceptance test.

### P2 — real Chrome/MV3 behavior remains unverified

The source wiring is plausible, but no evidence here verifies that `chrome.sidePanel.open({windowId: chrome.windows.WINDOW_ID_CURRENT})` succeeds from this popup in the target Chrome version, that the permission/manifest is accepted, or that a real panel receives and displays a live event. Existing browser tests inspect manifest/pairing behavior (`src/coach-browser-extension.test.cjs:43-85`) but do not load the extension, invoke the popup, exercise the side panel, or inject hostile feed JSON. Perform a real Chrome test for open, pair, multiple simultaneous operations, completion/failure/timeout, reconnect, cursor gap, restart reset, and unpair.

### P2 — lifecycle semantics need a tighter product schema

The observer emits `item.*completed` as `COMPLETED` (`codex-agent-runner.ts:431-433`), while the UI correctly treats only `runner.finalized` as authoritative (`panel.js:34-37`). That distinction is implicit rather than represented in a typed protocol. Publish/test a schema that marks item completion as nonterminal and runner finalization as terminal; otherwise a future client may incorrectly show an item completion as task success.

## Security and reliability assessment

Authentication is materially strong for the narrow local bridge: random 32-byte bearer token, timing-safe comparison, exact loopback bind/Host check, paired extension Origin/CORS, read-only GET route, no-store response, bounded response count, and no token in the panel DOM. The server also limits request/header timeouts and rejects unsupported methods (`managed-coach-sidecar.ts:93-99`, `:126-148`). The panel’s `textContent` rendering avoids HTML/script injection even if a compromised local endpoint returns markup-like strings.

Memory bounds and cursor arithmetic are generally sound. The store handles truncation with `gap`, caps page size at 100, and detects a cursor from a newer server generation (`agent-observer.ts:21-40`). However, history is intentionally lost on restart and there is no durable snapshot/replay; this must remain explicit product behavior. Node’s synchronous in-process map operations avoid ordinary shared-memory races, while runner timeout/kill and final emission are guarded by the existing promise/cleanup flow (`codex-agent-runner.ts:509-523`, `:572-598`). Concurrency coverage does not prove observer behavior for simultaneous real runs or sidecar start/stop races.

## Coverage and production decision

The added tests cover store bounds/redaction, loopback auth/Host/Origin/query/method checks, cross-workspace aggregation, cursor gaps, and restart reset (`src/agent-observer.test.ts`, `src/agent-observer.integration.test.ts`). They do not cover the actual runner-to-observer parser path, extension panel execution, malicious normalized payloads, multi-operation UI transitions, or real Chrome. I did not execute the package script, so the documentation’s claimed test result is not independently verified in this review.

The v0.2 production service and existing production extension were not changed by this review, and no production restart/deploy/merge/push/commit was performed. Release of this observer feature remains blocked until the cross-workspace authorization contract, parser tests, gap resync semantics, and real Chrome acceptance are completed. The feature may be suitable for an isolated engineering MVP after those risks are explicitly accepted, but the evidence available here does not support `ACCEPTED_FOR_ISOLATED_MVP`.
