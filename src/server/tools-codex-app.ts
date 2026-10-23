import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { bindSharedThread, boundSharedThread, createSharedThread, readSharedThread, sendSharedTurn, sharedTurnReceipt, sharedAppStatus } from "../coach-app-server-bridge.js";
import { taskReferenceSchema, verifyTask } from "../coach-task-contract.js";
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
    outputSchema:resultOutputSchema({receipt:z.unknown().optional(),error:z.unknown().optional()}),
    _meta:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,operationId})=>{
    ctx.workspaces.getWorkspace(workspaceId);
    const receipt=sharedTurnReceipt(ctx.config.stateDir,workspaceId,operationId);
    return{content:[textBlock(receipt?"Codex App operation status: "+receipt.state:"No Codex App operation record found.")],
      structuredContent:{result:"Codex App turn receipt",...(receipt?{receipt}:{})}};
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
    const receipt=await sendSharedTurn({
      workspaceId,root:workspace.root,threadId,operationId,prompt:effectivePrompt,sandbox,
      stateDir:ctx.config.stateDir,timeoutMs,
    });
    return{content:[textBlock("Codex App turn "+receipt.turnId+" completed; inspect receipt for the actual reply.")],
      structuredContent:{result:"App thread completed; not an approved code review",receipt}};
  });
}
