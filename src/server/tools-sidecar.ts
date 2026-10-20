import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";

const workspaceIdSchema = z.string().min(1);
const portSchema = z.number().int().min(1).max(65535);
const extensionIdSchema = z.string().regex(/^[a-p]{32}$/).optional();

// The shared tool wrapper returns {result,error} on rejection. Every output
// schema must accept that envelope so a denied request remains a readable MCP
// error instead of producing a second client-side schema failure.
const optionalError = z.unknown().optional();

export function registerSidecarTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, managedCoachSidecar } = ctx;

  if (!config.readOnly) {
    registerAppTool(
      server,
      "start_coach_sidecar",
      {
        title: "Start coach feed",
        description:
          "Start loopback read-only coach feed. Optional adminObserverScope=all_native_worktrees explicitly grants the paired extension access to redacted native Codex events across THIS DevSpace instance; default is disabled. The pairing token is returned only on successful start.",
        inputSchema: {
          workspaceId: workspaceIdSchema,
          port: portSchema,
          pairedExtensionId: extensionIdSchema,
          // Explicit elevated scope. Existing v0.2 starts default to off.
          adminObserverScope: z.literal("all_native_worktrees").optional(),
          // Explicit, bounded event scope. Never discover or authorize all
          // registered worktrees automatically.
          authorizedWorkspaceIds: z.array(workspaceIdSchema).min(1).max(8).optional(),
        },
        outputSchema: resultOutputSchema({
          sidecar: z.unknown().optional(),
          token: z.string().optional(),
          error: optionalError,
        }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, port, pairedExtensionId, adminObserverScope,authorizedWorkspaceIds }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const ids=authorizedWorkspaceIds??[workspaceId];
        if(!ids.includes(workspaceId)||new Set(ids).size!==ids.length)
          throw new Error("COACH_FEED_SCOPE_INVALID");
        // Each additional workspace requires the same explicit MCP-approved
        // root validation as the original workspace.
        for(const id of ids)workspaces.getWorkspace(id);
        const consent={workspaceId,workspaceRoot:workspace.root,port,pairedExtensionId,
          observeAllNativeAgents:adminObserverScope==="all_native_worktrees",
          authorizedWorkspaceIds:ids};
        const started = await managedCoachSidecar.start(consent);
        try{ctx.coachReviewEvents.saveCoachFeedConfig(consent);}
        catch(error){await managedCoachSidecar.stop(workspaceId);throw error;}
        const { token, ...sidecar } = started;
        const result =
          "Started coach-feed on 127.0.0.1:" +
          sidecar.port +
          ". A one-time bearer token is returned for explicit browser pairing.";
        return {
          content: [textBlock(result)],
          structuredContent: { result, sidecar, token },
        };
      },
    );

    registerAppTool(
      server,
      "stop_coach_sidecar",
      {
        title: "Stop coach feed",
        description:
          "Stop a managed event feed for an authorized workspace. Safe to call repeatedly.",
        inputSchema: { workspaceId: workspaceIdSchema },
        outputSchema: resultOutputSchema({ error: optionalError }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId }) => {
        workspaces.getWorkspace(workspaceId);
        await managedCoachSidecar.stop(workspaceId);
        const saved=ctx.coachReviewEvents.coachFeedConfig();
        if(saved?.workspaceId===workspaceId)ctx.coachReviewEvents.clearCoachFeedConfig();
        const result = "Coach feed stopped.";
        return {
          content: [textBlock(result)],
          structuredContent: { result },
        };
      },
    );
  }

  registerAppTool(
    server,
    "coach_delivery_receipt",
    {
      title: "Inspect Chrome Coach delivery evidence",
      description: "Read one browser-submitted, bearer-authenticated event receipt after exact Sidecar event identity verification. A DOM submission receipt is not proof ChatGPT accepted the message or completed a review.",
      inputSchema: {workspaceId:workspaceIdSchema,eventId:z.number().int().positive()},
      outputSchema: resultOutputSchema({receipt:z.unknown().optional(),error:optionalError}),
      _meta:{},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },
    async ({workspaceId,eventId})=>{
      workspaces.getWorkspace(workspaceId);
      if(!managedCoachSidecar.getDeliveryReceipt)throw new Error("COACH_RECEIPT_READER_NOT_SUPPORTED");
      const receipt=await managedCoachSidecar.getDeliveryReceipt(workspaceId,eventId);
      const result=receipt?"Browser DOM submission receipt found.":"No verified browser receipt exists for this event.";
      return {content:[textBlock(result)],structuredContent:{result,...(receipt?{receipt}:{})}};
    }
  );

  registerAppTool(
    server,
    "coach_sidecar_status",
    {
      title: "Coach feed status",
      description:
        "Inspect a managed local event feed; the bearer token is never included.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema: resultOutputSchema({
        sidecar: z.unknown().optional(),
        error: optionalError,
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      workspaces.getWorkspace(workspaceId);
      const sidecar = await managedCoachSidecar.status(workspaceId);
      const result = sidecar ? "Coach feed is running." : "Coach feed is stopped.";
      return {
        content: [textBlock(result)],
        structuredContent: { result, ...(sidecar ? { sidecar } : {}) },
      };
    },
  );
}
