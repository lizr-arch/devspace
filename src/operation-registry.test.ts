import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperationRegistry,
  canonicalizeJson,
  computeRequestHash,
} from "./operation-registry.js";

test("OperationRegistry idempotency lifecycle", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-op-test-"));
  const registry = new OperationRegistry(stateDir);

  t.after(() => {
    registry.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  await t.test("canonicalizeJson and computeRequestHash are deterministic", () => {
    const objA = { b: 2, a: 1, nested: { y: "hello", x: [1, 2] } };
    const objB = { nested: { x: [1, 2], y: "hello" }, a: 1, b: 2 };
    assert.equal(canonicalizeJson(objA), canonicalizeJson(objB));
    assert.equal(
      computeRequestHash("write_file", objA),
      computeRequestHash("write_file", objB),
    );
  });

  await t.test("records new operation and allows replay on success", () => {
    const opId = "op-test-123";
    const reqHash = computeRequestHash("write_file", { path: "a.txt" });

    const outcome1 = registry.recordStart(opId, {
      workspaceId: "ws-1",
      toolName: "write_file",
      requestHash: reqHash,
    });
    assert.equal(outcome1.status, "new");

    const inProgress = registry.recordStart(opId, {
      workspaceId: "ws-1",
      toolName: "write_file",
      requestHash: reqHash,
    });
    assert.equal(inProgress.status, "in_progress");

    const successResult = { written: true, bytes: 42 };
    registry.recordSuccess(opId, successResult, true);

    const outcome2 = registry.recordStart(opId, {
      workspaceId: "ws-1",
      toolName: "write_file",
      requestHash: reqHash,
    });
    assert.equal(outcome2.status, "replay");
    if (outcome2.status === "replay") {
      assert.deepEqual(outcome2.result, successResult);
      assert.equal(outcome2.record.sideEffectApplied, true);
    }
  });

  await t.test("handles failure and allows retry", () => {
    const opId = "op-fail-456";
    const reqHash = computeRequestHash("git_commit", { message: "test" });

    registry.recordStart(opId, {
      workspaceId: "ws-1",
      toolName: "git_commit",
      requestHash: reqHash,
    });

    registry.recordFailure(opId, new Error("Git lock failed"));

    const retrieved = registry.getOperation(opId);
    assert.equal(retrieved?.status, "failed");
    assert.equal(
      (retrieved?.error as { message: string })?.message,
      "Git lock failed",
    );

    const retryOutcome = registry.recordStart(opId, {
      workspaceId: "ws-1",
      toolName: "git_commit",
      requestHash: reqHash,
    });
    assert.equal(retryOutcome.status, "retry_previous_failure");
  });

  await t.test("findRecentOperations lists recent records", () => {
    const recent = registry.findRecentOperations("ws-1", 10);
    assert.equal(recent.length >= 2, true);
  });
});
