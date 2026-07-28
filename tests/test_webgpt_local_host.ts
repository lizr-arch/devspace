import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { startLocalWebGptTestServer } from "./webgpt_local_server.js";

interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

interface SuiteReport {
  status: "complete";
  passed: number;
  failed: number;
  durationMs: number;
  results: ScenarioResult[];
  activeFrames: number;
}

const server = await startLocalWebGptTestServer();
let browser: Browser | undefined;

try {
  const pageResponse = await fetch(`${server.baseUrl}/app-test`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.match(
    pageResponse.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.ok(
    [403, 404].includes(
      await requestStatusWithHost(
        new URL(server.baseUrl).port,
        "/app-test",
        "mcp.workspaceport.com",
      ),
    ),
  );
  assert.equal(
    await requestStatusWithHost(
      new URL(server.baseUrl).port,
      "/app-test",
      "127.0.0.1",
      { "cf-ray": "local-test-must-not-be-public" },
    ),
    404,
  );

  browser = await chromium.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });
  const unexpectedConsoleErrors: string[] = [];
  const unexpectedRequestFailures: string[] = [];
  const badLocalResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const sourceUrl = message.location().url;
    if (
      text.includes("example.invalid/devspace-csp-probe.js") ||
      sourceUrl.includes("example.invalid/devspace-csp-probe.js") ||
      sourceUrl.includes("/app-test/api?uri=") ||
      sourceUrl.endsWith("/favicon.ico")
    ) {
      return;
    }
    unexpectedConsoleErrors.push(sourceUrl ? `${text} (${sourceUrl})` : text);
  });
  page.on("pageerror", (error) => {
    unexpectedConsoleErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("example.invalid/devspace-csp-probe.js")) return;
    unexpectedRequestFailures.push(
      `${request.failure()?.errorText ?? "failed"} ${url}`,
    );
  });
  page.on("response", (response) => {
    const url = response.url();
    if (
      response.status() >= 400 &&
      (url.includes("/mcp-app-assets/") || url.includes("/app-test/assets/"))
    ) {
      badLocalResponses.push(`${response.status()} ${url}`);
    }
  });

  await page.goto(`${server.baseUrl}/app-test?autorun=1&concurrency=8`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      document.body.dataset.suiteStatus === "complete" &&
      window.__DEVSPACE_WEBGPT_TEST_REPORT__?.status === "complete",
    undefined,
    { timeout: 90_000 },
  );
  const report = (await page.evaluate(
    () => window.__DEVSPACE_WEBGPT_TEST_REPORT__,
  )) as SuiteReport | undefined;
  const hostEvents = await page.locator("#events").innerText();

  assert.ok(report, "browser host did not publish a suite report");
  assert.equal(report.status, "complete");
  assert.equal(report.results.length, 10);
  assert.equal(
    report.failed,
    0,
    `${formatFailures(report.results)}\n\nHost events:\n${hostEvents}\n\nConsole errors:\n${unexpectedConsoleErrors.join("\n")}`,
  );
  assert.equal(report.passed, 10);
  assert.equal(report.activeFrames, 16);
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(unexpectedRequestFailures, []);
  assert.deepEqual(badLocalResponses, []);

  console.log("\nWeb GPT Local Browser Host Tests\n");
  for (const result of report.results) {
    console.log(
      `  [${result.passed ? "PASS" : "FAIL"}] ${result.name} (${result.durationMs} ms)`,
    );
  }
  console.log(
    `\n  Results: ${report.passed}/${report.results.length} passed in ${report.durationMs} ms`,
  );
  console.log("  Local-only route boundary: PASS");
  console.log("  Browser console/network gate: PASS\n");
} finally {
  await browser?.close();
  await server.close();
}

function findBrowserExecutable(): string {
  const configured = process.env["DEVSPACE_TEST_BROWSER"];
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "No Chromium browser found. Install Chrome/Edge/Chromium or set DEVSPACE_TEST_BROWSER to its executable.",
    );
  }
  return executable;
}

function formatFailures(results: ScenarioResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => `${result.name}: ${result.detail}`)
    .join("\n");
}

async function requestStatusWithHost(
  port: string,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        headers: { host, ...headers },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
  });
}
