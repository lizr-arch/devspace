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

export type MonitorEventSource = "http" | "mcp" | "tool";
export type MonitorEventSeverity = "warning" | "error";

export interface MonitorEvent {
  timestamp: string;
  source: MonitorEventSource;
  severity: MonitorEventSeverity;
  code: string;
  message: string;
  statusCode?: number;
}

export interface MonitorEventInput {
  source: MonitorEventSource;
  severity: MonitorEventSeverity;
  code: string;
  message: string;
  statusCode?: number;
}

export class MonitorEventStore {
  private readonly events: MonitorEvent[] = [];
  private readonly eventPath: string;
  private persistenceAvailable = true;

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
      !["http", "mcp", "tool"].includes(value.source ?? "") ||
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

function validStatusCode(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) >= 100 && (value ?? 0) <= 599;
}
