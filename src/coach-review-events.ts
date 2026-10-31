import { safeReportOutcome, type ReportOutcome } from "./coach-result-contract.js";
/** Native DevSpace coach event store; no project-local experiment DB. */
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isPathInsideRoot } from "./roots.js";
import type { AgentEfficiencySnapshot } from "./agent-efficiency-audit.js";
import { validateCodexSelection, type CodexSelection } from "./coach-model-policy.js";
const FILE = "coach-review-events.sqlite";
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export type CoachDeliveryType="READY_FOR_GPT_REVIEW"|"PLAN_CONFLICT";
/** The immutable completion journal retains its historical schema and IDs.
 * Project the delivery queue from frozen reports, before counting/pagination. */
export const COACH_DELIVERY_SQL="(p.event_id IS NULL OR " +
  "(json_type(p.packet_json,'$.task') IS NULL AND json_type(p.packet_json,'$.report') IS NULL) OR " +
  "(json_type(p.packet_json,'$.report.valid')='true' AND " +
  "json_extract(p.packet_json,'$.report.schema')='DEVSPACE_CODEX_REPORT_CHECK_V1' AND " +
  "json_extract(p.packet_json,'$.report.code')='REPORT_VALID_UNVERIFIED_CLAIMS' AND " +
  "json_type(p.packet_json,'$.report.testsIndependentlyVerified')='false' AND " +
  "length(json_extract(p.packet_json,'$.report.reportSha256'))=64 AND " +
  "json_extract(p.packet_json,'$.report.reportSha256') NOT GLOB '*[^0-9a-f]*' AND " +
  "json_extract(p.packet_json,'$.report.status') IN ('READY_FOR_REVIEW','PLAN_CONFLICT')))";
export function completionDeliveryType(packet?:{task?:unknown;report?:unknown}):CoachDeliveryType|undefined {
  if(packet?.task===undefined&&packet?.report===undefined)return "READY_FOR_GPT_REVIEW";
  const report=safeReportOutcome(packet?.report);
  if(!report?.valid||!report.reportSha256||report.code!=="REPORT_VALID_UNVERIFIED_CLAIMS")return undefined;
  return report.status==="READY_FOR_REVIEW"?"READY_FOR_GPT_REVIEW":report.status==="PLAN_CONFLICT"?"PLAN_CONFLICT":undefined;
}
type Decision = "APPROVED" | "REWORK" | "BLOCKED";
/** Historical archival decisions are deliberately separate from normal review
 * decisions: they can never approve work, grant rework authority, or advance a
 * plan. Only BLOCKED / REWORK_RECOMMENDED are representable. */
export type HistoricalDecision = "BLOCKED" | "REWORK_RECOMMENDED";
export interface HistoricalReviewReceipt {
  event_id: number;
  workspace_id: string;
  operation_id: string;
  decision: HistoricalDecision;
  reason: string;
  evidence_sha256: string;
  frozen_fingerprint: string;
  current_fingerprint: string;
  /** Algorithm used for the current fingerprint: full ref snapshot or bounded git coarse. */
  current_fingerprint_algorithm: string;
  drift: 0 | 1;
  reviewed_at: string;
  source: string;
}
/** Queued selection is applied only when a new explicitly reviewed turn starts.
 * Changes to a running process never mutate its CLI argv or restart the process.
 */
export interface StoredCodexConfig {
  workspaceId:string; operationId:string; revision:number;
  active:CodexSelection; next:CodexSelection; updatedAt:string;
}
export interface VerifiedTest { event_id: number; workspace_id: string; task_id: string; session_id: string; tested_fingerprint: string; output_sha256: string; created_at: string; }
export interface CoachEvent {
  event_id: number;
  workspace_id: string;
  operation_id: string;
  event_type: CoachDeliveryType;
  created_at: string;
  report?:ReportOutcome;
}
export type AgentRunState = "RUNNING"|"COMPLETED"|"FAILED"|"STOPPED"|"INTERRUPTED"|"CLEARED";
export interface GuardianRecord { marker:string; pid:number; pgid:number; uid:number; lstart:string; }
export interface DurableAgentRun {
  workspaceId:string;operationId:string;requestSha256:string;state:AgentRunState;
  startedAt:string;finishedAt:string|null;threadId:string|null;
  eventId:number|null;reason:string|null;
  workerId?:string|null;workerGeneration?:number|null;leaseOwner?:string|null;
  leaseHeartbeatAt?:string|null;eventCursor?:number|null;
}
export interface WorkerLease { workerId:string;generation:number;pid:number;uid:number;lstart:string;heartbeatAt:string; }
export interface ReviewReceipt {
  event_id: number;
  decision: Decision;
  evidence_sha256: string;
  reviewed_at: string;
}
export type AppTurnState="PENDING"|"UNCERTAIN"|"COMPLETED"|"FAILED"|"BLOCKED_PENDING_CONNECTION";
export interface AppTurnRecord {workspace_id:string;operation_id:string;workspace_root:string;thread_id:string;request_sha256:string;task_id:string;task_sha256:string;state:AppTurnState;turn_id:string|null;event_id:string|null;updated_at:string}
export interface AppReviewEvent {event_id:string;workspace_id:string;operation_id:string;event_type:"CODEX_APP_READY_FOR_GPT_REVIEW";thread_id:string;turn_id:string;evidence_sha256:string;created_at:string}
export class CoachReviewEventStore {
  readonly path: string;
  private readonly db: Database.Database;
  private readonly completionListeners=new Set<(event:{workspaceId:string;operationId:string;eventId:number;report?:ReportOutcome})=>void>();
  onCompleted(listener:(event:{workspaceId:string;operationId:string;eventId:number;report?:ReportOutcome})=>void):()=>void {
    this.completionListeners.add(listener);
    return ()=>this.completionListeners.delete(listener);
  }
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(stateDir, 0o700);
    const root = realpathSync(stateDir);
    this.path = join(root, FILE);
    try {
      const existing = realpathSync(this.path);
      if (!isPathInsideRoot(existing, root) || !statSync(existing).isFile() || existing !== this.path) {
        throw new Error("COACH_EVENT_STORE_PATH_UNSAFE");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.db = new Database(this.path);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 10000");
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current > 5) {
      this.db.close();
      throw new Error("COACH_EVENT_STORE_UNSUPPORTED_VERSION");
    }
    this.db.transaction(() => {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS coach_review_events (" +
        "event_id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL," +
        "operation_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type='READY_FOR_GPT_REVIEW')," +
        "evidence_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,operation_id));" +
        "CREATE TABLE IF NOT EXISTS coach_review_decisions (" +
        "event_id INTEGER PRIMARY KEY REFERENCES coach_review_events(event_id)," +
        "decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REWORK','BLOCKED'))," +
        "evidence_sha256 TEXT NOT NULL, reviewed_at TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS coach_review_events_ws_idx " +
        "ON coach_review_events (workspace_id,event_id);" +
        "CREATE TABLE IF NOT EXISTS coach_review_evidence (" +
        "event_id INTEGER PRIMARY KEY REFERENCES coach_review_events(event_id)," +
        "evidence_sha256 TEXT NOT NULL, packet_json TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS coach_review_test_proofs (" +
        "event_id INTEGER PRIMARY KEY REFERENCES coach_review_events(event_id), workspace_id TEXT NOT NULL," +
        "task_id TEXT NOT NULL, session_id TEXT NOT NULL, tested_fingerprint TEXT NOT NULL," +
        "output_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS coach_agent_runs (" +
        "workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_sha256 TEXT NOT NULL," +
        "state TEXT NOT NULL CHECK(state IN (\'RUNNING\',\'COMPLETED\',\'FAILED\',\'STOPPED\',\'INTERRUPTED\',\'CLEARED\'))," +
        "started_at TEXT NOT NULL, finished_at TEXT, thread_id TEXT, event_id INTEGER, reason TEXT," +
        "guardian_marker TEXT, guardian_pid INTEGER, guardian_pgid INTEGER, guardian_uid INTEGER, guardian_lstart TEXT," +
        "worker_id TEXT, worker_generation INTEGER, lease_owner TEXT, lease_heartbeat_at TEXT, cancel_requested_at TEXT, event_cursor INTEGER NOT NULL DEFAULT 0,"+
        "PRIMARY KEY(workspace_id,operation_id));"
      );
      // SQLite ADD COLUMN cannot change the v3 state CHECK constraint.
      // Upgrade the table transactionally and preserve existing run history.
      // Also repair early v4 tables produced by add-column-only migrations.
      const fields=new Set((this.db.pragma("table_info(coach_agent_runs)") as
        {name:string}[]).map(row=>row.name));
      const schema=this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='coach_agent_runs'"
      ).get() as {sql:string};
      const newColumns=["guardian_marker","guardian_pid","guardian_pgid",
        "guardian_uid","guardian_lstart","worker_id","worker_generation","lease_owner","lease_heartbeat_at","cancel_requested_at","event_cursor"];
      if(!schema.sql.includes("'CLEARED'")) {
        const columns=["workspace_id","operation_id","request_sha256","state",
          "started_at","finished_at","thread_id","event_id","reason",...newColumns];
        const select=columns.map(name=>fields.has(name)?name:name==="event_cursor"?"0":"NULL").join(",");
        this.db.exec(
          "ALTER TABLE coach_agent_runs RENAME TO coach_agent_runs_v3_archive;" +
          "CREATE TABLE coach_agent_runs (" +
          "workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_sha256 TEXT NOT NULL," +
          "state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETED','FAILED','STOPPED','INTERRUPTED','CLEARED'))," +
          "started_at TEXT NOT NULL, finished_at TEXT, thread_id TEXT, event_id INTEGER, reason TEXT," +
          "guardian_marker TEXT, guardian_pid INTEGER, guardian_pgid INTEGER, guardian_uid INTEGER, guardian_lstart TEXT," +
          "worker_id TEXT, worker_generation INTEGER, lease_owner TEXT, lease_heartbeat_at TEXT, cancel_requested_at TEXT, event_cursor INTEGER NOT NULL DEFAULT 0,"+
          "PRIMARY KEY(workspace_id,operation_id));" +
          "INSERT INTO coach_agent_runs ("+columns.join(",")+") SELECT "+
            select+" FROM coach_agent_runs_v3_archive;" +
          "DROP TABLE coach_agent_runs_v3_archive;"
        );
      } else {
        for(const name of newColumns) {
          if(!fields.has(name))
            this.db.exec(`ALTER TABLE coach_agent_runs ADD COLUMN ${name} ${name.includes("pid")||name==="guardian_uid"||name==="worker_generation"||name==="event_cursor"?"INTEGER":"TEXT"}${name==="event_cursor"?" NOT NULL DEFAULT 0":""}`);
        }
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS codex_worker_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1),worker_id TEXT NOT NULL,generation INTEGER NOT NULL,pid INTEGER NOT NULL,uid INTEGER NOT NULL,lstart TEXT NOT NULL,heartbeat_at TEXT NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS codex_app_turns (workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,workspace_root TEXT NOT NULL,thread_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,task_id TEXT NOT NULL,task_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','UNCERTAIN','COMPLETED','FAILED','BLOCKED_PENDING_CONNECTION')),turn_id TEXT,event_id TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,operation_id));"+
        "CREATE TABLE IF NOT EXISTS codex_app_review_events (event_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,operation_id));"+
        "CREATE TABLE IF NOT EXISTS codex_app_review_decisions (event_id TEXT PRIMARY KEY REFERENCES codex_app_review_events(event_id),decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REWORK','BLOCKED')),evidence_sha256 TEXT NOT NULL,reason TEXT NOT NULL,reviewed_at TEXT NOT NULL);");
      this.db.exec("CREATE TABLE IF NOT EXISTS codex_worker_generation (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_worker_review_recommendations (workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REWORK','BLOCKED')),reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,operation_id),FOREIGN KEY(workspace_id,operation_id) REFERENCES coach_agent_runs(workspace_id,operation_id))");
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_feed_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL,workspace_root TEXT NOT NULL,port INTEGER NOT NULL,paired_extension_id TEXT,observe_all_native_agents INTEGER NOT NULL CHECK(observe_all_native_agents IN (0,1)),updated_at TEXT NOT NULL)");
      // Explicitly authorized additional workspaces. Never infer access from
      // all existing workspace sessions or a broad observer permission.
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_feed_authorized_workspaces (workspace_id TEXT PRIMARY KEY)");
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_browser_route_claims (workspace_id TEXT PRIMARY KEY,nonce TEXT NOT NULL UNIQUE,url TEXT NOT NULL,claimed_at TEXT NOT NULL);"+
        "CREATE TABLE IF NOT EXISTS coach_webgpt_turn_acks (event_id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,delivery_workspace_id TEXT NOT NULL,acknowledged_at TEXT NOT NULL);");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS coach_agent_model_configs ("+
        "workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL,"+
        "active_model TEXT NOT NULL, active_effort TEXT NOT NULL,"+
        "next_model TEXT NOT NULL, next_effort TEXT NOT NULL,"+
        "revision INTEGER NOT NULL CHECK(revision>=0), updated_at TEXT NOT NULL,"+
        "PRIMARY KEY(workspace_id,operation_id));"
      );
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_agent_quarantine_audit (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id, operation_id, action)); CREATE TABLE IF NOT EXISTS agent_efficiency_audits (workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, operation_id));");
      const af=new Set((this.db.pragma("table_info(agent_efficiency_audits)") as {name:string}[]).map(x=>x.name)); if(!af.has("snapshot_sha256")) this.db.exec("ALTER TABLE agent_efficiency_audits ADD COLUMN snapshot_sha256 TEXT");
      // Additive historical archival journal. It is intentionally NOT part of
      // coach_review_decisions, so the scheduler/rework paths cannot consume it.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS coach_historical_reviews (" +
        "event_id INTEGER PRIMARY KEY REFERENCES coach_review_events(event_id)," +
        "workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL," +
        "decision TEXT NOT NULL CHECK(decision IN ('BLOCKED','REWORK_RECOMMENDED'))," +
        "reason TEXT NOT NULL, evidence_sha256 TEXT NOT NULL," +
        "frozen_fingerprint TEXT NOT NULL, current_fingerprint TEXT NOT NULL," +
        "current_fingerprint_algorithm TEXT NOT NULL DEFAULT 'full-snapshot-v1'," +
        "drift INTEGER NOT NULL CHECK(drift IN (0,1)), reviewed_at TEXT NOT NULL," +
        "source TEXT NOT NULL, UNIQUE(workspace_id,operation_id));" +
        "CREATE INDEX IF NOT EXISTS coach_historical_reviews_ws_idx " +
        "ON coach_historical_reviews(workspace_id,event_id);"
      );
      const hf=new Set((this.db.pragma("table_info(coach_historical_reviews)") as {name:string}[]).map(x=>x.name));
      if(!hf.has("current_fingerprint_algorithm"))
        this.db.exec("ALTER TABLE coach_historical_reviews ADD COLUMN current_fingerprint_algorithm TEXT NOT NULL DEFAULT 'full-snapshot-v1'");
      this.db.pragma("user_version = 5");
    }).immediate();
  }
  /** Save initial selection for exact run scope. Idempotent only for identical
   * inputs; no cross-workspace model changes or silent downgrade.
   */
  recordRunConfig(workspaceId:string,operationId:string,selection:CodexSelection):StoredCodexConfig {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_CONFIG_INVALID_SCOPE");
    validateCodexSelection(selection);
    return this.db.transaction(()=>{
      const run=this.getAgentRun(workspaceId,operationId);
      if(!run)throw new Error("COACH_CONFIG_RUN_NOT_FOUND");
      const existing=this.getRunConfig(workspaceId,operationId);
      if(existing){
        if(existing.active.model!==selection.model || existing.active.reasoningEffort!==selection.reasoningEffort)
          throw new Error("COACH_CONFIG_IDENTITY_CONFLICT");
        return existing;
      }
      this.db.prepare("INSERT INTO coach_agent_model_configs "+
        "(workspace_id,operation_id,active_model,active_effort,next_model,next_effort,revision,updated_at) "+
        "VALUES (?,?,?,?,?,?,0,?)")
        .run(workspaceId,operationId,selection.model,selection.reasoningEffort,
          selection.model,selection.reasoningEffort,new Date().toISOString());
      return this.getRunConfig(workspaceId,operationId)!;
    }).immediate();
  }
  getRunConfig(workspaceId:string,operationId:string):StoredCodexConfig|undefined {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_CONFIG_INVALID_SCOPE");
    const row=this.db.prepare("SELECT * FROM coach_agent_model_configs WHERE workspace_id=? AND operation_id=?")
      .get(workspaceId,operationId) as {active_model:string;active_effort:string;next_model:string;next_effort:string;revision:number;updated_at:string}|undefined;
    if(!row)return undefined;
    const active={model:row.active_model,reasoningEffort:row.active_effort};
    const next={model:row.next_model,reasoningEffort:row.next_effort};
    validateCodexSelection(active);validateCodexSelection(next);
    return {workspaceId,operationId,revision:row.revision,active,next,updatedAt:row.updated_at};
  }
  /** Version-checked durable update. No in-flight interruption; the next
   * explicitly authorized REWORK will inherit this queued selection.
   */
  queueRunConfig(input:{workspaceId:string;operationId:string;expectedRevision:number;selection:CodexSelection}):StoredCodexConfig {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId) ||
       !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)
      throw new TypeError("COACH_CONFIG_INVALID_SCOPE_OR_REVISION");
    validateCodexSelection(input.selection);
    return this.db.transaction(()=>{
      const run=this.getAgentRun(input.workspaceId,input.operationId);
      if(!run || !["RUNNING","COMPLETED"].includes(run.state))
        throw new Error("COACH_CONFIG_RUN_NOT_RESUMABLE");
      const current=this.getRunConfig(input.workspaceId,input.operationId);
      if(!current)throw new Error("COACH_CONFIG_NOT_INITIALIZED");
      if(current.revision!==input.expectedRevision)throw new Error("COACH_CONFIG_STALE_REVISION");
      if(current.next.model===input.selection.model && current.next.reasoningEffort===input.selection.reasoningEffort)
        return current;
      const updated=this.db.prepare(
        "UPDATE coach_agent_model_configs SET next_model=?,next_effort=?,revision=revision+1,updated_at=? "+
        "WHERE workspace_id=? AND operation_id=? AND revision=?")
        .run(input.selection.model,input.selection.reasoningEffort,new Date().toISOString(),
          input.workspaceId,input.operationId,input.expectedRevision);
      if(updated.changes!==1)throw new Error("COACH_CONFIG_STALE_REVISION");
      return this.getRunConfig(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  recordEfficiencyAudit(snapshot: AgentEfficiencySnapshot): void {
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json, "utf8") > 48 * 1024) throw new Error("COACH_AUDIT_TOO_LARGE");
    const digest=createHash("sha256").update(json).digest("hex");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO agent_efficiency_audits(workspace_id,operation_id,snapshot_json,snapshot_sha256,created_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,operation_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,snapshot_sha256=excluded.snapshot_sha256,created_at=excluded.created_at")
        .run(snapshot.identity.workspaceId, snapshot.identity.operationId, json, digest, new Date().toISOString());
      // The audit is observational; keep a bounded history, never an
      // unbounded secondary journal. Core COACH evidence is not deleted.
      this.db.exec("DELETE FROM agent_efficiency_audits WHERE rowid NOT IN (SELECT rowid FROM agent_efficiency_audits ORDER BY created_at DESC,rowid DESC LIMIT 512)");
    }).immediate();
  }
  getEfficiencyAudit(workspaceId: string, operationId: string): AgentEfficiencySnapshot | undefined {
    if (!ID.test(workspaceId) || !ID.test(operationId)) throw new TypeError("COACH_AUDIT_INVALID_SCOPE");
    const row = this.db.prepare("SELECT snapshot_json,snapshot_sha256 FROM agent_efficiency_audits WHERE workspace_id=? AND operation_id=?").get(workspaceId, operationId) as { snapshot_json: string,snapshot_sha256:string } | undefined;
    if (!row) return undefined;
    if (Buffer.byteLength(row.snapshot_json, "utf8") > 48 * 1024 ||
        !row.snapshot_sha256 || createHash("sha256").update(row.snapshot_json).digest("hex") !== row.snapshot_sha256)
      throw new Error("COACH_AUDIT_INTEGRITY_FAILURE");
    const parsed=JSON.parse(row.snapshot_json) as AgentEfficiencySnapshot;
    if (!parsed || parsed.identity?.workspaceId !== workspaceId || parsed.identity?.operationId !== operationId || parsed.version !== 1)
      throw new Error("COACH_AUDIT_INTEGRITY_FAILURE");
    return parsed;
  }
  recordCompleted(input: {workspaceId:string;operationId:string;evidenceSha256:string}): CoachEvent {
    if (!ID.test(input.workspaceId) || !ID.test(input.operationId) || !SHA.test(input.evidenceSha256))
      throw new TypeError("COACH_EVENT_INVALID_INPUT");
    return this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO coach_review_events " +
        "(workspace_id,operation_id,event_type,evidence_sha256,created_at) " +
        "VALUES (?,?,'READY_FOR_GPT_REVIEW',?,?)")
        .run(input.workspaceId,input.operationId,input.evidenceSha256,new Date().toISOString());
      const row = this.db.prepare(
        "SELECT * FROM coach_review_events WHERE workspace_id=? AND operation_id=?"
      ).get(input.workspaceId,input.operationId) as CoachEvent & {evidence_sha256:string};
      if (row.evidence_sha256 !== input.evidenceSha256)
        throw new Error("COACH_EVENT_IDENTITY_CONFLICT");
      const { event_id, workspace_id, operation_id, event_type, created_at } = row;
      return {event_id,workspace_id,operation_id,event_type,created_at};
    }).immediate();
  }
  registerAppTurn(input:{workspaceId:string;operationId:string;workspaceRoot:string;threadId:string;requestSha256:string;taskId:string;taskSha256:string}):AppTurnRecord {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||!SHA.test(input.requestSha256)||!SHA.test(input.taskSha256)||!input.workspaceRoot||!input.threadId||!ID.test(input.taskId))throw new TypeError("CODEX_APP_JOURNAL_INVALID");
    const now=new Date().toISOString();
    return this.db.transaction(()=>{
      this.db.prepare("INSERT OR IGNORE INTO codex_app_turns(workspace_id,operation_id,workspace_root,thread_id,request_sha256,task_id,task_sha256,state,updated_at) VALUES(?,?,?,?,?,?,?,'PENDING',?)").run(input.workspaceId,input.operationId,input.workspaceRoot,input.threadId,input.requestSha256,input.taskId,input.taskSha256,now);
      const row=this.db.prepare("SELECT * FROM codex_app_turns WHERE workspace_id=? AND operation_id=?").get(input.workspaceId,input.operationId) as AppTurnRecord;
      const expected:{workspace_root:string;thread_id:string;request_sha256:string;task_id:string;task_sha256:string}={
        workspace_root:input.workspaceRoot,thread_id:input.threadId,request_sha256:input.requestSha256,
        task_id:input.taskId,task_sha256:input.taskSha256};
      for(const k of Object.keys(expected) as Array<keyof typeof expected>)if(row[k]!==expected[k])throw new Error("CODEX_APP_OPERATION_CONFLICT");
      return row;
    }).immediate();
  }
  updateAppTurn(input:{workspaceId:string;operationId:string;state:AppTurnState;turnId?:string}):AppTurnRecord {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||!(["PENDING","UNCERTAIN","COMPLETED","FAILED","BLOCKED_PENDING_CONNECTION"] as string[]).includes(input.state))throw new TypeError("CODEX_APP_JOURNAL_INVALID");
    const now=new Date().toISOString();
    return this.db.transaction(()=>{
      const old=this.db.prepare("SELECT * FROM codex_app_turns WHERE workspace_id=? AND operation_id=?").get(input.workspaceId,input.operationId) as AppTurnRecord|undefined;
      if(!old)throw new Error("CODEX_APP_OPERATION_NOT_FOUND");
      if(old.state==="COMPLETED"&&input.state!=="COMPLETED")return old;
      if(old.state==="FAILED"&&input.state!=="FAILED")return old;
      const turnId=input.turnId??old.turn_id;
      this.db.prepare("UPDATE codex_app_turns SET state=?,turn_id=?,updated_at=? WHERE workspace_id=? AND operation_id=?").run(input.state,turnId,now,input.workspaceId,input.operationId);
      let eventId=old.event_id;
      if(input.state==="COMPLETED"){
        if(!turnId)throw new Error("CODEX_APP_TURN_ID_REQUIRED");
        eventId="app:"+createHash("sha256").update(input.workspaceId+"\\0"+input.operationId).digest("hex");
        const evidenceSha=createHash("sha256").update(JSON.stringify({workspaceId:input.workspaceId,operationId:input.operationId,threadId:old.thread_id,turnId,requestSha256:old.request_sha256,taskId:old.task_id,taskSha256:old.task_sha256})).digest("hex");
        this.db.prepare("INSERT OR IGNORE INTO codex_app_review_events(event_id,workspace_id,operation_id,thread_id,turn_id,evidence_sha256,created_at) VALUES(?,?,?,?,?,?,?)").run(eventId,input.workspaceId,input.operationId,old.thread_id,turnId,evidenceSha,now);
        const ev=this.db.prepare("SELECT event_id,thread_id,turn_id,evidence_sha256 FROM codex_app_review_events WHERE workspace_id=? AND operation_id=?").get(input.workspaceId,input.operationId) as {event_id:string;thread_id:string;turn_id:string;evidence_sha256:string};
        if(ev.event_id!==eventId||ev.thread_id!==old.thread_id||ev.turn_id!==turnId||ev.evidence_sha256!==evidenceSha)throw new Error("CODEX_APP_EVENT_IDENTITY_CONFLICT");
        this.db.prepare("UPDATE codex_app_turns SET event_id=? WHERE workspace_id=? AND operation_id=?").run(eventId,input.workspaceId,input.operationId);
      }
      return this.db.prepare("SELECT * FROM codex_app_turns WHERE workspace_id=? AND operation_id=?").get(input.workspaceId,input.operationId) as AppTurnRecord;
    }).immediate();
  }
  getAppTurn(workspaceId:string,operationId:string):AppTurnRecord|undefined {if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("CODEX_APP_JOURNAL_INVALID");return this.db.prepare("SELECT * FROM codex_app_turns WHERE workspace_id=? AND operation_id=?").get(workspaceId,operationId) as AppTurnRecord|undefined;}
  listRecoverableAppTurns(limit=50):AppTurnRecord[]{if(!Number.isInteger(limit)||limit<1||limit>50)throw new TypeError("CODEX_APP_JOURNAL_INVALID");return this.db.prepare("SELECT * FROM codex_app_turns WHERE state IN ('PENDING','UNCERTAIN','BLOCKED_PENDING_CONNECTION') AND turn_id IS NOT NULL ORDER BY updated_at LIMIT ?").all(limit) as AppTurnRecord[];}
  listPendingAppEvents(workspaceId:string,limit=50):AppReviewEvent[]{if(!ID.test(workspaceId)||!Number.isInteger(limit)||limit<1||limit>50)throw new TypeError("CODEX_APP_EVENT_QUERY_INVALID");return this.db.prepare("SELECT e.event_id,e.workspace_id,e.operation_id,'CODEX_APP_READY_FOR_GPT_REVIEW' AS event_type,e.thread_id,e.turn_id,e.evidence_sha256,e.created_at FROM codex_app_review_events e LEFT JOIN codex_app_review_decisions d ON d.event_id=e.event_id WHERE e.workspace_id=? AND d.event_id IS NULL ORDER BY e.created_at LIMIT ?").all(workspaceId,limit) as AppReviewEvent[];}
  getAppEventTask(workspaceId:string,eventId:string):{thread_id:string;task_id:string;task_sha256:string;decision?:Decision}|undefined {if(!ID.test(workspaceId)||!/^app:[a-f0-9]{64}$/.test(eventId))throw new TypeError("CODEX_APP_EVENT_QUERY_INVALID");return this.db.prepare("SELECT e.thread_id,t.task_id,t.task_sha256,d.decision FROM codex_app_review_events e JOIN codex_app_turns t ON t.workspace_id=e.workspace_id AND t.operation_id=e.operation_id LEFT JOIN codex_app_review_decisions d ON d.event_id=e.event_id WHERE e.workspace_id=? AND e.event_id=?").get(workspaceId,eventId) as {thread_id:string;task_id:string;task_sha256:string;decision?:Decision}|undefined;}
  countAppReworks(workspaceId:string,taskId:string,taskSha256:string):number {if(!ID.test(workspaceId)||!ID.test(taskId)||!SHA.test(taskSha256))throw new TypeError("CODEX_APP_EVENT_QUERY_INVALID");const row=this.db.prepare("SELECT count(*) AS n FROM codex_app_review_decisions d JOIN codex_app_review_events e ON e.event_id=d.event_id JOIN codex_app_turns t ON t.workspace_id=e.workspace_id AND t.operation_id=e.operation_id WHERE e.workspace_id=? AND t.task_id=? AND t.task_sha256=? AND d.decision='REWORK'").get(workspaceId,taskId,taskSha256) as {n:number};return row.n;}
  submitAppReview(input:{workspaceId:string;eventId:string;decision:Decision;evidenceSha256:string;reason:string}):{event_id:string;decision:Decision;evidence_sha256:string;reviewed_at:string}{
    if(!ID.test(input.workspaceId)||!/^app:[a-f0-9]{64}$/.test(input.eventId)||!SHA.test(input.evidenceSha256)||!input.reason.trim()||input.reason.length>4000||!["APPROVED","REWORK","BLOCKED"].includes(input.decision))throw new TypeError("CODEX_APP_REVIEW_INVALID");
    return this.db.transaction(()=>{const event=this.db.prepare("SELECT evidence_sha256 FROM codex_app_review_events WHERE event_id=? AND workspace_id=?").get(input.eventId,input.workspaceId) as {evidence_sha256:string}|undefined;if(!event)throw new Error("CODEX_APP_EVENT_NOT_FOUND");if(event.evidence_sha256!==input.evidenceSha256)throw new Error("CODEX_APP_REVIEW_EVIDENCE_MISMATCH");this.db.prepare("INSERT OR IGNORE INTO codex_app_review_decisions(event_id,decision,evidence_sha256,reason,reviewed_at) VALUES(?,?,?,?,?)").run(input.eventId,input.decision,input.evidenceSha256,input.reason.trim(),new Date().toISOString());const receipt=this.db.prepare("SELECT event_id,decision,evidence_sha256,reviewed_at FROM codex_app_review_decisions WHERE event_id=?").get(input.eventId) as {event_id:string;decision:Decision;evidence_sha256:string;reviewed_at:string};if(receipt.decision!==input.decision||receipt.evidence_sha256!==input.evidenceSha256)throw new Error("CODEX_APP_REVIEW_CONFLICT");return receipt;}).immediate();
  }
  /** Atomically persist a trusted Runner evidence packet and its completion event. */
  recordCompletedWithEvidence(input: {workspaceId:string;operationId:string;evidenceSha256:string;packetJson:string}): CoachEvent {
    if (typeof input.packetJson !== "string" || Buffer.byteLength(input.packetJson,"utf8") > 1024 * 1024)
      throw new TypeError("COACH_EVIDENCE_PACKET_INVALID");
    let data:Record<string,unknown>;
    try { data=JSON.parse(input.packetJson) as Record<string,unknown>; }
    catch { throw new TypeError("COACH_EVIDENCE_PACKET_INVALID"); }
    if (data.operationId !== input.operationId || data.workspaceId !== input.workspaceId ||
        data.evidenceSha256 !== input.evidenceSha256)
      throw new Error("COACH_EVIDENCE_IDENTITY_MISMATCH");
    const {evidenceSha256: _digest, ...base}=data;
    const hash=createHash("sha256").update(JSON.stringify(base)).digest("hex");
    if (hash !== input.evidenceSha256) throw new Error("COACH_EVIDENCE_HASH_MISMATCH");
    const completedEvent=this.db.transaction(()=>{
      const event=this.recordCompleted(input);
      this.db.prepare("INSERT OR IGNORE INTO coach_review_evidence " +
        "(event_id,evidence_sha256,packet_json) VALUES (?,?,?)")
        .run(event.event_id,input.evidenceSha256,input.packetJson);
      const stored=this.db.prepare("SELECT evidence_sha256,packet_json FROM coach_review_evidence WHERE event_id=?")
        .get(event.event_id) as {evidence_sha256:string;packet_json:string};
      if(stored.evidence_sha256!==input.evidenceSha256 || stored.packet_json!==input.packetJson)
        throw new Error("COACH_EVIDENCE_CONFLICT");
      return event;
    }).immediate();
    // Only publish AFTER SQLite commits evidence and event atomically.
    // A listener is advisory; it must not overturn verified runner success.
    for(const listener of this.completionListeners) {
      try {listener({workspaceId:input.workspaceId,operationId:input.operationId,eventId:completedEvent.event_id,...(safeReportOutcome(data.report)?{report:safeReportOutcome(data.report)}:{})});}
      catch { /* Poll fallback recovers the missed notification. */ }
    }
    return completedEvent;
  }
  getEvidence(workspaceId:string,operationId:string): unknown | undefined {
    if (!ID.test(workspaceId) || !ID.test(operationId)) throw new TypeError("COACH_EVENT_INVALID_INPUT");
    const stored=this.db.prepare("SELECT p.packet_json,p.evidence_sha256 FROM coach_review_evidence p " +
      "JOIN coach_review_events e ON e.event_id=p.event_id " +
      "WHERE e.workspace_id=? AND e.operation_id=?")
      .get(workspaceId,operationId) as {packet_json:string;evidence_sha256:string}|undefined;
    if(!stored)return undefined;
    const parsed=JSON.parse(stored.packet_json) as Record<string,unknown>;
    const {evidenceSha256,...base}=parsed;
    const digest=createHash("sha256").update(JSON.stringify(base)).digest("hex");
    if(digest!==stored.evidence_sha256 || evidenceSha256!==digest)
      throw new Error("COACH_EVIDENCE_INTEGRITY_FAILURE");
    return parsed;
  }
  getEvidenceByEvent(workspaceId: string, eventId: number): unknown | undefined {
    const stored = this.db.prepare("SELECT p.packet_json,p.evidence_sha256 FROM coach_review_evidence p JOIN coach_review_events e ON e.event_id=p.event_id WHERE e.event_id=? AND e.workspace_id=?").get(eventId, workspaceId) as {packet_json:string;evidence_sha256:string}|undefined;
    if (!stored) return undefined;
    const parsed = JSON.parse(stored.packet_json) as Record<string, unknown>;
    const { evidenceSha256, ...base } = parsed;
    if (evidenceSha256 !== stored.evidence_sha256 || createHash("sha256").update(JSON.stringify(base)).digest("hex") !== stored.evidence_sha256) throw new Error("COACH_EVIDENCE_INTEGRITY_FAILURE");
    return parsed;
  }
  recordVerifiedTest(input: {eventId:number;workspaceId:string;taskId:string;sessionId:string;testedFingerprint:string;outputSha256:string}): VerifiedTest {
    if (!SHA.test(input.testedFingerprint) || !SHA.test(input.outputSha256)) throw new TypeError("COACH_TEST_PROOF_INVALID");
    const event = this.db.prepare("SELECT event_id FROM coach_review_events WHERE event_id=? AND workspace_id=?").get(input.eventId,input.workspaceId);
    if (!event) throw new Error("COACH_REVIEW_EVENT_NOT_FOUND");
    this.db.prepare("INSERT OR IGNORE INTO coach_review_test_proofs(event_id,workspace_id,task_id,session_id,tested_fingerprint,output_sha256,created_at) VALUES (?,?,?,?,?,?,?)").run(input.eventId,input.workspaceId,input.taskId,input.sessionId,input.testedFingerprint,input.outputSha256,new Date().toISOString());
    const stored=this.db.prepare("SELECT event_id,workspace_id,task_id,session_id,tested_fingerprint,output_sha256,created_at FROM coach_review_test_proofs WHERE event_id=?").get(input.eventId) as VerifiedTest;
    if(stored.workspace_id!==input.workspaceId || stored.task_id!==input.taskId ||
        stored.session_id!==input.sessionId || stored.tested_fingerprint!==input.testedFingerprint ||
        stored.output_sha256!==input.outputSha256) throw new Error("COACH_TEST_PROOF_CONFLICT");
    return stored;
  }
  getVerifiedTest(eventId: number): VerifiedTest | undefined { return this.db.prepare("SELECT event_id,workspace_id,task_id,session_id,tested_fingerprint,output_sha256,created_at FROM coach_review_test_proofs WHERE event_id=?").get(eventId) as VerifiedTest|undefined; }
  getReview(workspaceId:string,operationId:string): ReviewReceipt | undefined {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_REVIEW_INVALID_SCOPE");
    return this.db.prepare("SELECT d.event_id,d.decision,d.evidence_sha256,d.reviewed_at " +
      "FROM coach_review_decisions d JOIN coach_review_events e ON e.event_id=d.event_id " +
      "WHERE e.workspace_id=? AND e.operation_id=?").get(workspaceId,operationId) as ReviewReceipt|undefined;
  }
  submitReview(input: {workspaceId:string;eventId:number;decision:Decision;evidenceSha256:string}): ReviewReceipt {
    if (!ID.test(input.workspaceId) || !Number.isSafeInteger(input.eventId) || input.eventId <= 0 ||
        !["APPROVED","REWORK","BLOCKED"].includes(input.decision) || !SHA.test(input.evidenceSha256))
      throw new TypeError("COACH_REVIEW_INVALID_INPUT");
    return this.db.transaction(() => {
      const original = this.db.prepare("SELECT evidence_sha256 FROM coach_review_events WHERE event_id=? AND workspace_id=?")
        .get(input.eventId,input.workspaceId) as {evidence_sha256:string}|undefined;
      if (!original || original.evidence_sha256 !== input.evidenceSha256)
        throw new Error("COACH_REVIEW_EVIDENCE_MISMATCH");
      // Two-way mutual exclusion: an archived historical event can never acquire
      // a normal authoritative decision afterwards (or race past it).
      const archived = this.db.prepare("SELECT 1 AS archived FROM coach_historical_reviews WHERE event_id=?")
        .get(input.eventId) as {archived:number}|undefined;
      if (archived) throw new Error("COACH_REVIEW_HISTORICAL_ARCHIVED_CONFLICT");
      this.db.prepare("INSERT OR IGNORE INTO coach_review_decisions " +
        "(event_id,decision,evidence_sha256,reviewed_at) VALUES (?,?,?,?)")
        .run(input.eventId,input.decision,input.evidenceSha256,new Date().toISOString());
      const receipt = this.db.prepare("SELECT * FROM coach_review_decisions WHERE event_id=?")
        .get(input.eventId) as ReviewReceipt;
      if (receipt.decision !== input.decision || receipt.evidence_sha256 !== input.evidenceSha256)
        throw new Error("COACH_REVIEW_DECISION_CONFLICT");
      return receipt;
    }).immediate();
  }
  /** Read one archived historical review by exact event identity. */
  getHistoricalReview(workspaceId:string,eventId:number): HistoricalReviewReceipt|undefined {
    if(!ID.test(workspaceId)||!Number.isSafeInteger(eventId)||eventId<=0)
      throw new TypeError("COACH_HISTORICAL_REVIEW_INVALID_INPUT");
    return this.db.prepare("SELECT event_id,workspace_id,operation_id,decision,reason," +
      "evidence_sha256,frozen_fingerprint,current_fingerprint,current_fingerprint_algorithm," +
      "drift,reviewed_at,source " +
      "FROM coach_historical_reviews WHERE workspace_id=? AND event_id=?")
      .get(workspaceId,eventId) as HistoricalReviewReceipt|undefined;
  }
  /** Bounded historical audit query; archived events stay readable forever. */
  listHistoricalReviews(workspaceId:string,limit=50): HistoricalReviewReceipt[] {
    if(!ID.test(workspaceId)||!Number.isInteger(limit)||limit<1||limit>50)
      throw new TypeError("COACH_HISTORICAL_REVIEW_INVALID_INPUT");
    return this.db.prepare("SELECT event_id,workspace_id,operation_id,decision,reason," +
      "evidence_sha256,frozen_fingerprint,current_fingerprint,current_fingerprint_algorithm," +
      "drift,reviewed_at,source " +
      "FROM coach_historical_reviews WHERE workspace_id=? ORDER BY event_id DESC LIMIT ?")
      .all(workspaceId,limit) as HistoricalReviewReceipt[];
  }
  /**
   * Persist one historical archival decision. Identity/evidence must match the
   * immutable event row; one normal review and one historical review are
   * mutually exclusive. Identical replays are idempotent, any differing replay
   * is a conflict. This writes ONLY to coach_historical_reviews; it never
   * touches coach_review_decisions, evidence, tests, runs, or plans.
   */
  recordHistoricalReview(input: {
    workspaceId:string; operationId:string; eventId:number;
    decision:HistoricalDecision; reason:string; evidenceSha256:string;
    frozenFingerprint:string; currentFingerprint:string;
    currentFingerprintAlgorithm:string; drift:0|1; source:string;
  }): {receipt:HistoricalReviewReceipt; created:boolean} {
    const reasonOk = typeof input.reason==="string" && input.reason.length>=16 &&
      input.reason.length<=1200 && ![...input.reason].some(ch=>ch.charCodeAt(0)<32);
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||
       !Number.isSafeInteger(input.eventId)||input.eventId<=0||
       !["BLOCKED","REWORK_RECOMMENDED"].includes(input.decision)||!reasonOk||
       !SHA.test(input.evidenceSha256)||!SHA.test(input.frozenFingerprint)||
       !SHA.test(input.currentFingerprint)||
       !["full-snapshot-v1","git-coarse-v1"].includes(input.currentFingerprintAlgorithm)||
       (input.drift!==0&&input.drift!==1)||!ID.test(input.source))
      throw new TypeError("COACH_HISTORICAL_REVIEW_INVALID_INPUT");
    // Drift must be derived from the recorded values, never trusted blindly.
    if(input.drift !== (input.frozenFingerprint===input.currentFingerprint?0:1))
      throw new TypeError("COACH_HISTORICAL_REVIEW_INVALID_INPUT");
    return this.db.transaction(()=>{
      const event = this.db.prepare("SELECT operation_id,evidence_sha256 FROM coach_review_events " +
        "WHERE event_id=? AND workspace_id=?").get(input.eventId,input.workspaceId) as
        {operation_id:string;evidence_sha256:string}|undefined;
      if(!event) throw new Error("COACH_HISTORICAL_EVENT_NOT_FOUND");
      if(event.operation_id!==input.operationId) throw new Error("COACH_HISTORICAL_IDENTITY_MISMATCH");
      if(event.evidence_sha256!==input.evidenceSha256) throw new Error("COACH_HISTORICAL_EVIDENCE_MISMATCH");
      const normal = this.db.prepare("SELECT 1 AS reviewed FROM coach_review_decisions WHERE event_id=?")
        .get(input.eventId) as {reviewed:number}|undefined;
      if(normal) throw new Error("COACH_HISTORICAL_ALREADY_REVIEWED");
      const existing = this.getHistoricalReview(input.workspaceId,input.eventId);
      if(existing){
        // Idempotency is keyed to the archival inputs only. The current
        // fingerprint is a point-in-time observation and must not turn an
        // identical replay into a conflict after further workspace drift.
        const identical = existing.operation_id===input.operationId &&
          existing.decision===input.decision && existing.reason===input.reason &&
          existing.evidence_sha256===input.evidenceSha256 &&
          existing.frozen_fingerprint===input.frozenFingerprint &&
          existing.source===input.source;
        if(!identical) throw new Error("COACH_HISTORICAL_REVIEW_CONFLICT");
        return {receipt:existing,created:false};
      }
      this.db.prepare("INSERT INTO coach_historical_reviews " +
        "(event_id,workspace_id,operation_id,decision,reason,evidence_sha256," +
        "frozen_fingerprint,current_fingerprint,current_fingerprint_algorithm," +
        "drift,reviewed_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        input.eventId,input.workspaceId,input.operationId,input.decision,input.reason,
        input.evidenceSha256,input.frozenFingerprint,input.currentFingerprint,
        input.currentFingerprintAlgorithm,input.drift,new Date().toISOString(),input.source);
      return {receipt:this.getHistoricalReview(input.workspaceId,input.eventId)!,created:true};
    }).immediate();
  }
  listPending(workspaceId: string, limit=50): { pending_count:number; events:CoachEvent[] } {
    if (!ID.test(workspaceId) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("COACH_QUERY_INVALID_INPUT");
    // Archived historical reviews are terminal for delivery purposes: they must
    // never be pushed to a browser conversation again, but remain queryable via
    // listHistoricalReviews()/getHistoricalReview().
    const pending = "FROM coach_review_events e LEFT JOIN coach_review_decisions d " +
      "ON d.event_id=e.event_id LEFT JOIN coach_historical_reviews h ON h.event_id=e.event_id " +
      "LEFT JOIN coach_review_evidence p ON p.event_id=e.event_id " +
      "WHERE e.workspace_id=? AND d.event_id IS NULL AND h.event_id IS NULL AND "+COACH_DELIVERY_SQL;
    const count = this.db.prepare("SELECT count(*) AS n "+pending).get(workspaceId) as {n:number};
    const events = this.db.prepare("SELECT e.event_id,e.workspace_id,e.operation_id,e.event_type,e.created_at "+
      pending+" ORDER BY e.event_id LIMIT ?").all(workspaceId,limit) as CoachEvent[];
    return {pending_count:count.n,events:events.map(e=>{
      const packet=this.getEvidence(e.workspace_id,e.operation_id) as {task?:unknown;report?:unknown}|undefined;
      const event_type=completionDeliveryType(packet),report=safeReportOutcome(packet?.report);
      if(!event_type)throw new Error("COACH_DELIVERY_REPORT_INVALID");
      return {...e,event_type,...(report?{report}:{})};
    })};
  }
  hasInterruptedRun(workspaceId:string):boolean {
    if(!ID.test(workspaceId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    const row=this.db.prepare("SELECT 1 AS blocked FROM coach_agent_runs " +
      "WHERE workspace_id=? AND state=\'INTERRUPTED\' LIMIT 1")
      .get(workspaceId) as {blocked:number}|undefined;
    return Boolean(row);
  }
  listInterruptedRuns(workspaceId:string): DurableAgentRun[] {
    return this.db.prepare("SELECT workspace_id AS workspaceId,operation_id AS operationId,request_sha256 AS requestSha256,state,started_at AS startedAt,finished_at AS finishedAt,thread_id AS threadId,event_id AS eventId,reason FROM coach_agent_runs WHERE workspace_id=? AND state='INTERRUPTED' ORDER BY started_at").all(workspaceId) as DurableAgentRun[];
  }
  getGuardian(workspaceId:string, operationId:string): GuardianRecord | undefined {
    const row=this.db.prepare("SELECT guardian_marker AS marker,guardian_pid AS pid,guardian_pgid AS pgid,guardian_uid AS uid,guardian_lstart AS lstart FROM coach_agent_runs WHERE workspace_id=? AND operation_id=?").get(workspaceId,operationId) as GuardianRecord|undefined;
    return row?.marker && row.pid && row.pgid && row.uid !== undefined && row.lstart ? row : undefined;
  }
  recordGuardian(input:{workspaceId:string;operationId:string;identity:GuardianRecord}):void {
    const g=input.identity;
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||
       !/^devspace-guardian-[0-9a-f]{36}$/.test(g.marker)||
       !Number.isSafeInteger(g.pid)||g.pid<=1||g.pgid!==g.pid||
       !Number.isSafeInteger(g.uid)||g.uid<0||
       typeof g.lstart!=="string"||g.lstart.length<18||g.lstart.length>32)
      throw new TypeError("COACH_GUARDIAN_INVALID_IDENTITY");
    const result=this.db.prepare("UPDATE coach_agent_runs SET guardian_marker=?,guardian_pid=?,guardian_pgid=?,guardian_uid=?,guardian_lstart=? WHERE workspace_id=? AND operation_id=? AND state='RUNNING' AND guardian_marker IS NULL")
      .run(g.marker,g.pid,g.pgid,g.uid,g.lstart,input.workspaceId,input.operationId);
    if(result.changes!==1)throw new Error("COACH_GUARDIAN_IDENTITY_ALREADY_RECORDED_OR_NOT_RUNNING");
  }
  clearInterruptedRun(input:{workspaceId:string;operationId:string;explanation:string}):DurableAgentRun {
    return this.db.transaction(()=>{
      const row=this.getAgentRun(input.workspaceId,input.operationId);
      if(!row || row.state!=="INTERRUPTED") throw new Error("COACH_QUARANTINE_NOT_CLEARABLE");
      this.db.prepare("UPDATE coach_agent_runs SET state='CLEARED',finished_at=?,reason=? WHERE workspace_id=? AND operation_id=? AND state='INTERRUPTED'").run(new Date().toISOString(),input.explanation.slice(0,160),input.workspaceId,input.operationId);
      this.db.prepare("INSERT INTO coach_agent_quarantine_audit(workspace_id,operation_id,action,explanation,created_at) VALUES (?,?, 'CLEAR',?,?)").run(input.workspaceId,input.operationId,input.explanation.slice(0,160),new Date().toISOString());
      return this.getAgentRun(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  getWorkerLease():WorkerLease|undefined {
    const row=this.db.prepare("SELECT worker_id AS workerId,generation,pid,uid,lstart,heartbeat_at AS heartbeatAt FROM codex_worker_lease WHERE singleton=1").get() as WorkerLease|undefined;
    return row;
  }
  acquireWorkerLease(input:{workerId:string;pid:number;uid:number;lstart:string;previousOwnerProvenDead:boolean}):WorkerLease {
    if(!ID.test(input.workerId)||!Number.isSafeInteger(input.pid)||input.pid<=1||!Number.isSafeInteger(input.uid)||input.uid<0||input.lstart.length<18||input.lstart.length>32)
      throw new TypeError("COACH_WORKER_LEASE_INVALID");
    return this.db.transaction(()=>{
      const old=this.getWorkerLease();
      if(old&&!input.previousOwnerProvenDead)throw new Error("COACH_WORKER_LEASE_OWNER_UNCERTAIN");
      const saved=this.db.prepare("SELECT generation FROM codex_worker_generation WHERE singleton=1").get() as {generation:number}|undefined;
      const generation=Math.max(saved?.generation??0,old?.generation??0)+1,heartbeatAt=new Date().toISOString();
      this.db.prepare("INSERT INTO codex_worker_generation(singleton,generation) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation").run(generation);
      this.db.prepare("INSERT INTO codex_worker_lease(singleton,worker_id,generation,pid,uid,lstart,heartbeat_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET worker_id=excluded.worker_id,generation=excluded.generation,pid=excluded.pid,uid=excluded.uid,lstart=excluded.lstart,heartbeat_at=excluded.heartbeat_at")
        .run(input.workerId,generation,input.pid,input.uid,input.lstart,heartbeatAt);
      return {workerId:input.workerId,generation,pid:input.pid,uid:input.uid,lstart:input.lstart,heartbeatAt};
    }).immediate();
  }
  heartbeatWorkerLease(input:{workerId:string;generation:number}):boolean {
    const result=this.db.prepare("UPDATE codex_worker_lease SET heartbeat_at=? WHERE singleton=1 AND worker_id=? AND generation=?").run(new Date().toISOString(),input.workerId,input.generation);
    return result.changes===1;
  }
  releaseWorkerLease(input:{workerId:string;generation:number}):boolean {
    return this.db.prepare("DELETE FROM codex_worker_lease WHERE singleton=1 AND worker_id=? AND generation=?").run(input.workerId,input.generation).changes===1;
  }
  listRunningAgentRuns():DurableAgentRun[] {
    return this.db.prepare("SELECT workspace_id AS workspaceId,operation_id AS operationId,request_sha256 AS requestSha256,state,started_at AS startedAt,finished_at AS finishedAt,thread_id AS threadId,event_id AS eventId,reason,worker_id AS workerId,worker_generation AS workerGeneration,lease_owner AS leaseOwner,lease_heartbeat_at AS leaseHeartbeatAt,event_cursor AS eventCursor FROM coach_agent_runs WHERE state='RUNNING' ORDER BY started_at").all() as DurableAgentRun[];
  }
  activeAgentOperationsForWorkspace(workspaceId:string):string[] {
    if(!ID.test(workspaceId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    return (this.db.prepare("SELECT operation_id FROM coach_agent_runs WHERE workspace_id=? AND state='RUNNING' ORDER BY started_at")
      .all(workspaceId) as {operation_id:string}[]).map(row=>row.operation_id);
  }
  markAgentRunInterrupted(input:{workspaceId:string;operationId:string;reason:string}):boolean {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    return this.db.prepare("UPDATE coach_agent_runs SET state='INTERRUPTED',finished_at=?,reason=? WHERE workspace_id=? AND operation_id=? AND state='RUNNING'").run(new Date().toISOString(),input.reason.slice(0,160),input.workspaceId,input.operationId).changes===1;
  }
  heartbeatAgentRun(input:{workspaceId:string;operationId:string;workerId:string;generation:number;eventCursor?:number}):boolean {
    const result=this.db.prepare("UPDATE coach_agent_runs SET lease_heartbeat_at=?,event_cursor=max(event_cursor,?) WHERE workspace_id=? AND operation_id=? AND state='RUNNING' AND worker_id=? AND worker_generation=? AND EXISTS(SELECT 1 FROM codex_worker_lease WHERE singleton=1 AND worker_id=? AND generation=?)")
      .run(new Date().toISOString(),input.eventCursor??0,input.workspaceId,input.operationId,input.workerId,input.generation,input.workerId,input.generation);
    return result.changes===1;
  }
  /** Durable claim: a request ID is never automatically replayed after restart. */
  claimAgentRun(input:{workspaceId:string;operationId:string;requestSha256:string;workerId?:string;generation?:number}):DurableAgentRun {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||!SHA.test(input.requestSha256))
      throw new TypeError("COACH_AGENT_RUN_INVALID");
    return this.db.transaction(()=>{
      if(input.workerId!==undefined||input.generation!==undefined){
        if(!input.workerId||!Number.isSafeInteger(input.generation))throw new TypeError("COACH_WORKER_FENCE_INVALID");
        const lease=this.getWorkerLease();
        if(!lease||lease.workerId!==input.workerId||lease.generation!==input.generation)throw new Error("COACH_WORKER_FENCED");
      }
      const existing=this.getAgentRun(input.workspaceId,input.operationId);
      if(existing){
        if(existing.requestSha256!==input.requestSha256)throw new Error("COACH_AGENT_RUN_IDENTITY_CONFLICT");
        throw new Error("COACH_AGENT_RUN_ALREADY_RECORDED_NO_REPLAY");
      }
      this.db.prepare("INSERT INTO coach_agent_runs " +
        "(workspace_id,operation_id,request_sha256,state,started_at,worker_id,worker_generation,lease_owner,lease_heartbeat_at,event_cursor) VALUES (?,?,?,\'RUNNING\',?,?,?,?,?,0)")
        .run(input.workspaceId,input.operationId,input.requestSha256,new Date().toISOString(),input.workerId??null,input.generation??null,input.workerId??null,input.workerId?new Date().toISOString():null);
      return this.getAgentRun(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  finishAgentRun(input:{workspaceId:string;operationId:string;state:"COMPLETED"|"FAILED"|"STOPPED";threadId?:string;eventId?:number;reason?:string;reviewRecommendation?:{decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string};workerId?:string;generation?:number}):DurableAgentRun {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    if(input.state==="COMPLETED" && (!Number.isSafeInteger(input.eventId)||!input.eventId))
      throw new Error("COACH_AGENT_COMPLETION_EVENT_REQUIRED");
    if(input.reviewRecommendation&&(!["APPROVED","REWORK","BLOCKED"].includes(input.reviewRecommendation.decision)||input.reviewRecommendation.reason.length<3||input.reviewRecommendation.reason.length>350||/[\u0000-\u001f]/.test(input.reviewRecommendation.reason)||input.state!=="COMPLETED"))
      throw new Error("COACH_REVIEW_RECOMMENDATION_INVALID");
    return this.db.transaction(()=>{
      const current=this.getAgentRun(input.workspaceId,input.operationId);
      if(!current || current.state!=="RUNNING")throw new Error("COACH_AGENT_RUN_NOT_ACTIVE");
      if(input.state==="COMPLETED"){
        const completed=this.db.prepare("SELECT event_id FROM coach_review_events " +
          "WHERE event_id=? AND workspace_id=? AND operation_id=?").get(input.eventId,input.workspaceId,input.operationId);
        if(!completed)throw new Error("COACH_AGENT_COMPLETION_UNVERIFIED");
      }
      if(input.workerId!==undefined||input.generation!==undefined){
        const lease=this.getWorkerLease();
        if(!lease||lease.workerId!==input.workerId||lease.generation!==input.generation)throw new Error("COACH_WORKER_FENCED");
      }
      this.db.prepare("UPDATE coach_agent_runs SET state=?,finished_at=?,thread_id=?,event_id=?,reason=? " +
        "WHERE workspace_id=? AND operation_id=? AND state=\'RUNNING\' AND (? IS NULL OR (worker_id=? AND worker_generation=?))")
        .run(input.state,new Date().toISOString(),input.threadId??null,input.eventId??null,
          (input.reason??"").slice(0,160),input.workspaceId,input.operationId,input.workerId??null,input.workerId??null,input.generation??null);
      if(input.reviewRecommendation){
        const existing=this.getReviewRecommendation(input.workspaceId,input.operationId);
        if(existing&&(existing.decision!==input.reviewRecommendation.decision||existing.reason!==input.reviewRecommendation.reason))
          throw new Error("COACH_REVIEW_RECOMMENDATION_CONFLICT");
        this.db.prepare("INSERT OR IGNORE INTO coach_worker_review_recommendations(workspace_id,operation_id,decision,reason,created_at) VALUES (?,?,?,?,?)")
          .run(input.workspaceId,input.operationId,input.reviewRecommendation.decision,input.reviewRecommendation.reason,new Date().toISOString());
      }
      return this.getAgentRun(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  getReviewRecommendation(workspaceId:string,operationId:string):{decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string}|undefined {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    const row=this.db.prepare("SELECT r.decision,r.reason FROM coach_worker_review_recommendations r JOIN coach_agent_runs a USING(workspace_id,operation_id) WHERE r.workspace_id=? AND r.operation_id=? AND a.state='COMPLETED'")
      .get(workspaceId,operationId) as {decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string}|undefined;
    return row?{...row}:undefined;
  }
  saveCoachFeedConfig(input:{workspaceId:string;workspaceRoot:string;port:number;pairedExtensionId?:string;observeAllNativeAgents:boolean;authorizedWorkspaceIds?:string[]}):void {
    const ids=input.authorizedWorkspaceIds??[input.workspaceId];
    if(!ID.test(input.workspaceId)||!input.workspaceRoot||!Number.isSafeInteger(input.port)||input.port<1||input.port>65535||
      (input.pairedExtensionId!==undefined&&!/^[a-p]{32}$/.test(input.pairedExtensionId))||
      (input.observeAllNativeAgents&&!input.pairedExtensionId)||
      ids.length<1||ids.length>8||new Set(ids).size!==ids.length||
      !ids.includes(input.workspaceId)||ids.some(id=>!ID.test(id)))
      throw new Error("COACH_FEED_CONFIG_INVALID");
    this.db.transaction(()=>{
      this.db.prepare("INSERT INTO coach_feed_config(singleton,workspace_id,workspace_root,port,paired_extension_id,observe_all_native_agents,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET workspace_id=excluded.workspace_id,workspace_root=excluded.workspace_root,port=excluded.port,paired_extension_id=excluded.paired_extension_id,observe_all_native_agents=excluded.observe_all_native_agents,updated_at=excluded.updated_at")
        .run(input.workspaceId,input.workspaceRoot,input.port,input.pairedExtensionId??null,input.observeAllNativeAgents?1:0,new Date().toISOString());
      this.db.prepare("DELETE FROM coach_feed_authorized_workspaces").run();
      const insert=this.db.prepare("INSERT INTO coach_feed_authorized_workspaces(workspace_id) VALUES(?)");
      for(const id of ids)insert.run(id);
    }).immediate();
  }
  coachFeedConfig():{workspaceId:string;workspaceRoot:string;port:number;pairedExtensionId?:string;observeAllNativeAgents:boolean;authorizedWorkspaceIds:string[]}|undefined {
    const row=this.db.prepare("SELECT workspace_id AS workspaceId,workspace_root AS workspaceRoot,port,paired_extension_id AS pairedExtensionId,observe_all_native_agents AS observeAllNativeAgents FROM coach_feed_config WHERE singleton=1")
      .get() as {workspaceId:string;workspaceRoot:string;port:number;pairedExtensionId:string|null;observeAllNativeAgents:number}|undefined;
    if(!row)return undefined;
    const ids=(this.db.prepare("SELECT workspace_id FROM coach_feed_authorized_workspaces ORDER BY workspace_id")
      .all() as {workspace_id:string}[]).map(x=>x.workspace_id);
    return {workspaceId:row.workspaceId,workspaceRoot:row.workspaceRoot,port:row.port,
      ...(row.pairedExtensionId?{pairedExtensionId:row.pairedExtensionId}:{}),
      observeAllNativeAgents:row.observeAllNativeAgents===1,
      authorizedWorkspaceIds:ids.length?ids:[row.workspaceId]};
  }
  clearCoachFeedConfig():void {
    this.db.transaction(()=>{
      this.db.prepare("DELETE FROM coach_feed_config WHERE singleton=1").run();
      this.db.prepare("DELETE FROM coach_feed_authorized_workspaces").run();
    }).immediate();
  }
  coachFeedWorkspaceIdsForRoot(root:string):string[] {
    const row=this.coachFeedConfig();return row?.workspaceRoot===root?[row.workspaceId]:[];
  }
  getAgentRun(workspaceId:string,operationId:string):DurableAgentRun|undefined {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    return this.db.prepare("SELECT workspace_id AS workspaceId,operation_id AS operationId," +
      "request_sha256 AS requestSha256,state,started_at AS startedAt,finished_at AS finishedAt," +
      "thread_id AS threadId,event_id AS eventId,reason " +
      ",worker_id AS workerId,worker_generation AS workerGeneration,lease_owner AS leaseOwner,lease_heartbeat_at AS leaseHeartbeatAt,event_cursor AS eventCursor " +
      "FROM coach_agent_runs WHERE workspace_id=? AND operation_id=?")
      .get(workspaceId,operationId) as DurableAgentRun|undefined;
  }
  /** Called once at controlled service boot. Never restarts or kills an unknown PID. */
  reconcileInterruptedRuns():{interrupted:number;completed:number} {
    return this.db.transaction(()=>{
      const pending=this.db.prepare("SELECT workspace_id,operation_id FROM coach_agent_runs " +
        "WHERE state=\'RUNNING\'").all() as {workspace_id:string;operation_id:string}[];
      let interrupted=0,completed=0;
      for(const row of pending){
        const ev=this.db.prepare("SELECT e.event_id FROM coach_review_events e " +
          "JOIN coach_review_evidence p ON p.event_id=e.event_id " +
          "WHERE e.workspace_id=? AND e.operation_id=?")
          .get(row.workspace_id,row.operation_id) as {event_id:number}|undefined;
        let verified=false;
        if(ev){
          try { verified=Boolean(this.getEvidence(row.workspace_id,row.operation_id)); }
          catch { /* Corrupt or missing proof never establishes completion. */ }
        }
        const state=verified?"COMPLETED":"INTERRUPTED";
        this.db.prepare("UPDATE coach_agent_runs SET state=?,finished_at=?,event_id=?,reason=? " +
          "WHERE workspace_id=? AND operation_id=? AND state=\'RUNNING\'")
          .run(state,new Date().toISOString(),verified?ev?.event_id??null:null,
            verified?"completion_evidence_recovered":"unknown_outcome_no_automatic_replay",
            row.workspace_id,row.operation_id);
        if(verified)completed++;else interrupted++;
      }
      return {interrupted,completed};
    }).immediate();
  }
  close():void {this.db.close();}

  /** Only the successful browser challenge + MCP claim path calls this. It
   * grants delivery, never execution or review under a different workspace. */
  recordBrowserRouteClaim(workspaceId:string,nonce:string,url:string):void {
    if(!ID.test(workspaceId)||!/^[a-f0-9]{32}$/.test(nonce)||
       !/^https:\/\/chatgpt\.com\/(?:g\/[^/?#]+\/)?c\/[A-Za-z0-9_-]{8,128}$/.test(url))
      throw new Error("COACH_DELIVERY_ROUTE_INVALID");
    this.db.prepare("INSERT INTO coach_browser_route_claims VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET nonce=excluded.nonce,url=excluded.url,claimed_at=excluded.claimed_at")
      .run(workspaceId,nonce,url,new Date().toISOString());
  }
  browserRouteClaim(workspaceId:string):{nonce:string;url:string}|undefined {
    return this.db.prepare("SELECT nonce,url FROM coach_browser_route_claims WHERE workspace_id=?").get(workspaceId) as {nonce:string;url:string}|undefined;
  }
  assertDeliveryRoute(delivery:{workspaceId:string;nonce:string}):void {
    if(!delivery||!ID.test(delivery.workspaceId)||!/^[a-f0-9]{32}$/.test(delivery.nonce)||
       this.browserRouteClaim(delivery.workspaceId)?.nonce!==delivery.nonce)
      throw new Error("COACH_DELIVERY_ROUTE_NOT_CLAIMED");
  }
  recordWebGptTurnAck(input:{workspaceId:string;operationId:string;eventId:number;evidenceSha256:string}):unknown {
    const packet=this.getEvidenceByEvent(input.workspaceId,input.eventId) as
      {operationId:string;evidenceSha256:string;delivery?:{workspaceId:string;nonce:string}}|undefined;
    if(!packet?.delivery||packet.operationId!==input.operationId||packet.evidenceSha256!==input.evidenceSha256)
      throw new Error("COACH_TURN_ACK_SCOPE_MISMATCH");
    this.assertDeliveryRoute(packet.delivery);
    this.db.prepare("INSERT OR IGNORE INTO coach_webgpt_turn_acks VALUES(?,?,?,?,?,?)")
      .run(input.eventId,input.workspaceId,input.operationId,input.evidenceSha256,packet.delivery.workspaceId,new Date().toISOString());
    return this.webGptTurnAck(input.workspaceId,input.eventId);
  }
  webGptTurnAck(workspaceId:string,eventId:number):unknown {
    return this.db.prepare("SELECT * FROM coach_webgpt_turn_acks WHERE workspace_id=? AND event_id=?").get(workspaceId,eventId);
  }
}
