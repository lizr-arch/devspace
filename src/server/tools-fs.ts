import { existsSync, lstatSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  editFileTool,
  readFileTool,
  writeFileTool,
} from "../pi-tools.js";
import { moveWorkspacePathToTrash } from "../workspace-files.js";
import {
  resultOutputSchema,
  WRITE_TOOL_ANNOTATIONS,
  EDIT_TOOL_ANNOTATIONS,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  logFailedToolResponse,
  textBlock,
  contentText,
  textSummary,
  contentLineCount,
  countDiffStats,
  newFilePatch,
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

export function registerFsReadTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const {
    config,
    workspaces,
    runtime,
    toolNames,
    widgetMeta,
  } = ctx;

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: [
        "Read a file inside an open workspace or authorized additional root. Relative paths use the workspace root; absolute paths may select an additional root. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
        "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
        config.skillsEnabled
          ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "Workspace-relative path, absolute path inside an authorized additional root, or an advertised skill path from open_workspace skills."
              : "Workspace-relative path, or an absolute path inside an authorized additional root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.read, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.read,
        projectMemoryReceiptId,
      );
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          projectMemory,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
}

export function registerFsWriteTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const {
    config,
    workspaces,
    runtime,
    toolNames,
    widgetMeta,
  } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description: `Create a file inside an open workspace or writable additional root. Existing files are rejected unless overwrite=true; prefer ${toolNames.edit} for targeted changes. Relative paths use the workspace root; absolute paths may select an authorized additional root.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            "Workspace-relative path, or an absolute path inside an authorized writable additional root.",
          ),
        content: z.string().describe("Complete new file content."),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Defaults to false. Set true only for an intentional complete rewrite.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.write, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.write,
        projectMemoryReceiptId,
      );
      const destination = workspaces.resolveWritePath(workspace, input.path);
      if (existsSync(destination.absolutePath)) {
        const target = lstatSync(destination.absolutePath);
        if (target.isSymbolicLink() || !target.isFile()) {
          throw new Error(
            "PATH_TYPE_REJECTED: Write destination must be a regular file.",
          );
        }
        if (!input.overwrite) {
          throw new Error(
            "PATH_EXISTS: Destination exists; set overwrite=true or use edit.",
          );
        }
        await moveWorkspacePathToTrash({
          workspaceRoot: destination.rootPath,
          stateDir: config.stateDir,
          workspaceId,
          path: destination.relativePath,
        });
      }
      const response = await writeFileTool(
        { ...input, path: destination.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          writeRoots: [destination.rootPath],
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          projectMemory,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
}

export function registerFsEditTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const {
    config,
    workspaces,
    runtime,
    toolNames,
    widgetMeta,
  } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description: `Edit one file inside an open workspace or writable additional root by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file. Relative paths use the workspace root; absolute paths may select an authorized additional root.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            "Workspace-relative path, or an absolute path inside an authorized writable additional root.",
          ),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...widgetMeta(toolNames.edit, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.edit,
        projectMemoryReceiptId,
      );
      const editPath = workspaces.resolveWritePath(workspace, input.path);
      const response = await editFileTool(
        { ...input, path: editPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          writeRoots: [editPath.rootPath],
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          projectMemory,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
}

export function registerFsReviewTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const {
    config,
    workspaces,
    reviewCheckpoints,
    widgetMeta,
  } = ctx;

  if (config.widgets !== "changes") return;

  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show aggregate file changes in an open workspace since the last shown checkpoint or since the workspace was opened. After you create, edit, or overwrite files, call this once when the related file changes are complete so the user can inspect the combined diff.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        since: z
          .enum(["last_shown", "workspace_open"])
          .optional()
          .describe(
            "Defaults to last_shown. Use workspace_open to compare against the initial open_workspace checkpoint.",
          ),
        markReviewed: z
          .boolean()
          .optional()
          .describe(
            "Defaults to true. When true, advances the last shown checkpoint to the current workspace state.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta("show_changes", "show_changes"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, since, markReviewed, projectMemoryReceiptId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "show_changes",
        projectMemoryReceiptId,
      );
      const review = await reviewCheckpoints.reviewChanges({
        workspaceId,
        root: workspace.root,
        since: since ?? "last_shown",
        markReviewed: markReviewed ?? true,
      });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: "show_changes",
          projectMemory,
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          result: contentText(content),
        },
      };
    },
  );
}
