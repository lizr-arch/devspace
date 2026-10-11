import assert from "node:assert/strict";
import { JobResourceLocks, ResourceLockBusyError, requestsForCommand } from "./job-resource-locks.js";

const sidecar = JobResourceLocks.requestsForReadonlySidecar({ serviceName: "coach", port: 4311 });
assert.deepEqual(sidecar.map((request) => JobResourceLocks.keyFor(request)), [
  "sidecar-service:coach",
  "sidecar-endpoint:127.0.0.1:4311",
]);
assert.throws(() => JobResourceLocks.keyFor({ kind: "sidecar-service", value: "./coach" }), TypeError);
for (const endpoint of ["0.0.0.0:4311", "127.0.0.1:04311", "127.0.0.1:65536", "127.0.0.1:4/311"]) {
  assert.throws(() => JobResourceLocks.keyFor({ kind: "sidecar-endpoint", value: endpoint }), TypeError);
}
for (const input of [
  { serviceName: "../coach", port: 4311 },
  { serviceName: "Coach", port: 4311 },
  { serviceName: "coach", port: "4311" },
  { serviceName: "coach", port: true },
  { serviceName: "coach", port: 0 },
  { serviceName: "coach", port: 65536 },
  { serviceName: "coach", port: -1 },
  { serviceName: "coach", port: Number.NaN },
  { serviceName: "coach", port: 3.14 },
]) {
  assert.throws(() => JobResourceLocks.requestsForReadonlySidecar(input as never));
}

const locks = new JobResourceLocks();
locks.acquire({ jobId: "sidecar", runner: "sidecar", workspaceRoot: "/tmp/ws", requests: sidecar });
assert.equal(locks.heldByJob("sidecar")[0].runner, "sidecar");
assert.equal(locks.heldByJob("sidecar")[0].provenance, "sidecar");
assert.throws(
  () => locks.acquire({ jobId: "other", runner: "sidecar", workspaceRoot: "/tmp/ws", requests: JobResourceLocks.requestsForReadonlySidecar({ serviceName: "other", port: 4311 }) }),
  ResourceLockBusyError,
);
assert.throws(
  () => locks.acquire({ jobId: "other", runner: "sidecar", workspaceRoot: "/tmp/ws", requests: JobResourceLocks.requestsForReadonlySidecar({ serviceName: "coach", port: 4312 }) }),
  ResourceLockBusyError,
);
const ordinary = requestsForCommand({ argv: ["/usr/bin/python3", "bridge.py"], workspaceRoot: "/tmp/ws" });
assert.deepEqual(ordinary, [{ kind: "workspace", value: "/tmp/ws" }]);
locks.acquire({ jobId: "ordinary", runner: "npm", workspaceRoot: "/tmp/ws", requests: ordinary });
assert.equal(Object.hasOwn(locks.heldByJob("ordinary")[0], "provenance"), false);
assert.equal(locks.snapshot().length, 3);
// Failed acquisition must not leave a partial service-name claim behind.
assert.equal(locks.isBusy({ kind: "sidecar-service", value: "other" }), false);
locks.release("sidecar");
locks.release("sidecar");
assert.equal(locks.snapshot().length, 1);
console.log("sidecar resource lock tests passed");
