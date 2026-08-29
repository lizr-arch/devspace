import { desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions, type WorkspaceSessionRow } from "./db/schema.js";
import type { AdditionalRoot } from "./roots.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
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

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
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
