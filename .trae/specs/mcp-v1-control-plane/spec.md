# MCP-v1 Control Plane Spec

## Why

Delegate/Free Mode CLI mock 链路已跑通，OpenAI-compatible Provider mock HTTP E2E v4 已通过。需要实现 MCP 控制面，让外部 Coach GPT / Web GPT / MCP Client 可以通过 MCP 工具安全地查看、校验、预览、启动、暂停、停止 Delegate Run。

## What Changes

### MCP Server Skeleton
- 新增 `src/mcp/server.ts`、`tools.ts`、`schemas.ts`、`handlers.ts`、`audit.ts`
- CLI 增加 `devspace mcp serve`、`devspace mcp tools`、`devspace mcp smoke`

### Read-only MCP Tools
- `get_delegate_status`、`read_delegate_timeline`、`read_current_task`、`read_handoff_summary`、`read_run_artifacts`、`validate_handoff`、`list_runs`

### Controlled Write / Control Tools
- `preview_delegate_run`、`start_delegate_run`、`pause_delegate_run`、`resume_delegate_run`、`stop_delegate_run`、`answer_need_user`

### Run Lock + Audit Log
- `.devspace/mcp_audit.jsonl`、`.devspace/run.lock`

### MCP Smoke Tests
- 13 个真实 handler 测试用例

### Subagent Reviews
- Tester Review、Security Review、Contract Review

## Impact

- Affected specs: delegate-mode, provider-e2e
- Affected code: `src/mcp/` (new), `src/cli.ts` (add mcp commands), `.devspace/` (audit log, run lock)

## ADDED Requirements

### Requirement: MCP Server Skeleton
The system SHALL provide an MCP server entry point with tool listing, schema validation, and audit logging.

#### Scenario: Start MCP server
- **WHEN** user runs `devspace mcp serve`
- **THEN** MCP server starts and accepts tool calls

#### Scenario: List tools
- **WHEN** user runs `devspace mcp tools`
- **THEN** all available MCP tools are listed with schemas

### Requirement: Read-only MCP Tools
The system SHALL provide read-only tools that do not modify any state.

#### Scenario: get_delegate_status with no state
- **WHEN** no state.json exists
- **THEN** returns safe empty status

#### Scenario: Path traversal rejection
- **WHEN** tool input contains `../../package.json`
- **THEN** returns error, does not read file

### Requirement: Controlled Write Tools
The system SHALL provide control tools with safety gates.

#### Scenario: start_delegate_run defaults
- **WHEN** start_delegate_run called with no options
- **THEN** defaults to provider=mock, max_rounds=1, timeout=30, mode=delegate

#### Scenario: free mode gate
- **WHEN** start_delegate_run called with mode=free but allow_free_mode=false
- **THEN** returns rejection error

#### Scenario: real provider gate
- **WHEN** start_delegate_run called with provider=openai but allow_real_provider=false
- **THEN** returns rejection error

### Requirement: Run Lock
The system SHALL prevent concurrent delegate runs.

#### Scenario: Concurrent start prevention
- **WHEN** a run is already active
- **THEN** second start_delegate_run returns lock error

### Requirement: Audit Log
The system SHALL log every MCP tool call.

#### Scenario: Tool call logged
- **WHEN** any MCP tool is called
- **THEN** audit entry is appended to `.devspace/mcp_audit.jsonl`

## MODIFIED Requirements

None.

## REMOVED Requirements

None.
