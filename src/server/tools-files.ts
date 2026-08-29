import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  copyWorkspacePath,
  createWorkspaceDirectory,
  moveWorkspacePath,
  moveWorkspacePathToTrash,
} from "../workspace-files.js";
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

export function registerFileOpsTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "mkdir",
    {
      title: "Create directory",
      description:
        "Create a real nested directory inside the workspace or a writable additional root. Relative paths use the workspace root.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ operation: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, projectMemoryReceiptId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "mkdir",
        projectMemoryReceiptId,
      );
      const destination = workspaces.resolveWritePath(workspace, path);
      const operation = await createWorkspaceDirectory(
        destination.rootPath,
        destination.relativePath,
      );
      const result = `${operation.created ? "Created" : "Exists"}: ${operation.path}`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "mkdir", projectMemory },
        structuredContent: { result, operation },
      };
    },
  );

  registerAppTool(
    server,
    "copy",
    {
      title: "Copy path",
      description:
        "Copy a regular file or symlink-free directory tree between the workspace and authorized additional roots. The source requires read access and the destination requires write access.",
      inputSchema: {
        workspaceId: z.string(),
        sourcePath: z.string().max(512),
        destinationPath: z.string().max(512),
        overwrite: z.boolean().optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ operation: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      sourcePath,
      destinationPath,
      overwrite,
      projectMemoryReceiptId,
    }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "copy",
        projectMemoryReceiptId,
      );
      const source = workspaces.resolveWorkspacePath(
        workspace,
        sourcePath,
        "read",
      );
      const destination = workspaces.resolveWritePath(
        workspace,
        destinationPath,
      );
      const operation = await copyWorkspacePath({
        workspaceRoot: workspace.root,
        sourceRoot: source.rootPath,
        destinationRoot: destination.rootPath,
        stateDir: config.stateDir,
        workspaceId,
        sourcePath: source.relativePath,
        destinationPath: destination.relativePath,
        overwrite,
      });
      const result = `Copied ${operation.sourcePath} to ${operation.destinationPath}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "copy", projectMemory },
        structuredContent: { result, operation },
      };
    },
  );

  registerAppTool(
    server,
    "move",
    {
      title: "Move path",
      description:
        "Atomically move a regular file or real directory between writable workspace roots. Cross-device moves and directory replacement are prohibited.",
      inputSchema: {
        workspaceId: z.string(),
        sourcePath: z.string().max(512),
        destinationPath: z.string().max(512),
        overwrite: z.boolean().optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ operation: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      sourcePath,
      destinationPath,
      overwrite,
      projectMemoryReceiptId,
    }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "move",
        projectMemoryReceiptId,
      );
      const source = workspaces.resolveWritePath(workspace, sourcePath);
      const destination = workspaces.resolveWritePath(
        workspace,
        destinationPath,
      );
      const operation = await moveWorkspacePath({
        workspaceRoot: workspace.root,
        sourceRoot: source.rootPath,
        destinationRoot: destination.rootPath,
        stateDir: config.stateDir,
        workspaceId,
        sourcePath: source.relativePath,
        destinationPath: destination.relativePath,
        overwrite,
      });
      const result = `Moved ${operation.sourcePath} to ${operation.destinationPath}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "move", projectMemory },
        structuredContent: { result, operation },
      };
    },
  );

  registerAppTool(
    server,
    "move_to_trash",
    {
      title: "Move to trash",
      description:
        "Move a file or directory from the workspace or a writable additional root into the private DevSpace quarantine. No permanent deletion is performed.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().max(512),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ trash: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, projectMemoryReceiptId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "move_to_trash",
        projectMemoryReceiptId,
      );
      const source = workspaces.resolveWritePath(workspace, path);
      const trash = await moveWorkspacePathToTrash({
        workspaceRoot: source.rootPath,
        stateDir: config.stateDir,
        workspaceId,
        path: source.relativePath,
      });
      const result = `Moved ${trash.originalPath} to quarantine as ${trash.trashId}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "move_to_trash", projectMemory },
        structuredContent: { result, trash },
      };
    },
  );
}
