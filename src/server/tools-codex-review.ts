import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";
import { CoachReviewGate } from "../coach-review-gate.js";
import { captureCodexFingerprint } from "../codex-agent-runner.js";
import { CODEX_MODELS, CODEX_EFFORTS } from "../coach-model-policy.js";
import { checkManifestIntegrity, isTaskApproved } from "../task-manifest.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export function registerCodexReviewTools(server: McpServer, ctx: ServerContext): void {
  if (ctx.config.readOnly) return;
  const gate = new CoachReviewGate({ events: ctx.coachReviewEvents, tasks: ctx.tasks });
  registerAppTool(server, "codex_agent_verify_test", {
    title: "Verify an approved task for review",
    description: "Run one declared, approved workspace task and bind its successful unchanged fingerprint to the review event.",
    inputSchema: { workspaceId: id, eventId: z.number().int().positive(), taskId: id },
    outputSchema: resultOutputSchema({ proof: z.unknown().optional(), error: z.unknown().optional() }),
    _meta: {}, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, eventId, taskId }) => {
    const workspace = ctx.workspaces.getWorkspace(workspaceId);
    const approved = workspace.approvedTasks;
    if (!approved || !checkManifestIntegrity(workspace.root, approved))
      throw new Error("COACH_TEST_MANIFEST_NOT_APPROVED_OR_CHANGED");
    if (!isTaskApproved(taskId, approved)) throw new Error("COACH_TEST_TASK_NOT_APPROVED");
    const proof = await gate.verifyTest({ workspaceId, workspaceRoot: workspace.root, eventId, taskId });
    return { content: [textBlock(`Verified task ${taskId} for review event ${eventId}.`)], structuredContent: { result: "verified", proof } };
  });
  registerAppTool(server, "codex_agent_start_rework", {
    title: "Resume Codex from approved REWORK",
    description: "Explicitly launch a new Codex operation in the parent verified REWORK thread; never automatically resubmit or use a caller-supplied arbitrary thread ID.",
    inputSchema: { workspaceId:id, parentOperationId:id, operationId:id,
      prompt:z.string().min(1).max(10000),
      // Optional fields override the parent's queued selection independently.
      model:z.enum(CODEX_MODELS).optional(),
      reasoningEffort:z.enum(CODEX_EFFORTS).optional(),
      sandbox:z.enum(["workspace-write","read-only"]),
      timeoutMs:z.number().int().min(3000).max(3600000).optional() },
    outputSchema: resultOutputSchema({status:z.unknown().optional(),error:z.unknown().optional()}),
    _meta: {},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,parentOperationId,operationId,prompt,model,reasoningEffort,sandbox,timeoutMs})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    if(parentOperationId===operationId)throw new Error("COACH_REWORK_SAME_OPERATION");
    const review=ctx.coachReviewEvents.getReview(workspaceId,parentOperationId);
    const packet=ctx.coachReviewEvents.getEvidence(workspaceId,parentOperationId) as
      {threadId?:unknown;finalFingerprint?:unknown;evidenceSha256?:unknown}|undefined;
    if(!review || review.decision!=="REWORK" || !packet ||
      typeof packet.threadId!=="string" || typeof packet.finalFingerprint!=="string" ||
      packet.evidenceSha256!==review.evidence_sha256)
      throw new Error("COACH_REWORK_PARENT_NOT_APPROVED");
    const current=await captureCodexFingerprint(workspace.root);
    if(current.sha!==packet.finalFingerprint)throw new Error("COACH_REWORK_STALE_WORKTREE");
    const runner=ctx.getNativeCodexRunner();
    const parentConfig=ctx.coachReviewEvents.getRunConfig(workspaceId,parentOperationId);
    // Historical reviews may predate durable model configs. In that case
    // require a fully explicit permitted selection; never infer a legacy model.
    if(!parentConfig && (model===undefined || reasoningEffort===undefined))
      throw new Error("COACH_REWORK_CONFIG_NOT_FOUND");
    const selected={model:model??parentConfig!.next.model,
      reasoningEffort:reasoningEffort??parentConfig!.next.reasoningEffort};
    const status=runner.start({workspaceId,workspaceRoot:workspace.root,operationId,
      parentOperationId,expectedFingerprint:packet.finalFingerprint,prompt,
      ...selected,sandbox,sessionId:packet.threadId,...(timeoutMs?{timeoutMs}:{})});
    const result="Started explicit Codex rework operation "+operationId+" on parent thread.";
    return {content:[textBlock(result)],structuredContent:{result,status}};
  });
  registerAppTool(server, "codex_agent_submit_review", {
    title: "Submit verified Codex review",
    description: "Submit APPROVED, REWORK, or BLOCKED only after immutable evidence and current workspace fingerprint verification.",
    inputSchema: { workspaceId: id, operationId: id, eventId: z.number().int().positive(), decision: z.enum(["APPROVED", "REWORK", "BLOCKED"]), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) },
    outputSchema: resultOutputSchema({ receipt: z.unknown().optional(), error: z.unknown().optional() }),
    _meta: {}, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, operationId, eventId, decision, evidenceSha256 }) => {
    const workspace = ctx.workspaces.getWorkspace(workspaceId);
    const receipt = await gate.submit({ workspaceId, workspaceRoot: workspace.root, operationId, eventId, decision, evidenceSha256 });
    return { content: [textBlock(`Review event ${eventId}: ${decision}.`)], structuredContent: { result: decision, receipt } };
  });
}
