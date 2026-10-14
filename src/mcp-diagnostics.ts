import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export type McpDiagnosticStage = "request_received" | "authenticated" | "parsed" | "tool_started" | "tool_finished" | "response_written" | "client_abort" | "http_response_error";
export type McpErrorClass = "AUTH_FAILURE" | "MCP_PROTOCOL_ERROR" | "TOOL_EXECUTION_ERROR" | "TOOL_TIMEOUT" | "CLIENT_ABORT" | "HTTP_RESPONSE_ERROR" | "NETWORK_OR_TUNNEL_ERROR" | "CONNECTOR_WRAPPER_ERROR" | "UNKNOWN";
export interface McpDiagnosticEvent {
  at: string; requestId: string; traceId: string; stage: McpDiagnosticStage;
  rpcMethod?: string; rpcId?: string | number; toolName?: string; operationId?: string;
  workspaceRef?:string;statusCode?: number; errorClass?: McpErrorClass; durationMs?: number;
}
interface RequestContext { requestId: string; traceId: string; rpcMethod?: string; rpcId?: string | number; }

const MAX_EVENTS = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_METHOD = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;
const context = new AsyncLocalStorage<RequestContext>();
const events: McpDiagnosticEvent[] = [];
const starts = new Map<string, number>();
const requestStarts = new Map<string, number>();
const keyFor = (requestId: string, toolName?: string, operationId?: string) => `${requestId}\u0000${toolName ?? ""}\u0000${operationId ?? ""}`;

export function requestTraceId(): string { return randomUUID(); }
export function withMcpRequest<T>(value: RequestContext, work: () => T): T {
  return context.run(value, work);
}
export function recordMcpDiagnostic(
  stage: McpDiagnosticStage,
  fields: Pick<McpDiagnosticEvent, "toolName" | "operationId" | "workspaceRef" | "statusCode" | "errorClass"> = {},
): void {
  const current = context.getStore();
  if (!current) return;
  const event: McpDiagnosticEvent = {
    at: new Date().toISOString(), requestId: current.requestId, traceId: current.traceId, stage,
    ...(current.rpcMethod && SAFE_METHOD.test(current.rpcMethod) ? { rpcMethod: current.rpcMethod } : {}),
    ...(current.rpcId !== undefined && (typeof current.rpcId === "string" ? current.rpcId.length <= 80 : Number.isSafeInteger(current.rpcId)) ? { rpcId: current.rpcId } : {}),
    ...(fields.toolName && SAFE_METHOD.test(fields.toolName) ? { toolName: fields.toolName } : {}),
    ...(fields.operationId && ID.test(fields.operationId) ? { operationId: fields.operationId } : {}),
    ...(fields.workspaceRef && ID.test(fields.workspaceRef) ? { workspaceRef: fields.workspaceRef } : {}),
    ...(Number.isInteger(fields.statusCode) && fields.statusCode! >= 100 && fields.statusCode! <= 599 ? { statusCode: fields.statusCode } : {}),
    ...(fields.errorClass ? { errorClass: fields.errorClass } : {}),
  };
  if (stage === "request_received") {
    requestStarts.set(current.requestId, performance.now());
    if (requestStarts.size > MAX_EVENTS) requestStarts.delete(requestStarts.keys().next().value as string);
  }
  if (stage === "tool_started") {
    const key = keyFor(current.requestId, event.toolName, event.operationId);
    starts.set(key, performance.now());
    if (starts.size > MAX_EVENTS) starts.delete(starts.keys().next().value as string);
  }
  if (stage === "tool_finished" || stage === "response_written" || stage === "client_abort" || stage === "http_response_error") {
    const key = stage === "tool_finished" ? keyFor(current.requestId, event.toolName, event.operationId) : current.requestId;
    const start = stage === "tool_finished" ? starts.get(key) : requestStarts.get(key);
    if (start !== undefined) event.durationMs = Math.max(0, Math.round(performance.now() - start));
    if (stage === "tool_finished") starts.delete(key);
    else requestStarts.delete(key);
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}
export function mcpDiagnosticsSnapshot(limit = 100): { retained: number; events: McpDiagnosticEvent[]; countsByStage: Record<string, number>; countsByError: Record<string, number>; toolCalls: { count: number; successCount: number; errorCount: number; successRate: number | null; serverSuccessRate:number|null; connectorReceipt:"not_observable"; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null } } {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const recent = events.slice(-bounded).map((event) => ({ ...event }));
  const countsByStage: Record<string, number> = {};
  const countsByError: Record<string, number> = {};
  const calls = recent.filter((event) => event.stage === "tool_finished");
  const durations = calls.map((event) => event.durationMs).filter((value): value is number => Number.isFinite(value)).sort((a,b)=>a-b);
  const percentile = (p:number) => durations.length ? durations[Math.ceil(p*durations.length)-1]! : null;
  const errorCount = calls.filter((event) => Boolean(event.errorClass)).length;
  for (const event of recent) {
    countsByStage[event.stage] = (countsByStage[event.stage] ?? 0) + 1;
    if (event.errorClass) countsByError[event.errorClass] = (countsByError[event.errorClass] ?? 0) + 1;
  }
  return { retained: events.length, events: recent, countsByStage, countsByError,
    toolCalls:{count:calls.length,successCount:calls.length-errorCount,errorCount,
      successRate:calls.length?(calls.length-errorCount)/calls.length:null,
      serverSuccessRate:calls.length?(calls.length-errorCount)/calls.length:null,
      connectorReceipt:"not_observable",
      p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99)} };
}
