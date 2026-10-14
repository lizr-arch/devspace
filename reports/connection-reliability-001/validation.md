# Connection Reliability 001 validation record

Observed 2026-10-14 (UTC). This records the current evidence and the deployment gate; it does not certify a completed production rollout.

## M0 production baseline

- Service: launchd label `com.liz.devspace`, plist `~/Library/LaunchAgents/com.liz.devspace.plist`, running `/Users/liz/agy/devspace/dist/cli.js serve` on port 7676. Cloudflare tunnel label `com.liz.cloudflared-devspace` was active.
- Effective transport before remediation: `stateful` from `~/.devspace/config.json`; `DEVSPACE_MCP_TRANSPORT_MODE` was unset in the launchd environment. The environment variable overrides the JSON setting.
- Pre-switch public snapshot: 64/64 active sessions, 622 capacity evictions, 97 unknown-session requests, 32 in-flight requests, 824 cumulative initializations, and 864 MiB heap used. Historical project notes showed higher heap values, but were not treated as this audit's measurements.
- Request/initialize churn is directly supported by the counters and logs. `request aborted` was also observed, but its initiator (ChatGPT, Cloudflare/network, or another client) is unknown. The earlier SIGKILL exit was observed; OOM causality is not established.

## Changes and verification

- Persisted `mcpTransportMode=stateless`. No launchd environment override was present. The 300-second TTL and 64-session cap were not changed.
- Added `get_agent_efficiency_audit` to the exposed read-only tool catalog and schema fingerprint. Fixed the doctor assertion to compare public model tools against the `devspace_info` catalog while accounting for app-only tools. Added stateful and stateless 100 sequential + 20 concurrent external-client probe coverage.
- Changed the default `godot_import` wait from 240 seconds to 1 second. The import remains a background job and can be queried using `wait_job` / `poll_job`; an explicit caller wait remains supported.
- `npm run typecheck`, focused session/operation/job recovery/Godot tests, `npm run test:mcp`, Gemini catalog test, Coach Mac test, and `npm run build` passed. The build retains the existing large frontend chunk warning.
- The doctor test against an isolated local server passed in both stateful and stateless modes, including 100 sequential + 20 concurrent calls. Production `doctor --public --full-loop` was run before the catalog fix and failed its catalog contract as expected from the defect; it was not rerun against the new build because the service has not been safely restarted.
- Real DevSpaceMac Cloudflare Connector calls succeeded against the stateless production instance. Bounded public probe: 100 calls in ten batches of ten returned 98 successes and 2 errors (the tool result did not expose enough detail to attribute these; cause `UNKNOWN`); a further 20 concurrent calls returned 20 successes. Successful-call latency was about 3.0 seconds p50 / 6.0 seconds p95 for the batched sequential phase and 3.8 seconds p95 for the concurrent phase. These include Connector overhead, not just server handling time.
- Across the public probe, production reported 0 retained/active sessions, 0 capacity evictions, 0 unknown-session requests, and 0 in-flight requests at the final sample. `statelessRequests` reached 1,044. Heap used was 97 MiB before and 98 MiB after the 100+20 probe; RSS varied from 173 MiB to 511 MiB during the observation window. Request monitor p95 was 67 ms in a separate sample, with no recent errors/timeouts. The difference between server and Connector latency remains unexplained.

## Git and deployment gate

- Task branch: `fix/devspace-connection-reliability-001`.
- Source changes were committed and pushed without force. The task branch was fast-forward integrated with the then-current `origin/main`; main was pushed successfully. Integration included 12 existing local-main commits and the two remote-main commits that were missing from the initial checkout, in addition to this task's changes.
- Production `npm run build` passed from the integrated checkout. Build output is at the service's configured project path.
- A safe restart was not performed. Before restart, the service had an active Codex run in another workspace (`tria-mapv1-batch-a-m0m1-r3-sol61-high-20261014-04`, state `RUNNING`; recent native events observed) with a guardian process owned by the DevSpace server, plus live Godot scene processes parented to the DevSpace PID. Stopping the service would risk terminating another user's work. `/monitor/api` did not list these native child processes as active Jobs. They were left untouched.
- Therefore the current process still has the prior running build/schema, although its effective MCP transport is stateless. A new PID/Boot ID, loaded new schema, post-restart OAuth/Workspace checks, 10–15 minute post-restart soak, and ChatGPT Web UI verification remain pending. Web UI verification is `WEB_UI_VERIFICATION_PENDING`.

## Acceptance status at observation time

| Gate | Status |
|---|---|
| Code changes | PASS |
| Automated/local integration tests | PASS |
| Git commit and push | PASS |
| Production build | PASS |
| Stateless public Connector verification | PARTIAL (118/120 successful in the recorded 100+20 probe) |
| Restart with new build | BLOCKED by active external Codex/Godot processes |
| Post-restart recovery and soak | PENDING |
| ChatGPT Web UI | `WEB_UI_VERIFICATION_PENDING` |
| `RELIABILITY_001_COMPLETE` | NOT PASS |

## R2 follow-up (2026-10-14)

- The protected R3 operation completed naturally at `2026-10-14T05:59:07.416Z`, exit code 0. Native status and immutable evidence were read; evidence SHA-256: `525b8a647ddc4e36d54ad5634a8e649e6cac4e936f928e91635340354b3601f0`.
- A later run in that same geoterrain workspace began before deployment: `tria-mapv1-batch-a-m0m1-r4-sol61-high-20261014-05`, state `RUNNING`, guardian PID/PGID `46313`, Codex child PID `46316`. It emitted native events during this audit. No part of that run was stopped.
- DevSpace Job monitor reported `active=0`; no Godot/Houdini process was present in the final inventory. The DevSpace coach feed was still running for workspace `ws_9adc027a-b6e2-4003-8e5c-31c1e8840ed4`; Chrome PID 806 had an established localhost TCP connection to port 8765. It was left intact. Therefore restarting the HTTP/MCP process was not safe.
- Probe failure diagnostics: the original 118/120 result did not retain per-call timestamps, request IDs, or error payloads, so those two calls cannot be joined to specific server log entries. In the surrounding 05:25–05:50Z server logs, all recorded OpenAI HTTP POSTs were 200, recorded `tools/call` responses were 200, and 141 `list_workspaces` tool executions were successful. No failed `list_workspaces` tool call or failed OpenAI POST was logged. There were separate unauthenticated `DELETE /mcp` requests from user-agent category `other` (401); the logs do not link them to the two probe failures. Two raw-body `request aborted` stacks have no request ID and no reliable timestamp correlation to the probe. The two failures remain `UNKNOWN`; the available evidence does not establish a DevSpace tool execution defect or identify a network/client cause.
- The source at `ba213bd3c56b833b153e1776f8b8eda9e59791c1` was rebuilt successfully. The currently running process remains PID 7240 / Boot ID `995360e9-23e4-4e69-9f33-d710f4ddd5fe` with the old schema revision. The new revision suffix `+agent-efficiency-audit-v1` is present in the built artifact but has not been loaded by the production process.
- No automatic deployment watcher was installed: without a server-side admission/drain gate, a local check followed by restart has a race with newly arriving task starts, and a long-lived active coach connection would be interrupted. The independent lifecycle design is recorded in `docs/architecture/guardian-lifecycle-decoupling.md`.

## R2 production deployment and post-restart acceptance (2026-10-14 UTC)

- The operator explicitly authorized restart while the R4 Codex Guardian was still active. Before restart, the live process tree was captured: service PID 7240; Guardian PID/PGID 46313; Codex wrapper 46315; Codex native child 46316; code-mode-host 46628. No Godot task or managed Job was observed. The R4 run was never manually stopped or replayed.
- `main` and `origin/main` were both `c3812f87c6bf059e9ed13e4b2330b5894cae92f8` before deployment. Production artifact `dist/cli.js` SHA-256: `c2bb0b6a2a85088c1370613bcff6a840e13737a3033e76f7eab618ea5c288109`. LaunchAgent `com.liz.devspace` was restarted using local `launchctl`; `com.liz.cloudflared-devspace` remained running.
- The new process was independently verified through the public health endpoint and authenticated DevSpaceMac Connector: PID 47264; Boot ID `99416852-c3dc-4c70-822d-4542def7e67c` (prior Boot ID `995360e9-23e4-4e69-9f33-d710f4ddd5fe`). It loaded schema suffix `+agent-efficiency-audit-v1`, fingerprint `41693af30fe8fbc016408dd21377f1750d31ea6fe7e54fb8ef1f85c21ed5f4c9`, and 79 tools. `mcpTransportMode=stateless` remained effective; no launchd environment override was set. OAuth-authenticated Connector calls, `devspace_info`, and audited workspace listing succeeded.
- Post-restart persisted recovery: R3 (`tria-mapv1-batch-a-m0m1-r3-sol61-high-20261014-04`) completion metadata remained queryable with exit code 0 and the same evidence SHA `525b8a647ddc4e36d54ad5634a8e649e6cac4e936f928e91635340354b3601f0`. R4 (`tria-mapv1-batch-a-m0m1-r4-sol61-high-20261014-05`) transitioned to `INTERRUPTED`, reason `unknown_outcome_no_automatic_replay`; its workspace remains quarantined. No task session or completed evidence was available for R4. We did not clear quarantine or replay the run. Thus completed-result recovery is verified, but recovery of the active R4 execution is not.
- The Coach feed that was running before restart now reports stopped. This confirms the HTTP/MCP restart interrupts that in-process sidecar. The independent Guardian/HTTP lifecycle decoupling design remains recorded in `docs/architecture/guardian-lifecycle-decoupling.md`; no runtime refactor was included.
- A 100-call authenticated public Connector batch completed with 91 tool results not marked as errors and 9 marked as errors by the connector wrapper. The wrapper did not preserve those nine error payloads or request IDs. In DevSpace logs across the post-restart run, 582 HTTP requests were recorded (388 status 200 and 194 status 202); MCP methods included 194 initialize, 194 initialized notifications, 193 tools/call, and one resources/read. Server-side handling p50/p95 was 25/112 ms, max 10,758 ms. The matching connector-call error IDs and stages cannot be reconstructed; those nine failures remain `UNKNOWN`, not attributed to Cloudflare, ChatGPT, or DevSpace.
- The public 100-call wrapper latency sample was p50 3,784 ms, p95 10,409 ms, max 101,236 ms. Twelve subsequent sequential authenticated Connector calls all returned successfully; their wall time ranged 2.7–19.8 seconds, including host overhead. The previous 118/120 sample still has no saved per-call IDs/payloads; its two errors remain uncorrelated.
- During more than 11 minutes after restart, the public MCP counters remained at zero active/created/high-water sessions, capacity evictions, unknown-session requests, and in-flight requests. Stateless request count reached 794. Heap samples fluctuated 74–260 MiB (260 MiB was early post-start/concurrent load; later samples 74–101 MiB); RSS fluctuated 72–195 MiB in later samples. This bounded observation does not establish long-term memory behavior, but showed no monotonic heap growth. The tunnel remained loaded and public requests succeeded.
- Build, source tests, focused recovery/idempotency tests, local MCP stateless/stateful tests, and prior pre-deployment checks are recorded above; they were not all rerun during R2. ChatGPT Web UI page-level verification was not performed: `WEB_UI_VERIFICATION_PENDING`.

## Final gate status

| Gate | Result | Evidence / limitation |
|---|---|---|
| `SERVICE_RESTART_VERIFIED` | PASS | PID 47264, new Boot ID, schema fingerprint, 79 tools |
| `MCP_PUBLIC_E2E_PASS` | PARTIAL | Authenticated public calls and 91/100 clean batch results; 9 wrapper errors lack IDs/payloads |
| `RECOVERY_VERIFIED` | PARTIAL | R3 persisted result recovered; active R4 became interrupted and remains quarantined |
| `WEB_UI_VERIFICATION` | `WEB_UI_VERIFICATION_PENDING` | No ChatGPT Web UI page-level session was exercised |
| `RELIABILITY_001_COMPLETE` | NOT PASS | Public wrapper errors are uncorrelated, R4 did not resume, and UI verification is pending |
