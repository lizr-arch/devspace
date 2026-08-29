import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../background-jobs.js";
import { checkManifestIntegrity, isTaskApproved } from "../task-manifest.js";
import {
  resultOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
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

export function registerProjectTaskTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, tasks } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "project_task",
    {
      title: "Run a declared project task",
      description:
        "Execute a task declared in the workspace's .devspace/tasks.yaml. Tasks are named, pre-approved commands with fixed arguments and optional declared parameters. The result always includes a task session ID. After a client interruption, recover it with list_task_sessions and continue with wait_task.",
      inputSchema: {
        workspaceId: z.string(),
        task: z.string().describe("Task ID from .devspace/tasks.yaml."),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe("Parameter values."),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ task: z.unknown() }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ workspaceId, task: taskId, params, projectMemoryReceiptId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "project_task",
        projectMemoryReceiptId,
      );
      const approved = workspace.approvedTasks;
      if (!approved)
        throw new Error("TASK_NOT_APPROVED: No manifest approved.");
      if (!checkManifestIntegrity(workspace.root, approved))
        throw new Error("TASK_MANIFEST_CHANGED: Re-approve required.");
      if (!isTaskApproved(taskId, approved))
        throw new Error(`TASK_NOT_APPROVED: ${taskId}.`);

      const result = await tasks.runTask({
        workspaceId,
        workspaceRoot: workspace.root,
        taskId,
        params: params ?? {},
        additionalRoots: workspace.additionalRoots,
      });
      const text =
        result.mode === "run"
          ? `Task ${result.taskId}: ${result.status} (exit ${result.exitCode}) in ${result.durationMs}ms. Session: ${result.sessionId}.`
          : `Task ${result.taskId}: session ${result.sessionId} started (pid ${result.pid}). Wait with wait_task; recover after interruption with list_task_sessions.`;
      logToolCall(config, {
        tool: "project_task",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(text)],
        _meta: { tool: "project_task", projectMemory },
        structuredContent: { result: text, task: result },
      };
    },
  );
}

export function registerTaskSessionReadOnlyTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, tasks } = ctx;

  registerAppTool(
    server,
    "list_task_sessions",
    {
      title: "List recent project task sessions",
      description:
        "List recent task sessions owned by one workspace. Use this after a client interruption to recover a missing session ID, then continue with wait_task.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the task sessions."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultOutputSchema({
        sessions: z.array(z.unknown()),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, limit }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const sessions = tasks
        .listSessions(workspaceId, limit ?? 20)
        .map(({ stdout, stderr, ...session }) => ({
          ...session,
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
        }));
      const result =
        sessions.length === 0
          ? "No task sessions found for this workspace."
          : sessions
              .map(
                (session) =>
                  `${session.sessionId}: ${session.taskId} ${session.status}${session.exitCode !== undefined ? ` (exit ${session.exitCode})` : ""}; started ${session.startedAt}.`,
              )
              .join("\n");
      logToolCall(config, {
        tool: "list_task_sessions",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {},
        structuredContent: { result, sessions },
      };
    },
  );

  registerAppTool(
    server,
    "wait_task",
    {
      title: "Wait for a project task session",
      description: `Wait up to ${DEFAULT_WAIT_SECONDS} seconds for a project task session to settle and return its current status and bounded output tail. If the client reconnects without a session ID, call list_task_sessions first.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the task session."),
        sessionId: z.string().describe("Task session ID from project_task."),
        waitSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional(),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, sessionId, waitSeconds }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const existing = tasks.getSession(sessionId);
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error(`TASK_SESSION_NOT_FOUND: ${sessionId}`);
      }
      const session = await tasks.waitSession(
        sessionId,
        (waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
      );
      if (!session || session.workspaceId !== workspaceId) {
        throw new Error(`TASK_SESSION_NOT_FOUND: ${sessionId}`);
      }
      const output = session.stdout.slice(-8000) + session.stderr.slice(-2000);
      const result = [
        `Task ${session.taskId}: ${session.status}. Session: ${session.sessionId}.`,
        session.exitCode !== undefined
          ? `Exit code: ${session.exitCode}.`
          : undefined,
        output ? `Latest output:\n${output}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      logToolCall(config, {
        tool: "wait_task",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {},
        structuredContent: { result, session },
      };
    },
  );

  registerAppTool(
    server,
    "poll_task",
    {
      title: "Poll a running task session",
      description:
        "Check the status and recent output of a running task session.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the task session."),
        sessionId: z.string().describe("Task session ID from project_task."),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, sessionId }) => {
      workspaces.getWorkspace(workspaceId);
      const session = tasks.getSession(sessionId);
      if (!session || session.workspaceId !== workspaceId)
        throw new Error(`TASK_SESSION_NOT_FOUND: ${sessionId}`);
      const output = session.stdout.slice(-8000) + session.stderr.slice(-2000);
      return {
        content: [
          textBlock(`Task ${session.taskId}: ${session.status}\n${output}`),
        ],
        _meta: {},
        structuredContent: { result: output, session },
      };
    },
  );
}

export function registerTaskSessionMutationTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, tasks } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "stop_task",
    {
      title: "Stop a running task session",
      description: "Terminate a running task session.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the task session."),
        sessionId: z.string().describe("Task session ID from project_task."),
      },
      outputSchema: resultOutputSchema({ stopped: z.boolean() }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ workspaceId, sessionId }) => {
      workspaces.getWorkspace(workspaceId);
      const session = tasks.getSession(sessionId);
      if (!session || session.workspaceId !== workspaceId) {
        throw new Error(`TASK_SESSION_NOT_FOUND: ${sessionId}`);
      }
      const stopped = tasks.stopSession(sessionId);
      return {
        content: [textBlock(stopped ? "Stopped." : "Not found.")],
        _meta: {},
        structuredContent: {
          result: stopped ? "stopped" : "not_found",
          stopped,
        },
      };
    },
  );

  registerAppTool(
    server,
    "approve_task_manifest",
    {
      title: "Approve task manifest",
      description:
        "Approve tasks from .devspace/tasks.yaml. Records manifest SHA; changes invalidate approval.",
      inputSchema: {
        workspaceId: z.string(),
        taskIds: z.array(z.string()),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ approved: z.unknown() }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ workspaceId, taskIds, projectMemoryReceiptId }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "approve_task_manifest",
        projectMemoryReceiptId,
      );
      const approved = workspaces.approveTaskManifest(workspaceId, taskIds);
      if (!approved) throw new Error("TASK_APPROVAL_FAILED.");
      const result = `Approved ${taskIds.length} task(s). SHA: ${approved.manifestSha256}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "approve_task_manifest", projectMemory },
        structuredContent: { result, approved },
      };
    },
  );
}

export function registerTaskTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerProjectTaskTool(server, ctx);
  registerTaskSessionReadOnlyTools(server, ctx);
  registerTaskSessionMutationTools(server, ctx);
}
