import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { normalizeAdditionalRoots } from "../roots.js";
import {
  resultOutputSchema,
  toolErrorOutputSchema,
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

function projectMemoryReceiptInputSchema() {
  return z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe(
      "Receipt ID returned by the latest Project Memory preflight for this task. SHADOW records missing or stale IDs but does not block the tool.",
    );
}

export function registerWorkspaceListTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, jobs, games, tasks } = ctx;

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
        audit: z
          .boolean()
          .optional()
          .describe(
            "Include a read-only lifecycle audit: real state derived from disk, Git and live runtime activity, uncommitted/untracked/unmerged/active-job risks, a single cleanup verdict, and whether each workspace is a safe reclamation CANDIDATE. The persisted status column is never trusted.",
          ),
        cleanupPlan: z
          .boolean()
          .optional()
          .describe(
            "Return the unified, strictly read-only cleanup plan in structuredContent.cleanupPlan: one verdict per workspace plus the associated local branch's safe-delete eligibility. Selecting this never deletes anything.",
          ),
        includeOrphans: z
          .boolean()
          .optional()
          .describe(
            "With audit=true, also inventory directories under the managed worktree root that NO workspace record mentions. These are invisible to every other tool. Read-only: nothing is removed, and each entry reports whether Git still references it, whether it holds uncommitted or unmerged work, and whether a job is running in it.",
          ),
      },
      outputSchema: resultOutputSchema({
        workspaces: z.array(workspaceSessionOutputSchema),
        audits: z.array(z.unknown()).optional(),
        orphanedWorktrees: z.unknown().optional(),
        cleanupPlan: z.unknown().optional(),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit, audit, cleanupPlan, includeOrphans }) => {
      const startedAt = performance.now();
      const sessions = await workspaces.listWorkspaces(limit ?? 20);
      const audits = audit
        ? await workspaces.auditWorkspaces({
            limit: limit ?? 20,
            activeJobRoots: (root) => jobs.activeJobIdsForRoot(root),
          })
        : undefined;
      const orphanAudit =
        audit && includeOrphans
          ? await workspaces.orphanedWorktreeAudit({
              activeJobRoots: (root) => jobs.activeJobIdsForRoot(root),
            })
          : undefined;
      const plan = cleanupPlan
        ? await workspaces.cleanupPlan({
            limit: limit ?? 20,
            includeOrphans: includeOrphans ?? false,
          })
        : undefined;
      const base =
        sessions.length === 0
          ? "No resumable workspace sessions are available."
          : sessions
              .map(
                (session) =>
                  `${session.workspaceId} | ${session.mode} | ${session.lifecycleState} | ${session.resumable ? "resumable" : "unavailable"} | ${session.root}`,
              )
              .join("\n");
      const auditText = audits?.length
        ? "\n\n" +
          audits
            .map((entry) => {
              const risks = entry.risks.map((risk) => risk.code).join(",") || "none";
              const activity = [
                entry.hasActiveSession ? "live" : "no-live-owner",
                entry.activeJobIds.length > 0
                  ? `jobs=${entry.activeJobIds.join(",")}`
                  : undefined,
                entry.activeGameSessionIds.length > 0
                  ? `games=${entry.activeGameSessionIds.join(",")}`
                  : undefined,
                entry.activeTaskSessionIds.length > 0
                  ? `tasks=${entry.activeTaskSessionIds.join(",")}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" ");
              return `${entry.workspaceId ?? "(orphan)"} | ${entry.verdict} | ${entry.lifecycle} | session=${entry.sessionState ?? "none"} (${activity}) | lastUsed=${entry.lastUsedAt ?? "unknown"} | dirty=${entry.dirtyFileCount} untracked=${entry.untrackedFileCount} unmerged=${entry.unmergedCommitCount} | risks=${risks} | ${entry.reclaimable ? "RECLAIM_CANDIDATE" : `keep: ${entry.blockedReasons.join("; ") || "see risks"}`}`;
            })
            .join("\n")
        : "";
      const planText = plan
        ? "\n\nCleanup plan (read-only; nothing is deleted by reading this):\n" +
          [
            `  auditedAt=${plan.auditedAt}`,
            ...Object.entries(plan.summary)
              .filter(([key]) => key !== "TOTAL")
              .map(([key, value]) => `  ${key}=${value}`),
            ...plan.entries.map(
              (entry) =>
                `  ${entry.verdict} | ${entry.workspaceId ?? "(orphan)"} | branch=${entry.branch ?? "(detached)"} | head=${entry.headSha ?? "unknown"} | branchDelete=${entry.branchDelete?.verdict ?? "n/a"}`,
            ),
            `  orphaned worktree directories: ${plan.orphans.orphanedCount} of ${plan.orphans.directoryCount} under ${plan.orphans.worktreeRoot}${plan.orphans.truncated ? " (truncated)" : ""}`,
          ].join("\n")
        : "";
      const orphanText = orphanAudit
        ? "\n\n" +
          [
            `Orphaned worktree directories (no workspace record): ${orphanAudit.scan.orphaned.length} of ${orphanAudit.scan.directories.length} under ${orphanAudit.scan.worktreeRoot}`,
            ...orphanAudit.audits.map((entry) => {
              const risks =
                entry.risks.map((risk) => risk.code).join(",") || "none";
              return `  ${entry.root} | ${entry.verdict} | gitRegistered=${entry.risks.some((r) => r.code === "not_a_worktree") ? "no" : "yes"} | dirty=${entry.dirtyFileCount} untracked=${entry.untrackedFileCount} unmerged=${entry.unmergedCommitCount} | risks=${risks}`;
            }),
            orphanAudit.truncated
              ? "  (truncated; raise the limit for the full inventory)"
              : "",
            "  Read-only inventory. Nothing has been removed.",
          ]
            .filter(Boolean)
            .join("\n")
        : "";
      const result = base + auditText + orphanText + planText;
      logToolCall(config, {
        tool: "list_workspaces",
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: { tool: "list_workspaces" },
        structuredContent: {
          result,
          workspaces: sessions,
          audits,
          orphanedWorktrees: orphanAudit,
          cleanupPlan: plan,
        },
      };
    },
  );

  if (!config.readOnly) {
    registerAppTool(
      server,
      "reclaim_workspace",
      {
        title: "Reclaim a managed worktree",
        description:
          "Remove ONE DevSpace-managed Git worktree after an explicit, SHA-pinned confirmation. Refuses anything with uncommitted files, untracked files, unmerged commits, a running job, a live session, or uncertain ownership. Only managed worktrees created by open_workspace(mode=\"worktree\") are eligible; normal checkouts are never removed. Removal uses `git worktree remove` WITHOUT --force, so Git independently refuses a dirty worktree. There is no recursive directory delete, no `git clean`, and no reset.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("The managed worktree workspaceId to reclaim."),
          expectedHeadSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/)
            .describe(
              "Exact current HEAD SHA from list_workspaces(audit=true). A stale decision cannot remove a worktree that has moved.",
            ),
          confirmWorkspaceId: z
            .string()
            .describe(
              "Must exactly equal workspaceId. Guards against acting on the wrong workspace.",
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          reclaimed: z.unknown().optional(),
          // Present on refusal: a refusal is structured data the client can
          // validate, not a transport-level failure.
          error: toolErrorOutputSchema,
        }),
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
        expectedHeadSha,
        confirmWorkspaceId,
        projectMemoryReceiptId,
      }) => {
        // The safety guards must observe the workspace as it was BEFORE this
        // call. The reclaim itself does not attach a live session (it reads the
        // store directly), and the SHADOW observation is recorded afterwards so
        // it cannot influence the decision it is recording.
        const reclaimed = await workspaces.withExclusiveLease(
          workspaceId,
          (workspace, others) =>
            workspaces.reclaimWorkspace({
              workspaceId: workspace.id,
              expectedHeadSha,
              confirmation: confirmWorkspaceId,
              activeJobIdsForRoot: (root) => jobs.activeJobIdsForRoot(root),
              activeGameSessionIds: (id) =>
                games
                  .listActiveSessions(id)
                  .map((session) => session.sessionId),
              activeTaskSessionIds: (id) =>
                tasks
                  .listSessions(id, 50)
                  .filter((session) => session.status === "running")
                  .map((session) => session.sessionId),
              othersHolding: others,
            }),
        );
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "reclaim_workspace",
          projectMemoryReceiptId,
        );
        const result = `Reclaimed ${reclaimed.workspaceId} at ${reclaimed.root} (HEAD ${reclaimed.headSha}). Store record removed: ${reclaimed.storeRecordRemoved}.`;
        return {
          content: [textBlock(result)],
          _meta: { tool: "reclaim_workspace", projectMemory },
          structuredContent: { result, reclaimed },
        };
      },
    );

    registerAppTool(
      server,
      "close_workspace_session",
      {
        title: "Close a workspace session",
        description:
          "Release DevSpace's session occupancy for ONE workspace and persist the lifecycle transition. This is NOT a delete: it never removes a worktree, a branch, a file, a log, an agent, a job or a Git ref, and it never resets or cleans anything. Refuses when an in-flight DevSpace operation, background job, task session or game session is still using the workspace, when the workspace identity or HEAD cannot be confirmed, or when HEAD does not match expectedHeadSha. Idempotent: closing an already-closed session reports alreadyClosed. After closing, re-run list_workspaces(audit=true, cleanupPlan=true) before reclaiming anything.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("The workspaceId whose session should be closed."),
          confirmWorkspaceId: z
            .string()
            .describe(
              "Must exactly equal workspaceId. Guards against acting on the wrong workspace.",
            ),
          expectedHeadSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/)
            .optional()
            .describe(
              "Optional exact HEAD SHA from list_workspaces(audit=true). When supplied, a mismatch refuses the close so a stale decision cannot release a workspace that has moved.",
            ),
          reason: z
            .string()
            .max(500)
            .optional()
            .describe(
              "Optional short operator note recorded with the transition. Not a task description and not persisted as free-form content elsewhere.",
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          session: z.unknown().optional(),
          error: toolErrorOutputSchema,
        }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({
        workspaceId,
        confirmWorkspaceId,
        expectedHeadSha,
        reason,
        projectMemoryReceiptId,
      }) => {
        const session = await workspaces.withExclusiveLease(
          workspaceId,
          (workspace, others) =>
            workspaces.closeWorkspaceSession({
              workspaceId: workspace.id,
              confirmation: confirmWorkspaceId,
              expectedHeadSha,
              reason,
              othersHolding: others,
            }),
        );
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "close_workspace_session",
          projectMemoryReceiptId,
        );
        const result = [
          session.alreadyClosed
            ? `Session ${session.workspaceId} was already closed; no state was written.`
            : `Closed session ${session.workspaceId} (${session.previousState} -> ${session.lifecycleState}).`,
          `Workspace: ${session.root}`,
          `HEAD ${session.headSha ?? "unknown"}.`,
          `Reclaim eligible right now: ${String(session.reclaimEligible)}.`,
          "Nothing was deleted: no worktree, branch, file, log, job or Git ref was removed.",
          ...session.notes,
        ].join("\n");
        logToolCall(config, {
          tool: "close_workspace_session",
          workspaceId,
          success: true,
          durationMs: 0,
        });
        return {
          content: [textBlock(result)],
          _meta: { tool: "close_workspace_session", projectMemory },
          structuredContent: { result, session },
        };
      },
    );
  }

  registerAppTool(
    server,
    "query_operation",
    {
      title: "Query operation status",
      description:
        "Check the execution and idempotency status of a previously initiated operation by its operationId. Use this when recovering from client disconnections or timeouts before retrying mutations.",
      inputSchema: {
        operationId: z
          .string()
          .min(1)
          .max(256)
          .describe("The unique operation ID supplied when starting a mutating tool call."),
      },
      outputSchema: resultOutputSchema({
        operation: z.object({
          operationId: z.string(),
          status: z.enum(["running", "succeeded", "failed", "unknown"]),
          workspaceId: z.string().nullable().optional(),
          toolName: z.string().optional(),
          sideEffectApplied: z.boolean().optional(),
          createdAt: z.string().optional(),
          completedAt: z.string().nullable().optional(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
        }),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ operationId }) => {
      const startedAt = performance.now();
      const op = ctx.operations.getOperation(operationId);
      if (!op) {
        const notFound = {
          operationId,
          status: "unknown" as const,
        };
        const text = `Operation ${operationId} not found in operation registry.`;
        return {
          content: [textBlock(text)],
          _meta: { tool: "query_operation" },
          structuredContent: {
            result: text,
            operation: notFound,
          },
        };
      }

      const text = `Operation ${op.operationId}: ${op.status} (tool=${op.toolName}, sideEffectApplied=${op.sideEffectApplied}, started=${op.createdAt}).`;
      logToolCall(config, {
        tool: "query_operation",
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(text)],
        _meta: { tool: "query_operation" },
        structuredContent: {
          result: text,
          operation: op,
        },
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
