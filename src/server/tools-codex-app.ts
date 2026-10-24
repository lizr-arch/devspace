import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { bindSharedThread, boundSharedThread, assertSharedThreadOwnership, createSharedThread, readSharedThread, sendSharedTurn, sharedTurnReceipt, sharedAppStatus, reconcileSharedTurn, AppBridgeError } from "../coach-app-server-bridge.js";
import { taskReferenceSchema, verifyTask, sha256 } from "../coach-task-contract.js";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const threadId=z.string().uuid();
export function registerSharedCodexAppTools(server:McpServer,ctx:ServerContext):void {
  registerAppTool(server,"codex_app_shared_status",{
    title:"Check shared Codex App Server",
    description:"Read-only, local Unix socket handshake. Never launches, restarts or modifies ChatGPT App or Codex.",
    inputSchema:{workspaceId:id},
    outputSchema:resultOutputSchema({bridge:z.unknown().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId})=>{
    ctx.workspaces.getWorkspace(workspaceId);
    const bridge=await sharedAppStatus();
    return{content:[textBlock(bridge.connected?"Shared Codex App Server reachable.":"Shared Codex App Server unavailable.")],
      structuredContent:{result:"Shared Codex App Server status",bridge}};
  });
  registerAppTool(server,"codex_app_turn_receipt",{
    title:"Read durable status of a Codex App turn",
    description:"Read PENDING, UNCERTAIN or COMPLETED evidence by workspace and operation ID after a client or network interruption; never resubmits the message.",
    inputSchema:{workspaceId:id,operationId:id},
    outputSchema:resultOutputSchema({receipt:z.unknown().optional(),journal:z.unknown().optional(),
      appConnection:z.string().optional(),sidecarState:z.string().optional(),eventState:z.string().optional(),
      deliveryReceipt:z.string().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,operationId})=>{
    ctx.workspaces.getWorkspace(workspaceId);
    let journal=ctx.coachReviewEvents.getAppTurn(workspaceId,operationId);
    let receipt=sharedTurnReceipt(ctx.config.stateDir,workspaceId,operationId);
    if(journal&&receipt&&receipt.state!=="COMPLETED"&&receipt.state!=="FAILED"&&receipt.acceptedTurnId){
      try{
        const recovered=await reconcileSharedTurn({root:ctx.workspaces.getWorkspace(workspaceId).root,stateDir:ctx.config.stateDir,workspaceId,operationId,threadId:journal.thread_id});
        if(recovered)ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"COMPLETED",turnId:recovered.turnId});
        else if(sharedTurnReceipt(ctx.config.stateDir,workspaceId,operationId)?.state==="FAILED")ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"FAILED",turnId:receipt.acceptedTurnId});
      }catch(error){
        if(error instanceof AppBridgeError&&["CODEX_APP_SHARED_SOCKET_UNAVAILABLE","CODEX_APP_SOCKET_ERROR","CODEX_APP_SOCKET_CLOSED"].includes(error.code))
          ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"BLOCKED_PENDING_CONNECTION",turnId:receipt.acceptedTurnId});
      }
      journal=ctx.coachReviewEvents.getAppTurn(workspaceId,operationId);receipt=sharedTurnReceipt(ctx.config.stateDir,workspaceId,operationId);
    }
    const app=await sharedAppStatus();
    const sidecar=await ctx.managedCoachSidecar.status(workspaceId);
    const delivery=journal?.event_id?await ctx.managedCoachSidecar.getDeliveryReceipt?.(workspaceId,journal.event_id):undefined;
    const state=journal?.state??receipt?.state??"NOT_FOUND";
    return{content:[textBlock("Native App turn "+state+"; event "+(journal?.event_id?"persisted":"pending or absent")+
      "; browser submission "+(delivery?.result??"not acknowledged")+".")],
      structuredContent:{result:"Codex App recovery and delivery status",appConnection:app.connected?"CONNECTED":app.error,
        sidecarState:sidecar?.state??"UNAVAILABLE",eventState:journal?.event_id?"PENDING_REVIEW":"NOT_PUBLISHED",
        deliveryReceipt:delivery?.result??"NONE",...(receipt?{receipt}:{}),...(journal?{journal:{state:journal.state,eventId:journal.event_id}}:{})}};
  });
  registerAppTool(server,"codex_app_thread_current",{
    title:"Read the pinned Codex App thread for a DevSpace workspace",
    description:"Read only the exact workspace-to-thread binding from local DevSpace state. No guesses based on active or latest ChatGPT tab.",
    inputSchema:{workspaceId:id},outputSchema:resultOutputSchema({threadId:z.string().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId})=>{
    ctx.workspaces.getWorkspace(workspaceId);
    const threadId=boundSharedThread(ctx.config.stateDir,workspaceId);
    return{content:[textBlock(threadId?"Pinned App thread found.":"No App thread bound to workspace.")],
      structuredContent:{result:"Pinned Codex App thread",...(threadId?{threadId}:{})}};
  });
  registerAppTool(server,"codex_app_thread_read",{
    title:"Read one authorized App-visible Codex thread",
    description:"Read history only when thread cwd matches the exact authorized DevSpace workspace. No thread lock takeover; returns up to 20 most recent messages.",
    inputSchema:{workspaceId:id,threadId,limit:z.number().int().min(1).max(20).default(8)},
    outputSchema:resultOutputSchema({thread:z.unknown().optional(),historyAvailable:z.boolean().optional(),messages:z.unknown().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,threadId,limit})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    const result=await readSharedThread({root:workspace.root,threadId,limit});
    return{content:[textBlock("Read authorized App thread "+threadId+".")],
      structuredContent:{result:"Codex App thread read",...result}};
  });
  if(ctx.config.readOnly)return;
  registerAppTool(server,"codex_app_thread_create",{
    title:"Create an App-visible Codex thread in workspace",
    description:"Explicit new native vscode-source thread on an already-running private shared App Server. No shell, no model turn, no App restart. Not idempotent: on transport uncertainty read existing threads instead of retrying.",
    inputSchema:{workspaceId:id},
    outputSchema:resultOutputSchema({thread:z.unknown().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async({workspaceId})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    if(boundSharedThread(ctx.config.stateDir,workspaceId))throw new Error("CODEX_APP_WORKSPACE_ALREADY_BOUND");
    const thread=await createSharedThread({root:workspace.root});
    await bindSharedThread({workspaceId,root:workspace.root,threadId:thread.threadId,stateDir:ctx.config.stateDir});
    return{content:[textBlock("Created App-visible Codex thread "+thread.threadId+".")],
      structuredContent:{result:"App thread created",thread}};
  });
  registerAppTool(server,"codex_app_thread_bind",{
    title:"Pin one existing App-visible Codex thread to this workspace",
    description:"Explicit exact thread and workspace binding after live server verifies matching cwd; durable across DevSpace restarts. Refuses replacing another pinned thread.",
    inputSchema:{workspaceId:id,threadId},
    outputSchema:resultOutputSchema({threadId:z.string().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,threadId})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    const bound=await bindSharedThread({workspaceId,root:workspace.root,threadId,stateDir:ctx.config.stateDir});
    return{content:[textBlock("Pinned exact Codex App thread to authorized workspace.")],
      structuredContent:{result:"Codex App thread pinned",threadId:bound}};
  });
  registerAppTool(server,"codex_app_thread_send",{
    title:"Send one turn to existing App-visible Codex thread",
    description:"Explicit exact threadId and unique operationId required. Workspace ownership is verified against thread cwd before sending. Uses the existing private shared App Server; never kills/restarts App. On lost connection, operation is UNCERTAIN and cannot be replayed with the same ID. Workspace-write turns require a frozen TASK; successful messages are not Code Review approval or verified tests.",
    inputSchema:{
      workspaceId:id,threadId,operationId:id,
      prompt:z.string().min(1).max(10000),
      sandbox:z.enum(["read-only","workspace-write"]).default("read-only"),
      task:taskReferenceSchema.optional(),
      timeoutMs:z.number().int().min(3000).max(3600000).optional(),
    },
    outputSchema:resultOutputSchema({receipt:z.unknown().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},
  },async({workspaceId,threadId,operationId,prompt,sandbox,task,timeoutMs})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    if(sandbox==="workspace-write"){
      verifyTask(workspace.root,workspaceId,task);
      if(ctx.coachReviewEvents.hasInterruptedRun(workspaceId))
        throw new Error("CODEX_APP_WORKSPACE_QUARANTINED");
    }else if(task){
      verifyTask(workspace.root,workspaceId,task);
    }
    // The frozen TASK, not an ad-hoc Web GPT prompt, is authoritative for mutations.
    const effectivePrompt=sandbox==="workspace-write"&&task
      ? "Authorized frozen development TASK: "+task.taskPath+
        "\nExpected SHA-256: "+task.sha256+
        "\nRead this exact TASK file and comply with its full scope and acceptance criteria. "+
        "Do not modify .devspace control files. This App turn alone is not an APPROVED review."+
        "\nSupplementary Web GPT instruction:\n"+prompt
      : prompt;
    if(effectivePrompt.length>10000)throw new Error("CODEX_APP_TASK_PROMPT_TOO_LONG");
    assertSharedThreadOwnership(ctx.config.stateDir,workspaceId,workspace.root,threadId);
    const ref=task;
    ctx.coachReviewEvents.registerAppTurn({workspaceId,operationId,workspaceRoot:workspace.root,threadId,
      requestSha256:sha256(effectivePrompt),taskId:ref?.taskId??"read-only",taskSha256:ref?.sha256??sha256("read-only")});
    let receipt;
    try{
      receipt=await sendSharedTurn({workspaceId,root:workspace.root,threadId,operationId,prompt:effectivePrompt,sandbox,
        stateDir:ctx.config.stateDir,timeoutMs,onAccepted:turnId=>{ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"PENDING",turnId});}});
      ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"COMPLETED",turnId:receipt.turnId});
    }catch(error){
      const bridgeReceipt=sharedTurnReceipt(ctx.config.stateDir,workspaceId,operationId);
      ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:bridgeReceipt?.state==="PENDING"?"BLOCKED_PENDING_CONNECTION":bridgeReceipt?.state==="FAILED"?"FAILED":"UNCERTAIN"});
      throw error;
    }
    return{content:[textBlock("Codex App turn "+receipt.turnId+" completed; inspect receipt for the actual reply.")],
      structuredContent:{result:"App thread completed; not an approved code review",receipt}};
  });
  registerAppTool(server,"codex_app_review",{
    title:"Record an independent Web GPT review of a native App event",
    description:"Writes a bounded APPROVED, REWORK or BLOCKED receipt for one exact workspace-scoped native ChatGPT App Codex event. Requires Web GPT evidence SHA-256 and reason; completion and browser DOM submission are not approval.",
    inputSchema:{workspaceId:id,eventId:z.string().regex(/^app:[a-f0-9]{64}$/),decision:z.enum(["APPROVED","REWORK","BLOCKED"]),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().min(1).max(4000)},
    outputSchema:resultOutputSchema({receipt:z.unknown().optional()}),_meta:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,eventId,decision,evidenceSha256,reason})=>{
    ctx.workspaces.getWorkspace(workspaceId);
    const receipt=ctx.coachReviewEvents.submitAppReview({workspaceId,eventId,decision,evidenceSha256,reason});
    return{content:[textBlock("Recorded independent native App event review: "+decision+".")],structuredContent:{result:"Native App review receipt",receipt}};
  });
  registerAppTool(server,"codex_app_thread_rework",{
    title:"Send bounded REWORK to the same native App thread",
    description:"After an exact native App event has a recorded Web GPT REWORK verdict, sends one new operation to that same pinned thread under the same frozen TASK. Maximum three REWORK cycles per task fingerprint; never starts CLI.",
    inputSchema:{workspaceId:id,eventId:z.string().regex(/^app:[a-f0-9]{64}$/),operationId:id,prompt:z.string().min(1).max(8000),task:taskReferenceSchema},
    outputSchema:resultOutputSchema({receipt:z.unknown().optional(),error:z.unknown().optional()}),_meta:{},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},
  },async({workspaceId,eventId,operationId,prompt,task})=>{
    const workspace=ctx.workspaces.getWorkspace(workspaceId);verifyTask(workspace.root,workspaceId,task);
    const prior=ctx.coachReviewEvents.getAppEventTask(workspaceId,eventId);
    if(!prior||prior.decision!=="REWORK")throw new Error("CODEX_APP_REWORK_NOT_AUTHORIZED");
    assertSharedThreadOwnership(ctx.config.stateDir,workspaceId,workspace.root,prior.thread_id);
    if(prior.task_id!==task.taskId||prior.task_sha256!==task.sha256)throw new Error("CODEX_APP_REWORK_TASK_MISMATCH");
    if(ctx.coachReviewEvents.countAppReworks(workspaceId,task.taskId,task.sha256)>=3)throw new Error("CODEX_APP_REWORK_LIMIT");
    const effectivePrompt="Authorized frozen development TASK: "+task.taskPath+"\nExpected SHA-256: "+task.sha256+
      "\nRead this exact TASK file and comply with its full scope and acceptance criteria. Do not modify .devspace control files.\n"+prompt;
    ctx.coachReviewEvents.registerAppTurn({workspaceId,operationId,workspaceRoot:workspace.root,threadId:prior.thread_id,
      requestSha256:sha256(effectivePrompt),taskId:task.taskId,taskSha256:task.sha256});
    try{
      const receipt=await sendSharedTurn({workspaceId,root:workspace.root,threadId:prior.thread_id,operationId,prompt:effectivePrompt,
        sandbox:"workspace-write",stateDir:ctx.config.stateDir,onAccepted:turnId=>{ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"PENDING",turnId});}});
      ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"COMPLETED",turnId:receipt.turnId});
      return{content:[textBlock("Native App REWORK turn completed on the pinned thread; independent review is still required.")],structuredContent:{result:"Native App REWORK completed",receipt}};
    }catch(error){ctx.coachReviewEvents.updateAppTurn({workspaceId,operationId,state:"UNCERTAIN"});throw error;}
  });
}
