import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {realpath} from "node:fs/promises";
import {computeRequestHash} from "../operation-registry.js";
import {OpenCodeSessionAdapter} from "../opencode-session-adapter.js";
import type {ServerContext} from "./server-types.js";
import {registerAppTool,textBlock} from "./server-helpers.js";
import {resultOutputSchema} from "./server-types.js";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/**
 * Explicitly opt-in, single-session local test surface. It is absent from
 * normal DevSpace servers and cannot address arbitrary OpenCode sessions.
 */
export function registerOpenCodeSessionTestTool(server:McpServer,ctx:ServerContext):void{
  const pinnedSession=process.env.DEVSPACE_OPENCODE_TEST_SESSION_ID;
  const pinnedDirectory=process.env.DEVSPACE_OPENCODE_TEST_DIRECTORY;
  const baseUrl=process.env.DEVSPACE_OPENCODE_TEST_BASE_URL??"http://127.0.0.1:49374";
  if(!pinnedSession||!pinnedDirectory)return;

  registerAppTool(server,"opencode_test_session_send",{
    title:"Send one turn to the explicitly authorized OpenCode test session",
    description:"Local opt-in test-only tool. Pins one Session ID, one canonical directory and a loopback OpenCode service. Uses official Session API and durable DevSpace operation receipts; never creates, resumes, or selects a session by recency.",
    inputSchema:{workspaceId:id,sessionId:id,operationId:id,text:z.string().min(1).max(20_000)},
    outputSchema:resultOutputSchema({sessionId:z.string(),userMessageId:z.string(),assistantMessageId:z.string(),model:z.unknown(),assistant:z.unknown(),receipt:z.string()}),
    _meta:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({workspaceId,sessionId,operationId,text})=>{
    if(sessionId!==pinnedSession)throw new Error("OPENCODE_TEST_SESSION_NOT_AUTHORIZED");
    const workspace=ctx.workspaces.getWorkspace(workspaceId);
    const [actualRoot,authorizedRoot]=await Promise.all([realpath(workspace.root),realpath(pinnedDirectory)]);
    if(actualRoot!==authorizedRoot)throw new Error("OPENCODE_TEST_DIRECTORY_NOT_AUTHORIZED");
    const adapter=await OpenCodeSessionAdapter.authorize({baseUrl,directory:authorizedRoot,sessionId:pinnedSession});
    const identity=await adapter.readSession();
    const requestHash=computeRequestHash("opencode_test_session_send",{workspaceId,sessionId,operationId,text});
    const existing=ctx.operations.getOperation(operationId);
    if(existing){
      if(existing.requestHash!==requestHash)throw new Error("OPENCODE_OPERATION_ID_PAYLOAD_MISMATCH");
      if(existing.status==="succeeded")return existing.result as {content:ReturnType<typeof textBlock>[];structuredContent?:Record<string,unknown>};
      if(existing.status==="running")throw new Error("OPENCODE_OPERATION_UNCERTAIN_DO_NOT_RESEND");
      throw new Error("OPENCODE_OPERATION_PREVIOUS_FAILURE_REQUIRES_RECONCILIATION");
    }
    const start=ctx.operations.recordStart(operationId,{workspaceId,toolName:"opencode_test_session_send",requestHash});
    // Defend against concurrent calls even though normal MCP clients serialize
    // one tool call at a time. Never proceed on any non-new registry outcome.
    if(start.status!=="new")throw new Error("OPENCODE_OPERATION_STATE_CHANGED_DO_NOT_RESEND");
    const accepted=await adapter.prompt(text) as {id?:string};
    if(!accepted?.id)throw new Error("OPENCODE_PROMPT_ACCEPTED_WITHOUT_MESSAGE_ID_UNCERTAIN");
    const assistant=await adapter.waitForTurn(accepted.id);
    const result={sessionId:pinnedSession,userMessageId:accepted.id,assistantMessageId:String(assistant.id),model:identity.model,assistant,receipt:"COMPLETED"};
    const output={content:[textBlock(`OpenCode turn completed in authorized Session ${pinnedSession}.`)],structuredContent:{result:"OpenCode test Session turn",...result}};
    ctx.operations.recordSuccess(operationId,output,true);
    return output;
  });
}
