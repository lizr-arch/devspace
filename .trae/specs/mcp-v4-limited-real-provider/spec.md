# MCP-v4: Limited Real Provider Loop Spec

## Why

MCP-v3 签收为 PASS_WITH_WARNINGS。核心遗留问题：

1. **Run artifacts 无写入保护**：当前 run.lock 只防止并发启动，但不阻止已停止的旧 run 写入 artifact 文件。stop 后 token 失效机制缺失。
2. **Force recovery 无门槛**：`recover_stale_lock({ force: true })` 无条件删除锁，可被滥用删除活跃 lock。
3. **Real provider 无上限约束**：`start_gated_loop` 使用 real provider 时无 max_rounds/timeout 上限，可能导致无限运行或超时。
4. **Real provider E2E 未验证**：MCP JSON-RPC → real provider（mock HTTP）→ orchestrator 完整链路未测试。

## What Changes

### Part 1: Run Session Token / Write Guard
- 每个 run 创建 `run_token`（randomUUID）和 `run_token_hash`（sha256 前 16 位）
- `run.lock` 记录 `run_id`、`run_token_hash`、`pid`、`created_at`、`mode`、`provider`
- `start_delegate_run` / `start_gated_loop` 返回 `run_token` 给客户端
- 所有 run artifact 写入（`submit_coach_review`、`handleSubmitCoachReview` 内部写 local_report.md 等）前校验 run_token_hash
- `stop_delegate_run` 后 token 失效（lock 删除 + state 清除）
- 新增 `verify_run_token` MCP 工具，客户端可主动校验 token 是否仍有效
- Negative test：stop 后旧 token write 被拒绝

### Part 2: Force Recovery Gate
- `recover_stale_lock` 新增 `allow_force_recovery` 参数（boolean，必须为 true 才允许 force）
- `force: true` 且 `allow_force_recovery` 未设置时返回 REJECTED
- force recovery 写 `safety_flags: ["force_recovery"]`
- force recovery 记录 old lock 内容摘要到 audit

### Part 3: MCP-v4 Real Provider Controlled Run
- 默认仍然 `provider=mock`
- `start_gated_loop` 使用 real provider 时新增约束：
  - `max_rounds` 上限：2（默认 1）
  - `timeout` 上限：30 秒
  - 必须 `allow_real_provider=true`
  - 必须已有 approval
- `allow_real_free_mode=true` 时额外约束：`max_rounds` 必须为 1

### Part 4: Real Provider Smoke
- 使用本地 mock OpenAI-compatible HTTP server（Python，已有 `tests/mock_openai_server.py`）
- MCP JSON-RPC 调用链：initialize → tools/list → create_handoff → validate_handoff → approve → start_gated_loop(provider=openai) → read_delegate_timeline → read_run_artifacts → submit_coach_review(DONE) → stop
- 验证：request_count >= 1、local_report.md、coach_review.md、final_report.md 或 blocked_report.md、mcp_audit.jsonl、run_token 验证通过

### Part 5: Negative Tests
- openai without allow_real_provider → REJECTED
- openai + free without allow_real_free_mode → REJECTED
- force recovery without allow_force_recovery → REJECTED
- stop 后 old token write → REJECTED
- stale approval replay → REJECTED
- max_rounds > cap → REJECTED
- timeout > cap → REJECTED
- unknown JSON-RPC tool → structured error + audit

### Part 6: Subagent Reviews
- tests/mcp_v4_tests_review.md
- tests/mcp_v4_security_review.md
- tests/mcp_v4_contract_review.md
- tests/mcp_v4_redteam_review.md

## Impact

- Affected specs: mcp-v3-real-gated-loop, mcp-v2-gated-loop
- Affected code:
  - `src/mcp/handlers.ts` — run_token 生成、write guard、force recovery gate、real provider caps
  - `src/mcp/schemas.ts` — recover_stale_lock 新增 allow_force_recovery、verify_run_token 新 schema
  - `src/mcp/tools.ts` — callTool 可能需要传递 run_token context
  - `src/mcp/server.ts` — smoke test 升级
  - `tests/test_mcp_real_provider_loop.ts` — 新文件
  - `tests/test_mcp_write_guard.ts` — 新文件

## ADDED Requirements

### Requirement: Run Session Token
The system SHALL generate a unique run_token for each run and use it to guard artifact writes.

#### Scenario: Run creates token
- **WHEN** `start_delegate_run` or `start_gated_loop` succeeds
- **THEN** response SHALL include `run_token` and `run_token_hash`

#### Scenario: Write guard rejects stale token
- **WHEN** a write operation is attempted with an invalidated run_token
- **THEN** the write SHALL be rejected with status REJECTED

### Requirement: Force Recovery Gate
The system SHALL require explicit `allow_force_recovery=true` for force lock removal.

#### Scenario: Force without gate
- **WHEN** `recover_stale_lock` is called with `force: true` but without `allow_force_recovery: true`
- **THEN** the call SHALL be rejected

### Requirement: Real Provider Caps
The system SHALL enforce max_rounds and timeout limits for real provider runs.

#### Scenario: Rounds cap
- **WHEN** `start_gated_loop` with real provider and `max_rounds > 2`
- **THEN** the call SHALL be rejected

#### Scenario: Timeout cap
- **WHEN** `start_gated_loop` with real provider and `timeout > 30`
- **THEN** the call SHALL be rejected

## MODIFIED Requirements

### Requirement: recover_stale_lock (Modified from MCP-v3)
新增 `allow_force_recovery` 参数，force 路径需要此参数为 true。

### Requirement: start_gated_loop (Modified from MCP-v2)
Real provider 路径新增 max_rounds <= 2 和 timeout <= 30 约束。

## REMOVED Requirements

None.

## Hard Constraint

**unattended free mode 仍然不开放。** `allow_real_free_mode` gate 保留，不移除。real+free 时 `max_rounds` 必须为 1。
