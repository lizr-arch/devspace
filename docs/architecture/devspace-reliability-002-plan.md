# DEVSPACE-RELIABILITY-002 implementation plan and status

Baseline checked 2026-10-14 on isolated feature branch `feat/devspace-reliability-002`, rebased onto source `main` at `ca21f2da2b573dae16a8829542e30a96566b617d`. Source checkout and its untracked `.devspace/` were not modified.

## Baseline facts

- Before this change, the API process owned `NativeCodexAgentRunner` records and Guardian owner pipes; an API exit therefore terminated Codex. Coach Feed's HTTP listener and token were also owned by API memory.
- Native runs and evidence already had SQLite persistence and operation fingerprints, but live child handles and events were not independently owned across API lifetime.
- The production API was healthy on loopback with stateless sessions active 0 and capacity evictions 0. Coach was API-owned at baseline. No native Codex run was active when inspected. Historical R4 remains untouched and was not used as a fixture.
- Source `main` was ahead of `origin/main` by three local commits during inspection. No production process or unrelated worktree was changed.

## Design implemented

1. A per-user Worker Supervisor owns Codex runner and Guardian lifetimes. `devspace codex-worker` serves bounded JSON RPC over a mode-0600 Unix socket protected by a mode-0600 random secret file; state directory is mode 0700. It checks process UID/start identity, one active Worker lease, monotonically increasing fencing generations, registered workspace identity, canonical allowed roots, and operation workspace scope.
2. Worker SQLite journal records operation fingerprint, Worker ID/generation, heartbeat/cursor, Guardian PID/PGID/UID/start identity, cancellation state, result, and Evidence. Same operation ID and fingerprint is idempotent; mismatched fingerprints fail. Unknown work is never replayed. Worker takeover waits for prior Guardian process groups to be proven gone; uncertainty blocks takeover. This is fail-closed quarantine, not Guardian reattachment.
3. Coach Feed runs inside the Worker process, outside API lifetime. Workspace, extension ID, port, and exact observation scope persist in SQLite. Pairing token is separate in a mode-0600 file and is omitted from status and logs. Worker start restores the same token/scope only after current Workspace authorization; Worker and Coach consequently share one process failure domain.
4. Native observer events persist in bounded SQLite with monotonic cursor and explicit gap/reset semantics.
5. MCP diagnostics use a bounded in-memory ring with request/trace correlation, stage, tool, operation ID, status/error class, and latency summary. Doctor probe records preserve available server correlation headers and sanitized errors. Failed POST requests are not resent through the fallback path.

## Validation so far

- `npm run typecheck` and `npm run build` passed; the build emitted an existing large frontend chunk warning.
- Private UDS Worker and Coach lifecycle test passed on macOS: lease generation/fencing, duplicate Worker rejection, one Coach listener, extension Origin rejection, API control-client close, same-token/same-scope Worker restart recovery.
- Observer persistence/cursor, runner idempotency/evidence, Coach realtime, doctor probe metadata/non-replay, and MCP bounded diagnostics tests passed.
- `node --import tsx src/doctor.test.ts` passed after updating stale tool inventory assertions to current main (82 tools including `coach_realtime_status`). The local external-client simulation runs 100 sequential and 20 concurrent calls.
- A full `npm test` run reached `doctor.test.ts` and failed only on the stale tool inventory assertion. After updating both stale assertions, `doctor.test.ts` passed alone. The entire unit suite has not yet been rerun to completion.
- Browser automation initialization timed out; real Chrome extension access remains unverified.

## Remaining gates

- Completed in isolated E2E: real Codex CLI file-changing tasks survived normal API restart and API `SIGKILL`; operation IDs, Guardian identities, cursors, Evidence SHA, and one-write outputs were checked.
- Completed in isolated E2E: Worker `SIGKILL` closed its Guardian owner pipe, the process group was verified gone, replacement generation 2 kept the result `INTERRUPTED / unknown_outcome_no_automatic_replay`, and no retry write occurred.
- Still inject Guardian/PID reuse, explicit cancellation, response loss, and API admission/drain races against real processes.
- Add/validate Worker launchd install, rollback, and API `SERVING`/`DRAINING`/`RESTARTING` integration before any deployment.
- Test standalone Coach crash/reconnect and the real browser extension. Coach was proven to survive API restart/`SIGKILL` and recover after Worker restart with the same token/scope; browser access remains unverified.
- Inject connector timeout, client abort, response-write failure, and completed-task/lost-response. Run public Cloudflare calls with 100 sequential and 20 bounded concurrent requests; distinguish server processing time from connector end-to-end time.
- Finish the E01–E16 matrix and bounded resource soak; rerun full unit/MCP suites; integrate, commit, push with remote SHA verification, build from production checkout, and deploy only after safety gates pass.

## Deployment safety

No Worker/Coach installation, production build replacement, API restart, push, or merge has occurred. Deployment must inventory legacy API-owned Guardians first and refuse to proceed if task ownership is unknown. Only the isolated test workspace may be used for destructive failure injection. R4 and unknown `.devspace/` files remain outside the test scope.
