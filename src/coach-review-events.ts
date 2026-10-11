/** Native DevSpace coach event store; no project-local experiment DB. */
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isPathInsideRoot } from "./roots.js";
const FILE = "coach-review-events.sqlite";
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Decision = "APPROVED" | "REWORK" | "BLOCKED";
export interface VerifiedTest { event_id: number; workspace_id: string; task_id: string; session_id: string; tested_fingerprint: string; output_sha256: string; created_at: string; }
export interface CoachEvent {
  event_id: number;
  workspace_id: string;
  operation_id: string;
  event_type: "READY_FOR_GPT_REVIEW";
  created_at: string;
}
export type AgentRunState = "RUNNING"|"COMPLETED"|"FAILED"|"STOPPED"|"INTERRUPTED"|"CLEARED";
export interface GuardianRecord { marker:string; pid:number; pgid:number; uid:number; lstart:string; }
export interface DurableAgentRun {
  workspaceId:string;operationId:string;requestSha256:string;state:AgentRunState;
  startedAt:string;finishedAt:string|null;threadId:string|null;
  eventId:number|null;reason:string|null;
}
export interface ReviewReceipt {
  event_id: number;
  decision: Decision;
  evidence_sha256: string;
  reviewed_at: string;
}
export class CoachReviewEventStore {
  readonly path: string;
  private readonly db: Database.Database;
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
    if (current > 4) {
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
        "guardian_uid","guardian_lstart"];
      if(!schema.sql.includes("'CLEARED'")) {
        const columns=["workspace_id","operation_id","request_sha256","state",
          "started_at","finished_at","thread_id","event_id","reason",...newColumns];
        const select=columns.map(name=>fields.has(name)?name:"NULL").join(",");
        this.db.exec(
          "ALTER TABLE coach_agent_runs RENAME TO coach_agent_runs_v3_archive;" +
          "CREATE TABLE coach_agent_runs (" +
          "workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_sha256 TEXT NOT NULL," +
          "state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETED','FAILED','STOPPED','INTERRUPTED','CLEARED'))," +
          "started_at TEXT NOT NULL, finished_at TEXT, thread_id TEXT, event_id INTEGER, reason TEXT," +
          "guardian_marker TEXT, guardian_pid INTEGER, guardian_pgid INTEGER, guardian_uid INTEGER, guardian_lstart TEXT," +
          "PRIMARY KEY(workspace_id,operation_id));" +
          "INSERT INTO coach_agent_runs ("+columns.join(",")+") SELECT "+
            select+" FROM coach_agent_runs_v3_archive;" +
          "DROP TABLE coach_agent_runs_v3_archive;"
        );
      } else {
        for(const name of newColumns) {
          if(!fields.has(name))
            this.db.exec(`ALTER TABLE coach_agent_runs ADD COLUMN ${name} ${name.includes("pid")||name==="guardian_uid"?"INTEGER":"TEXT"}`);
        }
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS coach_agent_quarantine_audit (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id, operation_id, action));");
      this.db.pragma("user_version = 4");
    }).immediate();
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
  /** Atomically persist a trusted Runner evidence packet and its completion event. */
  recordCompletedWithEvidence(input: {workspaceId:string;operationId:string;evidenceSha256:string;packetJson:string}): CoachEvent {
    if (typeof input.packetJson !== "string" || Buffer.byteLength(input.packetJson,"utf8") > 65536)
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
    return this.db.transaction(()=>{
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
  listPending(workspaceId: string, limit=50): { pending_count:number; events:CoachEvent[] } {
    if (!ID.test(workspaceId) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("COACH_QUERY_INVALID_INPUT");
    const pending = "FROM coach_review_events e LEFT JOIN coach_review_decisions d " +
      "ON d.event_id=e.event_id WHERE e.workspace_id=? AND d.event_id IS NULL";
    const count = this.db.prepare("SELECT count(*) AS n "+pending).get(workspaceId) as {n:number};
    const events = this.db.prepare("SELECT e.event_id,e.workspace_id,e.operation_id,e.event_type,e.created_at "+
      pending+" ORDER BY e.event_id LIMIT ?").all(workspaceId,limit) as CoachEvent[];
    return {pending_count:count.n,events};
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
  /** Durable claim: a request ID is never automatically replayed after restart. */
  claimAgentRun(input:{workspaceId:string;operationId:string;requestSha256:string}):DurableAgentRun {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId)||!SHA.test(input.requestSha256))
      throw new TypeError("COACH_AGENT_RUN_INVALID");
    return this.db.transaction(()=>{
      const existing=this.getAgentRun(input.workspaceId,input.operationId);
      if(existing){
        if(existing.requestSha256!==input.requestSha256)throw new Error("COACH_AGENT_RUN_IDENTITY_CONFLICT");
        throw new Error("COACH_AGENT_RUN_ALREADY_RECORDED_NO_REPLAY");
      }
      this.db.prepare("INSERT INTO coach_agent_runs " +
        "(workspace_id,operation_id,request_sha256,state,started_at) VALUES (?,?,?,\'RUNNING\',?)")
        .run(input.workspaceId,input.operationId,input.requestSha256,new Date().toISOString());
      return this.getAgentRun(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  finishAgentRun(input:{workspaceId:string;operationId:string;state:"COMPLETED"|"FAILED"|"STOPPED";threadId?:string;eventId?:number;reason?:string}):DurableAgentRun {
    if(!ID.test(input.workspaceId)||!ID.test(input.operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    if(input.state==="COMPLETED" && (!Number.isSafeInteger(input.eventId)||!input.eventId))
      throw new Error("COACH_AGENT_COMPLETION_EVENT_REQUIRED");
    return this.db.transaction(()=>{
      const current=this.getAgentRun(input.workspaceId,input.operationId);
      if(!current || current.state!=="RUNNING")throw new Error("COACH_AGENT_RUN_NOT_ACTIVE");
      if(input.state==="COMPLETED"){
        const completed=this.db.prepare("SELECT event_id FROM coach_review_events " +
          "WHERE event_id=? AND workspace_id=? AND operation_id=?").get(input.eventId,input.workspaceId,input.operationId);
        if(!completed)throw new Error("COACH_AGENT_COMPLETION_UNVERIFIED");
      }
      this.db.prepare("UPDATE coach_agent_runs SET state=?,finished_at=?,thread_id=?,event_id=?,reason=? " +
        "WHERE workspace_id=? AND operation_id=? AND state=\'RUNNING\'")
        .run(input.state,new Date().toISOString(),input.threadId??null,input.eventId??null,
          (input.reason??"").slice(0,160),input.workspaceId,input.operationId);
      return this.getAgentRun(input.workspaceId,input.operationId)!;
    }).immediate();
  }
  getAgentRun(workspaceId:string,operationId:string):DurableAgentRun|undefined {
    if(!ID.test(workspaceId)||!ID.test(operationId))throw new TypeError("COACH_AGENT_RUN_INVALID");
    return this.db.prepare("SELECT workspace_id AS workspaceId,operation_id AS operationId," +
      "request_sha256 AS requestSha256,state,started_at AS startedAt,finished_at AS finishedAt," +
      "thread_id AS threadId,event_id AS eventId,reason " +
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
}
