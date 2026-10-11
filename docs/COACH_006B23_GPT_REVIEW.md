# COACH-006-B.2 / B.3 — Independent Web GPT Final Code Review

Date: 2026-10-11
Branch: devspace/integration/devspace-devspace-f50dc711
Actual worktree: /Users/liz/.devspace/worktrees/devspace-f50dc711
Base/clean main: c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1

## Decision

- **B.2 REVIEW_PROTOCOL_AND_TARGETED_E2E_PASS** — reviewer tests plus actual approved TaskRunner execution and 5 local protocol cycles are green.
- **B.3 FAIL_CLOSED_RECOVERY_AND_QUARANTINE_PASS** — durable journal and restart reconciliation are verified in temporary SQLite, no automatic replay.
- **B.3 FULL_OS_ORPHAN_CLEANUP_NOT_VERIFIED** — unresolved safety/release blocker; do not call B.3 production-complete.
- **INTEGRATION/PLAYER_RELEASE NOT APPROVED** — no merge, commit, push, build, process restart, existing Chrome re-pairing or 24h soak.

## Changes executed in this turn

### B.2 — secure code review and controlled rework

1. Reviewed and hardened Codex-implemented CoachReviewGate and MCP endpoints.
2. `codex_agent_verify_test` first verifies current workspace approved task set and manifest SHA-256 using the same checks as native project_task. A caller cannot pass fake results or arbitrary shell argv.
3. Verification uses actual TaskRunner task exit status and before/after fingerprint; failed/dirty task => no proof. Verified-test proof is persisted with INSERT OR IGNORE plus strict identity check; a second different proof cannot overwrite it.
4. `codex_agent_submit_review` rechecks event identity and evidence hash under exclusive workspace lock and requires matching trusted proof for APPROVED. Identical decisions idempotent, conflicting decisions rejected; REWORK and BLOCKED need not claim a test PASS.
5. `codex_agent_start_rework` is an EXPLICIT caller action only after signed-off REWORK, retrieving the parent Codex thread ID and SHA from the authorized workspace's persisted evidence. The source fingerprint is rechecked both before calling the Runner and AFTER the Runner acquires its workspace lock, before any new subprocess starts. Generic codex_agent_start no longer accepts arbitrary sessionId.
6. Git source diff / non-Git bounded source snapshot is captured inside the completion packet. A missing, oversized, sensitive-path or unsafe file fails closed rather than silently claiming complete review evidence. Project .devspace admin settings are included in non-Git fingerprints even where admin contents are excluded from user-facing code diffs.
7. Default codex_agent_evidence returns metadata and hash only; a separate authorized codex_agent_source_diff call is required to retrieve frozen textual code changes. This prevents accidental source/prompt text echo in general status and evidence calls.

### B.3 — durable Agent operations and interruption handling

1. Native SQLite coach_agent_runs journal (schema user_version=3), claim-before-spawn, final status update, unique workspace+operation, SHA-based request identity, and blocked duplicate replay.
2. Server-start reconciliation of precrash RUNNING rows: verifies persisted event evidence digest before marking COMPLETED; otherwise marks INTERRUPTED and never invents a success or launches an automatic retry.
3. codex_agent_status can read durable terminal/INTERRUPTED state after a fresh Runner instance. Pending review evidence remains accessible from SQLite, independent of in-memory tasks.
4. Workspaces with unresolved INTERRUPTED runs are quarantined: new native Codex launches and project_task execution refuse. Central MCP tool wrapper also denies workspace.write, git.write, runner.execute, game.control, artifact.publish and explicit destructive lifecycle operations. The workspace reclaim occupancy probe shows the quarantine.
5. No auto-kill of an unknown PID. An orphan child from a force-killed server might still exist; without a reliable OS-level process identity/supervisor proof, quarantines remain in place and manual operator recovery is required.

## Independently executed validation — exact PASS results

| Gate | Result |
|---|---|
| B.1 Native Codex Runner unit, fake child process and grandchild SIGTERM, stale REWORK hold-lock check | PASS exit 0 |
| B.1 MCP SDK start/status/evidence/sourceDiff/stop, workspace denial, SQLite reopen, readonly tools | PASS exit 0 |
| B.2 initial review gate tests | PASS exit 0 |
| B.2 real TaskRunner + MCP 3-stage denied/REWORK/APPROVED flow, manifest mutation denial | PASS exit 0 |
| B.3 precrash RUNNING, post-evidence crash, restart reconciliation, no replay, quarantine with actual MCP call | PASS exit 0 |
| Combined 5-cycle E2E with real Node child fake Codex JSON and real MCP/TaskRunner | PASS 5 cycles; 2 REWORK, 3 APPROVED, 0 pending, same thread, 0 billable model calls |
| Real Codex CLI (model gpt-5.6-luna effort none): new thread and same-thread exec resume | PASS; 2 actual turns, event IDs 1/2, no scratch mutation |
| New admin-manifest fingerprint mutation test | PASS exit 0 |
| Full TypeScript tsc --noEmit | PASS exit 0 |
| Existing native event store tests | PASS exit 0 |
| Existing managed Sidecar and actual DevSpace createServer tests | PASS exit 0 |
| A.3 secret-redaction + penetration suite | 49/49 PASS exit 0 |
| Worktree lifecycle and process probe | 50/50 PASS exit 0 |
| Existing Git governance and background jobs | PASS exit 0 |

Real Codex regression thread: 01a12b49-d01a-7883-9768-0433f24b6ea0.
Tracked Git diff SHA-256 at closure: 19b365a6890165d27969aa875b1f1491b3e5f37f8aed26a439025337ac85f117 (does NOT include new untracked files).

## New key files

- src/coach-review-gate.ts, src/coach-review-gate.test.ts, src/coach-review-gate.integration.test.ts
- src/server/tools-codex-review.ts
- src/coach-agent-recovery.test.ts, src/coach-five-cycle.test.ts
- Updated src/codex-agent-runner.ts, src/coach-review-events.ts, src/server/tools-codex-agent.ts, src/server/tools-tasks.ts, src/server.ts, src/server/server-helpers.ts, src/server/server-types.ts
- Existing A1-A3/B1 files preserved with targeted compatibility updates.

## Remaining release gates

1. OS orphan watchdog/process identity: demonstrate forced main-process crash cannot leave an uncontrolled Codex modifying an unquarantined project. Need secure orphan detection/removal, safe manual clearance and bounded watchdog test; never kill reused/unrelated PID.
2. Crash recovery is fail-closed, not resumable in-flight execution. Durable status and completed evidence survive; an INTERRUPTED run cannot be reused. An explicit reconciled clearance workflow and process-state verification remain to be implemented.
3. Native EventStore server startup assumes an exclusive single active DevSpace server for the state directory. A real single-instance ownership lock is needed before production cutover; do not boot two writers sharing one live DB.
4. 64-KiB evidence packet/diff cap is deliberate; large change sets are BLOCKED rather than approved. Pagination/artifact bundling needed for larger production projects.
5. A passing approved task proves successful execution, not test semantic coverage. Reviewer must independently inspect real changed files and select appropriate test suite before APPROVED.
6. No automatic Web GPT wakeup from an ordinary ChatGPT conversation. Currently human-triggered Chrome notifications are the proven model. New paired Chrome v0.2 is not yet live.
7. No full npm run test:unit or production release build, deployment, live service restart, rollback test or 24-hour soak claimed.

## Git safety and next actionable task

`/Users/liz/agy/devspace` main clean, no staged files. All modifications in managed worktree; no commit, push, merge or restart. Do not use bulk git add -A: exclude .devspace/tasks.yaml, COACH_*_SPEC.md and node_modules symlink, plus scratch-only development probes. Next recommended gate: COACH-006-B.3-OS-001 native supervisor process identity, orphan cleanup and safe quarantine-clearance plus actual kill -9/restart isolation test; then controlled release integration.

**Conclusion: B2 feature development and B3 conservative persistence/quarantine are built and verified, but NOT production-release accepted.**
