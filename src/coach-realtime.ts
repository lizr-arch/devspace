import { verifyTask, taskFailure, type TaskReference } from "./coach-task-contract.js";
import type { ReportOutcome } from "./coach-result-contract.js";
/** COACH-REALTIME-001: opt-in event-driven, crash-conservative local reviewer.
 * No web-GPT background presence is assumed. No silent model fallback.
 * An AI verdict is never sufficient for APPROVED: independently preapproved
 * deterministic tests and the signed evidence fingerprint remain mandatory.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {checkManifestIntegrity} from "./task-manifest.js";
import { CoachReviewGate } from "./coach-review-gate.js";
import type { CoachReviewEventStore } from "./coach-review-events.js";
import type { RunnerInput, RunnerStatus } from "./codex-agent-runner.js";
import type { CodexAgentControl } from "./codex-agent-control.js";
import { captureCodexFingerprint } from "./codex-agent-runner.js";
import type { TaskRunner } from "./task-runner.js";
import { validateCodexSelection, type CodexModel, type CodexEffort } from "./coach-model-policy.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
function sameTask(a:TaskReference|undefined,b:TaskReference|undefined){return !!a && !!b && a.workspaceId===b.workspaceId && a.taskId===b.taskId && a.taskPath===b.taskPath && a.version===b.version && a.sha256===b.sha256;}
type Phase="ACTIVE"|"AWAITING_WEBGPT"|"REVIEWING"|"DISPATCHING"|"DONE"|"BLOCKED"|"PAUSED";
export interface CoachRealtimeStage {
  prompt:string;
  task?:TaskReference;
  stageId?:string;
  testTaskId:string;
  model:CodexModel;
  reasoningEffort:CodexEffort;
  sandbox:"workspace-write"|"read-only";
}
export interface CoachRealtimeSpec {
  planId:string;
  workspaceId:string;
  /** The initial operation must already be running in the approved workspace. */
  initialOperationId:string;
  reviewerModel:CodexModel;
  reviewerEffort:CodexEffort;
  maxReworks:number;
  maxContinuations?:number;
  /** Original local reviewer remains default. */
  reviewerMode?:"local"|"webgpt";
  stages:CoachRealtimeStage[];
  /** Server-pinned approval, never accepted from the caller. */
  approvedManifestSha256?:string;
}
export interface CoachRealtimePlan {
  planId:string;workspaceId:string;workspaceRoot:string;
  spec:CoachRealtimeSpec;currentOperationId:string;
  phase:Phase;stageIndex:number;reworkCount:number;
  lastError:string|null;updatedAt:string;
}
export interface RealtimeReviewRecommendation {
  decision:"APPROVED"|"REWORK"|"BLOCKED";reason:string;
}
export interface RealtimeDependencies {
  events:CoachReviewEventStore;
  tasks:TaskRunner;
  runner:()=>CodexAgentControl;
  workspaces:Pick<WorkspaceRegistry,"getWorkspace">;
  /** Test-only: never select a different model or fabricate an APPROVED. */
  review?: (input:{
    plan:CoachRealtimePlan; eventId:number; packet:Record<string,unknown>;
    operationId:string;
  })=>Promise<RealtimeReviewRecommendation>;
  gate?:Pick<CoachReviewGate,"verifyTest"|"submit">;
  /** Test only; production cadence is 5s fallback, completion subscription immediate. */
  recoveryIntervalMs?:number;
}
export class CoachRealtimeEngine {
  private readonly db:Database.Database;
  private readonly busy=new Set<string>();
  private readonly pending=new Set<Promise<void>>();
  private readonly gate:Pick<CoachReviewGate,"verifyTest"|"submit">;
  private readonly unsub:()=>void;
  private readonly timer:NodeJS.Timeout;
  private closing=false;
  constructor(stateDir:string,private readonly d:RealtimeDependencies) {
    this.db=new Database(join(realpathSync(stateDir),"coach-realtime.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS realtime_plans("+
      "plan_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root TEXT NOT NULL,"+
      "spec_json TEXT NOT NULL, current_operation TEXT NOT NULL,"+
      "phase TEXT NOT NULL, stage_idx INTEGER NOT NULL, rework_count INTEGER NOT NULL,"+
      "last_error TEXT, updated_at TEXT NOT NULL);"+
      "CREATE INDEX IF NOT EXISTS realtime_active_ws ON realtime_plans(workspace_id,phase);"+
      "CREATE TABLE IF NOT EXISTS realtime_web_feedback("+
      "plan_id TEXT NOT NULL,event_id INTEGER NOT NULL,operation_id TEXT NOT NULL,"+
      "decision TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,"+
      "PRIMARY KEY(plan_id,event_id));");
    this.db.exec("CREATE TABLE IF NOT EXISTS realtime_continuations(plan_id TEXT NOT NULL,stage_idx INTEGER NOT NULL,parent_operation TEXT NOT NULL,child_operation TEXT NOT NULL,PRIMARY KEY(plan_id,parent_operation));");
    this.gate=d.gate??new CoachReviewGate({events:d.events,tasks:d.tasks});
    this.unsub=d.events.onCompleted(event=> {
      // The runner emits completion before it releases its resource lock.
      // Defer the review until after the finalization/lock release.
      if(!this.closing) {
        const timeout=setTimeout(()=>{
          if(!this.closing)this.wakeByOperation(event.workspaceId,event.operationId);
        },150);
        timeout.unref?.();
      }
    });
    this.timer=setInterval(()=>{void this.recover();},d.recoveryIntervalMs??5000);
    this.timer.unref?.();
    // Reconcile persisted plans after a new server boot. Never replay an
    // operation with unknown outcome or an interrupted guardian.
    queueMicrotask(()=>{void this.recover();});
  }
  private assertSpec(spec:CoachRealtimeSpec):void {
    if(!ID.test(spec.planId)||!ID.test(spec.workspaceId)||!ID.test(spec.initialOperationId)||
      !Number.isInteger(spec.maxReworks)||spec.maxReworks<0||spec.maxReworks>5||
      !Array.isArray(spec.stages)||spec.stages.length<1||spec.stages.length>8)
      throw new TypeError("COACH_REALTIME_INVALID_PLAN");
    if(spec.reviewerMode!==undefined && !["local","webgpt"].includes(spec.reviewerMode))
      throw new TypeError("COACH_REALTIME_INVALID_REVIEWER_MODE");
    validateCodexSelection({model:spec.reviewerModel,reasoningEffort:spec.reviewerEffort});
    if(spec.maxContinuations!==undefined && (!Number.isInteger(spec.maxContinuations)||spec.maxContinuations<0||spec.maxContinuations>3))throw new Error("COACH_INVALID_CONTINUATION_LIMIT");
    for(const stage of spec.stages) {
      validateCodexSelection(stage);
      if(!ID.test(stage.testTaskId)||!["workspace-write","read-only"].includes(stage.sandbox)||
        typeof stage.prompt!=="string"||stage.prompt.length>8000)
        throw new TypeError("COACH_REALTIME_INVALID_STAGE");
    }
  }
  async register(spec:CoachRealtimeSpec):Promise<CoachRealtimePlan> {
    this.assertSpec(spec);
    const ws=this.d.workspaces.getWorkspace(spec.workspaceId);
    // An unattended Web GPT plan can mutate files without a human click.
    // Never enroll an attached or dirty main checkout; only managed worktrees.
    if(spec.reviewerMode==="webgpt" &&
       (ws.mode!=="worktree" || ws.worktree?.managed!==true))
      throw new Error("COACH_WEBGPT_MANAGED_WORKTREE_REQUIRED");
    const root=realpathSync(ws.root);
    const existing=this.get(spec.planId);
    if(existing) {
      // On reconnect, the in-memory task approval may no longer be loaded.
      // An identical durable plan can be inspected without granting NEW access.
      const {approvedManifestSha256:_pinned,...original}=existing.spec;
      if(JSON.stringify(original)!==JSON.stringify(spec)||existing.workspaceRoot!==root)
        throw new Error("COACH_REALTIME_PLAN_ID_CONFLICT");
      return existing;
    }
    for(const stage of spec.stages)verifyTask(root,spec.workspaceId,stage.task);
    const initialStatus=await this.d.runner().status(spec.initialOperationId,spec.workspaceId);
    if(!sameTask(initialStatus.task,spec.stages[0].task)||initialStatus.stageId!==(spec.stages[0].stageId??"development"))
      taskFailure("TASK_INITIAL_BINDING_MISMATCH","initialOperationId","Initial operation must use the first stage frozen TASK and stage ID.");
    const first=this.d.events.getAgentRun(spec.workspaceId,spec.initialOperationId);
    if(!first||!["RUNNING","COMPLETED"].includes(first.state))
      throw new Error("COACH_REALTIME_INITIAL_OPERATION_NOT_ACTIVE_OR_VERIFIED");
    if(first.state==="COMPLETED" && !this.d.events.getEvidence(spec.workspaceId,spec.initialOperationId))
      throw new Error("COACH_REALTIME_INITIAL_EVIDENCE_MISSING");
    const manifest=ws.approvedTasks;
    if(!manifest)throw new Error("COACH_REALTIME_TASKS_NOT_APPROVED");
    for(const stage of spec.stages)
      if(!manifest.taskIds.includes(stage.testTaskId))
        throw new Error("COACH_REALTIME_TEST_TASK_NOT_APPROVED");
    if(!checkManifestIntegrity(root,manifest))
      throw new Error("COACH_REALTIME_TASK_MANIFEST_CHANGED");
    // Do not trust an arbitrary caller-supplied hash; pin the workspace's
    // current approved manifest only after validating its real bytes.
    const sealed={...spec,approvedManifestSha256:manifest.manifestSha256};
    if(this.all().length>=180)throw new Error("COACH_REALTIME_PLAN_CAPACITY");
    if(this.all().some(p=>p.workspaceId===spec.workspaceId &&
        ["ACTIVE","AWAITING_WEBGPT","REVIEWING","DISPATCHING"].includes(p.phase)))
      throw new Error("COACH_REALTIME_WORKSPACE_ALREADY_ENROLLED");
    // The approved task manifest bytes are sealed into the durable plan,
    // not merely held in the per-session in-memory approvedTasks cache.
    this.db.prepare("INSERT INTO realtime_plans VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      spec.planId,spec.workspaceId,root,JSON.stringify(sealed),spec.initialOperationId,
      "ACTIVE",0,0,null,new Date().toISOString());
    this.wake(spec.planId);
    return this.get(spec.planId)!;
  }
  get(planId:string):CoachRealtimePlan|undefined {
    if(!ID.test(planId))throw new TypeError("COACH_REALTIME_INVALID_PLAN_ID");
    const row=this.db.prepare("SELECT * FROM realtime_plans WHERE plan_id=?").get(planId) as
      {plan_id:string;workspace_id:string;root:string;spec_json:string;
       current_operation:string;phase:Phase;stage_idx:number;rework_count:number;
       last_error:string|null;updated_at:string}|undefined;
    return row?{planId:row.plan_id,workspaceId:row.workspace_id,workspaceRoot:row.root,
      spec:JSON.parse(row.spec_json) as CoachRealtimeSpec,currentOperationId:row.current_operation,
      phase:row.phase,stageIndex:row.stage_idx,reworkCount:row.rework_count,
      lastError:row.last_error,updatedAt:row.updated_at}:undefined;
  }
  all():CoachRealtimePlan[] {
    const rows=this.db.prepare("SELECT plan_id FROM realtime_plans ORDER BY updated_at DESC LIMIT 200").all() as Array<{plan_id:string}>;
    return rows.map(r=>this.get(r.plan_id)!);
  }
  pause(planId:string):CoachRealtimePlan {
    const row=this.get(planId);
    if(!row)throw new Error("COACH_REALTIME_PLAN_NOT_FOUND");
    if(row.phase==="ACTIVE"||row.phase==="AWAITING_WEBGPT")
      this.transition(row,"PAUSED","paused_by_user");
    // No process is stopped; a running reviewer is allowed to finish.
    else if(row.phase!=="PAUSED")throw new Error("COACH_REALTIME_CANNOT_PAUSE_DISPATCH");
    return this.get(planId)!;
  }
  resume(planId:string):CoachRealtimePlan {
    const row=this.get(planId);
    if(!row||row.phase!=="PAUSED")throw new Error("COACH_REALTIME_NOT_PAUSED");
    this.transition(row,"ACTIVE",null);
    this.wake(planId);
    return this.get(planId)!;
  }
  /** Atomic intent: record bounded human-readable Web GPT feedback before
   * submitting the cryptographically matched review receipt. Retry after a
   * crash is idempotent; no runner is dispatched by a bare conversational text. */
  async submitWebVerdict(input:{planId:string;workspaceId:string;operationId:string;
      eventId:number;decision:"APPROVED"|"REWORK"|"BLOCKED";evidenceSha256:string;
      reason:string}):Promise<CoachRealtimePlan>{
    const plan=this.get(input.planId);
    if(plan?.spec.reviewerMode==="webgpt" && plan.workspaceId===input.workspaceId){
      // Network retries of the same signed review are idempotent even after
      // the plan advanced to another stage. Different decisions never alias.
      const previous=this.db.prepare("SELECT operation_id,decision,reason FROM realtime_web_feedback WHERE plan_id=? AND event_id=?")
        .get(input.planId,input.eventId) as {operation_id:string;decision:string;reason:string}|undefined;
      const receipt=this.d.events.getReview(input.workspaceId,input.operationId);
      if(previous && receipt && previous.operation_id===input.operationId &&
         previous.decision===input.decision && previous.reason===input.reason &&
         receipt.event_id===input.eventId && receipt.decision===input.decision &&
         receipt.evidence_sha256===input.evidenceSha256)return plan;
    }
    if(!plan||plan.spec.reviewerMode!=="webgpt"||plan.workspaceId!==input.workspaceId||
       plan.currentOperationId!==input.operationId||plan.phase!=="AWAITING_WEBGPT")
      throw new Error("COACH_WEBGPT_NOT_AWAITING_VERDICT");
    if(!Number.isSafeInteger(input.eventId)||input.eventId<=0||
       !/^[a-f0-9]{64}$/.test(input.evidenceSha256)||
       !["APPROVED","REWORK","BLOCKED"].includes(input.decision)||
       typeof input.reason!=="string"||input.reason.trim().length<16||
       input.reason.length>1200||[...input.reason].some(ch=>ch.charCodeAt(0)<32))
      throw new Error("COACH_WEBGPT_INVALID_VERDICT");
    const event=this.d.events.getAgentRun(input.workspaceId,input.operationId);
    const packet=this.d.events.getEvidence(input.workspaceId,input.operationId) as
      {finalFingerprint?:string;evidenceSha256?:string}|undefined;
    if(event?.eventId!==input.eventId || packet?.evidenceSha256!==input.evidenceSha256)
      throw new Error("COACH_WEBGPT_EVIDENCE_MISMATCH");
    if((await captureCodexFingerprint(plan.workspaceRoot)).sha!==packet.finalFingerprint)
      throw new Error("COACH_WEBGPT_STALE_FINGERPRINT");
    if(input.decision==="APPROVED"){
      await this.gate.verifyTest({workspaceId:input.workspaceId,workspaceRoot:plan.workspaceRoot,
        eventId:input.eventId,taskId:plan.spec.stages[plan.stageIndex].testTaskId});
    }
    this.db.prepare("INSERT OR IGNORE INTO realtime_web_feedback VALUES(?,?,?,?,?,?)")
      .run(plan.planId,input.eventId,input.operationId,input.decision,input.reason,new Date().toISOString());
    const saved=this.db.prepare("SELECT operation_id,decision,reason FROM realtime_web_feedback WHERE plan_id=? AND event_id=?")
      .get(plan.planId,input.eventId) as {operation_id:string;decision:string;reason:string};
    if(saved.operation_id!==input.operationId||saved.decision!==input.decision||
       saved.reason!==input.reason)throw new Error("COACH_WEBGPT_FEEDBACK_CONFLICT");
    await this.gate.submit({workspaceId:input.workspaceId,workspaceRoot:plan.workspaceRoot,
      operationId:input.operationId,eventId:input.eventId,
      decision:input.decision,evidenceSha256:input.evidenceSha256});
    this.wake(plan.planId);
    return this.get(plan.planId)!;
  }

  private transition(plan:CoachRealtimePlan,phase:Phase,reason:string|null,
      currentOperation=plan.currentOperationId,stageIndex=plan.stageIndex,
      reworkCount=plan.reworkCount):void {
    const changed=this.db.prepare("UPDATE realtime_plans SET phase=?,last_error=?,current_operation=?,"+
      "stage_idx=?,rework_count=?,updated_at=? WHERE plan_id=? AND phase=? AND current_operation=?")
      .run(phase,reason?.slice(0,200)??null,currentOperation,stageIndex,reworkCount,
        new Date().toISOString(),plan.planId,plan.phase,plan.currentOperationId);
    if(changed.changes!==1)throw new Error("COACH_REALTIME_CONCURRENT_UPDATE");
  }
  private wakeByOperation(ws:string,op:string):void {
    for(const plan of this.all())if(plan.workspaceId===ws && plan.currentOperationId===op &&
      (plan.phase==="ACTIVE"||plan.phase==="AWAITING_WEBGPT"))this.wake(plan.planId);
  }
  wake(planId:string):void {
    if(this.closing||this.busy.has(planId))return;
    this.busy.add(planId);
    // Work runs outside the critical native event transaction.
    const pending=this.process(planId).catch(error=>{
      const plan=this.get(planId);
      if(!plan||this.closing)return;
      const reason=error instanceof Error?error.message:"unknown_error";
      if(/JOB_RESOURCE_BUSY|COACH_REVIEW_STALE_EVIDENCE/.test(reason)){
        // Lock races can outlive the journal by a fraction of a second.
        // Stale evidence is not transient: NEVER retry it.
        if(reason.includes("STALE_EVIDENCE"))this.transition(plan,"BLOCKED",reason);
        return;
      }
      if(plan.phase==="ACTIVE"||plan.phase==="AWAITING_WEBGPT"||plan.phase==="REVIEWING"||plan.phase==="DISPATCHING")
        this.transition(plan,"BLOCKED",reason);
    }).finally(()=>this.busy.delete(planId));
    this.pending.add(pending);
    void pending.then(()=>this.pending.delete(pending));
  }
  async recover():Promise<void>{
    if(this.closing)return;
    for(const plan of this.all()) {
      if(plan.phase==="ACTIVE"||plan.phase==="AWAITING_WEBGPT")this.wake(plan.planId);
      // A previously dispatched operation may be reconciled by its durable
      // identity. A missing/unknown child is BLOCKED, never launched twice.
      if(plan.phase==="DISPATCHING"&&!this.busy.has(plan.planId)){
        const child=this.d.events.getAgentRun(plan.workspaceId,plan.currentOperationId);
        if(child && ["RUNNING","COMPLETED"].includes(child.state)){
          this.transition(plan,"ACTIVE",null);
          this.wake(plan.planId);
        } else this.transition(plan,"BLOCKED","unknown_dispatch_outcome_requires_reconciliation");
      }
      if(plan.phase==="REVIEWING"&&!this.busy.has(plan.planId))
        this.transition(plan,"BLOCKED","unknown_review_outcome_after_restart");
    }
  }
  private async process(planId:string):Promise<void>{
    const p=this.get(planId);
    if(!p||(p.phase!=="ACTIVE"&&p.phase!=="AWAITING_WEBGPT"))return;
    const run=this.d.events.getAgentRun(p.workspaceId,p.currentOperationId);
    if(!run||run.state==="RUNNING")return;
    if(run.state!=="COMPLETED"||!run.eventId){
      this.transition(p,"BLOCKED","agent_"+(run?.state??"missing")+"_requires_review");
      return;
    }
    if(!p.spec.approvedManifestSha256 || !checkManifestIntegrity(p.workspaceRoot,{
      manifestSha256:p.spec.approvedManifestSha256,
      taskIds:p.spec.stages.map(s=>s.testTaskId),
    })){
      this.transition(p,"BLOCKED","approved_task_manifest_changed");return;
    }
    const packet=this.d.events.getEvidence(p.workspaceId,p.currentOperationId) as Record<string,unknown>|undefined;
    if(!packet||packet.evidenceSha256===undefined || packet.operationId!==p.currentOperationId ||
       packet.workspaceId!==p.workspaceId|| packet.threadId!==run.threadId)
      {this.transition(p,"BLOCKED","immutable_evidence_invalid");return;}
    const stage=p.spec.stages[p.stageIndex];
    // Historical completed reviews remain readable; no new legacy-prompt child may run.
    if(stage.task){
      verifyTask(p.workspaceRoot,p.workspaceId,stage.task);
      if(!sameTask(packet.task as TaskReference|undefined,stage.task)||packet.stageId!==(stage.stageId??"development"))
        taskFailure("TASK_STAGE_BINDING_MISMATCH","task","Completion differs from registered authority.");
      const report=packet.report as ReportOutcome|undefined;
      if(!report?.valid || report.status==="IN_PROGRESS"){
        if(this.d.events.getReview(p.workspaceId,p.currentOperationId)){this.transition(p,"BLOCKED","non_ready_report_already_reviewed");return;}
        await this.continueDevelopment(p,packet,report?.valid?"continue_remaining_work":"repair_result_report");return;
      }
      if(report.status==="PLAN_CONFLICT"||report.status==="BLOCKED"){
        this.transition(p,"BLOCKED",report.status==="PLAN_CONFLICT"?"PLAN_CONFLICT_requires_Web_GPT_revision":"developer_report_BLOCKED");return;
      }
      if(report.status!=="READY_FOR_REVIEW"){this.transition(p,"BLOCKED","report_not_ready");return;}
    }
    const externalReview=this.d.events.getReview(p.workspaceId,p.currentOperationId);
    if(p.spec.reviewerMode!=="webgpt" && externalReview){
      this.transition(p,"BLOCKED","review_already_decided_outside_realtime");
      return;
    }
    if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint){
      this.transition(p,"BLOCKED","stale_fingerprint");return;
    }
    let recommendation:RealtimeReviewRecommendation;
    if(p.spec.reviewerMode==="webgpt"){
      // Web GPT owns the verdict; never substitute an unsupervised local review.
      if(p.phase==="ACTIVE"){
        this.transition(p,"AWAITING_WEBGPT",null);
        if(!externalReview)return;
      }
      if(!externalReview)return;
      const feedback=this.db.prepare("SELECT operation_id,decision,reason FROM realtime_web_feedback WHERE plan_id=? AND event_id=?")
        .get(p.planId,run.eventId) as {operation_id:string;decision:string;reason:string}|undefined;
      if(!feedback||feedback.operation_id!==p.currentOperationId||
         feedback.decision!==externalReview.decision||
         externalReview.evidence_sha256!==packet.evidenceSha256){
        this.transition(this.get(planId)!,"BLOCKED","external_review_missing_bounded_feedback");return;
      }
      recommendation={decision:externalReview.decision,reason:feedback.reason};
      if(recommendation.decision==="APPROVED"){
        const proof=this.d.events.getVerifiedTest(run.eventId);
        if(!proof||proof.workspace_id!==p.workspaceId||
           proof.tested_fingerprint!==packet.finalFingerprint){
          this.transition(this.get(planId)!,"BLOCKED","external_approval_missing_verified_test");return;
        }
      }
    }else{
      this.transition(p,"REVIEWING",null);
      const reviewing=this.get(planId)!;
      const reviewOp=this.operationId(p,"review");
      recommendation=await this.review(reviewing,run.eventId,packet,reviewOp);
      if(this.closing)return;
      if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint)
        throw new Error("COACH_REALTIME_REVIEW_MUTATED_WORKSPACE");
      if(recommendation.decision==="APPROVED"){
        const taskId=p.spec.stages[p.stageIndex].testTaskId;
        await this.gate.verifyTest({workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,eventId:run.eventId,taskId});
      }
      await this.gate.submit({workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,
        operationId:p.currentOperationId,eventId:run.eventId,
        evidenceSha256:String(packet.evidenceSha256),decision:recommendation.decision});
    }
    if(this.closing)return;
    if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint)
      throw new Error("COACH_REALTIME_REVIEW_MUTATED_WORKSPACE");
    const decision=recommendation.decision;
    if(decision==="BLOCKED") {
      this.transition(this.get(planId)!,"BLOCKED","reviewer_blocked:"+recommendation.reason);return;
    }
    if(decision==="APPROVED" && p.stageIndex===p.spec.stages.length-1) {
      this.transition(this.get(planId)!,"DONE",null);return;
    }
    if(decision==="REWORK" && p.reworkCount>=p.spec.maxReworks){
      this.transition(this.get(planId)!,"BLOCKED","maximum_rework_cycles_reached");return;
    }
    const newStage=decision==="APPROVED"?p.stageIndex+1:p.stageIndex;
    // maxReworks is a plan-wide cost/safety ceiling, never reset at a stage boundary.
    const newCount=decision==="APPROVED"?p.reworkCount:p.reworkCount+1;
    const nextOp=this.nextOperationId(p,newStage,newCount);
    const next=p.spec.stages[newStage];
    const config=this.d.events.getRunConfig(p.workspaceId,p.currentOperationId);
    const selection=decision==="REWORK"
      ?config?.next??{model:next.model,reasoningEffort:next.reasoningEffort}
      :{model:next.model,reasoningEffort:next.reasoningEffort};
    validateCodexSelection(selection);
    const prompt=decision==="REWORK"
      ?next.prompt+"\n\nIndependent reviewer identified a bounded defect to correct: "+
         recommendation.reason+". Correct the defect, run the approved test, and report factual evidence."
      :next.prompt;
    if(prompt.length>10000)throw new Error("COACH_REALTIME_REWORK_PROMPT_TOO_LONG");
    // Commit dispatch intention FIRST, so a crash cannot accidentally replay
    // an expensive or potentially mutating Codex run.
    this.transition(this.get(planId)!,"DISPATCHING",null,nextOp,newStage,newCount);
    verifyTask(p.workspaceRoot,p.workspaceId,next.task);
    const input:RunnerInput={task:next.task,stageId:next.stageId,workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,
      operationId:nextOp,prompt,model:selection.model,reasoningEffort:selection.reasoningEffort,
      sandbox:next.sandbox,timeoutMs:3600000,
      sessionId:String(packet.threadId),parentOperationId:p.currentOperationId,
      expectedFingerprint:String(packet.finalFingerprint)};
    await this.d.runner().start(input);
    this.transition(this.get(planId)!,"ACTIVE",null);
  }
  private async continueDevelopment(p:CoachRealtimePlan,packet:Record<string,unknown>,reason:string):Promise<void>{
    const count=(this.db.prepare("SELECT count(*) n FROM realtime_continuations WHERE plan_id=? AND stage_idx=?").get(p.planId,p.stageIndex) as {n:number}).n;
    if(count>=(p.spec.maxContinuations??3)){this.transition(p,"BLOCKED","maximum_development_continuations_reached:"+reason);return;}
    const next=p.spec.stages[p.stageIndex];
    verifyTask(p.workspaceRoot,p.workspaceId,next.task);
    if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint)throw new Error("COACH_REVIEW_STALE_EVIDENCE");
    const nextOp="coach-cont-"+createHash("sha256").update(p.planId+"|"+p.currentOperationId).digest("hex").slice(0,40);
    // Durable intention before dispatch; recovery never replays an unknown outcome.
    this.db.transaction(()=>{
      this.db.prepare("INSERT INTO realtime_continuations VALUES(?,?,?,?)").run(p.planId,p.stageIndex,p.currentOperationId,nextOp);
      this.transition(p,"DISPATCHING",reason,nextOp);
    }).immediate();
    const selection=this.d.events.getRunConfig(p.workspaceId,p.currentOperationId)?.next??next;
    await this.d.runner().start({workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,operationId:nextOp,
      task:next.task,stageId:next.stageId,prompt:reason+". Read prior operation report "+p.currentOperationId+"; preserve it and write a new operation report. "+next.prompt,
      model:selection.model,reasoningEffort:selection.reasoningEffort,sandbox:next.sandbox,
      sessionId:String(packet.threadId),parentOperationId:p.currentOperationId,expectedFingerprint:String(packet.finalFingerprint)});
    this.transition(this.get(p.planId)!,"ACTIVE",null);
  }
  private operationId(p:CoachRealtimePlan,kind:"review"):string {
    return createHash("sha256").update(p.planId+"|"+p.currentOperationId+"|"+kind)
      .digest("hex").slice(0,28).replace(/^/,"coach-review-");
  }
  private nextOperationId(p:CoachRealtimePlan,stage:number,rework:number):string {
    return ("coach-"+p.planId+"-s"+stage+"-r"+rework).slice(0,128);
  }
  private async review(plan:CoachRealtimePlan,eventId:number,packet:Record<string,unknown>,
      operationId:string):Promise<RealtimeReviewRecommendation> {
    verifyTask(plan.workspaceRoot,plan.workspaceId,plan.spec.stages[plan.stageIndex].task);
    if(this.d.review)return this.d.review({plan,eventId,packet,operationId});
    const guidance="You are a SEPARATE read-only Codex reviewer. Assess the developer's ACTUAL workspace "+
      "against the following stage specification, not the developer's self-reported tests. "+
      "Read code and evidence as needed, do NOT modify files or invoke a different model. "+
      "The approved deterministic task is "+plan.spec.stages[plan.stageIndex].testTaskId+". "+
      "If any material missing functionality, unsupported claim or safety concern exists, say REWORK or BLOCKED. "+
      "APPROVED only if you independently inspected the deliverable and are prepared for a separate deterministic test. "+
      "No source text, paths or secrets in the reason. Final answer MUST BE one valid compact JSON object, "+
      'exactly {"decision":"APPROVED"|"REWORK"|"BLOCKED","reason":"3-350 chars safe plain text"}. '+
      "Read the ENTIRE authoritative TASK and verify its pinned version: "+JSON.stringify(plan.spec.stages[plan.stageIndex].task)+"\n"+
      "Signed evidence SHA: "+String(packet.evidenceSha256)+"\n"+
      "Workspace fingerprint: "+String(packet.finalFingerprint);
    const status:RunnerStatus=await this.d.runner().run({
      workspaceId:plan.workspaceId,workspaceRoot:plan.workspaceRoot,operationId,
      model:plan.spec.reviewerModel,reasoningEffort:plan.spec.reviewerEffort,
      prompt:guidance.slice(0,10000),sandbox:"read-only",
      timeoutMs:600000,internalReview:true,task:plan.spec.stages[plan.stageIndex].task,
    });
    if(status.state!=="COMPLETED"||status.exitCode!==0||!status.eventId)
      throw new Error("COACH_REALTIME_REVIEWER_FAILED");
    const verdict=await this.d.runner().getReviewRecommendation(operationId,plan.workspaceId);
    if(!verdict)throw new Error("COACH_REALTIME_REVIEWER_INVALID_VERDICT");
    return verdict;
  }
  async close():Promise<void> {
    this.closing=true;
    clearInterval(this.timer);
    this.unsub();
    // Server shutdown closes NativeRunner concurrently; wait until every
    // in-flight scheduler task observes its terminal outcome BEFORE closing
    // SQLite. Never independently kill a running Codex process here.
    await Promise.allSettled([...this.pending]);
    this.db.close();
  }
}
