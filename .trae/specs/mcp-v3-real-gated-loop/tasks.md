# Tasks

## Part 1: Audit Upgrade (UI-ready Audit)

- [x] Task 1.1: 升级 `src/mcp/audit.ts` — `AuditEntry` 新增 `event_id`（UUID v4）、`parent_event_id`（可选）；`result_status` 改为枚举类型 `OK | ERROR | REJECTED | RECOVERED | UNKNOWN_TOOL`；`createAuditEntry()` 自动生成 `event_id`
- [x] Task 1.2: 清理 `src/mcp/handlers.ts` — 移除所有 handler 内部的 `writeAudit()` / `createAuditEntry()` 调用（38 处），审计全部由 `callTool()` 统一处理
- [x] Task 1.3: 更新 `src/mcp/tools.ts` — `callTool()` 中统一使用新版 `createAuditEntry()`，传入正确的 `resultStatus` 枚举值；添加 `parent_event_id` 参数支持（UUID 格式校验）

## Part 2: Stale Lock Recovery

- [x] Task 2.1: 实现 `handleRecoverStaleLock` — 在 `src/mcp/handlers.ts` 中新增：读取 `run.lock`，检查 pid 是否存活（`process.kill(pid, 0)`），检查 `created_at` 是否超过 TTL（默认 300s），满足任一条件则删除 lock 并返回 `RECOVERED`，否则返回 `REJECTED`
- [x] Task 2.2: 在 `src/mcp/schemas.ts` 中添加 `recover_stale_lock` schema — 参数：`ttl_seconds?: number`（默认 300）、`force?: boolean`（强制删除，跳过 pid 检查）
- [x] Task 2.3: 在 `src/mcp/handlers.ts` 的 `handleToolCall` dispatch 中注册 `recover_stale_lock`

## Part 3: Smoke Test 升级

- [x] Task 3.1: 更新 `src/mcp/server.ts` 的 `runSmoke()` — tools/list 返回 20 个工具（含 `recover_stale_lock`）；新增 `recover_stale_lock` 的 5 个测试路径（dead pid、no lock、TTL expired、active lock、force）
- [x] Task 3.2: 在 `runSmoke()` 中增加完整生命周期测试 — `start → pause → resume → stop`；增加 `stop → stop`（idempotent）
- [x] Task 3.3: 在 `runSmoke()` 中增加 negative tests — lock 已存在时 start 拒绝、missing verdict 拒绝、PASS without next_task 拒绝、stale approval 拒绝、unknown tool 结构化错误、answer_need_user 输入校验

## Part 4: Real JSON-RPC MCP Smoke

- [x] Task 4.1: 创建 `tests/test_mcp_jsonrpc.ts` — 通过 `child_process.spawn` 启动 MCP server；通过 stdin 发送 JSON-RPC 行，从 stdout 读取响应行
- [x] Task 4.2: 覆盖 JSON-RPC 测试用例 — initialize（验证 protocolVersion）、tools/list（验证工具数量）、tools/call get_delegate_status、tools/call validate_handoff、tools/call preview_delegate_run、tools/call start_delegate_run（mock）、tools/call stop_delegate_run、错误格式 JSON（Parse error）、未知方法（Method not found）

## Part 5: Gated Loop E2E Simulation

- [x] Task 5.1: 创建 `tests/test_gated_loop_e2e.ts` — 端到端模拟完整 gated loop：create_handoff_from_webgpt → approve_next_run → start_gated_loop(mock) → submit_coach_review(PASS + next_task) → create_next_task → approve_next_run → start_gated_loop(第二轮) → stop
- [x] Task 5.2: 验证 approval 消费机制 — 第一次 approve → start 后 approval 被消费；第二次 start 需要重新 approve；task 变化后旧 approval 的 task_hash 不匹配

## Part 6: Subagent Reviews

- [x] Task 6.1: Tester review — PASS（20 工具全覆盖、audit event_id 正确、stale lock 5 路径、gated loop E2E）
- [x] Task 6.2: Security review — PASS_WITH_WARNINGS（force 需 safety_flags 已修复、parent_event_id 需 UUID 校验已修复）
- [x] Task 6.3: Contract review — PASS_WITH_WARNINGS（tools/call 需 params.name 校验已修复、require() 已修复）
- [x] Task 6.4: Red Team review — PASS（无可利用漏洞）

## Part 7: Final Report

- [x] Task 7.1: 运行 `npx tsx src/cli.ts mcp smoke` — 41/41 passed
- [x] Task 7.2: 运行 `npx tsx tests/test_mcp_jsonrpc.ts` — 10/10 passed
- [x] Task 7.3: 运行 `npx tsx tests/test_gated_loop_e2e.ts` — 16/16 passed
- [x] Task 7.4: 输出 MCP-v3 final report

# Task Dependencies

- Part 1 (Audit Upgrade) 无依赖，可立即开始 ✅
- Part 2 (Stale Lock Recovery) 依赖 Part 1（audit 格式）✅
- Part 3 (Smoke 升级) 依赖 Part 1 + 2 ✅
- Part 4 (JSON-RPC Smoke) 依赖 Part 1 + 2 ✅
- Part 5 (Gated Loop E2E) 依赖 Part 1 + 2 ✅
- Part 6 (Reviews) 依赖 Part 3 + 4 + 5 ✅
- Part 7 (Final Report) 依赖 Part 6 ✅
