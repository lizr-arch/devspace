# BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001 — implementation report

Stage outcome: **BLOCKED**. Code and offline simulations are reviewable; required
loopback integration cannot run in this sandbox (`listen EPERM`), and the local commit is blocked by Git metadata write confinement (`git add` exit 128). This is neither
APPROVED nor a real Chrome/DSH E2E result. Retained failed tests require reviewer
resolution before READY_FOR_INDEPENDENT_REVIEW; they have not been relabeled PASS.

## Authority and isolation

- Frozen TASK version 1, SHA-256 `fc3d8ede8e2151598ae04bd0317d3c1eef47b6a6e5273b22a3e0e03fa6b955ac`, verified before work and again after implementation.
- Workspace `ws_3fb54bb2-1790-45e0-bc22-2c12b7d3107e`.
- Only worktree `/Users/liz/.devspace/worktrees/devspace-a8f30657`.
- Branch `devspace/integration/devspace-devspace-a8f30657`.
- Starting and final HEAD `cd9b1d6471919c5fda8b6ff0dacecf2862aaa2ac`; staging failed before a commit could be created. Final Git identity and staging attempt are recorded in the operation's result/evidence index. Test source SHA-256 manifests identify exact tested bytes independently of Git.
- Operation `bridge-autoloop-001-p0p1-implementation`, stage `development`.
- Initial tracked tree clean; existing untracked `.devspace/`, root `TASK.md` and root `BRIDGE-WEBGPT-DSH-AUTONOMOUS-LOOP-001-TASK.md` retained. Only this operation's result file is written.
- Dependencies reused through a local untracked `node_modules` symlink. No install, production service restart, browser load/send, DSH send/allow/revoke, deploy, push or merge. No other worktree, session, pairing state or mailbox modified.

## Independent WHY assessment and P0 trace

The hypothesis is supported, with its explicit fail-closed fallback. This task
already anticipates missing trusted-source proof and missing live authorization;
there is no PLAN_CONFLICT requiring revision of the frozen task.

Observed candidate facts (source at starting HEAD, not historical test claims):
`src/coach-multiroute.ts` is exactly 1453 lines; its line 210 template calls every
wake a completed Codex CLI task; lines 1310/1326 only enqueue fixed wakes/replies.
`src/managed-coach-sidecar.ts:663` exposes enqueue methods but no trusted DSH
producer or outbound bridge submit; `/next` at line 610 omitted the flattened
eventId/operationId/workspaceId expected by the Chrome gate. The Chrome exact pump
persisted `in_flight` but its gate did not block that state after restart, and the
pump never called its SHA digest checker. These are independently reproducible
code defects, rather than inferred failures of a running session.

Read-only supporting documents: external `MULTIROUTE_REPORT.md` under the task's
route-dev evidence directory and `raw/candidate-HEAD.patch` (SHA-256
`dbdc36ec29ae3b3cb9152f7352cc9b68e3a23cf691b60e6965c40593de5f622b`). The public
`cross-agent-bridge/references/dsh-session-bridge.md` and bridge source confirm
that `sender` is self-reported. Bridge `observe()` ties assistant append messages
to a claimed request/turn, and public completed records expose rpcId, claimed,
seenUser and messages. No bridge state, token, policy, process or live session was
queried. Statements about historical production state remain historical only.

| Segment | Candidate finding | Current source anchor | Status / boundary |
| --- | --- | --- | --- |
| DSH event production | No automatic trusted producer in candidate | `coach-routes/delivery.ts:65` ingest | Implemented receipt adapter; real authenticated transport LIVE_BLOCKED |
| Source authentication | `sender`/`from=dsh` cannot prove origin | `delivery.ts:65` receipt lookup + complete SHA/claimed/seenUser/rpcId/seq checks | Implemented, transport MOCKED in tests; not arbitrary unsolicited DSH events |
| Route binding | Exact tuple + startup session array, no live session query | `managed-coach-sidecar.ts:649`; `registry.ts:197` | Configured adapter queries exact allowed session; transport-free legacy API retained |
| Queue enqueue | Durable queue existed; one false Codex template | `coach-multiroute.ts:65`; `protocol.ts:189` | DSH_MESSAGE_NOTIFY fixed lookup, body confined to inbox; REVIEW_WAKE remains legacy alias for CODEX_REVIEW_WAKE |
| Sidecar/browser wire | Missing flattened event identity | `managed-coach-sidecar.ts:619` | Implemented; source body/request record excluded from browser wire |
| Browser poll/submit | Exact tab gate existed, SHA not checked by pump, crash gap | `auto-worker.js:100`; `multiroute-gate.js:194,219` | Digest + in_flight + final epoch/tab/revision fence; actual worker executed with fake Chrome |
| GPT turn ACK | DOM ACK only | `durable-queue.ts` pendingReviewWakes; browser classifyReviewState | Implemented separation; real GPT turn receipt LIVE_BLOCKED |
| GPT reply/principal | Generic reply could be attributed to WebGPT | `tools-sidecar.ts:364`; `delivery.ts:100` | trusted_reply passes host MCP context; verifier required; self-asserted body denied |
| DSH request/wait | Queue only, no dispatch | `delivery.ts:167` | Stable exact-session request + durable before/after submit + request/wait reconciliation, MOCKED transport |

All new asynchronous boundaries are explicit: session lookup, receipt lookup,
WebGPT authorization, send, request and wait. Route/scope/revision are rechecked
after lookup/authorization and immediately before the synchronous durable submit
marker. The remote bridge must also enforce its current allowlist at admission;
a local snapshot cannot make a remote revoke atomic. Chrome rechecks its mutation
epoch and exact tab after readiness/ledger persistence. Legacy observer/completion
callbacks are unchanged; no watcher or background autonomous send loop was added.

## Five owners and compatibility

| Owner | Lines | State actually owned |
| --- | ---: | --- |
| `src/coach-routes/protocol.ts` | 326 | Wire types, pure validation, identity hashing, separate fixed prompts; no mutable state |
| `src/coach-routes/registry.ts` | 433 | Registry/proposal/legacy maps, consent revisions, save/load, revoke/rebind invariants |
| `src/coach-routes/durable-queue.ts` | 526 | File descriptors, frames, envelopes/order, transitions, leases and cursor/ACK state |
| `src/coach-routes/delivery.ts` | 198 | Trusted authorization/transport boundary, shared dispatch exclusion, durable external-submit journal and reconciliation |
| `src/coach-multiroute.ts` | 214 | Public compatible facade, queue lifecycle and OS ownership, message coordination |

The old core is replaced, not wrapped around an unchanged monolith. All five
owners are below 800 lines. Existing unrelated large files/tests were not
reformatted to satisfy a repository-wide size metric. Original public exports
remain available from `coach-multiroute.ts`; original fixed wake bytes and legacy
workspace-only extension behavior remain covered by the existing tests. A
configured trusted exact claim may be asynchronous; the MCP handler awaits it,
while the transport-free legacy claim retains its synchronous return.

The existing DevSpaceInstanceLock component supplies an exclusive SQLite OS lock
for the route store, released even on SIGKILL. It stores no application messages
or competing routing schema: registry JSON and the existing END+SHA journals
remain authoritative. A second process cannot race a journal append or submit.
Adapter instances on the same store also share dispatch exclusion. Views return
copies rather than mutable registry/data references.

The new `bridge.blocks` journal lives next to each existing route queue. Each
reply requestId is a hash of route/session/revision/message/inReplyTo/content SHA.
PREPARED is durable before dispatch; SUBMITTING is fsynced before the external
call. ACCEPTED/COMPLETED/UNCERTAIN is fsynced after response. A lost response or
interrupted SUBMITTING is reconciled through request/wait with the original ID,
never another POST. Missing request proof stays UNCERTAIN. Torn/corrupt outbound
frames block dispatch; they are never repaired into permission to resend.

## Trusted adapter contract and explicit real blockers

`BridgeTransport` is constructor injection for a trusted local host connection,
not a tool argument, sender label, bearer accepted from a message, or inferred
"most recent" session. It exposes only session/receipt/send/request/wait and a
host WebGPT invocation verifier. It has no allow/revoke API. Completed source
receipts must be full, untruncated bridge records whose exact bytes match the
supplied SHA; the adapter fetches them independently, then validates exact
session/rpcId/claimed/seenUser/sequence. A running=false session can persist both
sides of the queue; browser delivery and outbound send wait for that same session.

The real host must supply an authenticated bridge connection and a real verifier
for WebGPT's MCP principal. Shared MCP access or a client-supplied `from=webgpt`
field is insufficient. This task supplies the reviewable contract and offline
implementations, not production credentials or a fictional attestation scheme.
The default deployed constructor has neither component; new trusted calls return
BLOCKED_REAL_E2E. Generic legacy `reply` cannot reply to a DSH_MESSAGE_NOTIFY.

No active production binding, tab ID, DSH session or GPT reply is asserted here.
The completed receipt route handles DSH replies observed by the bridge, not an
arbitrary unsolicited assistant log entry; a future append-only event adapter
must prove the same source/sequence/content properties before use.

## Actual tests and retained failures

All logs and exact subprocess exits are in `docs/evidence/bridge-autoloop-001/`.
The runner returns success to finish evidence collection even for a failed test;
its JSON/log `exit_code` is the actual tested process exit, never the runner exit.
Final `*-verified.sources.json` files hash every touched source/test before launch.
The operation result indexes logs with accurate SHA-256. Claims await independent
review of those files and the code diff.

| Command / evidence stem | Actual result |
| --- | --- |
| `npm run test:coach:bridge` / `bridge-verified` | exit 0: 13 hostile + 7 actual handler/MCP in-memory checks; three unattended simulated turns |
| `npm run test:coach:multiroute` / `multiroute-verified` | exit 1: 27 core PASS, then required 11 loopback checks cannot start (`listen EPERM 127.0.0.1`); chained extension checks not reached |
| `node --test src/coach-multiroute-extension.test.cjs src/coach-browser-extension.test.cjs src/coach-auto-delivery.test.cjs` / `chrome-verified` | exit 0: all 142 PASS (11 + 72 + 59), executed independently despite prior failure |
| `./node_modules/.bin/tsc -p tsconfig.json --noEmit` / `typecheck-verified` | exit 0: no type errors |
| Initial required npm command / `baseline-rerun` | exit 1: tsx CLI IPC socket denied; changed focused script to `node --import tsx` to remove the unnecessary socket |
| Initial refactor core check / `core-after-split` | exit 1: 26 PASS, one old fixture left a reopened owner unclosed; fixture now closes in finally; `core-fixed` and final required run show 27 PASS |
| Direct socket suite retry / `loopback-required` | exit 1: same listen EPERM, not relabeled or bypassed |

Hostile checks include sender spoof, forged from=dsh, stale authorization, wrong
session/revision, replay/conflict, changed inReplyTo, stopped session, revoked
route, rebind, two chats/one workspace and three workspaces, lost ACK, real child
exit 91 after mock external submit, actual SIGKILL of a test-owned lock holder,
concurrent adapters, torn outbound frame, bad SHA, fake worker restart with a
persistent in_flight marker, actual pump digest enforcement, final grant-change
fence, draft/busy/navigation/tab mismatch and default unconfigured adapter denial.
Expected child exit/signal are printed verbatim; they are fault injections, not
hidden failed outer tests. The in-memory handler test injects a temporary Entry;
it does not claim the blocked loopback test passed.

## G01–G12 real E2E checklist and evidence contract (NOT EXECUTED)

These are this task's explicitly numbered future gates, not fabricated historical
passes. Every REAL column is **BLOCKED_REAL_E2E** pending separately authorized
maintenance, dedicated session/chat/tab consent, authenticated source and verifier.
No command below authorizes a production action.

| Gate | Check / required real evidence | OFFLINE evidence | REAL |
| --- | --- | --- | --- |
| G01 | Dedicated exact route; host/source identity and consent revision recorded | registry + wiring live-claim tests | BLOCKED |
| G02 | DSH produces complete trusted receipt; raw bytes/SHA/session/rpcId/seq agree | hostile receipt negatives | BLOCKED |
| G03 | Exact routeStore enqueue and browser poll carry same message tuple | wiring handler tests | BLOCKED |
| G04 | Fixed DSH notify reaches correct Chrome tab, no peer body/Codex claim | fake worker + prompt equality | BLOCKED |
| G05 | Real draft/busy/tab navigation prevents send | gate + fake worker | BLOCKED |
| G06 | Actual DOM submitted receipt and subsequent GPT turn ID separately recorded | DOM ACK stays pending | BLOCKED |
| G07 | Real WebGPT trusted tool invocation verified by host; verdict content/inReplyTo pinned | MCP context tests | BLOCKED |
| G08 | Exact-session outbound stable requestId and receipt; no recent-session fallback | dispatch identity checks | BLOCKED |
| G09 | Three successive real rounds without human relay; dual-end reconciliation | three simulated rounds | BLOCKED |
| G10 | ACK loss/restart: no second external POST/DOM action, reconcile original ID | child crash/SIGKILL/fake worker | BLOCKED |
| G11 | Stop/revoke/rebind fences new claims and sends; review partial submissions | live scope + revision tests | BLOCKED |
| G12 | Two routes in one workspace, three workspaces, old V1 route equivalence | core + extension regressions | BLOCKED |

For each real gate, collect a confined immutable evidence directory containing:
source commit + file hashes; authorization reference (no credential material);
route/workspace/session/chat/exact-tab/consent revision; source request and seq;
raw source SHA; route message/kind/content SHA; browser poll and durable ledger;
actual DOM action/receipt timestamp; separate real GPT user-turn/assistant-turn
identity; host verified tool receipt + inReplyTo; outbound requestId and
SUBMITTING/response journal; bridge request/wait receipt; round number; command,
outer exit and UTC timestamps. Hash every artifact in an index. Redact credentials
and do not copy auth.json. Reconcile browser, GPT and DSH identities on both ends;
DOM ACK alone, a local agent's verdict, or a mock receipt cannot pass a real gate.
Stop on uncertain submit or mismatched evidence; preserve it for independent review.

## Next action and rollback

The attempted `git add` failed with exit 128 because this managed worktree
points at `/Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace/.git/worktrees/devspace-a8f30657`,
which is outside the writable sandbox roots. No index or branch mutation occurred;
no local commit was created. `git-add.txt` preserves the complete error. The
confined `implementation.patch` includes all changed code/tests and this report,
including new files, for review without Git index access.

Independent reviewer should inspect the code/source fingerprints, resolve Git
metadata write confinement to create the required isolated local commit, resolve the
loopback sandbox blocker and rerun the required 11 integration checks. Real E2E
requires separate host verification and the user's maintenance/dedicated-route
authorization. No deployment or native browser/session action is implied.

Rollback for this isolated candidate: preserve evidence and reverse the dedicated
implementation commit after review, or discard this isolated checkout through the
normal workspace owner workflow. No production rollback is needed because no
production action occurred. Do not delete production journals: rolling back to an
older runtime that ignores SUBMITTING/UNCERTAIN can lose the at-most-once guard.
