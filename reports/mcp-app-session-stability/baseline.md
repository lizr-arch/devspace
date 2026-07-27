# DevSpace Workspace App / MCP Session Stability Baseline

Captured: 2026-07-27 (Asia/Shanghai)

## Repository and service

- Repository commit: `19eee7c0bb786224a68b3fdc3df68d6ff12196ec`
- Task branch: `codex/workspace-app-session-stability-v1`
- Baseline code already includes the earlier result-card, bounded-session, safe
  Git, and test-config isolation changes that are present on local `main`.
- Production widget mode: `full` (the operator config does not override
  `DEVSPACE_WIDGETS`, whose current default is `full`).
- DevSpace version: `1.1.0`
- Schema revision:
  `devspacemac-m4-safe-git-integration.2026-07-27`
- Workspace App build fingerprint:
  `5eb1d63879144c30922e5e86931b48aced9660fe33103c5cb4313ad0e8fe859f`
- Tool count: 44
- Baseline Boot ID: `b5310d1c-b360-4a64-9246-0a54a43090d9`
- MCP idle TTL: 300 seconds
- MCP capacity: 256 sessions

The DevSpace and Cloudflare launchd services were running before the baseline
experiment. The Boot ID stayed unchanged during the controlled calls below.

## Session and memory baseline

Initial local `/healthz` sample:

| Metric | Value |
| --- | ---: |
| active | 64 |
| created | 226 |
| closed | 162 |
| expired | 162 |
| capacity evictions | 0 |
| close errors | 0 |
| RSS | 483 MiB |
| heap used | 422 MiB |
| heap total | 463 MiB |

A public `devspace_info` call then reported `active=67`, `created=229`,
`RSS=510 MiB`, and `heapUsed=440 MiB`.

Five sequential public `devspace_info` calls through the connected
DevSpaceMac Cloudflare client produced:

| Call | active | created | expired | RSS MiB | heap used MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 72 | 234 | 162 | 542 | 468 |
| 2 | 74 | 236 | 162 | 554 | 478 |
| 3 | 75 | 237 | 162 | 555 | 483 |
| 4 | 77 | 239 | 162 | 573 | 495 |
| 5 | 79 | 241 | 162 | 584 | 506 |

### Fact

The five ordinary public tool calls increased both `created` and `active` by
12 relative to the immediately preceding public sample. The same Boot ID was
used, no capacity eviction occurred, and no close error was recorded.

### Hypothesis

The connected host is creating additional MCP sessions around one logical tool
call, plausibly for result-card/App work. Existing metrics cannot attribute
those sessions to the main connector, Workspace App, doctor, or another client,
so attribution is not yet confirmed.

The increasing heap samples are correlated with the session increase but do not
by themselves prove a leak. A post-fix fixed-sequence matrix, explicit client
classification, session reuse counters, forced-GC sampling, and soak test are
required.

## Advertised Skill path reproduction

`resume_workspace` advertised:

```text
~/.codex/skills/chronicle/SKILL.md
```

Reading that exact advertised path failed with:

```text
ENOENT: .../<workspace-root>/~/.codex/skills/chronicle/SKILL.md
```

### Confirmed cause

`WorkspaceRegistry.resolveReadPath()` attempts ordinary workspace resolution
before advertised-Skill resolution. A leading `~/` is therefore accepted as a
workspace-relative lexical path and does not reach the existing safe Skill
fallback.

## Result-card reproduction status

The supplied Web GPT evidence records different tools rendering as the same
`resume_workspace` card and later generic/template errors. The current local
normalizer test passes for individual `resume_workspace`,
`project_memory_preflight`, job, and unknown-tool payloads.

Source inspection found that dynamic payload rendering relies on container
identity and current global `card` state but has no explicit monotonic render
generation or captured card identity. A deterministic rapid-result/async-delay
test does not yet exist. Therefore:

- the historical wrong-card display is a fact from the Web GPT observation;
- `_meta.tool` corruption is not yet confirmed;
- stale async rendering remains a testable hypothesis;
- stale host/template state remains a separate hypothesis.

## Error-layer baseline

For the current service Boot ID, structured DevSpace logs contained:

- MCP session created events: 256
- MCP session closed events: 181
- MCP request errors: 0
- transport close errors: 0
- authorization denials: 0
- HTTP 502 responses: 0

Cloudflare logs since the same service start contained:

- QUIC reconnect: 0
- reconnect: 0
- DNS failure: 0
- 502/origin refused: 0
- timeout: 0
- remote stream cancellation: 494

The remote cancellations are counted separately and are not classified as
transport failures without an HTTP/MCP failure.

The existing service does not count unknown-session requests, initialize
requests, client closes, request reuse, high-water mark, or recent session
creation rate. Template and card-render failures occur in the host/App layer
and are not present in server logs, so a zero server-log match is not evidence
that they did not occur.

## Raw evidence locations

- `/Users/liz/.local/state/devspace/devspace.log`
- `/Users/liz/.local/state/devspace/devspace.error.log`
- `/Users/liz/.devspace/logs/cloudflared.out.log`
- `/Users/liz/.devspace/logs/cloudflared.err.log`

These files are not copied into the report because they may contain local
request metadata.

## Baseline conclusion

Confirmed defects:

1. advertised `~/.../SKILL.md` paths are resolved incorrectly;
2. current Session diagnostics cannot attribute or quantify churn well enough;
3. `full` attaches the Workspace App to ordinary tools, increasing the surface
   on which host/App sessions can be created.

Still unconfirmed:

1. whether every result card creates a dedicated Session;
2. whether the wrong-card display is caused by stale async rendering, host
   iframe reuse, or stale template state;
3. whether retained sessions cause unbounded memory growth after GC and expiry.

No current-baseline evidence supports continuous Cloudflare 502, DNS failure,
OAuth failure, or MCP backend request failure as the cause of the observed
session growth.
