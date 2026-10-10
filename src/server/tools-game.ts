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

const MOUSE_BUTTON_SCHEMA = z.enum(["left", "right", "middle"]);
const MODIFIER_SCHEMA = z
  .object({
    shift: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    meta: z.boolean().optional(),
  })
  .optional()
  .describe("Modifier keys held for this event.");

const POINTER_STEP_FIELDS = {
  x: z.number().describe("Viewport-local X coordinate."),
  y: z.number().describe("Viewport-local Y coordinate."),
  button: MOUSE_BUTTON_SCHEMA.optional(),
  wheelDirection: z.enum(["up", "down", "left", "right"]).optional(),
  factor: z.number().optional().describe("Wheel notch strength."),
  modifiers: MODIFIER_SCHEMA,
};

const KEY_STEP_FIELDS = {
  key: z
    .string()
    .min(1)
    .max(64)
    .describe('Godot key name, for example "W", "Escape", "Space", "Control".'),
  text: z
    .string()
    .min(1)
    .max(2)
    .optional()
    .describe(
      "Character this key inserts into a focused text field. Required to type into dialogs, because Godot inserts from the key's unicode value. Defaults to the key when it is a single printable character.",
    ),
  physical: z
    .boolean()
    .optional()
    .describe("Use the physical (layout-independent) keycode."),
  echo: z.boolean().optional(),
  modifiers: MODIFIER_SCHEMA,
};

function gameInputSchema() {
  return z.discriminatedUnion("kind", [
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
      button: MOUSE_BUTTON_SCHEMA,
    }),
    z.object({
      kind: z.literal("pointer"),
      event: z.enum(["down", "up", "move", "wheel", "double_click"]),
      ...POINTER_STEP_FIELDS,
    }),
    z.object({
      kind: z.literal("key"),
      event: z.enum(["press", "release", "tap"]),
      ...KEY_STEP_FIELDS,
    }),
    z.object({
      kind: z.literal("sequence"),
      steps: z
        .array(
          z.discriminatedUnion("type", [
            z.object({
              type: z.literal("pointer"),
              event: z.enum(["down", "up", "move", "wheel", "double_click"]),
              frameDelay: z.number().int().min(0).max(600).optional(),
              ...POINTER_STEP_FIELDS,
            }),
            z.object({
              type: z.literal("key"),
              event: z.enum(["press", "release", "tap"]),
              frameDelay: z.number().int().min(0).max(600).optional(),
              ...KEY_STEP_FIELDS,
            }),
            z.object({
              type: z.literal("action"),
              action: z.string().min(1).max(128),
              operation: z.enum(["press", "release", "tap"]),
              strength: z.number().min(0).max(1).optional(),
              frames: z.number().int().min(1).max(120).optional(),
              frameDelay: z.number().int().min(0).max(600).optional(),
            }),
            z.object({
              type: z.literal("wait"),
              frameDelay: z.number().int().min(0).max(600).optional(),
            }),
          ]),
        )
        .min(1)
        .max(256)
        .describe(
          "Ordered steps, dispatched one per engine frame. Use this for drags, wheel bursts and modifier chords.",
        ),
      releaseAtEnd: z
        .boolean()
        .optional()
        .describe(
          "Release every latched key/button/action when the sequence finishes. Defaults to true.",
        ),
    }),
    z.object({ kind: z.literal("release_all") }),
  ]);
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
        "Inject input into a DevSpace-owned Godot Session. Supports InputMap actions, single clicks, pointer down/up/move/wheel/double-click, keyboard press/release with modifiers, ordered multi-step sequences, and release_all. No global desktop event is generated. Latched keys and buttons are always released on sequence end, session stop, and host disconnect.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        input: gameInputSchema(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        accepted: z.literal(true),
        pressedInput: z.unknown().optional(),
      }),
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
        "Capture the running Session viewport as PNG evidence in DevSpace private state and return bounded image content. A machine-readable manifest is written beside the PNG with engine, renderer, scene, git, resolution, SHA256 and frame timing. Frames whose engine renderer is headless or dummy are reported as guiVerdict=headless_not_gui and are not GUI visual evidence.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        waitFrames: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe(
            "Engine frames to let elapse before reading the framebuffer, so the capture reflects input already injected. Defaults to 2.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        frame: z.unknown(),
        manifest: z.unknown(),
      }),
      ...widgetMeta("capture_game_frame", "review"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      sessionId,
      waitFrames,
      projectMemoryReceiptId,
    }) => {
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "capture_game_frame",
        projectMemoryReceiptId,
      );
      const captured = await games.capture(workspaceId, sessionId, {
        waitFrames,
      });
      const { data, path: _privatePath, manifest, ...frame } = captured;
      const result =
        `Captured ${frame.frameId}: ${frame.width}x${frame.height}, sha256 ${frame.sha256}, ` +
        `gui=${manifest.guiVerdict}, driver=${manifest.render === "unknown" ? "unknown" : manifest.render.renderingDriver}, ` +
        `scene=${manifest.scene}, head=${manifest.git.headSha}, manifest=${frame.frameId}.manifest.json`;
      return {
        content: [
          textBlock(result),
          { type: "image", data, mimeType: "image/png" },
        ],
        _meta: { tool: "capture_game_frame", projectMemory },
        structuredContent: { result, frame, manifest },
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
