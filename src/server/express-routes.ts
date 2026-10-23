import { randomUUID } from "node:crypto";
import { bearerTokenFingerprint, geminiClientMatches, geminiToolAllowlist, selectGeminiTools } from "../gemini-toolset.js";
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
  toolNamesFor,
} from "./server-helpers.js";
import { createRequestLoggingMiddleware } from "./request-logging.js";
import {
  workspaceAppHtml,
  workspaceAppUiMetadata,
  setAssetHeaders,
  webGptTestBuildDirectoryUrl,
} from "./server-workspace-app.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpDiagnosticsSnapshot, recordMcpDiagnostic, withMcpRequest } from "../mcp-diagnostics.js";

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

  app.use(
    createRequestLoggingMiddleware({
      config,
      requestMonitor,
      monitorEvents: runtime.monitorEvents,
    }),
  );

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
        memoryAccounting:
          process.platform === "darwin"
            ? "freemem_excludes_inactive_speculative"
            : "os_freemem",
        memoryPressureFreePercent: resources.memoryPressureFreePercent,
        cpuCount: resources.cpuCount,
        loadAverage: resources.loadAverage,
        swapUsedMiB: resources.swapUsedMiB,
        swapTotalMiB: resources.swapTotalMiB,
        swapUsedPercent: resources.swapUsedPercent,
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
      mcpDiagnostics: mcpDiagnosticsSnapshot(100),
      load: calculateLoadAssessment({
        requests,
        resources,
        jobs: jobSnapshot,
      }),
    });
  });

  if (workspaceApp) {
    // Serve the Workspace App template over plain HTTP at
    // /ui/workspace-app[*].html. ChatGPT's Apps SDK may resolve a `ui://`
    // resource URI to this HTTP path (and legacy/older clients do), instead of
    // calling MCP resources/read. Without a route here that request 404s and
    // surfaces in the ChatGPT UI as "Failed to fetch template" /
    // "Error loading app". Accept both the versioned
    // (workspace-app-<hash>.html) and legacy (workspace-app.html) names.
    app.get("/ui/:file", (req, res) => {
      const file =
        typeof req.params.file === "string" ? req.params.file : "";
      if (!/^workspace-app(-[0-9a-f]+)?\.html$/.test(file)) {
        res.status(404).type("text").send("Not found");
        return;
      }
      // Assets must be absolute: this HTML renders inside a ChatGPT iframe.
      const publicBase = config.publicBaseUrl
        ? String(config.publicBaseUrl).replace(/\/+$/, "")
        : `${req.protocol}://${req.get("host") ?? "127.0.0.1:7676"}`;
      res.setHeader("Cache-Control", "no-store");
      res
        .type("html")
        .send(
          workspaceAppHtml(config, workspaceApp, `${publicBase}/mcp-app-assets`),
        );
    });

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

  // Compatibility shim: Gemini Spark (and possibly other MCP clients) sends
  // empty-string optional client metadata fields such as client_uri: "" in its
  // Dynamic Client Registration request. The MCP SDK validates these with a
  // strict URL schema (SafeUrlSchema = z.string().url()) and rejects the whole
  // registration with 400 invalid_client_metadata, which forces the client onto
  // a degraded manual-credentials path where account linking never completes.
  // An empty string in RFC 7591 metadata carries no information, so treat it as
  // "field not provided": parse the JSON body first and drop empty-string
  // top-level values before the SDK router (whose own express.json() skips
  // re-parsing once req.body is populated).
  // Wire log (dcr_wire) records sanitized request + response so Gemini's exact
  // registration body and rejection reason are visible in run.log.
  app.post("/register", express.json({ limit: "1mb" }), (req, res, next) => {
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      const removed: string[] = [];
      for (const key of Object.keys(req.body)) {
        const value = req.body[key];
        if (typeof value === "string" && value.trim() === "") {
          delete req.body[key];
          removed.push(key);
        }
      }
      const origJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        logEvent(config.logging, "info", "dcr_wire", {
          removedBlankFields: removed.join(",") || "none",
          requestBody: JSON.stringify(req.body).slice(0, 800),
          responseStatus: res.statusCode,
          responseBody: JSON.stringify(body).slice(0, 800),
        });
        return origJson(body as never);
      }) as typeof res.json;
    }
    next();
  });

  // Wire diagnosis + Gemini Spark compatibility for /mcp POST requests.
  // GET (SSE stream) and DELETE pass through untouched.
  //
  // Gemini gets a bounded coding/Godot catalog. Stateless transport has no
  // MCP session id, so a successful initialize is correlated by a short-lived
  // one-way fingerprint of its bearer token for the following tools/list.
  const geminiAllowedTools = geminiToolAllowlist(toolNamesFor(config));
  const geminiSessions = new Map<string, true>();
  const geminiCredentials = new Map<string, number>();
  const GEMINI_CREDENTIAL_TTL_MS = 60 * 60 * 1000;

  // Recursively drop JSON-Schema features Gemini's function-declaration
  // pipeline is documented to struggle with / sanitize itself.
  const sanitizeSchemaForGemini = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sanitizeSchemaForGemini);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (key === "$schema" || key === "additionalProperties") continue;
        out[key] = sanitizeSchemaForGemini(value);
      }
      return out;
    }
    return node;
  };

  const stripToolForGemini = (
    tool: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...tool };
    delete out.outputSchema; // not covered by Gemini's documented sanitizer
    delete out["_meta"]; // Apps-UI (ui:// iframe) metadata ChatGPT-only
    if (out.inputSchema && typeof out.inputSchema === "object") {
      out.inputSchema = sanitizeSchemaForGemini(out.inputSchema);
    }
    return out;
  };

  // Rewrite one SSE/JSON chunk of a tools/list response for Gemini sessions.
  // Returns the rewritten text, or null when nothing matched (pass through).
  const transformToolsListChunk = (
    text: string,
    requestId: string | undefined,
  ): string | null => {
    if (!text.includes('"tools"')) return null;
    const lines = text.split("\n");
    let changed = false;
    const outLines = lines.map((line) => {
      const payload = line.startsWith("data: ") ? line.slice(6) : null;
      if (payload === null) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return line;
      }
      const result = (parsed as { result?: { tools?: unknown } })?.result;
      if (!result || !Array.isArray(result.tools)) return line;
      const before = result.tools.length;
      const selected = selectGeminiTools(
        result.tools as Record<string, unknown>[],
        geminiAllowedTools,
      );
      result.tools = selected.map(stripToolForGemini);
      changed = true;
      logEvent(config.logging, "info", "gemini_tools_filtered", {
        requestId,
        toolsBefore: before,
        toolsAfter: (result.tools as unknown[]).length,
        toolLimit: geminiAllowedTools.size,
      });
      return "data: " + JSON.stringify(parsed);
    });
    return changed ? outLines.join("\n") : null;
  };

  app.use("/mcp", (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const requestId = res.locals.requestId as string | undefined;
    const traceId = res.locals.traceId as string | undefined;
    const rpcMethod =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as { method?: unknown }).method
        : undefined;
    const rpcId = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as { id?: unknown }).id : undefined;
    if (geminiSessions.size > 256) geminiSessions.clear();

    // Is this request part of a known Gemini session?
    const requestSessionId = req.header("mcp-session-id");
    const bearerFingerprint = bearerTokenFingerprint(req.header("authorization"));
    const credentialExpiry = bearerFingerprint
      ? geminiCredentials.get(bearerFingerprint)
      : undefined;
    if (bearerFingerprint && credentialExpiry !== undefined && credentialExpiry <= Date.now()) {
      geminiCredentials.delete(bearerFingerprint);
    }
    // A concrete MCP session identifies its own client. Never let a Gemini
    // bearer-token fallback rewrite another (e.g. ChatGPT) session which happens
    // to reuse the same OAuth access token. Only stateless requests can rely
    // on the time-bounded token fingerprint.
    const geminiCompat = requestSessionId !== undefined
      ? geminiSessions.get(requestSessionId) === true
      : (rpcMethod === "tools/list" &&
          bearerFingerprint !== undefined &&
          credentialExpiry !== undefined &&
          credentialExpiry > Date.now());

    let responseBytes = 0;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    // When we filter a Gemini tools/list response the byte length shrinks, but
    // @hono/node-server fixed Content-Length to the UNFILTERED size in
    // writeHead() before pumping the body. Writing fewer bytes than the
    // declared Content-Length makes the client wait for bytes that never
    // arrive and then terminate the connection. Drop Content-Length for the
    // filtered case so Node falls back to chunked transfer-encoding.
    if (geminiCompat && rpcMethod === "tools/list") {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = ((status: unknown, ...args: unknown[]) => {
        const headers = args[args.length - 1];
        if (
          headers &&
          typeof headers === "object" &&
          !Array.isArray(headers)
        ) {
          const record = headers as Record<string, unknown>;
          delete record["content-length"];
          delete record["Content-Length"];
        }
        return (origWriteHead as (...a: never[]) => typeof res)(
          status as never,
          ...(args as never[]),
        );
      }) as typeof res.writeHead;
    }

    const processChunk = (chunk: unknown): unknown => {
      // @hono/node-server pumps Uint8Array from the SDK's TextEncoder, NOT
      // Buffer or string — all three shapes must be accepted or this hook
      // silently sees zero bytes (observed as resLen:0 in mcp_wire).
      let text: string | undefined;
      if (typeof chunk === "string") text = chunk;
      else if (chunk instanceof Uint8Array)
        text = Buffer.from(chunk).toString("utf8");
      if (text === undefined) return chunk;
      if (!geminiCompat || rpcMethod !== "tools/list") {
        responseBytes += Buffer.byteLength(text);
        return chunk;
      }
      const transformed = transformToolsListChunk(text, requestId);
      if (transformed === null) {
        responseBytes += Buffer.byteLength(text);
        return chunk;
      }
      responseBytes += Buffer.byteLength(transformed);
      return Buffer.from(transformed);
    };

    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      return (origWrite as (...args: never[]) => boolean)(
        processChunk(chunk) as never,
        ...(rest as never[]),
      );
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk !== undefined && chunk !== null) chunk = processChunk(chunk);

      // Correlate successful Gemini initialization with subsequent requests.
      // Stateful clients use mcp-session-id; stateless clients use a token hash.
      if (rpcMethod === "initialize") {
        const newSessionId = res.getHeader("mcp-session-id");
        const clientInfo = (
          req.body as {
            params?: { clientInfo?: { name?: unknown; version?: unknown } };
          }
        )?.params?.clientInfo;
        if (
          res.statusCode < 400 &&
          geminiClientMatches(clientInfo?.name, clientInfo?.version)
        ) {
          if (typeof newSessionId === "string") geminiSessions.set(newSessionId, true);
          if (bearerFingerprint) {
            if (geminiCredentials.size >= 128) geminiCredentials.clear();
            geminiCredentials.set(bearerFingerprint, Date.now() + GEMINI_CREDENTIAL_TTL_MS);
          }
          logEvent(config.logging, "info", "gemini_client_marked", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(
              typeof newSessionId === "string" ? newSessionId : undefined,
            ),
            credentialBound: Boolean(bearerFingerprint),
            clientName: clientInfo?.name,
            clientVersion: String(clientInfo?.version ?? ""),
          });
        }
      }

      logEvent(config.logging, "info", "mcp_wire", {
        httpMethod: req.method,
        rpcMethod: typeof rpcMethod === "string" ? rpcMethod : undefined,
        traceId,
        sessionIdPrefix: sessionIdPrefix(requestSessionId),
        status: res.statusCode,
        geminiCompat,
        contentType: String(res.getHeader("content-type") ?? ""),
        resLen: responseBytes,
      });
      return (origEnd as (...args: never[]) => typeof res)(
        chunk as never,
        ...(rest as never[]),
      );
    }) as typeof res.end;
    withMcpRequest({
      requestId: requestId ?? "unknown",
      traceId: traceId ?? requestId ?? "unknown",
      rpcMethod: typeof rpcMethod === "string" ? rpcMethod : undefined,
      rpcId: typeof rpcId === "string" || typeof rpcId === "number" ? rpcId : undefined,
    }, () => { recordMcpDiagnostic("request_received"); next(); });
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
    recordMcpDiagnostic("authenticated");

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
      recordMcpDiagnostic("parsed", { statusCode: 401, errorClass: "AUTH_FAILURE" });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    recordMcpDiagnostic("parsed");

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
            errorClass: "MCP_PROTOCOL_ERROR",
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
        recordMcpDiagnostic("parsed", { statusCode: 500, errorClass: "MCP_PROTOCOL_ERROR" });
        logEvent(config.logging, "error", "mcp_request_error", {
          requestId,
          transportMode: "stateless",
          errorClass: "MCP_PROTOCOL_ERROR",
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
      recordMcpDiagnostic("parsed", { statusCode: 500, errorClass: "MCP_PROTOCOL_ERROR" });
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        errorClass: "MCP_PROTOCOL_ERROR",
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
            errorClass: "MCP_PROTOCOL_ERROR",
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
