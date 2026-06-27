import { callTool } from "../src/mcp/tools.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setupWorkspace, teardownWorkspace } from "./test_utils.js";

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

type R = Record<string, unknown>;

async function run(): Promise<void> {
  console.log("\nDogfood: Real Small Task End-to-End\n");
  setupWorkspace();

  const r1 = (await callTool("create_handoff_from_webgpt", {
    contract_md:
      "# Delegate Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest — write files under .devspace only",
    stop_conditions_md:
      "# Stop Conditions\n\n## DONE\n- Feature A implemented with tests\n## BLOCKED\n- Cannot write files",
    first_task_md:
      "# Task: Implement Feature A\n\nWrite a file `.devspace/output/feature_a.md` containing `Hello from delegate`",
  })) as R;
  check("1. Web GPT creates handoff", r1.status === "OK");

  const r2 = (await callTool("validate_handoff", {})) as R;
  check("2. Handoff validated", typeof r2.valid === "boolean");

  const r3 = (await callTool("approve_next_run", {})) as R;
  check(
    "3. Human approves first run",
    r3.status === "OK" && typeof r3.task_hash === "string",
  );

  const r4 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check("4. Gated loop started", r4.status === "STARTED");
  const runToken = r4.run_token as string;
  const runId = r4.run_id as string;

  const r5 = (await callTool("run_orchestrator_step", {
    provider: "mock",
    run_token: runToken,
  })) as R;
  check(
    "5. Orchestrator executes task via mock provider",
    r5.status === "COMPLETED",
  );

  const r6 = (await callTool("read_current_task", {})) as R;
  check(
    "6. Task content readable",
    typeof r6.content === "string" && r6.content.length > 0,
  );

  const r7 = (await callTool("read_delegate_timeline", {})) as R;
  check(
    "7. Timeline has entries",
    Array.isArray(r7.entries) && r7.entries.length > 0,
  );

  const r8 = (await callTool("submit_coach_review", {
    verdict: "PASS",
    reasoning_summary: "Feature A implemented correctly",
    next_task_content:
      "# Task: Implement Feature B\n\nWrite `.devspace/output/feature_b.md`",
    run_token: runToken,
  })) as R;
  check(
    "8. Coach reviews PASS",
    r8.status === "OK" && typeof r8.review_id === "string",
  );

  const r9 = (await callTool("create_next_task", {
    task_content:
      "# Task: Implement Feature B\n\nWrite `.devspace/output/feature_b.md`",
    review_id: r8.review_id as string,
  })) as R;
  check("9. Next task created from review", r9.status === "OK");

  const r10 = (await callTool("read_run_artifacts", { run_id: runId })) as R;
  check("10. Run artifacts readable", typeof r10.artifacts === "object");

  const runsDir = ".devspace/runs";
  let hasArtifacts = false;
  if (existsSync(runsDir)) {
    const runDirs = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
    hasArtifacts = runDirs.some((d) =>
      existsSync(join(runsDir, d, "local_report.md")),
    );
  }
  check("11. Artifacts written to disk", hasArtifacts);

  const auditPath = ".devspace/mcp_audit.jsonl";
  let auditToolCount = 0;
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const tools = new Set<string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.tool) tools.add(entry.tool);
      } catch {
        /* ignore */
      }
    }
    auditToolCount = tools.size;
  }
  check("12. Audit trail covers 10+ unique tools", auditToolCount >= 10);

  const r11 = (await callTool("stop_delegate_run", {
    run_token: runToken,
  })) as R;
  check("13. Loop stopped", r11.status === "STOPPED");

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
