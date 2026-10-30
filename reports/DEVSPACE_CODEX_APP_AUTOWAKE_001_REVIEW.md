# DEVSPACE-CODEX-APP-AUTOWAKE-001 implementation report

Date: 2026-10-24  
Frozen TASK SHA-256: `f0a781d00f87137d4e06c8a6885da606d8ebc044b1ff328140e1a2f86bf9f7c0`  
Workspace: `ws_93dcc2dc-a050-4bb0-801f-dd978d5ce41b`  
Disposition: **IMPLEMENTED CANDIDATE — INDEPENDENT REVIEW REQUIRED; LIVE_E2E_BLOCKED**

## Source contract and change

Before this change, `codex_app_thread_send` called `sendSharedTurn` and stored only the transport receipt in an owner-only JSON file. The listener existed only for the duration of that call. A timeout wrote `UNCERTAIN`, discarded the accepted turn ID, and removed the listener. The App path never registered `CoachReviewEventStore` completion, so the existing `/events` feed had no App event to deliver. The existing browser worker accepted only positive numeric event IDs, whose reviews belong to the CLI evidence/verdict path.

The candidate now records App turns and App-specific review events in new tables in the existing Coach SQLite database. It records workspace, canonical root, exact pinned thread, operation, request fingerprint, frozen task identity, accepted turn ID, and state. It does not persist prompts or replies in the new event tables. App events use `app:<sha256>` IDs, separate from legacy integer IDs and DSH string event IDs. Completion is inserted transactionally and idempotently by `(workspace_id, operation_id)`; a durable review decision is required to remove the event from the pending feed.

The bridge persists the accepted turn ID before waiting. A 30-second service recovery loop and the read-only receipt tool can reconcile only that exact turn ID from the exact bound thread after reconnect. The bridge verifies the thread owner and workspace root before reconciling. It does not infer completion from the latest assistant message or resubmit an uncertain turn. The existing browser feed remains the sender; it receives the explicit native-App kind, exact workspace, operation, event, thread, turn, and evidence digest. The extension routes only through its preexisting explicit workspace-to-chat binding and records the existing `dom_submitted` receipt separately from review.

Native App verdicts use `codex_app_review` and an event-specific evidence digest and reason. `codex_app_thread_rework` requires a recorded `REWORK`, the exact currently pinned/owned thread, the same frozen task hash, a fresh operation ID, and a maximum of three REWORK verdicts for that task fingerprint. It writes through the native App bridge; no CLI worker is invoked. Tool catalog capability and schema revision were updated.

Key locations:

- [coach-app-server-bridge.ts](/Users/liz/.devspace/worktrees/devspace-8c228250/src/coach-app-server-bridge.ts:254): durable accepted turn and exact-turn reconciliation.
- [coach-review-events.ts](/Users/liz/.devspace/worktrees/devspace-8c228250/src/coach-review-events.ts:150): App tables; turn journal, event, and verdict methods at lines 280–319.
- [tools-codex-app.ts](/Users/liz/.devspace/worktrees/devspace-8c228250/src/server/tools-codex-app.ts:26): read-only recovery/delivery status; send and App review/REWORK tools at lines 126–184.
- [server.ts](/Users/liz/.devspace/worktrees/devspace-8c228250/src/server.ts:430): 30-second reconciliation loop and shutdown cleanup.
- [managed-coach-sidecar.ts](/Users/liz/.devspace/worktrees/devspace-8c228250/src/managed-coach-sidecar.ts:298): scoped feed projection and App receipt validation.
- [auto-worker.js](/Users/liz/.devspace/worktrees/devspace-8c228250/coach-browser-extension/auto-worker.js:96): App-specific validation, instruction, and string-ID receipt support.

## Event sequence

Before: accepted App turn → transient in-call completion listener → JSON transport receipt; no Coach event → no browser poll notification → manual Web GPT wake-up was needed.

After, by implementation contract: journal `PENDING` → persist accepted turn ID → `COMPLETED` only after the exact App turn is authoritatively completed → one `app:` event → existing authorized Sidecar `/events` poll → existing explicitly bound Chrome route → one DOM submission receipt → independent Web GPT review receipt → optional bounded same-thread REWORK. `dom_submitted` does not remove an event or imply a Web GPT response. Sidecar, browser, route, and App outages leave the durable event/journal pending or blocked; queued is not delivered.

## Verification and acceptance status

One focused batch was attempted on 2026-10-24:

- `npm run test:coach:0310`: **PASS**, 59/59 browser auto-delivery tests.
- `npm run typecheck`: **BLOCKED**, exit 127, `sh: tsc: command not found`.
- `node --import tsx src/coach-app-server-bridge.test.ts`: **BLOCKED**, exit 1, `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`.
- `node --import tsx src/coach-review-events.test.ts`: **BLOCKED**, exit 1, same missing `tsx` loader.
- `node --import tsx src/managed-coach-sidecar.test.ts`: **BLOCKED**, exit 1, same missing `tsx` loader.
- `node --import tsx src/coach-app-server-mcp.test.ts && node --import tsx src/coach-tool-catalog.test.ts`: **BLOCKED**, exit 1, same missing `tsx` loader (first command could not start).
- `npm run test:coach:0310`: **PASS**, exit 0, 59/59 browser auto-delivery tests.
- `node --test src/coach-browser-extension.test.cjs`: **PASS**, exit 0, 73/73 tests, including the new App instruction validation test. This direct run was before the consolidated batch; subsequent edits were TypeScript-only.
- `git diff --check`: **PASS**, exit 0.
- Dependency state: `node_modules` absent; no package installation or network access was attempted.

| Criterion | Status | Evidence / gap |
|---|---|---|
| A-01 journal, late exact-turn reconciliation, restart-safe dedup | Candidate implemented; **unverified** | Simulation added to `coach-app-server-bridge.test.ts`; runner unavailable. |
| A-02 authorized App feed, browser receipt, legacy delivery compatibility | Browser baseline **PASS**; App integration **unverified** | Existing 59 browser tests pass; new Sidecar integration is authored but not runnable here. |
| A-03 App review and same-thread bounded REWORK | Candidate implemented; **unverified** | New store/MCP paths and tests authored; TypeScript/SQLite unavailable. |
| A-04 negative security/recovery cases | Partial; **unverified** | Exact binding/root checks and event scope checks implemented; test suite unavailable. |
| A-05 required typecheck and consolidated tests | **BLOCKED** | Dependencies absent; see exact exits above. |
| A-06 genuine App + Chrome + Web GPT loop | **LIVE_E2E_BLOCKED** | The existing read-only diagnostic reports `CODEX_APP_SHARED_SOCKET_UNAVAILABLE`; no live native bridge or real Chrome route/review was exercised. |
| A-07 isolation and production safeguards | **PASS by workspace inspection** | No source checkout, parallel worktree, production Sidecar, App, Chrome installation, tunnel, or secret was changed. No merge/deploy/push occurred. |

The App socket diagnostic at [DEVSPACE_CODEX_APP_AUTOWAKE_001_SOCKET_DIAG.md](/Users/liz/.devspace/worktrees/devspace-8c228250/reports/DEVSPACE_CODEX_APP_AUTOWAKE_001_SOCKET_DIAG.md) records that the expected shared socket alias is absent and the one opaque private socket rejects the compatible handshake. Ordinary App restart did not restore it. This is why a genuine App turn and end-to-end browser delivery could not be tested. No App launch/restart, socket reconstruction, writer lock, CLI substitution, or production restart was attempted.

## Compatibility, rollout, and rollback

Legacy `coach_review_events` numeric IDs, decisions, evidence packets, CLI review gates, DSH events, `/events` authorization, explicit Chrome route consent, 30-second browser alarm, and uncertain DOM-send suppression remain on their existing paths. App events occupy a prefixed string namespace and their delivery receipts have a separate table. The only extension change is support for that App event contract; the active/deployed extension was not installed or overwritten. Existing routes still require the user’s first explicit browser conversation binding and an available extension/ChatGPT tab. The production Sidecar must be running and authorized for that workspace. None of those conditions was established by this offline test run.

Before rollout, install dependencies in an approved isolated environment, run the required TypeScript, App bridge, Coach feed, browser, review, JSON-RPC, and runtime tests, then validate a genuine App completion against the already authorized Chrome route. Preserve the prior extension build and existing database; rollback consists of reverting only the scoped source/extension candidate and restarting only through a later explicitly authorized deployment. Do not merge or deploy this candidate based on this report.

No commit was created: independent review and the required test gates remain incomplete. The frozen TASK and `.devspace` control files were not modified. Existing unrelated `package.json`, socket diagnostic, and other untracked `.devspace` worktree content were preserved.
