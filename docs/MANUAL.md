# DevSpace MCP — User Manual

## 1. Start MCP Server

```bash
# Development (stdio mode)
npx tsx src/cli.ts mcp serve

# Production (after build)
node dist/cli.js mcp serve
```

The server communicates over stdin/stdout using JSON-RPC 2.0.

## 2. Connect MCP Client

### ChatGPT / Claude Desktop

Add to your MCP config:

```json
{
  "mcpServers": {
    "devspace": {
      "command": "npx",
      "args": ["tsx", "src/cli.ts", "mcp", "serve"],
      "cwd": "/path/to/devspace"
    }
  }
}
```

### HTTP Mode (Remote)

```bash
node dist/cli.js serve --port 3000
```

Then connect via `http://localhost:3000/mcp` with OAuth2 bearer token.

## 3. Run a Controlled Task

### Step 1: Create Handoff

```
tools/call → create_handoff_from_webgpt
  contract_md: "# Contract\n## Acceptable Risk Level\nlow"
  stop_conditions_md: "# DONE\n- Feature implemented"
  first_task_md: "# Task\nImplement feature X"
```

### Step 2: Approve

```
tools/call → approve_next_run
```

Returns a `task_hash` binding the approval to the current task.

### Step 3: Start Gated Loop

```
tools/call → start_gated_loop
  provider: "mock"  (or "openai", "ollama")
```

Returns `run_id` and `run_token`. Keep the `run_token` — you need it for all subsequent operations.

### Step 4: Execute

```
tools/call → run_orchestrator_step
  run_token: "<from step 3>"
  provider: "mock"
```

The orchestrator runs one round: reads the task, calls the provider, generates `local_report.md`.

### Step 5: Coach Review

```
tools/call → submit_coach_review
  verdict: "PASS"
  reasoning_summary: "Looks good"
  next_task_content: "# Next Task\n..."
  run_token: "<from step 3>"
```

Verdicts: `PASS`, `PASS_WITH_WARNINGS`, `NEEDS_FIX`, `BLOCKED`, `DONE`, `NEED_USER`, `SAFETY_STOP`, `BUDGET_STOP`.

### Step 6: Create Next Task

```
tools/call → create_next_task
  task_content: "# Next Task\n..."
  review_id: "<from step 5>"
```

Requires the `review_id` from `submit_coach_review` to prevent task fabrication.

### Repeat

Approve → Start Loop → Execute → Review → Next Task → until `DONE`.

## 4. Abort / Pause / Resume

### Pause

```
tools/call → pause_delegate_run
  run_token: "<your token>"
```

### Resume

```
tools/call → resume_delegate_run
  run_token: "<your token>"
```

### Stop (Terminate)

```
tools/call → stop_delegate_run
  run_token: "<your token>"
```

After stop, the `run_token` is invalidated. You must re-approve and start a new loop.

### Force Stop (Admin Override)

If the `run_token` is lost or stale:

```
tools/call → stop_delegate_run
  admin_override: true
  allow_admin_override: true
  reason: "Force stopping due to token loss"
```

This adds `safety_flags: ["admin_override"]` to the audit trail.

## 5. View Audit Trail

The audit log is at `.devspace/mcp_audit.jsonl`. Each line is a JSON object:

```json
{
  "event_id": "uuid",
  "timestamp": "ISO-8601",
  "tool": "start_gated_loop",
  "args_summary": {...},
  "status": "OK",
  "run_id": "run-1234",
  "parent_event_id": null,
  "safety_flags": []
}
```

- `parent_event_id`: Links chained calls (e.g., `start_gated_loop` → `run_orchestrator_step`)
- `safety_flags`: Contains `["admin_override"]` when admin bypass was used
- Sensitive fields (api_key, token, password) are automatically redacted

### Read Audit via MCP

```
tools/call → list_runs
```

Returns the 20 most recent run directories with their state.

```
tools/call → read_run_artifacts
  run_id: "<run-id>"
```

Returns the artifacts (local_report.md, coach_review.md, etc.) for a specific run.

## 6. Tool Inventory (22 Tools)

| Category | Tools |
|----------|-------|
| Status | `get_delegate_status` |
| Read | `read_delegate_timeline`, `read_current_task`, `read_handoff_summary`, `read_run_artifacts`, `validate_handoff`, `list_runs`, `preview_delegate_run` |
| Control | `start_delegate_run`, `pause_delegate_run`, `resume_delegate_run`, `stop_delegate_run`, `answer_need_user` |
| Write | `create_handoff_from_webgpt`, `submit_coach_review`, `create_next_task` |
| Approval | `approve_next_run` |
| Loop | `start_gated_loop`, `get_gated_loop_status` |
| Recovery | `recover_stale_lock` |
| Auth | `verify_run_token` |
| Execution | `run_orchestrator_step` |

## 7. Safety Model

| Gate | Description |
|------|-------------|
| Approval | `approve_next_run` must be called before starting a loop |
| Run Token | Required for all write operations during a run |
| Mode Caps | Real providers capped at max_rounds=2, timeout=30s |
| No-Fabrication | `create_next_task` requires a `review_id` from coach review |
| Audit | All tool calls are logged with event_id and parent_event_id |
| Admin Override | Dual-flag gate (`admin_override` + `allow_admin_override`) with audit trail |

## 8. Unsupported Modes

| Mode | Status | Reason |
|------|--------|--------|
| Unattended free mode | **NOT SUPPORTED** | All loops require human approval via `approve_next_run` before each run. The `start_delegate_run` and `start_gated_loop` tools reject `mode: "free"` unless explicit safety flags are set, which are not available in the MCP interface. |
| Parallel runs | **NOT SUPPORTED** | Only one active run at a time. Concurrent `start_*` calls will race on `run.lock` and exactly one will succeed. |
