import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { registerAppTool as registerMcpAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ServerConfig } from "../config.js";
import { logEvent, commandPreview } from "../logger.js";
import { JOB_RUNNERS, type JobSnapshot } from "../background-jobs.js";
import { type RunnerInspection } from "../runner-registry.js";
import { type MonitorEventStore } from "../monitor-events.js";
import type { McpSessionSnapshot } from "../mcp-session-registry.js";
import {
  moveWorkspacePathToTrash,
  restoreWorkspaceFileFromTrash,
} from "../workspace-files.js";
import { formatPathForPrompt } from "../skills.js";
import {
  formatAgentsPath,
  refreshWorkspaceGitAttachment,
  type Workspace,
  type WorkspaceContext,
} from "../workspaces.js";
import type { createReviewCheckpointManager } from "../review-checkpoints.js";
import { attachRegisteredToolName } from "../tool-result-metadata.js";
import {
  PACKAGE_VERSION,
  TOOL_SCHEMA_REVISION,
  type ToolCapability,
  type ToolContent,
  type DiffStats,
  type ToolNames,
  type ToolLogFields,
  type ServiceRuntime,
  type WorkspaceAppBuild,
} from "./server-types.js";

import { formatErrorRemedy } from "../errors.js";

export async function rollbackImportedAsset(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  path: string;
  displacedTrashId?: string;
}): Promise<void> {
  try {
    if (input.displacedTrashId) {
      await restoreWorkspaceFileFromTrash({
        workspaceRoot: input.workspaceRoot,
        stateDir: input.stateDir,
        workspaceId: input.workspaceId,
        trashId: input.displacedTrashId,
        path: input.path,
      });
      return;
    }
    await moveWorkspacePathToTrash({
      workspaceRoot: input.workspaceRoot,
      stateDir: input.stateDir,
      workspaceId: input.workspaceId,
      path: input.path,
    });
  } catch (error) {
    throw new Error(
      `ASSET_ROLLBACK_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export const registerAppTool: typeof registerMcpAppTool = ((
  server: Parameters<typeof registerMcpAppTool>[0],
  name: Parameters<typeof registerMcpAppTool>[1],
  definition: Parameters<typeof registerMcpAppTool>[2],
  handler: Parameters<typeof registerMcpAppTool>[3],
) => {
  const capability = requiredCapabilityForTool(String(name));
  const meta = (definition as { _meta?: Record<string, unknown> })._meta ?? {};
  return registerMcpAppTool(
    server,
    name,
    {
      ...definition,
      _meta: {
        ...meta,
        devspace: { requiredCapability: capability },
      },
    },
    (async (...args: unknown[]) => {
      try {
        const result = await Reflect.apply(
          handler as (...handlerArgs: unknown[]) => unknown,
          undefined,
          args,
        );
        return attachRegisteredToolName(String(name), result);
      } catch (error) {
        const { message, errorPayload } = formatErrorRemedy(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          _meta: {
            tool: String(name),
            error: errorPayload,
          },
          structuredContent: {
            error: errorPayload,
            result: message,
          },
        };
      }
    }) as typeof handler,
  );
}) as typeof registerMcpAppTool;

export function toolNamesFor(config: ServerConfig): ToolNames {
  return config.toolNaming === "short"
    ? {
        openWorkspace: "open_workspace",
        read: "read",
        write: "write",
        edit: "edit",
        grep: "grep",
        glob: "glob",
        ls: "ls",
        shell: "bash",
      }
    : {
        openWorkspace: "open_workspace",
        read: "read_file",
        write: "write_file",
        edit: "edit_file",
        grep: "grep_files",
        glob: "find_files",
        ls: "list_directory",
        shell: "run_shell",
      };
}

export function exposeDedicatedReadTools(config: ServerConfig): boolean {
  return config.readOnly || !config.minimalTools;
}

export function exposedToolNames(
  config: ServerConfig,
  toolNames: ToolNames,
): string[] {
  const tools = [
    "devspace_info",
    "houdini_info",
    "list_workspaces",
    "query_operation",
    "list_artifacts",
    "inspect_artifact",
    "git_status",
    "git_diff",
    "inspect_glb",
    "resume_workspace",
    "open_workspace",
    "project_memory_preflight",
    toolNames.read,
    "list_task_sessions",
    "wait_task",
    "poll_task",
  ];
  if (!config.readOnly) {
    tools.splice(3, 0, "publish_artifact");
    tools.push(
      toolNames.write,
      "import_asset",
      "import_png",
      "archive_approved_image",
      "find_approved_assets",
      "verify_approved_asset",
      "recover_approved_asset",
      "reindex_approved_assets",
      toolNames.edit,
      "preview_artifact",
      "mkdir",
      "copy",
      "move",
      "move_to_trash",
      "git_stage_paths",
      "git_unstage_paths",
      "git_commit",
      "git_branch",
      "git_fetch",
      "git_merge",
      "start_game_session",
      "inspect_game_session",
      "send_game_input",
      "capture_game_frame",
      "read_game_logs",
      "stop_game_session",
      "inspect_blend",
      "inspect_audio",
      "render_model_preview",
      "project_task",
      "stop_task",
      "approve_task_manifest",
    );
    if (config.gitRemoteWrite.enabled) {
      tools.splice(tools.indexOf("git_merge") + 1, 0, "git_push");
    }
  }
  if (config.widgets === "changes") tools.push("show_changes");
  if (exposeDedicatedReadTools(config)) {
    tools.push(toolNames.grep, toolNames.glob, toolNames.ls);
  }
  if (!config.readOnly) {
    tools.push(
      "start_job",
      "start_capture",
      "wait_job",
      "list_jobs",
      "poll_job",
      "cancel_job",
    );
  }
  return tools;
}

export function createServiceRuntime(
  config: ServerConfig,
  workspaceApp: WorkspaceAppBuild | undefined,
  mcpSessionStats: () => McpSessionSnapshot,
  monitorEvents: MonitorEventStore,
): ServiceRuntime {
  const tools = exposedToolNames(config, toolNamesFor(config));
  const requiredCapabilities = Object.fromEntries(
    tools.map((tool) => [tool, requiredCapabilityForTool(tool)]),
  ) as Record<string, ToolCapability>;
  const schemaFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        packageVersion: PACKAGE_VERSION,
        schemaRevision: TOOL_SCHEMA_REVISION,
        tools,
        readOnly: config.readOnly,
        minimalTools: config.minimalTools,
        widgets: config.widgets,
        toolNaming: config.toolNaming,
        requiredCapabilities,
        runnerNames: JOB_RUNNERS,
        gitRemoteWrite: config.gitRemoteWrite,
        workspaceApp: workspaceApp
          ? {
              resourceUri: workspaceApp.resourceUri,
              buildFingerprint: workspaceApp.buildFingerprint,
              manifestSha256: workspaceApp.manifestSha256,
            }
          : undefined,
      }),
    )
    .digest("hex");
  return {
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
    tools,
    schemaFingerprint,
    requiredCapabilities,
    mcpSessionStats,
    monitorEvents,
    workspaceApp: workspaceApp
      ? {
          resourceUri: workspaceApp.resourceUri,
          buildFingerprint: workspaceApp.buildFingerprint,
          manifestSha256: workspaceApp.manifestSha256,
        }
      : undefined,
  };
}

export function processMemorySnapshot(): {
  rssMiB: number;
  heapUsedMiB: number;
  heapTotalMiB: number;
  externalMiB: number;
} {
  const memory = process.memoryUsage();
  const toMiB = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  return {
    rssMiB: toMiB(memory.rss),
    heapUsedMiB: toMiB(memory.heapUsed),
    heapTotalMiB: toMiB(memory.heapTotal),
    externalMiB: toMiB(memory.external),
  };
}

export function requiredCapabilityForTool(tool: string): ToolCapability {
  if (
    [
      "write",
      "write_file",
      "edit",
      "edit_file",
      "import_asset",
      "import_png",
      "archive_approved_image",
      "recover_approved_asset",
      "reindex_approved_assets",
      "mkdir",
      "copy",
      "move",
      "move_to_trash",
    ].includes(tool)
  ) {
    return "workspace.write";
  }
  if (["inspect_artifact", "list_artifacts"].includes(tool)) {
    return "artifact.inspect";
  }
  if (["inspect_glb", "inspect_blend", "inspect_audio"].includes(tool)) {
    return "artifact.inspect";
  }
  if (tool === "render_model_preview") return "artifact.publish";
  if (["publish_artifact", "preview_artifact"].includes(tool)) {
    return "artifact.publish";
  }
  if (["git_status", "git_diff"].includes(tool)) return "git.read";
  if (
    [
      "git_stage_paths",
      "git_unstage_paths",
      "git_commit",
      "git_branch",
      "git_fetch",
      "git_merge",
      "git_push",
    ].includes(tool)
  ) {
    return "git.write";
  }
  if (
    [
      "start_job",
      "start_capture",
      "wait_job",
      "list_jobs",
      "poll_job",
      "cancel_job",
      "project_task",
      "stop_task",
      "bash",
      "run_shell",
    ].includes(tool)
  ) {
    return "runner.execute";
  }
  if (["list_task_sessions", "wait_task", "poll_task"].includes(tool))
    return "workspace.read";
  if (tool === "approve_task_manifest") return "workspace.write";
  if (
    [
      "start_game_session",
      "inspect_game_session",
      "send_game_input",
      "capture_game_frame",
      "read_game_logs",
      "stop_game_session",
    ].includes(tool)
  ) {
    return "game.control";
  }
  return "workspace.read";
}

export function serverInstructions(
  config: ServerConfig,
  toolNames: ToolNames,
): string {
  const inspectionText = exposeDedicatedReadTools(config)
    ? `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `
    : `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  const showChanges =
    config.widgets === "changes"
      ? " After creating, editing, or overwriting files, call show_changes once after the related file changes are complete so the user can see the aggregate diff."
      : "";

  const projectMemory =
    config.projectMemory.repositories.length > 0
      ? " For each new task in a configured repository, pass the task to open_workspace or call project_memory_preflight before other tools. Pass the returned projectMemoryReceiptId on later workspace tool calls. Project Memory is SHADOW-only: missing or would-deny receipts are observed but do not block existing tools."
      : " Project Memory preflight is available only for operator-configured repository roots.";

  if (config.readOnly) {
    return `Use DevSpace as a read-only local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later read, search, directory, and show-changes tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspectionText}${toolNames.write}, ${toolNames.edit}, and ${toolNames.shell} are disabled in this server mode.${projectMemory}`;
  }

  return `Use DevSpace as a local coding workspace. Call devspace_info when diagnosing tool discovery or server freshness. Use list_workspaces and resume_workspace to recover a persisted checkout or managed worktree by workspaceId after a server or client restart. Call ${toolNames.openWorkspace} once per new project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, job, capture, artifact, and Git tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspectionText}Prefer ${toolNames.edit} for targeted text modifications, ${toolNames.write} only for new text files or explicit complete rewrites, import_asset for binary asset intake, start_job followed by wait_job for named validation runners, list_jobs to recover jobs after a client interruption, poll_job only for explicit paginated log reads, cancel_job to stop a job, start_capture for a validated project capture profile, inspect_artifact and list_artifacts for evidence, and preview_artifact or publish_artifact for short-lived review URLs. Arbitrary shell command execution is not exposed.${showChanges}${projectMemory}`;
}

export function formatRunnerSummary(runners: RunnerInspection[]): string {
  return runners
    .map((runner) => {
      const state = runner.available
        ? runner.version
          ? `available (${runner.version})`
          : "available"
        : runner.enabled
          ? "unavailable"
          : "disabled";
      return `${runner.name}=${state}`;
    })
    .join(", ");
}

export function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function requestLogFields(
  req: Request,
  _config: ServerConfig,
): Record<string, unknown> {
  return {
    networkSource: req.header("cf-ray") ? "cloudflare" : "direct",
    host: boundedHeader(req.header("host"), 120),
    userAgentCategory: userAgentCategory(req.header("user-agent")),
    originHost: safeUrlHost(req.header("origin")),
    contentLength: req.header("content-length"),
  };
}

export function boundedHeader(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value?.slice(0, maxLength);
}

export function safeUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.slice(0, 120);
  } catch {
    return "invalid";
  }
}

export function userAgentCategory(value: string | undefined): string {
  const lower = value?.toLowerCase() ?? "";
  if (!lower) return "missing";
  if (lower.includes("devspacedoctor")) return "devspace_doctor";
  if (lower.includes("chatgpt") || lower.includes("openai")) return "openai";
  if (lower.includes("cloudflare")) return "cloudflare";
  if (lower.includes("curl")) return "curl";
  if (lower.includes("node")) return "node";
  if (
    lower.includes("chrome") ||
    lower.includes("safari") ||
    lower.includes("firefox")
  ) {
    return "browser";
  }
  return "other";
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview:
      config.logging.shellCommands && command
        ? commandPreview(command)
        : undefined,
  });
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

export function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
  monitorEvents: MonitorEventStore,
): void {
  const errorPreview = toolErrorPreview(content);
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: errorPreview,
  });
  monitorEvents.recordToolFailure(fields.tool, errorPreview);
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function gitToolFailure(tool: string, error: unknown, projectMemory: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(raw);
  const detail = {
    code: match?.[1] ?? "GIT_OPERATION_FAILED",
    message: match?.[2] || raw || "Git operation failed.",
  };
  const result = `${detail.code}: ${detail.message}`;
  return {
    isError: true as const,
    content: [textBlock(result)],
    _meta: { tool, projectMemory },
    structuredContent: { result, error: detail },
  };
}

export function gitRemotePolicyForWorkspace(
  config: ServerConfig,
  workspace: { root: string; sourceRoot?: string },
) {
  if (!config.gitRemoteWrite.enabled) {
    throw new Error(
      "GIT_REMOTE_POLICY_DISABLED: Operator Git remote policy is disabled.",
    );
  }
  const repositoryRoot = workspace.sourceRoot ?? workspace.root;
  if (!config.gitRemoteWrite.approvedRepositoryRoots.includes(repositoryRoot)) {
    throw new Error(
      "GIT_REPOSITORY_NOT_APPROVED: Workspace repository is not approved for remote Git operations.",
    );
  }
  return {
    approvedRemotes: config.gitRemoteWrite.approvedRemotes,
    approvedRemoteUrls: config.gitRemoteWrite.approvedRemoteUrls,
    approvedDestinationBranches:
      config.gitRemoteWrite.approvedDestinationBranches,
  };
}

export async function assertManagedAttachedGitWorkspace(
  workspace: Workspace,
): Promise<void> {
  if (
    workspace.mode !== "worktree" ||
    workspace.worktree?.managed !== true ||
    workspace.worktree.path !== workspace.root
  ) {
    throw new Error(
      "GIT_MANAGED_WORKTREE_REQUIRED: Operation requires a DevSpace-managed worktree.",
    );
  }
  await refreshWorkspaceGitAttachment(workspace);
  if (workspace.worktree.detached || !workspace.worktree.branch) {
    throw new Error(
      "GIT_DETACHED_HEAD: Operation requires an attached managed worktree branch.",
    );
  }
}

export function gitRemoteWriteSummary(config: ServerConfig) {
  const policy = config.gitRemoteWrite;
  return {
    enabled: policy.enabled,
    approvedRemotes: policy.approvedRemotes,
    approvedDestinationBranches: policy.approvedDestinationBranches,
    approvedRepositoryRoots: policy.approvedRepositoryRoots,
    allowForce: policy.allowForce,
    requireCleanWorkspace: policy.requireCleanWorkspace,
    requireExpectedRemoteSha: policy.requireExpectedRemoteSha,
    requireFastForward: policy.requireFastForward,
  };
}

export function assertJobWorkspace(job: JobSnapshot, workspaceId: string): void {
  if (job.workspaceId !== workspaceId) {
    throw new Error("Job does not belong to this workspaceId.");
  }
}

export function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

export function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

export function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function workspaceContextToolResponse(input: {
  action: "open_workspace" | "resume_workspace";
  actionLabel: "Opened" | "Resumed";
  config: ServerConfig;
  toolNames: ToolNames;
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  context: WorkspaceContext;
  task?: string;
  startedAt: number;
}) {
  const { workspace, agentsFiles, availableAgentsFiles, projectMemory } =
    input.context;
  if (input.config.widgets === "changes") {
    void input.reviewCheckpoints.initializeWorkspace({
      workspaceId: workspace.id,
      root: workspace.root,
    });
  }
  const visibleSkills = workspace.skills
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: formatPathForPrompt(skill.filePath),
    }));
  const loadedAgentsFiles = agentsFiles.map((file) => ({
    path: formatAgentsPath(file.path, workspace.root),
    content: file.content,
  }));
  const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
    path: formatAgentsPath(file.path, workspace.root),
  }));
  const instructionPrefix = input.config.readOnly
    ? "Use this workspaceId in all subsequent read-only tool calls for this project."
    : "Use this workspaceId in all subsequent tool calls for this project.";
  const instructionCore =
    " Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
  const instructionSkills = input.config.skillsEnabled
    ? " When a task matches an available skill in skills, read its path before proceeding."
    : "";
  const instructionReadOnly = input.config.readOnly
    ? ` ${input.toolNames.write}, ${input.toolNames.edit}, and ${input.toolNames.shell} are unavailable in this server mode.`
    : "";
  const instructionProjectMemory = projectMemory?.receiptId
    ? ` For this task, pass projectMemoryReceiptId ${projectMemory.receiptId} on later workspace tool calls. Call project_memory_preflight again when the task changes.`
    : input.task
      ? " Project Memory did not issue a receipt. SHADOW does not block existing tools; call project_memory_preflight again when the task changes."
      : " For a new task in a configured repository, call project_memory_preflight before later workspace tools.";
  const {
    requestedAdditionalRoots,
    effectiveAdditionalRoots,
    rejectedAdditionalRoots,
    additionalRootsScope,
    additionalRootsPersisted,
  } = input.context.additionalRootsAuthorization;
  const instructionAdditionalRoots =
    rejectedAdditionalRoots.length > 0
      ? " One or more requested additional roots were rejected, so the requested set was not partially applied. Inspect rejectedAdditionalRoots and effectiveAdditionalRoots before accessing them."
      : effectiveAdditionalRoots.length > 0
        ? " Additional-root grants are effective only for this in-memory service session and must be supplied again after service restart."
        : "";
  const instruction = `${instructionPrefix}${instructionCore}${instructionSkills}${instructionReadOnly}${instructionProjectMemory}${instructionAdditionalRoots}`;
  const resultContent: ToolContent[] = [
    {
      type: "text",
      text: [
        input.context.reused
          ? `${input.actionLabel} workspace ${workspace.id} (session reused)`
          : `${input.actionLabel} workspace ${workspace.id}`,
        `Root: ${workspace.root}`,
        `Mode: ${workspace.mode}`,
        loadedAgentsFiles.length > 0
          ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
          : undefined,
        availableAgentsFileOutputs.length > 0
          ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
          : undefined,
        visibleSkills.length > 0
          ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
          : undefined,
        projectMemory
          ? `Project Memory SHADOW: ${projectMemory.status}; decision=${projectMemory.decision ?? "none"}; receipt=${projectMemory.receiptId ?? "none"}`
          : undefined,
        projectMemory?.bundle
          ? `Project Memory bundle (first delivery only):\n${JSON.stringify(projectMemory.bundle, null, 2)}`
          : undefined,
        requestedAdditionalRoots.length > 0
          ? `Requested additional roots: ${requestedAdditionalRoots.length}; effective: ${effectiveAdditionalRoots.length}; rejected: ${rejectedAdditionalRoots.length}.`
          : undefined,
        instruction,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  logToolCall(input.config, {
    tool: input.action,
    workspaceId: workspace.id,
    path: workspace.root,
    success: true,
    durationMs: Math.round(performance.now() - input.startedAt),
  });

  return {
    content: resultContent,
    _meta: {
      tool: input.action,
      card: {
        workspaceId: workspace.id,
        root: workspace.root,
        path: workspace.root,
        summary: {
          agentsFiles: loadedAgentsFiles.length,
          availableAgentsFiles: availableAgentsFileOutputs.length,
          skills: visibleSkills.length,
          skillDiagnostics: workspace.skillDiagnostics.length,
        },
      },
    },
    structuredContent: {
      workspaceId: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      worktree: workspace.worktree,
      agentsFiles: loadedAgentsFiles,
      availableAgentsFiles: availableAgentsFileOutputs,
      skills: visibleSkills,
      skillDiagnostics: workspace.skillDiagnostics,
      projectMemory,
      requestedAdditionalRoots,
      effectiveAdditionalRoots,
      rejectedAdditionalRoots,
      additionalRootsScope,
      additionalRootsPersisted,
      reused: input.context.reused,
      instruction,
    },
  };
}
