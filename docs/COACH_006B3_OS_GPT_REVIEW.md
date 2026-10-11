# COACH-006-B.3-OS-001 — Native Guardian Process Safety Closure

Date: 2026-10-11
Reviewer: Web GPT via DevSpaceMac MCP. Actual Mac worktree, no live production restart.
Verdict: **OS001_CODE_AND_TARGETED_TESTS_PASS**; **PRODUCTION_RELEASE_NOT_YET_APPROVED**.

## Goal and change safety

- Scope: `/Users/liz/.devspace/worktrees/devspace-f50dc711`, based on clean main `c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1`.
- Did not stage/commit/push/merge; no TriaRegna modifications and no production DevSpace process termination or restart.
- Every forced kill in tests targeted a PID created and retained by that test. Any test-owned process group emergency cleanup required verified guardian marker/PID/PGID/UID/birth.

## Technical outcome

1. New `src/coach-agent-guardian.ts`: fixed trusted Node guardian source, spawned in a dedicated detached Unix process group. The original DevSpace process maintains a private FD3 pipe *not* inherited by Codex. The guardian monitors pipe closure using event-driven `net.Socket` instead of blocking `fs.ReadStream` and SIGKILLs only its own process group if its owner abruptly disappears.
2. Guardian does not start Codex until after DevSpace has persistently claimed the operation and recorded the guardian's PID, PGID, UID, command marker and OS start time in SQLite. Then it receives bounded prompt on stdin and spawns the fixed allowlisted Node+Codex CLI without a shell or user-supplied executable.
3. Normal Codex exit now safely drains output, SIGTERMs the guardian-owned group, checks that no non-zombie descendants remain with a separate detached `ps` helper, and preserves Codex's successful exit code. A nonterminating descendant fails closed instead of reporting success.
4. Process identity is verified using Darwin `/bin/ps`: PID=PGID, expected uid, birth time and fresh 144-bit random guardian marker in command args. Orphan-group membership is verified read-only; no restarted DevSpace code calls `kill()` against a possibly reused old PID.
5. New SQLite schema v4 adds guardian identity and audited quarantine clearance. Migrates v3 (and early add-column-only v4) by transactionally rebuilding legacy `coach_agent_runs` tables if their CHECK constraint lacks CLEARED. Existing runs and review evidence remain intact.
6. `codex_agent_quarantine_status` exposes metadata only. `codex_agent_clear_quarantine` is an explicit authorized mutation that requires recorded guardian identity, observed absent owner and group, no running TaskRunner session, no active jobs, no concurrent workspace tool operation, and a fresh zero-foreign-process lsof probe. Unknown, reused, forged, alive or lingering group => still BLOCKED.
7. A cleared operation becomes terminal CLEARED with append-only audit record. It remains non-replayable. The normal workspace quarantine guard has exactly one controlled exception for the explicit clearance tool, which then enforces its own narrower checks.

## Actual independent gates, all exit=0 after corrective fixes

| Gate | Verdict |
|---|---|
| `verify-b3-os`: real isolated parent SIGKILL, guardian owner-pipe EOF, grandchild non-survival, unrelated sibling survival, authorized MCP quarantine clear, replay rejection | PASS |
| `verify-b3-guardian-normal`: real normal exit, grandchild holds stdout/stderr but cannot survive successful guardian cleanup | PASS |
| `verify-b3-os-security`: live guardian cannot clear; marker/birth/PGID mismatch blocked; leader-gone-but-descendant-active remains quarantined; clean group can clear; old SQLite v3 migrates and CLEARED passes | PASS |
| `verify-b3-os-migration`: preserved v3 historical RUNNING records, v4 `CLEARED` constraint replacement and audit durability; invalid guardian must fail closed | PASS |
| Real Codex CLI read-only `exec` and same-session `exec resume` via production default guardian | PASS; final independent retry thread `01a12b70-0abb-74b1-a661-fa718c4d8074`, two completion events, 11.6s first execution, scratch modified=false |
| `verify-typecheck` after final schema change | PASS |
| `verify-b1-core`, `verify-b1-mcp`, `verify-b2-review`, `verify-b2-integration`, `verify-b3-recovery`, `verify-b23-five-cycles` | PASS; 5 cycles, 2 REWORK, 3 APPROVED, 0 pending |
| `verify-a3-events`, `verify-managed-sidecar`, `verify-a3-server-smoke` | PASS |
| `verify-server-security` | 49/49 PASS |
| `verify-sidecar-tool-coverage` | PASS, 64 existing tools |
| Existing workspace lifecycle | 50/50 PASS in final independent batch |

## Important discovered failures (fixed, not suppressed)

- The initial Codex implementation closed fd3 before watching it, reversed stream direction, and the initial OS test killed the guardian itself rather than the owning parent. Corrected and independently replaced with a true owner SIGKILL test.
- `fs.createReadStream(fd3)` on Mac held a blocking filesystem read that prevented actual guardian process exit: simulated and real Codex normal completion initially timed out. Switched to `net.Socket(fd3)`; normal and real Codex execution now both PASS.
- The normal process-group inspection helper originally joined its parent's process group and detected itself as a lingering descendant. Moved the read-only `ps` process into its own temporary detached group. A further normal-exit test confirmed Codex exit=0 is passed through and any stdout/stderr-holding grandchild is cleaned up.
- The initial v3→v4 migration added columns but did not replace the old state CHECK constraint, which prohibited CLEARED. Implemented transactional table rebuild and an actual old-record transition test.
- Tool registration and output schemas were updated for quarantine status/clearance, and existing MCP tests were extended accordingly.

## Limits and RELEASE blockers

1. **Single-instance ownership for the live DevSpace state directory** remains a separate hard deployment gate: starting two independent server processes sharing this native SQLite and running reconciliation could mark a legitimate RUNNING operation as interrupted. Controlled release must implement and test exclusive instance ownership/second-server refusal first.
2. Host OS crash, power loss or explicit SIGKILL of the guardian itself can bypass owner-pipe cleanup. The recovery path detects unknown or lingering group state and fails closed with quarantine; it does not assume universal automatic orphan removal.
3. Workspaces interrupted *before a guardian identity is persisted* remain conservatively quarantined, although the guardian protocol prevents Codex from doing work before that point. A manual, audited no-identity clearance workflow is intentionally not provided.
4. Mac/Darwin-only process identity contract; Windows is unsupported for this guardian release. Linux would require independent /proc starttime-based verification and separate tests.
5. This is tested within isolated temporary services, not as a replacement for the current running DevSpace. No live signed-in Chrome extension pairing, 24-hour soak, complete npm test:unit, production build, release merge, rollback or deployment claim.
6. Ordinary Web GPT still requires a human browser-triggered review message. These OS changes do not enable automatic resumption of a completed ChatGPT conversation.

## Recommended next stage

`COACH-006-RELEASE-001`: exclusive DevSpace instance ownership lock, clean Git staging allowlist (exclude scratch .devspace/tasks.yaml, node_modules symlink, SPEC files), full test+build, controlled main fast-forward, production server switch/rollback and real signed-in Chrome v0.2 pairing. Maintain required human click to trigger Web GPT review.

## Final independent rerun, 2026-10-11

All 15 explicitly selected closure tasks returned `succeeded`, exit=0: guardian normal, actual parent SIGKILL, v3→v4 migration, TypeScript, B1 Runner/MCP, B2 review/integration, B3 reconciliation/five-cycle, native events, Sidecar, security 49/49, lifecycle 50/50 and actual createServer. Additional guardian reuse/foreign-orphan security test and 64-tool coverage also returned exit=0. Real Codex `exec` and same-thread resume passed in a separate paid CLI smoke.

Git status: `main` unchanged and clean at `c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1`. Isolated worktree changes remain unstaged; no commit, push, merge, service restart or Chrome re-pairing. Tracked diff SHA-256 was `c3ebc9098a54c5a9a6a552cc175bd3be19abd4e362b2b61133baa9c9af9f5179` at review; new untracked source/tests are not included in this hash.

**Final: OS001 targeted implementation & real Mac SIGKILL/normal-exit safety accepted. Full production release remains gated.**
