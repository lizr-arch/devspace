# DEVSPACE-RELIABILITY-002 validation

Status: **PARTIAL / NOT ACCEPTED**. No production deployment, push, or full reliability PASS is claimed. Updated 2026-10-14 (Asia/Shanghai).

## Baseline and safety

- Work is on isolated branch `feat/devspace-reliability-002` in `/Users/liz/agy/devspace-reliability-002`, rebased on source `main` at `ca21f2da2b573dae16a8829542e30a96566b617d`. Development files are uncommitted. The original checkout and its untracked `.devspace/` were not modified.
- Source production checkout was read-only inspected: local `main` is three commits ahead of `origin/main`; do not push directly from this feature branch until safe integration and remote verification.
- Current production API was healthy at `127.0.0.1:7676/healthz`, Boot ID `e7ddcf4b-1b53-4bda-9384-42a202908172`, stateless sessions active 0 / capacity evictions 0. Production Coach still shared the API PID; no production service changes were made.
- The live task inventory showed no RUNNING native Codex rows at inspection. Historical R4 remains interrupted and was not read, changed, replayed, or used as a test fixture. No unrelated process was signalled.
- Browser automation initialization timed out. No claim of Chrome extension or ChatGPT Web UI verification is made.

## Implemented in the feature branch

### M1 Worker

- Added a separate `devspace codex-worker` service and a private mode-0600 Unix socket with a random mode-0600 key, bounded JSON framing, same-UID process identity, single-instance lease, monotonic SQLite generation fencing, heartbeat, and operation/workspace checks.
- Worker start validates the registered workspace against canonicalized allowed roots. Status, stop, recommendation, and queued configuration are workspace-checked. Stop is fenced by the requested workspace.
- SQLite persists worker identity/generation, operation fingerprint, lease heartbeat/cursor, Guardian identity, result/evidence, and cancellation state. Same ID/same fingerprint is idempotent; conflicting fingerprint is rejected; unknown side effects are never replayed.
- Worker restart only proceeds when the prior Worker is proven dead and all prior active Guardian process groups are verified gone. Missing, live, or uncertain Guardian identity fails closed. Guardian still owns its child process group and closes that group when the Worker owner pipe disappears.
- API can connect through `DEVSPACE_CODEX_WORKER_SOCKET`; API-side control client close does not stop the independent Worker. Native observer events persist in SQLite with bounded retention and cursor gap/reset semantics.
- Real private UDS, normal API restart, API `SIGKILL`, real Worker `SIGKILL`, and restart recovery passed in the same isolated end-to-end harness. Worker crash closes Guardian's owner pipe; the Guardian process group was verified gone. Replacement Worker acquired generation 2 and quarantined the operation as `INTERRUPTED / unknown_outcome_no_automatic_replay`; same-ID start did not spawn a second Guardian or write the requested file.
- **Not yet verified:** separate production Worker launchd installation, all remaining E01–E16 fault injections, and production activation.

### M2 Coach

- Coach Feed control is routed to the independent Worker when configured. Worker persists workspace, port, paired extension ID, and observer scope; the bearer token is stored separately in a mode-0600 file and never appears in status/config/log output.
- Worker startup restores the same token and scope and refuses authorization if the saved workspace no longer matches current allowed roots. MCP start/stop/status remain the control surface.
- Loopback Coach health/event HTTP checks passed in both the UDS test and real API process E2E. Coach remained available through normal API restart and API `SIGKILL`; it also recovered after Worker crash/restart with the same protected token and exact saved scope. A simulated port collision was reported as `COACH_FEED_PORT_IN_USE`; after freeing the port, bounded retry restored the same Coach instance. No-token and forged-Origin requests were rejected.
- **Not yet verified:** installed launchd service and Chrome extension in a real browser; browser automation initialization timed out.

### M3 Diagnostics

- Added a bounded in-memory MCP diagnostic ring (512 records) and `/monitor/api` summary with request/trace IDs, method, RPC ID, tool, operation ID, a stable one-way workspace reference, stages, coarse error class, status, and p50/p95/p99 processing time. The summary labels success as server-observed and explicitly marks Connector receipt `not_observable`. Response headers return request/trace IDs; raw MCP body/error text is excluded from wire logs.
- Doctor probes now retain sample ID, local timestamps/duration, HTTP status, server correlation headers, response presence, and bounded sanitized errors. Failed POST is no longer retried by a fallback GET/JSON helper.
- `src/doctor.test.ts` completed successfully after aligning two stale current-main tool inventory assertions. Its local OAuth/MCP external-client probe includes 100 sequential session reuse calls and 20 concurrent calls.
- **Not yet verified:** injected client abort, failed response write, tool timeout, completed operation with lost client response, public Cloudflare connector 100+20 run, external wrapper error payload availability. Because the connector is outside this repo, caller receipt cannot be proven from server success alone. Diagnostic history is process-local and bounded, not a durable journal.

## Test/build evidence

Executed in the isolated feature checkout:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS after current Worker permission and Guardian recovery checks |
| `npm run build` | PASS; existing large front-end chunk warning remains |
| `npm run test:codex-worker` | PASS, including private UDS, generation fencing, Coach persistence, and SQLite cursor migration |
| `node --import tsx src/codex-agent-runner.test.ts` | PASS, including durable operation identity and review persistence |
| `node --import tsx src/coach-realtime.integration.test.ts` | PASS |
| `npm run test:mcp-diagnostics` | PASS |
| `npm run test:doctor-diagnostics` | PASS: probe metadata, error retention, failed POST sent once |
| `npm run test:coach:observer` | PASS, including browser-extension logic tests (not a real browser session) |
| `node --import tsx src/doctor.test.ts` | PASS after correcting current-main tool inventory expectations; local public-client simulation includes 100 sequential + 20 concurrent calls |
| `DEVSPACE_RUN_REAL_E2E=1 node --import tsx src/codex-worker-api-restart.real.test.ts` | PASS in isolated `/private/tmp/dsr2-*` workspaces. Real Codex tasks survived normal API restart and controlled API `SIGKILL`; a third task was interrupted by controlled Worker `SIGKILL`, its Guardian group was reaped, and generation 2 quarantined without replay. Coach survived API restarts and recovered after Worker restart. |
| `npm test` | **FAILED at first run** due to the stale 78-tool expectation (current main exposes 82); that assertion and a missing `coach_realtime_status` read-only expectation were corrected and `doctor.test.ts` rerun successfully. The full `npm test` command has not yet been rerun to completion. |

Real Codex/API/Worker evidence (full JSON in `reports/reliability-002/real-codex-api-restart.json`): Worker PID `58754` stayed constant while API PID `58756` restarted to `58761` (new Boot ID); a second task survived API PID `58761` being forcibly terminated and API PID `58825` restarting. Both completed with exactly one expected file write and Evidence SHA-256; their cursors advanced 2→20 and 20→41. Guardian identities were unchanged across API restarts. A third task was active when Worker PID `58754` received `SIGKILL`; its Guardian process group verified `gone`. Worker PID `58915` acquired generation 2, Coach recovered, and the task remained `INTERRUPTED / unknown_outcome_no_automatic_replay` without creating its requested file. This proves the tested local normal/abnormal API and Worker recovery contracts; public Cloudflare behavior remains unverified.

No Cloudflare public test, deployment, push, production build from the deploy checkout, or 10–15 minute soak has been performed.

## Gate status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| `WORKER_LIFECYCLE_PASS` | PASS (local E2E) | Two real Codex tasks survived normal API restart and controlled API `SIGKILL`; new API queried old IDs, event cursor, and Evidence. |
| `WORKER_RECOVERY_PASS` | PASS (local E2E) | Real Worker `SIGKILL` reaped the Guardian process group; replacement generation quarantined outcome as uncertain and did not replay. |
| `COACH_LIFECYCLE_PASS` | PASS (service E2E) | Coach stayed online during API normal/forced restart and recovered after Worker restart with same token/scope; Chrome browser extension and launchd install remain pending. |
| `CONNECTOR_DIAGNOSTICS_PASS` | PARTIAL | Local stages/probe context tested; network and injected write/abort failures/public connector pending |
| `OPERATION_IDEMPOTENCY_PASS` | PASS (tested behavior) | Real MCP same-ID/same-request retry did not duplicate the task; same ID with a different prompt returned an operation conflict. Completed-result recovery after a lost response remains to be injected. |
| `RECOVERY_E2E_PASS` | NOT PASS | E01–E16 full fault matrix pending |
| `PROCESS_SECURITY_PASS` | PARTIAL | UDS key, allowed root, PID identity and fail-closed checks implemented/tested; real crash/reuse tests pending |
| `GIT_PUSH_VERIFIED` | NOT PASS | No commit or push yet |
| `PRODUCTION_BUILD_PASS` | NOT PASS | Feature build passed; no production deployment checkout build |
| `SERVICE_RESTART_VERIFIED` | NOT PASS | No production restart |
| `MCP_PUBLIC_E2E_PASS` | NOT PASS | Cloudflare public connector run pending |
| `WEB_UI_VERIFICATION` | PENDING | Browser automation initialization timed out; no Web UI claim |
| `RELIABILITY_002_COMPLETE` | NOT PASS | Required end-to-end and deployment gates remain open |
