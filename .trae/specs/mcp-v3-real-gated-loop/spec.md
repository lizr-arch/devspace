# MCP-v3: Real Gated Loop + Stale Lock Recovery + Audit Upgrade Spec

## Why

MCP-v2 签收为 PASS_WITH_WARNINGS，核心功能已全部实现（19 工具、atomic lock、symlink-safe path、gated loop、完整审计）。但子审查发现以下遗留问题需要在 v3 中解决：

1. **测试覆盖不足**：现有 smoke 直接调 `handleToolCall()` 绕过 JSON-RPC 协议层和 `callTool()` 审计路径；缺少真实 JSON-RPC stdin/stdout 测试
2. **Stale lock 无法恢复**：如果 MCP server 崩溃，`run.lock` 残留导致后续 run 全部被拒绝，无恢复机制
3. **审计日志不可 UI 化**：缺少 `event_id` 去重、`parent_event_id` 请求链追踪、统一的 `result_status` 枚举
4. **Gated loop 端到端未验证**：create_handoff → approve → start_gated_loop → submit_coach_review 完整链路未被集成测试
5. **Negative test 缺口**：tests_review 指出 lock 竞争、missing handoff、输入校验等关键拒绝路径未覆盖

## What Changes

### Part 1: Stale Lock Recovery
- 新增 `recover_stale_lock` MCP 工具
- 基于 pid 存活检测 + TTL 超时双重判定
- 记录 recovery 原因到 audit log

### Part 2: Audit Dedup / UI-ready Audit
- audit 条目新增 `event_id`（UUID v4）用于去重
- audit 条目新增 `parent_event_id` 关联请求链
- 统一 `result_status` 为枚举：`OK | ERROR | REJECTED | RECOVERED | UNKNOWN_TOOL`
- handlers 内部不再重复写 audit（由 `callTool()` 统一写入）

### Part 3: Real JSON-RPC MCP Smoke
- 新增 `tests/test_mcp_jsonrpc.ts` 测试脚本
- 通过 `child_process.spawn` 启动 MCP server 进程
- 通过 stdin/stdout 发送 JSON-RPC 请求，验证协议层端到端
- 覆盖 `initialize`、`tools/list`、`tools/call`（每个工具至少一次）

### Part 4: Web GPT Gated Loop Simulation
- 端到端测试完整 gated loop 流程
- create_handoff_from_webgpt → approve_next_run → start_gated_loop → submit_coach_review(PASS) → create_next_task → approve_next_run → start_gated_loop(下一轮)
- 验证 approval 消费、task_hash 变化后旧 approval 失效

### Part 5: Negative Tests
- 补充 10+ negative test 场景到现有 smoke test 或新测试脚本
- 覆盖：stale lock recovery、symlink traversal、free mode/real provider/real+free gate、concurrent start、PASS without next_task、stale approval replay、stop 后写入、missing verdict、unknown tool

### Part 6: Subagent Reviews
- Tester review：验证测试覆盖率和质量
- Security review：验证新功能安全性（stale lock recovery、audit 去重）
- Contract review：验证新工具 schema 和行为一致性
- Red Team review：验证越权和绕过场景

## Impact

- Affected specs: mcp-v2-gated-loop, mcp-v1-control-plane
- Affected code:
  - `src/mcp/audit.ts` — 新增 event_id、parent_event_id、枚举化 result_status
  - `src/mcp/handlers.ts` — 新增 `handleRecoverStaleLock`、移除内部重复 audit 调用
  - `src/mcp/tools.ts` — `callTool()` 中统一审计使用新 audit 格式
  - `src/mcp/schemas.ts` — 新增 `recover_stale_lock` schema
  - `src/mcp/server.ts` — 更新 smoke test 覆盖新工具和 negative cases
  - `tests/` — 新增 JSON-RPC smoke 测试和 gated loop 模拟测试

## ADDED Requirements

### Requirement: Stale Lock Recovery
The system SHALL provide a `recover_stale_lock` tool that removes stale run.lock files based on pid liveness check and configurable TTL.

#### Scenario: Lock owner process dead
- **WHEN** `run.lock` exists AND lock pid is not alive
- **THEN** lock SHALL be removed and recovery logged

#### Scenario: Lock TTL expired
- **WHEN** `run.lock` exists AND lock age exceeds TTL (default 300s)
- **THEN** lock SHALL be removed and recovery logged

#### Scenario: Lock still valid
- **WHEN** `run.lock` exists AND lock pid is alive AND TTL not expired
- **THEN** lock SHALL NOT be removed and error returned

### Requirement: UI-ready Audit
The system SHALL emit structured audit entries with deduplication and request chain tracing.

#### Scenario: Every tool call produces audit entry
- **WHEN** any tool is called via `callTool()`
- **THEN** exactly one audit entry with `event_id` SHALL be written

#### Scenario: Audit entries are deduplicatable
- **WHEN** audit entries are written
- **THEN** each entry SHALL have a unique `event_id` (UUID v4)

### Requirement: Real JSON-RPC Protocol Test
The system SHALL be testable through actual JSON-RPC stdin/stdout communication.

#### Scenario: MCP server responds to initialize
- **WHEN** JSON-RPC `initialize` request is sent via stdin
- **THEN** server SHALL respond with `protocolVersion` and `capabilities`

#### Scenario: MCP server lists all tools
- **WHEN** JSON-RPC `tools/list` request is sent
- **THEN** server SHALL respond with all 20 registered tools (19 existing + 1 new)

### Requirement: Gated Loop E2E Simulation
The system SHALL support a complete gated loop lifecycle test.

#### Scenario: Full gated loop round
- **WHEN** client creates handoff, approves run, starts gated loop, submits coach review with PASS
- **THEN** all steps SHALL succeed and produce correct artifacts

## MODIFIED Requirements

### Requirement: Audit Entry Format (Modified from MCP-v2)
The audit entry format SHALL be extended with `event_id`, `parent_event_id`, and enum-validated `result_status`.

### Requirement: Handler Audit Dedup (Modified from MCP-v2)
Handler internal `writeAudit()` calls in `handlers.ts` SHALL be removed; all audit writes SHALL go through `callTool()` in `tools.ts` only.

## REMOVED Requirements

None.

## Hard Constraint

**unattended free mode 仍然不开放。** `allow_real_free_mode` gate 保留，不移除。
