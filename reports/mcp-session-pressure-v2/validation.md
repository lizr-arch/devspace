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

## Change

- Default idle TTL: 300 seconds to 90 seconds.
- Default sweep interval: 30 seconds to 15 seconds.
- Default retained-session limit: 256 to 64.
- Added bounded configuration through:
  - `mcpSessions` in `~/.devspace/config.json`
  - `DEVSPACE_MCP_SESSION_IDLE_TTL_SECONDS`
  - `DEVSPACE_MCP_SESSION_MAX_SESSIONS`
  - `DEVSPACE_MCP_SESSION_SWEEP_INTERVAL_SECONDS`
  - matching `devspace config set` commands
- The sweep interval is rejected when it exceeds the idle TTL.

At the observed initialization rate, the new defaults should reduce steady
state retention from roughly 40-50 sessions to roughly 8-15 sessions. The
64-session cap is a hard safety boundary; it is not expected to be reached
during normal operation.

## Automated validation

Passed:

- `npm run format:check`
- `npm run typecheck`
- focused config, client classification, session registry, and doctor tests
- `npm run test:mcp`
- `npm run build`
- CLI persistence round trip for all three session settings

The full `npm run test:unit` command twice hit the existing five-second
`background-jobs.test.ts` lifecycle wait. The same focused test passed in the
main worktree and passed on a later isolated-worktree rerun. No background-job
production code changed in this branch.

## Live validation

Pending deployment and a new production boot. Acceptance requires:

- health reports `idleTtlSeconds=90` and `maxSessions=64`;
- public doctor full loop passes;
- real Connector calls remain successful;
- after at least two idle-TTL windows, session expiry increases without
  `unknownSessionRequests`, capacity eviction, or close errors;
- active sessions and memory settle materially below the 300-second baseline.
