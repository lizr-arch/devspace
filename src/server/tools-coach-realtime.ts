import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {registerAppTool,textBlock} from "./server-helpers.js";
import {resultOutputSchema,type ServerContext} from "./server-types.js";
import {checkManifestIntegrity} from "../task-manifest.js";
import {CODEX_MODELS,CODEX_EFFORTS} from "../coach-model-policy.js";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const stage=z.object({
 prompt:z.string().min(1).max(8000),
 testTaskId:id,
 model:z.enum(CODEX_MODELS),
 reasoningEffort:z.enum(CODEX_EFFORTS),
 sandbox:z.enum(["workspace-write","read-only"]),
});
export function registerCoachRealtimeTools(server:McpServer,ctx:ServerContext):void{
 registerAppTool(server,"coach_realtime_status",{
  title:"Read realtime Coach plan",
  description:"Return persisted local autonomous Coach plan states, bounded rework progress and blockers. No model prompts or secrets.",
  inputSchema:{planId:id.optional()},
  outputSchema:resultOutputSchema({plans:z.unknown()}),
  _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
 },async({planId})=>{
  const plans=planId?[ctx.coachRealtime.get(planId)].filter(Boolean):ctx.coachRealtime.all();
  const safe=plans.map(p=>({planId:p!.planId,workspaceId:p!.workspaceId,phase:p!.phase,
   currentOperationId:p!.currentOperationId,stageIndex:p!.stageIndex,
   reworkCount:p!.reworkCount,maxReworks:p!.spec.maxReworks,
   lastErrorCode:p!.lastError?.split(":")[0].slice(0,80)??null,updatedAt:p!.updatedAt}));
  return {content:[textBlock("Realtime Coach plans: "+safe.length)],structuredContent:{result:"ok",plans:safe}};
 });
 if(ctx.config.readOnly)return;
 registerAppTool(server,"coach_realtime_register",{
  title:"Enroll explicitly approved native Agent workflow",
  description:"Opt-in autonomous real-time Coach: independent local Codex review after signed completion, approved deterministic test before APPROVED, at most five revisions, optional later stages. Requires an already running native Agent and workspace-approved test tasks. This starts no unrelated model.",
  inputSchema:{planId:id,workspaceId:id,initialOperationId:id,
   reviewerModel:z.enum(CODEX_MODELS),reviewerEffort:z.enum(CODEX_EFFORTS),
   maxReworks:z.number().int().min(0).max(5),
   stages:z.array(stage).min(1).max(8)},
  outputSchema:resultOutputSchema({plan:z.unknown()}),
  _meta:{},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},
 },async(spec)=>{
  const ws=ctx.workspaces.getWorkspace(spec.workspaceId);
  if(!ws.approvedTasks || !checkManifestIntegrity(ws.root,ws.approvedTasks))
    throw new Error("COACH_REALTIME_TASK_MANIFEST_NOT_APPROVED");
  const plan=ctx.coachRealtime.register(spec);
  return {content:[textBlock("Enrolled explicitly approved realtime Coach plan "+plan.planId)],
   structuredContent:{result:"registered",plan:{planId:plan.planId,phase:plan.phase,
    currentOperationId:plan.currentOperationId}}};
 });
 for(const [name,action] of [["coach_realtime_pause","pause"],["coach_realtime_resume","resume"]] as const){
  registerAppTool(server,name,{
   title:action==="pause"?"Pause realtime Coach scheduling":"Resume realtime Coach scheduling",
   description:action==="pause"?"Pause future scheduling without killing a live Codex process. Only ACTIVE plans can pause.":"Resume an explicitly paused plan after reconciling current operation state.",
   inputSchema:{planId:id},
   outputSchema:resultOutputSchema({plan:z.unknown()}),
   _meta:{},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
  },async({planId})=>{
   const p=action==="pause"?ctx.coachRealtime.pause(planId):ctx.coachRealtime.resume(planId);
   return {content:[textBlock("Realtime Coach plan "+planId+": "+p.phase)],
    structuredContent:{result:p.phase,plan:{planId:p.planId,phase:p.phase,stageIndex:p.stageIndex,
      currentOperationId:p.currentOperationId}}};
  });
 }
}
