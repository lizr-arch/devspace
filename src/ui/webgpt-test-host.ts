import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_NAMES, type ToolName } from "./card-types.js";
import "./webgpt-test-host.css";

interface TestConfig {
  currentResourceUri: string;
  legacyResourceUri: string;
  previousBuildResourceUri: string;
  declaredUi: {
    domain?: string;
    csp?: {
      resourceDomains?: string[];
      connectDomains?: string[];
    };
  };
}

interface TestResource {
  uri: string;
  mimeType: string;
  html: string;
}

interface ProbeState {
  ready: boolean;
  text: string;
  errors: string[];
}

interface ViewHandle {
  bridge: AppBridge;
  container: HTMLElement;
  frame: HTMLIFrameElement;
  state: ProbeState;
  transport: PostMessageTransport;
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

interface ToolMatrixResult {
  tool: ToolName;
  passed: boolean;
  detail: string;
}

interface SuiteReport {
  status: "idle" | "running" | "complete";
  passed: number;
  failed: number;
  durationMs: number;
  results: ScenarioResult[];
  activeFrames: number;
  toolMatrix: {
    total: number;
    passed: number;
    failed: number;
    results: ToolMatrixResult[];
  };
}

declare global {
  interface Window {
    __DEVSPACE_WEBGPT_TEST_REPORT__?: SuiteReport;
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element as T;
};

const runButton = byId<HTMLButtonElement>("run-suite");
const themeButton = byId<HTMLButtonElement>("toggle-theme");
const concurrencySelect = byId<HTMLSelectElement>("concurrency");
const resultsList = byId<HTMLOListElement>("results");
const toolMatrix = byId<HTMLDivElement>("tool-matrix");
const frames = byId<HTMLDivElement>("frames");
const events = byId<HTMLPreElement>("events");
const suiteDot = byId<HTMLSpanElement>("suite-dot");
const suiteState = byId<HTMLSpanElement>("suite-state");

const views: ViewHandle[] = [];
const eventLines: string[] = [];
let config: TestConfig;
let hostTheme: "light" | "dark" = "dark";
let running = false;
let toolMatrixResults: ToolMatrixResult[] = [];

window.addEventListener("message", (event) => {
  if (
    !event.data ||
    typeof event.data !== "object" ||
    event.data.source !== "devspace-webgpt-test-probe"
  ) {
    return;
  }

  const view = views.find(
    (candidate) => candidate.frame.contentWindow === event.source,
  );
  if (!view) return;
  const kind =
    typeof event.data.event === "string" ? event.data.event : "event";
  if (kind === "ready") view.state.ready = true;
  if (kind === "snapshot" && typeof event.data.text === "string") {
    view.state.text = event.data.text;
    if (typeof event.data.height === "number") {
      view.frame.style.height = `${Math.min(620, Math.max(220, event.data.height + 12))}px`;
    }
  }
  if (kind === "error") {
    const detail =
      typeof event.data.resourceUrl === "string" && event.data.resourceUrl
        ? event.data.resourceUrl
        : String(event.data.message ?? "unknown iframe error");
    view.state.errors.push(detail);
    logEvent(`iframe error: ${detail}`);
  }
});

window.addEventListener("error", (event) => {
  logEvent(`host error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  logEvent(`host rejection: ${String(event.reason)}`);
});

runButton.addEventListener("click", () => void runSuite());
themeButton.addEventListener("click", () => {
  hostTheme = hostTheme === "dark" ? "light" : "dark";
  for (const view of views) {
    view.bridge.setHostContext(hostContext());
  }
  logEvent(`host context changed: theme=${hostTheme}`);
});
byId<HTMLButtonElement>("clear-events").addEventListener("click", () => {
  eventLines.length = 0;
  events.textContent = "等待事件…";
});

void initialize();

async function initialize(): Promise<void> {
  config = await fetchJson<TestConfig>("/app-test/api");
  byId("resource-uri").textContent = config.currentResourceUri;
  logEvent(`current resource: ${config.currentResourceUri}`);

  const params = new URLSearchParams(window.location.search);
  if (params.get("autorun") !== "0") {
    const concurrency = params.get("concurrency");
    if (concurrency && ["1", "4", "8", "16"].includes(concurrency)) {
      concurrencySelect.value = concurrency;
    }
    await runSuite();
  }
}

async function runSuite(): Promise<void> {
  if (running) return;
  running = true;
  runButton.disabled = true;
  resultsList.replaceChildren();
  toolMatrix.replaceChildren();
  toolMatrixResults = [];
  byId("matrix-passed").textContent = "0";
  await disposeViews();
  frames.replaceChildren();
  const results: ScenarioResult[] = [];
  const startedAt = performance.now();
  setSuiteStatus("running", "正在运行");
  updateReport("running", results, startedAt);

  const run = async (
    name: string,
    operation: () => Promise<string>,
  ): Promise<void> => {
    const scenarioStartedAt = performance.now();
    try {
      const detail = await operation();
      const result = {
        name,
        passed: true,
        detail,
        durationMs: Math.round(performance.now() - scenarioStartedAt),
      };
      results.push(result);
      renderResult(result);
    } catch (error) {
      const result = {
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - scenarioStartedAt),
      };
      results.push(result);
      renderResult(result);
    }
    updateReport("running", results, startedAt);
  };

  await run("当前版本 URI + AppBridge 握手 + 已知结果卡", async () => {
    const sentinel = "LOCAL_CURRENT_SENTINEL";
    await createView(
      "current",
      config.currentResourceUri,
      resultFixture("read_file", sentinel),
      sentinel,
    );
    return "当前模板加载、ui/initialize 和 read_file 渲染均正常";
  });

  await run("旧版固定 URI 兼容", async () => {
    const sentinel = "LOCAL_LEGACY_SENTINEL";
    await createView(
      "legacy",
      config.legacyResourceUri,
      resultFixture("read_file", sentinel),
      sentinel,
    );
    return config.legacyResourceUri;
  });

  await run("历史指纹 URI 兼容", async () => {
    const sentinel = "LOCAL_PREVIOUS_BUILD_SENTINEL";
    await createView(
      "previous build",
      config.previousBuildResourceUri,
      resultFixture("read_file", sentinel),
      sentinel,
    );
    return config.previousBuildResourceUri;
  });

  await run("同一会话内结果更新", async () => {
    const first = "LOCAL_UPDATE_FIRST";
    const second = "LOCAL_UPDATE_SECOND";
    const view = await createView(
      "result update",
      config.currentResourceUri,
      resultFixture("read_file", first),
      first,
    );
    await view.bridge.sendToolResult(resultFixture("read_file", second));
    await waitFor(() => view.state.text.includes(second), 5_000);
    return "复用同一 iframe 时第二次 tool-result 已替换首个结果";
  });

  await run("未知工具通用卡降级", async () => {
    const sentinel = "LOCAL_GENERIC_SENTINEL";
    await createView(
      "generic fallback",
      config.currentResourceUri,
      resultFixture("future_tool_not_known_locally", sentinel),
      "Tool Result",
    );
    return "未知工具未产生空卡，已落入通用结果卡";
  });

  await run("错误结果卡渲染", async () => {
    const sentinel = "LOCAL_ERROR_RESULT_SENTINEL";
    await createView(
      "error result",
      config.currentResourceUri,
      resultFixture("read_file", sentinel, true),
      sentinel,
    );
    return "isError=true 仍可形成可见卡片";
  });

  await run("宿主上下文热更新", async () => {
    const sentinel = "LOCAL_CONTEXT_SENTINEL";
    const view = await createView(
      "host context",
      config.currentResourceUri,
      resultFixture("read_file", sentinel),
      sentinel,
    );
    hostTheme = hostTheme === "dark" ? "light" : "dark";
    view.bridge.setHostContext(hostContext());
    await delay(80);
    if (view.state.errors.length > 0) {
      throw new Error(view.state.errors.join("; "));
    }
    return `theme=${hostTheme}, locale=zh-CN, platform=web`;
  });

  await run("CSP / 资源失败可观测性", async () => {
    const sentinel = "LOCAL_CSP_SENTINEL";
    const view = await createView(
      "csp detection",
      config.currentResourceUri,
      resultFixture("read_file", sentinel),
      sentinel,
      true,
    );
    await waitFor(() => view.state.errors.length > 0, 5_000);
    if (
      !view.state.errors.some((message) => message.includes("example.invalid"))
    ) {
      throw new Error(`未识别故障资源：${view.state.errors.join(", ")}`);
    }
    return "故障注入被捕获，Workspace App 主脚本仍完成握手和渲染";
  });

  await run("非法模板 URI 拒绝", async () => {
    const response = await fetch(
      `/app-test/api?uri=${encodeURIComponent(
        "ui://devspace/workspace-app-not-a-fingerprint.html",
      )}`,
      { cache: "no-store" },
    );
    if (response.status !== 404) {
      throw new Error(`expected HTTP 404, received ${response.status}`);
    }
    return "无效 URI 返回 HTTP 404，不会错误回落到当前模板";
  });

  await run("58 工具逐项 Workspace App 卡片矩阵", async () => {
    toolMatrixResults = await runToolContractMatrix();
    const failedTools = toolMatrixResults.filter((result) => !result.passed);
    if (failedTools.length > 0) {
      throw new Error(
        failedTools
          .map((result) => `${result.tool}: ${result.detail}`)
          .join("; "),
      );
    }
    return `${toolMatrixResults.length} 个工具全部完成独立 iframe 握手与非空卡片渲染`;
  });

  await run("多卡并发沙箱", async () => {
    const count = Number.parseInt(concurrencySelect.value, 10);
    const concurrent = Array.from({ length: count }, (_, index) => {
      const sentinel = `LOCAL_CONCURRENT_${index + 1}`;
      return createView(
        `concurrent ${index + 1}`,
        config.currentResourceUri,
        resultFixture("read_file", sentinel),
        sentinel,
      );
    });
    await Promise.all(concurrent);
    return `${count} 个独立 iframe 同时完成握手和结果渲染`;
  });

  const failed = results.filter((result) => !result.passed).length;
  setSuiteStatus(
    failed === 0 ? "passed" : "failed",
    failed === 0 ? "全部通过" : `${failed} 项失败`,
  );
  updateReport("complete", results, startedAt);
  runButton.disabled = false;
  running = false;
}

async function createView(
  title: string,
  resourceUri: string,
  result: CallToolResult,
  expectedText?: string,
  injectFailure = false,
): Promise<ViewHandle> {
  const resource = await fetchJson<TestResource>(
    `/app-test/api?uri=${encodeURIComponent(resourceUri)}`,
  );
  if (resource.mimeType !== "text/html;profile=mcp-app") {
    throw new Error(`unexpected MIME type: ${resource.mimeType}`);
  }

  const frameCard = document.createElement("article");
  frameCard.className = "frame-card";
  const frameTitle = document.createElement("div");
  frameTitle.className = "frame-title";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const status = document.createElement("span");
  status.textContent = "连接中";
  frameTitle.append(strong, status);

  const frame = document.createElement("iframe");
  frame.title = `Workspace App: ${title}`;
  frame.sandbox.add("allow-scripts");
  frameCard.append(frameTitle, frame);
  frames.append(frameCard);

  const state: ProbeState = { ready: false, text: "", errors: [] };
  const bridge = new AppBridge(
    null,
    { name: "DevSpace Local Web GPT Host", version: "1.0.0" },
    { logging: {}, serverTools: {} },
    { hostContext: hostContext() },
  );
  bridge.oncalltool = async (params) => {
    logEvent(`view tools/call: ${params.name}`);
    return {
      content: [
        {
          type: "text",
          text:
            params.name === "report_workspace_app_error"
              ? "Local host captured Workspace App diagnostic."
              : `Local host fixture response for ${params.name}.`,
        },
      ],
    };
  };

  let resolveInitialized: (() => void) | undefined;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });
  bridge.oninitialized = () => {
    status.textContent = "已握手";
    logEvent(`ui/notifications/initialized: ${title}`);
    resolveInitialized?.();
  };

  const contentWindow = frame.contentWindow;
  if (!contentWindow) throw new Error("iframe contentWindow unavailable");
  const transport = new PostMessageTransport(contentWindow, contentWindow);
  const view = { bridge, container: frameCard, frame, state, transport };
  views.push(view);
  byId("active-frames").textContent = String(views.length);

  await bridge.connect(transport);
  frame.srcdoc = instrumentResource(resource.html, injectFailure);
  await withTimeout(initialized, 8_000, "ui/initialize timed out");
  await bridge.sendToolInput({ arguments: { localTest: title } });
  await bridge.sendToolResult(result);
  try {
    await waitFor(
      () =>
        expectedText
          ? state.text.includes(expectedText)
          : isRenderedCardSnapshot(state.text),
      6_000,
    );
  } catch {
    throw new Error(
      `result text not observed; iframe snapshot=${JSON.stringify(
        state.text.slice(0, 600),
      )}`,
    );
  }

  const unexpectedErrors = injectFailure
    ? state.errors.filter((message) => !message.includes("example.invalid"))
    : state.errors;
  if (unexpectedErrors.length > 0) {
    throw new Error(`iframe errors: ${unexpectedErrors.join("; ")}`);
  }

  status.textContent = "已渲染";
  return view;
}

async function runToolContractMatrix(): Promise<ToolMatrixResult[]> {
  const results = await mapWithConcurrency(
    [...TOOL_NAMES],
    6,
    async (tool): Promise<ToolMatrixResult> => {
      let view: ViewHandle | undefined;
      try {
        view = await createView(
          `tool matrix: ${tool}`,
          config.currentResourceUri,
          matrixResultFixture(tool),
        );
        const detail = compactSnapshot(view.state.text);
        await disposeView(view);
        return { tool, passed: true, detail };
      } catch (error) {
        if (view) await disposeView(view);
        return {
          tool,
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  for (const result of results) renderToolMatrixResult(result);
  const passed = results.filter((result) => result.passed).length;
  byId("matrix-passed").textContent = String(passed);
  byId("matrix-total").textContent = String(results.length);
  return results;
}

function matrixResultFixture(tool: ToolName): CallToolResult {
  const marker = `fixtures/matrix/${tool}.txt`;
  const text = `MATRIX_${tool}\nSynthetic local contract fixture.`;
  return {
    content: [{ type: "text", text }],
    _meta: { tool },
    structuredContent: {
      status: "success",
      workspaceId: "workspace-tool-matrix",
      root: "/tmp/devspace-tool-matrix",
      path: marker,
      outcome: "verified",
      readyForPipeline: true,
      indexed: 1,
      count: 1,
      summary: {
        source: "webgpt-local-tool-matrix",
        lines: 2,
        count: 1,
        indexed: 1,
        files: 1,
        pattern: tool,
        command: `fixture:${tool}`,
        jobId: `job-${tool}`,
        status: "completed",
        agentsFiles: 0,
        skills: 0,
        skillDiagnostics: 0,
      },
      files: [
        {
          path: marker,
          type: "modified",
          additions: 1,
          removals: 0,
        },
      ],
      agentsFiles: [],
      availableAgentsFiles: [],
      skills: [],
      skillDiagnostics: [],
      payload: {
        content: [{ type: "text", text }],
        patch: [
          `diff --git a/${marker} b/${marker}`,
          `--- a/${marker}`,
          `+++ b/${marker}`,
          "@@ -1 +1 @@",
          "-before",
          `+MATRIX_${tool}`,
        ].join("\n"),
      },
    },
  };
}

function resultFixture(
  tool: string,
  sentinel: string,
  isError = false,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${sentinel}\nLocal browser-host fixture for ${tool}.`,
      },
    ],
    isError,
    _meta: { tool },
    structuredContent: {
      status: isError ? "error" : "success",
      path: `fixtures/${sentinel}.txt`,
      summary: { source: "webgpt-local-test", sentinel },
      payload: {
        content: [
          {
            type: "text",
            text: `${sentinel}\nLocal browser-host fixture for ${tool}.`,
          },
        ],
      },
    },
  };
}

function isRenderedCardSnapshot(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 &&
    !normalized.includes("Connecting to host") &&
    !normalized.includes("Waiting for a tool result") &&
    !normalized.includes("Unable to render this tool result") &&
    !normalized.includes("Workspace App unavailable")
  );
}

function compactSnapshot(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 120) || "rendered";
}

function instrumentResource(html: string, injectFailure: boolean): string {
  const origin = window.location.origin;
  const declaredResources = config.declaredUi.csp?.resourceDomains ?? [];
  const declaredConnect = config.declaredUi.csp?.connectDomains ?? [];
  const resourceSources = uniqueCspSources([origin, ...declaredResources]);
  const connectSources = uniqueCspSources([origin, ...declaredConnect]);
  const csp = [
    "default-src 'none'",
    `script-src ${resourceSources}`,
    `style-src ${resourceSources} 'unsafe-inline'`,
    `img-src ${resourceSources} data: blob:`,
    `font-src ${resourceSources}`,
    `connect-src ${connectSources}`,
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const failureScript = injectFailure
    ? '<script src="https://example.invalid/devspace-csp-probe.js"></script>'
    : "";
  const instrumentation = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<script src="/app-test/probe.js"></script>',
    failureScript,
  ].join("");
  return html.replace(/<head>/i, `<head>${instrumentation}`);
}

function uniqueCspSources(values: string[]): string {
  return [...new Set(values.map((value) => new URL(value).origin))].join(" ");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function hostContext() {
  return {
    theme: hostTheme,
    locale: "zh-CN",
    timeZone: "Asia/Shanghai",
    displayMode: "inline" as const,
    availableDisplayModes: ["inline" as const],
    platform: "web" as const,
    containerDimensions: { width: 560, maxHeight: 620 },
    userAgent: "DevSpace Local Web GPT Compatibility Host",
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`condition timed out after ${timeoutMs}ms`);
    }
    await delay(30);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function disposeViews(): Promise<void> {
  await Promise.all([...views].map((view) => disposeView(view)));
  byId("active-frames").textContent = "0";
}

async function disposeView(view: ViewHandle): Promise<void> {
  const index = views.indexOf(view);
  if (index >= 0) views.splice(index, 1);
  try {
    await view.bridge.teardownResource({});
  } catch {
    // A partially initialized view is safe to discard in the local harness.
  }
  await view.transport.close();
  view.container.remove();
  byId("active-frames").textContent = String(views.length);
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  limit: number,
  operation: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const outputs = new Array<TOutput>(inputs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, async () => {
      while (cursor < inputs.length) {
        const index = cursor++;
        outputs[index] = await operation(inputs[index]);
      }
    }),
  );
  return outputs;
}

function renderResult(result: ScenarioResult): void {
  const item = document.createElement("li");
  item.className = `result ${result.passed ? "passed" : "failed"}`;
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = result.passed ? "✓" : "×";
  const name = document.createElement("strong");
  name.textContent = result.name;
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent = result.detail;
  const time = document.createElement("time");
  time.textContent = `${result.durationMs} ms`;
  item.append(mark, name, detail, time);
  resultsList.append(item);
}

function renderToolMatrixResult(result: ToolMatrixResult): void {
  const item = document.createElement("article");
  item.className = `tool-contract ${result.passed ? "passed" : "failed"}`;
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = result.passed ? "✓" : "×";
  const tool = document.createElement("strong");
  tool.textContent = result.tool;
  const detail = document.createElement("span");
  detail.textContent = result.detail;
  item.append(mark, tool, detail);
  toolMatrix.append(item);
}

function setSuiteStatus(
  state: "running" | "passed" | "failed",
  label: string,
): void {
  suiteDot.className = `dot ${state}`;
  suiteState.textContent = label;
}

function updateReport(
  status: SuiteReport["status"],
  results: ScenarioResult[],
  startedAt: number,
): void {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const durationMs = Math.round(performance.now() - startedAt);
  byId("passed").textContent = String(passed);
  byId("failed").textContent = String(failed);
  byId("duration").textContent = `${durationMs} ms`;
  const report: SuiteReport = {
    status,
    passed,
    failed,
    durationMs,
    results: [...results],
    activeFrames: views.length,
    toolMatrix: {
      total: toolMatrixResults.length,
      passed: toolMatrixResults.filter((result) => result.passed).length,
      failed: toolMatrixResults.filter((result) => !result.passed).length,
      results: [...toolMatrixResults],
    },
  };
  window.__DEVSPACE_WEBGPT_TEST_REPORT__ = report;
  document.body.dataset.suiteStatus = status;
}

function logEvent(message: string): void {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  eventLines.push(`${timestamp}  ${message}`);
  if (eventLines.length > 200) eventLines.splice(0, eventLines.length - 200);
  events.textContent = eventLines.join("\n");
  events.scrollTop = events.scrollHeight;
}
