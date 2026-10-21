import { safeReportOutcome } from "./coach-result-contract.js";
import { COACH_DELIVERY_SQL, completionDeliveryType } from "./coach-review-events.js";
import { createHash, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync, lstatSync, chmodSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { isPathInsideRoot } from "./roots.js";
import Database from "better-sqlite3";
import { JobResourceLocks, sharedResourceLocks } from "./job-resource-locks.js";
import { AgentObserverStore } from "./agent-observer.js";

const SERVICE_NAME = "coach-feed";
const PAIRING_EXTENSION_ID = "bapcebjlgncogfpgbhllioaichcldkbl";
const MAX_EVENTS = 50;
const EXTENSION_ID = /^[a-p]{32}$/;

type SidecarInput = { workspaceId: string; workspaceRoot: string; port: number; pairedExtensionId?: string; observeAllNativeAgents?: boolean; pairingToken?:string; authorizedWorkspaceIds?:string[] };
type EventRow = { event_id: string | number; workspace_id?:string; operation_id: string; event_type: string; created_at: string };
export type DeliveryReceipt = {event_id:number;workspace_id:string;operation_id:string;result:"dom_submitted";recorded_at:string};
type Entry = SidecarInput & { token: Buffer; server: Server; database: Database.Database; receiptDb?:Database.Database; jobId: string; startedAt: string; handoffPath?:string };

export interface CoachSidecarStatus { workspaceId: string; serviceName: string; port: number; state: "running"|"stopped"; startedAt?: string; pairedExtensionId?: string; reason?:string; }
export interface CoachSidecarStartResult extends CoachSidecarStatus { token: string; }
export interface ManagedCoachSidecarControl {
  start(input:Omit<SidecarInput,"pairingToken">):Promise<CoachSidecarStartResult>;
  stop(workspaceId:string):Promise<void>;
  status(workspaceId:string):CoachSidecarStatus|undefined|Promise<CoachSidecarStatus|undefined>;
  activeServiceIdsForRoot(root:string):string[];
  getDeliveryReceipt?(workspaceId:string,eventId:number):DeliveryReceipt|undefined|Promise<DeliveryReceipt|undefined>;
  close():Promise<void>;
  claimBrowserRoute?(workspaceId:string,nonce:string,url:string,persistScope?:(ids:string[])=>void):boolean;
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
  // Browser-origin challenges are short-lived, memory-only, and bound to one exact chat URL.
  private readonly browserClaims = new Map<string,{entryId:string;url:string;expires:number;workspaceId?:string}>();
  private starting?: Promise<CoachSidecarStartResult>;
  private closing = false;
  private readonly handoffPath?: string;
  constructor(
    private readonly locks: JobResourceLocks = sharedResourceLocks,
    private readonly nativeEventDatabasePath?: string,
    private readonly observer?: AgentObserverStore,
  ) { this.handoffPath=nativeEventDatabasePath?join(realpathSync(dirname(nativeEventDatabasePath)),"coach-current-pairing.json"):undefined; }

  private publishHandoff(port:number,token:Buffer):string|undefined {
    const path=this.handoffPath;if(!path)return undefined;
    const dir=dirname(path);mkdirSync(dir,{recursive:true,mode:0o700});const ds=lstatSync(dir);
    if(ds.isSymbolicLink()||!ds.isDirectory()||realpathSync(dir)!==dir||(process.getuid&&ds.uid!==process.getuid())||(process.platform!=="win32"&&(ds.mode&0o077)!==0))throw new Error("COACH_PAIRING_STATE_UNSAFE");
    if(existsSync(path)){const st=lstatSync(path);if(st.isSymbolicLink()||!st.isFile()||realpathSync(path)!==path||(process.getuid&&st.uid!==process.getuid()))throw new Error("COACH_PAIRING_HANDOFF_UNSAFE");}
    const temp=path+"."+randomUUID()+".tmp",fd=openSync(temp,"wx",0o600);
    try{writeSync(fd,JSON.stringify({port,token:token.toString("base64url")}));}finally{closeSync(fd);}
    try{chmodSync(temp,0o600);renameSync(temp,path);chmodSync(path,0o600);return path;}
    catch(error){try{unlinkSync(temp);}catch{/* Best-effort cleanup of a failed atomic handoff. */}throw error;}
  }
  private revokeHandoff(path:string|undefined):void {
    if(!path||!existsSync(path))return;const st=lstatSync(path);
    if(st.isSymbolicLink()||!st.isFile()||realpathSync(path)!==path||(process.getuid&&st.uid!==process.getuid()))throw new Error("COACH_PAIRING_HANDOFF_UNSAFE");unlinkSync(path);
  }

  async start(input: SidecarInput): Promise<CoachSidecarStartResult> {
    if (this.closing) throw new Error("coach-feed manager has been closed");
    validPort(input.port);
    if (!input.workspaceId || !input.workspaceRoot) throw new TypeError("workspaceId and workspaceRoot are required");
    if (input.pairedExtensionId !== undefined && !EXTENSION_ID.test(input.pairedExtensionId)) throw new TypeError("Invalid paired extension id");
    if(input.pairingToken!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(input.pairingToken))throw new TypeError("Invalid pairing token");
    // Elevated cross-worktree observer scope must be explicitly granted at
    // sidecar startup, never implicitly inherited from the existing v0.2 token.
    if (input.observeAllNativeAgents && !input.pairedExtensionId) throw new TypeError("Admin observer requires a paired extension");
    const scope=input.authorizedWorkspaceIds??[input.workspaceId];
    if(scope.length<1||scope.length>8||!scope.includes(input.workspaceId)||
       new Set(scope).size!==scope.length||
       scope.some(id=>!(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))))
      throw new Error("COACH_FEED_SCOPE_INVALID");
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
    let receiptDb: Database.Database | undefined;
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
      if(this.nativeEventDatabasePath) {
        // Keep completion/review evidence readonly. A separate owner-only DB
        // records browser claims, which never count as AI approval.
        const receiptPath=join(dirname(canonicalDatabase),"coach-delivery-receipts.sqlite");
        if(existsSync(receiptPath) && (lstatSync(receiptPath).isSymbolicLink() ||
            !statSync(receiptPath).isFile() || realpathSync(receiptPath)!==receiptPath))
          throw new Error("COACH_DELIVERY_RECEIPT_UNSAFE_PATH");
        receiptDb=new Database(receiptPath);
        if(process.platform!=="win32")chmodSync(receiptPath,0o600);
        receiptDb.pragma("journal_mode = WAL");
        receiptDb.pragma("busy_timeout = 5000");
        receiptDb.exec("CREATE TABLE IF NOT EXISTS delivery_receipts("+
          "event_id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,"+
          "result TEXT NOT NULL CHECK(result='dom_submitted'),recorded_at TEXT NOT NULL)");
      }
      const token = input.pairingToken?Buffer.from(input.pairingToken,"base64url"):randomBytes(32);
      const entry = await new Promise<Entry>((resolve, reject) => {
        server = createServer((req, res) => this.handle(entry, req, res));
        server.requestTimeout = 5_000;
        server.headersTimeout = 5_000;
        server.maxRequestsPerSocket = 100;
        server.once("error", reject);
        server.listen(input.port, "127.0.0.1", () => resolve({ ...input, token, server: server!, database: database!, receiptDb, jobId, startedAt: new Date().toISOString() }));
      });
      entry.handoffPath=input.pairedExtensionId===PAIRING_EXTENSION_ID?this.publishHandoff(input.port,token):undefined;
      this.services.set(input.workspaceId, entry);
      // An unexpected listener exit must not strand its exclusive claims.
      entry.server.once("close", () => {
        if (this.services.get(input.workspaceId) !== entry) return;
        this.services.delete(input.workspaceId);
        for(const [nonce,v] of this.browserClaims)if(v.entryId===input.workspaceId)this.browserClaims.delete(nonce);
        try { this.revokeHandoff(entry.handoffPath); } catch { /* Keep shutdown best-effort. */ }
        try { entry.database.close(); } catch { /* Already shutting down. */ }
        try { entry.receiptDb?.close(); } catch { /* Already shutting down. */ }
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
      try { database?.close(); receiptDb?.close(); }
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
      return send(res, 204, {}, { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Authorization, Content-Type" });
    }
    if(req.method==="POST" && req.url==="/bind/start") {
      if(!entry.pairedExtensionId || origin!==`chrome-extension://${entry.pairedExtensionId}` ||
         !tokenMatches(entry.token,req.headers.authorization))
        return send(res,403,{error:"binding transport forbidden"},cors);
      void this.startBrowserClaim(entry,req,res,cors);return;
    }
    if(req.method==="POST" && req.url==="/delivery-receipt") {
      if(!entry.receiptDb || !entry.pairedExtensionId ||
          origin!==`chrome-extension://${entry.pairedExtensionId}`)
        return send(res,403,{error:"receipt transport unavailable"},cors);
      if(!tokenMatches(entry.token,req.headers.authorization))
        return send(res,401,{error:"unauthorized"},cors);
      void this.acceptDeliveryReceipt(entry,req,res,cors);
      return;
    }
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, cors);
    if (!tokenMatches(entry.token, req.headers.authorization)) return send(res, 401, { error: "unauthorized" }, cors);
    if (req.url === "/health") return send(res, 200, { ok: true, service: SERVICE_NAME, status: "ok" }, cors);
    if(req.url?.startsWith("/bind/status?")) {
      const u=new URL(req.url,"http://127.0.0.1");
      if(u.pathname!=="/bind/status" || [...u.searchParams.keys()].join(",")!=="nonce")
        return send(res,400,{error:"invalid binding query"},cors);
      const nonce=u.searchParams.get("nonce")??"";
      const v=this.browserClaims.get(nonce);
      if(!/^[a-f0-9]{32}$/.test(nonce)||!v||v.entryId!==entry.workspaceId||v.expires<Date.now())
        return send(res,404,{error:"binding unavailable"},cors);
      res.setHeader("cache-control","no-store");
      return send(res,200,{ok:true,state:v.workspaceId?"claimed":"pending",
        ...(v.workspaceId?{workspaceId:v.workspaceId,url:v.url}:{})},cors);
    }
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
    const feedUrl=req.url?new URL(req.url,"http://127.0.0.1"):null;
    if(feedUrl?.pathname!=="/events")return send(res,404,{error:"not found"},cors);
    if([...feedUrl.searchParams.keys()].some(k=>k!=="workspaceId")||
       feedUrl.searchParams.getAll("workspaceId").length>1)
      return send(res,400,{error:"invalid feed selector"},cors);
    // No selector returns only the explicitly authorized union. A caller may
    // also request one selected workspace for bounded per-workspace recovery.
    const selected=feedUrl.searchParams.get("workspaceId");
    const scopes=entry.authorizedWorkspaceIds??[entry.workspaceId];
    if(selected!==null&&!scopes.includes(selected))
      return send(res,403,{error:"workspace scope not authorized"},cors);
    const ids=selected?[selected]:scopes;
    try {
      const native = Boolean(this.nativeEventDatabasePath);
      const hasEvidence=native&&Boolean(entry.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coach_review_evidence'").get());
      const pendingQuery = native
        ? "from coach_review_events e "+(hasEvidence?"LEFT JOIN coach_review_evidence p ON p.event_id=e.event_id ":"")+"where e.workspace_id IN (" +
          ids.map(()=>"?").join(",") + ") and e.event_type = 'READY_FOR_GPT_REVIEW' " +
          (hasEvidence?"AND "+COACH_DELIVERY_SQL+" ":"")+
          "and not exists (select 1 from coach_review_decisions r where r.event_id=e.event_id)"
        : "from events e where e.event_type = 'READY_FOR_GPT_REVIEW' " +
          "and not exists (select 1 from review_decisions r where r.event_id = e.event_id)";
      const total = entry.database.prepare("select count(*) as count " + pendingQuery)
        .get(...(native ? ids : [])) as { count: number };
      const rows = entry.database.prepare(
        "select e.event_id as event_id, " +
        (native?"e.workspace_id as workspace_id, ":"") +
        "substr(cast(e.operation_id as text),1,128) as operation_id, " +
        "e.event_type, substr(cast(e.created_at as text),1,64) as created_at " +
        pendingQuery + " order by e.created_at asc,e.event_id asc limit 50",
      ).all(...(native ? ids : [])) as EventRow[];
      return send(res,200,{
        pending_count:total.count,
        events:rows.slice(0,MAX_EVENTS).map(row=>{
          const evidence=hasEvidence?entry.database.prepare("SELECT packet_json,evidence_sha256 FROM coach_review_evidence WHERE event_id=?").get(row.event_id) as {packet_json:string;evidence_sha256:string}|undefined:undefined;
          let report;
          let event_type: string="READY_FOR_GPT_REVIEW";
          if(evidence){
            const {evidenceSha256,...packet}=JSON.parse(evidence.packet_json);
            if(evidenceSha256!==evidence.evidence_sha256 || createHash("sha256").update(JSON.stringify(packet)).digest("hex")!==evidence.evidence_sha256)throw new Error("COACH_EVIDENCE_INTEGRITY_FAILURE");
            report=safeReportOutcome(packet.report);
            const delivery=completionDeliveryType(packet);
            if(!delivery)throw new Error("COACH_DELIVERY_REPORT_INVALID");
            event_type=delivery;
          }
          return {...row,event_type,workspace_id:native?row.workspace_id:entry.workspaceId,...(report?{report}:{})};
        }),
      },cors);
    } catch {
      return send(res, 503, { error: "event store unavailable" }, cors);
    }
  }

  // This endpoint never accepts a workspaceId from the browser: only an independent
  // Web GPT MCP claim can associate the authenticated challenge with a workspace.
  private async startBrowserClaim(entry:Entry,req:IncomingMessage,res:ServerResponse,cors:Record<string,string>):Promise<void> {
    try {
      if(req.headers["content-type"]!=="application/json")return send(res,415,{error:"invalid content type"},cors);
      let raw="",length=0;
      for await(const part of req){
        length+=Buffer.byteLength(part);if(length>600)return send(res,413,{error:"binding too large"},cors);
        raw+=part.toString("utf8");
      }
      const data=JSON.parse(raw) as Record<string,unknown>;
      if(!data||Array.isArray(data)||typeof data!=="object"||
         Object.keys(data).sort().join(",")!=="nonce,url"||
         typeof data.nonce!=="string"||!/^[a-f0-9]{32}$/.test(data.nonce)||
         typeof data.url!=="string"||!/^https:\/\/chatgpt\.com\/(?:g\/[^/?#]+\/)?c\/[A-Za-z0-9_-]{8,128}$/.test(data.url))
        return send(res,400,{error:"invalid binding"},cors);
      const now=Date.now();
      for(const [k,v] of this.browserClaims)if(v.expires<now)this.browserClaims.delete(k);
      if(this.browserClaims.size>=16)return send(res,429,{error:"too many binding requests"},cors);
      if(this.browserClaims.has(data.nonce))return send(res,409,{error:"binding already exists"},cors);
      this.browserClaims.set(data.nonce,{entryId:entry.workspaceId,url:data.url,expires:now+600_000});
      send(res,200,{ok:true,expiresSeconds:600},cors);
    } catch {if(!res.headersSent)send(res,400,{error:"invalid binding"},cors);}
  }

  claimBrowserRoute(workspaceId:string,nonce:string,url:string,persistScope?:(ids:string[])=>void):boolean {
    if(!/^[a-f0-9]{32}$/.test(nonce))return false;
    const claim=this.browserClaims.get(nonce);
    if(!claim||claim.expires<Date.now()||claim.workspaceId||claim.url!==url)return false;
    const entry=this.services.get(claim.entryId);
    if(!entry)return false;
    // Prevent simultaneously claiming the same workspace from two browser handshakes.
    for(const [key,v] of this.browserClaims)
      if(key!==nonce&&v.entryId===claim.entryId&&v.workspaceId===workspaceId&&v.expires>=Date.now())return false;
    const scope=entry.authorizedWorkspaceIds??[entry.workspaceId];
    if(!scope.includes(workspaceId)){
      // The user's one-click request plus the exact Web GPT MCP claim are
      // the only authorization for expanding scope; never discover all roots.
      if(scope.length>=8||!persistScope)return false;
      const next=[...scope,workspaceId];
      try{persistScope(next);}catch{return false;}
      entry.authorizedWorkspaceIds=next;
    }
    claim.workspaceId=workspaceId;return true;
  }

  private async acceptDeliveryReceipt(entry:Entry,req:IncomingMessage,res:ServerResponse,cors:Record<string,string>):Promise<void> {
    try {
      if(req.headers["content-type"]!=="application/json")
        return send(res,415,{error:"invalid content type"},cors);
      let raw="",length=0;
      for await(const chunk of req) {
        length+=Buffer.byteLength(chunk);
        if(length>1024)return send(res,413,{error:"receipt too large"},cors);
        raw+=chunk.toString("utf8");
      }
      const data=JSON.parse(raw) as Record<string,unknown>;
      if(!data || typeof data!=="object" || Array.isArray(data) ||
          Object.keys(data).sort().join(",")!=="event_id,operation_id,workspace_id" ||
          !Number.isSafeInteger(data.event_id) || Number(data.event_id)<=0 ||
          !(entry.authorizedWorkspaceIds??[entry.workspaceId]).includes(String(data.workspace_id)) ||
          typeof data.operation_id!=="string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(data.operation_id))
        return send(res,400,{error:"invalid receipt identity"},cors);
      const event=entry.database.prepare("SELECT operation_id FROM coach_review_events WHERE event_id=? AND workspace_id=?")
        .get(data.event_id,data.workspace_id) as {operation_id:string}|undefined;
      if(!event || event.operation_id!==data.operation_id)
        return send(res,404,{error:"event identity not found"},cors);
      const stamp=new Date().toISOString();
      entry.receiptDb!.prepare("INSERT OR IGNORE INTO delivery_receipts VALUES(?,?,?,?,?)")
        .run(data.event_id,data.workspace_id,data.operation_id,"dom_submitted",stamp);
      const row=this.getDeliveryReceipt(String(data.workspace_id),Number(data.event_id));
      if(!row || row.operation_id!==data.operation_id)
        return send(res,409,{error:"receipt identity conflict"},cors);
      send(res,200,{ok:true,receipt:row},cors);
    } catch {
      if(!res.headersSent)send(res,400,{error:"invalid receipt"},cors);
    }
  }

  getDeliveryReceipt(workspaceId:string,eventId:number):DeliveryReceipt|undefined {
    const entry=[...this.services.values()].find(e=>
      (e.authorizedWorkspaceIds??[e.workspaceId]).includes(workspaceId));
    if(!entry?.receiptDb || !Number.isSafeInteger(eventId) || eventId<=0)return undefined;
    return entry.receiptDb.prepare("SELECT event_id,workspace_id,operation_id,result,recorded_at FROM delivery_receipts WHERE event_id=? AND workspace_id=?")
      .get(eventId,workspaceId) as DeliveryReceipt|undefined;
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
      try { this.revokeHandoff(entry.handoffPath); entry.database.close(); entry.receiptDb?.close(); }
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
