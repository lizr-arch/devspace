import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  LiveRequestMonitor,
  isLocalMonitorHost,
  liveMonitorHtml,
} from "./live-monitor.js";
import { createServer } from "./server.js";

assert.equal(isLocalMonitorHost("localhost"), true);
assert.equal(isLocalMonitorHost("localhost:7676"), true);
assert.equal(isLocalMonitorHost("127.0.0.1:7676"), true);
assert.equal(isLocalMonitorHost("[::1]:7676"), true);
assert.equal(isLocalMonitorHost("mcp.workspaceport.com"), false);
assert.equal(isLocalMonitorHost("127.0.0.1.evil.example"), false);
assert.equal(isLocalMonitorHost(undefined), false);

const monitor = new LiveRequestMonitor();
const finishFirst = monitor.begin("/mcp", 100_000);
const finishSecond = monitor.begin("/mcp", 100_100);
monitor.begin("/monitor/api", 100_200)(200, 1);

let snapshot = monitor.snapshot(100_500);
assert.equal(snapshot.mcp.inFlight, 2);
assert.equal(snapshot.mcp.peakInFlight, 2);
assert.equal(snapshot.mcp.total, 2);
assert.equal(snapshot.http.total, 2);
assert.equal(snapshot.mcp.perMinute, 2);
assert.equal(
  snapshot.mcpRequestsPerSecond.reduce((total, value) => total + value, 0),
  2,
);

finishFirst(200, 80);
finishFirst(500, 90);
finishSecond(500, 120);
snapshot = monitor.snapshot(100_600);
assert.equal(snapshot.mcp.inFlight, 0);
assert.equal(snapshot.mcp.completed, 2);
assert.equal(snapshot.mcp.errors, 1);
assert.equal(snapshot.mcp.averageLatencyMs, 100);

snapshot = monitor.snapshot(161_000);
assert.equal(snapshot.mcp.perMinute, 0);
assert.equal(
  snapshot.mcpRequestsPerSecond.reduce((total, value) => total + value, 0),
  0,
);

const html = liveMonitorHtml();
assert.match(html, /DevSpace Live Monitor/);
assert.match(html, /setInterval\(refresh,1000\)/);
assert.doesNotMatch(html, /https?:\/\//);

const tempRoot = mkdtempSync(join(tmpdir(), "devspace-live-monitor-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(tempRoot, "config"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://mcp.workspaceport.com",
  DEVSPACE_STATE_DIR: join(tempRoot, "state"),
  DEVSPACE_WORKTREE_ROOT: join(tempRoot, "worktrees"),
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_LOG_REQUESTS: "0",
  DEVSPACE_LOG_TOOL_CALLS: "0",
});
const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
try {
  await once(httpServer, "listening");
  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${baseUrl}/monitor`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );

  const api = await fetch(`${baseUrl}/monitor/api`);
  assert.equal(api.status, 200);
  const payload = (await api.json()) as {
    service: { name: string };
    requests: { mcp: { total: number } };
  };
  assert.equal(payload.service.name, "devspace");
  assert.equal(payload.requests.mcp.total, 0);

  assert.equal(
    await requestStatusWithHost(
      address.port,
      "/monitor",
      "mcp.workspaceport.com",
    ),
    404,
  );
  assert.equal(
    await requestStatusWithHost(address.port, "/monitor", "127.0.0.1", {
      "cf-ray": "test-ray",
    }),
    404,
  );
} finally {
  httpServer.close();
  await once(httpServer, "close");
  running.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("live monitor tests passed");

async function requestStatusWithHost(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = get(
      { hostname: "127.0.0.1", port, path, headers: { host, ...headers } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
  });
}
