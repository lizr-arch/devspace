import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  setupWorkspace,
  teardownWorkspace,
  DEVSPACE_CLI,
  TSX_CLI,
  treeKill,
  waitForProcessOutput,
} from "./test_utils.js";

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let stdoutBuffer = "";

function startServer(): ChildProcess {
  const proc = spawn(
    process.execPath,
    [TSX_CLI, DEVSPACE_CLI, "mcp", "serve"],
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
        // skip non-JSON lines
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
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    proc.stdin!.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response id=${id}`));
      }
    }, 10000);
  });
}

function sendRaw(
  proc: ChildProcess,
  raw: string,
): Promise<Record<string, unknown>> {
  const markerId = 0;
  return new Promise((resolve, reject) => {
    const handler = (msg: Record<string, unknown>) => {
      if (msg.id === markerId && msg.error) {
        resolve(msg);
      }
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 0 && msg.error) {
            resolve(msg);
            cleanup();
            return;
          }
        } catch {
          // skip
        }
      }
    };
    const cleanup = () => {
      proc.stdout!.off("data", onData);
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(raw);
    setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for raw response"));
    }, 10000);
  });
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

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(): Promise<void> {
  console.log("\nMCP JSON-RPC E2E Tests\n");

  setupWorkspace();

  const ceoDir = ".devspace/ceo";
  mkdirSync(ceoDir, { recursive: true });
  writeFileSync(
    `${ceoDir}/delegate_contract.md`,
    "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    "utf-8",
  );
  writeFileSync(
    `${ceoDir}/stop_conditions.md`,
    "# Stop\n\n## DONE Conditions\n- Done",
    "utf-8",
  );

  const proc = startServer();
  await waitForProcessOutput(proc, "Starting MCP server on stdin/stdout...");

  try {
    const initRes = await sendRequest(proc, "initialize");
    check(
      "Test 1: initialize returns protocolVersion 2024-11-05",
      (initRes.result as Record<string, unknown>)?.protocolVersion ===
        "2024-11-05",
    );
    check(
      "Test 1b: initialize returns capabilities.tools",
      !!(initRes.result as Record<string, unknown>)?.capabilities,
    );

    const toolsRes = await sendRequest(proc, "tools/list");
    const tools = (toolsRes.result as Record<string, unknown>)
      ?.tools as unknown[];
    check("Test 2: tools/list returns 22 tools", tools?.length === 22);

    const statusRes = await sendRequest(proc, "tools/call", {
      name: "get_delegate_status",
      arguments: {},
    });
    const statusContent = (statusRes.result as Record<string, unknown>)
      ?.content as unknown[];
    check(
      "Test 3: tools/call get_delegate_status returns content array",
      Array.isArray(statusContent),
    );

    const handoffRes = await sendRequest(proc, "tools/call", {
      name: "validate_handoff",
      arguments: {},
    });
    const handoffContent = (handoffRes.result as Record<string, unknown>)
      ?.content as unknown[];
    check(
      "Test 4: tools/call validate_handoff returns content array",
      Array.isArray(handoffContent),
    );

    const previewRes = await sendRequest(proc, "tools/call", {
      name: "preview_delegate_run",
      arguments: { provider: "mock" },
    });
    const previewContent = (previewRes.result as Record<string, unknown>)
      ?.content as unknown[];
    check(
      "Test 5: tools/call preview_delegate_run returns content",
      Array.isArray(previewContent) && previewContent.length > 0,
    );

    const startRes = await sendRequest(proc, "tools/call", {
      name: "start_delegate_run",
      arguments: { provider: "mock" },
    });
    const startContent = (startRes.result as Record<string, unknown>)
      ?.content as Array<Record<string, unknown>>;
    const startParsed = startContent?.[0]
      ? JSON.parse(startContent[0].text as string)
      : null;
    check(
      "Test 6: tools/call start_delegate_run (mock) returns STARTED",
      startParsed?.status === "STARTED",
    );
    const runToken = startParsed?.run_token as string;

    const stopRes = await sendRequest(proc, "tools/call", {
      name: "stop_delegate_run",
      arguments: { run_token: runToken },
    });
    const stopContent = (stopRes.result as Record<string, unknown>)
      ?.content as Array<Record<string, unknown>>;
    const stopParsed = stopContent?.[0]
      ? JSON.parse(stopContent[0].text as string)
      : null;
    check(
      "Test 7: tools/call stop_delegate_run returns STOPPED",
      stopParsed?.status === "STOPPED",
    );

    const parseErrorRes = await sendRaw(proc, "{not json\n");
    check(
      "Test 8: invalid JSON returns Parse error (-32700)",
      parseErrorRes.error?.code === -32700,
    );

    const methodRes = await sendRequest(proc, "nonexistent_method");
    check(
      "Test 9: unknown method returns -32601",
      (methodRes.error as Record<string, unknown>)?.code === -32601,
    );
  } finally {
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
