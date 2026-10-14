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
