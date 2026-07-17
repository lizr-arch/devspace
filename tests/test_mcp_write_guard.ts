import { spawn, type ChildProcess } from "node:child_process";
import {
  setupWorkspace,
  teardownWorkspace,
  DEVSPACE_CLI,
  TSX_IMPORT,
  treeKill,
  waitForProcessOutput,
} from "./test_utils.js";

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
>();
let stdoutBuffer = "";

function startServer(): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["--import", TSX_IMPORT, DEVSPACE_CLI, "mcp", "serve"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
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
        // skip non-JSON
      }
    }
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
    pending.set(id, { resolve, reject });
    proc.stdin!.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response id=${id}`));
      }
    }, 10000);
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseToolResult(
  res: Record<string, unknown>,
): Record<string, unknown> {
  const content = (res.result as Record<string, unknown>)?.content as
    Array<Record<string, unknown>> | undefined;
  if (!content?.[0]?.text) return {};
  return JSON.parse(content[0].text as string);
}

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

async function callTool(
  proc: ChildProcess,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await sendRequest(proc, "tools/call", { name, arguments: args });
  return parseToolResult(res);
}

async function run(): Promise<void> {
  console.log("\nMCP Write Guard Lifecycle Tests\n");

  setupWorkspace();

  const proc = startServer();
  await waitForProcessOutput(proc, "Starting MCP server on stdin/stdout...");

  const timeout = setTimeout(() => {
    console.error("\nGlobal timeout (30s) reached. Forcing exit.\n");
    proc.kill("SIGTERM");
    process.exit(1);
  }, 30000);

  try {
    const initRes = await sendRequest(proc, "initialize");
    check(
      "Step 1: initialize",
      !!(initRes.result as Record<string, unknown>)?.protocolVersion,
    );

    const handoff = await callTool(proc, "create_handoff_from_webgpt", {
      contract_md:
        "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
      stop_conditions_md: "# Stop\n\n## DONE Conditions\n- Done",
      first_task_md: "# Task\n\nTest write guard",
    });
    check("Step 2: create_handoff_from_webgpt", handoff.status === "OK");

    const start1 = await callTool(proc, "start_delegate_run", {
      provider: "mock",
    });
    const runToken1 = start1.run_token as string;
    check(
      "Step 3: start_delegate_run returns STARTED with run_token",
      start1.status === "STARTED" && !!runToken1,
    );

    const verify1 = await callTool(proc, "verify_run_token", {
      run_token: runToken1,
    });
    check(
      "Step 4: verify_run_token valid=true for active token",
      verify1.valid === true,
    );

    const review1 = await callTool(proc, "submit_coach_review", {
      verdict: "DONE",
      reasoning_summary: "Completed",
      run_token: runToken1,
    });
    check(
      "Step 5: submit_coach_review with valid token → OK",
      review1.status === "OK",
    );

    const stop1 = await callTool(proc, "stop_delegate_run", {
      run_token: runToken1,
    });
    check("Step 6: stop_delegate_run → STOPPED", stop1.status === "STOPPED");

    const verify2 = await callTool(proc, "verify_run_token", {
      run_token: runToken1,
    });
    check(
      "Step 7: verify_run_token valid=false after stop",
      verify2.valid === false,
    );

    const review2 = await callTool(proc, "submit_coach_review", {
      verdict: "DONE",
      reasoning_summary: "Stale",
      run_token: runToken1,
    });
    check(
      "Step 8: submit_coach_review with stale token → REJECTED",
      review2.status === "REJECTED",
    );

    const start2 = await callTool(proc, "start_delegate_run", {
      provider: "mock",
    });
    const runToken2 = start2.run_token as string;
    check(
      "Step 9: start_delegate_run → new run_token",
      start2.status === "STARTED" && !!runToken2 && runToken2 !== runToken1,
    );

    await callTool(proc, "stop_delegate_run", { run_token: runToken2 });

    const concA = sendRequest(proc, "tools/call", {
      name: "start_delegate_run",
      arguments: { provider: "mock" },
    });
    const concB = sendRequest(proc, "tools/call", {
      name: "start_delegate_run",
      arguments: { provider: "mock" },
    });
    const [resA, resB] = await Promise.all([concA, concB]);
    const parsedA = parseToolResult(resA);
    const parsedB = parseToolResult(resB);
    const oneStarted =
      (parsedA.status === "STARTED" && parsedB.status === "REJECTED") ||
      (parsedA.status === "REJECTED" && parsedB.status === "STARTED");
    check(
      "Step 10: concurrent start_delegate_run — exactly one STARTED, one REJECTED",
      oneStarted,
    );

    const concRunToken = (
      parsedA.status === "STARTED" ? parsedA.run_token : parsedB.run_token
    ) as string;
    const stop2 = await callTool(proc, "stop_delegate_run", {
      run_token: concRunToken,
    });
    check(
      "Step 11: stop_delegate_run after concurrent",
      stop2.status === "STOPPED",
    );

    const start3 = await callTool(proc, "start_delegate_run", {
      provider: "mock",
    });
    const runToken3 = start3.run_token as string;
    check(
      "Step 12: start_delegate_run → capture run_token",
      start3.status === "STARTED" && !!runToken3,
    );

    const review3 = await callTool(proc, "submit_coach_review", {
      verdict: "DONE",
      reasoning_summary: "No token provided",
    });
    check(
      "Step 13: submit_coach_review without run_token → REJECTED",
      review3.status === "REJECTED",
    );

    const stop3 = await callTool(proc, "stop_delegate_run", {
      run_token: runToken3,
    });
    check("Step 14: stop_delegate_run → STOPPED", stop3.status === "STOPPED");
  } finally {
    clearTimeout(timeout);
    proc.stdin!.end();
    await sleep(500);
    if (!proc.killed) {
      treeKill(proc);
    }
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
