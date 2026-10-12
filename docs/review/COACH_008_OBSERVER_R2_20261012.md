# COACH-008 observer — independent security/product re-review (R2)

Date: 2026-10-12  
Review scope: current worktree source, current tests, current diff/untracked observer files  
Reviewer: independent second-pass Codex thread

## Verdict

**ISOLATED_MVP_ACCEPTED_WITH_CHROME_GATE**.

The three P1 findings from the prior report are materially addressed in the
current source and test design. This is an isolated engineering acceptance
only. **PRODUCTION_RELEASE_BLOCKED** remains in force because full GUI Chrome
E2E acceptance is still missing. No deployment, service start, merge, push, or
commit was performed for this review.

## Evidence reviewed

- `src/server/tools-sidecar.ts` exposes `adminObserverScope` only as the exact
  literal `all_native_worktrees`; the normal v0.2 path leaves observer admin
  scope disabled.
- `src/managed-coach-sidecar.ts` rejects elevated scope without a paired
  extension, protects the feed with a newly generated bearer token, exact
  loopback Host and paired-extension Origin checks, GET-only routing, strict
  cursor/query validation, and `no-store` responses. The old token is not
  reused after restart.
- `src/agent-observer.ts` is memory-only, bounded, workspace-labelled, and
  field-whitelisted. `normalizeCodexNativeEvent` accepts only known native
  lifecycle/item categories and emits no command, prompt, reasoning, output,
  path, argument, token, or arbitrary event data.
- `src/codex-agent-runner.ts` invokes that exact parser on real native JSONL
  records and emits the authoritative `runner.finalized` result only after the
  existing finalization path. This closes the former “sanitized test input but
  unverified runner boundary” gap.
- `src/agent-observer.test.ts` includes malicious fixture fields, unknown event
  and item types, malformed input, exact output assertions, redaction checks,
  bounds, cross-worktree reads, cursor gaps, and newer-generation reset.
- `src/agent-observer.integration.test.ts` checks the real HTTP route for
  default denial, explicit admin enablement, old-token denial, missing token,
  wrong Origin, bad Host, invalid cursor/query/method, CORS, no-store, bounded
  redacted output, gap handling, and restart reset.
- `coach-browser-extension/panel.js` clears task and timeline state on either
  `gap` or `reset`, labels incomplete history, and treats only
  `runner.finalized` as terminal. Rendering uses `textContent`/created DOM
  nodes rather than HTML injection. `src/coach-observer-panel.test.cjs`
  exercises gap, completion, disconnect, reset, and hostile-markup-safe DOM
  simulation.
- `manifest.json` grants only `alarms`, `storage`, and `sidePanel`, with the
  narrow loopback host permission `http://127.0.0.1/*`; it does not grant
  ChatGPT/tab access.

## Re-evaluation of prior P1 findings

### P1: unauthorized cross-workspace aggregation — addressed

Aggregation is no longer implicit. The sidecar’s `/agent/events` route returns
403 unless the sidecar was explicitly started with
`adminObserverScope=all_native_worktrees`; startup additionally requires a
paired extension. The tool description discloses that this is an elevated,
instance-wide redacted feed, while the preexisting v0.2 contract defaults it
off. The integration test verifies default denial, explicit enablement, and
that a prior token cannot authorize the newly enabled feed.

Residual product condition: the explicit admin scope is intentionally broader
than one workspace. Product owners must preserve the disclosure/confirmation
semantics if the tool UI or caller is changed. I found no current source-level
authorization bypass in the reviewed path.

### P1: missing native parser tests — addressed

The pure parser is now fixture-tested at the native JSON shape and is called by
the real `NativeCodexAgentRunner` path. Tests cover malicious nested fields,
unknown categories, malformed values, error/lifecycle projections, and exact
absence of secrets and raw fields. The allowlist is fail-closed.

### P1: stale UI state after cursor gap — addressed

On either a retention gap or server-generation reset, the panel clears its
task summaries and timeline before consuming new events. It displays history
loss/restart status and does not retain a stale RUNNING summary. The DOM
simulation test covers both gap and reset transitions.

## Remaining findings and gates

### P1 — full GUI Chrome E2E is still outstanding (release blocker)

The repository tests inspect the manifest and simulate the panel DOM, but do
not load the unpacked extension in real Chrome. They do not prove that
`chrome.sidePanel.open` works in the target Chrome version, that the manifest
is accepted, or that a real popup/panel completes pairing and observes live
events. They also do not provide real-browser coverage for simultaneous
operations, completion/failure/timeout, reconnect, gap, restart reset, and
unpair. This blocks production release, but does not prevent the isolated MVP
verdict above.

### P2 — protocol terminality remains implicit

The observer schema can label an `item.completed` event `COMPLETED`, while the
panel separately recognizes only `phase=runner.finalized` as authoritative.
The current panel behavior is safe, and the tests exercise it, but the
wire-level contract does not type or explicitly mark item completion as
nonterminal. A future client could misinterpret it. Publish or encode the
terminal/nonterminal distinction before broad client adoption.

### P2 — concurrency breadth is limited

The reviewed tests cover store and HTTP behavior, but not simultaneous real
native runner emissions combined with sidecar start/stop races. The in-process
Map operations are synchronous and bounded, so this is not evidence of a
current confidentiality failure; it is additional hardening/acceptance
coverage.

## Security notes

The reviewed path rejects malicious event types and nested raw fields before
storage; memory is bounded by event/workspace caps; cursor reset and overflow
are explicit; the sidecar is loopback-only with exact Host and Origin checks;
the bearer comparison is length-validated and timing-safe; query parsing does
not accept extra parameters; and the extension has no broad tab or ChatGPT
permission. The panel uses text-only rendering. I found no P0 finding and no
new P1 source defect beyond the missing real Chrome gate.

## Test evidence status

The following independent DevSpace TaskRunner outputs were supplied as prior
evidence and were **not rerun in this review**: observer tests (10 tests pass),
typecheck, and Mac regression (`task_55a936cd-135a-4b8d-9f22-97c85347973c`,
`task_9475840a-5791-4572-b9c2-3d5483ed46d2`, and
`task_be9e4c4b-5ee7-44e3-92a5-62ef7aed3ab6`). This report does not represent
those results as independently reproduced. Full GUI Chrome E2E remains the
only explicitly identified acceptance gate.

