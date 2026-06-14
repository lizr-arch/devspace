import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SqliteResultStore } from "./result-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "pi-on-mcp-result-store-test-"));

try {
  const firstStore = new SqliteResultStore(stateDir);
  const stored = firstStore.put({
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
    tool: "edit_file",
    path: "README.md",
    label: "README.md",
    summary: { additions: 1, removals: 0, editCount: 1 },
    payload: { patch: "diff --git a/README.md b/README.md\n+hello" },
  });
  firstStore.close();

  const secondStore = new SqliteResultStore(stateDir);
  const loaded = secondStore.get(stored.id, "ws_test");
  assert.equal(loaded.id, stored.id);
  assert.equal(loaded.workspaceId, "ws_test");
  assert.equal(loaded.workspaceRoot, "/tmp/project");
  assert.equal(loaded.payload.patch, stored.payload.patch);
  assert.deepEqual(loaded.summary, stored.summary);
  assert.throws(() => secondStore.get(stored.id, "ws_other"), /Unknown tool result/);
  secondStore.close();

} finally {
  await rm(stateDir, { recursive: true, force: true });
}
