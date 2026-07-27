import assert from "node:assert/strict";
import {
  WORKSPACE_APP_VERSION,
  WorkspaceAppTelemetry,
  errorName,
} from "./workspace-app-telemetry.js";

const originalCrypto = globalThis.crypto;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { randomUUID: () => "018f4e53-3a31-7abc-8def-0123456789ab" },
});

try {
  const telemetry = new WorkspaceAppTelemetry();
  for (let index = 0; index < 12; index += 1) {
    telemetry.capture("script_error", "render", {
      errorName: `Type Error ${index}`,
    });
  }
  assert.equal(telemetry.queuedCount(), 10);

  const reported: unknown[] = [];
  telemetry.connect(async (diagnostic) => {
    reported.push(diagnostic);
  });
  await waitFor(() => reported.length === 10);
  assert.equal(telemetry.queuedCount(), 0);
  assert.deepEqual(reported[0], {
    kind: "script_error",
    phase: "render",
    appVersion: WORKSPACE_APP_VERSION,
    errorName: "Type_Error_2",
    instanceId: "018f4e53-3a31-7abc-8def-0123456789ab",
  });

  assert.equal(errorName(new TypeError("private message")), "TypeError");
  assert.equal(errorName("private rejection text"), "StringError");
} finally {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
}

console.log("workspace app telemetry tests passed");

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for telemetry flush");
}
