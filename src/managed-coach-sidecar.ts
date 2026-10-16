import { createHash, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { isPathInsideRoot } from "./roots.js";
import Database from "better-sqlite3";
import { JobResourceLocks, sharedResourceLocks } from "./job-resource-locks.js";
import { AgentObserverStore } from "./agent-observer.js";

const SERVICE_NAME = "coach-feed";
const MAX_EVENTS = 50;
const EXTENSION_ID = /^[a-p]{32}$/;

type SidecarInput = { workspaceId: string; workspaceRoot: string; port: number; pairedExtensionId?: string; observeAllNativeAgents?: boolean; pairingToken?:string };
type EventRow = { event_id: string | number; operation_id: string; event_type: string; created_at: string };
type Entry = SidecarInput & { token: Buffer; server: Server; database: Database.Database; jobId: string; startedAt: string };

export interface CoachSidecarStatus { workspaceId: string; serviceName: string; port: number; state: "running"|"stopped"; startedAt?: string; pairedExtensionId?: string; reason?:string; }
export interface CoachSidecarStartResult extends CoachSidecarStatus { token: string; }
export interface ManagedCoachSidecarControl {
  start(input:Omit<SidecarInput,"pairingToken">):Promise<CoachSidecarStartResult>;
  stop(workspaceId:string):Promise<void>;
  status(workspaceId:string):CoachSidecarStatus|undefined|Promise<CoachSidecarStatus|undefined>;
  activeServiceIdsForRoot(root:string):string[];
  close():Promise<void>;
}

function validPort(port: unknown): asserts port is number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid loopback port");
}

function tokenMatches(expected: Buffer, actual: string | undefined): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const encoded = actual.slice(7);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const candidate = Buffer.from(encoded, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function schemaCheck(database: Database.Database, native: boolean): void {
  if (native) {
    database.prepare("select event_id,workspace_id,operation_id,event_type,created_at from coach_review_events where 1=0").all();
    database.prepare("select event_id from coach_review_decisions where 1=0").all();
    database.prepare("select snapshot_json from agent_efficiency_audits where 1=0").all();
    return;
  }
  const tables = database.prepare("select name from sqlite_master where type = 'table' and name in ('events','review_decisions')").all() as { name: string }[];
  if (tables.length !== 2) throw new Error("coach feed database schema is missing");
  database.prepare("select event_id, operation_id, event_type, created_at from events where 1 = 0").all();
  database.prepare("select event_id from review_decisions where 1 = 0").all();
}

export class ManagedCoachSidecar {
  private readonly services = new Map<string, Entry>();
  private starting?: Promise<CoachSidecarStartResult>;
  private closing = false;
  constructor(
    private readonly locks: JobResourceLocks = sharedResourceLocks,
    private readonly nativeEventDatabasePath?: string,
    private readonly observer?: AgentObserverStore,
  ) {}

  async start(input: SidecarInput): Promise<CoachSidecarStartResult> {
    if (this.closing) throw new Error("coach-feed manager has been closed");
    validPort(input.port);
    if (!input.workspaceId || !input.workspaceRoot) throw new TypeError("workspaceId and workspaceRoot are required");
    if (input.pairedExtensionId !== undefined && !EXTENSION_ID.test(input.pairedExtensionId)) throw new TypeError("Invalid paired extension id");
    if(input.pairingToken!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(input.pairingToken))throw new TypeError("Invalid pairing token");
    // Elevated cross-worktree observer scope must be explicitly granted at
    // sidecar startup, never implicitly inherited from the existing v0.2 token.
    if (input.observeAllNativeAgents && !input.pairedExtensionId) throw new TypeError("Admin observer requires a paired extension");
    if (this.services.has(input.workspaceId) || this.services.size > 0) throw new Error("coach-feed sidecar is already running");
    if (this.starting) throw new Error("coach-feed start already in progress");
    this.starting = this.startInternal(input);
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private async startInternal(input: SidecarInput): Promise<CoachSidecarStartResult> {
    // A unique claim prevents a different manager instance from aliasing a live lease.
    const jobId = `sidecar:${randomUUID()}`;
    const requests = JobResourceLocks.requestsForReadonlySidecar({ serviceName: SERVICE_NAME, port: input.port });
    this.locks.acquire({ jobId, runner: "sidecar", workspaceRoot: input.workspaceRoot, requests });
    let database: Database.Database | undefined;
    let server: Server | undefined;
    try {
      const databasePath = this.nativeEventDatabasePath ?? join(input.workspaceRoot, ".devspace", "coach_loop_spike.sqlite");
      if (!existsSync(databasePath)) throw new Error("coach feed database is missing");
      const canonicalRoot = realpathSync(input.workspaceRoot);
      const canonicalDatabase = realpathSync(databasePath);
      const fileAuthorized = this.nativeEventDatabasePath
        ? canonicalDatabase === this.nativeEventDatabasePath
        : isPathInsideRoot(canonicalDatabase, canonicalRoot);
      if (!fileAuthorized || !statSync(canonicalDatabase).isFile()) {
        throw new Error("coach feed database must be a regular file inside the authorized workspace");
      }
      database = new Database(canonicalDatabase, { readonly: true, fileMustExist: true });
      schemaCheck(database, Boolean(this.nativeEventDatabasePath));
      const token = input.pairingToken?Buffer.from(input.pairingToken,"base64url"):randomBytes(32);
      const entry = await new Promise<Entry>((resolve, reject) => {
        server = createServer((req, res) => this.handle(entry, req, res));
        server.requestTimeout = 5_000;
        server.headersTimeout = 5_000;
        server.maxRequestsPerSocket = 100;
        server.once("error", reject);
        server.listen(input.port, "127.0.0.1", () => resolve({ ...input, token, server: server!, database: database!, jobId, startedAt: new Date().toISOString() }));
      });
      this.services.set(input.workspaceId, entry);
      // An unexpected listener exit must not strand its exclusive claims.
      entry.server.once("close", () => {
        if (this.services.get(input.workspaceId) !== entry) return;
        this.services.delete(input.workspaceId);
        try { entry.database.close(); } catch { /* Already shutting down. */ }
        this.locks.release(entry.jobId);
      });
      entry.server.on("error", () => {
        if (this.services.get(input.workspaceId) === entry) {
          void this.stop(input.workspaceId).catch(() => {});
        }
      });
      return { workspaceId: input.workspaceId, serviceName: SERVICE_NAME, port: input.port, state: "running", startedAt: entry.startedAt, ...(input.pairedExtensionId ? { pairedExtensionId: input.pairedExtensionId } : {}), token: token.toString("base64url") };
    } catch (error) {
      if (server) {
        try { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
        catch { /* Bind may have failed before listen; no active listener exists. */ }
      }
      try { database?.close(); }
      finally { this.locks.release(jobId); }
      throw error;
    }
  }

  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const cors: Record<string, string> = entry.pairedExtensionId && origin === `chrome-extension://${entry.pairedExtensionId}` ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    if (req.headers.host !== `127.0.0.1:${entry.port}`) return send(res, 400, { error: "invalid host" });
    if (origin && origin !== `chrome-extension://${entry.pairedExtensionId ?? ""}`) return send(res, 403, { error: "origin forbidden" });
    if (req.method === "OPTIONS") {
      if (!entry.pairedExtensionId || origin !== `chrome-extension://${entry.pairedExtensionId}`) return send(res, 403, { error: "origin forbidden" });
      return send(res, 204, {}, { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "Authorization" });
    }
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, cors);
    if (!tokenMatches(entry.token, req.headers.authorization)) return send(res, 401, { error: "unauthorized" }, cors);
    if (req.url === "/health") return send(res, 200, { ok: true, service: SERVICE_NAME, status: "ok" }, cors);
    if (req.url) {
      const parsed=new URL(req.url,"http://127.0.0.1");
      if (parsed.pathname === "/agent/events") {
      if (!entry.observeAllNativeAgents) return send(res,403,{error:"observer admin scope not enabled"},cors);
      if (!this.observer) return send(res, 503, { error:"observer unavailable" }, cors);
      for (const key of parsed.searchParams.keys()) if(key!=="cursor") return send(res,400,{error:"invalid query"},cors);
      const value=parsed.searchParams.get("cursor")??"0";
      if(!/^\d+$/.test(value)) return send(res,400,{error:"invalid cursor"},cors);
      const cursor=Number(value); if(!Number.isSafeInteger(cursor)||cursor<0) return send(res,400,{error:"invalid cursor"},cors);
      const feed=this.observer.readGlobal(cursor);
      res.setHeader("cache-control","no-store");
      return send(res,200,feed,cors);
      }
      if (parsed.pathname === "/agent/audit") {
        if (!entry.observeAllNativeAgents) return send(res,403,{error:"observer admin scope not enabled"},cors);
        const workspaceId=parsed.searchParams.get("workspaceId"), operationId=parsed.searchParams.get("operationId");
        const names=[...parsed.searchParams.keys()];
        if (!workspaceId || !operationId ||
            !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId) ||
            !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId) ||
            names.length!==2 || names.some(k=>k!=="workspaceId" && k!=="operationId"))
          return send(res,400,{error:"invalid query"},cors);
        try {
          const row=entry.database.prepare(
            "SELECT snapshot_json,snapshot_sha256 FROM agent_efficiency_audits WHERE workspace_id=? AND operation_id=?"
          ).get(workspaceId,operationId) as {snapshot_json:string;snapshot_sha256:string}|undefined;
          if(!row)return send(res,404,{error:"audit unavailable"},cors);
          if(Buffer.byteLength(row.snapshot_json,"utf8")>48*1024 ||
             !row.snapshot_sha256 ||
             createHash("sha256").update(row.snapshot_json).digest("hex")!==row.snapshot_sha256)
            return send(res,503,{error:"audit integrity failure"},cors);
          const snapshot=JSON.parse(row.snapshot_json);
          if(snapshot?.version!==1 || snapshot.identity?.workspaceId!==workspaceId ||
             snapshot.identity?.operationId!==operationId)
            return send(res,503,{error:"audit integrity failure"},cors);
          res.setHeader("cache-control","no-store");
          return send(res,200,{snapshot},cors);
        } catch { return send(res,503,{error:"audit unavailable"},cors); }
      }
    }
    if (req.url !== "/events") return send(res, 404, { error: "not found" }, cors);
    try {
      const native = Boolean(this.nativeEventDatabasePath);
      const pendingQuery = native
        ? "from coach_review_events e where e.workspace_id = ? " +
          "and e.event_type = 'READY_FOR_GPT_REVIEW' " +
          "and not exists (select 1 from coach_review_decisions r where r.event_id=e.event_id)"
        : "from events e where e.event_type = 'READY_FOR_GPT_REVIEW' " +
          "and not exists (select 1 from review_decisions r where r.event_id = e.event_id)";
      const total = entry.database.prepare("select count(*) as count " + pendingQuery)
        .get(...(native ? [entry.workspaceId] : [])) as { count: number };
      const rows = entry.database.prepare(
        "select e.event_id as event_id, " +
        "substr(cast(e.operation_id as text),1,128) as operation_id, " +
        "e.event_type, substr(cast(e.created_at as text),1,64) as created_at " +
        pendingQuery + " order by e.created_at asc limit 50",
      ).all(...(native ? [entry.workspaceId] : [])) as EventRow[];
      return send(res, 200, {
        pending_count: total.count,
        // A native Sidecar serves only entry.workspaceId; include that verified scope
        // in each event so external Coach notifications can locate exact evidence.
        events: rows.slice(0, MAX_EVENTS).map(row=>({...row,workspace_id:entry.workspaceId})),
      }, cors);
    } catch {
      return send(res, 503, { error: "event store unavailable" }, cors);
    }
  }

  status(workspaceId: string): CoachSidecarStatus | undefined {
    const entry = this.services.get(workspaceId);
    if (!entry) return undefined;
    return { workspaceId, serviceName: SERVICE_NAME, port: entry.port, state: "running", startedAt: entry.startedAt, ...(entry.pairedExtensionId ? { pairedExtensionId: entry.pairedExtensionId } : {}) };
  }

  async stop(workspaceId: string): Promise<void> {
    // Stop may race a pending bind; do not return before a new listener exists.
    if (this.starting) { try { await this.starting; } catch { /* Failed starts already release locks. */ } }
    const entry = this.services.get(workspaceId);
    if (!entry) return;
    this.services.delete(workspaceId);
    try {
      entry.server.closeAllConnections();
      await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    } finally {
      try { entry.database.close(); }
      finally { this.locks.release(entry.jobId); }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.starting) { try { await this.starting; } catch { /* Failed start cleaned up. */ } }
    await Promise.all([...this.services.keys()].map((id) => this.stop(id)));
  }
  activeServiceIdsForRoot(root: string): string[] { return [...this.services.values()].filter((entry) => entry.workspaceRoot === root).map((entry) => entry.workspaceId); }
}
