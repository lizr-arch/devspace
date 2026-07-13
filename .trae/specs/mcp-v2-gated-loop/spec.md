# MCP-v2: Gated Web GPT Loop + Safety Hardening Spec

## Why

MCP-v1 Control Plane 已签收为 PASS_WITH_WARNINGS，但存在 3 个 warning：audit log 不完整、run.lock TOCTOU 竞态、symlink 路径风险。需要硬化安全性并实现 gated Web GPT loop，让 MCP Client 能安全地进行多轮 delegate run。

## What Changes

### Part 1: MCP-v1 Hardening
- Full audit coverage（所有工具调用都审计）
- Atomic run lock（fs.openSync "wx" 替代 existsSync+writeFileSync）
- Symlink-safe path（realpathSync 检查）

### Part 2: Gated Web GPT Loop Tools
- `create_handoff_from_webgpt`
- `submit_coach_review`
- `create_next_task`
- `approve_next_run`
- `start_gated_loop`
- `get_gated_loop_status`

### Part 3: Real MCP JSON-RPC Smoke
- 通过 stdin/stdout 发送 JSON-RPC 请求测试 MCP server

### Part 4: Negative Tests
- 12 个 negative test 覆盖

### Part 5: Subagent Reviews
- Tester、Security、Contract、Red Team

## Impact

- Affected specs: mcp-v1-control-plane
- Affected code: `src/mcp/` (handlers, audit, tools, server), `tests/`

## ADDED Requirements

### Requirement: Full Audit Coverage
The system SHALL log every MCP tool call including read operations.

### Requirement: Atomic Run Lock
The system SHALL use atomic file creation to prevent concurrent run races.

### Requirement: Symlink-safe Path
The system SHALL reject symlink paths that point outside `.devspace/`.

### Requirement: Gated Web GPT Loop
The system SHALL provide tools for Web GPT to safely participate in multi-round delegate runs.

### Requirement: Approval Gate
The system SHALL require explicit approval before starting real runs.

## MODIFIED Requirements

None.

## REMOVED Requirements

None.
