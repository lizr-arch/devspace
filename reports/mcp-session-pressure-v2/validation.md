# DevSpace MCP Session Pressure V2

## Baseline

Observed on the production DevSpaceMac boot
`d824ebb1-ec39-4b3d-937d-8bac05f07c6a`:

- 43 active sessions, 213 created, and 170 expired after about 44 minutes.
- All active sessions were classified as `main_connector`.
- `unknownSessionRequests`, `capacityEvictions`, and `closeErrors` were zero.
- `clientClosed` was zero.
- The current-boot sample contained 185 completed session lifetimes:
  - minimum: 302 seconds
  - median: 317 seconds
  - p95: 330 seconds
  - maximum: 332 seconds

The lifetime distribution matches the old 300-second idle TTL plus the
30-second sweep interval. The sessions were initialized, used in a short burst,
then retained until idle expiry. The client names were bounded diagnostics
reported as `openai-mcp` and `openai-mcp _Codex_`; neither client sent a close
request during the observation.

## Falsified mitigation

A first live candidate reduced the default idle TTL from 300 to 90 seconds and
the sweep interval from 30 to 15 seconds. Public probes and real Connector calls
passed, but the shorter expiry caused the client to reinitialize aggressively:

- active sessions rose from 13 to 43 in about two minutes;
- created sessions rose from 13 to 58;
- the final creation rate was 33 sessions per minute;
- `unknownSessionRequests`, capacity eviction, and close errors remained zero.

The client treated server-side expiry as a reconnect signal, so a shorter TTL
amplified churn instead of controlling it. The production default is therefore
not reduced.

## Final change

- Streamable HTTP transport defaults to SDK-compatible stateless mode.
- Stateless mode creates and closes one MCP server per POST; it does not retain
  a session map entry and returns 405 for GET/DELETE.
- Stateful mode remains available as an explicit compatibility fallback.
- Stateful defaults remain 300-second idle TTL and 30-second sweep interval.
- Default retained-session limit is reduced from 256 to 64 as a stateful safety
  boundary.
- Added bounded configuration through:
  - `mcpTransportMode` in `~/.devspace/config.json`
  - `DEVSPACE_MCP_TRANSPORT_MODE`
  - `mcpSessions` in `~/.devspace/config.json`
  - `DEVSPACE_MCP_SESSION_IDLE_TTL_SECONDS`
  - `DEVSPACE_MCP_SESSION_MAX_SESSIONS`
  - `DEVSPACE_MCP_SESSION_SWEEP_INTERVAL_SECONDS`
  - matching `devspace config set` commands
- The public doctor full-loop understands both stateless and stateful transport
  contracts.
- Health and `devspace_info` report transport mode and stateless request count.

## Automated validation

Passed:

- `npm run format:check`
- `npm run typecheck`
- focused config, client classification, session registry, and doctor tests
- `npm run test:mcp`
- `npm run build`
- CLI persistence round trip for the transport mode and session settings

The full `npm run test:unit` command twice hit the existing five-second
`background-jobs.test.ts` lifecycle wait. The same focused test passed in the
main worktree and passed on a later isolated-worktree rerun. No background-job
production code changed in this branch.

## Live validation

Passed on DevSpaceMac boot `d563fb75-2ce7-4278-b998-8a975fc2d267`:

- local live and public readiness probes passed;
- public OAuth registration, owner approval, token exchange, initialize,
  tools/list, Workspace App resource/assets, `devspace_info`,
  `open_workspace`, `list_workspaces`, and `resume_workspace` passed;
- real DevSpaceMac Cloudflare Connector calls to `devspace_info` and
  `list_workspaces` passed;
- after two minutes of Connector background traffic:
  - stateless request count increased from 25 to 40;
  - active, high-water, and created retained-session counts remained zero;
  - unknown requests, expiry, capacity eviction, and close errors remained zero;
  - heap used was observed at 60 MiB, 73 MiB, then 61 MiB.

The service is deliberately left on the isolated validation worktree for soak.
The branch is not merged or pushed by this report.
