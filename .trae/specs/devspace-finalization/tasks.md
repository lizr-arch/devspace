# Tasks

## Phase 1: Unified Approval

- [ ] Task 1.1: 修改 `approve_next_run` — 接收 provider/mode/max_rounds/timeout/scope 参数，写入 approval 文件
- [ ] Task 1.2: 修改 `consumeApproval` — 校验 task_hash + provider + mode + max_rounds + timeout + scope
- [ ] Task 1.3: 修改 `handleStartDelegateRun` — 使用 consumeApproval 替代文件存在性检查
- [ ] Task 1.4: 确认 `handleStartGatedLoop` 使用同一 consumeApproval
- [ ] Task 1.5: 新增 `tests/test_mcp_approval_unification.ts`

## Phase 2: Execution Bridge

- [ ] Task 2.1: 实现 `run_orchestrator_step` — 调用 LocalOrchestrator.executeSingleTask()
- [ ] Task 2.2: 校验 run_token + run.lock + state.status
- [ ] Task 2.3: 生成 local_report.md / coach_review.md / final_report.md / blocked_report.md / next_task.md
- [ ] Task 2.4: 新增 schema + dispatch
- [ ] Task 2.5: 新增 `tests/test_mcp_orchestrator_step.ts`

## Phase 3: Control Token Gate

- [ ] Task 3.1: pause/resume/stop 新增 run_token 参数
- [ ] Task 3.2: admin_override 参数 + safety_flags
- [ ] Task 3.3: 新增 `tests/test_mcp_control_token_gate.ts`

## Phase 4: No-Fabrication

- [ ] Task 4.1: submit_coach_review 生成 review_id
- [ ] Task 4.2: create_next_task 要求 review_id
- [ ] Task 4.3: 无 active run 时禁止写 task
- [ ] Task 4.4: 新增 `tests/test_mcp_no_fabrication.ts`

## Phase 5: Web GPT Full Loop E2E

- [ ] Task 5.1: 新增 `tests/test_webgpt_full_loop.ts` — JSON-RPC 完整链路

## Phase 6: Unified Error Envelope

- [ ] Task 6.1: 统一所有 tool 返回格式 { ok, status, data, error, safety_flags }
- [ ] Task 6.2: 更新所有测试

## Phase 7: Input/Secret Hardening

- [ ] Task 7.1: 输入大小限制
- [ ] Task 7.2: Secret redaction in audit
- [ ] Task 7.3: 新增 `tests/test_mcp_input_secret_hardening.ts`

## Phase 8: Subagent Reviews

- [ ] Task 8.1: Architect review
- [ ] Task 8.2: Tester review
- [ ] Task 8.3: Security review
- [ ] Task 8.4: Contract review
- [ ] Task 8.5: Red Team review

## Phase 9: Final Commands + Report

- [ ] Task 9.1: 运行所有 required commands
- [ ] Task 9.2: 输出 `reports/devspace_final_completion_report.md`

# Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
Phase 6 and 7 can run in parallel with Phase 3-5
Phase 8 depends on Phase 1-7
Phase 9 depends on Phase 8
