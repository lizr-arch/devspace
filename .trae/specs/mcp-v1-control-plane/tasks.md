# Tasks

## Phase 1: MCP Server Skeleton + Audit + Run Lock

- [ ] Task 1.1: Create `src/mcp/audit.ts` — audit log writer for `.devspace/mcp_audit.jsonl`
- [ ] Task 1.2: Create `src/mcp/schemas.ts` — Zod/JSON schemas for all MCP tool inputs/outputs
- [ ] Task 1.3: Create `src/mcp/tools.ts` — tool registry with name, description, inputSchema, handler ref
- [ ] Task 1.4: Create `src/mcp/handlers.ts` — handler implementations for all 13 tools (read-only + control)
- [ ] Task 1.5: Create `src/mcp/server.ts` — MCP server entry point (stdio transport)
- [ ] Task 1.6: Add run lock logic (`.devspace/run.lock`) — acquire/release/check in handlers
- [ ] Task 1.7: Add CLI commands: `devspace mcp serve`, `devspace mcp tools`, `devspace mcp smoke`

## Phase 2: Read-only MCP Tools

- [ ] Task 2.1: Implement `get_delegate_status` — read `.devspace/state.json`, return safe empty if missing
- [ ] Task 2.2: Implement `read_delegate_timeline` — read `.devspace/conversation.jsonl`
- [ ] Task 2.3: Implement `read_current_task` — read `.devspace/current_task.md` or `.devspace/ceo/first_task.md`
- [ ] Task 2.4: Implement `read_handoff_summary` — read handoff files, return summary
- [ ] Task 2.5: Implement `read_run_artifacts` — read files from `.devspace/runs/<run-id>/`
- [ ] Task 2.6: Implement `validate_handoff` — call existing validateHandoffPackage
- [ ] Task 2.7: Implement `list_runs` — list `.devspace/runs/` directories
- [ ] Task 2.8: Add path traversal protection to all file reads

## Phase 3: Controlled Write / Control Tools

- [ ] Task 3.1: Implement `preview_delegate_run` — check handoff, contract, task, provider availability
- [ ] Task 3.2: Implement `start_delegate_run` — with safety gates (mock default, free mode gate, real provider gate)
- [ ] Task 3.3: Implement `pause_delegate_run` — update state, write audit
- [ ] Task 3.4: Implement `resume_delegate_run` — update state, write audit
- [ ] Task 3.5: Implement `stop_delegate_run` — update state, write audit, release lock
- [ ] Task 3.6: Implement `answer_need_user` — write to `.devspace/user_answers/`, audit log

## Phase 4: MCP Smoke Tests

- [ ] Task 4.1: Create `tests/mcp_smoke.ps1` — 13 test cases calling real MCP handlers
- [ ] Task 4.2: Run all tests, fix failures

## Phase 5: Subagent Reviews

- [ ] Task 5.1: Tester subagent — review MCP smoke tests
- [ ] Task 5.2: Security reviewer subagent — review path traversal, API key leaks, gates
- [ ] Task 5.3: Contract reviewer subagent — review tool schemas, error shapes, CLI consistency

## Phase 6: Final Report

- [ ] Task 6.1: Run all existing tests (build, contract_audit, openai_e2e, mcp_smoke)
- [ ] Task 6.2: Output final MCP-v1 report with evidence

# Task Dependencies

- Phase 2 depends on Phase 1
- Phase 3 depends on Phase 1
- Phase 4 depends on Phase 2 + 3
- Phase 5 depends on Phase 4
- Phase 6 depends on Phase 5
