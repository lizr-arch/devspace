import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  commitGit,
  fetchGit,
  inspectGitDiff,
  inspectGitStatus,
  manageGitBranch,
  mergeGit,
  pushGit,
  stageGitPaths,
  unstageGitPaths,
} from "../git-tools.js";
import {
  deleteMergedBranch,
  listLocalBranchVerdicts,
} from "../git-branch-cleanup.js";
import {
  resultOutputSchema,
  toolErrorOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  textBlock,
  gitToolFailure,
  gitRemotePolicyForWorkspace,
  assertManagedAttachedGitWorkspace,
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

export function registerGitInspectionTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, widgetMeta } = ctx;

  registerAppTool(
    server,
    "git_status",
    {
      title: "Git status",
      description:
        "Inspect local Git status for a workspace whose root exactly equals the Git root.",
      inputSchema: {
        workspaceId: z.string(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ status: z.unknown() }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, projectMemoryReceiptId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_status",
        projectMemoryReceiptId,
      );
      const status = await inspectGitStatus(workspace.root);
      const result = `${status.branch ?? "(detached)"} @ ${status.headSha} | ${status.clean ? "clean" : "dirty"} | staged ${status.staged.length}, unstaged ${status.unstaged.length}, untracked ${status.untracked.length}, conflicts ${status.conflicts.length}`;
      logToolCall(config, {
        tool: "git_status",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: { tool: "git_status", projectMemory },
        structuredContent: { result, status },
      };
    },
  );

  registerAppTool(
    server,
    "git_diff",
    {
      title: "Git diff",
      description:
        "Read a bounded local Git patch and its full SHA-256. Does not invoke external diff tools.",
      inputSchema: {
        workspaceId: z.string(),
        scope: z.enum(["head", "staged", "unstaged"]).optional(),
        paths: z.array(z.string().max(512)).max(100).optional(),
        contextLines: z.number().int().min(0).max(20).optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ diff: z.unknown() }),
      ...widgetMeta("git_diff", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      scope,
      paths,
      contextLines,
      projectMemoryReceiptId,
    }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_diff",
        projectMemoryReceiptId,
      );
      const diff = await inspectGitDiff({
        workspaceRoot: workspace.root,
        scope,
        paths,
        contextLines,
      });
      const result = diff.patch || "No matching Git changes.";
      logToolCall(config, {
        tool: "git_diff",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: { tool: "git_diff", projectMemory },
        structuredContent: { result, diff },
      };
    },
  );
}

export function registerGitMutationTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces } = ctx;

  if (config.readOnly) return;

  for (const tool of ["git_stage_paths", "git_unstage_paths"] as const) {
    registerAppTool(
      server,
      tool,
      {
        title:
          tool === "git_stage_paths"
            ? "Stage Git paths"
            : "Unstage Git paths",
        description:
          "Change the local Git index for an explicit, bounded list of workspace-relative paths.",
        inputSchema: {
          workspaceId: z.string(),
          paths: z.array(z.string().max(512)).min(1).max(100),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({ status: z.unknown() }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, paths, projectMemoryReceiptId }) => {
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          tool,
          projectMemoryReceiptId,
        );
        // Holding a real lease is what lets close_workspace_session and the
        // lifecycle audit see that this workspace is busy right now.
        const status = await workspaces.withLease(workspaceId, (workspace) =>
          tool === "git_stage_paths"
            ? stageGitPaths(workspace.root, paths)
            : unstageGitPaths(workspace.root, paths),
        );
        const result = `${tool === "git_stage_paths" ? "Staged" : "Unstaged"} ${paths.length} path(s). Index sha256 ${status.stagedDiffSha256}.`;
        return {
          content: [textBlock(result)],
          _meta: { tool, projectMemory },
          structuredContent: { result, status },
        };
      },
    );
  }

  registerAppTool(
    server,
    "git_commit",
    {
      title: "Commit local Git changes",
      description:
        "Create one local commit only when the reviewed staged diff SHA-256 still matches. Hooks and GPG signing are disabled.",
      inputSchema: {
        workspaceId: z.string(),
        message: z.string().min(1).max(10_000),
        expectedStagedDiffSha256: z.string().regex(/^[0-9a-f]{64}$/),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ commit: z.unknown() }),
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
      message,
      expectedStagedDiffSha256,
      projectMemoryReceiptId,
    }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_commit",
        projectMemoryReceiptId,
      );
      const commit = await workspaces.withLease(workspaceId, (workspace) =>
        commitGit({
          workspaceRoot: workspace.root,
          message,
          expectedStagedDiffSha256,
        }),
      );
      const result = `Created local commit ${commit.headSha}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "git_commit", projectMemory },
        structuredContent: { result, commit },
      };
    },
  );

  registerAppTool(
    server,
    "git_branch",
    {
      title: "Manage local Git branch",
      description:
        "List, create (with optional checkout), or switch to an existing local branch. By default, create also checks out the new branch atomically via git switch -c. Set checkout=false to create the ref without switching. Switching requires a clean workspace; deletion, force, merge, and remote operations are unsupported.",
      inputSchema: {
        workspaceId: z.string(),
        action: z.enum(["list", "create", "switch"]),
        name: z.string().max(255).optional(),
        checkout: z
          .boolean()
          .optional()
          .describe(
            "When action=create, whether to also switch to the new branch. Defaults to true.",
          ),
        startPoint: z
          .string()
          .max(255)
          .optional()
          .describe(
            "When action=create, the starting commit for the new branch. Defaults to HEAD.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ branch: z.unknown() }),
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
      action,
      name,
      checkout,
      startPoint,
      projectMemoryReceiptId,
    }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_branch",
        projectMemoryReceiptId,
      );
      const branch = await workspaces.withLease(workspaceId, (workspace) =>
        manageGitBranch({
          workspaceRoot: workspace.root,
          action,
          name,
          checkout,
          startPoint,
        }),
      );
      const statusLine = branch.detached
        ? "detached"
        : `on ${branch.currentBranch}`;
      const result = `Current: ${statusLine}; local branches: ${branch.branches.join(", ")}.`;
      return {
        content: [textBlock(result)],
        _meta: { tool: "git_branch", projectMemory },
        structuredContent: { result, branch },
      };
    },
  );

  registerAppTool(
    server,
    "git_delete_merged_branch",
    {
      title: "Delete a merged local Git branch",
      description:
        "Delete ONE local branch that is provably merged, using `git branch -d` only. Refuses protected or development branches (main, master, the repository default, release/*, feat/*, and any operator-configured pattern), branches checked out in any worktree, branches whose SHA or mainline SHA changed since inspection, branches with commits that are not ancestors of main, and branches that any live workspace depends on. Force deletion (-D), remote branch deletion, tag deletion and ref surgery are not available at all. Set action=list to only read branch verdicts. After deleting, the tool proves main, HEAD and every remote-tracking ref are unchanged.",
      inputSchema: z.strictObject({
        workspaceId: z
          .string()
          .describe(
            "Workspace whose repository holds the branch. Any worktree of the repository works.",
          ),
        branchName: z
          .string()
          .max(255)
          .optional()
          .describe(
            "Local branch to delete. Required unless action=list.",
          ),
        action: z
          .enum(["list", "delete"])
          .optional()
          .describe(
            "Defaults to delete. Use list for a read-only verdict per local branch.",
          ),
        expectedBranchSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional()
          .describe(
            "Exact current branch SHA from the cleanup plan. Required for action=delete.",
          ),
        expectedMainSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional()
          .describe(
            "Exact current mainline SHA from the cleanup plan. Required for action=delete.",
          ),
        confirmBranchName: z
          .string()
          .max(255)
          .optional()
          .describe(
            "Must exactly equal branchName. Required for action=delete.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      }),
      outputSchema: resultOutputSchema({
        branch: z.unknown().optional(),
        branches: z.unknown().optional(),
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
      branchName,
      action,
      expectedBranchSha,
      expectedMainSha,
      confirmBranchName,
      projectMemoryReceiptId,
    }) => {
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        if ((action ?? "delete") === "list") {
          const branches = await listLocalBranchVerdicts({
            workspaceRoot: workspace.root,
            policy: workspaces.branchCleanupPolicy(),
          });
          const deletable = branches.filter(
            (entry) => entry.verdict === "DELETABLE_MERGED",
          );
          const result = [
            `Local branches: ${branches.length}; deletable (merged, unused): ${deletable.length}.`,
            ...branches.map(
              (entry) =>
                `  ${entry.verdict} | ${entry.branch} | ${entry.sha ?? "missing"} | ${entry.reasons.join("; ")}`,
            ),
            "Read-only listing. Nothing was deleted.",
          ].join("\n");
          return {
            content: [textBlock(result)],
            _meta: { tool: "git_delete_merged_branch" },
            structuredContent: { result, branches },
          };
        }

        if (!branchName) {
          throw new Error(
            "GIT_BRANCH_NAME_REQUIRED: branchName is required for action=delete.",
          );
        }
        if (!expectedBranchSha || !expectedMainSha || !confirmBranchName) {
          throw new Error(
            "GIT_BRANCH_CONFIRMATION_REQUIRED: action=delete requires expectedBranchSha, expectedMainSha and confirmBranchName.",
          );
        }
        const activeDependents = await workspaces.branchActiveDependents(
          workspace.root,
          // This call holds a lease on `workspaceId` itself; excluding it keeps
          // the dependency check about *other* workspaces.
          { excludeWorkspaceId: workspaceId },
        );
        const branch = await deleteMergedBranch({
          workspaceRoot: workspace.root,
          branchName,
          expectedBranchSha,
          expectedMainSha,
          confirmation: confirmBranchName,
          policy: workspaces.branchCleanupPolicy(),
          activeDependents,
        });
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_delete_merged_branch",
          projectMemoryReceiptId,
        );
        const result = [
          `Deleted local branch ${branch.branch} (was ${branch.deletedSha}).`,
          `Mainline ${branch.mainlineRef} unchanged at ${branch.mainlineShaAfter}.`,
          `HEAD unchanged at ${branch.headShaAfter}.`,
          `Remote-tracking refs unchanged: ${String(branch.remoteRefsUnchanged)}. No remote branch was touched.`,
        ].join("\n");
        return {
          content: [textBlock(result)],
          _meta: { tool: "git_delete_merged_branch", projectMemory },
          structuredContent: { result, branch },
        };
      } catch (error) {
        return gitToolFailure("git_delete_merged_branch", error, undefined);
      }
    },
  );
  registerAppTool(
    server,
    "git_fetch",
    {
      title: "Fetch approved Git remote",
      description:
        "Fetch one existing operator-approved remote without accepting a URL or refspec. Remote-tracking ref changes are reported; HEAD, branch, index, and worktree must remain unchanged.",
      inputSchema: z.strictObject({
        workspaceId: z.string(),
        remote: z.string().max(255).optional(),
        prune: z.boolean().optional(),
        expectedHeadSha: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
          .optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      }),
      outputSchema: resultOutputSchema({
        fetch: z.unknown().optional(),
        error: toolErrorOutputSchema,
      }),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      workspaceId,
      remote,
      prune,
      expectedHeadSha,
      projectMemoryReceiptId,
    }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_fetch",
        projectMemoryReceiptId,
      );
      try {
        const fetch = await workspaces.withLease(workspaceId, async (workspace) => {
          const policy = gitRemotePolicyForWorkspace(config, workspace);
          return fetchGit({
            workspaceRoot: workspace.root,
            approvedRemotes: policy.approvedRemotes,
            approvedRemoteUrls: policy.approvedRemoteUrls,
            remote,
            prune,
            expectedHeadSha,
          });
        });
        const result = [
          `Fetched ${fetch.remote} (prune=${String(fetch.prune)}).`,
          `HEAD ${fetch.headSha} on ${fetch.branch ?? "(detached)"}.`,
          `Remote refs: ${fetch.updatedRefs.length} updated, ${fetch.createdRefs.length} created, ${fetch.deletedRefs.length} deleted.`,
        ].join("\n");
        return {
          content: [textBlock(result)],
          _meta: { tool: "git_fetch", projectMemory },
          structuredContent: { result, fetch },
        };
      } catch (error) {
        return gitToolFailure("git_fetch", error, projectMemory);
      }
    },
  );

  registerAppTool(
    server,
    "git_merge",
    {
      title: "Merge Git commit safely",
      description:
        "Merge one validated commit into a clean attached workspace using ff-only or no-ff. Expected SHAs prevent stale operations; hooks, GPG signing, executable filters, and custom merge drivers are blocked. Conflicts are recorded and automatically aborted back to the clean pre-merge state.",
      inputSchema: z.strictObject({
        workspaceId: z.string(),
        sourceRef: z.string().min(1).max(255),
        mode: z.enum(["ff_only", "no_ff"]),
        expectedHeadSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        commitMessage: z.string().min(1).max(10_000).optional(),
        expectedSourceSha: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
          .optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      }),
      outputSchema: resultOutputSchema({
        merge: z.unknown().optional(),
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
      sourceRef,
      mode,
      expectedHeadSha,
      commitMessage,
      expectedSourceSha,
      projectMemoryReceiptId,
    }) => {
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "git_merge",
        projectMemoryReceiptId,
      );
      try {
        const merge = await workspaces.withLease(workspaceId, async (workspace) => {
          await assertManagedAttachedGitWorkspace(workspace);
          return mergeGit({
            workspaceRoot: workspace.root,
            sourceRef,
            mode,
            expectedHeadSha,
            commitMessage,
            expectedSourceSha,
          });
        });
        const result = [
          `Merged ${merge.sourceRef} (${merge.sourceSha}) into ${merge.branch}.`,
          `HEAD ${merge.headBefore} -> ${merge.headAfter}; mode=${merge.mode}.`,
          merge.createdMergeCommit
            ? `Created merge commit ${merge.mergeCommitSha}.`
            : "No merge commit was created.",
        ].join("\n");
        return {
          content: [textBlock(result)],
          _meta: { tool: "git_merge", projectMemory },
          structuredContent: { result, merge },
        };
      } catch (error) {
        return gitToolFailure("git_merge", error, projectMemory);
      }
    },
  );

  if (config.gitRemoteWrite.enabled) {
    registerAppTool(
      server,
      "git_push",
      {
        title: "Push approved Git branch safely",
        description:
          "Push one exact local commit to one operator-approved remote branch. The tool fetches first, requires exact local and remote SHAs, verifies fast-forward ancestry, performs an atomic expected-remote compare-and-swap, and fetches again to verify the result. Force, deletion, tags, arbitrary refspecs, URLs, and arbitrary Git arguments are not accepted.",
        inputSchema: z.strictObject({
          workspaceId: z.string(),
          remote: z.string().max(255).optional(),
          sourceRef: z.string().min(1).max(255).optional(),
          destinationBranch: z.string().min(1).max(255),
          expectedLocalSha: z
            .string()
            .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
          expectedRemoteSha: z
            .string()
            .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
          verifyAncestor: z.boolean().optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        }),
        outputSchema: resultOutputSchema({
          push: z.unknown().optional(),
          error: z
            .object({ code: z.string(), message: z.string() })
            .optional(),
        }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        workspaceId,
        remote,
        sourceRef,
        destinationBranch,
        expectedLocalSha,
        expectedRemoteSha,
        verifyAncestor,
        projectMemoryReceiptId,
      }) => {
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_push",
          projectMemoryReceiptId,
        );
        try {
          const push = await workspaces.withLease(workspaceId, async (workspace) => {
            await assertManagedAttachedGitWorkspace(workspace);
            const policy = gitRemotePolicyForWorkspace(config, workspace);
            return pushGit({
              workspaceRoot: workspace.root,
              approvedRemotes: policy.approvedRemotes,
              approvedRemoteUrls: policy.approvedRemoteUrls,
              approvedDestinationBranches: policy.approvedDestinationBranches,
              remote,
              sourceRef,
              destinationBranch,
              expectedLocalSha,
              expectedRemoteSha,
              verifyAncestor,
            });
          });
          const result = [
            `Pushed ${push.localSha} to ${push.remote}/${push.destinationBranch}.`,
            `Remote ${push.remoteShaBefore} -> ${push.remoteShaAfter}.`,
            `Verified remoteContainsLocal=${String(push.remoteContainsLocal)}.`,
          ].join("\n");
          return {
            content: [textBlock(result)],
            _meta: { tool: "git_push", projectMemory },
            structuredContent: { result, push },
          };
        } catch (error) {
          return gitToolFailure("git_push", error, projectMemory);
        }
      },
    );
  }
}

export function registerGitTools(server: McpServer, ctx: ServerContext): void {
  registerGitInspectionTools(server, ctx);
  registerGitMutationTools(server, ctx);
}
