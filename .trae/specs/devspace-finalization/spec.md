# DEVSPACE Finalization Spec

## Why

Self-audit reveals 5 blocking gaps that prevent claiming "complete":
1. MCP cannot trigger orchestrator execution
2. Approval semantics inconsistent between start_delegate_run and start_gated_loop
3. Control tools (pause/resume/stop) have no run_token gate
4. create_next_task can fabricate tasks without review_id
5. Error envelope format inconsistent, no input size limits, no secret redaction

## What Changes

### Phase 1: Unified Approval
- Approval file gains: provider, mode, max_rounds, timeout, scope
- `approve_next_run` accepts these fields
- `consumeApproval` validates all fields
- Both start_delegate_run and start_gated_loop use same consumeApproval

### Phase 2: Execution Bridge
- New `run_orchestrator_step` MCP tool
- Calls LocalOrchestrator.executeSingleTask() directly
- Generates all artifacts (local_report, coach_review, final/blocked/next_task)
- Validates run_token before execution

### Phase 3: Control Token Gate
- pause/resume/stop require run_token or admin_override
- Schema updated for all three tools

### Phase 4: No-Fabrication
- create_next_task requires review_id
- submit_coach_review generates review_id
- current_task.md only writable via verified review chain

### Phase 5: Web GPT Full Loop E2E
- JSON-RPC test: handoff → approve → start → step → review → stop
- Real provider request_count verification

### Phase 6: Unified Error Envelope
- All tools return { ok, status, data, error, safety_flags }

### Phase 7: Input/Secret Hardening
- Input size limits (64KB handoff, 32KB task, 16KB answer)
- Secret redaction in audit args_summary

## Hard Constraint

unattended free mode 不开放。
