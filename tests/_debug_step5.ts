import { callTool } from "../src/mcp/tools.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

async function main() {
  const ceoDir = ".devspace/ceo";
  if (!existsSync(".devspace")) mkdirSync(".devspace", { recursive: true });
  if (!existsSync(ceoDir)) mkdirSync(ceoDir, { recursive: true });
  writeFileSync(
    join(ceoDir, "delegate_contract.md"),
    "# Contract\n\n## Acceptable Risk Level\nlow\n\n## Maximum Auto Scope\ntest",
    "utf-8",
  );
  writeFileSync(
    join(ceoDir, "stop_conditions.md"),
    "# Stop\n\n## DONE Conditions\n- Done",
    "utf-8",
  );
  writeFileSync(
    join(ceoDir, "first_task.md"),
    "# First Task\n\nImplement feature X",
    "utf-8",
  );

  const r3 = (await callTool("start_gated_loop", {
    provider: "mock",
  })) as Record<string, unknown>;
  console.log("r3 run_id:", r3.run_id);
  console.log("r3 run_token:", r3.run_token);

  const r4 = (await callTool("submit_coach_review", {
    verdict: "PASS",
    reasoning_summary: "Feature X implemented",
    next_task_content: "# Task 2\n\nImplement feature Y",
    run_token: r3.run_token,
  })) as Record<string, unknown>;
  console.log("r4:", JSON.stringify(r4));

  const stateContent = readFileSync(join(".devspace", "state.json"), "utf-8");
  const state = JSON.parse(stateContent);
  console.log("state.current_run_id:", state.current_run_id);

  const reviewPath = join(
    ".devspace",
    "runs",
    state.current_run_id,
    "review_meta.json",
  );
  console.log("reviewPath:", reviewPath);
  console.log("reviewPath resolved:", resolve(reviewPath));
  console.log("reviewPath exists:", existsSync(reviewPath));
  if (existsSync(reviewPath)) {
    console.log("reviewPath content:", readFileSync(reviewPath, "utf-8"));
  }

  const dirPath = join(".devspace", "runs", state.current_run_id);
  console.log("dirPath exists:", existsSync(dirPath));
  if (existsSync(dirPath)) {
    console.log("dirPath contents:", readdirSync(dirPath));
  }

  const r5 = (await callTool("create_next_task", {
    task_content: "# Task 2\n\nImplement feature Y",
    review_id: r4.review_id as string,
  })) as Record<string, unknown>;
  console.log("r5:", JSON.stringify(r5));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
