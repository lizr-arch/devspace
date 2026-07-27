export const DEFAULT_MCP_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MCP_SESSION_SWEEP_INTERVAL_MS = 30 * 1000;
export const DEFAULT_MAX_MCP_SESSIONS = 256;

export type McpSessionCloseReason =
  "client" | "expired" | "capacity" | "shutdown";

export type McpSessionSource =
  "main_connector" | "workspace_app" | "doctor" | "test_client" | "unknown";

export type McpMissingSessionReason = McpSessionCloseReason | "never_seen";

export interface CloseableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionSnapshot {
  active: number;
  highWaterMark: number;
  created: number;
  initializeRequests: number;
  acquireRequests: number;
  reusedRequests: number;
  unknownSessionRequests: number;
  closed: number;
  clientClosed: number;
  expired: number;
  capacityEvictions: number;
  closeErrors: number;
  createdLastMinute: number;
  createdLastFiveMinutes: number;
  inFlightRequests: number;
  activeBySource: Record<McpSessionSource, number>;
  createdBySource: Record<McpSessionSource, number>;
  unknownRequestsByReason: Record<McpMissingSessionReason, number>;
  idleTtlSeconds: number;
  maxSessions: number;
}

interface McpSessionRecord<TTransport extends CloseableMcpTransport> {
  sessionId: string;
  transport: TTransport;
  lastUsedAtMs: number;
  inFlightRequests: number;
  source: McpSessionSource;
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
    source: McpSessionSource;
  }) => void;
  onCloseError?: (event: {
    sessionId: string;
    reason: McpSessionCloseReason;
    source: McpSessionSource;
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
  private highWaterMark = 0;
  private initializeRequests = 0;
  private acquireRequests = 0;
  private reusedRequests = 0;
  private unknownSessionRequests = 0;
  private closed = 0;
  private clientClosed = 0;
  private expired = 0;
  private capacityEvictions = 0;
  private closeErrors = 0;
  private readonly createdAtMs: number[] = [];
  private readonly createdBySource = emptySourceCounts();
  private readonly closedSessionReasons = new Map<
    string,
    McpSessionCloseReason
  >();
  private readonly unknownRequestsByReason = emptyMissingReasonCounts();
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
    source: McpSessionSource = "unknown",
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

    const registeredAtMs = this.now();
    this.sessions.set(sessionId, {
      sessionId,
      transport,
      lastUsedAtMs: registeredAtMs,
      inFlightRequests,
      source,
    });
    this.created += 1;
    this.createdAtMs.push(registeredAtMs);
    this.createdBySource[source] += 1;
    this.enforceCapacity(sessionId);
    this.highWaterMark = Math.max(this.highWaterMark, this.sessions.size);
  }

  recordInitializeRequest(): void {
    this.initializeRequests += 1;
  }

  acquire(sessionId: string): TTransport | undefined {
    this.acquireRequests += 1;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.unknownSessionRequests += 1;
      const reason = this.closedSessionReasons.get(sessionId) ?? "never_seen";
      this.unknownRequestsByReason[reason] += 1;
      return undefined;
    }
    this.reusedRequests += 1;
    session.lastUsedAtMs = this.now();
    session.inFlightRequests += 1;
    return session.transport;
  }

  missingReason(sessionId: string): McpMissingSessionReason | undefined {
    if (this.sessions.has(sessionId)) return undefined;
    return this.closedSessionReasons.get(sessionId) ?? "never_seen";
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
    const currentTime = this.now();
    this.pruneCreatedAt(currentTime - 5 * 60 * 1000);
    const activeBySource = emptySourceCounts();
    let inFlightRequests = 0;
    for (const session of this.sessions.values()) {
      activeBySource[session.source] += 1;
      inFlightRequests += session.inFlightRequests;
    }
    return {
      active: this.sessions.size,
      highWaterMark: this.highWaterMark,
      created: this.created,
      initializeRequests: this.initializeRequests,
      acquireRequests: this.acquireRequests,
      reusedRequests: this.reusedRequests,
      unknownSessionRequests: this.unknownSessionRequests,
      closed: this.closed,
      clientClosed: this.clientClosed,
      expired: this.expired,
      capacityEvictions: this.capacityEvictions,
      closeErrors: this.closeErrors,
      createdLastMinute: this.createdAtMs.filter(
        (createdAt) => createdAt > currentTime - 60 * 1000,
      ).length,
      createdLastFiveMinutes: this.createdAtMs.length,
      inFlightRequests,
      activeBySource,
      createdBySource: { ...this.createdBySource },
      unknownRequestsByReason: { ...this.unknownRequestsByReason },
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
    this.rememberClosedSession(session.sessionId, reason);
    this.closed += 1;
    if (reason === "client") this.clientClosed += 1;
    if (reason === "expired") this.expired += 1;
    if (reason === "capacity") this.capacityEvictions += 1;
    this.onClosed?.({
      sessionId: session.sessionId,
      reason,
      source: session.source,
    });
    if (closeTransport) {
      try {
        void session.transport.close().catch((error) => {
          this.recordCloseError(
            session.sessionId,
            reason,
            session.source,
            error,
          );
        });
      } catch (error) {
        this.recordCloseError(session.sessionId, reason, session.source, error);
      }
    }
  }

  private recordCloseError(
    sessionId: string,
    reason: McpSessionCloseReason,
    source: McpSessionSource,
    error: unknown,
  ): void {
    this.closeErrors += 1;
    this.onCloseError?.({ sessionId, reason, source, error });
  }

  private rememberClosedSession(
    sessionId: string,
    reason: McpSessionCloseReason,
  ): void {
    this.closedSessionReasons.delete(sessionId);
    this.closedSessionReasons.set(sessionId, reason);
    while (this.closedSessionReasons.size > this.maxSessions * 4) {
      const oldest = this.closedSessionReasons.keys().next().value;
      if (typeof oldest !== "string") break;
      this.closedSessionReasons.delete(oldest);
    }
  }

  private pruneCreatedAt(cutoffMs: number): void {
    let firstRetained = 0;
    while (
      firstRetained < this.createdAtMs.length &&
      this.createdAtMs[firstRetained] <= cutoffMs
    ) {
      firstRetained += 1;
    }
    if (firstRetained > 0) this.createdAtMs.splice(0, firstRetained);
  }
}

function emptySourceCounts(): Record<McpSessionSource, number> {
  return {
    main_connector: 0,
    workspace_app: 0,
    doctor: 0,
    test_client: 0,
    unknown: 0,
  };
}

function emptyMissingReasonCounts(): Record<McpMissingSessionReason, number> {
  return {
    client: 0,
    expired: 0,
    capacity: 0,
    shutdown: 0,
    never_seen: 0,
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
