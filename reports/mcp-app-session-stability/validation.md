# DevSpace Workspace App / MCP Session Stability Validation

Validated: 2026-07-27 (Asia/Shanghai)

## Verdict

`DO NOT MERGE` until a fresh Web GPT conversation completes the manual
result-card visual gate. Code, protocol, local service, public full-loop, skill
path, and bounded-session gates pass. The remaining gate cannot be established
by server-side tests because it concerns Host iframe reuse and what Web GPT
actually renders.

## Deployed candidate

- Branch: `codex/workspace-app-session-stability-v1`
- Base: `19eee7c0bb786224a68b3fdc3df68d6ff12196ec`
- Candidate: `6f7d21f769fbba7ffe57ad0e3dea68459797c26d`
- Production widget mode: `review_only`
- Tool count: 44
- Final service Boot ID: `5d3b89ee-3324-414b-a382-bc7ffea811e3`
- Schema revision:
  `devspacemac-mcp-app-session-stability-v1.2026-07-27`
- Schema fingerprint:
  `328788adc6f0cfc5136398bd8ca04469aad22fa2b5f35e526a420f1dc3ded002`
- Workspace App build fingerprint:
  `7b861da651f0dce29a33f66fc49430aa68e9ca715471c072fac021d6cc5bbebf`

The launchd service is running from the isolated worktree. Cloudflare stayed on
the existing service, hostname, route, and token file.

## Confirmed causes and fixes

1. Advertised `~/.../SKILL.md` paths were treated as workspace-relative before
   safe Skill resolution. Canonical advertised and activated Skill roots now
   resolve first; traversal, outside paths, and symlink escapes fail closed.
2. `full` attached Workspace App metadata to ordinary tools. `review_only`
   centrally limits it to ten rich review tools without changing their text or
   structured results.
3. Async Workspace App payload imports had no result generation or captured
   card identity. A result generation, payload generation, card object, and
   container gate now rejects stale completions.
4. Handler-provided `_meta.tool` was not enforced by registration. The
   registration wrapper now stamps the actual registered tool name on every
   result; all supported tool names normalize and unknown results use the
   generic card.
5. The Session Registry could not distinguish initialize, reuse, unknown
   requests, source, high water, or recent churn. It now exposes bounded,
   source-aware counters and bounded close-reason tombstones.
6. Widget mode was not persistable in operator config. It is now supported by
   `devspace config set widgets review_only` with environment override
   precedence.

## Rejected or weakened hypotheses

- Cloudflare/OAuth/MCP failure was not the sustained cause: 10/10 public
  full-loops passed with a stable Boot ID; post-final-boot logs contained no
  QUIC/HTTP2 reconnect, DNS failure, 502, refused origin, or timeout.
- Widget attachment is not the main cause of Connector Session creation.
  Five identical public `devspace_info` calls created 7, 6, and 7 sessions in
  `off`, `review_only`, and `full`; this difference is within run noise.
- No bounded-run evidence supports an unbounded memory leak. After churn,
  natural TTL expiry reduced active sessions from 29 to 16 and memory from
  RSS/heap `374/247 MiB` to `261/166 MiB` while the Boot ID stayed fixed.
  Explicit forced GC was not exposed on the production service.
- No directly identified Workspace App client created an HTTP MCP Session:
  `createdBySource.workspace_app` stayed zero. Host-created connector sessions
  identified themselves as the main connector.

## A/B and stability results

| Mode | Identical calls | Created delta | Failures | Unknown |
| --- | ---: | ---: | ---: | ---: |
| `off` | 5 | 7 | 0 | 0 |
| `review_only` | 5 | 6 | 0 | 0 |
| `full` | 5 | 7 | 0 | 0 |

The final production mode is `review_only`. Public `tools/list` advertised App
metadata on exactly:

`list_artifacts`, `inspect_artifact`, `git_diff`, `publish_artifact`,
`preview_artifact`, `capture_game_frame`, `inspect_glb`, `inspect_blend`,
`inspect_audio`, and `render_model_preview`.

Public full-loop: 10 successes, 0 failures, average 17,816 ms, maximum
20,898 ms. The same explicit doctor Session then handled 100 sequential and 20
concurrent tool calls with no response Session change and
`doctorCreatedDelta=0`. Other Host clients created five sessions during that
run, which is separately visible in total source metrics.

The final Boot exceeded ten minutes without an unexpected restart. At one
post-expiry checkpoint:

- active 16, high-water 30, created 57, closed/expired 41;
- acquire/reused 569/569;
- unknown 0, capacity eviction 0, close error 0;
- RSS 261 MiB, heap used 166 MiB.

## Functional validation

- Public advertised `~/.codex/skills/chronicle/SKILL.md`: read succeeded.
- Public unadvertised `/etc/passwd`: rejected as outside allowed roots.
- All 44 tools normalize with registered tool identity in unit coverage.
- Unknown/missing tool metadata produces a generic readable card.
- Rapid `resume_workspace -> project_memory_preflight -> read -> grep`
  generation test leaves only `grep` current.
- Background jobs validate two-running capacity, bounded rejection of a third,
  cancellation, and successful third lifecycle after capacity is released.
- Git Remote Write remained enabled with exact remote/branch/root binding,
  clean workspace requirement, expected remote SHA, fast-forward-only, and no
  force.

## Test gates

All passed on candidate `6f7d21f`:

- `npm run format:check`
- `npm run typecheck`
- `npm run test:unit`
- `npm run build`
- `npm run test:mcp`
- `npm run test:game-art-real`
- `devspace doctor --live`
- `devspace doctor --public`
- 10 consecutive `devspace doctor --public --full-loop`

Cloudflared `2026.7.3` diagnostic collected state, system information, runtime
profiles, metrics, and connectivity prechecks. Traceroute was killed and two
configuration collectors timed out, so the diagnostic was partial. Its archive
was moved to Trash and is recoverable.

## Remaining manual gate

In a fresh Web GPT conversation, verify that rapid mixed tool calls render the
last tool's card, never reuse `resume_workspace`, never show
`No result card is available for this tool result`, and do not report template
fetch failures. This is the only reason the current verdict is not
`ALLOW MERGE`.
