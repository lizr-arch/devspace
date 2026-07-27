export const DEFAULT_MCP_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MCP_SESSION_SWEEP_INTERVAL_MS = 30 * 1000;
export const DEFAULT_MAX_MCP_SESSIONS = 256;

export type McpSessionCloseReason =
  "client" | "expired" | "capacity" | "shutdown";

export interface CloseableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionSnapshot {
  active: number;
  created: number;
  closed: number;
  expired: number;
  capacityEvictions: number;
  closeErrors: number;
  idleTtlSeconds: number;
  maxSessions: number;
}

interface McpSessionRecord<TTransport extends CloseableMcpTransport> {
  sessionId: string;
  transport: TTransport;
  lastUsedAtMs: number;
  inFlightRequests: number;
}

export interface McpSessionRegistryOptions {
  idleTtlMs?: number;
  maxSessions?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  autoSweep?: boolean;
  onClosed?: (event: {
    sessionId: string;
    reason: McpSessionCloseReason;
  }) => void;
  onCloseError?: (event: {
    sessionId: string;
    reason: McpSessionCloseReason;
    error: unknown;
  }) => void;
}

export class McpSessionRegistry<TTransport extends CloseableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionRecord<TTransport>>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly onClosed?: McpSessionRegistryOptions["onClosed"];
  private readonly onCloseError?: McpSessionRegistryOptions["onCloseError"];
  private readonly sweepTimer?: NodeJS.Timeout;
  private created = 0;
  private closed = 0;
  private expired = 0;
  private capacityEvictions = 0;
  private closeErrors = 0;
  private stopped = false;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_MCP_SESSION_IDLE_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_MCP_SESSIONS;
    const sweepIntervalMs =
      options.sweepIntervalMs ?? DEFAULT_MCP_SESSION_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onClosed = options.onClosed;
    this.onCloseError = options.onCloseError;

    assertPositiveInteger(this.idleTtlMs, "idleTtlMs");
    assertPositiveInteger(this.maxSessions, "maxSessions");
    assertPositiveInteger(sweepIntervalMs, "sweepIntervalMs");

    if (options.autoSweep !== false) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  register(
    sessionId: string,
    transport: TTransport,
    inFlightRequests = 0,
  ): void {
    if (this.stopped) {
      throw new Error("MCP session registry is closed.");
    }
    if (!sessionId) throw new Error("MCP session ID is required.");
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate MCP session ID: ${sessionId}`);
    }
    if (!Number.isInteger(inFlightRequests) || inFlightRequests < 0) {
      throw new Error("inFlightRequests must be a non-negative integer.");
    }

    this.sessions.set(sessionId, {
      sessionId,
      transport,
      lastUsedAtMs: this.now(),
      inFlightRequests,
    });
    this.created += 1;
    this.enforceCapacity(sessionId);
  }

  acquire(sessionId: string): TTransport | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastUsedAtMs = this.now();
    session.inFlightRequests += 1;
    return session.transport;
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.inFlightRequests > 0) session.inFlightRequests -= 1;
    if (session.inFlightRequests === 0) {
      session.lastUsedAtMs = this.now();
      this.enforceCapacity();
    }
  }

  handleTransportClosed(sessionId: string, transport: TTransport): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.transport !== transport) return false;
    this.remove(session, "client", false);
    return true;
  }

  sweep(): number {
    if (this.stopped) return 0;
    const expiresAtOrBefore = this.now() - this.idleTtlMs;
    const expired = Array.from(this.sessions.values()).filter(
      (session) =>
        session.inFlightRequests === 0 &&
        session.lastUsedAtMs <= expiresAtOrBefore,
    );
    for (const session of expired) {
      this.remove(session, "expired", true);
    }
    this.enforceCapacity();
    return expired.length;
  }

  snapshot(): McpSessionSnapshot {
    return {
      active: this.sessions.size,
      created: this.created,
      closed: this.closed,
      expired: this.expired,
      capacityEvictions: this.capacityEvictions,
      closeErrors: this.closeErrors,
      idleTtlSeconds: this.idleTtlMs / 1000,
      maxSessions: this.maxSessions,
    };
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const session of Array.from(this.sessions.values())) {
      this.remove(session, "shutdown", true);
    }
  }

  private enforceCapacity(preserveSessionId?: string): void {
    while (this.sessions.size > this.maxSessions) {
      const candidate = this.oldestIdleSession(preserveSessionId);
      if (!candidate) return;
      this.remove(candidate, "capacity", true);
    }
  }

  private oldestIdleSession(
    preserveSessionId?: string,
  ): McpSessionRecord<TTransport> | undefined {
    let oldest: McpSessionRecord<TTransport> | undefined;
    for (const session of this.sessions.values()) {
      if (
        session.sessionId === preserveSessionId ||
        session.inFlightRequests > 0
      ) {
        continue;
      }
      if (!oldest || session.lastUsedAtMs < oldest.lastUsedAtMs) {
        oldest = session;
      }
    }
    return oldest;
  }

  private remove(
    session: McpSessionRecord<TTransport>,
    reason: McpSessionCloseReason,
    closeTransport: boolean,
  ): void {
    if (this.sessions.get(session.sessionId) !== session) return;
    this.sessions.delete(session.sessionId);
    this.closed += 1;
    if (reason === "expired") this.expired += 1;
    if (reason === "capacity") this.capacityEvictions += 1;
    this.onClosed?.({ sessionId: session.sessionId, reason });
    if (closeTransport) {
      try {
        void session.transport.close().catch((error) => {
          this.recordCloseError(session.sessionId, reason, error);
        });
      } catch (error) {
        this.recordCloseError(session.sessionId, reason, error);
      }
    }
  }

  private recordCloseError(
    sessionId: string,
    reason: McpSessionCloseReason,
    error: unknown,
  ): void {
    this.closeErrors += 1;
    this.onCloseError?.({ sessionId, reason, error });
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
