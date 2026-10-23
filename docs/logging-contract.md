# DevSpace HTTP request logging contract

The HTTP request middleware (`src/server/request-logging.ts`, extracted from
`src/server/express-routes.ts` on 2026-10-24) emits one `http_request` log event
per request and keeps the live monitor + MCP diagnostics consistent with it.

## `http_request` event fields

| Field | Type | Notes |
| --- | --- | --- |
| `ts` | ISO-8601 string | logger-assigned event time |
| `level` | `"info"` | request completion is informational |
| `event` | `"http_request"` | |
| `requestId` | UUID string | also returned as `X-DevSpace-Request-Id` |
| `method` | string | HTTP method |
| `path` | string | request path without query string |
| `status` | number | final status; **499** for client aborts (see below) |
| `durationMs` | integer | wall time from middleware entry to completion |
| `aborted` | `true`, optional | present only when the client went away first |
| `networkSource` | `"cloudflare"` \| `"direct"` | `cf-ray` header presence |
| `host`, `userAgentCategory`, `originHost`, `contentLength` | optional | bounded header-derived fields |

## Client abort semantics: 499

A request is "aborted" when the response emits `close` without
`writableFinished` becoming true. Before 2026-10-24 such requests were logged
with Node's implicit default `res.statusCode` (200), which made a hung tool call
that the client cancelled after ~300 s look like a successful 200 request.

From 2026-10-24:

- `status` is **499** (`CLIENT_ABORT_STATUS`, the nginx "client closed request"
  convention), never 200;
- `aborted: true` is added to the log event;
- the live request monitor counts it as an error (`status >= 400`) and it shows
  up in `errors.recentErrors` / `mcp.errorRatePercent`;
- `runtime.monitorEvents` records `HTTP_499` with the message
  `<METHOD> <path> aborted by client` (except `/monitor*` and `/app-test*`);
- the MCP diagnostics stream records stage `client_abort` with
  `statusCode: 499` and `errorClass: CLIENT_ABORT`.

Normal completion is unchanged: `close` after a successful `finish` keeps the
real status code, and no `aborted` field is emitted.

## Why this matters for incident triage

`/monitor/api` and `~/.local/state/devspace/devspace.log` now distinguish:

- a genuinely successful request: `status: 200`, no `aborted`;
- a client that gave up after a long tool call: `status: 499`, `aborted: true`,
  multi-minute `durationMs`;
- a real server/protocol failure: 4xx/5xx as returned by the route.

Treat 499 as "the caller lost patience or the transport died", not as a server
success. When a 499 appears together with `cloudflared ... context canceled` and
a public 502, the request path is unhealthy even though `/healthz` may still be
200.
