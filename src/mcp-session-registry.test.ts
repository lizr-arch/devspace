import assert from "node:assert/strict";
import {
  McpSessionRegistry,
  type CloseableMcpTransport,
} from "./mcp-session-registry.js";

class FakeTransport implements CloseableMcpTransport {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

let now = 0;
const ttlRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 300_000,
  maxSessions: 256,
  now: () => now,
  autoSweep: false,
});
const ttlTransport = new FakeTransport();
ttlRegistry.register("ttl", ttlTransport);
now = 299_999;
assert.equal(ttlRegistry.sweep(), 0);
assert.equal(ttlRegistry.snapshot().active, 1);
now = 300_000;
assert.equal(ttlRegistry.sweep(), 1);
assert.equal(ttlRegistry.snapshot().active, 0);
assert.equal(ttlRegistry.snapshot().expired, 1);
assert.equal(ttlTransport.closeCalls, 1);
assert.equal(ttlRegistry.acquire("ttl"), undefined);
assert.equal(ttlRegistry.snapshot().unknownSessionRequests, 1);
assert.equal(ttlRegistry.snapshot().unknownRequestsByReason.expired, 1);

now = 0;
const activeRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 100,
  maxSessions: 2,
  now: () => now,
  autoSweep: false,
});
const activeTransport = new FakeTransport();
activeRegistry.register("active", activeTransport, 1);
now = 1_000;
assert.equal(activeRegistry.sweep(), 0);
assert.equal(activeRegistry.snapshot().active, 1);
activeRegistry.release("active");
now = 1_099;
assert.equal(activeRegistry.sweep(), 0);
now = 1_100;
assert.equal(activeRegistry.sweep(), 1);
assert.equal(activeTransport.closeCalls, 1);

now = 0;
const capacityEvents: string[] = [];
const capacityRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 1_000,
  maxSessions: 2,
  now: () => now,
  autoSweep: false,
  onClosed: ({ sessionId, reason }) => {
    capacityEvents.push(`${sessionId}:${reason}`);
  },
});
const oldestTransport = new FakeTransport();
const middleTransport = new FakeTransport();
const newestTransport = new FakeTransport();
capacityRegistry.register("oldest", oldestTransport);
now = 1;
capacityRegistry.register("middle", middleTransport);
now = 2;
capacityRegistry.register("newest", newestTransport);
assert.equal(capacityRegistry.snapshot().active, 2);
assert.equal(capacityRegistry.snapshot().highWaterMark, 2);
assert.equal(capacityRegistry.snapshot().capacityEvictions, 1);
assert.equal(oldestTransport.closeCalls, 1);
assert.equal(middleTransport.closeCalls, 0);
assert.equal(newestTransport.closeCalls, 0);
assert.deepEqual(capacityEvents, ["oldest:capacity"]);

now = 0;
const overflowRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 1_000,
  maxSessions: 1,
  now: () => now,
  autoSweep: false,
});
const firstActive = new FakeTransport();
const secondActive = new FakeTransport();
overflowRegistry.register("first", firstActive, 1);
overflowRegistry.register("second", secondActive, 1);
assert.equal(overflowRegistry.snapshot().active, 2);
overflowRegistry.release("first");
assert.equal(overflowRegistry.snapshot().active, 1);
assert.equal(firstActive.closeCalls, 1);
assert.equal(secondActive.closeCalls, 0);

const clientRegistry = new McpSessionRegistry<FakeTransport>({
  autoSweep: false,
});
const clientTransport = new FakeTransport();
clientRegistry.register("client", clientTransport);
assert.equal(
  clientRegistry.handleTransportClosed("client", clientTransport),
  true,
);
assert.equal(
  clientRegistry.handleTransportClosed("client", clientTransport),
  false,
);
assert.equal(clientRegistry.snapshot().closed, 1);
assert.equal(clientRegistry.snapshot().clientClosed, 1);
assert.equal(clientTransport.closeCalls, 0);

const shutdownRegistry = new McpSessionRegistry<FakeTransport>({
  autoSweep: false,
});
const shutdownA = new FakeTransport();
const shutdownB = new FakeTransport();
shutdownRegistry.register("shutdown-a", shutdownA, 1);
shutdownRegistry.register("shutdown-b", shutdownB);
shutdownRegistry.close();
shutdownRegistry.close();
assert.equal(shutdownRegistry.snapshot().active, 0);
assert.equal(shutdownRegistry.snapshot().closed, 2);
assert.equal(shutdownA.closeCalls, 1);
assert.equal(shutdownB.closeCalls, 1);
assert.throws(
  () => shutdownRegistry.register("late", new FakeTransport()),
  /registry is closed/,
);

const soakRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 300_000,
  maxSessions: 256,
  autoSweep: false,
});
const soakTransports: FakeTransport[] = [];
for (let index = 0; index < 2_000; index += 1) {
  const transport = new FakeTransport();
  soakTransports.push(transport);
  soakRegistry.register(`soak-${index}`, transport);
}
assert.equal(soakRegistry.snapshot().active, 256);
assert.equal(soakRegistry.snapshot().created, 2_000);
assert.equal(soakRegistry.snapshot().capacityEvictions, 1_744);
assert.equal(
  soakTransports.reduce((total, transport) => total + transport.closeCalls, 0),
  1_744,
);
soakRegistry.close();
assert.equal(soakRegistry.snapshot().active, 0);
assert.equal(
  soakTransports.reduce((total, transport) => total + transport.closeCalls, 0),
  2_000,
);

now = 0;
const reuseRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 300_000,
  maxSessions: 10,
  now: () => now,
  autoSweep: false,
});
reuseRegistry.recordInitializeRequest();
reuseRegistry.recordInitializeRequest();
reuseRegistry.register("reuse", new FakeTransport(), 0, "main_connector");
for (let call = 0; call < 30; call += 1) {
  assert.ok(reuseRegistry.acquire("reuse"));
  now += 1_000;
  reuseRegistry.release("reuse");
}
const reuseSnapshot = reuseRegistry.snapshot();
assert.equal(reuseSnapshot.initializeRequests, 2);
assert.equal(reuseSnapshot.acquireRequests, 30);
assert.equal(reuseSnapshot.reusedRequests, 30);
assert.equal(reuseSnapshot.created, 1);
assert.equal(reuseSnapshot.active, 1);
assert.equal(reuseSnapshot.highWaterMark, 1);
assert.equal(reuseSnapshot.activeBySource.main_connector, 1);
assert.equal(reuseSnapshot.createdBySource.main_connector, 1);
assert.equal(reuseSnapshot.createdLastMinute, 1);
assert.equal(reuseSnapshot.createdLastFiveMinutes, 1);

const concurrentRegistry = new McpSessionRegistry<FakeTransport>({
  idleTtlMs: 100,
  maxSessions: 3,
  now: () => now,
  autoSweep: false,
});
concurrentRegistry.register("app", new FakeTransport(), 0, "workspace_app");
concurrentRegistry.register("doctor", new FakeTransport(), 0, "doctor");
concurrentRegistry.register("test", new FakeTransport(), 0, "test_client");
assert.ok(concurrentRegistry.acquire("app"));
assert.ok(concurrentRegistry.acquire("doctor"));
assert.ok(concurrentRegistry.acquire("test"));
now += 1_000;
assert.equal(concurrentRegistry.sweep(), 0);
assert.equal(concurrentRegistry.snapshot().inFlightRequests, 3);
concurrentRegistry.release("app");
concurrentRegistry.release("doctor");
concurrentRegistry.release("test");
assert.equal(concurrentRegistry.snapshot().inFlightRequests, 0);
assert.deepEqual(concurrentRegistry.snapshot().activeBySource, {
  main_connector: 0,
  workspace_app: 1,
  doctor: 1,
  test_client: 1,
  unknown: 0,
});

class RejectingTransport implements CloseableMcpTransport {
  async close(): Promise<void> {
    throw new Error("expected close failure");
  }
}
const closeErrors: string[] = [];
const failureRegistry = new McpSessionRegistry<RejectingTransport>({
  idleTtlMs: 1,
  now: () => now,
  autoSweep: false,
  onCloseError: ({ error }) => {
    closeErrors.push(error instanceof Error ? error.message : String(error));
  },
});
failureRegistry.register("reject", new RejectingTransport());
now += 1;
failureRegistry.sweep();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(failureRegistry.snapshot().closeErrors, 1);
assert.deepEqual(closeErrors, ["expected close failure"]);

const unknownRegistry = new McpSessionRegistry<FakeTransport>({
  autoSweep: false,
});
assert.equal(unknownRegistry.acquire("never-seen"), undefined);
assert.equal(unknownRegistry.snapshot().unknownSessionRequests, 1);
assert.equal(unknownRegistry.snapshot().unknownRequestsByReason.never_seen, 1);
