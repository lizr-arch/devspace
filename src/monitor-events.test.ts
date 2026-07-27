import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorEventStore, safeMonitorPath } from "./monitor-events.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-monitor-events-test-"));
try {
  const store = new MonitorEventStore(stateDir);
  store.record({
    source: "http",
    severity: "warning",
    code: "http 404",
    message: "GET /missing\nfailed",
    statusCode: 404,
  });
  store.record({
    source: "tool",
    severity: "error",
    code: "READ_FAILED",
    message: "read failed",
  });

  const events = store.snapshot();
  assert.equal(store.isPersistent(), true);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.code, "READ_FAILED");
  assert.equal(events[1]?.code, "HTTP_404");
  assert.equal(events[1]?.message, "GET /missing failed");
  assert.equal(events[1]?.statusCode, 404);

  const eventPath = join(stateDir, "monitor-events.jsonl");
  assert.equal(statSync(eventPath).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(eventPath, "utf8").split("\n").filter(Boolean).length,
    2,
  );

  const reloaded = new MonitorEventStore(stateDir);
  assert.deepEqual(reloaded.snapshot(), events);

  assert.equal(safeMonitorPath("/artifacts/secret-token"), "/artifacts/:token");
  assert.equal(
    safeMonitorPath("/mcp-app-assets/private-name.js"),
    "/mcp-app-assets/*",
  );
  assert.equal(safeMonitorPath("/mcp"), "/mcp");
  assert.equal(safeMonitorPath("/secret-token"), "/other");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("monitor event tests passed");
