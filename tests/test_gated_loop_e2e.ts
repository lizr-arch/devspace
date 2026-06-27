import { callTool } from "../src/mcp/tools.js";
import { setupWorkspace, teardownWorkspace } from "./test_utils.js";
import { existsSync, unlinkSync, rmSync } from "node:fs";

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

function cleanState(): void {
  for (const f of [".devspace/state.json", ".devspace/run.lock"]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (existsSync(".devspace/approvals")) {
    try {
      rmSync(".devspace/approvals", { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

type R = Record<string, unknown>;

async function run(): Promise<void> {
  console.log("\nGated Loop E2E Tests\n");

  setupWorkspace();
  cleanState();

  const r1 = (await callTool("create_handoff_from_webgpt", {
    contract_md:
      "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    stop_conditions_md: "# Stop\n\n## DONE Conditions\n- Done",
    first_task_md: "# First Task\n\nImplement feature X",
  })) as R;
  check("Step 1: create_handoff_from_webgpt", r1.status === "OK");

  const r2 = (await callTool("approve_next_run", {})) as R;
  check(
    "Step 2: approve_next_run",
    r2.status === "OK" && typeof r2.task_hash === "string",
  );

  const r3 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check(
    "Step 3: start_gated_loop (mock, delegate)",
    r3.status === "STARTED" && typeof r3.run_id === "string",
  );
  const runToken3 = r3.run_token as string;

  const r4 = (await callTool("submit_coach_review", {
    verdict: "PASS",
    reasoning_summary: "Feature X implemented",
    next_task_content: "# Task 2\n\nImplement feature Y",
    run_token: runToken3,
  })) as R;
  check("Step 4: submit_coach_review PASS", r4.status === "OK");
  const reviewId4 = r4.review_id as string;
  console.log("  [DEBUG] r4:", JSON.stringify(r4));

  const r5 = (await callTool("create_next_task", {
    task_content: "# Task 2\n\nImplement feature Y",
    review_id: reviewId4,
  })) as R;
  if (r5.status !== "OK") console.log("  [DEBUG] r5:", JSON.stringify(r5));
  check("Step 5: create_next_task", r5.status === "OK");

  const r6 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check(
    "Step 6: start_gated_loop without new approval REJECTED",
    r6.status === "REJECTED",
  );

  const r6Stop = (await callTool("stop_delegate_run", {
    run_token: runToken3,
  })) as R;
  check(
    "Step 6b: stop_delegate_run to release lock",
    r6Stop.status === "STOPPED",
  );

  const r7 = (await callTool("approve_next_run", {})) as R;
  check(
    "Step 7: approve_next_run for new task",
    r7.status === "OK" && typeof r7.task_hash === "string",
  );

  const r8 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check("Step 8: start_gated_loop second round", r8.status === "STARTED");
  const runToken8 = r8.run_token as string;

  const r9 = (await callTool("submit_coach_review", {
    verdict: "DONE",
    reasoning_summary: "All tasks completed",
    run_token: runToken8,
  })) as R;
  check("Step 9: submit_coach_review DONE", r9.status === "OK");

  const r10 = (await callTool("stop_delegate_run", {
    run_token: runToken8,
  })) as R;
  check("Step 10: stop_delegate_run", r10.status === "STOPPED");

  const r11a = (await callTool("create_next_task", {
    task_content: "# Task 3\n\nImplement feature Z",
    source: "user_approved",
  })) as R;
  const r11b = (await callTool("approve_next_run", {})) as R;
  check(
    "Step 11a: approve for task 3",
    r11b.status === "OK" && typeof r11b.task_hash === "string",
  );
  const r11c = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check(
    "Step 11b: start_gated_loop consumes approval",
    r11c.status === "STARTED",
  );
  const runToken11c = r11c.run_token as string;
  const r11d = (await callTool("stop_delegate_run", {
    run_token: runToken11c,
  })) as R;
  check("Step 11c: stop_delegate_run", r11d.status === "STOPPED");

  const r12a = (await callTool("create_next_task", {
    task_content: "# Task 4\n\nImplement feature W",
    source: "user_approved",
  })) as R;
  const r12b = (await callTool("approve_next_run", {})) as R;
  check("Step 12a: approve for task 4", r12b.status === "OK");
  const staleHash = r12b.task_hash as string;
  await callTool("create_next_task", {
    task_content: "# Task 5\n\nImplement feature V",
    source: "user_approved",
  });
  const r12d = (await callTool("approve_next_run", {
    task_hash: staleHash,
  })) as R;
  check("Step 12b: stale task_hash REJECTED", r12d.status === "REJECTED");

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
