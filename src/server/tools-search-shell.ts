import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  runShellTool,
} from "../pi-tools.js";
import {
  resultOutputSchema,
  SHELL_TOOL_ANNOTATIONS,
  EXPOSE_LEGACY_SHELL,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  logFailedToolResponse,
  contentText,
  textSummary,
  exposeDedicatedReadTools,
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

export function registerFsSearchTools(
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

  if (!exposeDedicatedReadTools(config)) return;

  registerAppTool(
    server,
    toolNames.grep,
    {
      title: config.toolNaming === "short" ? "Grep" : "Grep files",
      description:
        "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("Search pattern."),
        path: z
          .string()
          .optional()
          .describe(
            "Optional workspace-relative scope, or an absolute path inside an authorized additional root.",
          ),
        include: z.string().optional().describe("Optional include glob."),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.grep, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.grep,
        projectMemoryReceiptId,
      );
      const grepPath = input.path
        ? workspaces.resolveReadPath(workspace, input.path)
        : undefined;
      const response = await grepFilesTool(
        {
          ...input,
          path: grepPath?.absolutePath,
        },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: grepPath?.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.grep,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.grep,
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

  registerAppTool(
    server,
    toolNames.glob,
    {
      title: config.toolNaming === "short" ? "Glob" : "Find files",
      description:
        "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("File glob pattern."),
        path: z
          .string()
          .optional()
          .describe(
            "Optional workspace-relative scope, or an absolute path inside an authorized additional root.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.glob, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.glob,
        projectMemoryReceiptId,
      );
      const findPath = input.path
        ? workspaces.resolveReadPath(workspace, input.path)
        : undefined;
      const response = await findFilesTool(
        {
          ...input,
          path: findPath?.absolutePath,
        },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: findPath?.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.glob,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.glob,
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

  registerAppTool(
    server,
    toolNames.ls,
    {
      title: config.toolNaming === "short" ? "Ls" : "List directory",
      description:
        "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            "Workspace-relative directory, or an absolute directory inside an authorized additional root.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.ls, "directory"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, projectMemoryReceiptId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.ls,
        projectMemoryReceiptId,
      );
      const listPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await listDirectoryTool(
        { ...input, path: listPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: listPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const summary = textSummary(response.content);
      logToolCall(config, {
        tool: toolNames.ls,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.ls,
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

export function registerFsShellTool(
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

  if (config.readOnly || !EXPOSE_LEGACY_SHELL) return;

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: config.toolNaming === "short" ? "Bash" : "Run shell",
      description: config.minimalTools
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema(),
      ...widgetMeta(toolNames.shell, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      workingDirectory,
      projectMemoryReceiptId,
      ...input
    }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        toolNames.shell,
        projectMemoryReceiptId,
      );
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
          },
          response.content,
          startedAt,
          runtime.monitorEvents,
        );
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          projectMemory,
          card: {
            workspaceId,
            path: workingDirectory,
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
