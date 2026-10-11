import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { LsofWorktreeProcessProbe } from "../workspace-process-probe.js";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";
import { guardedClearQuarantine, assessGuardian } from "../coach-agent-guardian.js";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const operation=id;
const optionalError=z.unknown().optional();

export function registerCodexAgentTools(server:McpServer,ctx:ServerContext):void {
  const {config,workspaces,coachReviewEvents,getNativeCodexRunner}=ctx;
  if(!config.readOnly) {
    registerAppTool(server,"codex_agent_start",{
      title:"Start native Codex Agent",
      description:"Start approved local Codex CLI and return immediately. Status/evidence are queried separately. A successful turn is not proof tests passed.",
      inputSchema:{
        workspaceId:id,operationId:operation,
        prompt:z.string().min(1).max(10000),
        model:z.literal("gpt-5.6-luna"),
        reasoningEffort:z.enum(["none","low"]),
        sandbox:z.enum(["read-only","workspace-write"]),
        // Existing threads may only be resumed through verified REWORK tool.
        timeoutMs:z.number().int().min(3000).max(180000).optional(),
      },
      outputSchema:resultOutputSchema({status:z.unknown().optional(),error:optionalError}),
      _meta:{},
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},
    },async(input)=>{
      const workspace=workspaces.getWorkspace(input.workspaceId);
      const runner=getNativeCodexRunner();
      const status=runner.start({
        ...input,workspaceRoot:workspace.root,
      });
      const result="Codex task "+input.operationId+" started or already known. Poll codex_agent_status; a completion event is created only after verified Codex JSON evidence.";
      return {content:[textBlock(result)],structuredContent:{result,status}};
    });
    registerAppTool(server,"codex_agent_stop",{
      title:"Stop native Codex Agent",
      description:"Stop only an Agent run belonging to the authorized workspace. Safe if already completed.",
      inputSchema:{workspaceId:id,operationId:operation},
      outputSchema:resultOutputSchema({stopped:z.boolean().optional(),error:optionalError}),
      _meta:{},
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
    },async({workspaceId,operationId})=>{
      workspaces.getWorkspace(workspaceId);
      const runner=getNativeCodexRunner();
      let stopped=false;
      try {
        const s=runner.status(operationId,workspaceId);
        if(s.workspaceId!==workspaceId)throw new Error("CODEX_WORKSPACE_MISMATCH");
        stopped=await runner.stop(operationId);
      } catch(error) {
        if(error instanceof Error && error.message==="CODEX_OPERATION_NOT_FOUND")stopped=false;
        else throw error;
      }
      const result=stopped?"Codex run stopped.":"No active Codex run to stop.";
      return {content:[textBlock(result)],structuredContent:{result,stopped}};
    });
  }

  registerAppTool(server,"codex_agent_status",{
    title:"Native Codex Agent status",
    description:"Inspect an authorized local Codex run without returning its prompt. After restart, use codex_agent_evidence for persisted completed evidence.",
    inputSchema:{workspaceId:id,operationId:operation},
    outputSchema:resultOutputSchema({status:z.unknown().optional(),error:optionalError}),
    _meta:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,operationId})=>{
    workspaces.getWorkspace(workspaceId);
    const runner=getNativeCodexRunner();
    const status=runner.status(operationId,workspaceId);
    if(status.workspaceId!==workspaceId)throw new Error("CODEX_WORKSPACE_MISMATCH");
    const result="Codex run "+operationId+": "+status.state;
    return {content:[textBlock(result)],structuredContent:{result,status}};
  });

  registerAppTool(server,"codex_agent_quarantine_status",{
    title:"Native Codex quarantine status",
    description:"Read-only, workspace-authorized quarantine metadata.",
    inputSchema:{workspaceId:id}, outputSchema:resultOutputSchema({quarantined:z.boolean(),runs:z.unknown()}), _meta:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId})=>{
    workspaces.getWorkspace(workspaceId);
    const runs=coachReviewEvents.listInterruptedRuns(workspaceId).map(run=>({operationId:run.operationId,state:run.state,reason:run.reason}));
    return {content:[textBlock(runs.length?"Workspace remains quarantined.":"Workspace has no unresolved Codex quarantine.")],structuredContent:{result:"Quarantine status",quarantined:runs.length>0,runs}};
  });

  if(!config.readOnly) registerAppTool(server,"codex_agent_clear_quarantine",{
    title:"Clear native Codex quarantine",
    description:"Clear an interrupted run only after verified guardian identity and an idle authorized workspace.",
    inputSchema:{workspaceId:id,operationId:operation,explanation:z.string().min(1).max(160)}, outputSchema:resultOutputSchema({cleared:z.boolean()}), _meta:{},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
  },async({workspaceId,operationId,explanation})=>{
    const workspace=workspaces.getWorkspace(workspaceId);
    if(workspaces.liveLeases(workspaceId)>1) throw new Error("COACH_QUARANTINE_WORKSPACE_BUSY");
    if(ctx.jobs.activeJobIdsForRoot(workspace.root).length) throw new Error("COACH_QUARANTINE_ACTIVE_JOB");
    if(ctx.tasks.listSessions(workspaceId,50).some(session=>session.status==="running"))
      throw new Error("COACH_QUARANTINE_ACTIVE_TASK");
    const occupancy=await new LsofWorktreeProcessProbe({cacheTtlMs:0}).occupancyOf(workspace.root);
    if(occupancy.unknown || occupancy.pids.length)
      throw new Error("COACH_QUARANTINE_FOREIGN_PROCESS_OR_UNKNOWN");
    const run=coachReviewEvents.getAgentRun(workspaceId,operationId);
    if(!run || run.state!=="INTERRUPTED") throw new Error("COACH_QUARANTINE_NOT_CLEARABLE");
    const identity=coachReviewEvents.getGuardian(workspaceId,operationId);
    if(!identity)throw new Error("COACH_QUARANTINE_IDENTITY_UNKNOWN");
    const assessment=assessGuardian(identity);
    if(assessment.kind!=="gone")
      throw new Error("COACH_QUARANTINE_NOT_SAFE_"+
        (assessment.kind==="alive"?"GUARDIAN_RUNNING":assessment.reason));
    const clearance=guardedClearQuarantine(identity);
    if(!clearance.cleared)throw new Error("COACH_QUARANTINE_RECHECK_FAILED");
    coachReviewEvents.clearInterruptedRun({workspaceId,operationId,explanation});
    return {content:[textBlock("Codex quarantine cleared after verified inactive guardian identity.")],structuredContent:{result:"Quarantine cleared",cleared:true}};
  });

  registerAppTool(server,"codex_agent_source_diff",{
    title:"Read frozen Codex source diff",
    description:"Explicit authorized review of bounded frozen code diff; may contain source code, but no raw Codex prompt or stderr logs are exposed separately.",
    inputSchema:{workspaceId:id,operationId:operation},
    outputSchema:resultOutputSchema({sourceDiff:z.string().optional(),error:optionalError}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,operationId})=>{
    workspaces.getWorkspace(workspaceId);
    const packet=coachReviewEvents.getEvidence(workspaceId,operationId) as
      ({sourceDiff?:unknown})|undefined;
    if(!packet || typeof packet.sourceDiff!=="string")
      throw new Error("CODEX_FROZEN_DIFF_NOT_AVAILABLE");
    const result="Bounded immutable source diff available for explicit inspection.";
    return {content:[textBlock(result)],structuredContent:{result,sourceDiff:packet.sourceDiff}};
  });

  registerAppTool(server,"codex_agent_evidence",{
    title:"Read trusted Codex evidence",
    description:"Read an immutable native SQLite review packet scoped to the authorized workspace; contains hashes, not the user prompt. Does not assert claimed tests passed.",
    inputSchema:{workspaceId:id,operationId:operation},
    outputSchema:resultOutputSchema({evidence:z.unknown().optional(),error:optionalError}),
    _meta:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,operationId})=>{
    workspaces.getWorkspace(workspaceId);
    const packet=coachReviewEvents.getEvidence(workspaceId,operationId) as
      (Record<string,unknown> & {sourceDiff?:unknown})|undefined;
    if(!packet)throw new Error("CODEX_EVIDENCE_NOT_FOUND_OR_NOT_COMPLETE");
    // Evidence metadata never automatically includes source code or prompts.
    const {sourceDiff,...evidence}=packet;
    const result="Trusted hashed completion metadata for "+operationId+
      " is available. Use codex_agent_source_diff explicitly to inspect code changes.";
    return {content:[textBlock(result)],structuredContent:{result,evidence}};
  });
}
