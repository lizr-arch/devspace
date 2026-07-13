# Checklist

## Part 1: Run Session Token / Write Guard

- [ ] `acquireRunLock` 生成 `run_token` 和 `run_token_hash`
- [ ] `run.lock` 包含 `run_token_hash` 字段
- [ ] `start_delegate_run` 返回 `run_token` 和 `run_token_hash`
- [ ] `start_gated_loop` 返回 `run_token` 和 `run_token_hash`
- [ ] `verify_run_token` 工具正确校验 token
- [ ] `submit_coach_review` 写 artifact 前校验 run_token
- [ ] stop 后旧 token write 被拒绝
- [ ] smoke test 中 negative test 通过

## Part 2: Force Recovery Gate

- [ ] `recover_stale_lock` schema 包含 `allow_force_recovery` 参数
- [ ] `force: true` 且无 `allow_force_recovery` 时返回 REJECTED
- [ ] `force: true` 且 `allow_force_recovery: true` 时正常恢复
- [ ] force recovery 写 `safety_flags: ["force_recovery"]`
- [ ] force recovery audit 包含 old lock 摘要

## Part 3: Real Provider Caps

- [ ] `start_gated_loop` real provider `max_rounds > 2` 被拒绝
- [ ] `start_gated_loop` real provider `timeout > 30` 被拒绝
- [ ] `start_delegate_run` real provider 同样有 caps
- [ ] real+free 路径 `max_rounds` 必须为 1

## Part 4: Smoke Test

- [ ] force recovery gate negative test 通过
- [ ] real provider caps negative test 通过
- [ ] verify_run_token 测试通过
- [ ] 现有 41 smoke tests 不回归

## Part 5: Real Provider Smoke

- [ ] mock OpenAI server 启动成功
- [ ] MCP JSON-RPC → real provider 完整链路通过
- [ ] request_count >= 1
- [ ] local_report.md 存在
- [ ] coach_review.md 存在
- [ ] final_report.md 或 blocked_report.md 存在
- [ ] mcp_audit.jsonl 存在且有 event_id
- [ ] run_token 验证通过

## Part 6: Write Guard Test

- [ ] start → token 有效 → stop → token 无效
- [ ] stop 后 submit_coach_review 被拒绝
- [ ] concurrent start 只有一个成功

## Part 7: Negative Tests

- [ ] openai without allow_real_provider → REJECTED
- [ ] openai+free without allow_real_free_mode → REJECTED
- [ ] force recovery without allow_force_recovery → REJECTED
- [ ] stop 后 old token write → REJECTED
- [ ] stale approval replay → REJECTED
- [ ] max_rounds > cap → REJECTED
- [ ] timeout > cap → REJECTED
- [ ] unknown tool → structured error + audit

## Part 8: Subagent Reviews

- [ ] Tester review PASS
- [ ] Security review PASS
- [ ] Contract review PASS
- [ ] Red Team review PASS

## Hard Stop Conditions (must all be false)

- [ ] unattended free mode 被开放
- [ ] run_token 可被伪造绕过
- [ ] force recovery 无门槛可用
- [ ] real provider 无上限约束
- [ ] 现有 smoke test 回归失败
- [ ] write guard 无法阻止 stop 后写入
