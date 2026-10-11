# COACH-006-B.1 — Native Codex Agent Runner and Trusted Completion Events

Date: 2026-10-11
Final reviewer: ordinary Web GPT using DevSpaceMac MCP (actual source and independent tests)
Verdict: **B1_CODE_AND_TARGETED_GATES_PASS**
Production activation: **NOT DEPLOYED / NOT COMMITTED / NOT MERGED**

## 1. Code and scope

- Primary code: `src/codex-agent-runner.ts` — native fixed allowlisted Node/Codex executable, bounded model gpt-5.6-luna and effort none/low, sandbox read-only/workspace-write, JSONL event parser, safe same-thread UUIDv7 resume, immediate-start/status/stop, workspace lock and Unix process group termination.
- MCP tool adapter: `src/server/tools-codex-agent.ts` — `codex_agent_start`, `codex_agent_status`, `codex_agent_evidence`, `codex_agent_stop` with workspace authorization, idempotent operation ID and read-only mode hiding mutation controls.
- Existing server integration: `src/server.ts`, `src/server/server-types.ts`, `src/server/server-helpers.ts` — lazy runner initialization (other platforms boot without Codex), server-close agent cleanup, workspace lifecycle occupancy, tool capability metadata and schema revision.
- Native SQLite evidence store: `src/coach-review-events.ts` schema user_version=2, new `coach_review_evidence` table. `recordCompletedWithEvidence()` stores review event and hash-verified evidence packet in ONE SQLite transaction. `getEvidence()` revalidates checksum on retrieval.
- Tests: `src/codex-agent-runner.test.ts`, `src/codex-agent-mcp.test.ts`, `src/codex-agent-real-smoke.test.ts`.
- Scratch development instructions: `COACH_006B1_NATIVE_SPEC.md`, `.devspace/tasks.yaml` NOT for production staging.

## 2. Exact execution contract

- DevSpace MCP requires an authorized workspaceId to run or inspect task; no caller-specified filesystem root, executable path, model outside allowlist, shell, external endpoint, or arbitrary environment injection.
- A Codex process holds the same canonical workspace exclusive resource key as project_task during its entire lifetime. Separate workspaces may operate in parallel; contention fails safely.
- JSON events must contain valid thread.started (UUIDv7 accepted) and turn.completed with exit 0, no parsing/error/turn.failed or oversize. Agent prose ('tests passed') is never accepted as a test result by itself.
- Snapshot hashes encode actual Git HEAD/index/status and changed/untracked content, or bounded non-Git file bytes; no path-only fake fingerprint. Snapshot failure aborts review readiness.
- The event stores metadata and hashed stdout/stderr, not the user prompt, code text, raw conversation or secret values. Reviewers must fetch real source/tests separately and confirm no post-snapshot change before approval.
- Agent stop and timeout terminate the dedicated process group on Unix. A real grandchild delayed-write negative test proves it did not survive cancellation.
- The native review packet and event survive SQLite close/reopen, while active process state remains in memory and is NOT automatically resumed after a server crash.

## 3. Actual Codex model evidence

- First real handshake initially failed CLOSED because runner rejected Codex's real UUIDv7 (although exit=0 / turn.completed); no completion event was created. After fixing UUIDv7 validation, the identical type of real test passed.
- Real CLI read-only single-turn: PASS, thread `01a12af7-64a2-7ab1-8ed0-09dc42ee685b`, event_id=1, ~8.2 seconds, input 16481 (cached 9984), output 10, reasoning output 0, no scratch file changes.
- Real two-turn Codex exec + resume: PASS, SAME thread `01a12af8-18cf-7601-b290-7a320ebd6dcb`, two distinct persisted event IDs 1 and 2, no scratch changes. The first of those two turns reported input 16483 (cached 0), output 10, reasoning output 0. No total claim for the second turn.
- CLI help explicitly confirmed prompt `-` reads stdin and resume `<SESSION_ID> -` supports same-session continuation.
- Codex initial development implementation was reviewed, hardened, and tests were independently run through DevSpace. Initial agent sandbox `tsx` EPERM is NOT counted as a test pass.

## 4. Final independent verification (approved task calls, all exit=0)

| Gate | Result |
|---|---|
| `verify-b1-core`: fake Codex real child processes, file mutation, success/failed/missing thread/parse failure/oversize/timeout/cancel, same/different workspace, unborn Git head, child process group termination | PASS |
| `verify-b1-mcp`: real MCP SDK client start/status/evidence/stop, denied workspace, immutable stored evidence reopened, read-only tools | PASS |
| Real Codex CLI new thread and true same-session resume | PASS |
| `verify-typecheck`: project TypeScript noEmit | PASS |
| `verify-a3-events`: persisted native event database | PASS |
| `verify-managed-sidecar`: HTTP auth, MCP, workspace coexistence and native feed | PASS |
| `verify-a3-server-smoke`: actual createServer registration | PASS |
| `verify-server-security`: scoped secret security test suite | 49/49 PASS |
| `verify-mcp-jsonrpc` (legacy surface regression) | 10/10 PASS |
| `verify-mcp-write-guard` (legacy surface regression) | 14/14 PASS |
| `verify-lifecycle-with-lsof`: workspace cleanup and process safety | 50/50 PASS |
| Existing worktree Git and background job tests | PASS |

## 5. Remaining blockers before release

1. This is *trusted completion* evidence, not GPT approval. COACH-006-B.2 must implement an authorized, snapshot-revalidating, idempotent review RPC returning APPROVED/REWORK/BLOCKED and proof-grade verification result checks.
2. Current evidence packet stores Git/tree hashes and summary only; it does not preserve every changed source file, a complete immutable textual diff, or actual independently executed test transcript. B.2 must freeze/retrieve those materials under bounded policy before approving.
3. Process crash/restart does NOT preserve in-flight Codex sessions. The persistent completed evidence survives, but B.2/B.3 must add interrupted-task reconciliation, cleanup of unintended orphan processes after host crash, and durable task status.
4. No five-cycle autonomous development experiment, 24h soak or post-restart production smoke yet.
5. `gpt-5.6-luna`/effort none was requested by CLI and 0 reasoning output tokens were reported; do not infer precise billing from gross token totals.
6. Existing old Chrome extension is not modified and v0.2 pairing not deployed; normal Web GPT auto-wakeup remains unproven/unsupported as a production contract.
7. Full `npm run test:unit`, production release build and actual service restart not run in this B.1 milestone.

## 6. Git and deployment safety

- Canonical development source `/Users/liz/agy/devspace`, main frozen at `c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1` (prior verified clean).
- Isolated worktree `/Users/liz/.devspace/worktrees/devspace-f50dc711`, branch `devspace/integration/devspace-devspace-f50dc711`.
- No Git stage/commit/push/merge, no production DevSpace restart, no TriaRegna modifications.
- New untracked files do not appear in tracked Git diff SHA; future staging MUST use an exact allowlist, excluding `.devspace/tasks.yaml`, specs, node_modules symlink, scratch-only test artifacts.

Final code state: **COACH006B1_CODE_COMPLETE_TARGETED_VERIFIED**; deployment and autonomous looping are deliberately pending.
