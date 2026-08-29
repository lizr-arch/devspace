import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { logEvent, requestPath, sessionIdPrefix } from "../logger.js";
import { classifyMcpClient } from "../mcp-client-classification.js";
import { SingleUserOAuthProvider } from "../oauth-provider.js";
import { safeMonitorPath } from "../monitor-events.js";
import {
  type LiveRequestMonitor,
  type ProcessResourceMonitor,
  calculateLoadAssessment,
  diskSpaceSnapshot,
  liveMonitorHtml,
  requireLocalMonitor,
  setMonitorSecurityHeaders,
} from "../live-monitor.js";
import type { McpSessionRegistry } from "../mcp-session-registry.js";
import {
  WEBGPT_TEST_HOST_ENTRY,
  WEBGPT_TEST_PROBE_JAVASCRIPT,
  WEBGPT_TEST_SECURITY_HEADERS,
  isWorkspaceAppTestResourceUri,
  prepareWebGptTestHostHtml,
} from "../webgpt-local-test.js";
import {
  PACKAGE_VERSION,
  TOOL_SCHEMA_REVISION,
  LEGACY_WORKSPACE_APP_RESOURCE_URI,
  type ServerContext,
  type Transport,
} from "./server-types.js";
import {
  requestLogFields,
  sendJsonRpcError,
  processMemorySnapshot,
} from "./server-helpers.js";
import {
  workspaceAppHtml,
  workspaceAppUiMetadata,
  setAssetHeaders,
  webGptTestBuildDirectoryUrl,
} from "./server-workspace-app.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function setupExpressRoutes(params: {
  app: express.Express;
  ctx: ServerContext;
  mcpSessions: McpSessionRegistry<Transport>;
  resourceServerUrl: URL;
  oauthProvider: SingleUserOAuthProvider;
  bearerAuth: express.RequestHandler;
  requestMonitor: LiveRequestMonitor;
  resourceMonitor: ProcessResourceMonitor;
  createMcpServer: (ctx: ServerContext) => McpServer;
}): void {
  const {
    app,
    ctx,
    mcpSessions,
    resourceServerUrl,
    oauthProvider,
    bearerAuth,
    requestMonitor,
    resourceMonitor,
    createMcpServer,
  } = params;
  const { config, runtime, jobs, publisher, workspaceApp } = ctx;

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const finishMonitoring = requestMonitor.begin(requestPath(req));
    res.locals.requestId = requestId;

    let completed = false;
    const completeRequest = () => {
      if (completed) return;
      completed = true;
      finishMonitoring(res.statusCode, performance.now() - startedAt);
      const path = requestPath(req);
      if (
        res.statusCode >= 400 &&
        path !== "/monitor" &&
        !path.startsWith("/monitor/") &&
        path !== "/app-test" &&
        !path.startsWith("/app-test/")
      ) {
        runtime.monitorEvents.record({
          source: "http",
          severity: res.statusCode >= 500 ? "error" : "warning",
          code: `HTTP_${res.statusCode}`,
          message: `${req.method} ${safeMonitorPath(path)} returned ${res.statusCode}`,
          statusCode: res.statusCode,
        });
      }
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    };
    res.once("finish", completeRequest);
    res.once("close", completeRequest);

    next();
  });

  app.get("/monitor", (req, res) => {
    if (!requireLocalMonitor(req, res)) return;
    setMonitorSecurityHeaders(res);
    res.type("html").send(liveMonitorHtml());
  });

  app.get("/monitor/api", (req, res) => {
    if (!requireLocalMonitor(req, res)) return;
    setMonitorSecurityHeaders(res);
    const requests = requestMonitor.snapshot();
    const resources = resourceMonitor.snapshot();
    const jobSnapshot = jobs.monitorSnapshot();
    res.json({
      observedAt: new Date().toISOString(),
      service: {
        name: "devspace",
        version: PACKAGE_VERSION,
        bootId: runtime.bootId,
        startedAt: runtime.startedAt,
        uptimeSeconds: Math.max(
          0,
          Math.round((Date.now() - Date.parse(runtime.startedAt)) / 1_000),
        ),
      },
      process: {
        pid: process.pid,
        cpuPercent: resources.processCpuPercent,
        cpuAverage15s: resources.processCpuAverage15s,
      },
      memory: {
        rssMiB: resources.rssMiB,
        heapUsedMiB: resources.heapUsedMiB,
        heapTotalMiB: resources.heapTotalMiB,
        externalMiB: resources.externalMiB,
        rssGrowthMiBPerMinute: resources.rssGrowthMiBPerMinute,
      },
      system: {
        cpuPercent: resources.systemCpuPercent,
        cpuAverage15s: resources.systemCpuAverage15s,
        memoryUsedPercent: resources.systemMemoryUsedPercent,
        memoryAvailableMiB: resources.systemMemoryAvailableMiB,
        memoryTotalMiB: resources.systemMemoryTotalMiB,
        disk: diskSpaceSnapshot(config.stateDir),
      },
      eventLoop: {
        p95Ms: resources.eventLoopP95Ms,
        maxMs: resources.eventLoopMaxMs,
      },
      resourceHistory: resources.history,
      requests,
      sessions: mcpSessions.snapshot(),
      jobs: jobSnapshot,
      errors: {
        recent: runtime.monitorEvents.snapshot(50),
        persisted: runtime.monitorEvents.isPersistent(),
        retention: 200,
      },
      load: calculateLoadAssessment({
        requests,
        resources,
        jobs: jobSnapshot,
      }),
    });
  });

  if (workspaceApp) {
    app.get("/app-test", (req, res) => {
      if (!requireLocalMonitor(req, res)) return;
      for (const [name, value] of Object.entries(
        WEBGPT_TEST_SECURITY_HEADERS,
      )) {
        res.setHeader(name, value);
      }
      try {
        const html = readFileSync(
          join(
            fileURLToPath(webGptTestBuildDirectoryUrl()),
            WEBGPT_TEST_HOST_ENTRY,
          ),
          "utf8",
        );
        res.type("html").send(prepareWebGptTestHostHtml(html));
      } catch {
        res
          .status(503)
          .type("text")
          .send("Local Web GPT test host is unavailable. Run npm run build.");
      }
    });

    app.get("/app-test/api", (req, res) => {
      if (!requireLocalMonitor(req, res)) return;
      for (const [name, value] of Object.entries(
        WEBGPT_TEST_SECURITY_HEADERS,
      )) {
        res.setHeader(name, value);
      }

      const requestedResourceUri =
        typeof req.query.uri === "string" ? req.query.uri : undefined;
      if (!requestedResourceUri) {
        res.json({
          currentResourceUri: workspaceApp.resourceUri,
          legacyResourceUri: LEGACY_WORKSPACE_APP_RESOURCE_URI,
          previousBuildResourceUri:
            "ui://devspace/workspace-app-0000000000000000.html",
          declaredUi: workspaceAppUiMetadata(config),
        });
        return;
      }

      if (
        !isWorkspaceAppTestResourceUri(
          requestedResourceUri,
          workspaceApp.resourceUri,
          LEGACY_WORKSPACE_APP_RESOURCE_URI,
        )
      ) {
        res.status(404).json({ error: "Workspace App resource not found." });
        return;
      }

      const localAssetBase = `${req.protocol}://${req.get("host")}/mcp-app-assets`;
      res.json({
        uri: requestedResourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        html: workspaceAppHtml(config, workspaceApp, localAssetBase),
        _meta: {
          ui: workspaceAppUiMetadata(config),
        },
      });
    });

    app.get("/app-test/probe.js", (req, res) => {
      if (!requireLocalMonitor(req, res)) return;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("application/javascript").send(WEBGPT_TEST_PROBE_JAVASCRIPT);
    });

    app.use(
      "/app-test/assets",
      (req, res, next) => {
        if (!requireLocalMonitor(req, res)) return;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        next();
      },
      express.static(
        join(fileURLToPath(webGptTestBuildDirectoryUrl()), "assets"),
        {
          fallthrough: false,
        },
      ),
    );
  }

  app.get("/artifacts/:token", async (req, res) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    await publisher.serve(token, res);
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  if (workspaceApp) {
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
      setAssetHeaders(res);
      res.sendStatus(204);
    });

    app.use(
      "/mcp-app-assets",
      express.static(workspaceApp.uiDirectoryPath, {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
      }),
    );
  }

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "devspace",
      version: PACKAGE_VERSION,
      bootId: runtime.bootId,
      schemaRevision: TOOL_SCHEMA_REVISION,
      schemaFingerprint: runtime.schemaFingerprint,
      tools: runtime.tools.length,
      mcpSessions: mcpSessions.snapshot(),
      memory: processMemorySnapshot(),
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest =
      req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    const authReq = req as express.Request & { auth?: { resource?: URL } };
    if (
      !authReq.auth?.resource ||
      !checkResourceAllowed({
        requestedResource: authReq.auth.resource,
        configuredResource: resourceServerUrl,
      })
    ) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });
    if (initializeRequest) mcpSessions.recordInitializeRequest();

    if (config.mcpTransportMode === "stateless") {
      mcpSessions.recordStatelessRequest();
      if (req.method !== "POST") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed");
        return;
      }

      if (initializeRequest) {
        const client = classifyMcpClient(req.body);
        logEvent(config.logging, "info", "mcp_stateless_initialize", {
          requestId,
          source: client.source,
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          ...requestLogFields(req, config),
        });
      }

      const statelessTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const statelessServer = createMcpServer(ctx);
      let statelessClosed = false;
      const closeStatelessServer = (): void => {
        if (statelessClosed) return;
        statelessClosed = true;
        void statelessServer.close().catch((error) => {
          logEvent(config.logging, "warn", "mcp_stateless_close_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          runtime.monitorEvents.record({
            source: "mcp",
            severity: "warning",
            code: "MCP_STATELESS_CLOSE_ERROR",
            message: "Stateless MCP server close failed",
          });
        });
      };
      res.once("finish", closeStatelessServer);
      res.once("close", closeStatelessServer);

      try {
        await statelessServer.connect(statelessTransport);
        await statelessTransport.handleRequest(req, res, req.body);
      } catch (error) {
        logEvent(config.logging, "error", "mcp_request_error", {
          requestId,
          transportMode: "stateless",
          error: error instanceof Error ? error.message : String(error),
        });
        runtime.monitorEvents.record({
          source: "mcp",
          severity: "error",
          code: "MCP_REQUEST_ERROR",
          message: "Stateless MCP request failed",
        });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
        closeStatelessServer();
      }
      return;
    }

    let transport: Transport | undefined;
    let acquiredSessionId: string | undefined;
    let initializingTransport = false;
    try {
      if (sessionId) {
        transport = mcpSessions.acquire(sessionId);
        if (!transport) {
          logEvent(config.logging, "warn", "mcp_session_unknown", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            reason: mcpSessions.missingReason(sessionId),
          });
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        acquiredSessionId = sessionId;
      } else if (initializeRequest) {
        initializingTransport = true;
        const client = classifyMcpClient(req.body);
        const createdTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            mcpSessions.register(
              newSessionId,
              createdTransport,
              1,
              client.source,
            );
            acquiredSessionId = newSessionId;
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              source: client.source,
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              ...requestLogFields(req, config),
            });
          },
        });
        transport = createdTransport;

        createdTransport.onclose = () => {
          const closedSessionId = createdTransport.sessionId;
          if (closedSessionId) {
            mcpSessions.handleTransportClosed(
              closedSessionId,
              createdTransport,
            );
          }
        };

        const server = createMcpServer(ctx);
        await server.connect(createdTransport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      runtime.monitorEvents.record({
        source: "mcp",
        severity: "error",
        code: "MCP_REQUEST_ERROR",
        message: "Stateful MCP request failed",
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      if (acquiredSessionId) {
        mcpSessions.release(acquiredSessionId);
      } else if (initializingTransport && transport) {
        try {
          await transport.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_transport_close_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          runtime.monitorEvents.record({
            source: "mcp",
            severity: "warning",
            code: "MCP_TRANSPORT_CLOSE_ERROR",
            message: "MCP transport close failed",
          });
        }
      }
    }
  });
}
