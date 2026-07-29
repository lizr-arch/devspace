import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { TOOL_TEST_COVERAGE } from "./tool-test-coverage.js";
import { TOOL_NAMES } from "./ui/card-types.js";

const coveredTools = Object.keys(TOOL_TEST_COVERAGE).sort();
const expectedTools = [...TOOL_NAMES].sort();

assert.deepEqual(
  coveredTools,
  expectedTools,
  "Every Workspace App tool must have an explicit functional test strategy.",
);

for (const tool of TOOL_NAMES) {
  const coverage = TOOL_TEST_COVERAGE[tool];
  assert.equal(coverage.visualContract, "sandbox_fixture");
  assert.ok(coverage.functionalTests.length > 0, `${tool} has no test file.`);
  for (const testFile of coverage.functionalTests) {
    assert.equal(
      existsSync(testFile),
      true,
      `${tool} references a missing functional test: ${testFile}`,
    );
  }
}

for (const tool of [
  "write",
  "write_file",
  "edit",
  "edit_file",
  "move_to_trash",
  "git_commit",
  "git_merge",
  "git_push",
  "send_game_input",
] as const) {
  assert.notEqual(
    TOOL_TEST_COVERAGE[tool].mode,
    "isolated_read",
    `${tool} must never use a live read-only test environment as a mutation target.`,
  );
}

console.log(`tool test coverage manifest passed (${TOOL_NAMES.length} tools)`);
