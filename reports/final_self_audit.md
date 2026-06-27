# DEVSPACE Final Self-Audit

## 0.1 Architecture — True Link Status

```text
Web GPT / MCP Client
  │
  ▼
MCP JSON-RPC Server (stdin/stdout)                    [REAL] ✅
  │
  ▼
MCP Tools / Handlers (21 tools)                       [REAL] ✅
  │
  ├── state.json / run.lock / approval / audit        [REAL] ✅
  │
  ├── start_delegate_run / start_gated_loop           [PARTIAL] ⚠️
  │     Writes state.json + run.lock
  │     Does NOT spawn orchestrator
  │     Does NOT call provider
  │
  ├── submit_coach_review                             [REAL] ✅
  │     Writes artifacts with run_token guard
  │
  ├── read_delegate_timeline / read_run_artifacts     [REAL] ✅
  │
  └── stop / pause / resume                           [REAL] ✅ state only
        No run_token check on control ops

LocalOrchestratorV2                                   [REAL] ✅
  │
  ├── executeSingleTask()                             [REAL] ✅
  │     Calls ExecutorProvider.execute()
  │
  ├── runAutoLoop()                                   [REAL] ✅
  │     Calls executeSingleTask() + CoachReviewProvider.review()
  │
  └── ONLY invoked via CLI: devspace delegate run     [GAP] ⚠️
        NOT invoked by MCP tools

ExecutorProvider                                      [REAL] ✅
  ├── MockExecutorProvider                            [REAL] ✅
  ├── OllamaExecutorProvider                          [REAL] ✅
  └── OpenAICompatibleExecutorProvider                [REAL] ✅
        Makes real HTTP to /v1/chat/completions

CoachReviewProvider                                   [REAL] ✅
  ├── MockCoachReviewProvider                         [REAL] ✅
  ├── OllamaCoachReviewProvider                       [REAL] ✅
  └── OpenAICompatibleCoachReviewProvider             [REAL] ✅
        Makes real HTTP to /v1/chat/completions

Run Artifacts (local_report.md, coach_review.md, etc) [REAL] ✅
  Written by LocalOrchestratorV2

MCP Read Artifacts                                    [REAL] ✅
  read_run_artifacts reads from .devspace/runs/

Web GPT Review / Next Task                            [PARTIAL] ⚠️
  submit_coach_review can write next_task
  create_next_task can write current_task.md
  BUT: create_next_task has NO review_id validation
  AND: can write without active run
```

**Critical Gap**: MCP tools do NOT trigger LocalOrchestrator execution. `start_delegate_run` and `start_gated_loop` only write state files. The orchestrator is only invoked via `devspace delegate run` CLI. This means MCP cannot drive a complete loop autonomously.

## 0.2 Tool Inventory

| # | Tool | Type | Modifies State | Needs Approval | Needs run_token | Triggers Provider | Has Tests | Has Negative Tests |
|---|------|------|---------------|---------------|----------------|------------------|-----------|-------------------|
| 1 | get_delegate_status | read | no | no | no | no | ✅ | ✅ |
| 2 | read_delegate_timeline | read | no | no | no | no | ✅ | ✅ |
| 3 | read_current_task | read | no | no | no | no | ✅ | — |
| 4 | read_handoff_summary | read | no | no | no | no | ✅ | — |
| 5 | read_run_artifacts | read | no | no | no | no | ✅ | ✅ traversal |
| 6 | validate_handoff | read | no | no | no | no | ✅ | — |
| 7 | list_runs | read | no | no | no | no | ✅ | — |
| 8 | preview_delegate_run | read | no | no | no | no | ✅ | — |
| 9 | start_delegate_run | control+write | ✅ | ⚠️ checks file | no | ❌ NO | ✅ | ✅ |
| 10 | pause_delegate_run | control | ✅ | no | ❌ NO | no | ✅ | — |
| 11 | resume_delegate_run | control | ✅ | no | ❌ NO | no | ✅ | — |
| 12 | stop_delegate_run | control | ✅ | no | ❌ NO | no | ✅ | ✅ |
| 13 | answer_need_user | write | ✅ | no | no | no | ✅ | ✅ |
| 14 | create_handoff_from_webgpt | write | ✅ | no | no | no | ✅ | — |
| 15 | submit_coach_review | write | ✅ | no | ✅ YES | no | ✅ | ✅ |
| 16 | create_next_task | write | ✅ | ❌ NO | no | no | ✅ | ⚠️ partial |
| 17 | approve_next_run | write | ✅ | no | no | no | ✅ | ✅ |
| 18 | start_gated_loop | control+write | ✅ | ✅ consumeApproval | no | ❌ NO | ✅ | ✅ |
| 19 | get_gated_loop_status | read | no | no | no | no | ✅ | — |
| 20 | recover_stale_lock | recovery | ✅ | ⚠️ allow_force_recovery | no | no | ✅ | ✅ |
| 21 | verify_run_token | read | no | no | no | no | ✅ | ✅ |

**Key observations**:
- Tools 9, 18: write state but do NOT trigger provider/orchestrator
- Tools 10, 11, 12: no run_token gate
- Tool 16: no review_id validation, no active run requirement
- No tool triggers actual orchestrator execution

## 0.3 State Machine

```text
NO_STATE ──────────────────────────────────────────────────────┐
  │ start_delegate_run / start_gated_loop                      │
  ▼                                                            │
READY_TO_DELEGATE                                              │
  │ (internal transition)                                      │
  ▼                                                            │
DELEGATE_RUNNING                                               │
  │ pause_delegate_run                                         │
  ▼                                                            │
PAUSED ────────────── resume_delegate_run ──→ DELEGATE_RUNNING │
  │                                                           │
  │ (orchestrator executes)                                    │
  ▼                                                            │
LOCAL_EXECUTING                                                │
  │ (orchestrator generates report)                            │
  ▼                                                            │
LOCAL_REPORTED                                                 │
  │ coach review                                              │
  ▼                                                            │
DONE ◄─── stop_delegate_run (from any state)                  │
BLOCKED                                                        │
NEED_USER                                                      │
SAFETY_STOP                                                    │
BUDGET_STOP                                                    │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

**Current MCP tools can transition**:
- `start_delegate_run` / `start_gated_loop`: NO_STATE → DELEGATE_RUNNING
- `pause_delegate_run`: DELEGATE_RUNNING → PAUSED (no status check!)
- `resume_delegate_run`: PAUSED → DELEGATE_RUNNING (no status check!)
- `stop_delegate_run`: any → DONE (no status check!)
- `submit_coach_review`: writes artifacts (no state transition)

**Gap**: No tool transitions to LOCAL_EXECUTING or LOCAL_REPORTED. Only the CLI-spawned orchestrator does that.

## 0.4 Known Gaps — Honest Answers

### Q1: Does start_delegate_run really consumeApproval?
**A: NO.** It checks if an approval file EXISTS but does NOT call `consumeApproval()`. The approval file is NOT marked as used. It can be reused.

### Q2: Does start_gated_loop really consumeApproval?
**A: YES.** It calls `consumeApproval(taskHash)` which marks the approval as used.

### Q3: Are the two approval binding fields consistent?
**A: NO.** `start_gated_loop` uses `consumeApproval` with task_hash only. `start_delegate_run` checks file existence with task_hash only. Neither checks provider/mode/max_rounds/timeout.

### Q4: Does start_gated_loop only write state.json / run_state.json?
**A: YES.** It does NOT spawn the orchestrator or call any provider.

### Q5: Does run_orchestrator_step exist?
**A: NO.** There is no tool that triggers orchestrator execution.

### Q6: Can MCP truly call LocalOrchestrator.runAutoLoop or step?
**A: NO.** The MCP tools only manage state files. The orchestrator is only invoked via `devspace delegate run` CLI.

### Q7: Is real provider mock HTTP request_count from Provider calls?
**A: YES, but indirectly.** The test spawns the orchestrator via CLI (`devspace delegate run --provider openai`), which calls the provider. The MCP `start_gated_loop` does NOT trigger the provider.

### Q8: Can submit_coach_review write current_task.md without active run?
**A: PARTIALLY.** The write guard checks run.lock. If no lock exists, it rejects. But if a lock exists from a different tool call, it could pass.

### Q9: Can create_next_task bypass CoachReview contract?
**A: YES.** `create_next_task` can write `current_task.md` at any time without any review_id validation. It only checks `task_content` is provided.

### Q10: Do stop/pause/resume need run_token or admin gate?
**A: NO.** They don't check run_token at all.

### Q11: Does force recovery have allow_force_recovery and audit?
**A: YES.** Force requires `allow_force_recovery: true`, writes `safety_flags: ["force_recovery"]`, and logs old lock summary.

### Q12: Is stale approval rejected?
**A: YES.** `consumeApproval` checks task_hash match. If task changed, hash doesn't match → REJECTED.

### Q13: Is used approval rejected?
**A: YES.** `consumeApproval` checks `used !== true`.

### Q14: Is approval bound to provider/mode/max_rounds/timeout/task_hash?
**A: NO.** Only task_hash is checked. Provider/mode/max_rounds/timeout are NOT in the approval file.

### Q15: Can stopped run still write artifacts?
**A: NO for submit_coach_review** (write guard checks lock). **YES for create_next_task** (no guard).

### Q16: Can audit log reconstruct full causal chain?
**A: PARTIALLY.** Has event_id, parent_event_id, tool name, args_summary, result_status. But no run_id correlation across all entries.

### Q17: Are all MCP JSON-RPC errors structured?
**A: YES.** Parse error (-32700), Method not found (-32601), Invalid params (-32602) all implemented.

### Q18: Do all artifact writes have write guard?
**A: NO.** Only `submit_coach_review` has write guard. `create_next_task`, `create_handoff_from_webgpt`, `approve_next_run` do NOT.

### Q19: Are all shell/command capabilities still blocked?
**A: YES.** No MCP tool exposes shell execution.

### Q20: Is there API key / env leakage?
**A: NO in tool responses.** But `args_summary` in audit may contain sensitive data if passed as args.

## 0.5 Self-Audit Conclusion

```text
Overall: PASS_WITH_WARNINGS

Can enter final implementation: YES (with mandatory fixes)

Blocking gaps (P0):
1. MCP cannot trigger orchestrator execution (no run_orchestrator_step)
2. start_delegate_run does not consumeApproval (only checks file existence)
3. Approval file lacks provider/mode/max_rounds/timeout fields
4. create_next_task can fabricate tasks without review_id
5. pause/resume/stop have no run_token gate

Non-blocking gaps (P1):
1. submit_coach_review can write next_task without review_id binding
2. Error envelope format inconsistent across tools
3. No input size limits
4. Audit args_summary may leak secrets
5. create_next_task can write current_task.md without active run

Recommended execution plan:
Phase 1: Unified approval (provider/mode/max_rounds/timeout in approval file)
Phase 2: Execution bridge (run_orchestrator_step that calls LocalOrchestrator)
Phase 3: Control tools run_token/admin gate
Phase 4: No-fabrication contract (review_id binding)
Phase 5: Web GPT full loop E2E
Phase 6: Unified error envelope
Phase 7: Input/secret hardening
Phase 8: Reviews
Phase 9: Final commands + report
```
