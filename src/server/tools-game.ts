import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MAX_GAME_LOG_READ_BYTES } from "../game-sessions.js";
import {
  resultOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  textBlock,
} from "./server-helpers.js";

function projectMemoryReceiptInputSchema() {
  return z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe(
      "Receipt ID returned by the latest Project Memory preflight for this task. SHADOW records missing or stale IDs but does not block the tool.",
    );
}

export function registerGameTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, games, widgetMeta } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "start_game_session",
    {
      title: "Start Godot game session",
      description:
        "Start one workspace-scoped Godot scene through the bundled loopback Runtime Bridge. DevSpace chooses the registered engine and constructs all process arguments.",
      inputSchema: {
        workspaceId: z.string(),
        projectPath: z.string().max(512),
        scene: z.string().max(512),
        engine: z.enum(["auto", "godot", "godot-mono"]).optional(),
        viewportWidth: z.number().int().min(64).max(4096).optional(),
        viewportHeight: z.number().int().min(64).max(4096).optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "start_game_session",
        projectMemoryReceiptId,
      );
      const session = await games.start({
        workspaceId,
        workspaceRoot: workspace.root,
        ...input,
      });
      const result =
        `Started ${session.sessionId}: ${session.scene} with ${session.engine} ${session.engineVersion ?? ""}`.trim();
      return {
        content: [textBlock(result)],
        _meta: { tool: "start_game_session", projectMemory },
        structuredContent: { result, session },
      };
    },
  );

  registerAppTool(
    server,
    "inspect_game_session",
    {
      title: "Inspect Godot game session",
      description:
        "Inspect session identity, pinned source snapshot, heartbeat, exit state, and a bounded scene tree containing only path/type/child-count/visibility.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sessionId, projectMemoryReceiptId }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "inspect_game_session",
        projectMemoryReceiptId,
      );
      workspaces.getWorkspace(workspaceId);
      const session = await games.inspect(workspaceId, sessionId);
      const result = `${session.sessionId}: ${session.status}; ${session.nodes?.length ?? 0} visible tree records.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "inspect_game_session", projectMemory },
        structuredContent: { result, session },
      };
    },
  );

  registerAppTool(
    server,
    "send_game_input",
    {
      title: "Send Godot game input",
      description:
        "Inject exactly one InputMap action or viewport-local mouse click into a DevSpace-owned Godot Session. No global desktop event is generated.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        input: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("action"),
            action: z.string().min(1).max(128),
            operation: z.enum(["press", "release", "tap"]),
            strength: z.number().min(0).max(1).optional(),
            frames: z.number().int().min(1).max(120).optional(),
          }),
          z.object({
            kind: z.literal("click"),
            x: z.number(),
            y: z.number(),
            button: z.enum(["left", "right", "middle"]),
          }),
        ]),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ accepted: z.literal(true) }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sessionId, input, projectMemoryReceiptId }) => {
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "send_game_input",
        projectMemoryReceiptId,
      );
      const accepted = await games.sendInput(workspaceId, sessionId, input);
      const result = `Input accepted by ${sessionId}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "send_game_input", projectMemory },
        structuredContent: { result, ...accepted },
      };
    },
  );

  registerAppTool(
    server,
    "capture_game_frame",
    {
      title: "Capture Godot game frame",
      description:
        "Capture the running Session viewport as PNG evidence in DevSpace private state and return bounded image content.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ frame: z.unknown() }),
      ...widgetMeta("capture_game_frame", "review"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sessionId, projectMemoryReceiptId }) => {
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "capture_game_frame",
        projectMemoryReceiptId,
      );
      const captured = await games.capture(workspaceId, sessionId);
      const { data, path: _privatePath, ...frame } = captured;
      const result = `Captured ${frame.frameId}: ${frame.width}x${frame.height}, sha256 ${frame.sha256}.`;
      return {
        content: [
          textBlock(result),
          { type: "image", data, mimeType: "image/png" },
        ],
        _meta: { tool: "capture_game_frame", projectMemory },
        structuredContent: { result, frame },
      };
    },
  );

  registerAppTool(
    server,
    "read_game_logs",
    {
      title: "Read Godot game logs",
      description:
        "Incrementally read merged stdout, stderr, Godot diagnostics, and Runtime Bridge lifecycle events by byte offset.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        offsetBytes: z.number().int().nonnegative().optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_GAME_LOG_READ_BYTES)
          .optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ logs: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      sessionId,
      offsetBytes,
      maxBytes,
      projectMemoryReceiptId,
    }) => {
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "read_game_logs",
        projectMemoryReceiptId,
      );
      const logs = games.readLogs(
        workspaceId,
        sessionId,
        offsetBytes,
        maxBytes,
      );
      const result = logs.output || "No new game logs.";
      return {
        content: [textBlock(result)],
        _meta: { tool: "read_game_logs", projectMemory },
        structuredContent: { result, logs },
      };
    },
  );

  registerAppTool(
    server,
    "stop_game_session",
    {
      title: "Stop Godot game session",
      description:
        "Request a graceful bridge shutdown, then terminate the verified DevSpace process group if needed. Repeated calls are idempotent.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sessionId, projectMemoryReceiptId }) => {
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "stop_game_session",
        projectMemoryReceiptId,
      );
      const session = await games.stop(workspaceId, sessionId);
      const result = `${session.sessionId}: ${session.status}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "stop_game_session", projectMemory },
        structuredContent: { result, session },
      };
    },
  );
}
