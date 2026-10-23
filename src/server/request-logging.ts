import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { ServerConfig } from "../config.js";
import { logEvent, requestPath } from "../logger.js";
import type { LiveRequestMonitor } from "../live-monitor.js";
import { safeMonitorPath, type MonitorEventStore } from "../monitor-events.js";
import {
  recordMcpDiagnostic,
  requestTraceId,
  withMcpRequest,
} from "../mcp-diagnostics.js";
import { requestLogFields } from "./server-helpers.js";

/**
 * HTTP status used for requests whose client went away before the response was
 * finished. 499 is the de-facto "client closed request" code used by nginx and
 * many proxies; it keeps aborted requests out of the success bucket and makes
 * the failure visible in logs, metrics and monitor events.
 */
export const CLIENT_ABORT_STATUS = 499;

export interface RequestLoggingDeps {
  config: ServerConfig;
  requestMonitor: LiveRequestMonitor;
  monitorEvents: Pick<MonitorEventStore, "record">;
  /**
   * Test seam: defaults to the structured logger. Production callers do not
   * pass this.
   */
  logRequest?: (
    level: "info",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}

export interface RequestOutcome {
  status: number;
  aborted: boolean;
}

/**
 * Resolve the status to report for a completed HTTP exchange.
 *
 * A `close` without a finished write means the client aborted the request, so
 * the raw `res.statusCode` (typically the implicit 200 default) must never be
 * reported as success.
 */
export function resolveRequestOutcome(
  res: Pick<Response, "statusCode" | "writableFinished">,
): RequestOutcome {
  if (!res.writableFinished) {
    return { status: CLIENT_ABORT_STATUS, aborted: true };
  }
  return { status: res.statusCode, aborted: false };
}

function isMonitorPathExcluded(path: string): boolean {
  return (
    path === "/monitor" ||
    path.startsWith("/monitor/") ||
    path === "/app-test" ||
    path.startsWith("/app-test/")
  );
}

export function createRequestLoggingMiddleware(
  deps: RequestLoggingDeps,
): RequestHandler {
  const { config, requestMonitor, monitorEvents } = deps;
  const logRequest =
    deps.logRequest ??
    ((
      level: "info",
      event: string,
      fields: Record<string, unknown>,
    ): void => {
      logEvent(config.logging, level, event, fields);
    });

  return (req: Request, res: Response, next): void => {
    const requestId = randomUUID();
    const inboundTraceId = req.header("x-devspace-trace-id");
    const traceId =
      inboundTraceId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(inboundTraceId)
        ? inboundTraceId
        : requestTraceId();
    const startedAt = performance.now();
    const finishMonitoring = requestMonitor.begin(requestPath(req));
    res.locals.requestId = requestId;
    res.locals.traceId = traceId;
    res.setHeader("X-DevSpace-Request-Id", requestId);
    res.setHeader("X-DevSpace-Trace-Id", traceId);

    let completed = false;
    const completeRequest = (): void => {
      if (completed) return;
      completed = true;
      const { status, aborted } = resolveRequestOutcome(res);
      finishMonitoring(status, performance.now() - startedAt);
      const path = requestPath(req);
      if (status >= 400 && !isMonitorPathExcluded(path)) {
        monitorEvents.record({
          source: "http",
          severity: status >= 500 ? "error" : "warning",
          code: `HTTP_${status}`,
          message: aborted
            ? `${req.method} ${safeMonitorPath(path)} aborted by client`
            : `${req.method} ${safeMonitorPath(path)} returned ${status}`,
          statusCode: status,
        });
      }
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logRequest("info", "http_request", {
        requestId,
        method: req.method,
        path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        ...(aborted ? { aborted: true } : {}),
        ...requestLogFields(req, config),
      });
    };

    res.once("finish", () => {
      if (requestPath(req) === "/mcp") {
        const errorClass =
          res.statusCode === 401
            ? "AUTH_FAILURE"
            : [400, 404, 405].includes(res.statusCode)
              ? "MCP_PROTOCOL_ERROR"
              : res.statusCode >= 500
                ? "HTTP_RESPONSE_ERROR"
                : undefined;
        withMcpRequest({ requestId, traceId }, () =>
          recordMcpDiagnostic("response_written", {
            statusCode: res.statusCode,
            ...(errorClass ? { errorClass } : {}),
          }),
        );
      }
      completeRequest();
    });
    res.once("close", () => {
      if (!res.writableFinished) {
        withMcpRequest({ requestId, traceId }, () =>
          recordMcpDiagnostic("client_abort", {
            statusCode: CLIENT_ABORT_STATUS,
            errorClass: "CLIENT_ABORT",
          }),
        );
      }
      completeRequest();
    });
    res.once("error", () =>
      withMcpRequest({ requestId, traceId }, () =>
        recordMcpDiagnostic("http_response_error", {
          statusCode: res.statusCode,
          errorClass: "HTTP_RESPONSE_ERROR",
        }),
      ),
    );

    next();
  };
}
