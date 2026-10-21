---
name: devspace-webgpt-coach
description: Use when Web GPT develops, dispatches, reviews, or resumes native Codex CLI tasks through DevSpace Coach. Full TASK.md is mandatory; use frozen document/version, structured results and independent review.
---

# DevSpace Web GPT Coach — Document-Driven Contract

For DevSpace-managed native Codex development, **never send a compressed stage prompt as the authority**. Full user-approved TASK.md is the single authoritative development contract. DevSpace transports/validates it; Codex reads and independently checks WHY before development; Web GPT reviews real changes and evidence.

## Required workflow

1. Identify the precise authorized workspaceId for THIS conversation/task. Reuse existing workspace; do not guess the most recent one and do not route notifications from other chats.
2. Discuss and approve technical approach with user, then write `.devspace/coach/tasks/<taskId>/TASK.md` within that workspace. Use YAML `schema: DEVSPACE_TASK_V1`, `task_id`, `task_type`, and integer `version`. Provide exactly one nonempty H2 of each: WHY, GOAL, CONTEXT, SCOPE, IMPLEMENTATION, ACCEPTANCE, TEST, CONSTRAINTS, DONE.
3. WHY must contain H3 PROBLEM, EVIDENCE, HYPOTHESIS, RATIONALE. Distinguish observed facts from guesses. Add numbered GOAL `G-01: ...` and numbered ACCEPTANCE `A-01 -> G-01: ...` with full coverage. Explain real test methods and provenance; code compilation alone is not game-level acceptance.
4. Run `codex_task_freeze` with workspaceId and taskId. **DevSpace computes the SHA-256** and returns the exact {workspaceId,taskId,taskPath,version,sha256} reference. Resolve actionable TASK gate errors (keyword, reason, remediation) by fixing TASK and re-freezing; do not launch on rejection. Never invent hashes or use an unchecked shortcut.
5. Start developer Codex via `codex_agent_start` with that exact frozen `task` reference. Other required arguments: operationId, model, reasoningEffort, sandbox, optional stageId. The generated bootstrap instructs full reading of TASK and AGENTS. Any separate prompt is supplemental only. Every rework and Coach stage carries a task reference and same version or an explicitly revised version. Do not modify an authoritative TASK silently.
6. Follow native status/evidence. Codex returns DEVSPACE_CODEX_REPORT_V1 with exactly one of IN_PROGRESS / READY_FOR_REVIEW / PLAN_CONFLICT / BLOCKED. Its report must match task version/operation/stage and actual immutable test artifacts. A successful Codex process or report claim is **not** independent proof.
7. For IN_PROGRESS, use bounded safe continuation, not APPROVED or REWORK. For PLAN_CONFLICT read actual counter-evidence before revising the task; route to designing Web GPT, not formal signed verdict. For BLOCKED identify the external impediment. For READY_FOR_REVIEW inspect Git diff, immutable native packet, actual test results and state, then submit only evidence-supported APPROVED / REWORK / BLOCKED with the existing signed review mechanism.
8. Only user-authorized, verified workspaces may be bound to a ChatGPT tab. Use `coach_webgpt_claim_browser_route` only after the explicit one-click request from THIS conversation gives a nonce, canonical chat URL and the authorized matching workspaceId; confirm binding only after `claimed=true`. If tool unavailable, report unavailable without fabricating success.
9. Production safety: do not overwrite dirty main, restart a service while running jobs, remove unrelated worktrees, install globally, or deploy until owner handoffs and a rollback/preflight are verified. Maintain only minimum targeted tests; preserve raw evidence and status.

## Version and tool availability

This skill documents the **new source contract**, not the currently deployed DevSpace. If `devspace_info` lists an older 86-tool schema, `codex_task_freeze` and `coach_webgpt_claim_browser_route` may not yet be callable. Never claim a release or route binding succeeded from source inspection or unit tests. Production adoption needs the code merged, built, restarted, rediscovered by ChatGPT, and a real one-click/handoff smoke.

Detailed contract and errors: `docs/DEVSPACE_COACH_CONTRACT_001.md` (read from repository root when needed). This checked-in skill is a **repository default**; it does not update a user's global Codex skill installation automatically.
