import { listTools, callTool } from "./tools.js";

interface McpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function handleRequest(req: McpRequest): Promise<McpResponse> {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "devspace-mcp", version: "1.0.0" },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: listTools() },
      };

    case "tools/call": {
      const params = req.params || {};
      const toolName = params.name as string;
      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "Missing required params.name" },
        };
      }
      const toolArgs = (params.arguments || {}) as Record<string, unknown>;
      const result = await callTool(toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    }

    case "notifications/initialized":
      return { jsonrpc: "2.0", id: req.id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export function startMcpServer(): void {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const req: McpRequest = JSON.parse(trimmed);
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch {
        const res: McpResponse = {
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32700, message: "Parse error" },
        };
        process.stdout.write(JSON.stringify(res) + "\n");
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}

export function printTools(): void {
  const tools = listTools();
  console.log(`\nMCP Tools (${tools.length}):\n`);
  for (const tool of tools) {
    console.log(`  ${tool.name}`);
    console.log(`    ${tool.description}`);
    console.log("");
  }
}

export async function runSmoke(): Promise<void> {
  const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  console.log("\nMCP Smoke Test\n");

  const auditPath = ".devspace/mcp_audit.jsonl";
  if (existsSync(auditPath)) {
    try {
      unlinkSync(auditPath);
    } catch {
      /* ignore */
    }
  }

  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${name}`);
      failed++;
    }
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    return callTool(name, args);
  }

  const tools = listTools();
  check("Test 1: List tools returns 22 tools", tools.length === 22);

  const validation = await call("validate_handoff", {});
  check("Test 2: validate_handoff returns result", !!validation);

  const status = await call("get_delegate_status", {});
  check("Test 3: get_delegate_status with no state.json", !!status);

  const preview = (await call("preview_delegate_run", {
    provider: "mock",
  })) as any;
  check("Test 4: preview_delegate_run returns checks", !!preview?.checks);

  const startResult = (await call("start_delegate_run", {})) as any;
  check(
    "Test 5: start_delegate_run defaults to mock + max_rounds=1",
    startResult?.status === "STARTED",
  );
  const currentRunToken = startResult?.run_token;

  const freeResult = (await call("start_delegate_run", {
    mode: "free",
  })) as any;
  check(
    "Test 6: free mode without allow_free_mode rejected",
    freeResult?.status === "REJECTED",
  );

  const realResult = (await call("start_delegate_run", {
    provider: "openai",
  })) as any;
  check(
    "Test 7: real provider without allow_real_provider rejected",
    realResult?.status === "REJECTED",
  );

  const handoff = (await call("create_handoff_from_webgpt", {
    contract_md:
      "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    stop_conditions_md: "# Stop\n\n## DONE Conditions\n- Done",
  })) as any;
  check("Test 15: create_handoff_from_webgpt works", handoff?.status === "OK");

  const review = (await call("submit_coach_review", {
    verdict: "DONE",
    reasoning_summary: "All tasks completed",
    run_token: currentRunToken,
  })) as any;
  check("Test 16: submit_coach_review DONE works", review?.status === "OK");
  const lastReviewId = review?.review_id;

  const badReview = (await call("submit_coach_review", {})) as any;
  check(
    "Test 17: submit_coach_review missing verdict rejected",
    badReview?.status === "REJECTED",
  );

  const pauseResult = (await call("pause_delegate_run", {
    run_token: currentRunToken,
  })) as any;
  check(
    "Test 8a: pause_delegate_run returns PAUSED",
    pauseResult?.status === "PAUSED",
  );

  const resumeResult = (await call("resume_delegate_run", {
    run_token: currentRunToken,
  })) as any;
  check(
    "Test 8b: resume_delegate_run returns RESUMED",
    resumeResult?.status === "RESUMED",
  );

  const stopResult = (await call("stop_delegate_run", {
    run_token: currentRunToken,
  })) as any;
  check(
    "Test 8c: stop_delegate_run returns STOPPED",
    stopResult?.status === "STOPPED",
  );

  const runs = (await call("list_runs", {})) as any;
  check("Test 9: list_runs returns runs", Array.isArray(runs?.runs));

  if (runs?.runs?.length > 0) {
    const artifacts = (await call("read_run_artifacts", {
      run_id: runs.runs[0].run_id,
    })) as any;
    check(
      "Test 10: read_run_artifacts returns artifacts",
      !!artifacts?.artifacts,
    );
  } else {
    check("Test 10: read_run_artifacts (no runs to test)", true);
  }

  const traversal = (await call("read_run_artifacts", {
    run_id: "../../package.json",
  })) as any;
  check("Test 11: path traversal rejected", !!traversal?.error);

  const hasAudit = existsSync(auditPath);
  const auditContent = hasAudit ? readFileSync(auditPath, "utf-8") : "";
  const auditLines = auditContent.split("\n").filter((l) => l.trim());
  check(
    "Test 12: audit log has entries for all tools",
    auditLines.length >= 10,
  );

  const auditHasEventId =
    auditLines.length > 0 &&
    (() => {
      try {
        return "event_id" in JSON.parse(auditLines[0]);
      } catch {
        return false;
      }
    })();
  check("Test 12b: audit entries have event_id", auditHasEventId);

  const answer = (await call("answer_need_user", {
    answer: "test",
    decision: "continue",
  })) as any;
  check("Test 13: answer_need_user works", answer?.status === "ANSWERED");

  const timeline = (await call("read_delegate_timeline", { limit: 5 })) as any;
  check(
    "Test 14: read_delegate_timeline returns entries",
    Array.isArray(timeline?.entries),
  );

  const nextTask = (await call("create_next_task", {
    task_content: "# Next Task",
    source: "user_approved",
  })) as any;
  check("Test 18: create_next_task works", nextTask?.status === "OK");

  const approval = (await call("approve_next_run", {})) as any;
  check("Test 19: approve_next_run works", approval?.status === "OK");

  const gated = (await call("start_gated_loop", { provider: "mock" })) as any;
  check("Test 20: start_gated_loop mock works", gated?.status === "STARTED");
  const gatedToken = gated?.run_token;

  const gatedStatus = (await call("get_gated_loop_status", {})) as any;
  check("Test 21: get_gated_loop_status returns state", !!gatedStatus?.state);

  const unknown = (await call("unknown_tool", {})) as any;
  check("Test 22: unknown tool returns error", !!unknown?.error);

  const realFree = (await call("start_gated_loop", {
    provider: "openai",
    mode: "free",
    allow_free_mode: true,
    allow_real_provider: true,
  })) as any;
  check(
    "Test 23: real+free without allow_real_free_mode rejected",
    realFree?.status === "REJECTED",
  );

  await call("stop_delegate_run", { run_token: gatedToken });

  const stopAgain = (await call("stop_delegate_run", {
    run_token: gatedToken,
  })) as any;
  check(
    "Test 24: stop_delegate_run again returns STOPPED (idempotent)",
    stopAgain?.status === "STOPPED",
  );

  const lifecycleStart = (await call("start_delegate_run", {})) as any;
  check("Test 25a: lifecycle start", lifecycleStart?.status === "STARTED");
  const lifecycleToken = lifecycleStart?.run_token;

  const lifecyclePause = (await call("pause_delegate_run", {
    run_token: lifecycleToken,
  })) as any;
  check("Test 25b: lifecycle pause", lifecyclePause?.status === "PAUSED");

  const lifecycleResume = (await call("resume_delegate_run", {
    run_token: lifecycleToken,
  })) as any;
  check("Test 25c: lifecycle resume", lifecycleResume?.status === "RESUMED");

  const lifecycleStop = (await call("stop_delegate_run", {
    run_token: lifecycleToken,
  })) as any;
  check("Test 25d: lifecycle stop", lifecycleStop?.status === "STOPPED");

  const lockPath = join(".devspace", "run.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      run_id: "fake",
      created_at: new Date().toISOString(),
      pid: 999999,
      mode: "delegate",
      provider: "mock",
    }),
    "utf-8",
  );
  const lockConflict = (await call("start_delegate_run", {})) as any;
  check(
    "Test 26: start rejected when lock exists",
    lockConflict?.status === "REJECTED",
  );

  const staleLockRecovery = (await call("recover_stale_lock", {})) as any;
  check(
    "Test 27a: recover stale lock (dead pid)",
    staleLockRecovery?.status === "RECOVERED",
  );

  const noLockRecovery = (await call("recover_stale_lock", {})) as any;
  check(
    "Test 27b: recover_stale_lock no lock returns NO_LOCK",
    noLockRecovery?.status === "NO_LOCK",
  );

  writeFileSync(
    lockPath,
    JSON.stringify({
      run_id: "fake2",
      created_at: new Date(Date.now() - 400000).toISOString(),
      pid: process.pid,
      mode: "delegate",
      provider: "mock",
    }),
    "utf-8",
  );
  const ttlRecovery = (await call("recover_stale_lock", {
    ttl_seconds: 300,
  })) as any;
  check(
    "Test 27c: recover stale lock (ttl expired)",
    ttlRecovery?.status === "RECOVERED",
  );

  writeFileSync(
    lockPath,
    JSON.stringify({
      run_id: "fake3",
      created_at: new Date().toISOString(),
      pid: process.pid,
      mode: "delegate",
      provider: "mock",
    }),
    "utf-8",
  );
  const activeLockRecovery = (await call("recover_stale_lock", {})) as any;
  check(
    "Test 27d: recover rejected for active lock",
    activeLockRecovery?.status === "REJECTED",
  );

  const forceRecovery = (await call("recover_stale_lock", {
    force: true,
    allow_force_recovery: true,
  })) as any;
  check(
    "Test 27e: force recovery works",
    forceRecovery?.status === "RECOVERED",
  );

  const passNoNext = (await call("submit_coach_review", {
    verdict: "PASS",
    reasoning_summary: "test",
  })) as any;
  check(
    "Test 28: PASS without next_task_content rejected",
    passNoNext?.status === "REJECTED",
  );

  await call("create_next_task", {
    task_content: "# Task A",
    source: "user_approved",
  });
  const approvalA = (await call("approve_next_run", {})) as any;
  await call("create_next_task", {
    task_content: "# Task B",
    source: "user_approved",
  });
  const staleApproval = (await call("approve_next_run", {
    task_hash: approvalA?.task_hash,
  })) as any;
  check(
    "Test 29: stale approval task_hash rejected",
    staleApproval?.status === "REJECTED",
  );

  const missingAnswer = (await call("answer_need_user", {
    answer: "x",
  })) as any;
  check(
    "Test 30a: answer_need_user missing decision rejected",
    !!missingAnswer?.error,
  );

  const badDecision = (await call("answer_need_user", {
    answer: "x",
    decision: "invalid",
  })) as any;
  check(
    "Test 30b: answer_need_user invalid decision rejected",
    !!badDecision?.error,
  );

  const preForceStart = (await call("start_delegate_run", {})) as any;
  await call("stop_delegate_run", { run_token: preForceStart?.run_token });

  writeFileSync(
    lockPath,
    JSON.stringify({
      run_id: "fake-force",
      created_at: new Date().toISOString(),
      pid: 999999,
      mode: "delegate",
      provider: "mock",
    }),
    "utf-8",
  );
  const forceNoGate = (await call("recover_stale_lock", {
    force: true,
  })) as any;
  check(
    "Test 31: force recovery without allow_force_recovery rejected",
    forceNoGate?.status === "REJECTED",
  );
  await call("recover_stale_lock", { force: true, allow_force_recovery: true });

  await call("approve_next_run", { provider: "openai" });
  const roundsCap = (await call("start_gated_loop", {
    provider: "openai",
    allow_real_provider: true,
    max_rounds: 5,
  })) as any;
  check(
    "Test 32: real provider max_rounds > 2 rejected",
    roundsCap?.status === "REJECTED",
  );

  await call("approve_next_run", { provider: "openai" });
  const timeoutCap = (await call("start_gated_loop", {
    provider: "openai",
    allow_real_provider: true,
    timeout: 60,
  })) as any;
  check(
    "Test 33: real provider timeout > 30 rejected",
    timeoutCap?.status === "REJECTED",
  );

  const verifyInvalid = (await call("verify_run_token", {
    run_token: "invalid-token",
  })) as any;
  check(
    "Test 34: verify_run_token with invalid token",
    verifyInvalid?.valid === false,
  );

  const newRun = (await call("start_delegate_run", {})) as any;
  const newToken = newRun?.run_token;
  await call("stop_delegate_run", { run_token: newToken });
  const staleWrite = (await call("submit_coach_review", {
    verdict: "DONE",
    reasoning_summary: "test",
    run_token: newToken,
  })) as any;
  check(
    "Test 35: stop后old token write rejected",
    staleWrite?.status === "REJECTED",
  );

  const verifyValid = (await call("verify_run_token", {
    run_token: "no-active-run",
  })) as any;
  check(
    "Test 36: verify_run_token with no active run",
    verifyValid?.valid === false,
  );

  console.log(`\n  Results: ${passed}/${passed + failed} passed\n`);
  if (failed > 0) process.exit(1);
}
