# Tasks

## Part 1: MCP-v1 Hardening P0

- [ ] Task 1.1: Full audit coverage — 在 `callTool()` 统一 wrapper 中确保所有工具调用（包括 read）都写 audit log
- [ ] Task 1.2: Atomic run lock — 使用 `fs.openSync(lockPath, "wx")` 替代 `existsSync+writeFileSync`，lock 文件包含 run_id/created_at/pid/mode/provider
- [ ] Task 1.3: Symlink-safe path — 在 `safePath()` 中对已存在路径使用 `realpathSync`，拒绝指向 `.devspace/` 外的 symlink
- [ ] Task 1.4: 添加 negative tests 覆盖 symlink traversal 和 atomic lock

## Part 2: Gated Web GPT Loop Tools

- [ ] Task 2.1: 实现 `create_handoff_from_webgpt` — 接收 Web GPT 生成的 handoff markdown/JSON，写入 `.devspace/ceo/`，必须 validate
- [ ] Task 2.2: 实现 `submit_coach_review` — 接收 CoachReview，检查 verdict/next_task/DONE 合同，生成相应 report
- [ ] Task 2.3: 实现 `create_next_task` — 从已验证 CoachReview 产生 next_task，写入 `.devspace/current_task.md`
- [ ] Task 2.4: 实现 `approve_next_run` — approval gate，对 run_id+task_hash 有效，任务变化后失效
- [ ] Task 2.5: 实现 `start_gated_loop` — 受控启动，需要 approval，支持 allow_real_free_mode 双重 gate
- [ ] Task 2.6: 实现 `get_gated_loop_status` — 返回当前 gated loop 状态、approval 状态、lock 状态

## Part 3: Real MCP JSON-RPC Smoke

- [ ] Task 3.1: 创建 `tests/mcp_jsonrpc_smoke.ps1` — 通过 stdin/stdout 发送 JSON-RPC 请求测试 MCP server
- [ ] Task 3.2: 覆盖 initialize、tools/list、validate_handoff、get_delegate_status、preview、start、timeline、artifacts、stop

## Part 4: Negative Tests

- [ ] Task 4.1: 创建 `tests/mcp_security_negative.ps1` — 12 个 negative test
- [ ] Task 4.2: 覆盖 path traversal、symlink、free mode gate、real provider gate、concurrent start、stale lock、missing verdict、PASS without next_task、stale approval、stop 后写入、unknown tool

## Part 5: Subagent Reviews

- [ ] Task 5.1: Tester review — handler smoke、JSON-RPC smoke、negative tests、audit coverage
- [ ] Task 5.2: Security review — API key leak、path traversal、symlink、lock atomicity、gates
- [ ] Task 5.3: Contract review — tool schema、error shape、CoachReview contract、approval gate
- [ ] Task 5.4: Red Team review — 越权启动、路径穿越、symlink、stale approval replay、race condition

## Part 6: Final Report

- [ ] Task 6.1: 运行所有测试命令
- [ ] Task 6.2: 输出 MCP-v2 final report

# Task Dependencies

- Part 2 depends on Part 1
- Part 3 depends on Part 1 + 2
- Part 4 depends on Part 1 + 2
- Part 5 depends on Part 3 + 4
- Part 6 depends on Part 5
