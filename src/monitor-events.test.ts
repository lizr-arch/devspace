import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  assert.equal(events[0]?.category, "invocation");
  assert.equal(events[1]?.code, "HTTP_404");
  assert.equal(events[1]?.category, "invocation");
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

  const legacyDir = mkdtempSync(
    join(tmpdir(), "devspace-monitor-events-legacy-test-"),
  );
  try {
    writeFileSync(
      join(legacyDir, "monitor-events.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-07-27T12:00:00.000Z",
        source: "http",
        severity: "error",
        code: "HTTP_503",
        message: "POST /mcp returned 503",
        statusCode: 503,
      })}\n`,
    );
    const legacyEvent = new MonitorEventStore(legacyDir).snapshot()[0];
    assert.equal(legacyEvent?.category, "service");
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }

  const timeoutEvent = store.recordToolFailure(
    "import_png",
    "The operation was aborted due to timeout at /private/secret.png",
  );
  assert.equal(timeoutEvent.category, "service");
  assert.equal(timeoutEvent.code, "TOOL_CALL_FAILED");
  assert.equal(timeoutEvent.message, "import_png tool failed");
  assert.doesNotMatch(readFileSync(eventPath, "utf8"), /secret\.png/);

  const editEvent = store.recordToolFailure(
    "edit",
    "Could not find exact text in /private/project/file.ts",
  );
  assert.equal(editEvent.category, "invocation");
  assert.equal(editEvent.message, "edit tool failed");

  assert.equal(safeMonitorPath("/artifacts/secret-token"), "/artifacts/:token");
  assert.equal(
    safeMonitorPath("/mcp-app-assets/private-name.js"),
    "/mcp-app-assets/*",
  );
  assert.equal(safeMonitorPath("/mcp"), "/mcp");
  assert.equal(safeMonitorPath("/secret-token"), "/other");

  const webAppResult = store.recordWorkspaceAppError(
    {
      kind: "script_error",
      phase: "render",
      errorName: "TypeError/private path",
      appVersion: "0.5.0",
      instanceId: "018f4e53-3a31-7abc-8def-0123456789ab",
    },
    1_000,
  );
  assert.deepEqual(webAppResult, { accepted: true, reason: "recorded" });
  assert.deepEqual(
    store.recordWorkspaceAppError(
      {
        kind: "script_error",
        phase: "render",
        errorName: "TypeError/private path",
        appVersion: "0.5.0",
        instanceId: "018f4e53-3a31-7abc-8def-111111111111",
      },
      2_000,
    ),
    { accepted: false, reason: "duplicate" },
  );
  const webAppEvent = store.snapshot()[0];
  assert.equal(webAppEvent?.source, "web_app");
  assert.equal(webAppEvent?.category, "service");
  assert.equal(webAppEvent?.code, "WEB_APP_SCRIPT_ERROR");
  assert.equal(
    webAppEvent?.message,
    "Workspace App script_error during render · TypeError_private_path · v0.5.0",
  );
  assert.equal(
    webAppEvent?.correlationId,
    "018f4e53-3a31-7abc-8def-0123456789ab",
  );

  for (let index = 0; index < 11; index += 1) {
    assert.equal(
      store.recordWorkspaceAppError(
        {
          kind: "render_error",
          phase: "payload_load",
          errorName: `RenderError${index}`,
          appVersion: "0.5.0",
        },
        3_000 + index,
      ).accepted,
      true,
    );
  }
  assert.deepEqual(
    store.recordWorkspaceAppError(
      {
        kind: "connect_error",
        phase: "connect",
        errorName: "ConnectionError",
        appVersion: "0.5.0",
      },
      4_000,
    ),
    { accepted: false, reason: "rate_limited" },
  );
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("monitor event tests passed");
