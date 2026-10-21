# Native Codex task and result contract

Every new native developer operation requires a complete, frozen TASK. A prompt is optional supplemental guidance. This applies to `codex_agent_start`, `codex_agent_start_rework`, Coach automatic dispatch and the Worker/Runner. There is no public skip switch. The older delegate `.devspace/current_task.md` workflow is separate.

## Web GPT operating instructions

1. Reuse the authorized workspace ID. Write the full approved contract to `.devspace/coach/tasks/<taskId>/TASK.md`. Never replace it with a summary. Task IDs use letters, numbers, `_` and `-`, at most 96 characters.
2. Use YAML frontmatter with `schema: DEVSPACE_TASK_V1`, `task_id`, `task_type` (a nonempty safe identifier such as `feature`), and positive integer `version`. H2 headings must be exactly WHY, GOAL, CONTEXT, SCOPE, IMPLEMENTATION, ACCEPTANCE, TEST, CONSTRAINTS, DONE, each once. WHY requires H3 PROBLEM, EVIDENCE, HYPOTHESIS, RATIONALE. GOAL uses `G-01: ...`; ACCEPTANCE uses `A-01 -> G-01: ...`, with unique acceptance IDs, existing goals, and coverage of every goal. Put each acceptance statement on its own line. Do not use dummy text, TODO fields or body keywords as substitutes for headings. Fenced code and HTML comments do not satisfy required headings. Maximum TASK size is 128 KiB; annex expansion is not supported.
3. Call `codex_task_freeze` with `workspaceId` and `taskId` (or exact relative `taskPath`). DevSpace securely reads the entire UTF-8 file, validates it, computes SHA-256 including newlines, and returns `task: {workspaceId, taskId, taskPath, version, sha256}`. Optional `version` and `expectedSha256` guard stale selection/bytes; a wrong expected hash returns `TASK_EXPECTED_HASH_MISMATCH` without creating a manifest. Callers need not prehash. The legacy full `task` argument remains supported; do not mix it with selection fields. Freeze creates a separate, create-only `frozen-v<version>.json` bound to the canonical workspace root. Retrying identical bytes is safe. A revision requires Web GPT to explicitly revise TASK, increment `version` and freeze again. A version cannot be reassigned to another document or workspace.
4. Pass that exact `task` reference to `codex_agent_start`. Supply the selected model, reasoning effort, sandbox and unique operation ID. Optional `stageId` defaults to `development`. The generated bootstrap cites exact path/version/hash and instructs Codex to read all of TASK and AGENTS, assess WHY, and complete DEV→TEST→FIX→DONE. Prompt text cannot replace or weaken TASK. Do not resume arbitrary threads; use the existing verified rework mechanism.
5. Register stages only after the initial operation is verified/running. Each stage includes its own frozen `task`, matching `stageId`, approved `testTaskId` and explicit model/effort/sandbox. Stage zero must match the initial operation. Use `reviewerMode=webgpt` through `coach_webgpt_register` when Web GPT owns review. The test manifest approval remains a separate requirement.
6. If a gate fails, inspect `structuredContent.error` with schema `DEVSPACE_TASK_GATE_RESULT_V1`: exact code, keyword, reason, remediation, retryable and `codex_started=false`. Repair the document/reference through an explicit Web GPT revision and retry. Do not invent a placeholder to bypass validation or edit another agent's contract. The Runner checks again after the workspace lease/fingerprint and immediately before spawning; late edits fail closed. TASK/manifests/other operation reports are protected even when Git ignores them.
7. Read `codex_agent_status` and `codex_agent_evidence` after completion. The immutable native packet contains pinned task metadata and `report` validation status/code/hash, without automatically exposing agent prose or logs. Native exit code, native completion evidence, report validity and independent test proof are separate facts. A clean native exit with a missing/invalid report remains execution-completed with `CODEX_REPORT_PROTOCOL_ERROR` and blocked review; it is not a transport failure or approval.
8. For IN_PROGRESS, continue development without issuing a formal REWORK verdict. Coach uses a separate durable per-stage continuation counter, default 3, configurable 0–3, shared with report-repair attempts. A deterministic operation ID and persisted dispatch intention prevent replay. Unknown dispatch outcomes block for reconciliation; reaching the cap blocks with an actionable reason. No registered plan means no automatic continuation; an authorized new document-bound operation can repair the report under a new operation ID. Prior immutable evidence must be preserved.
9. IN_PROGRESS, BLOCKED and missing/invalid reports are absent from the formal Chrome delivery queue, including its count and pagination. The immutable completion journal keeps historical event IDs/schema for scheduler recovery and signed reviews. PLAN_CONFLICT is delivered to the explicitly bound workspace owner with distinct `event_type: PLAN_CONFLICT` and a contract revision instruction, without asking for a formal verdict. Coach stops with `PLAN_CONFLICT_requires_Web_GPT_revision`; inspect the report's concrete counter-evidence and revise the contract explicitly if warranted. BLOCKED stops scheduling. READY_FOR_REVIEW still requires immutable native evidence, unchanged fingerprint, independently approved deterministic tests and the existing exact-event signed APPROVED mechanism. An agent's self-report, browser receipt or successful native turn cannot approve itself.

## Developer result

Write exactly `.devspace/coach/tasks/<taskId>/results/<operationId>.json`. The Runner creates the results directory; it rejects a preexisting report for a new operation. It never overwrites TASK. No symlink path components, absolute paths, traversal or cross-workspace references are accepted. Task controls are bounded to 2000 entries and 4 MiB per control/evidence file; result JSON is bounded to 128 KiB. Unknown-outcome operations require reconciliation rather than replay.

```json
{
  "schema": "DEVSPACE_CODEX_REPORT_V1",
  "task_id": "example-task",
  "task_sha256": "<64 lowercase hex characters>",
  "operation_id": "example-op",
  "stage_id": "development",
  "status": "READY_FOR_REVIEW",
  "summary": "Implemented the complete approved scope",
  "changes": ["Relevant source change"],
  "test_results": [{
    "command": "npm run typecheck",
    "exit_code": 0,
    "evidence_path": "test-results/typecheck.log",
    "evidence_sha256": "<SHA-256 of the actual log bytes>"
  }],
  "remaining": [],
  "issues": [],
  "next_action": "Independent Web GPT review",
  "evidence_paths": ["test-results/typecheck.log"]
}
```

Four statuses are accepted: IN_PROGRESS, READY_FOR_REVIEW, PLAN_CONFLICT, BLOCKED. All fields shown are mandatory; arrays may be empty except READY_FOR_REVIEW needs test evidence and no remaining work, and IN_PROGRESS needs remaining work. Nonzero tests cannot claim READY_FOR_REVIEW. Each test evidence path must be listed, exist as a confined regular file and match its hash. The report cannot serve as its own test evidence. PLAN_CONFLICT additionally requires `plan_conflict: {assumption, counter_evidence, impact, suggested_revision, safe_to_continue}` (four nonempty strings and one boolean).

Native source evidence keeps sensitive paths denied by default. Only this operation's exact result JSON and hashed test proof files explicitly listed in its validated report under `.devspace/coach/tasks/<taskId>/results/<operationId>/` are recorded as path/SHA-256 metadata in the immutable packet’s `operationProofs`; their raw bytes are never inlined. The existing `sourceDiff` text/manifest format stays unchanged. A proof must occur in `test_results` with matching `evidence_sha256` and in `evidence_paths`. Sensitive names (`.env`, credentials, secrets, etc.) remain rejected even there. Unlisted files, another operation's report/proofs, and edits to TASK/frozen manifests are rejected, including Git-ignored task controls. Proof paths already present before the operation are protected by the control snapshot. Prefer test logs outside `.devspace`; keep TMPDIR/npm caches outside the task controls. Never globally ignore `.devspace` to bypass evidence capture or delete old evidence/cache files.

Evidence existence and hash checks validate artifacts, not the truth of a claimed command or exit code. Returned metadata always states `testsIndependentlyVerified: false`; only the existing trusted task runner can produce independent signed review test proof. The report digest/status are frozen with native evidence in SQLite; later file edits cannot rewrite the operation's accepted metadata. Report repair always produces a new operation/report, never a replacement for signed evidence.

## Compatibility and limits

Historical persisted in-flight operations are not relaunched. Their evidence/reviews remain readable and historical pending Web GPT review can finish under existing safety gates. A historical plan without task references cannot launch a new developer or local reviewer child: attach a new complete, explicitly frozen document in a new registration after reconciling the old plan. There is no silent legacy-prompt migration. Public MCP callers cannot set `internalReview`; the internal exemption additionally requires a read-only sandbox, and registered local reviewers verify the same frozen TASK.

This change does not modify browser pairing, secret handling, production services or signed verdict ownership. Tests use fixture child processes, in-process MCP and isolated SQLite state; they do not call billable models. The full TASK is verified byte-for-byte before launch; no claim is made that prose or a hash proves model comprehension.

## Validation

Run `npm run typecheck`, `npm run build` and `npm run test:coach:contract`. The focused test group includes these contract/native cases plus signed-review and catalog regression checks:

- `src/coach-task-contract.test.ts`
- `src/coach-contract-r1.integration.test.ts`
- `src/coach-status-routing.test.ts`
- `src/coach-browser-extension.test.cjs` (includes automatic delivery tests)
- `src/coach-contract.integration.test.ts`
- `src/codex-agent-runner.test.ts`
- `src/codex-agent-mcp.test.ts`
- `src/coach-webgpt-loop.test.ts`
- `src/coach-realtime.integration.test.ts`

These cover parser mutations, filesystem confinement, frozen revisions, runner/Worker bypass and late edits, real native fixture streams, MCP early rejection, progress/report-repair caps, conflict routing, independent test failure and signed review/restart behavior.
