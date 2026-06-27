import { callTool } from "../src/mcp/tools.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupWorkspace, teardownWorkspace } from "./test_utils.js";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    results.push({ name, passed: true, detail });
    console.log(`  [PASS] ${name}`);
  } else {
    results.push({ name, passed: false, detail });
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type R = Record<string, unknown>;

async function run(): Promise<void> {
  console.log("\nRC-2 Dry Run: Fresh Workspace from docs/MANUAL.md\n");
  setupWorkspace();

  console.log("  Step a: create_handoff_from_webgpt");
  const r1 = (await callTool("create_handoff_from_webgpt", {
    contract_md: "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    stop_conditions_md: "# Stop\n\n## DONE Conditions\n- Feature implemented\n## BLOCKED\n- Cannot proceed",
    first_task_md: "# Task\n\nImplement feature X",
  })) as R;
  check("a. create_handoff_from_webgpt OK", r1.status === "OK", r1.status as string);

  console.log("  Step b: approve_next_run");
  const r2 = (await callTool("approve_next_run", {})) as R;
  check("b. approve_next_run OK", r2.status === "OK", r2.status as string);
  const taskHash = r2.task_hash as string;
  check("b. task_hash is string", typeof taskHash === "string" && taskHash.length > 0);

  console.log("  Step c: start_gated_loop");
  const r3 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check("c. start_gated_loop STARTED", r3.status === "STARTED", r3.status as string);
  const runToken = r3.run_token as string;
  const runId = r3.run_id as string;
  check("c. run_token exists", typeof runToken === "string" && runToken.length > 0);
  check("c. run_id exists", typeof runId === "string" && runId.length > 0);

  console.log("  Step d: run_orchestrator_step");
  const r4 = (await callTool("run_orchestrator_step", {
    provider: "mock",
    run_token: runToken,
  })) as R;
  check("d. run_orchestrator_step COMPLETED", r4.status === "COMPLETED", r4.status as string);

  console.log("  Step e: read_run_artifacts");
  const r5 = (await callTool("read_run_artifacts", { run_id: runId })) as R;
  check("e. read_run_artifacts has artifacts", typeof r5.artifacts === "object", JSON.stringify(Object.keys(r5.artifacts as object)));

  console.log("  Step f: read_current_task");
  const r6 = (await callTool("read_current_task", {})) as R;
  check("f. read_current_task has content", typeof r6.content === "string" && (r6.content as string).length > 0);

  console.log("  Step g: read_delegate_timeline");
  const r7 = (await callTool("read_delegate_timeline", {})) as R;
  check("g. timeline has entries", Array.isArray(r7.entries) && (r7.entries as unknown[]).length > 0);

  console.log("  Step h: get_delegate_status");
  const r8 = (await callTool("get_delegate_status", {})) as R;
  check("h. status has mode field", typeof r8.mode === "string" || r8.mode === null);

  console.log("  Step i: stop_delegate_run");
  const r9 = (await callTool("stop_delegate_run", { run_token: runToken })) as R;
  check("i. stop_delegate_run STOPPED", r9.status === "STOPPED", r9.status as string);

  const runsDir = ".devspace/runs";
  let hasFiles = false;
  if (existsSync(runsDir)) {
    const runDirs = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
    hasFiles = runDirs.length > 0;
    if (hasFiles) {
      const firstRun = join(runsDir, runDirs[0]);
      const files = readdirSync(firstRun);
      check("j. run directory has files", files.length > 0, files.join(", "));
    }
  }
  check("j. runs directory exists", hasFiles);

  const auditPath = ".devspace/mcp_audit.jsonl";
  check("k. audit file exists", existsSync(auditPath));
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, "utf-8").split("\n").filter((l) => l.trim());
    const tools = new Set<string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.tool) tools.add(entry.tool);
      } catch { /* ignore */ }
    }
    check("k. audit covers 8+ tools", tools.size >= 8, `found ${tools.size} tools: ${[...tools].sort().join(", ")}`);
  }

  teardownWorkspace();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n  Results: ${passed}/${passed + failed} passed\n`);

  if (failed > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
