import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Response } from "express";
import { loadConfig } from "../config.js";
import { LiveRequestMonitor } from "../live-monitor.js";
import { mcpDiagnosticsSnapshot } from "../mcp-diagnostics.js";
import type {
  MonitorEvent,
  MonitorEventInput,
  MonitorEventStore,
} from "../monitor-events.js";
import {
  CLIENT_ABORT_STATUS,
  createRequestLoggingMiddleware,
  resolveRequestOutcome,
} from "./request-logging.js";

// --- pure outcome resolution -------------------------------------------------

assert.deepEqual(
  resolveRequestOutcome({ statusCode: 200, writableFinished: true }),
  { status: 200, aborted: false },
);
assert.deepEqual(
  resolveRequestOutcome({ statusCode: 201, writableFinished: true }),
  { status: 201, aborted: false },
);
assert.deepEqual(
  resolveRequestOutcome({ statusCode: 200, writableFinished: false }),
  { status: CLIENT_ABORT_STATUS, aborted: true },
);
assert.equal(CLIENT_ABORT_STATUS, 499);

// --- end-to-end middleware behaviour ----------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "devspace-request-logging-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(tempRoot, "config"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://mcp.workspaceport.com",
  DEVSPACE_STATE_DIR: join(tempRoot, "state"),
  DEVSPACE_WORKTREE_ROOT: join(tempRoot, "worktrees"),
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_LOG_REQUESTS: "1",
  DEVSPACE_LOG_TOOL_CALLS: "0",
});

interface CapturedLog extends Record<string, unknown> {
  level: string;
  event: string;
}

const logs: CapturedLog[] = [];
const events: MonitorEvent[] = [];
const requestMonitor = new LiveRequestMonitor();
const monitorEvents: Pick<MonitorEventStore, "record"> = {
  record: (input: MonitorEventInput): MonitorEvent => {
    const event: MonitorEvent = {
      timestamp: new Date().toISOString(),
      source: input.source,
      severity: input.severity,
      category: input.category ?? "invocation",
      code: input.code,
      message: input.message,
      ...(input.statusCode !== undefined
        ? { statusCode: input.statusCode }
        : {}),
    };
    events.push(event);
    return event;
  },
};

const app = express();
app.use(
  createRequestLoggingMiddleware({
    config,
    requestMonitor,
    monitorEvents,
    logRequest: (level, event, fields) => {
      logs.push({ level, event, ...fields });
    },
  }),
);

const openResponses: Response[] = [];
const holdOpen = (statusCode: number) =>
  (_req: express.Request, res: Response): void => {
    res.status(statusCode);
    res.setHeader("content-type", "text/plain");
    res.flushHeaders();
    res.write("open");
    openResponses.push(res);
  };
app.get("/slow", holdOpen(200));
app.post("/mcp", holdOpen(200));
app.get("/ok", (_req, res) => {
  res.status(201).json({ ok: true });
});

const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function abortRequest(path: string): Promise<void> {
  const url = new URL(baseUrl + path);
  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: path === "/mcp" ? "POST" : "GET",
        timeout: 3_000,
      },
      (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.once("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.end();
  });
  // Give the server a moment to observe the socket close.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

try {
  // 1. Normal response keeps the real status and is not marked aborted.
  const ok = await fetch(`${baseUrl}/ok`);
  assert.equal(ok.status, 201);
  await ok.json();
  await waitFor(
    () => logs.some((entry) => entry.path === "/ok"),
    "normal request log",
  );
  const okLog = logs.find((entry) => entry.path === "/ok");
  assert.ok(okLog);
  assert.equal(okLog.status, 201);
  assert.equal(okLog.aborted, undefined);
  assert.equal(requestMonitor.snapshot().http.errors, 0);

  // 2. Client abort of a non-MCP route is reported as 499, counted as an
  //    error and surfaced as an HTTP_499 monitor event.
  await abortRequest("/slow");
  await waitFor(
    () => logs.some((entry) => entry.path === "/slow" && entry.status === 499),
    "aborted request log",
  );
  const abortLog = logs.find(
    (entry) => entry.path === "/slow" && entry.status === 499,
  );
  assert.ok(abortLog);
  assert.equal(abortLog.aborted, true);
  assert.equal(typeof abortLog.durationMs, "number");
  assert.ok(requestMonitor.snapshot().http.errors >= 1);
  const abortEvent = events.find((event) => event.code === "HTTP_499");
  assert.ok(abortEvent);
  assert.equal(abortEvent.statusCode, 499);
  assert.match(abortEvent.message, /aborted by client/);
  assert.equal(abortEvent.severity, "warning");

  // 3. Client abort of /mcp also lands in MCP diagnostics with 499.
  await abortRequest("/mcp");
  await waitFor(
    () =>
      mcpDiagnosticsSnapshot(200).events.some(
        (event) => event.stage === "client_abort" && event.statusCode === 499,
      ),
    "mcp client_abort diagnostic",
  );
  const diagnostic = mcpDiagnosticsSnapshot(200).events.find(
    (event) => event.stage === "client_abort" && event.statusCode === 499,
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.errorClass, "CLIENT_ABORT");
  assert.equal(diagnostic.traceId?.length, 36);

  console.log("request logging abort semantics PASS");
} finally {
  for (const response of openResponses) response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
}
