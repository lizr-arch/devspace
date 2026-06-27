# DevSpace v0.1.0-rc1 Release Notes

**Release Date:** 2026-06-27
**Verdict:** PASS_WITH_WARNINGS

---

## What Is DevSpace?

DevSpace is a secure local coding workspace exposed through an MCP (Model Context Protocol) server. It enables AI agents (Web GPT, ChatGPT, Claude) to execute tasks on your local machine through a gated, audited, human-in-the-loop workflow.

---

## Key Features

### 22 MCP Tools

- **Status:** `get_delegate_status`
- **Read:** `read_delegate_timeline`, `read_current_task`, `read_handoff_summary`, `read_run_artifacts`, `validate_handoff`, `list_runs`, `preview_delegate_run`
- **Control:** `start_delegate_run`, `pause_delegate_run`, `resume_delegate_run`, `stop_delegate_run`, `answer_need_user`
- **Write:** `create_handoff_from_webgpt`, `submit_coach_review`, `create_next_task`
- **Approval:** `approve_next_run`
- **Loop:** `start_gated_loop`, `get_gated_loop_status`
- **Recovery:** `recover_stale_lock`
- **Auth:** `verify_run_token`
- **Execution:** `run_orchestrator_step`

### Safety Model

- **Approval gate:** Every loop requires human approval via `approve_next_run` before execution
- **Run session tokens:** UUID-based tokens with SHA-256 hash storage, required for all write operations
- **No-fabrication contract:** `create_next_task` requires a `review_id` from coach review
- **Mode caps:** Real providers capped at max_rounds=2, timeout=30s
- **Audit trail:** All tool calls logged with event_id, parent_event_id, and safety_flags
- **Admin override:** Dual-flag gate with mandatory audit trail

### Unified Error Envelope

All tools return `{ ok, status, data, error, safety_flags }` via the `ToolEnvelope` wrapper.

---

## Test Results

| Test Suite | Tests | Status |
|------------|-------|--------|
| test_mcp_jsonrpc.ts | 10/10 | PASS |
| test_mcp_write_guard.ts | 14/14 | PASS |
| test_gated_loop_e2e.ts | 16/16 | PASS |
| test_webgpt_full_loop.ts | 30/30 | PASS |
| test_mcp_real_provider_loop.ts | 20/20 | PASS |
| test_dogfood.ts | 13/13 | PASS |
| test_dry_run.ts | 16/16 | PASS |
| unit tests | 6/6 | PASS |
| **Total** | **125/125** | **PASS** |

All tests run in isolated temporary workspaces — no shared `.devspace` state.

---

## Getting Started

### Quick Start (Mock Provider)

```bash
# 1. Clone and install
git clone <repo-url> && cd devspace && npm install

# 2. Start MCP server
npx tsx src/cli.ts mcp serve

# 3. Connect your MCP client (see docs/MANUAL.md)
```

### Run Tests

```bash
npm run test:all    # All tests (unit + MCP E2E)
npm run test:ci     # MCP tests in isolated tmpdirs
```

### Build for Production

```bash
npm run build       # Clean + vite build + tsc
npm start           # Start production server
```

---

## What's Included

| Category | Files |
|----------|-------|
| MCP Server | `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/handlers.ts`, `src/mcp/schemas.ts`, `src/mcp/audit.ts` |
| Delegate | `src/delegate/orchestrator_v2.ts`, `src/delegate/handoff.ts`, `src/delegate/providers/` |
| Tests | `tests/test_utils.ts`, 7 E2E test files, `tests/mock_openai_server.py` |
| Docs | `docs/MANUAL.md`, `docs/RELEASE_v0.1.0-rc1.md` |
| Reports | `reports/rc2_release_verification_report.md`, `reports/devspace_final_completion_report.md` |

---

## Known Limitations

- **Mock provider only out of the box** — `openai` requires `OPENAI_API_KEY`
- **Windows shell deprecation warning** — cosmetic, does not affect functionality
- **6 tools have indirect test coverage** — covered via integration but no dedicated unit tests
- **Process startup delay** — tests use fixed sleep instead of readiness polling

---

## Unsupported Modes

- **Unattended free mode** — all loops require human approval
- **Parallel runs** — one active run at a time via file-based locking
- **Real provider without approval** — approval gate enforced

---

## Upgrade Path

This is the first release candidate. Future releases will add:
- WebSocket transport for persistent connections
- Provider abstraction for additional LLM backends
- Webhook notifications for run state changes
- Dashboard UI for run monitoring

---

## Links

- User Manual: [docs/MANUAL.md](../MANUAL.md)
- Release Verification: [reports/rc2_release_verification_report.md](../reports/rc2_release_verification_report.md)
- Finalization Report: [reports/devspace_final_completion_report.md](../reports/devspace_final_completion_report.md)
