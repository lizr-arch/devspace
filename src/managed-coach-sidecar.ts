import { RouteBridgeDelivery, type BridgeTransport, type TrustedReply } from "./coach-routes/delivery.js";
import { RouteAccessController, type RouteAccessAction, type RouteAccessMode, type RoutePrincipal, type RoutePrincipalTarget, type RoutePrincipalVerifier } from "./coach-routes/route-principal.js";
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
import {
  DSH_SESSION_RE, MultiRouteStore, ROUTE_ID_RE, RouteError, canonicalChatUrl,
  type ClaimedEnvelope, type LegacyRouteRecord, type PendingReviewWake, type RouteEnvelope, type RouteMessageState,
  type RouteOrigination, type RouteProposal, type RouteRecord, type StoreSnapshot,
} from "./coach-multiroute.js";

const SERVICE_NAME = "coach-feed";
const PAIRING_EXTENSION_ID = "bapcebjlgncogfpgbhllioaichcldkbl";
const MAX_EVENTS = 50;
type FeedCursor={at:string;kind:"c"|"a";id:string};
const FEED_CURSOR=/^[A-Za-z0-9_-]{8,400}$/;
function decodeFeedCursor(raw:string):FeedCursor {
  if(!FEED_CURSOR.test(raw))throw new Error("INVALID_FEED_CURSOR");
  const data=JSON.parse(Buffer.from(raw,"base64url").toString("utf8")) as Record<string,unknown>;
  if(!data||Object.keys(data).sort().join(",")!=="at,id,kind,v"||data.v!==1||
     typeof data.at!=="string"||data.at.length<1||data.at.length>64||
     (data.kind!=="c"&&data.kind!=="a")||typeof data.id!=="string"||
     (data.kind==="c"?!/^[1-9][0-9]{0,15}$/.test(data.id):!/^[A-Za-z0-9:._-]{1,128}$/.test(data.id)))
    throw new Error("INVALID_FEED_CURSOR");
  const cursor:FeedCursor={at:data.at,kind:data.kind as "c"|"a",id:data.id};
  if(Buffer.from(JSON.stringify({v:1,...cursor})).toString("base64url")!==raw)
    throw new Error("INVALID_FEED_CURSOR");
  return cursor;
}
function encodeFeedCursor(cursor:FeedCursor):string{
  return Buffer.from(JSON.stringify({v:1,...cursor})).toString("base64url");
}
const EXTENSION_ID = /^[a-p]{32}$/;

type SidecarInput = {
  workspaceId: string; workspaceRoot: string; port: number;
  pairedExtensionId?: string; observeAllNativeAgents?: boolean; pairingToken?:string;
  authorizedWorkspaceIds?:string[];
  /** Explicit per-start consent for exact multi-route DSH sessions (bounded). */
  authorizedDshSessionIds?: string[];
  /** Durable per-route queue root; defaults next to the event database. */
  routeStateDir?: string;
};
type EventRow = { event_id: string | number; workspace_id?:string; operation_id: string; event_type: string; created_at: string };
export type DeliveryReceipt = {event_id:number|string;workspace_id:string;operation_id:string;result:"dom_submitted";recorded_at:string};
type Entry = SidecarInput & {
  token: Buffer; server: Server; database: Database.Database;
  receiptDb?:Database.Database; jobId: string; startedAt: string; handoffPath?:string;
  routeStore?: MultiRouteStore;
  routeBridge?: RouteBridgeDelivery;
};

export interface CoachSidecarStatus { workspaceId: string; serviceName: string; port: number; state: "running"|"stopped"; startedAt?: string; pairedExtensionId?: string; reason?:string; }
export interface CoachSidecarStartResult extends CoachSidecarStatus { token: string; }
export interface ManagedCoachSidecarControl {
  start(input:Omit<SidecarInput,"pairingToken">):Promise<CoachSidecarStartResult>;
  stop(workspaceId:string):Promise<void>;
  status(workspaceId:string):CoachSidecarStatus|undefined|Promise<CoachSidecarStatus|undefined>;
  activeServiceIdsForRoot(root:string):string[];
  getDeliveryReceipt?(workspaceId:string,eventId:number|string):DeliveryReceipt|undefined|Promise<DeliveryReceipt|undefined>;
  close():Promise<void>;
  claimBrowserRoute?(workspaceId:string,nonce:string,url:string,persistScope?:(ids:string[])=>void):boolean|Promise<boolean>;
  claimExactBrowserRoute?(input:ExactRouteClaimInput):ExactRouteClaimResult|Promise<ExactRouteClaimResult>;
  revokeBrowserRoute?(input:{routeId:string;expectedConsentRevision?:number;reason?:string}):ExactRouteClaimResult;
  enqueueRouteReviewWake?(input:{routeId:string;messageId:string;eventId:number;operationId:string}):{duplicate:boolean;envelope:RouteEnvelope};
  submitTrustedRouteReply?(input:TrustedReply, context:unknown):ReturnType<RouteBridgeDelivery["reply"]>;
  enqueueRouteReply?(input:{routeId:string;messageId:string;content:string;inReplyTo:string}):{duplicate:boolean;envelope:RouteEnvelope};
  claimRouteDeliveries?(input:{routeId:string;origination:RouteOrigination;limit?:number}):ClaimedEnvelope[];
  recordRouteOutcome?(input:{routeId:string;messageId:string;seq:number;contentSha256:string;
    outcome:"dom_submitted"|"manual_sent"|"acked"|"not_submitted"|"uncertain"|"timeout"|"existing_draft"|"page_busy"|"navigation_mismatch";reason?:string}):RouteEnvelope;
  resolveRouteAttention?(input:{routeId:string;messageId:string;seq:number;contentSha256:string;action:"retry"|"mark_sent";reason?:string}):RouteEnvelope;
  listRouteMessages?(input:{routeId:string;origination?:RouteOrigination;afterSeq?:number;limit?:number}):RouteEnvelope[];
  routeSnapshot?():StoreSnapshot;
  /** Test/diagnostics-only in-process read of unclaimed, unexpired proposals; never HTTP. */
  pendingRouteProposals?():RouteProposal[];
  importLegacyRoutes?(records:{workspaceId:string;url:string;tabId?:number}[]):LegacyRouteRecord[];
  migrateLegacyRoute?(input:{legacyId:string;targetRouteId:string;expectedConsentRevision?:number}):LegacyRouteRecord;
  classifyLegacyMessage?(input:{legacyId?:string;workspaceId?:string;messageId?:string}):{state:"UNROUTABLE";reason:string;legacyId?:string};
  pendingReviewWakes?():{routeId:string;messageId:string;seq:number;eventId:number;operationId:string;workspaceId:string;state:RouteMessageState;submittedAt:string}[];
  configureRouteAccess(options:{mode?:RouteAccessMode;verifier?:RoutePrincipalVerifier}):void;
  authorizeRouteAction(action:RouteAccessAction,context:unknown,route?:RoutePrincipalTarget):Promise<RoutePrincipal>;
  authorizeRouteClaim(action:"claim_browser_route"|"claim_browser_route_exact",context:unknown,input:{workspaceId:string;chatId:string}):Promise<RoutePrincipal>;
  authorizeRouteWorkspaceAction(action:"classify_legacy"|"migrate_legacy",context:unknown,workspaceId?:string):Promise<RoutePrincipal>;
  projectRouteSnapshotForPrincipal(principal:RoutePrincipal,snapshot:StoreSnapshot,pendingReviews:readonly PendingReviewWake[]):{snapshot:StoreSnapshot;pendingReviews:PendingReviewWake[]};
  visibleRoutesForPrincipal(principal:RoutePrincipal,routes:readonly RouteRecord[]):RouteRecord[];
  principalCanSeeRoute(principal:RoutePrincipal,route:RouteRecord):boolean;
}

export interface ExactRouteClaimInput {
  workspaceId:string; dshSessionId:string; routeId:string; nonce:string; url:string;
  replaceRouteId?:string; expectedConsentRevision?:number;
  persistScope?:(ids:string[])=>void;
}
export interface ExactRouteClaimResult {
  claimed:boolean; code?:string; route?:{
    routeId:string; workspaceId:string; dshSessionId:string; canonicalChatUrl:string;
    exactTabId:number; consentRevision:number; state:string;
  };
}

/** Local HTTP error with an explicit browser-visible status; never carries internals. */
class RouteHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "RouteHttpError"; }
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
  private readonly routeAccess = new RouteAccessController({ mode: "legacy" });
  constructor(
    private readonly locks: JobResourceLocks = sharedResourceLocks,
    private readonly nativeEventDatabasePath?: string,
    private readonly observer?: AgentObserverStore,
    private readonly bridgeTransport?: BridgeTransport,
  ) { this.handoffPath=nativeEventDatabasePath?join(realpathSync(dirname(nativeEventDatabasePath)),"coach-current-pairing.json"):undefined; }

  /**
   * HOST wiring point for route authorization. Production server code enables
   * "enforced" with no verifier => every sensitive route action is denied until
   * a real authenticated verifier is injected. Direct local/test users may keep
   * the compatibility "legacy" mode, which must never be used with a live
   * ChatGPT/MCP transport.
   */
  configureRouteAccess(options: { mode?: RouteAccessMode; verifier?: RoutePrincipalVerifier }): void {
    this.routeAccess.configure(options);
  }
  async authorizeRouteAction(action: RouteAccessAction, context: unknown, route?: RoutePrincipalTarget): Promise<RoutePrincipal> {
    return this.routeAccess.authorize(action, context, route);
  }
  async authorizeRouteClaim(action: "claim_browser_route" | "claim_browser_route_exact", context: unknown,
    input: { workspaceId: string; chatId: string }): Promise<RoutePrincipal> {
    return this.routeAccess.authorizeClaim(action, context, input);
  }
  async authorizeRouteWorkspaceAction(action: "classify_legacy" | "migrate_legacy", context: unknown,
    workspaceId?: string): Promise<RoutePrincipal> {
    return this.routeAccess.authorizeWorkspaceAction(action, context, workspaceId);
  }
  projectRouteSnapshotForPrincipal(principal: RoutePrincipal, snapshot: StoreSnapshot,
    pendingReviews: readonly PendingReviewWake[]) {
    return this.routeAccess.projectSnapshot(principal, snapshot, pendingReviews);
  }
  visibleRoutesForPrincipal(principal: RoutePrincipal, routes: readonly RouteRecord[]): RouteRecord[] {
    return this.routeAccess.visibleRoutes(principal, routes);
  }
  principalCanSeeRoute(principal: RoutePrincipal, route: RouteRecord): boolean {
    return this.routeAccess.canSeeRoute(principal, route);
  }

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
    if(input.authorizedDshSessionIds!==undefined){
      const ids=input.authorizedDshSessionIds;
      if(!Array.isArray(ids)||ids.length<1||ids.length>8||new Set(ids).size!==ids.length||
         ids.some(id=>typeof id!=="string"||!DSH_SESSION_RE.test(id)))
        throw new TypeError("Invalid authorized DSH session list");
      // Multi-route identity is meaningful only for the paired extension flow.
      if(!input.pairedExtensionId)throw new TypeError("Authorized DSH sessions require a paired extension");
    }
    if(input.routeStateDir!==undefined&&(typeof input.routeStateDir!=="string"||!input.routeStateDir))
      throw new TypeError("Invalid route state directory");
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
        receiptDb.exec("CREATE TABLE IF NOT EXISTS app_delivery_receipts(event_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,result TEXT NOT NULL CHECK(result='dom_submitted'),recorded_at TEXT NOT NULL)");
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
        try { entry.routeStore?.close(); } catch { /* Already shutting down. */ }
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
    const routePostUrl = req.url ?? "";
    if (req.method === "POST" && (routePostUrl === "/route/propose" || routePostUrl === "/routes/legacy/import" ||
        /^\/routes\/rt_[A-Za-z0-9_-]{43}\/(?:ack|resolve|revoke)$/.test(routePostUrl))) {
      if (!entry.pairedExtensionId || origin !== `chrome-extension://${entry.pairedExtensionId}` ||
          !tokenMatches(entry.token, req.headers.authorization))
        return send(res, 403, { error: "route transport forbidden" }, cors);
      void this.handleRoutePost(entry, req, res, cors);
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
    const routeGetUrl = req.url ?? "";
    if (routeGetUrl === "/routes" || routeGetUrl.startsWith("/routes/") || routeGetUrl.startsWith("/route/status")) {
      try {
        void this.handleRouteGet(entry, req, res, cors).then((handled) => {
          if (!handled) send(res, 404, { error: "not found" }, cors);
        }).catch((error: unknown) => this.sendRouteError(res, error instanceof RouteError ? error.code : "ROUTE_STORE_UNAVAILABLE", cors));
        return;
      } catch (error) {
        const code = error instanceof RouteError ? error.code : "ROUTE_STORE_UNAVAILABLE";
        return this.sendRouteError(res, code, cors);
      }
      return send(res, 404, { error: "not found" }, cors);
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
    if([...feedUrl.searchParams.keys()].some(k=>!["workspaceId","cursor","limit"].includes(k))||
       ["workspaceId","cursor","limit"].some(k=>feedUrl.searchParams.getAll(k).length>1))
      return send(res,400,{error:"invalid feed selector"},cors);
    const rawLimit=feedUrl.searchParams.get("limit");
    if(rawLimit!==null&&!/^[1-9][0-9]?$/.test(rawLimit))
      return send(res,400,{error:"invalid feed limit"},cors);
    const limit=rawLimit===null?MAX_EVENTS:Number(rawLimit);
    if(limit<1||limit>MAX_EVENTS)return send(res,400,{error:"invalid feed limit"},cors);
    let cursor:FeedCursor|null=null;
    try{const raw=feedUrl.searchParams.get("cursor");if(raw!==null)cursor=decodeFeedCursor(raw);}
    catch{return send(res,400,{error:"invalid feed cursor"},cors);}
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
      const hasRoutes=hasEvidence&&Boolean(entry.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coach_browser_route_claims'").get());
      // The event identity ALWAYS remains the execution origin. Only the
      // delivery selector uses the separately claimed immutable grant.
      const deliveryScope=hasRoutes?"coalesce(json_extract(p.packet_json,'$.delivery.workspaceId'),e.workspace_id)":"e.workspace_id";
      const validRoute=hasRoutes?" AND (json_type(p.packet_json,'$.delivery') IS NULL OR EXISTS (SELECT 1 FROM coach_browser_route_claims b WHERE b.workspace_id=json_extract(p.packet_json,'$.delivery.workspaceId') AND b.nonce=json_extract(p.packet_json,'$.delivery.nonce'))) ":"";
      const pendingQuery = native
        ? "from coach_review_events e "+(hasEvidence?"LEFT JOIN coach_review_evidence p ON p.event_id=e.event_id ":"")+"where "+deliveryScope+" IN (" +
          ids.map(()=>"?").join(",") + ") and e.event_type = 'READY_FOR_GPT_REVIEW' " +
          (hasEvidence?"AND "+COACH_DELIVERY_SQL+" ":"")+
          validRoute+
          "and not exists (select 1 from coach_review_decisions r where r.event_id=e.event_id)"
        : "from events e where e.event_type = 'READY_FOR_GPT_REVIEW' " +
          "and not exists (select 1 from review_decisions r where r.event_id = e.event_id)";
      const total = entry.database.prepare("select count(*) as count " + pendingQuery)
        .get(...(native ? ids : [])) as { count: number };
      const coachAfter=cursor
        ?cursor.kind==="c"
          ?" and (e.created_at > ? or (e.created_at = ? and e.event_id > ?))"
          :" and e.created_at > ?"
        :"";
      const coachArgs=cursor?(cursor.kind==="c"
        ?[cursor.at,cursor.at,Number(cursor.id)]:[cursor.at]):[];
      const rows = entry.database.prepare(
        "select e.event_id as event_id, " +
        (native?"e.workspace_id as workspace_id, ":"") +
        "substr(cast(e.operation_id as text),1,128) as operation_id, " +
        "e.event_type, substr(cast(e.created_at as text),1,64) as created_at " +
        pendingQuery+coachAfter+" order by e.created_at asc,e.event_id asc limit ?",
      ).all(...(native ? ids : []),...coachArgs,limit+1) as EventRow[];
      const hasAppEvents=native&&Boolean(entry.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_app_review_events'").get());
      const appPendingCount=hasAppEvents?(entry.database.prepare("SELECT count(*) AS count FROM codex_app_review_events e LEFT JOIN codex_app_review_decisions d ON d.event_id=e.event_id WHERE e.workspace_id IN ("+ids.map(()=>"?").join(",")+") AND d.event_id IS NULL").get(...ids) as {count:number}).count:0;
      const appAfter=cursor
        ?cursor.kind==="a"
          ?" AND (e.created_at > ? OR (e.created_at = ? AND e.event_id > ?))"
          :" AND e.created_at >= ?"
        :"";
      const appArgs=cursor?(cursor.kind==="a"
        ?[cursor.at,cursor.at,cursor.id]:[cursor.at]):[];
      const appRows=hasAppEvents?entry.database.prepare("SELECT e.event_id,e.workspace_id,e.operation_id,'CODEX_APP_READY_FOR_GPT_REVIEW' AS event_type,e.thread_id,e.turn_id,e.evidence_sha256,e.created_at FROM codex_app_review_events e LEFT JOIN codex_app_review_decisions d ON d.event_id=e.event_id WHERE e.workspace_id IN ("+ids.map(()=>"?").join(",")+") AND d.event_id IS NULL"+appAfter+" ORDER BY e.created_at,e.event_id LIMIT ?").all(...ids,...appArgs,limit+1) as Array<EventRow&{thread_id:string;turn_id:string;evidence_sha256:string}>:[];
      const combined=[...rows.map(row=>({row,kind:"c" as const,app:undefined as undefined|{thread_id:string;turn_id:string;evidence_sha256:string}})),...appRows.map(row=>({row,kind:"a" as const,app:row}))].sort((a,b)=>{
        const at=String(a.row.created_at),bt=String(b.row.created_at);
        if(at!==bt)return at<bt?-1:1;
        if(a.kind!==b.kind)return a.kind==="c"?-1:1;
        return a.kind==="c"?Number(a.row.event_id)-Number(b.row.event_id)
          :String(a.row.event_id).localeCompare(String(b.row.event_id),"en");
      });
      const hasMore=combined.length>limit;
      const page=combined.slice(0,limit);
      const last=page[page.length-1];
      return send(res,200,{
        pending_count:total.count+appPendingCount,
        has_more:hasMore,
        next_cursor:hasMore&&last?encodeFeedCursor({at:String(last.row.created_at),kind:last.kind,id:String(last.row.event_id)}):null,
        events:page.map(({row,app})=>{
          if(app)return {...row,event_type:"CODEX_APP_READY_FOR_GPT_REVIEW",app_kind:"native_chatgpt_app_codex",thread_id:app.thread_id,turn_id:app.turn_id,evidence_sha256:app.evidence_sha256};
          const evidence=hasEvidence?entry.database.prepare("SELECT packet_json,evidence_sha256 FROM coach_review_evidence WHERE event_id=?").get(row.event_id) as {packet_json:string;evidence_sha256:string}|undefined:undefined;
          let report;
          let deliveryFields={};
          let event_type: string="READY_FOR_GPT_REVIEW";
          if(evidence){
            const {evidenceSha256,...packet}=JSON.parse(evidence.packet_json);
            if(evidenceSha256!==evidence.evidence_sha256 || createHash("sha256").update(JSON.stringify(packet)).digest("hex")!==evidence.evidence_sha256)throw new Error("COACH_EVIDENCE_INTEGRITY_FAILURE");
            report=safeReportOutcome(packet.report);
            const delivery=completionDeliveryType(packet);
            if(!delivery)throw new Error("COACH_DELIVERY_REPORT_INVALID");
            event_type=delivery;
            if(packet.delivery)deliveryFields={delivery_workspace_id:packet.delivery.workspaceId,delivery_nonce:packet.delivery.nonce};
          }
          return {...row,event_type,workspace_id:native?row.workspace_id:entry.workspaceId,...deliveryFields,...(report?{report}:{})};
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

  // ---------------------------------------------------------------------
  // Exact multi-route API (I1). The legacy workspace-only browser claim above
  // is preserved byte-for-byte; this path always requires an exact routeId,
  // DSH session id, canonical chat URL and explicit per-start session consent.
  // ---------------------------------------------------------------------

  private scopeFor(entry: Entry): string[] { return entry.authorizedWorkspaceIds ?? [entry.workspaceId]; }

  private routeEntry(): Entry {
    const entries = [...this.services.values()];
    if (entries.length !== 1) throw new Error("COACH_ROUTE_STORE_UNAVAILABLE");
    return entries[0];
  }

  private routeStoreFor(entry: Entry): MultiRouteStore {
    if (entry.routeStore) return entry.routeStore;
    const fallback = join(dirname(entry.database.name), "coach-routes");
    const store = new MultiRouteStore({
      stateDir: entry.routeStateDir ?? fallback,
      maxRoutes: 32,
      maxLegacyRoutes: 32,
      maxProposals: 16,
      maxQueuedPerRoute: 1024,
    });
    entry.routeStore = store;
    return store;
  }

  private bridgeFor(entry: Entry): RouteBridgeDelivery {
    if (!this.bridgeTransport) throw new Error("BLOCKED_REAL_E2E: trusted bridge and WebGPT principal verifier required");
    return entry.routeBridge ??= new RouteBridgeDelivery(this.routeStoreFor(entry), this.bridgeTransport,
      () => entry.authorizedDshSessionIds ?? [], () => this.scopeFor(entry));
  }
  /** Local trusted ingest entry: only references, never self-reported sender/body. */
  ingestDshReceipt(input: Parameters<RouteBridgeDelivery["ingest"]>[0]) {
    return this.bridgeFor(this.routeEntry()).ingest(input);
  }
  submitTrustedRouteReply(input: TrustedReply, context: unknown) {
    return this.bridgeFor(this.routeEntry()).reply(input, context);
  }

  private assertRouteInScope(entry: Entry, store: MultiRouteStore, routeId: string): RouteRecord {
    const route = store.route(routeId);
    if (!route || !this.scopeFor(entry).includes(route.workspaceId)) {
      throw new RouteHttpError(403, "route scope not authorized");
    }
    return route;
  }

  private publicRoute(route: RouteRecord): ExactRouteClaimResult["route"] {
    return {
      routeId: route.routeId, workspaceId: route.workspaceId, dshSessionId: route.dshSessionId,
      canonicalChatUrl: route.canonicalChatUrl, exactTabId: route.exactTabId,
      consentRevision: route.consentRevision, state: route.state,
    };
  }

  private sendRouteError(res: ServerResponse, code: string, cors: Record<string, string>): void {
    const status =
      code === "ROUTE_NOT_FOUND" || code === "ROUTE_PROPOSAL_NOT_FOUND" ? 404 :
      code === "ROUTE_WORKSPACE_NOT_AUTHORIZED" || code === "ROUTE_DSH_SESSION_NOT_AUTHORIZED" ? 403 :
      code === "ROUTE_LIMIT" || code === "ROUTE_QUEUE_LIMIT" ? 429 :
      code.startsWith("ROUTE_QUEUE_CORRUPT") || code.startsWith("ROUTE_STORE_CORRUPT") || code === "ROUTE_STORE_UNAVAILABLE" ? 503 :
      code === "ROUTE_CHAT_ALREADY_BOUND" || code === "ROUTE_SESSION_ALREADY_BOUND" || code === "ROUTE_TAB_ALREADY_BOUND" ||
      code === "ROUTE_CONSENT_REVISION_MISMATCH" || code === "ROUTE_REVOKED" || code === "ROUTE_NOT_ACTIVE" ||
      code === "ROUTE_ACK_CONFLICT" || code === "ROUTE_STATE_TRANSITION_DENIED" || code === "ROUTE_LEGACY_MIGRATION_DENIED" ? 409 :
      code === "ROUTE_PROPOSAL_EXPIRED" || code === "ROUTE_PROPOSAL_ALREADY_CLAIMED" || code === "ROUTE_LEGACY_UNROUTABLE" ? 410 : 400;
    send(res, status, { error: code }, cors);
  }

  private async readRouteJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
    if (req.headers["content-type"] !== "application/json") throw new RouteHttpError(415, "invalid content type");
    let raw = "", length = 0;
    for await (const part of req) {
      length += Buffer.byteLength(part);
      if (length > limit) throw new RouteHttpError(413, "body too large");
      raw += part.toString("utf8");
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new RouteHttpError(400, "invalid json"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RouteHttpError(400, "invalid body");
    return data as Record<string, unknown>;
  }

  private checkRouteBody(data: Record<string, unknown>, allowed: string[], required: string[]): void {
    for (const key of Object.keys(data)) if (!allowed.includes(key)) throw new RouteHttpError(400, "unexpected field");
    for (const key of required) if (data[key] === undefined) throw new RouteHttpError(400, "missing field");
  }

  private async handleRoutePost(entry: Entry, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    try {
      const url = req.url ?? "";
      const store = this.routeStoreFor(entry);
      const scope = this.scopeFor(entry);
      if (url === "/route/propose") {
        const data = await this.readRouteJson(req, 2048);
        this.checkRouteBody(data, ["nonce", "tabId", "url"], ["nonce", "tabId", "url"]);
        const proposal = store.propose({ nonce: String(data.nonce), url: String(data.url), tabId: Number(data.tabId) });
        return send(res, 200, { ok: true, routeId: proposal.routeId, nonce: proposal.nonce,
          url: proposal.canonicalChatUrl, tabId: proposal.exactTabId, expiresSeconds: 600 }, cors);
      }
      if (url === "/routes/legacy/import") {
        const data = await this.readRouteJson(req, 16 * 1024);
        this.checkRouteBody(data, ["records"], ["records"]);
        if (!Array.isArray(data.records) || data.records.length < 1 || data.records.length > 32)
          throw new RouteHttpError(400, "invalid records");
        const records = data.records.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new RouteHttpError(400, "invalid record");
          const record = item as Record<string, unknown>;
          this.checkRouteBody(record, ["workspaceId", "url", "tabId"], ["workspaceId", "url"]);
          if (!scope.includes(String(record.workspaceId))) throw new RouteHttpError(403, "workspace scope not authorized");
          return {
            workspaceId: String(record.workspaceId), url: String(record.url),
            ...(record.tabId !== undefined ? { tabId: Number(record.tabId) } : {}),
          };
        });
        const legacy = store.importLegacyRoutes(records);
        return send(res, 200, { ok: true, count: legacy.length, legacy }, cors);
      }
      const match = /^\/routes\/(rt_[A-Za-z0-9_-]{43})\/(ack|resolve|revoke)$/.exec(url);
      if (!match) return send(res, 404, { error: "not found" }, cors);
      const route = this.assertRouteInScope(entry, store, match[1]);
      if (match[2] === "ack") {
        const data = await this.readRouteJson(req, 4096);
        this.checkRouteBody(data, ["messageId", "seq", "contentSha256", "outcome", "reason"],
          ["messageId", "seq", "contentSha256", "outcome"]);
        const envelope = store.recordDeliveryOutcome({
          routeId: route.routeId, messageId: String(data.messageId), seq: Number(data.seq),
          contentSha256: String(data.contentSha256), outcome: data.outcome as never,
          ...(data.reason !== undefined ? { reason: String(data.reason) } : {}),
        });
        return send(res, 200, { ok: true, message: { routeId: envelope.routeId, messageId: envelope.messageId, seq: envelope.seq, state: envelope.state } }, cors);
      }
      if (match[2] === "resolve") {
        const data = await this.readRouteJson(req, 4096);
        this.checkRouteBody(data, ["messageId", "seq", "contentSha256", "action", "reason"],
          ["messageId", "seq", "contentSha256", "action"]);
        const envelope = store.resolveAttention({
          routeId: route.routeId, messageId: String(data.messageId), seq: Number(data.seq),
          contentSha256: String(data.contentSha256), action: data.action as never,
          ...(data.reason !== undefined ? { reason: String(data.reason) } : {}),
        });
        return send(res, 200, { ok: true, message: { routeId: envelope.routeId, messageId: envelope.messageId, seq: envelope.seq, state: envelope.state } }, cors);
      }
      const data = await this.readRouteJson(req, 4096);
      this.checkRouteBody(data, ["expectedConsentRevision", "reason"], []);
      const revoked = store.revoke({
        routeId: route.routeId,
        ...(data.expectedConsentRevision !== undefined ? { expectedConsentRevision: Number(data.expectedConsentRevision) } : {}),
        ...(data.reason !== undefined ? { reason: String(data.reason) } : {}),
      });
      return send(res, 200, { ok: true, route: this.publicRoute(revoked) }, cors);
    } catch (error) {
      if (error instanceof RouteHttpError) return send(res, error.status, { error: error.message }, cors);
      const code = error instanceof RouteError ? error.code : "ROUTE_STORE_UNAVAILABLE";
      return this.sendRouteError(res, code, cors);
    }
  }

  private async handleRouteGet(entry: Entry, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<boolean> {
    const url = req.url ?? "";
    const store = this.routeStoreFor(entry);
    const scope = this.scopeFor(entry);
    if (url === "/routes") {
      const snapshot = store.snapshot();
      res.setHeader("cache-control", "no-store");
      send(res, 200, {
        ok: true, consentRevision: snapshot.consentRevision,
        routes: snapshot.routes.map((route) => this.publicRoute(route)),
        legacy: snapshot.legacy, pendingProposals: snapshot.pendingProposals,
        pendingReviews: store.pendingReviewWakes().length,
      }, cors);
      return true;
    }
    const status = /^\/route\/status\?routeId=(rt_[A-Za-z0-9_-]{43})$/.exec(url);
    if (status) {
      const route = store.route(status[1]);
      res.setHeader("cache-control", "no-store");
      if (route) {
        if (!scope.includes(route.workspaceId)) return send(res, 403, { error: "route scope not authorized" }, cors), true;
        return send(res, 200, { ok: true, state: route.state, route: this.publicRoute(route) }, cors), true;
      }
      const proposal = store.proposalByRouteId(status[1]);
      if (proposal && !proposal.claimedRouteId) {
        return send(res, 200, { ok: true, state: "pending", routeId: proposal.routeId,
          url: proposal.canonicalChatUrl, tabId: proposal.exactTabId,
          expiresAt: new Date(proposal.expiresAt).toISOString() }, cors), true;
      }
      return send(res, 404, { error: "ROUTE_NOT_FOUND" }, cors), true;
    }
    const next = /^\/routes\/(rt_[A-Za-z0-9_-]{43})\/next\?origination=(dsh|webgpt)(?:&limit=([1-8]))?$/.exec(url);
    if (next) {
      const route = this.assertRouteInScope(entry, store, next[1]);
      const messages = this.bridgeTransport && next[2] === "dsh" ? await this.bridgeFor(entry).claimBrowser(route.routeId) : store.claimDeliveries({
        routeId: route.routeId, origination: next[2] as RouteOrigination,
        ...(next[3] ? { limit: Number(next[3]) } : {}),
      });
      const stats = store.queueStats(route.routeId);
      res.setHeader("cache-control", "no-store");
      send(res, 200, {
        ok: true,
        messages: messages.map((message) => ({
          routeId: message.routeId, messageId: message.messageId, seq: message.seq,
          contentSha256: message.contentSha256, kind: message.kind, origination: message.origination,
          state: message.state, attempt: message.attempt, content: message.content,
          ...("eventId" in message.data ? { eventId: message.data.eventId,
            operationId: message.data.operationId, workspaceId: message.workspaceId } : {}),
          ...(message.kind === "DSH_MESSAGE_NOTIFY" && "eventId" in message.data ? {
            dshSessionId: message.dshSessionId, sourceContentSha256: message.data.sourceContentSha256,
            data: { eventId: message.data.eventId, operationId: message.data.operationId, sourceContentSha256: message.data.sourceContentSha256 },
          } : { data: message.data }),
        })),
        cursor: { ackedThroughSeq: stats.ackedThroughSeq, lastSeq: stats.lastSeq },
      }, cors);
      return true;
    }
    return false;
  }

  /** Exact bind used by coach_webgpt_claim_browser_route_exact (never the legacy tool). */
  claimExactBrowserRoute(input: ExactRouteClaimInput): ExactRouteClaimResult | Promise<ExactRouteClaimResult> {
    // Keep the old transport-free API synchronous. Configured trusted routes
    // must re-query the exact live session before granting a new claim.
    if (!this.bridgeTransport) return this.claimExactBrowserRouteUnchecked(input);
    return this.claimExactBrowserRouteLive(input);
  }
  private async claimExactBrowserRouteLive(input: ExactRouteClaimInput): Promise<ExactRouteClaimResult> {
    const entry = this.routeEntry();
    if (!entry.authorizedDshSessionIds?.includes(input.dshSessionId))
      return { claimed: false, code: "ROUTE_DSH_SESSION_NOT_AUTHORIZED" };
    try {
      const session = await this.bridgeTransport!.session(input.dshSessionId);
      if (!session || session.sessionId !== input.dshSessionId || !session.allowed)
        return { claimed: false, code: "ROUTE_DSH_SESSION_NOT_AUTHORIZED" };
      return this.claimExactBrowserRouteUnchecked(input); // rechecks current scope and revision
    } catch { return { claimed: false, code: "ROUTE_DSH_SESSION_NOT_AUTHORIZED" }; }
  }
  private claimExactBrowserRouteUnchecked(input: ExactRouteClaimInput): ExactRouteClaimResult {
    const entry = this.routeEntry();
    const scope = this.scopeFor(entry);
    if (!scope.includes(input.workspaceId)) {
      if (scope.length >= 8 || !input.persistScope) return { claimed: false, code: "ROUTE_WORKSPACE_NOT_AUTHORIZED" };
      const next = [...scope, input.workspaceId];
      try { input.persistScope(next); } catch { return { claimed: false, code: "COACH_ROUTE_SCOPE_PERSISTENCE_DENIED" }; }
      entry.authorizedWorkspaceIds = next;
    }
    const authorizedDshSessionIds = entry.authorizedDshSessionIds ?? [];
    if (authorizedDshSessionIds.length === 0) return { claimed: false, code: "COACH_ROUTE_DSH_SESSION_SCOPE_NOT_ENABLED" };
    try {
      const route = this.routeStoreFor(entry).claimExact({
        routeId: input.routeId, nonce: input.nonce, url: input.url,
        workspaceId: input.workspaceId, dshSessionId: input.dshSessionId,
        authorizedWorkspaceIds: this.scopeFor(entry),
        authorizedDshSessionIds,
        ...(input.replaceRouteId ? { replaceRouteId: input.replaceRouteId } : {}),
        ...(input.expectedConsentRevision !== undefined ? { expectedConsentRevision: input.expectedConsentRevision } : {}),
      });
      return { claimed: true, route: this.publicRoute(route) };
    } catch (error) {
      if (error instanceof RouteError) return { claimed: false, code: error.code };
      throw error;
    }
  }

  revokeBrowserRoute(input: { routeId: string; expectedConsentRevision?: number; reason?: string }): ExactRouteClaimResult {
    try {
      const entry = this.routeEntry();
      this.assertRouteInScope(entry, this.routeStoreFor(entry), input.routeId);
      const route = this.routeStoreFor(entry).revoke(input);
      return { claimed: true, route: this.publicRoute(route) };
    } catch (error) {
      if (error instanceof RouteHttpError) return { claimed: false, code: "ROUTE_WORKSPACE_NOT_AUTHORIZED" };
      if (error instanceof RouteError) return { claimed: false, code: error.code };
      throw error;
    }
  }

  enqueueRouteReviewWake(input: { routeId: string; messageId: string; eventId: number; operationId: string }) {
    const entry = this.routeEntry();
    return this.routeStoreFor(entry).enqueueReviewWake(input);
  }
  enqueueRouteReply(input: { routeId: string; messageId: string; content: string; inReplyTo: string }) {
    const store = this.routeStoreFor(this.routeEntry());
    let afterSeq = 0;
    for (;;) {
      const page = store.listMessages({ routeId: input.routeId, afterSeq, limit: 50 });
      if (page.some((message) => message.messageId === input.inReplyTo && message.kind === "DSH_MESSAGE_NOTIFY"))
        throw new Error("BRIDGE_WEBGPT_PRINCIPAL_UNVERIFIED: use trusted_reply");
      if (page.length < 50) break;
      afterSeq = page.at(-1)!.seq;
    }
    return store.enqueueReply(input);
  }
  claimRouteDeliveries(input: { routeId: string; origination: RouteOrigination; limit?: number }): ClaimedEnvelope[] {
    return this.routeStoreFor(this.routeEntry()).claimDeliveries(input);
  }
  recordRouteOutcome(input: { routeId: string; messageId: string; seq: number; contentSha256: string;
    outcome: "dom_submitted" | "manual_sent" | "acked" | "not_submitted" | "uncertain" | "timeout" | "existing_draft" | "page_busy" | "navigation_mismatch"; reason?: string }): RouteEnvelope {
    return this.routeStoreFor(this.routeEntry()).recordDeliveryOutcome(input);
  }
  resolveRouteAttention(input: { routeId: string; messageId: string; seq: number; contentSha256: string; action: "retry" | "mark_sent"; reason?: string }): RouteEnvelope {
    return this.routeStoreFor(this.routeEntry()).resolveAttention(input);
  }
  listRouteMessages(input: { routeId: string; origination?: RouteOrigination; afterSeq?: number; limit?: number }): RouteEnvelope[] {
    return this.routeStoreFor(this.routeEntry()).listMessages(input);
  }
  routeSnapshot(): StoreSnapshot {
    return this.routeStoreFor(this.routeEntry()).snapshot();
  }
  /**
   * Test-only in-process view used by `p6-test-bootstrap`: it can only OBSERVE a
   * proposal that the user's test extension created through POST /route/propose.
   * It is not routed through HTTP and is never called by production server code.
   */
  pendingRouteProposals(): RouteProposal[] {
    return this.routeStoreFor(this.routeEntry()).pendingRouteProposals();
  }
  importLegacyRoutes(records: { workspaceId: string; url: string; tabId?: number }[]): LegacyRouteRecord[] {
    const entry = this.routeEntry();
    const scope = this.scopeFor(entry);
    if (records.some((record) => !scope.includes(record.workspaceId))) throw new RouteHttpError(403, "workspace scope not authorized");
    return this.routeStoreFor(entry).importLegacyRoutes(records);
  }
  migrateLegacyRoute(input: { legacyId: string; targetRouteId: string; expectedConsentRevision?: number }): LegacyRouteRecord {
    return this.routeStoreFor(this.routeEntry()).migrateLegacy(input);
  }
  classifyLegacyMessage(input: { legacyId?: string; workspaceId?: string; messageId?: string }): { state: "UNROUTABLE"; reason: string; legacyId?: string } {
    return this.routeStoreFor(this.routeEntry()).classifyLegacyMessage(input);
  }
  pendingReviewWakes() {
    return this.routeStoreFor(this.routeEntry()).pendingReviewWakes();
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
          typeof data.workspace_id!=="string" ||
          typeof data.operation_id!=="string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(data.operation_id))
        return send(res,400,{error:"invalid receipt identity"},cors);
      if(typeof data.event_id==="string"&&/^app:[a-f0-9]{64}$/.test(data.event_id)){
        if(!(entry.authorizedWorkspaceIds??[entry.workspaceId]).includes(data.workspace_id))
          return send(res,400,{error:"invalid receipt identity"},cors);
        const event=entry.database.prepare("SELECT operation_id FROM codex_app_review_events WHERE event_id=? AND workspace_id=?").get(data.event_id,data.workspace_id) as {operation_id:string}|undefined;
        if(!event||event.operation_id!==data.operation_id)return send(res,404,{error:"event identity not found"},cors);
        entry.receiptDb!.prepare("INSERT OR IGNORE INTO app_delivery_receipts VALUES(?,?,?,?,?)").run(data.event_id,data.workspace_id,data.operation_id,"dom_submitted",new Date().toISOString());
        const row=entry.receiptDb!.prepare("SELECT event_id,workspace_id,operation_id,result,recorded_at FROM app_delivery_receipts WHERE event_id=? AND workspace_id=?").get(data.event_id,data.workspace_id) as DeliveryReceipt|undefined;
        if(!row||row.operation_id!==data.operation_id)return send(res,409,{error:"receipt identity conflict"},cors);
        return send(res,200,{ok:true,receipt:row},cors);
      }
      if(!Number.isSafeInteger(data.event_id)||Number(data.event_id)<=0)return send(res,400,{error:"invalid receipt identity"},cors);
      if(!this.receiptScopeAllowed(entry,data.workspace_id,Number(data.event_id)))
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

  getDeliveryReceipt(workspaceId:string,eventId:number|string):DeliveryReceipt|undefined {
    const entry=[...this.services.values()].find(e=>
      typeof eventId==="number"?this.receiptScopeAllowed(e,workspaceId,eventId):
        (e.authorizedWorkspaceIds??[e.workspaceId]).includes(workspaceId));
    if(!entry?.receiptDb)return undefined;
    if(typeof eventId==="string"&&/^app:[a-f0-9]{64}$/.test(eventId))return entry.receiptDb.prepare("SELECT event_id,workspace_id,operation_id,result,recorded_at FROM app_delivery_receipts WHERE event_id=? AND workspace_id=?").get(eventId,workspaceId) as DeliveryReceipt|undefined;
    if(typeof eventId!=="number"||!Number.isSafeInteger(eventId)||eventId<=0)return undefined;
    return entry.receiptDb.prepare("SELECT event_id,workspace_id,operation_id,result,recorded_at FROM delivery_receipts WHERE event_id=? AND workspace_id=?")
      .get(eventId,workspaceId) as DeliveryReceipt|undefined;
  }

  private receiptScopeAllowed(entry:Entry,workspaceId:string,eventId:number):boolean {
    if(!Number.isSafeInteger(eventId)||eventId<=0)return false;
    try {
      const row=entry.database.prepare("SELECT p.packet_json,p.evidence_sha256 FROM coach_review_events e JOIN coach_review_evidence p ON p.event_id=e.event_id WHERE e.event_id=? AND e.workspace_id=?")
        .get(eventId,workspaceId) as {packet_json:string;evidence_sha256:string}|undefined;
      if(row){
        const {evidenceSha256,...packet}=JSON.parse(row.packet_json);
        if(evidenceSha256!==row.evidence_sha256||createHash("sha256").update(JSON.stringify(packet)).digest("hex")!==evidenceSha256)return false;
        if(packet.delivery){
          const grant=entry.database.prepare("SELECT nonce FROM coach_browser_route_claims WHERE workspace_id=?").get(packet.delivery.workspaceId) as {nonce:string}|undefined;
          return grant?.nonce===packet.delivery.nonce && (entry.authorizedWorkspaceIds??[entry.workspaceId]).includes(packet.delivery.workspaceId);
        }
      }
      return (entry.authorizedWorkspaceIds??[entry.workspaceId]).includes(workspaceId);
    }catch{return false;}
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
      try {
        this.revokeHandoff(entry.handoffPath); entry.database.close(); entry.receiptDb?.close();
        entry.routeStore?.close();
      } finally { this.locks.release(entry.jobId); }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.starting) { try { await this.starting; } catch { /* Failed start cleaned up. */ } }
    await Promise.all([...this.services.keys()].map((id) => this.stop(id)));
  }
  activeServiceIdsForRoot(root: string): string[] { return [...this.services.values()].filter((entry) => entry.workspaceRoot === root).map((entry) => entry.workspaceId); }
}
