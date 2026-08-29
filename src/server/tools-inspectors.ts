import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { inspectAudio, inspectGlb } from "../inspectors.js";
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

export function registerGlbInspectorTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { workspaces, widgetMeta } = ctx;

  registerAppTool(
    server,
    "inspect_glb",
    {
      title: "Inspect GLB",
      description:
        "Parse a workspace GLB v2 header and JSON chunk directly in TypeScript without executing external code.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ inspection: z.unknown() }),
      ...widgetMeta("inspect_glb", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, projectMemoryReceiptId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "inspect_glb",
        projectMemoryReceiptId,
      );
      const inspection = inspectGlb(workspace.root, path);
      const result = `GLB ${path}: ${inspection.meshCount ?? 0} meshes, ${inspection.triangleCount ?? 0} triangles.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "inspect_glb", projectMemory },
        structuredContent: { result, inspection },
      };
    },
  );
}

export function registerOtherInspectorTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, inspectors, widgetMeta } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "inspect_blend",
    {
      title: "Inspect BLEND",
      description:
        "Open a workspace BLEND using the fixed bundled offline Blender inspector with auto-execution disabled. The source is never saved.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ inspection: z.unknown() }),
      ...widgetMeta("inspect_blend", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, projectMemoryReceiptId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "inspect_blend",
        projectMemoryReceiptId,
      );
      const inspection = await inspectors.inspectBlend(workspace.root, path);
      const result = `BLEND ${path}: ${inspection.objectCount ?? 0} objects, ${inspection.meshCount ?? 0} meshes.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "inspect_blend", projectMemory },
        structuredContent: { result, inspection },
      };
    },
  );

  registerAppTool(
    server,
    "inspect_audio",
    {
      title: "Inspect audio",
      description:
        "Read WAV/OGG metadata and use a fixed ffmpeg float-PCM decode to calculate peak and clipping metrics.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ inspection: z.unknown() }),
      ...widgetMeta("inspect_audio", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, projectMemoryReceiptId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "inspect_audio",
        projectMemoryReceiptId,
      );
      const inspection = await inspectAudio(workspace.root, path);
      const result = `Audio ${path}: ${inspection.durationSeconds ?? "unknown"}s, peak ${inspection.peakDbfs ?? "-inf"} dBFS.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "inspect_audio", projectMemory },
        structuredContent: { result, inspection },
      };
    },
  );

  registerAppTool(
    server,
    "render_model_preview",
    {
      title: "Render model preview",
      description:
        "Render a BLEND or GLB using a fixed camera, lighting, background, and bounded dimensions into private DevSpace evidence.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        view: z.enum(["perspective", "front", "right", "top"]).optional(),
        width: z.number().int().min(64).max(2048).optional(),
        height: z.number().int().min(64).max(2048).optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ preview: z.unknown() }),
      ...widgetMeta("render_model_preview", "review"),
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
        "render_model_preview",
        projectMemoryReceiptId,
      );
      const rendered = await inspectors.renderModelPreview({
        workspaceRoot: workspace.root,
        ...input,
      });
      const { data, ...preview } = rendered;
      const result = `Rendered ${preview.path}: ${preview.width}x${preview.height}, sha256 ${preview.sha256}.`;
      return {
        content: [
          textBlock(result),
          { type: "image", data, mimeType: "image/png" },
        ],
        _meta: { tool: "render_model_preview", projectMemory },
        structuredContent: { result, preview },
      };
    },
  );
}

export function registerInspectorTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerGlbInspectorTool(server, ctx);
  registerOtherInspectorTools(server, ctx);
}
