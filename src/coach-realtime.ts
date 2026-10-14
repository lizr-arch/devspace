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
import type { NativeCodexAgentRunner, RunnerInput, RunnerStatus } from "./codex-agent-runner.js";
import { captureCodexFingerprint } from "./codex-agent-runner.js";
import type { TaskRunner } from "./task-runner.js";
import { validateCodexSelection, type CodexModel, type CodexEffort } from "./coach-model-policy.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
type Phase="ACTIVE"|"REVIEWING"|"DISPATCHING"|"DONE"|"BLOCKED"|"PAUSED";
export interface CoachRealtimeStage {
  prompt:string;
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
  runner:()=>NativeCodexAgentRunner;
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
      "CREATE INDEX IF NOT EXISTS realtime_active_ws ON realtime_plans(workspace_id,phase);");
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
    validateCodexSelection({model:spec.reviewerModel,reasoningEffort:spec.reviewerEffort});
    for(const stage of spec.stages) {
      validateCodexSelection(stage);
      if(!ID.test(stage.testTaskId)||!["workspace-write","read-only"].includes(stage.sandbox)||
        typeof stage.prompt!=="string"||stage.prompt.length<1||stage.prompt.length>8000)
        throw new TypeError("COACH_REALTIME_INVALID_STAGE");
    }
  }
  register(spec:CoachRealtimeSpec):CoachRealtimePlan {
    this.assertSpec(spec);
    const ws=this.d.workspaces.getWorkspace(spec.workspaceId);
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
        ["ACTIVE","REVIEWING","DISPATCHING"].includes(p.phase)))
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
    if(row.phase==="ACTIVE")this.transition(row,"PAUSED","paused_by_user");
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
      plan.phase==="ACTIVE")this.wake(plan.planId);
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
      if(plan.phase==="ACTIVE"||plan.phase==="REVIEWING"||plan.phase==="DISPATCHING")
        this.transition(plan,"BLOCKED",reason);
    }).finally(()=>this.busy.delete(planId));
    this.pending.add(pending);
    void pending.then(()=>this.pending.delete(pending));
  }
  async recover():Promise<void>{
    if(this.closing)return;
    for(const plan of this.all()) {
      if(plan.phase==="ACTIVE")this.wake(plan.planId);
      // If a process was being launched or reviewed when the DevSpace
      // service was killed, NEVER replay it blindly after reboot.
      if((plan.phase==="REVIEWING"||plan.phase==="DISPATCHING")&&!this.busy.has(plan.planId))
        this.transition(plan,"BLOCKED","unknown_outcome_after_restart_manual_reconciliation_required");
    }
  }
  private async process(planId:string):Promise<void>{
    const p=this.get(planId);
    if(!p||p.phase!=="ACTIVE")return;
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
    if(this.d.events.getReview(p.workspaceId,p.currentOperationId)){
      // External reviewer already decided; an automatic coordinator must not
      // override or duplicate the user/Coach's previous disposition.
      this.transition(p,"BLOCKED","review_already_decided_outside_realtime");
      return;
    }
    if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint){
      this.transition(p,"BLOCKED","stale_fingerprint");return;
    }
    this.transition(p,"REVIEWING",null);
    const reviewing=this.get(planId)!;
    const reviewOp=this.operationId(p,"review");
    const recommendation=await this.review(reviewing,run.eventId,packet,reviewOp);
    // Closing a server mid-review must NOT dispatch another subprocess.
    // The persisted REVIEWING state will require manual reconciliation.
    if(this.closing)return;
    // Never accept a recommendation if the reviewer modified anything.
    if((await captureCodexFingerprint(p.workspaceRoot)).sha!==packet.finalFingerprint)
      throw new Error("COACH_REALTIME_REVIEW_MUTATED_WORKSPACE");
    const decision=recommendation.decision;
    if(decision==="APPROVED") {
      const taskId=p.spec.stages[p.stageIndex].testTaskId;
      await this.gate.verifyTest({workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,eventId:run.eventId,taskId});
    }
    await this.gate.submit({workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,
      operationId:p.currentOperationId,eventId:run.eventId,
      evidenceSha256:String(packet.evidenceSha256),decision});
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
    const newCount=decision==="APPROVED"?0:p.reworkCount+1;
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
    const input:RunnerInput={workspaceId:p.workspaceId,workspaceRoot:p.workspaceRoot,
      operationId:nextOp,prompt,model:selection.model,reasoningEffort:selection.reasoningEffort,
      sandbox:next.sandbox,timeoutMs:3600000,
      sessionId:String(packet.threadId),parentOperationId:p.currentOperationId,
      expectedFingerprint:String(packet.finalFingerprint)};
    this.d.runner().start(input);
    this.transition(this.get(planId)!,"ACTIVE",null);
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
    if(this.d.review)return this.d.review({plan,eventId,packet,operationId});
    const guidance="You are a SEPARATE read-only Codex reviewer. Assess the developer's ACTUAL workspace "+
      "against the following stage specification, not the developer's self-reported tests. "+
      "Read code and evidence as needed, do NOT modify files or invoke a different model. "+
      "The approved deterministic task is "+plan.spec.stages[plan.stageIndex].testTaskId+". "+
      "If any material missing functionality, unsupported claim or safety concern exists, say REWORK or BLOCKED. "+
      "APPROVED only if you independently inspected the deliverable and are prepared for a separate deterministic test. "+
      "No source text, paths or secrets in the reason. Final answer MUST BE one valid compact JSON object, "+
      'exactly {"decision":"APPROVED"|"REWORK"|"BLOCKED","reason":"3-350 chars safe plain text"}. '+
      "Developer task:\n"+plan.spec.stages[plan.stageIndex].prompt.slice(0,7000)+"\n"+
      "Signed evidence SHA: "+String(packet.evidenceSha256)+"\n"+
      "Workspace fingerprint: "+String(packet.finalFingerprint);
    const status:RunnerStatus=await this.d.runner().run({
      workspaceId:plan.workspaceId,workspaceRoot:plan.workspaceRoot,operationId,
      model:plan.spec.reviewerModel,reasoningEffort:plan.spec.reviewerEffort,
      prompt:guidance.slice(0,10000),sandbox:"read-only",
      timeoutMs:600000,internalReview:true,
    });
    if(status.state!=="COMPLETED"||status.exitCode!==0||!status.eventId)
      throw new Error("COACH_REALTIME_REVIEWER_FAILED");
    const verdict=this.d.runner().getReviewRecommendation(operationId);
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
