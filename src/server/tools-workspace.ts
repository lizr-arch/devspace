import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { normalizeAdditionalRoots } from "../roots.js";
import {
  resultOutputSchema,
  workspaceSessionOutputSchema,
  workspaceContextOutputSchema,
  projectMemoryPreflightOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  textBlock,
  workspaceContextToolResponse,
} from "./server-helpers.js";

export function registerWorkspaceListTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces } = ctx;

  registerAppTool(
    server,
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List recent persisted workspace sessions that remain inside the current filesystem policy. Use this after reconnecting or restarting, then pass a resumable workspaceId to resume_workspace. Missing managed worktrees are reported but never recreated. Managed worktree branch/detached state is probed live. Additional-root grants are in-memory only; active grants are reported, while a restarted service reports an empty effective set.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum recent sessions to return. Defaults to 20."),
      },
      outputSchema: resultOutputSchema({
        workspaces: z.array(workspaceSessionOutputSchema),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      const startedAt = performance.now();
      const sessions = await workspaces.listWorkspaces(limit ?? 20);
      const result =
        sessions.length === 0
          ? "No resumable workspace sessions are available."
          : sessions
              .map(
                (session) =>
                  `${session.workspaceId} | ${session.mode} | ${session.resumable ? "resumable" : "unavailable"} | ${session.root}`,
              )
              .join("\n");
      logToolCall(config, {
        tool: "list_workspaces",
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: { tool: "list_workspaces" },
        structuredContent: { result, workspaces: sessions },
      };
    },
  );
}

export function registerWorkspaceCoreTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, reviewCheckpoints, toolNames, widgetMeta } = ctx;

  registerAppTool(
    server,
    "resume_workspace",
    {
      title: "Resume workspace",
      description:
        "Verify an existing workspaceId and obtain its latest instructions without creating a new session. Use this immediately after reconnecting, switching tasks, or recovering a session from list_workspaces. Managed worktrees are verified to exist on disk; missing worktrees cannot be resumed and require open_workspace. In-memory additional roots can be refreshed on resume. If a task is supplied, DevSpace preflights SHADOW Project Memory and returns the bounded bundle once.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        task: z
          .string()
          .optional()
          .describe(
            "Optional new coding task. When configured, DevSpace runs SHADOW Project Memory preflight and returns the bundle once. Task text is not persisted.",
          ),
        additionalRoots: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe("Absolute path to an additional root directory."),
              access: z
                .enum(["inherit", "read_only", "read_write"])
                .optional()
                .describe(
                  "Optional access override. Defaults to inherit, which uses the workspace root's effective access.",
                ),
            }),
          )
          .optional()
          .describe(
            "Replacement set of in-memory additional-root grants. Roots inherit workspace access unless access overrides it. An empty array clears current grants. If any root is rejected, the requested set is not partially applied; inspect requestedAdditionalRoots, effectiveAdditionalRoots, and rejectedAdditionalRoots.",
          ),
      },
      outputSchema: workspaceContextOutputSchema,
      ...widgetMeta("resume_workspace", "workspace"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, task, additionalRoots }) => {
      const startedAt = performance.now();
      const parsedRoots = normalizeAdditionalRoots(additionalRoots);
      const context = await workspaces.resumeWorkspace(
        workspaceId,
        task,
        parsedRoots,
      );
      return workspaceContextToolResponse({
        action: "resume_workspace",
        actionLabel: "Resumed",
        config,
        toolNames,
        reviewCheckpoints,
        context,
        task,
        startedAt,
      });
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description: config.readOnly
        ? 'Open a local project directory as a read-only coding workspace. Call this once per project folder or worktree before reading, searching, listing directories, or showing changes. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode="worktree" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.'
        : 'Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode="worktree" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.',
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe(
            'Git ref to base a worktree on. Only used with mode="worktree". Defaults to HEAD.',
          ),
        task: z
          .string()
          .optional()
          .describe(
            "Current coding task. For an operator-configured repository, DevSpace runs SHADOW Project Memory preflight and returns the bounded bundle once. Task text is not persisted.",
          ),
        additionalRoots: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe("Absolute path to an additional root directory."),
              access: z
                .enum(["inherit", "read_only", "read_write"])
                .optional()
                .describe(
                  "Optional access override. Defaults to inherit, which uses the workspace root's effective access.",
                ),
            }),
          )
          .optional()
          .describe(
            "In-memory additional-root grants for this workspace. Each root inherits workspace access unless access overrides it. Junction and symlink targets are canonicalized. If any root is rejected, none of the requested grants take effect; inspect the requested/effective/rejected result fields.",
          ),
      },
      outputSchema: workspaceContextOutputSchema,
      ...widgetMeta("open_workspace", "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef, task, additionalRoots }) => {
      const startedAt = performance.now();
      const parsedRoots = normalizeAdditionalRoots(additionalRoots);
      const context = await workspaces.openWorkspace({
        path,
        mode,
        baseRef,
        task,
        additionalRoots: parsedRoots,
      });
      return workspaceContextToolResponse({
        action: "open_workspace",
        actionLabel: "Opened",
        config,
        toolNames,
        reviewCheckpoints,
        context,
        task,
        startedAt,
      });
    },
  );

  registerAppTool(
    server,
    "project_memory_preflight",
    {
      title: "Project Memory preflight",
      description:
        "Refresh SHADOW Project Memory context for a new task in an open workspace. The task is sent only to the operator-configured repository command and is not persisted. Returns the bounded bundle once and a receipt ID for later tool calls. SHADOW observations never block existing tools.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        task: z.string().min(1).describe("The current coding task."),
      },
      outputSchema: {
        result: z.string(),
        projectMemory: projectMemoryPreflightOutputSchema,
      },
      ...widgetMeta("project_memory_preflight", "project_memory"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, task }) => {
      const startedAt = performance.now();
      const projectMemory = await workspaces.preflightProjectMemory(
        workspaceId,
        task,
      );
      const lines = [
        `Project Memory SHADOW status: ${projectMemory.status}`,
        `Decision: ${projectMemory.decision ?? "none"}`,
        `Would deny: ${String(projectMemory.wouldDeny)}`,
        `Receipt: ${projectMemory.receiptId ?? "none"}`,
        projectMemory.denialReasons.length > 0
          ? `Reasons: ${projectMemory.denialReasons.join(", ")}`
          : undefined,
        projectMemory.bundle
          ? `Project Memory bundle (first delivery only):\n${JSON.stringify(projectMemory.bundle, null, 2)}`
          : undefined,
        projectMemory.error,
      ].filter((line): line is string => Boolean(line));
      const result = lines.join("\n");
      logToolCall(config, {
        tool: "project_memory_preflight",
        workspaceId,
        success: projectMemory.status !== "error",
        durationMs: Math.round(performance.now() - startedAt),
        error: projectMemory.error,
      });
      return {
        content: [textBlock(result)],
        _meta: {
          tool: "project_memory_preflight",
          projectMemory: {
            receiptId: projectMemory.receiptId,
            decision: projectMemory.decision,
            wouldDeny: projectMemory.wouldDeny,
          },
        },
        structuredContent: { result, projectMemory },
      };
    },
  );
}

export function registerWorkspaceTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerWorkspaceListTools(server, ctx);
  registerWorkspaceCoreTools(server, ctx);
}
