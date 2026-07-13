# Tasks

## Part 1: Run Session Token / Write Guard

- [x] Task 1.1: 修改 `acquireRunLock` — 生成 `run_token`（randomUUID）和 `run_token_hash`（sha256 前 16 位），写入 run.lock
- [x] Task 1.2: 修改 `handleStartDelegateRun` — 返回 `run_token` 和 `run_token_hash`
- [x] Task 1.3: 修改 `handleStartGatedLoop` — 返回 `run_token` 和 `run_token_hash`
- [x] Task 1.4: 实现 `verifyRunToken` — 读取 run.lock，比较 token_hash，返回有效/无效
- [x] Task 1.5: 在 `handleSubmitCoachReview` 中添加 write guard — 写 artifact 前校验 run_token_hash
- [x] Task 1.6: 添加 `verify_run_token` schema 到 `schemas.ts`，注册到 dispatch
- [x] Task 1.7: 在 smoke test 中添加 negative test — stop 后旧 token write 被拒绝

## Part 2: Force Recovery Gate

- [x] Task 2.1: 修改 `handleRecoverStaleLock` — force 路径检查 `args.allow_force_recovery === true`，否则 REJECTED
- [x] Task 2.2: 修改 recover_stale_lock schema — 新增 `allow_force_recovery` 参数
- [x] Task 2.3: force recovery 写 `safety_flags: ["force_recovery"]` 并记录 old lock 摘要；ttl_seconds 最小值 60s

## Part 3: Real Provider Caps

- [x] Task 3.1: 修改 `handleStartGatedLoop` — real provider 路径新增 `max_rounds <= 2` 和 `timeout <= 30` 检查
- [x] Task 3.2: 修改 `handleStartDelegateRun` — real provider 路径新增相同 caps + approval 检查
- [x] Task 3.3: real+free 路径额外约束 `max_rounds` 必须为 1

## Part 4: Smoke Test 升级

- [x] Task 4.1: 更新 smoke test — force recovery gate（无 allow_force_recovery 拒绝、有 allow_force_recovery 通过）
- [x] Task 4.2: 更新 smoke test — real provider caps（max_rounds > 2 拒绝、timeout > 30 拒绝）
- [x] Task 4.3: 更新 smoke test — verify_run_token（有效 token 通过、无效 token 拒绝）

## Part 5: Real Provider Smoke Test

- [x] Task 5.1: 创建 `tests/test_mcp_real_provider_loop.ts` — 启动 mock OpenAI server + MCP JSON-RPC 完整链路
- [x] Task 5.2: 验证 request_count >= 1、local_report.md、coach_review.md、final_report.md/blocked_report.md、mcp_audit.jsonl、run_token 验证

## Part 6: Write Guard Test

- [x] Task 6.1: 创建 `tests/test_mcp_write_guard.ts` — 14 tests covering token lifecycle
- [x] Task 6.2: 并发 start 竞争测试

## Part 7: Negative Tests

- [x] Task 7.1: 8 个 negative tests 在 smoke test 中 — openai without allow_real_provider、openai+free without allow_real_free_mode、force recovery without allow_force_recovery、stop 后 old token write、stale approval replay、max_rounds > cap、timeout > cap、unknown tool

## Part 8: Subagent Reviews

- [x] Task 8.1: Tester review — PASS
- [x] Task 8.2: Security review — PASS_WITH_WARNINGS（ttl_seconds 下限 + start_delegate_run approval 已修复）
- [x] Task 8.3: Contract review — PASS
- [x] Task 8.4: Red Team review — PASS_WITH_WARNINGS（同上两项已修复）

## Part 9: Final Report

- [x] Task 9.1: 运行所有 required commands 并确认通过
- [x] Task 9.2: 输出 MCP-v4 final report
