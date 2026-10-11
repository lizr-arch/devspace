import { desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions, type WorkspaceSessionRow } from "./db/schema.js";
import type { AdditionalRoot } from "./roots.js";
import {
  normalizeWorkspaceLifecycleState,
  type WorkspaceLifecycleState,
} from "./workspace-lifecycle.js";

export type WorkspaceMode = "checkout" | "worktree";

export type { WorkspaceLifecycleState };

export interface WorkspaceSession {
  id: string;
  root: string;
  /**
   * Legacy column. Mirror of `lifecycleState`; kept only so nothing that still
   * reads it observes a value contradicting reality.
   */
  status: string;
  /** Authoritative persisted lifecycle state. */
  lifecycleState: WorkspaceLifecycleState;
  closedAt?: string;
  closedReason?: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  detached: boolean;
  branch?: string;
  requestedAdditionalRoots?: AdditionalRoot[];
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
    detached?: boolean;
    branch?: string;
    requestedAdditionalRoots?: AdditionalRoot[];
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  listSessions(limit?: number): WorkspaceSession[];
  touchSession(id: string): void;
  /** Remove a single workspace record. Returns true when a row was deleted. */
  deleteSession(id: string): boolean;
  /**
   * Persist a lifecycle transition. Returns the updated session, or undefined
   * when the record no longer exists (a concurrent delete is not an error here;
   * the caller decides how to report it).
   */
  setSessionLifecycle?(
    id: string,
    state: WorkspaceLifecycleState,
    options?: { closedReason?: string; touch?: boolean },
  ): WorkspaceSession | undefined;
  /** Sessions whose directory no longer exists, for stale-record reconciliation. */
  listMissingSessions?(limit?: number): WorkspaceSession[];
  updateSessionAdditionalRoots?(id: string, roots: AdditionalRoot[]): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
    detached?: boolean;
    branch?: string;
    requestedAdditionalRoots?: AdditionalRoot[];
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      // A brand new session is only active in the sense that its first request
      // is still in flight. The registry promotes it to `idle` when that
      // request finishes, so a crash mid-request leaves `active` behind — which
      // is exactly the fail-closed state we want.
      lifecycleState: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      detached: input.detached ?? true,
      branch: input.branch,
      requestedAdditionalRoots: input.requestedAdditionalRoots,
      createdAt: now,
      lastUsedAt: now,
    };

    const requestedJson = input.requestedAdditionalRoots
      ? JSON.stringify(input.requestedAdditionalRoots)
      : null;

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        lifecycleState: session.lifecycleState,
        closedAt: null,
        closedReason: null,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        detached: String(session.detached),
        branch: session.branch ?? null,
        requestedAdditionalRootsJson: requestedJson,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listSessions(limit = 50): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .limit(limit)
      .all()
      .map(rowToWorkspaceSession);
  }

  deleteSession(id: string): boolean {
    const result = this.database.db
      .delete(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .run();
    return result.changes > 0;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  setSessionLifecycle(
    id: string,
    state: WorkspaceLifecycleState,
    options: { closedReason?: string; touch?: boolean } = {},
  ): WorkspaceSession | undefined {
    const closedAt = state === "closed" ? new Date().toISOString() : null;
    this.database.db
      .update(workspaceSessions)
      .set({
        lifecycleState: state,
        status: state,
        closedAt,
        closedReason: state === "closed" ? (options.closedReason ?? null) : null,
        ...(options.touch === false
          ? {}
          : { lastUsedAt: new Date().toISOString() }),
      })
      .where(eq(workspaceSessions.id, id))
      .run();
    return this.getSession(id);
  }

  updateSessionAdditionalRoots(id: string, roots: AdditionalRoot[]): void {
    const requestedJson = roots.length > 0 ? JSON.stringify(roots) : null;
    this.database.db
      .update(workspaceSessions)
      .set({
        requestedAdditionalRootsJson: requestedJson,
        lastUsedAt: new Date().toISOString(),
      })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  close(): void {
    this.database.close();
  }
}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  let requestedAdditionalRoots: AdditionalRoot[] | undefined;
  if (row.requestedAdditionalRootsJson) {
    try {
      requestedAdditionalRoots = JSON.parse(row.requestedAdditionalRootsJson);
    } catch {
      // Ignore json parse error
    }
  }

  return {
    id: row.id,
    root: row.root,
    status: row.status,
    lifecycleState: normalizeWorkspaceLifecycleState(row.lifecycleState),
    closedAt: row.closedAt ?? undefined,
    closedReason: row.closedReason ?? undefined,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    detached: row.detached === "true",
    branch: row.branch ?? undefined,
    requestedAdditionalRoots,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
