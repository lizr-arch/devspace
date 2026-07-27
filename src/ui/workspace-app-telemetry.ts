export const WORKSPACE_APP_VERSION = "0.6.0";

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

export interface WorkspaceAppDiagnostic {
  kind: WorkspaceAppErrorKind;
  phase: WorkspaceAppErrorPhase;
  appVersion: string;
  errorName?: string;
  resourceType?: WorkspaceAppResourceType;
  instanceId?: string;
}

type DiagnosticReporter = (diagnostic: WorkspaceAppDiagnostic) => Promise<void>;

const MAX_QUEUED_DIAGNOSTICS = 10;

export class WorkspaceAppTelemetry {
  private readonly queue: WorkspaceAppDiagnostic[] = [];
  private readonly instanceId =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
  private reporter: DiagnosticReporter | undefined;
  private flushing = false;

  capture(
    kind: WorkspaceAppErrorKind,
    phase: WorkspaceAppErrorPhase,
    options: {
      errorName?: string;
      resourceType?: WorkspaceAppResourceType;
    } = {},
  ): void {
    const diagnostic: WorkspaceAppDiagnostic = {
      kind,
      phase,
      appVersion: WORKSPACE_APP_VERSION,
      ...(options.errorName
        ? { errorName: safeErrorName(options.errorName) }
        : {}),
      ...(options.resourceType ? { resourceType: options.resourceType } : {}),
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
    };
    this.queue.push(diagnostic);
    if (this.queue.length > MAX_QUEUED_DIAGNOSTICS) this.queue.shift();
    void this.flush();
  }

  connect(reporter: DiagnosticReporter): void {
    this.reporter = reporter;
    void this.flush();
  }

  queuedCount(): number {
    return this.queue.length;
  }

  private async flush(): Promise<void> {
    if (!this.reporter || this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;
        try {
          await this.reporter(next);
          this.queue.shift();
        } catch {
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export function errorName(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return safeErrorName(value.name);
  }
  if (typeof value === "string") return "StringError";
  return `${typeof value}Error`;
}

export function resourceType(
  target: EventTarget | null,
): WorkspaceAppResourceType {
  if (target instanceof HTMLScriptElement) return "script";
  if (target instanceof HTMLLinkElement) return "style";
  if (target instanceof HTMLImageElement) return "image";
  return "other";
}

function safeErrorName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
  return normalized || "UnknownError";
}
