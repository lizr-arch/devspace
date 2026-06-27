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

function cleanState(): void {
  setupWorkspace();
}

type R = Record<string, unknown>;

async function run(): Promise<void> {
  console.log("\nWeb GPT Full Loop E2E Tests\n");

  setupWorkspace();
  cleanState();

  // Phase A: Bootstrap
  const r1 = (await callTool("create_handoff_from_webgpt", {
    contract_md:
      "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    stop_conditions_md:
      "# Stop\n\n## DONE Conditions\n- All features implemented\n## BLOCKED Conditions\n- Cannot proceed",
    first_task_md: "# First Task\n\nImplement feature A",
  })) as R;
  check("A1: create_handoff_from_webgpt OK", r1.status === "OK");

  const r1b = (await callTool("validate_handoff", {})) as R;
  check("A2: validate_handoff has valid field", typeof r1b.valid === "boolean");

  // Phase B: Round 1 — approve → start → orchestrator step → coach review → next task
  const r2 = (await callTool("approve_next_run", {
    provider: "mock",
    mode: "delegate",
  })) as R;
  check(
    "B1: approve_next_run OK",
    r2.status === "OK" && typeof r2.task_hash === "string",
  );

  const r3 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check("B2: start_gated_loop STARTED", r3.status === "STARTED");
  const runToken3 = r3.run_token as string;
  const runId3 = r3.run_id as string;

  const r4 = (await callTool("run_orchestrator_step", {
    provider: "mock",
    run_token: runToken3,
  })) as R;
  check("B3: run_orchestrator_step COMPLETED", r4.status === "COMPLETED");
  check(
    "B3b: orchestrator_status is LOCAL_REPORTED or DONE",
    r4.orchestrator_status === "LOCAL_REPORTED" ||
      r4.orchestrator_status === "DONE",
  );

  const r5 = (await callTool("submit_coach_review", {
    verdict: "PASS",
    reasoning_summary: "Feature A implemented correctly",
    next_task_content: "# Task 2\n\nImplement feature B",
    run_token: runToken3,
  })) as R;
  check("B4: submit_coach_review PASS OK", r5.status === "OK");
  const reviewId5 = r5.review_id as string;
  check(
    "B4b: review_id is string",
    typeof reviewId5 === "string" && reviewId5.length > 0,
  );

  const r6 = (await callTool("create_next_task", {
    task_content: "# Task 2\n\nImplement feature B",
    review_id: reviewId5,
  })) as R;
  check("B5: create_next_task OK", r6.status === "OK");

  // Phase C: Stop, re-approve, round 2
  const r7 = (await callTool("stop_delegate_run", {
    run_token: runToken3,
  })) as R;
  check("C1: stop_delegate_run STOPPED", r7.status === "STOPPED");

  const r8 = (await callTool("verify_run_token", {
    run_token: runToken3,
  })) as R;
  check("C2: verify_run_token valid=false after stop", r8.valid === false);

  const r9 = (await callTool("approve_next_run", {
    provider: "mock",
    mode: "delegate",
  })) as R;
  check("C3: approve_next_run round 2 OK", r9.status === "OK");

  const r10 = (await callTool("start_gated_loop", { provider: "mock" })) as R;
  check("C4: start_gated_loop round 2 STARTED", r10.status === "STARTED");
  const runToken10 = r10.run_token as string;
  const runId10 = r10.run_id as string;
  check("C4b: new run_id differs from round 1", runId10 !== runId3);

  const r11 = (await callTool("run_orchestrator_step", {
    provider: "mock",
    run_token: runToken10,
  })) as R;
  check(
    "C5: run_orchestrator_step round 2 COMPLETED",
    r11.status === "COMPLETED",
  );

  // Phase D: DONE verdict — terminate loop
  const r12 = (await callTool("submit_coach_review", {
    verdict: "DONE",
    reasoning_summary: "All features implemented",
    run_token: runToken10,
  })) as R;
  check("D1: submit_coach_review DONE OK", r12.status === "OK");

  const r13 = (await callTool("stop_delegate_run", {
    run_token: runToken10,
  })) as R;
  check("D2: stop_delegate_run after DONE", r13.status === "STOPPED");

  // Phase E: Verify artifacts
  const runsDir = ".devspace/runs";
  let runDirs: string[] = [];
  if (existsSync(runsDir)) {
    runDirs = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
  }
  check("E1: at least 2 run directories exist", runDirs.length >= 2);

  let hasLocalReport = false;
  let hasCoachReview = false;
  for (const d of runDirs) {
    const runDir = join(runsDir, d);
    if (existsSync(join(runDir, "local_report.md"))) hasLocalReport = true;
    if (existsSync(join(runDir, "coach_review.md"))) hasCoachReview = true;
  }
  check("E2: local_report.md exists in some run", hasLocalReport);
  check("E3: coach_review.md exists in some run", hasCoachReview);

  // Phase F: Verify audit trail
  const auditPath = ".devspace/mcp_audit.jsonl";
  check("F1: mcp_audit.jsonl exists", existsSync(auditPath));
  if (existsSync(auditPath)) {
    const auditContent = readFileSync(auditPath, "utf-8");
    const auditLines = auditContent.split("\n").filter((l) => l.trim());
    check("F2: audit has entries", auditLines.length > 0);

    let hasEventId = false;
    let hasParentEventIdField = false;
    let hasToolNames = new Set<string>();
    for (const line of auditLines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.event_id === "string" && entry.event_id.length > 0)
          hasEventId = true;
        if ("parent_event_id" in entry) hasParentEventIdField = true;
        if (typeof entry.tool === "string") hasToolNames.add(entry.tool);
      } catch {
        /* ignore */
      }
    }
    check("F3: audit entries have event_id", hasEventId);
    check(
      "F4: audit schema includes parent_event_id field",
      hasParentEventIdField,
    );
    check(
      "F5: audit covers key tools",
      hasToolNames.has("create_handoff_from_webgpt") &&
        hasToolNames.has("start_gated_loop"),
    );
  }

  // Phase G: Verify no-fabrication — create_next_task requires review_id
  const r14 = (await callTool("create_next_task", {
    task_content: "# Fake task",
  })) as R;
  check(
    "G1: create_next_task without review_id or source REJECTED",
    r14.status === "REJECTED",
  );

  const r15 = (await callTool("create_next_task", {
    task_content: "# Fake task",
    source: "user_approved",
  })) as R;
  check(
    "G2: create_next_task with source=user_approved OK",
    r15.status === "OK",
  );

  // Phase H: Verify control token gate
  const r16 = (await callTool("pause_delegate_run", {})) as R;
  check("H1: pause without run_token REJECTED", r16.status === "REJECTED");

  const r17 = (await callTool("resume_delegate_run", {})) as R;
  check("H2: resume without run_token REJECTED", r17.status === "REJECTED");

  const r18 = (await callTool("stop_delegate_run", {})) as R;
  check(
    "H3: stop without run_token or state REJECTED",
    r18.status === "REJECTED",
  );

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
