# Checklist

## Phase 1: MCP Server Skeleton

- [ ] `src/mcp/audit.ts` exists and writes to `.devspace/mcp_audit.jsonl`
- [ ] `src/mcp/schemas.ts` exists with all tool input/output schemas
- [ ] `src/mcp/tools.ts` exists with tool registry
- [ ] `src/mcp/handlers.ts` exists with all 13 tool handlers
- [ ] `src/mcp/server.ts` exists with MCP server entry point
- [ ] Run lock logic works (`.devspace/run.lock`)
- [ ] `devspace mcp serve` command works
- [ ] `devspace mcp tools` lists all tools
- [ ] `devspace mcp smoke` runs smoke tests

## Phase 2: Read-only Tools

- [ ] `get_delegate_status` returns safe empty when no state.json
- [ ] `read_delegate_timeline` reads conversation.jsonl
- [ ] `read_current_task` reads current_task.md or first_task.md
- [ ] `read_handoff_summary` returns summary
- [ ] `read_run_artifacts` reads run directory files
- [ ] `validate_handoff` calls existing validation
- [ ] `list_runs` lists run directories
- [ ] Path traversal `../../package.json` is rejected

## Phase 3: Control Tools

- [ ] `preview_delegate_run` checks without executing
- [ ] `start_delegate_run` defaults: provider=mock, max_rounds=1, timeout=30, mode=delegate
- [ ] `start_delegate_run` rejects free mode without `allow_free_mode`
- [ ] `start_delegate_run` rejects real provider without `allow_real_provider`
- [ ] `pause_delegate_run` updates state and audit
- [ ] `resume_delegate_run` updates state and audit
- [ ] `stop_delegate_run` updates state, audit, releases lock
- [ ] `answer_need_user` writes to user_answers/, not source code

## Phase 4: MCP Smoke Tests

- [ ] Test 1: mcp tools lists all tools
- [ ] Test 2: validate_handoff is read-only
- [ ] Test 3: get_delegate_status with no state.json
- [ ] Test 4: preview_delegate_run does not execute
- [ ] Test 5: start_delegate_run defaults to mock + max_rounds=1
- [ ] Test 6: free mode without allow_free_mode rejected
- [ ] Test 7: real provider without allow_real_provider rejected
- [ ] Test 8: start_delegate_run generates artifacts
- [ ] Test 9: pause/resume/stop updates state and audit
- [ ] Test 10: read_run_artifacts reads all report types
- [ ] Test 11: path traversal rejected
- [ ] Test 12: audit log has entries for all tool calls
- [ ] Test 13: run lock prevents concurrent start

## Phase 5: Subagent Reviews

- [ ] Tester review completed
- [ ] Security review completed
- [ ] Contract review completed

## Phase 6: Final Report

- [ ] `npm run build` passes
- [ ] `python tests/delegate/test_contract_audit.py` passes
- [ ] `powershell tests/openai_e2e_test.ps1` passes
- [ ] `powershell tests/mcp_smoke.ps1` passes
- [ ] Final MCP-v1 report output

## Hard Stop Conditions (must all be false)

- [ ] MCP start_delegate_run CANNOT bypass handoff validation
- [ ] MCP CANNOT directly modify source code
- [ ] free mode CANNOT start without allow_free_mode
- [ ] real provider CANNOT start without allow_real_provider
- [ ] run lock IS effective
- [ ] audit log IS recording
- [ ] path traversal IS blocked
- [ ] provider failure STOPS run
- [ ] stop DOES prevent continued writes
- [ ] MCP smoke tests test REAL handlers, not just helpers
