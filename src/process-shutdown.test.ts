import assert from "node:assert/strict";
import { createShutdownHandler } from "./process-shutdown.js";

{
  let closedResources = 0;
  const exits: number[] = [];
  const shutdown = createShutdownHandler({
    httpServer: {
      close: (callback) => callback(),
    },
    closeResources: () => {
      closedResources += 1;
    },
    exit: (code) => exits.push(code),
    logCrash: () => assert.fail("signal shutdown should not log a crash"),
    timeoutMs: 10,
  });

  shutdown("SIGTERM");
  shutdown("SIGINT");
  assert.equal(closedResources, 1);
  assert.deepEqual(exits, [0]);
}

{
  let forcedConnections = 0;
  let loggedCrashes = 0;
  let closedResources = 0;
  const exits: number[] = [];
  const shutdown = createShutdownHandler({
    httpServer: {
      close: () => undefined,
      closeAllConnections: () => {
        forcedConnections += 1;
      },
    },
    closeResources: () => {
      closedResources += 1;
    },
    exit: (code) => exits.push(code),
    logCrash: () => {
      loggedCrashes += 1;
    },
    timeoutMs: 10,
  });

  shutdown("uncaughtException", new Error("boom"));
  shutdown("unhandledRejection", new Error("second"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(loggedCrashes, 1);
  assert.equal(closedResources, 1);
  assert.equal(forcedConnections, 1);
  assert.deepEqual(exits, [1]);
}
