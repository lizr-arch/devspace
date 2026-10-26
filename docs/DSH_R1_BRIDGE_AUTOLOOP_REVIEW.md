# DSH-R1 — independent review of BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001

Status: **READY_FOR_INDEPENDENT_REVIEW**
Reviewer/implementer: DSH Lead (local implementation + verification only)
Owner/independent reviewer: Web GPT
Date: 2026-10-26
Worktree: `/Users/liz/.devspace/worktrees/devspace-a8f30657`
Branch: `devspace/integration/devspace-devspace-a8f30657`
Base HEAD at review start: `cd9b1d6471919c5fda8b6ff0dacecf2862aaa2ac`
Local implementation commit: the commit created immediately after this report
(`git log -1` on the branch above). No push/merge/deploy was performed.

This report supersedes none of the Codex-authored report
`docs/BRIDGE_WEBGPT_DSH_AUTONOMOUS_LOOP_001_REPORT.md`; it records the DSH
independent re-verification, the resolved loopback blocker, the control-mutation
failure explanation, and the exact evidence captured in this environment.

## 1. P0 — WIP preservation and failure forensics

### Preserved state (nothing reset/cleaned/stashed/rebased)

- 7 tracked modifications were present and are preserved unchanged:
  `coach-browser-extension/auto-worker.js`, `coach-browser-extension/multiroute-gate.js`,
  `package.json`, `src/coach-multiroute.test.ts`, `src/coach-multiroute.ts`,
  `src/managed-coach-sidecar.ts`, `src/server/tools-sidecar.ts`.
- Untracked work preserved: `src/coach-routes/` (5 modules + 2 tests),
  `docs/BRIDGE_WEBGPT_DSH_AUTONOMOUS_LOOP_001_REPORT.md`, `docs/evidence/`,
  `TASK.md`, `BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001-TASK.md`, `.devspace/`,
  `node_modules/`. No untracked item was removed or staged.
- No writer was active in this worktree (no process, no `index.lock`).
- The failed Codex operation `bridge-autoloop-001-p0p1-implementation` was **not**
  restarted.

### Frozen task controls are intact

| file | SHA-256 |
| --- | --- |
| `.devspace/coach/tasks/BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001/TASK.md` | `fc3d8ede8e2151598ae04bd0317d3c1eef47b6a6e5273b22a3e0e03fa6b955ac` |
| `.devspace/coach/tasks/BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001/frozen-v1.json` | `8eca6ca1dc191bc22c3453e460e87dd3027bd797fd51b227b8c74d437fbdf679` |
| `BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001-TASK.md` (root contract copy) | `fe11dfd39ed2053f060a68427fd7cba73c48aac68bac522d9122c0c38aa84d1b` |
| `TASK.md` (root copy) | `fe11dfd39ed2053f060a68427fd7cba73c48aac68bac522d9122c0c38aa84d1b` |

`frozen-v1.json` still points at `fc3d…` and the frozen TASK.md still hashes to
`fc3d…`. The root `TASK.md` is a pre-existing formatting variant (G-01… G-05
without colons) created before the freeze; it is not a control file and was not
modified by this run.

### Why the Codex operation ended in `CODEX_TASK_CONTROL_MUTATED`

Evidence row in `/Users/liz/.local/share/devspace/coach-review-events.sqlite`
(`coach_agent_runs`):

- operation: `bridge-autoloop-001-p0p1-implementation`
- state: `FAILED`, reason: `CODEX_TASK_CONTROL_MUTATED`
- started `2026-10-26T03:51:20.537Z`, finished `2026-10-26T04:18:58.402Z`
- request SHA-256 `42ff52afea41f063344a3a85cc6d0cbdb99e99815ff74963ca7c7743db208dd1`

The runner only evaluates this gate after an otherwise successful run
(`src/codex-agent-runner.ts:844-850`). `taskControlSnapshot()`
(`src/coach-task-contract.ts:155-165`) recursively hashes **every file** under
`.devspace/coach/tasks` except the operation's own report. During this run a
sidecar validation file appeared under that tree:

`.devspace/coach/tasks/BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001/results/bridge-autoloop-001-p0p1-implementation.validation.json`
(`DEVSPACE_CODEX_REPORT_CHECK_V1`, mtime 12:16 local; operation finished 12:18
local). That file is outside `ownReport`, so it changed the control snapshot and
triggered `CODEX_TASK_CONTROL_MUTATED` even though the frozen task, manifest and
source work were not mutated by Codex.

Conclusion: the failure is a **host control-plane artifact**, not evidence that
Codex edited the frozen task, source authorization, or production state. The run
must not be restarted. The validation file is preserved as evidence and is not
staged/committed.

## 2. P1 — ownership and security re-review

### Split owner sizes (hand-written, all <= 800 lines)

| module | lines | ownership |
| --- | ---: | --- |
| `src/coach-multiroute.ts` | 214 | public coordinator/API compatibility, OS instance lock |
| `src/coach-routes/protocol.ts` | 326 | wire types, identity validation, prompt templates, redaction |
| `src/coach-routes/registry.ts` | 433 | consent revisions, routes, proposals, legacy migration |
| `src/coach-routes/durable-queue.ts` | 526 | append-only queue/transitions, cursor, framing, claims |
| `src/coach-routes/delivery.ts` | 198 | trusted transport boundary, durable outbound dispatch |
| `src/coach-routes/bridge-hostile.test.ts` | 314 | hostile/fault tests |
| `src/coach-routes/bridge-wiring.test.ts` | 125 | real MCP/Sidecar in-memory wiring tests |

No wrapper-only move: the 1453-line predecessor is reduced to 214 lines and the
state ownership moved into the four owner modules.

### Confirmed properties (re-read in source, exercised by tests)

- **Sender labels never authenticate.** The trusted DSH ingest path fetches the
  bridge receipt independently; `from=dsh`/`sender` text is not trusted. A body
  cannot authorize anything.
- **Host-verified WebGPT principal.** `trusted_reply` passes MCP invocation
  metadata to `BridgeTransport.authorizeWebGpt(context, route)`; the default
  without a configured transport/verifier is `BLOCKED_REAL_E2E`.
- **Exact identity binding.** Route, workspace, DSH session, chat id, tab id,
  `inReplyTo`, content SHA and consent revision are checked; messages carry
  `routeId+messageId+seq+kind+sessionId+contentSha` (and source SHA for DSH
  notifications), not just body text.
- **Fixed browser instruction.** The browser receives a fixed lookup instruction
  rebuilt from identity; the DSH source body stays in `data`/inbox and is never
  forwarded as a browser command. `DSH_MESSAGE_NOTIFY` says "a DSH session
  message", never "Codex CLI completed".
- **Fail-closed state machine.** Revoke/rebind bump `consentRevision`; stale
  revision, wrong session/tab/chat, replay/conflict, torn or corrupt frames and
  illegal transitions fail closed. Outbound dispatch persists
  `PREPARED→SUBMITTING→ACCEPTED/COMPLETED/UNCERTAIN`; after an ambiguous submit it
  reconciles the stable requestId and never re-POSTs.
- **Cross-process fence.** `MultiRouteStore` acquires the existing
  `DevSpaceInstanceLock` before reading/repairing; concurrent adapter instances
  share one in-process external-submission owner and a second process is rejected.
- **Chrome fence.** The pump checks the wake digest, persists `in_flight` before
  DOM mutation, rechecks mutation epoch/tab/URL/revision after await, and a
  persisted `in_flight`/ACK-loss state blocks a second DOM submit.

### Residual risks (reported, not silently changed)

- Real authenticated bridge transport, host principal verifier and live session
  allowlist are **not configured in tests**; all E2E-adjacent results are offline
  (fake Chrome/mock transport). Default is blocked.
- `coach_route_admin` mutating actions rely on the Sidecar's authorized workspace
  scope and MCP/host authentication rather than an explicit per-call
  `workspaceId` check; this is pre-existing operator-tool behavior, not changed
  in this pass. It should be part of the real-rollout authorization review.
- A remote bridge revoke cannot be made atomic by a local snapshot; the remote
  bridge must enforce its current allowlist at admission (documented in the report).

No new confirmed source defect was found that warranted a change in this pass;
the WIP code was not rewritten.

## 3. P2 — real test execution in this DSH environment

All commands were run from the worktree above; raw combined log:
`docs/evidence/dsh-r1/tests-1.log`
(SHA-256 `1488170f83864e5a527d63378eba0ba5b295bbfe6314d487c8091d754b67348e`).

| command | exit | observed result |
| --- | ---: | --- |
| `./node_modules/.bin/tsc -p tsconfig.json --noEmit` | 0 | clean |
| `npm run test:coach:bridge` | 0 | hostile 13/13 PASS; real in-memory Sidecar/MCP wiring 7/7 PASS |
| `npm run test:coach:multiroute` | 0 | core 27 PASS; **integration/loopback 11/11 PASS** (previously `listen EPERM`); extension suite PASS |
| `node --test src/coach-multiroute-extension.test.cjs src/coach-browser-extension.test.cjs src/coach-auto-delivery.test.cjs` | 0 | **142/142 PASS** |

The previous Codex blocker was environmental: its sandbox denied `listen` on
127.0.0.1, so the 11 loopback checks could not run. In this DSH environment the
same checks run on test-owned ephemeral localhost sockets and pass; no test was
edited to bypass the gate. Real Chrome/DSH/GPT E2E was not executed.

## 4. G01–G12 matrix for this delivery

All rows are **OFFLINE** (source + isolated tests). "REAL" means actual
DSH/Chrome/GPT production interaction; none was performed or claimed.

| gate | evidence in this delivery | status |
| --- | --- | --- |
| G01 DSH event → route → Sidecar → Chrome break located | source trace + hostile/wiring tests | OFFLINE PASS / REAL NOT RUN |
| G02 GPT trusted reply to exact DSH session | exact-session dispatch tests, mock bridge | OFFLINE PASS / REAL BLOCKED |
| G03 1453-line split, <=800/file, state ownership | module table above + tsc | OFFLINE PASS |
| G04 hostile negatives and executable checklist | 13 hostile + 7 wiring + integration tests | OFFLINE PASS |
| G05 no production/WIP/水战/Chrome mutation | this report + untouched state inventory | PASS (local) |
| G06 exact route/session/chat/tab binding without spoof | hostile tests | OFFLINE PASS / REAL NOT RUN |
| G07 real WebGPT trusted tool invocation + pinned verdict | wiring test with host metadata; real MCP not launched | OFFLINE PASS / REAL BLOCKED |
| G08 stable requestId, no recent-session fallback | dispatch/reconcile tests | OFFLINE PASS / REAL BLOCKED |
| G09 three unattended rounds, dual-end reconciliation | three simulated rounds | OFFLINE PASS / REAL NOT RUN |
| G10 ACK loss/restart, no second external action | child crash/SIGKILL/fake worker tests | OFFLINE PASS / REAL NOT RUN |
| G11 stop/revoke/rebind fences | live-scope/revision tests | OFFLINE PASS / REAL NOT RUN |
| G12 two routes one workspace, three workspaces, V1 equivalence | integration/loopback tests | OFFLINE PASS / REAL NOT RUN |

## 5. P3 — local commit scope (whitelist)

Will be committed on the isolated branch only:

- 7 tracked modifications listed in §1
- `src/coach-routes/` (new modules and tests)
- `docs/BRIDGE_WEBGPT_DSH_AUTONOMOUS_LOOP_001_REPORT.md`
- `docs/evidence/bridge-autoloop-001/`
- `docs/evidence/dsh-r1/` (this run's log and source fingerprints)
- `docs/DSH_R1_BRIDGE_AUTOLOOP_REVIEW.md` (this report)

Explicitly **not** staged: `.devspace/` (frozen task controls/results/validation),
root `TASK.md`/`BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001-TASK.md`, `node_modules/`,
production state, other worktrees, shared mailbox/watcher/tasks.yaml.

No `git add -A`. No merge/push/deploy, no service/session/Chrome/browser change.

## 6. Remaining blockers and next step

1. Configure the real authenticated DSH bridge transport and host WebGPT
   principal verifier in the Sidecar (currently absent → `BLOCKED_REAL_E2E`).
2. Grant/maintain the exact DSH session allowlist and exact Chrome tab/chat
   binding; a remote revoke must be enforced by the bridge at admission.
3. After explicit user maintenance authorization, execute the G01–G12 real
   checklist (one exact session, one exact tab, three unattended rounds) and
   retain raw receipts/hashes.
4. Independent Web GPT review of this commit; no self-approved status.

Verdict: **READY_FOR_INDEPENDENT_REVIEW**. Real E2E remains **NOT RUN / NOT
APPROVED**; no deployment or production mutation is implied.

## 7. Rollback

- Revert the single local commit on this branch (`git revert <sha>`), or remove
  this dedicated worktree after review.
- The failed Codex run and its validation artifact remain untouched as evidence;
  do not restart that operation.
