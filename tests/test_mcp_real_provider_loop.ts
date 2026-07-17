import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  setupWorkspace,
  teardownWorkspace,
  PROJECT_ROOT,
  DEVSPACE_CLI,
  TSX_IMPORT,
  treeKill,
  waitForProcessOutput,
} from "./test_utils.js";

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let stdoutBuffer = "";

const results: { name: string; passed: boolean }[] = [];

function check(name: string, condition: boolean): void {
  if (condition) {
    results.push({ name, passed: true });
    console.log(`  [PASS] ${name}`);
  } else {
    results.push({ name, passed: false });
    console.log(`  [FAIL] ${name}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startMockServer(): ChildProcess {
  const proc = spawn(
    "python",
    [join(PROJECT_ROOT, "tests", "mock_openai_server.py"), "8082"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trim();
    if (text) console.log(`  [mock-stderr] ${text}`);
  });
  return proc;
}

function startMcpServer(): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["--import", TSX_IMPORT, DEVSPACE_CLI, "mcp", "serve"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENAI_API_URL: "http://localhost:8082/v1",
        OPENAI_API_KEY: "mock-key",
        OPENAI_MODEL: "gpt-mock",
      },
    },
  );

  proc.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf-8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        // skip non-JSON lines
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trim();
    if (text) console.log(`  [mcp-stderr] ${text}`);
  });

  return proc;
}

function sendRequest(
  proc: ChildProcess,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params: params || {} };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    proc.stdin!.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response id=${id}`));
      }
    }, 15000);
  });
}

function extractResult(res: Record<string, unknown>): unknown {
  const content = (res.result as Record<string, unknown>)?.content as Array<
    Record<string, unknown>
  >;
  if (!content?.[0]?.text) return null;
  try {
    return JSON.parse(content[0].text as string);
  } catch {
    return content[0].text;
  }
}

async function run(): Promise<void> {
  console.log("\nMCP Real Provider Loop E2E Tests\n");

  setupWorkspace();

  const globalTimeout = setTimeout(() => {
    console.error("\n  [TIMEOUT] Global timeout (90s) exceeded");
    process.exit(1);
  }, 90000);

  console.log("  Starting mock OpenAI server on port 8082...");
  const mockProc = startMockServer();
  await sleep(2000);

  console.log("  Starting MCP server...");
  const mcpProc = startMcpServer();
  await waitForProcessOutput(mcpProc, "Starting MCP server on stdin/stdout...");

  let runId: string | null = null;
  let runToken: string | null = null;

  try {
    const initRes = await sendRequest(mcpProc, "initialize");
    const initResult = initRes.result as Record<string, unknown>;
    check(
      "Step 1: initialize returns protocolVersion 2024-11-05",
      initResult?.protocolVersion === "2024-11-05",
    );

    const toolsRes = await sendRequest(mcpProc, "tools/list");
    const tools = (toolsRes.result as Record<string, unknown>)
      ?.tools as unknown[];
    check("Step 2: tools/list returns 22 tools", tools?.length === 22);

    const createRes = await sendRequest(mcpProc, "tools/call", {
      name: "create_handoff_from_webgpt",
      arguments: {
        contract_md:
          "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
        stop_conditions_md:
          "# Stop\n\n## DONE Conditions\n- Done\n## BLOCKED Conditions\n- Cannot proceed",
        first_task_md: "# First Task\n\nImplement feature X with story",
      },
    });
    const createResult = extractResult(createRes) as Record<string, unknown>;
    check(
      "Step 3: create_handoff_from_webgpt returns OK",
      createResult?.status === "OK",
    );

    const validateRes = await sendRequest(mcpProc, "tools/call", {
      name: "validate_handoff",
      arguments: {},
    });
    const validateResult = extractResult(validateRes) as Record<
      string,
      unknown
    >;
    check(
      "Step 4: validate_handoff returns response with valid field",
      typeof validateResult?.valid === "boolean",
    );
    check(
      "Step 4b: validate_handoff core files present",
      Array.isArray(validateResult?.errors),
    );

    const approveRes = await sendRequest(mcpProc, "tools/call", {
      name: "approve_next_run",
      arguments: {
        provider: "openai",
        mode: "delegate",
      },
    });
    const approveResult = extractResult(approveRes) as Record<string, unknown>;
    check(
      "Step 5: approve_next_run returns OK",
      approveResult?.status === "OK",
    );
    const taskHash = approveResult?.task_hash as string;
    check(
      "Step 5: approve_next_run returns task_hash",
      typeof taskHash === "string" && taskHash.length > 0,
    );

    const startRes = await sendRequest(mcpProc, "tools/call", {
      name: "start_gated_loop",
      arguments: {
        provider: "openai",
        allow_real_provider: true,
        allow_free_mode: false,
        allow_real_free_mode: false,
        max_rounds: 1,
        timeout: 15,
      },
    });
    const startResult = extractResult(startRes) as Record<string, unknown>;
    check(
      "Step 6: start_gated_loop returns STARTED",
      startResult?.status === "STARTED",
    );
    runId = (startResult?.run_id as string) || null;
    runToken = (startResult?.run_token as string) || null;
    check(
      "Step 6: start_gated_loop returns run_id",
      typeof runId === "string" && runId.length > 0,
    );
    check(
      "Step 6: start_gated_loop returns run_token",
      typeof runToken === "string" && runToken.length > 0,
    );

    console.log("  Spawning orchestrator...");
    const orchProc = spawn(
      process.execPath,
      [
        "--import",
        TSX_IMPORT,
        DEVSPACE_CLI,
        "delegate",
        "run",
        "--provider",
        "openai",
        "--max-rounds",
        "1",
        "--timeout",
        "15",
        "--mode",
        "free",
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENAI_API_URL: "http://localhost:8082/v1",
          OPENAI_API_KEY: "mock-key",
          OPENAI_MODEL: "gpt-mock",
        },
      },
    );
    orchProc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) console.log(`  [orch-stderr] ${text}`);
    });

    console.log("  Waiting for orchestrator to finish...");
    await new Promise<void>((resolve) => {
      orchProc.on("close", () => resolve());
      setTimeout(() => {
        try {
          orchProc.kill("SIGTERM");
        } catch {}
        resolve();
      }, 30000);
    });
    await sleep(1000);

    const timelineRes = await sendRequest(mcpProc, "tools/call", {
      name: "read_delegate_timeline",
      arguments: { limit: 20 },
    });
    const timelineResult = extractResult(timelineRes) as Record<
      string,
      unknown
    >;
    check(
      "Step 8: read_delegate_timeline returns entries array",
      Array.isArray(timelineResult?.entries),
    );

    if (runId) {
      const artifactsRes = await sendRequest(mcpProc, "tools/call", {
        name: "read_run_artifacts",
        arguments: { run_id: runId },
      });
      const artifactsResult = extractResult(artifactsRes) as Record<
        string,
        unknown
      >;
      check(
        "Step 9: read_run_artifacts returns artifacts",
        !!artifactsResult?.artifacts && !artifactsResult?.error,
      );
    } else {
      check("Step 9: read_run_artifacts (skipped - no run_id)", false);
    }

    const reviewRes = await sendRequest(mcpProc, "tools/call", {
      name: "submit_coach_review",
      arguments: {
        verdict: "DONE",
        reasoning_summary: "Test completed via real provider loop test",
        run_token: runToken || undefined,
      },
    });
    const reviewResult = extractResult(reviewRes) as Record<string, unknown>;
    check(
      "Step 10: submit_coach_review with DONE returns OK",
      reviewResult?.status === "OK",
    );

    const stopRes = await sendRequest(mcpProc, "tools/call", {
      name: "stop_delegate_run",
      arguments: {
        run_token: runToken || undefined,
      },
    });
    const stopResult = extractResult(stopRes) as Record<string, unknown>;
    check(
      "Step 11: stop_delegate_run returns STOPPED",
      stopResult?.status === "STOPPED",
    );

    try {
      const countRes = await fetch("http://localhost:8082/request_count");
      if (countRes.ok) {
        const countData = (await countRes.json()) as Record<string, unknown>;
        const count = typeof countData.count === "number" ? countData.count : 0;
        check("Step 12: mock server request_count >= 1", count >= 1);
      } else {
        check("Step 12: mock server request_count HTTP ok", false);
      }
    } catch {
      check("Step 12: mock server request_count reachable", false);
    }

    const runsDir = ".devspace/runs";
    let orchRunDir: string | null = null;
    if (existsSync(runsDir)) {
      const dirs = readdirSync(runsDir)
        .filter((d) => d.startsWith("run-"))
        .map((d) => ({ name: d, time: statSync(join(runsDir, d)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const d of dirs) {
        if (existsSync(join(runsDir, d.name, "local_report.md"))) {
          orchRunDir = join(runsDir, d.name);
          break;
        }
      }
    }

    if (orchRunDir) {
      check(
        "Step 13: local_report.md exists",
        existsSync(join(orchRunDir, "local_report.md")),
      );
      check(
        "Step 14: coach_review.md exists",
        existsSync(join(orchRunDir, "coach_review.md")),
      );
      check(
        "Step 15: final_report.md OR blocked_report.md exists",
        existsSync(join(orchRunDir, "final_report.md")) ||
          existsSync(join(orchRunDir, "blocked_report.md")),
      );
    } else {
      check("Step 13: local_report.md (no orchestrator run found)", false);
      check("Step 14: coach_review.md (no orchestrator run found)", false);
      check("Step 15: final/blocked report (no orchestrator run found)", false);
    }

    const auditPath = ".devspace/mcp_audit.jsonl";
    if (existsSync(auditPath)) {
      const auditContent = readFileSync(auditPath, "utf-8");
      const auditLines = auditContent.split("\n").filter((l) => l.trim());
      const hasEventId = auditLines.some((line) => {
        try {
          const entry = JSON.parse(line);
          return (
            typeof entry.event_id === "string" && entry.event_id.length > 0
          );
        } catch {
          return false;
        }
      });
      check(
        "Step 16: mcp_audit.jsonl exists and has entries with event_id",
        hasEventId && auditLines.length > 0,
      );
    } else {
      check("Step 16: mcp_audit.jsonl exists", false);
    }

    if (runToken) {
      const verifyRes = await sendRequest(mcpProc, "tools/call", {
        name: "verify_run_token",
        arguments: { run_token: runToken },
      });
      const verifyResult = extractResult(verifyRes) as Record<string, unknown>;
      check(
        "Step 17: verify_run_token returns invalid after stop",
        verifyResult?.valid === false,
      );
    } else {
      check("Step 17: verify_run_token (skipped - no run_token)", false);
    }
  } finally {
    clearTimeout(globalTimeout);
    mcpProc.stdin!.end();
    await sleep(500);
    if (!mcpProc.killed) treeKill(mcpProc);
    if (!mockProc.killed) treeKill(mockProc);
  }

  teardownWorkspace();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n  Results: ${passed}/${passed + failed} passed\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
