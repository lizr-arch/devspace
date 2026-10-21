---
task_id: DEVSPACE-COACH-CONTRACT-001-R1
schema: DEVSPACE_TASK_V1
task_type: fix
version: 1
---

## WHY

### PROBLEM
Initial implementation produced source/tests but failed native final evidence capture with CODEX_EVIDENCE_SENSITIVE_PATH. TASK.md and RESULT files live in .devspace/coach/tasks, while original source diff scanner rejects sensitive .devspace changed/untracked paths. Also Web GPT has to precompute SHA for freezing, and IN_PROGRESS may be delivered as formal Chrome review.

### EVIDENCE
Initial op devspace-coach-contract-001-implementation-20261021 ended FAILED after 1,858,844ms and 200 native events, evidence stage, CODEX_EVIDENCE_SENSITIVE_PATH. Initial source is committed 6ec4ed3d74c084131d567a3e58120c29e23d54d1. Independent npm run test:coach:contract PASS (82 + 103 checks and Runner/MCP/Coach regression). Existing isolated worktree has hundreds of untracked task/cache artifacts from tests. Real Sidecar socket test EPERM at listen 127.0.0.1, probably sandbox restriction.

### HYPOTHESIS
Narrow operation-bound proof metadata handling and separated TASK control integrity checks will allow valid report-based evidence without exposing .devspace content. Internal SHA calculation in the freeze tool will simplify Web GPT. Filtering event delivery using validated Codex report status prevents spurious reviews.

### RATIONALE
Do only focused R1 repairs, preserving M1-M4 implementation and signed review safety.

## GOAL

G-01: Native runner shall record immutable evidence successfully for a legitimate frozen TASK.md and its own RESULT.json under .devspace/coach/tasks; all unrelated sensitive paths still reject.
G-02: Web GPT shall freeze TASK by task ID/relative path using server-calculated SHA and receive complete task reference; optional expected hash can guard race.
G-03: IN_PROGRESS must not be delivered as READY_FOR_GPT_REVIEW; PLAN_CONFLICT must reach correct Web GPT reviewer as a distinct actionable notice/status, and READY_FOR_REVIEW must retain signed review path and historical behavior.
G-04: Pass minimum relevant regressions and produce source-only isolated branch commit.

## CONTEXT

Current worktree /Users/liz/.devspace/worktrees/devspace-a4b09b5f, workspace ws_f30c1657-c452-40d4-a0e8-005b07757550, HEAD 6ec4ed3d74c084131d567a3e58120c29e23d54d1. Original approved full plan lives at .devspace/coach/tasks/DEVSPACE-COACH-CONTRACT-001/TASK.md. Existing docs: docs/DEVSPACE_COACH_CONTRACT_001.md. Likely files: src/codex-agent-runner.ts; src/coach-task-contract.ts; src/server/tools-codex-agent.ts; src/coach-review-events.ts; src/managed-coach-sidecar.ts; src/coach-realtime.ts and Chrome extension. Read AGENTS.md and related tests before edits. Production main has dirty user edits and other active jobs.

## SCOPE

Only fix evidence capture/control snapshot, server automatic hash freeze, browser/sidecar status routing, corresponding tests/docs. No production restart/deploy, no main modification, no push or merge. Do not bulk-clean untracked files. Preserve original TASK, logs, results and all other agents' work.

## IMPLEMENTATION

1. Reproduce the evidence-stage error exactly. Identify changed paths from native snapshot and git status. Implement exact operation-scoped exceptions for its own RESULT artifact and explicitly whitelisted hashed proof records, never inline raw .devspace sensitive content; preserve deny-by-default for arbitrary .devspace files, secrets and other operation reports. Check the separate taskControlSnapshot still detects unauthorized modifications and unsafe reports. Do not blanket-exclude .devspace or disable a security control. Add precise positive/negative native fake-agent integration tests for this incident. Avoid generated caches inside .devspace; if generated legacy caches exist, do not bulk delete.
2. Refactor codex_task_freeze so caller supplies workspaceId + taskId (optional requested version/expected sha), DevSpace securely reads and validates exact TASK file, calculates SHA-256, freezes immutable manifest, returns task reference. Existing full-reference calls may stay compatible. Reject optional wrong expected hash. Update Web GPT docs and tests.
3. Inspect real Chrome/Sidecar delivery path end-to-end. Do not enqueue IN_PROGRESS as a formal review. Separate distinct PLAN_CONFLICT feedback for Web GPT and preserve READY_FOR_REVIEW signed proof. Maintain historical queue compatibility and cross-tab workspace routing. Guard missing/invalid report and keep implementation concise.
4. Run npm run typecheck, npm run build, npm run test:coach:contract and targeted event tests. Rerun Sidecar socket test in allowed environment if possible, else record EPERM without claiming PASS. Commit only source/docs/tests, no generated temp files.

## ACCEPTANCE

A-01 -> G-01: Native fake-agent with TASK and own RESULT in .devspace achieves verified evidence; malicious changed .devspace, altered TASK, other op result/secret rejected.
A-02 -> G-02: Freeze by taskId returns exact SHA without Web GPT prehash; expected hash mismatch rejected with precise feedback.
A-03 -> G-03: IN_PROGRESS never triggers Chrome review; PLAN_CONFLICT reaches owner as distinct feedback; READY_FOR_REVIEW routes normally and legacy signed history remains valid.
A-04 -> G-04: Focused test, typecheck and build exit 0; isolated Git source commit, production main intact.

## TEST

Use existing targeted test script plus new native fixtures and Sidecar/Chrome event dataflow assertions, including negative mutation. npm run typecheck, npm run build, npm run test:coach:contract. Test runner logs and temp caches should remain away from sensitive .devspace controls and be disposed of narrowly. Sidecar EPERM must be identified as sandbox limitation and cannot be called app PASS without actual network proof.

## CONSTRAINTS

Do not edit production main, global skills, unrelated tasks, other working trees, secrets or signed reviews. No model-heavy unrelated test suites. Keep TASK and version hash immutable and no public validation bypass. Avoid excessive cache/test artifacts. This task is correction of already implemented system, not rewrite from scratch.

## DONE

When A-01..A-04 verified, commit scoped source changes on isolated branch and return commit, actual exit codes, test logs and remaining risks. If true external block report evidence. Not READY_FOR_REVIEW while acceptance incomplete.
