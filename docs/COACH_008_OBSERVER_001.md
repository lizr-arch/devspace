# COACH-008 / OBSERVER-001 — Isolated Agent Observer implementation
Date: 2026-10-12
## User purpose and visible entry
Chrome MV3 COACH extension gains a button “打开 Agent 观察面板” in its existing popup; user clicks to open Chrome side panel next to ChatGPT Web. This panel is entirely extension-owned. It does NOT inject scripts or read ChatGPT page DOM, and ordinary ChatGPT mobile conversations do NOT get an embedded live stream.
The panel polls every 1.5 seconds while open. It shows up to 8 recent Codex task identities + last authoritative state, up to 120 recent tool/lifecycle event records, pause/resume without terminating an agent, online/offline/unpaired, gap notices and a cursor-reset notice on DevSpace restart.

## Actual data path
- Existing DevSpace native `CodexAgentRunner` parses authorized `codex exec --json` stdout in-process. Only a whitelist of native event types is accepted for the observer.
- `AgentObserverStore`: memory-only redacted, monotonically sequenced events, maximum 2048 events and 32 workspaces. No raw prompt, model reasoning, command string/arguments, stdout/stderr, secret, token, path or full diff is forwarded. Counts and lifecycle categories are allowed.
- `ManagedCoachSidecar` read-only `GET /agent/events?cursor=N`: same localhost 127.0.0.1 port, exact Host check, paired extension Origin/CORS, session Bearer token; rejects other query names/invalid cursor and all write methods. **Default observer admin scope is disabled**. The sidecar must be started with explicit MCP parameter `adminObserverScope="all_native_worktrees"` and a paired extension ID to enable cross-worktree read-only observation of this same DevSpace instance; preexisting v0.2 pairing tokens get HTTP 403. Scope disclosure is visible in the popup. No external Codex sessions are discovered.
- The extension service worker alone holds session-scoped token, performs authenticated localhost requests, and returns normalized JSON to the panel. No remote fetch, page scripting or shell-control endpoint.

## Verified gates (isolated branch; not production)
- `npm run test:coach:observer` exit 0: **10 tests**, including real Codex JSONL whitelist/secret-injection fixtures (runner uses same projection), store bounds, loopback HTTP with default admin DENY and explicit admin ALLOW, wrong origin/host/token/path/query/method, cross-worktree cursor behavior and restart reset, existing extension pairing tests, and a browser-sidepanel DOM simulation covering terminal/gap/offline/reconnect.
- `npm run typecheck` exit 0.
- `npm run test:coach:mac` exit 0: existing Mac COACH regression suite including five-cycle review logic.
- Final P1-remediation test evidence is held by DevSpace TaskRunner sessions: observer tests `task_55a936cd-135a-4b8d-9f22-97c85347973c`; typecheck `task_9475840a-5791-4572-b9c2-3d5483ed46d2`; regression `task_be9e4c4b-5ee7-44e3-92a5-62ef7aed3ab6`. All exited 0. Local test-only symlink and ignored task manifest were then removed from this isolated worktree.
- No actual Chrome browser visual E2E or deployed sidecar/extension pairing test was executed. Manual browser acceptance remains required before a release claim.
- Initial developer agent completed with immutable evidence; a second local development Codex run encountered `CODEX_EVIDENCE_SENSITIVE_PATH` when unrelated local test scaffolding under `.devspace` was included in its source-evidence snapshot. This was a review-evidence safety fail (not a passing review). Scaffolding removed after direct test verification; see separate independent review.
- No claim of independent security-review approval or production release.

## Hard boundaries
No main merge/push; no production restart; no changes to working `/Users/liz/agy/devspace` or the running COACH v0.2 service (8765); no COACH-007 branch changes.
No capture of arbitrary external terminal Codex sessions: ONLY Codex launched through this DevSpace instance's native runner.
No persistence of event history across server restarts: cursor epoch reset prevents a stuck panel but previously lost events cannot be reconstructed.
Privacy by suppression: “command” category deliberately does NOT show the command arguments/output; “file-change” category deliberately does NOT expose file paths or Git diff. Git diff remains available separately through authorized DevSpace review tools.

## Release gates still open
1. A second independent source/security review after the R1 REWORK_REQUIRED findings; the R1 report remains at `docs/review/COACH_008_OBSERVER_INDEPENDENT_20261012.md`. Review cross-worktree admin opt-in, native JSONL fixture mapping and gap reset fixes.
2. Chrome GUI side panel actual installation, open, visible real Codex event, stop, reconnect and multi-worktree acceptance on the user's paired browser.
3. Explicit upgrade/deployment approval before production service restart and re-pairing.
