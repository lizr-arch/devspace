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
          "Start a dedicated, token-protected, in-process readonly event feed on 127.0.0.1. The one-time pairing token is returned only on successful start.",
        inputSchema: {
          workspaceId: workspaceIdSchema,
          port: portSchema,
          pairedExtensionId: extensionIdSchema,
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
      async ({ workspaceId, port, pairedExtensionId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const started = await managedCoachSidecar.start({
          workspaceId,
          workspaceRoot: workspace.root,
          port,
          pairedExtensionId,
        });
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
      const sidecar = managedCoachSidecar.status(workspaceId);
      const result = sidecar ? "Coach feed is running." : "Coach feed is stopped.";
      return {
        content: [textBlock(result)],
        structuredContent: { result, ...(sidecar ? { sidecar } : {}) },
      };
    },
  );
}
