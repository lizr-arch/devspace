import test from "node:test";
import assert from "node:assert/strict";
import {
  DevSpaceError,
  formatErrorRemedy,
  isDevSpaceError,
} from "./errors.js";

test("Unified DevSpaceError and formatErrorRemedy", async (t) => {
  await t.test("formats explicit DevSpaceError with next recommended tools", () => {
    const err = new DevSpaceError({
      code: "TEST_CODE",
      layer: "tool",
      message: "Custom failure message",
      retryable: false,
      safeToRetry: true,
      recoveryHint: "Call fix_tool to resolve",
      nextRecommendedTools: ["fix_tool", "check_tool"],
    });

    assert.equal(isDevSpaceError(err), true);
    const formatted = formatErrorRemedy(err);
    assert.equal(formatted.errorPayload.code, "TEST_CODE");
    assert.equal(
      formatted.message.includes("Recovery Hint: Call fix_tool to resolve"),
      true,
    );
    assert.equal(
      formatted.message.includes("Next recommended tools: [fix_tool, check_tool]"),
      true,
    );
  });

  await t.test("infers recovery hint and next tools for WORKSPACE_NOT_FOUND", () => {
    const rawError = new Error("WORKSPACE_NOT_FOUND: ws-123 is unknown.");
    const formatted = formatErrorRemedy(rawError);
    assert.equal(formatted.errorPayload.code, "WORKSPACE_NOT_FOUND");
    assert.deepEqual(formatted.errorPayload.nextRecommendedTools, [
      "list_workspaces",
      "open_workspace",
    ]);
  });

  await t.test("infers recovery hint and next tools for TASK_NOT_APPROVED", () => {
    const rawError = new Error("TASK_NOT_APPROVED: task-build requires manifest approval.");
    const formatted = formatErrorRemedy(rawError);
    assert.equal(formatted.errorPayload.code, "TASK_NOT_APPROVED");
    assert.deepEqual(formatted.errorPayload.nextRecommendedTools, [
      "approve_task_manifest",
    ]);
  });

  await t.test("infers recovery hint for PATH_EXISTS", () => {
    const rawError = new Error("PATH_EXISTS: Destination exists; set overwrite=true or use edit.");
    const formatted = formatErrorRemedy(rawError);
    assert.equal(formatted.errorPayload.code, "PATH_EXISTS");
    assert.deepEqual(formatted.errorPayload.nextRecommendedTools, [
      "edit_file",
      "edit",
    ]);
  });
});
