import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_EVENTS = 200;
const MAX_EVENT_FILE_BYTES = 512 * 1024;
const WEB_APP_EVENT_LIMIT_PER_MINUTE = 12;
const WEB_APP_EVENT_DEDUPE_MS = 30_000;

export type MonitorEventSource = "http" | "mcp" | "tool" | "web_app";
export type MonitorEventSeverity = "warning" | "error";
export type WorkspaceAppErrorKind =
  | "script_error"
  | "unhandled_rejection"
  | "resource_error"
  | "connect_error"
  | "render_error";
export type WorkspaceAppErrorPhase =
  | "bootstrap"
  | "connect"
  | "tool_result"
  | "render"
  | "payload_load"
  | "teardown";
export type WorkspaceAppResourceType =
  "script" | "style" | "image" | "font" | "other";

export interface MonitorEvent {
  timestamp: string;
  source: MonitorEventSource;
  severity: MonitorEventSeverity;
  code: string;
  message: string;
  statusCode?: number;
  correlationId?: string;
}

export interface MonitorEventInput {
  source: MonitorEventSource;
  severity: MonitorEventSeverity;
  code: string;
  message: string;
  statusCode?: number;
  correlationId?: string;
}

export interface WorkspaceAppErrorInput {
  kind: WorkspaceAppErrorKind;
  phase: WorkspaceAppErrorPhase;
  errorName?: string;
  resourceType?: WorkspaceAppResourceType;
  appVersion: string;
  instanceId?: string;
}

export type WorkspaceAppErrorRecordResult =
  | { accepted: true; reason: "recorded" }
  | { accepted: false; reason: "duplicate" | "rate_limited" };

export class MonitorEventStore {
  private readonly events: MonitorEvent[] = [];
  private readonly eventPath: string;
  private readonly recentWebAppSignatures = new Map<string, number>();
  private persistenceAvailable = true;
  private webAppWindowStartedAt = 0;
  private webAppWindowCount = 0;

  constructor(stateDir: string) {
    this.eventPath = join(stateDir, "monitor-events.jsonl");
    mkdirSync(dirname(this.eventPath), { recursive: true, mode: 0o700 });
    this.load();
  }

  record(input: MonitorEventInput): MonitorEvent {
    const event: MonitorEvent = {
      timestamp: new Date().toISOString(),
      source: input.source,
      severity: input.severity,
      code: sanitizeCode(input.code),
      message: sanitizeMessage(input.message),
      ...(validStatusCode(input.statusCode)
        ? { statusCode: input.statusCode }
        : {}),
      ...(input.correlationId && isUuid(input.correlationId)
        ? { correlationId: input.correlationId.toLowerCase() }
        : {}),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    try {
      appendFileSync(this.eventPath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.eventPath, 0o600);
      if (statSync(this.eventPath).size > MAX_EVENT_FILE_BYTES) this.compact();
      this.persistenceAvailable = true;
    } catch {
      this.persistenceAvailable = false;
    }
    return event;
  }

  recordWorkspaceAppError(
    input: WorkspaceAppErrorInput,
    now = Date.now(),
  ): WorkspaceAppErrorRecordResult {
    const normalized = normalizeWorkspaceAppError(input);
    const signature = JSON.stringify({
      kind: normalized.kind,
      phase: normalized.phase,
      errorName: normalized.errorName,
      resourceType: normalized.resourceType,
      appVersion: normalized.appVersion,
    });
    const lastRecordedAt = this.recentWebAppSignatures.get(signature);
    if (
      lastRecordedAt !== undefined &&
      now - lastRecordedAt < WEB_APP_EVENT_DEDUPE_MS
    ) {
      return { accepted: false, reason: "duplicate" };
    }

    if (
      this.webAppWindowStartedAt === 0 ||
      now - this.webAppWindowStartedAt >= 60_000
    ) {
      this.webAppWindowStartedAt = now;
      this.webAppWindowCount = 0;
    }
    if (this.webAppWindowCount >= WEB_APP_EVENT_LIMIT_PER_MINUTE) {
      return { accepted: false, reason: "rate_limited" };
    }

    this.webAppWindowCount += 1;
    this.recentWebAppSignatures.set(signature, now);
    for (const [knownSignature, recordedAt] of this.recentWebAppSignatures) {
      if (now - recordedAt >= WEB_APP_EVENT_DEDUPE_MS) {
        this.recentWebAppSignatures.delete(knownSignature);
      }
    }

    const resource = normalized.resourceType
      ? ` (${normalized.resourceType})`
      : "";
    const error = normalized.errorName ? ` · ${normalized.errorName}` : "";
    this.record({
      source: "web_app",
      severity: normalized.kind === "resource_error" ? "warning" : "error",
      code: `WEB_APP_${normalized.kind}`,
      message: `Workspace App ${normalized.kind} during ${normalized.phase}${resource}${error} · v${normalized.appVersion}`,
      correlationId: normalized.instanceId,
    });
    return { accepted: true, reason: "recorded" };
  }

  snapshot(limit = 50): MonitorEvent[] {
    const boundedLimit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(limit)));
    return this.events
      .slice(-boundedLimit)
      .reverse()
      .map((event) => ({
        ...event,
      }));
  }

  isPersistent(): boolean {
    return this.persistenceAvailable;
  }

  private load(): void {
    if (!existsSync(this.eventPath)) return;
    try {
      const lines = readFileSync(this.eventPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-MAX_EVENTS);
      for (const line of lines) {
        const event = parseEvent(line);
        if (event) this.events.push(event);
      }
      chmodSync(this.eventPath, 0o600);
    } catch {
      this.events.length = 0;
      this.persistenceAvailable = false;
    }
  }

  private compact(): void {
    const temporaryPath = `${this.eventPath}.${process.pid}.tmp`;
    const content = this.events
      .map((event) => JSON.stringify(event))
      .join("\n");
    writeFileSync(temporaryPath, content ? `${content}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.eventPath);
    chmodSync(this.eventPath, 0o600);
  }
}

export function safeMonitorPath(path: string): string {
  if (path.startsWith("/artifacts/")) return "/artifacts/:token";
  if (path.startsWith("/mcp-app-assets/")) return "/mcp-app-assets/*";
  if (path.startsWith("/.well-known/")) return "/.well-known/*";
  if (
    [
      "/mcp",
      "/healthz",
      "/authorize",
      "/token",
      "/register",
      "/revoke",
      "/introspect",
    ].includes(path)
  ) {
    return path;
  }
  return "/other";
}

function parseEvent(line: string): MonitorEvent | undefined {
  try {
    const value = JSON.parse(line) as Partial<MonitorEvent>;
    if (
      typeof value.timestamp !== "string" ||
      Number.isNaN(Date.parse(value.timestamp)) ||
      !["http", "mcp", "tool", "web_app"].includes(value.source ?? "") ||
      !["warning", "error"].includes(value.severity ?? "") ||
      typeof value.code !== "string" ||
      typeof value.message !== "string"
    ) {
      return undefined;
    }
    return {
      timestamp: value.timestamp,
      source: value.source as MonitorEventSource,
      severity: value.severity as MonitorEventSeverity,
      code: sanitizeCode(value.code),
      message: sanitizeMessage(value.message),
      ...(validStatusCode(value.statusCode)
        ? { statusCode: value.statusCode }
        : {}),
      ...(value.correlationId && isUuid(value.correlationId)
        ? { correlationId: value.correlationId.toLowerCase() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function sanitizeCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "_")
    .slice(0, 64);
  return normalized || "UNKNOWN_ERROR";
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeWorkspaceAppError(
  input: WorkspaceAppErrorInput,
): WorkspaceAppErrorInput {
  return {
    kind: input.kind,
    phase: input.phase,
    appVersion: sanitizeAppVersion(input.appVersion),
    ...(input.errorName
      ? { errorName: sanitizeErrorName(input.errorName) }
      : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.instanceId && isUuid(input.instanceId)
      ? { instanceId: input.instanceId.toLowerCase() }
      : {}),
  };
}

function sanitizeAppVersion(value: string): string {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : "unknown";
}

function sanitizeErrorName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
  return normalized || "UnknownError";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validStatusCode(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) >= 100 && (value ?? 0) <= 599;
}
