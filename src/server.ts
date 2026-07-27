import { createHash, randomUUID } from "node:crypto";
import { accessSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool as registerMcpAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { attachRegisteredToolName } from "./tool-result-metadata.js";
import { classifyMcpClient } from "./mcp-client-classification.js";
import {
  createShutdownHandler,
  type ShutdownReason,
} from "./process-shutdown.js";
import {
  logEvent,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  BackgroundJobManager,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  JOB_RUNNERS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_POLL_BYTES,
  type JobSnapshot,
} from "./background-jobs.js";
import { RunnerRegistry, type RunnerInspection } from "./runner-registry.js";
import {
  ArtifactLedger,
  MAX_ARTIFACT_ROOTS,
  MAX_LIST_ARTIFACTS,
} from "./artifact-ledger.js";
import {
  ArtifactPublisher,
  DEFAULT_ARTIFACT_TTL_SECONDS,
  MAX_ARTIFACT_TTL_SECONDS,
  MIN_ARTIFACT_TTL_SECONDS,
} from "./artifact-publisher.js";
import { loadCaptureProfile } from "./capture-profiles.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { MonitorEventStore, safeMonitorPath } from "./monitor-events.js";
import {
  LiveRequestMonitor,
  ProcessResourceMonitor,
  calculateLoadAssessment,
  diskSpaceSnapshot,
  liveMonitorHtml,
  requireLocalMonitor,
  setMonitorSecurityHeaders,
} from "./live-monitor.js";
import { importPng, MAX_PNG_IMPORT_BYTES } from "./png-import.js";
import { validatePng } from "./png-validator.js";
import { AssetReceiptStore } from "./asset-receipts.js";
import {
  readApprovedReceiptFile,
  reindexApprovedAssetReceipts,
  removeApprovedReceiptFile,
  writeImmutableApprovedReceipt,
} from "./approved-assets.js";
import { validateApprovedAssetReceipt } from "./asset-receipts.js";
import {
  IMPORT_PNG_FILE_PARAMS_META,
  openAiFileInputSchema,
} from "./openai-file.js";
import { importAsset, MAX_IMPORT_BYTES } from "./asset-import.js";
import { inspectArtifact } from "./artifact-inspector.js";
import {
  copyWorkspacePath,
  createWorkspaceDirectory,
  moveWorkspacePath,
  moveWorkspacePathToTrash,
  restoreWorkspaceFileFromTrash,
  snapshotWorkspaceFileToTrash,
} from "./workspace-files.js";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-paths.js";
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
} from "./git-tools.js";
import {
  GameSessionManager,
  MAX_GAME_LOG_READ_BYTES,
} from "./game-sessions.js";
import {
  ExternalInspectorManager,
  inspectAudio,
  inspectGlb,
} from "./inspectors.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  ProjectMemoryController,
  type ProjectMemoryCommandRunner,
} from "./project-memory.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  formatAgentsPath,
  WorkspaceRegistry,
  type Workspace,
  type WorkspaceContext,
} from "./workspaces.js";
import { type AdditionalRoot, normalizeAdditionalRoots } from "./roots.js";
import { TaskRunner } from "./task-runner.js";
import { checkManifestIntegrity, isTaskApproved } from "./task-manifest.js";
import {
  McpSessionRegistry,
  type McpSessionSnapshot,
} from "./mcp-session-registry.js";

type Transport = StreamableHTTPServerTransport;
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const TOOL_SCHEMA_REVISION =
  "devspacemac-approved-asset-registry-p1.2026-07-28";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const IMPORT_PNG_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  close(): void;
}

interface ServiceRuntime {
  bootId: string;
  startedAt: string;
  tools: string[];
  schemaFingerprint: string;
  requiredCapabilities: Record<string, ToolCapability>;
  mcpSessionStats: () => McpSessionSnapshot;
  monitorEvents: MonitorEventStore;
  workspaceApp?: {
    resourceUri: string;
    buildFingerprint: string;
    manifestSha256: string;
  };
}

async function rollbackImportedAsset(input: {
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

type ToolCapability =
  | "workspace.read"
  | "workspace.write"
  | "artifact.inspect"
  | "artifact.publish"
  | "runner.execute"
  | "git.read"
  | "git.write"
  | "game.control";

const EXPOSE_LEGACY_SHELL = false;

const registerAppTool: typeof registerMcpAppTool = ((
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
      const result = await Reflect.apply(
        handler as (...handlerArgs: unknown[]) => unknown,
        undefined,
        args,
      );
      return attachRegisteredToolName(String(name), result);
    }) as typeof handler,
  );
}) as typeof registerMcpAppTool;

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export interface WorkspaceAppBuild {
  entry: WorkspaceAppManifestEntry;
  uiDirectoryPath: string;
  resourceUri: string;
  buildFingerprint: string;
  manifestSha256: string;
}

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "project_memory"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "job"
  | "show_changes"
  | "review";

export const REVIEW_ONLY_WIDGET_TOOLS = [
  "git_diff",
  "list_artifacts",
  "inspect_artifact",
  "publish_artifact",
  "import_png",
  "archive_approved_image",
  "find_approved_assets",
  "verify_approved_asset",
  "recover_approved_asset",
  "reindex_approved_assets",
  "preview_artifact",
  "inspect_glb",
  "inspect_blend",
  "inspect_audio",
  "render_model_preview",
  "capture_game_frame",
] as const;

const reviewOnlyWidgetToolNames = new Set<string>(REVIEW_ONLY_WIDGET_TOOLS);

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

export function shouldAttachWidget(
  mode: WidgetMode,
  toolName: string,
  kind: ToolWidgetKind,
): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return (
        kind === "workspace" ||
        kind === "project_memory" ||
        kind === "show_changes"
      );
    case "review_only":
      return reviewOnlyWidgetToolNames.has(toolName);
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  toolName: string,
  kind: ToolWidgetKind,
  workspaceApp: WorkspaceAppBuild | undefined,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, toolName, kind)) return { _meta: {} };
  if (!workspaceApp) {
    throw new Error(
      `Workspace App build is required when DEVSPACE_WIDGETS=${config.widgets}.`,
    );
  }

  return {
    _meta: {
      ui: {
        resourceUri: workspaceApp.resourceUri,
        visibility: ["model"],
      },
    },
  };
}

interface ToolNames {
  openWorkspace: "open_workspace";
  read: "read_file" | "read";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function toolNamesFor(config: ServerConfig): ToolNames {
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

function exposeDedicatedReadTools(config: ServerConfig): boolean {
  return config.readOnly || !config.minimalTools;
}

function exposedToolNames(
  config: ServerConfig,
  toolNames: ToolNames,
): string[] {
  const tools = [
    "devspace_info",
    "list_workspaces",
    "list_artifacts",
    "inspect_artifact",
    "git_status",
    "git_diff",
    "inspect_glb",
    "resume_workspace",
    "open_workspace",
    "project_memory_preflight",
    toolNames.read,
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
    tools.push("start_job", "start_capture", "poll_job", "cancel_job");
  }
  return tools;
}

function createServiceRuntime(
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

function processMemorySnapshot(): {
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

function requiredCapabilityForTool(tool: string): ToolCapability {
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
  if (tool === "poll_task") return "workspace.read";
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

function serverInstructions(
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

  return `Use DevSpace as a local coding workspace. Call devspace_info when diagnosing tool discovery or server freshness. Use list_workspaces and resume_workspace to recover a persisted checkout or managed worktree by workspaceId after a server or client restart. Call ${toolNames.openWorkspace} once per new project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, job, capture, artifact, and Git tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspectionText}Prefer ${toolNames.edit} for targeted text modifications, ${toolNames.write} only for new text files or explicit complete rewrites, import_asset for binary asset intake, start_job/poll_job/cancel_job for named validation runners, start_capture for a validated project capture profile, inspect_artifact and list_artifacts for evidence, and preview_artifact or publish_artifact for short-lived review URLs. Arbitrary shell command execution is not exposed.${showChanges}${projectMemory}`;
}

export interface CreateServerOptions {
  projectMemoryRunner?: ProjectMemoryCommandRunner;
  workspaceAppBuild?: {
    manifestUrl?: URL;
    uiDirectoryUrl?: URL;
  };
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

function mcpSessionSourceCountsSchema() {
  return z.object({
    main_connector: z.number().int().nonnegative(),
    workspace_app: z.number().int().nonnegative(),
    doctor: z.number().int().nonnegative(),
    test_client: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  });
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const projectMemoryPreflightOutputSchema = z.object({
  status: z.enum(["ready", "unconfigured", "error"]),
  receiptId: z.string().optional(),
  decision: z.enum(["allow", "observe_would_deny", "deny"]).optional(),
  wouldDeny: z.boolean(),
  denialReasons: z.array(z.string()),
  bundle: z.unknown().optional(),
  error: z.string().optional(),
});

const workspaceContextOutputSchema: z.ZodRawShape = {
  workspaceId: z.string(),
  root: z.string(),
  mode: z.enum(["checkout", "worktree"]),
  sourceRoot: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      baseRef: z.string(),
      baseSha: z.string(),
      dirtySource: z.boolean(),
      detached: z.boolean(),
      managed: z.boolean(),
      branch: z.string().optional(),
    })
    .optional(),
  agentsFiles: z.array(workspaceAgentsFileOutputSchema),
  availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
  skills: z.array(workspaceSkillOutputSchema),
  skillDiagnostics: z.array(z.unknown()),
  projectMemory: projectMemoryPreflightOutputSchema.optional(),
  instruction: z.string(),
};

const workspaceSessionOutputSchema = z.object({
  workspaceId: z.string(),
  root: z.string(),
  mode: z.enum(["checkout", "worktree"]),
  sourceRoot: z.string().optional(),
  managed: z.boolean(),
  status: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  resumable: z.boolean(),
  unavailableReason: z.string().optional(),
});

const jobStatusSchema = z.enum([
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

const jobSnapshotOutputSchema = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  workspaceRoot: z.string(),
  workingDirectory: z.string(),
  runner: z.enum(JOB_RUNNERS),
  runnerVersion: z.string().optional(),
  args: z.array(z.string()),
  label: z.string().optional(),
  status: jobStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  timeoutSeconds: z.number().int(),
  maxOutputBytes: z.number().int(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  outputBytes: z.number().int(),
  outputTruncated: z.boolean(),
  errorCode: z
    .enum([
      "RUNNER_UNAVAILABLE",
      "JOB_TIMEOUT",
      "JOB_CANCELLED",
      "JOB_INTERRUPTED",
      "BLENDER_FAILED",
      "CAPTURE_FAILED",
      "RUNNER_FAILED",
    ])
    .optional(),
  error: z.string().optional(),
  artifactRoots: z.array(z.string()).optional(),
  artifactStatus: z.enum([
    "none",
    "pending",
    "complete",
    "incomplete",
    "error",
  ]),
  artifactCount: z.number().int(),
  artifactErrors: z.array(z.string()).optional(),
  captureProfile: z.string().optional(),
  output: z.string().optional(),
  outputOffsetBytes: z.number().int().optional(),
  nextOutputOffsetBytes: z.number().int().optional(),
});

const artifactTypeSchema = z.enum([
  "blend",
  "glb",
  "image",
  "audio",
  "json",
  "text",
]);

const artifactOutputSchema = z.object({
  artifactId: z.string(),
  relativePath: z.string(),
  artifactType: artifactTypeSchema,
  mimeType: z.string(),
  format: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  change: z.enum(["created", "modified"]),
  completion: z.enum(["complete", "incomplete"]),
  jobId: z.string().optional(),
  runner: z.enum(JOB_RUNNERS).optional(),
  runnerVersion: z.string().optional(),
  origin: z.union([
    z.object({
      kind: z.literal("job"),
      jobId: z.string(),
      runner: z.enum(JOB_RUNNERS),
      runnerVersion: z.string().optional(),
    }),
    z.object({
      kind: z.literal("import"),
      importId: z.string(),
      source: z.enum(["https", "base64"]),
      sourceHost: z.string().optional(),
    }),
  ]),
  workspaceId: z.string(),
  createdAt: z.string(),
  gitStatus: z.enum(["tracked", "untracked", "ignored", "unknown"]),
  presence: z.enum([
    "present",
    "missing",
    "superseded",
    "unsafe",
    "unverified",
  ]),
});

const captureProfileOutputSchema = z.object({
  name: z.string(),
  runner: z.enum(["godot", "godot-mono"]),
  workingDirectory: z.string(),
  args: z.array(z.string()),
  artifactRoots: z.array(z.string()),
  timeoutSeconds: z.number().int(),
  capture: z.object({
    project: z.string(),
    scene: z.string(),
    viewportWidth: z.number().int(),
    viewportHeight: z.number().int(),
    randomSeed: z.number().int(),
    warmupFrames: z.number().int(),
    captureFrame: z.number().int(),
    outputPath: z.string(),
    manifestPath: z.string(),
    sourceCommit: z.string(),
  }),
});

function formatRunnerSummary(runners: RunnerInspection[]): string {
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

function projectMemoryReceiptInputSchema(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe(
      "Receipt ID returned by the latest Project Memory preflight for this task. SHADOW records missing or stale IDs but does not block the tool.",
    );
}

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
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

function requestLogFields(
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

function boundedHeader(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value?.slice(0, maxLength);
}

function safeUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.slice(0, 120);
  } catch {
    return "invalid";
  }
}

function userAgentCategory(value: string | undefined): string {
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

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
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

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
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
  monitorEvents.record({
    source: "tool",
    severity: "error",
    code:
      /^([A-Z][A-Z0-9_]{2,63})(?::|\b)/.exec(errorPreview ?? "")?.[1] ??
      "TOOL_CALL_FAILED",
    message: `${fields.tool} tool failed`,
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function gitToolFailure(tool: string, error: unknown, projectMemory: unknown) {
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

function gitRemotePolicyForWorkspace(
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

function assertManagedAttachedGitWorkspace(workspace: Workspace): void {
  if (
    workspace.mode !== "worktree" ||
    workspace.worktree?.managed !== true ||
    workspace.worktree.path !== workspace.root
  ) {
    throw new Error(
      "GIT_MANAGED_WORKTREE_REQUIRED: Operation requires a DevSpace-managed worktree.",
    );
  }
  if (workspace.worktree.detached || !workspace.worktree.branch) {
    throw new Error(
      "GIT_DETACHED_HEAD: Operation requires an attached managed worktree branch.",
    );
  }
}

function gitRemoteWriteSummary(config: ServerConfig) {
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

function assertJobWorkspace(job: JobSnapshot, workspaceId: string): void {
  if (job.workspaceId !== workspaceId) {
    throw new Error("Job does not belong to this workspaceId.");
  }
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
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

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function uiBuildDirectoryUrl(): URL {
  return new URL("../dist/ui/", import.meta.url);
}

export function resolveWorkspaceAppBuild(
  input: {
    manifestUrl?: URL;
    uiDirectoryUrl?: URL;
  } = {},
): WorkspaceAppBuild {
  const manifestUrl = input.manifestUrl ?? uiManifestUrl();
  const uiDirectoryUrl = input.uiDirectoryUrl ?? uiBuildDirectoryUrl();
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestUrl, "utf8");
  } catch (error) {
    throw new Error(
      `Workspace App manifest is unavailable. Run npm run build before starting DevSpace: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let manifest: WorkspaceAppManifest;
  try {
    manifest = JSON.parse(manifestText) as WorkspaceAppManifest;
  } catch (error) {
    throw new Error(
      `Workspace App manifest is invalid. Run npm run build before starting DevSpace: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  const candidates = [entry.file, ...(entry.css ?? [])].map((assetPath) => {
    if (
      !assetPath ||
      assetPath.startsWith("/") ||
      assetPath.includes("\\") ||
      assetPath.split("/").includes("..")
    ) {
      throw new Error(
        `Workspace App manifest contains an invalid asset path: ${assetPath}.`,
      );
    }
    return {
      assetPath,
      url: new URL(assetPath, uiDirectoryUrl),
    };
  });
  for (const candidate of candidates) {
    try {
      accessSync(candidate.url);
    } catch (error) {
      throw new Error(
        `Workspace App asset is unavailable: ${candidate.assetPath}. Run npm run build before starting DevSpace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const manifestSha256 = createHash("sha256")
    .update(manifestText)
    .digest("hex");
  const buildFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        packageVersion: PACKAGE_VERSION,
        schemaRevision: TOOL_SCHEMA_REVISION,
        manifestSha256,
      }),
    )
    .digest("hex");

  return {
    entry,
    uiDirectoryPath: fileURLToPath(uiDirectoryUrl),
    manifestSha256,
    buildFingerprint,
    resourceUri: `ui://devspace/workspace-app-${buildFingerprint.slice(0, 16)}.html`,
  };
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(
  config: ServerConfig,
  workspaceApp: WorkspaceAppBuild,
): string {
  const baseUrl = assetBaseUrl(config);
  const entry = workspaceApp.entry;
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: Pick<ServerConfig, "publicBaseUrl">): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

export function workspaceAppUiMetadata(
  config: Pick<ServerConfig, "publicBaseUrl">,
): {
  prefersBorder: true;
  domain: string;
  csp: ReturnType<typeof appCsp>;
} {
  const domain = new URL(config.publicBaseUrl).origin;
  return {
    prefersBorder: true,
    domain,
    csp: appCsp(config),
  };
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function workspaceContextToolResponse(input: {
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
  const instruction = `${instructionPrefix}${instructionCore}${instructionSkills}${instructionReadOnly}${instructionProjectMemory}`;
  const resultContent: ToolContent[] = [
    {
      type: "text",
      text: [
        `${input.actionLabel} workspace ${workspace.id}`,
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
      instruction,
    },
  };
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  jobs: BackgroundJobManager,
  games: GameSessionManager,
  inspectors: ExternalInspectorManager,
  runners: RunnerRegistry,
  artifacts: ArtifactLedger,
  assetReceipts: AssetReceiptStore,
  publisher: ArtifactPublisher,
  runtime: ServiceRuntime,
  workspaceApp: WorkspaceAppBuild | undefined,
  tasks: TaskRunner,
): McpServer {
  const toolNames = toolNamesFor(config);
  const widgetMeta = (
    toolName: string,
    kind: ToolWidgetKind,
  ): ToolWidgetDescriptorMeta =>
    toolWidgetDescriptorMeta(config, toolName, kind, workspaceApp);
  const interactiveWidgetMeta = (
    toolName: string,
    kind: ToolWidgetKind,
    extraMeta: Record<string, unknown> = {},
  ): ToolWidgetDescriptorMeta => {
    const base = widgetMeta(toolName, kind)._meta as Record<string, unknown>;
    const ui = base.ui as
      { resourceUri: string; visibility: string[] } | undefined;
    return {
      _meta: {
        ...extraMeta,
        ...base,
        ...(ui
          ? {
              ui: {
                ...ui,
                visibility: ["model", "app"],
              },
            }
          : {}),
      },
    };
  };
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: PACKAGE_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config, toolNames),
    },
  );

  if (workspaceApp) {
    registerAppResource(
      server,
      "DevSpace Workspace App",
      workspaceApp.resourceUri,
      {
        description:
          "Versioned interactive card for viewing DevSpace workspace and tool results.",
        _meta: {
          ui: workspaceAppUiMetadata(config),
        },
      },
      async () => ({
        contents: [
          {
            uri: workspaceApp.resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config, workspaceApp),
            _meta: {
              ui: workspaceAppUiMetadata(config),
            },
          },
        ],
      }),
    );

    registerAppTool(
      server,
      "report_workspace_app_error",
      {
        title: "Report Workspace App diagnostic",
        description:
          "Records a bounded, sanitized Workspace App runtime diagnostic. This tool is available only to the embedded App and does not accept messages, URLs, stack traces, chat content, or tool arguments.",
        inputSchema: {
          kind: z.enum([
            "script_error",
            "unhandled_rejection",
            "resource_error",
            "connect_error",
            "render_error",
          ]),
          phase: z.enum([
            "bootstrap",
            "connect",
            "tool_result",
            "render",
            "payload_load",
            "teardown",
          ]),
          errorName: z
            .string()
            .max(48)
            .regex(/^[A-Za-z0-9_.-]+$/)
            .optional(),
          resourceType: z
            .enum(["script", "style", "image", "font", "other"])
            .optional(),
          appVersion: z
            .string()
            .max(16)
            .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
          instanceId: z.uuid().optional(),
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (diagnostic) => {
        const result =
          runtime.monitorEvents.recordWorkspaceAppError(diagnostic);
        return {
          content: [
            textBlock(
              result.accepted
                ? "Workspace App diagnostic recorded."
                : `Workspace App diagnostic skipped (${result.reason}).`,
            ),
          ],
          structuredContent: result,
        };
      },
    );
  }

  registerAppTool(
    server,
    "devspace_info",
    {
      title: "DevSpace info",
      description:
        "Inspect the running DevSpace build, boot identity, tool schema fingerprint, enabled tools, approved roots, and bounded background-job capabilities. Use this to diagnose stale ChatGPT action discovery or verify that a restart loaded the expected build. Does not return credentials or environment variables.",
      inputSchema: {},
      outputSchema: resultOutputSchema({
        name: z.literal("devspace"),
        version: z.string(),
        bootId: z.string(),
        startedAt: z.string(),
        uptimeSeconds: z.number(),
        schemaRevision: z.string(),
        schemaFingerprint: z.string(),
        tools: z.array(z.string()),
        requiredCapabilities: z.record(z.string(), z.string()),
        readOnly: z.boolean(),
        toolMode: z.enum(["minimal", "full"]),
        toolNaming: z.enum(["legacy", "short"]),
        widgets: z.enum(["off", "changes", "review_only", "full"]),
        workspaceApp: z
          .object({
            resourceUri: z.string(),
            buildFingerprint: z.string(),
            manifestSha256: z.string(),
          })
          .optional(),
        allowedRoots: z.array(z.string()),
        worktreeRoot: z.string(),
        mcpSessions: z.object({
          transportMode: z.enum(["stateful", "stateless"]),
          active: z.number().int().nonnegative(),
          highWaterMark: z.number().int().nonnegative(),
          created: z.number().int().nonnegative(),
          initializeRequests: z.number().int().nonnegative(),
          statelessRequests: z.number().int().nonnegative(),
          acquireRequests: z.number().int().nonnegative(),
          reusedRequests: z.number().int().nonnegative(),
          unknownSessionRequests: z.number().int().nonnegative(),
          closed: z.number().int().nonnegative(),
          clientClosed: z.number().int().nonnegative(),
          expired: z.number().int().nonnegative(),
          capacityEvictions: z.number().int().nonnegative(),
          closeErrors: z.number().int().nonnegative(),
          createdLastMinute: z.number().int().nonnegative(),
          createdLastFiveMinutes: z.number().int().nonnegative(),
          inFlightRequests: z.number().int().nonnegative(),
          activeBySource: mcpSessionSourceCountsSchema(),
          createdBySource: mcpSessionSourceCountsSchema(),
          unknownRequestsByReason: z.object({
            client: z.number().int().nonnegative(),
            expired: z.number().int().nonnegative(),
            capacity: z.number().int().nonnegative(),
            shutdown: z.number().int().nonnegative(),
            never_seen: z.number().int().nonnegative(),
          }),
          idleTtlSeconds: z.number().positive(),
          maxSessions: z.number().int().positive(),
        }),
        memory: z.object({
          rssMiB: z.number().int().nonnegative(),
          heapUsedMiB: z.number().int().nonnegative(),
          heapTotalMiB: z.number().int().nonnegative(),
          externalMiB: z.number().int().nonnegative(),
        }),
        jobs: z.object({
          runners: z.array(z.enum(JOB_RUNNERS)),
          maxConcurrent: z.number().int(),
          maxTimeoutSeconds: z.number().int(),
          maxOutputBytes: z.number().int(),
        }),
        runnerRegistry: z.object({
          runners: z.array(
            z.object({
              name: z.enum(JOB_RUNNERS),
              enabled: z.boolean(),
              available: z.boolean(),
              executableExists: z.boolean(),
              executableConfigured: z.boolean(),
              supported: z.boolean(),
              version: z.string().optional(),
              diagnostic: z.string().optional(),
              supportedPlatforms: z.array(z.string()),
              argumentPolicy: z.string(),
              workingDirectoryPolicy: z.literal("workspace"),
              defaultTimeoutSeconds: z.number().int(),
              maxTimeoutSeconds: z.number().int(),
              maxConcurrent: z.number().int(),
              maxOutputBytes: z.number().int(),
              networkPolicy: z.enum([
                "inherited",
                "offline_requested",
                "disabled",
              ]),
              containment: z.enum(["strict", "best_effort", "trusted_local"]),
              artifactPolicy: z.literal("declared_workspace_roots"),
            }),
          ),
          diagnostics: z.array(z.string()),
        }),
        artifactPublication: z.object({
          tokenPersistence: z.literal("memory_only"),
          defaultTtlSeconds: z.number().int(),
          minTtlSeconds: z.number().int(),
          maxTtlSeconds: z.number().int(),
          restartInvalidatesTokens: z.literal(true),
          supportedFormats: z.array(z.string()),
          captureProfileDirectory: z.literal(".devspace/captures"),
        }),
        gitRemoteWrite: z.object({
          enabled: z.boolean(),
          approvedRemotes: z.array(z.string()),
          approvedDestinationBranches: z.array(z.string()),
          approvedRepositoryRoots: z.array(z.string()),
          allowForce: z.literal(false),
          requireCleanWorkspace: z.literal(true),
          requireExpectedRemoteSha: z.literal(true),
          requireFastForward: z.literal(true),
        }),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const runnerRegistry = await runners.inspectAll();
      const mcpSessions = runtime.mcpSessionStats();
      const memory = processMemorySnapshot();
      const uptimeSeconds = Math.max(
        0,
        (Date.now() - Date.parse(runtime.startedAt)) / 1000,
      );
      const details = {
        name: "devspace" as const,
        version: PACKAGE_VERSION,
        bootId: runtime.bootId,
        startedAt: runtime.startedAt,
        uptimeSeconds,
        schemaRevision: TOOL_SCHEMA_REVISION,
        schemaFingerprint: runtime.schemaFingerprint,
        tools: runtime.tools,
        requiredCapabilities: runtime.requiredCapabilities,
        readOnly: config.readOnly,
        toolMode: config.minimalTools
          ? ("minimal" as const)
          : ("full" as const),
        toolNaming: config.toolNaming,
        widgets: config.widgets,
        workspaceApp: runtime.workspaceApp,
        allowedRoots: config.allowedRoots,
        worktreeRoot: config.worktreeRoot,
        mcpSessions,
        memory,
        jobs: {
          runners: [...JOB_RUNNERS],
          maxConcurrent: MAX_CONCURRENT_JOBS,
          maxTimeoutSeconds: MAX_JOB_TIMEOUT_SECONDS,
          maxOutputBytes: MAX_JOB_OUTPUT_BYTES,
        },
        runnerRegistry,
        artifactPublication: {
          tokenPersistence: "memory_only" as const,
          defaultTtlSeconds: DEFAULT_ARTIFACT_TTL_SECONDS,
          minTtlSeconds: MIN_ARTIFACT_TTL_SECONDS,
          maxTtlSeconds: MAX_ARTIFACT_TTL_SECONDS,
          restartInvalidatesTokens: true as const,
          supportedFormats: [
            "BLEND",
            "GLB",
            "PNG",
            "JPEG",
            "WEBP",
            "WAV",
            "OGG",
            "JSON",
            "TXT",
            "LOG",
          ],
          captureProfileDirectory: ".devspace/captures" as const,
        },
        gitRemoteWrite: gitRemoteWriteSummary(config),
      };
      const result = [
        `DevSpace ${PACKAGE_VERSION}`,
        `Boot ID: ${runtime.bootId}`,
        `Schema: ${TOOL_SCHEMA_REVISION} (${runtime.schemaFingerprint})`,
        `Tools (${runtime.tools.length}): ${runtime.tools.join(", ")}`,
        `Mode: ${details.toolMode}, readOnly=${String(config.readOnly)}`,
        `MCP transport: ${mcpSessions.transportMode}; sessions ${mcpSessions.active}/${mcpSessions.maxSessions} active; high-water ${mcpSessions.highWaterMark}; created ${mcpSessions.createdLastMinute}/min; stateless requests ${mcpSessions.statelessRequests}; reused ${mcpSessions.reusedRequests}; unknown ${mcpSessions.unknownSessionRequests}; expired ${mcpSessions.expired}; capacity evictions ${mcpSessions.capacityEvictions}`,
        `Memory: RSS ${memory.rssMiB} MiB; heap ${memory.heapUsedMiB}/${memory.heapTotalMiB} MiB`,
        runtime.workspaceApp
          ? `Workspace App: ${runtime.workspaceApp.resourceUri} (${runtime.workspaceApp.buildFingerprint})`
          : "Workspace App: disabled",
        `Allowed roots: ${config.allowedRoots.join(", ")}`,
        `Git remote write: enabled=${String(config.gitRemoteWrite.enabled)}, remotes=${config.gitRemoteWrite.approvedRemotes.join(", ") || "(none)"}, branches=${config.gitRemoteWrite.approvedDestinationBranches.join(", ") || "(none)"}, force=false`,
        `Runners: ${formatRunnerSummary(runnerRegistry.runners)}`,
        runnerRegistry.diagnostics.length > 0
          ? `Runner diagnostics: ${runnerRegistry.diagnostics.join(" | ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [textBlock(result)],
        _meta: { tool: "devspace_info" },
        structuredContent: { result, ...details },
      };
    },
  );

  registerAppTool(
    server,
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List recent persisted workspace sessions that remain inside the current filesystem policy. Use this after reconnecting or restarting, then pass a resumable workspaceId to resume_workspace. Missing managed worktrees are reported but never recreated.",
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

  registerAppTool(
    server,
    "list_artifacts",
    {
      title: "List artifacts",
      description:
        "List bounded, versioned artifacts discovered from declared workspace artifact roots after background jobs. Filter by job, relative path prefix, or artifact type. Every record includes SHA-256, producer, completion state, Git status, and current presence; deleted files remain visible as missing.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the artifacts."),
        jobId: z
          .string()
          .regex(/^job_[0-9a-f-]{36}$/)
          .optional()
          .describe("Optional producing job identifier."),
        pathPrefix: z
          .string()
          .max(512)
          .optional()
          .describe("Optional workspace-relative artifact path prefix."),
        type: artifactTypeSchema
          .optional()
          .describe("Optional artifact type filter."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_ARTIFACTS)
          .optional()
          .describe("Maximum records to return. Defaults to 50."),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        artifacts: z.array(artifactOutputSchema),
      }),
      ...widgetMeta("list_artifacts", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      jobId,
      pathPrefix,
      type,
      limit,
      projectMemoryReceiptId,
    }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "list_artifacts",
        projectMemoryReceiptId,
      );
      const listed = await artifacts.listArtifacts({
        workspaceId,
        workspaceRoot: workspace.root,
        jobId,
        pathPrefix,
        type,
        limit,
      });
      const result =
        listed.length === 0
          ? "No matching artifacts are registered."
          : listed
              .map(
                (artifact) =>
                  `${artifact.artifactId} | ${artifact.presence} | ${artifact.format} | ${artifact.size} bytes | sha256 ${artifact.sha256} | ${artifact.relativePath}`,
              )
              .join("\n");
      logToolCall(config, {
        tool: "list_artifacts",
        workspaceId,
        path: pathPrefix,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {
          tool: "list_artifacts",
          projectMemory,
          card: {
            workspaceId,
            path: pathPrefix,
            summary: { count: listed.length, jobId, type },
          },
        },
        structuredContent: { result, artifacts: listed },
      };
    },
  );

  registerAppTool(
    server,
    "inspect_artifact",
    {
      title: "Inspect artifact",
      description:
        "Inspect one workspace-local artifact by registered artifactId or path. Returns a SHA-256 snapshot and bounded container metadata without executing the file.",
      inputSchema: {
        workspaceId: z.string(),
        artifactId: z
          .string()
          .regex(/^artifact_[0-9a-f-]{36}$/)
          .optional(),
        path: z.string().max(512).optional(),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({ inspection: z.unknown() }),
      ...widgetMeta("inspect_artifact", "review"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, artifactId, path, projectMemoryReceiptId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "inspect_artifact",
        projectMemoryReceiptId,
      );
      const inspection = await inspectArtifact({
        ledger: artifacts,
        workspaceId,
        workspaceRoot: workspace.root,
        artifactId,
        path,
      });
      const result = `${inspection.format} | ${inspection.size} bytes | sha256 ${inspection.sha256} | ${inspection.path}`;
      logToolCall(config, {
        tool: "inspect_artifact",
        workspaceId,
        path: inspection.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: { tool: "inspect_artifact", projectMemory },
        structuredContent: { result, inspection },
      };
    },
  );

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

  if (!config.readOnly) {
    registerAppTool(
      server,
      "publish_artifact",
      {
        title: "Publish artifact",
        description:
          "Create a high-entropy, short-lived URL for one registered artifact version after revalidating its current workspace path, type, size, and SHA-256. Provide exactly one of artifactId or path. Image URLs are inline previews; JSON, text, GLB, and BLEND use safe downloads. Grants live only in memory and become invalid when DevSpace restarts.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier that owns the artifact."),
          artifactId: z
            .string()
            .regex(/^artifact_[0-9a-f-]{36}$/)
            .optional()
            .describe("Opaque artifact ID returned by list_artifacts."),
          path: z
            .string()
            .max(512)
            .optional()
            .describe(
              "Exact workspace-relative path of the latest registered artifact version.",
            ),
          purpose: z
            .enum(["review", "download", "inspection"])
            .optional()
            .describe("Defaults to review and is retained in the audit event."),
          ttlSeconds: z
            .number()
            .int()
            .min(MIN_ARTIFACT_TTL_SECONDS)
            .max(MAX_ARTIFACT_TTL_SECONDS)
            .optional()
            .describe(
              `Defaults to ${DEFAULT_ARTIFACT_TTL_SECONDS}; valid range ${MIN_ARTIFACT_TTL_SECONDS}-${MAX_ARTIFACT_TTL_SECONDS}.`,
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          artifact: artifactOutputSchema,
          url: z.string().url(),
          expiresAt: z.string(),
          contentType: z.string(),
          size: z.number().int().nonnegative(),
          sha256: z.string(),
          previewType: z.enum(["image", "audio", "text", "json", "download"]),
        }),
        ...interactiveWidgetMeta("publish_artifact", "review"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        workspaceId,
        artifactId,
        path,
        purpose,
        ttlSeconds,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "publish_artifact",
          projectMemoryReceiptId,
        );
        const publication = await publisher.publish({
          workspaceId,
          workspaceRoot: workspace.root,
          artifactId,
          path,
          purpose,
          ttlSeconds,
        });
        const result = [
          `Published ${publication.artifact.relativePath}`,
          `URL: ${publication.url}`,
          `Expires: ${publication.expiresAt}`,
          `Type: ${publication.previewType} (${publication.contentType})`,
          `Size: ${publication.size}`,
          `SHA-256: ${publication.sha256}`,
        ].join("\n");
        logToolCall(config, {
          tool: "publish_artifact",
          workspaceId,
          path: publication.artifact.relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "publish_artifact",
            projectMemory,
            card: {
              workspaceId,
              path: publication.artifact.relativePath,
              summary: {
                artifactId: publication.artifact.artifactId,
                previewType: publication.previewType,
                expiresAt: publication.expiresAt,
                sha256: publication.sha256,
              },
            },
          },
          structuredContent: { result, ...publication },
        };
      },
    );

    registerAppTool(
      server,
      "archive_approved_image",
      {
        title: "Archive approved image",
        description:
          "Freeze a human-approved PNG into the workspace and create an immutable project receipt plus rebuildable SQLite index. Provide exactly one of file or existingImportReceiptId. This records approval but never runs Blender, Godot, Atlas, color matching, or another production pipeline.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().max(512),
          receiptDirectory: z.string().max(512),
          file: openAiFileInputSchema.optional(),
          existingImportReceiptId: z
            .string()
            .regex(/^import_receipt_[0-9a-f]{64}$/)
            .optional(),
          projectId: z.string().min(1).max(512),
          taskId: z.string().min(1).max(512),
          assetRole: z.string().min(1).max(512),
          sourceKind: z.enum([
            "user_upload",
            "image_gen",
            "file_library",
            "historical_conversation",
          ]),
          generationId: z.string().min(1).max(512).optional(),
          model: z.string().min(1).max(512).optional(),
          prompt: z.string().min(1).max(100_000).optional(),
          approvedPurpose: z.string().min(1).max(4096),
          decisionText: z.string().min(1).max(16_384),
          evidenceRef: z.string().min(1).max(4096).optional(),
          supersedesAssetReceiptId: z
            .string()
            .regex(/^asset_receipt_[0-9a-f]{64}$/)
            .optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          workspaceId: z.string(),
          path: z.string(),
          outcome: z.enum(["created", "unchanged", "replaced"]),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          mimeType: z.literal("image/png"),
          artifactId: z.string(),
          importReceiptId: z.string(),
          assetReceiptId: z.string(),
          assetReceiptPath: z.string(),
          humanApproval: z.object({
            status: z.literal("passed"),
            actor: z.literal("human_user"),
          }),
          supersedesAssetReceiptId: z.string().optional(),
          readyForPipeline: z.literal(true),
        }),
        ...interactiveWidgetMeta(
          "archive_approved_image",
          "review",
          IMPORT_PNG_FILE_PARAMS_META,
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({
        workspaceId,
        path,
        receiptDirectory,
        file,
        existingImportReceiptId,
        projectId,
        taskId,
        assetRole,
        sourceKind,
        generationId,
        model,
        prompt,
        approvedPurpose,
        decisionText,
        evidenceRef,
        supersedesAssetReceiptId,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "archive_approved_image",
          projectMemoryReceiptId,
        );
        const destination = workspaces.resolvePath(workspace, path);
        let displacedTrashId: string | undefined;
        let registeredArtifact:
          Awaited<ReturnType<ArtifactLedger["registerImport"]>> | undefined;
        let createdImportReceiptId: string | undefined;
        let importedOutcome: "created" | "unchanged" | "replaced" = "unchanged";
        try {
          if (
            (file === undefined) ===
            (existingImportReceiptId === undefined)
          ) {
            throw new Error(
              "APPROVED_ASSET_SOURCE_INVALID: Provide exactly one of file or existingImportReceiptId.",
            );
          }
          if (
            sourceKind === "image_gen" &&
            (!generationId || !model || !prompt)
          ) {
            throw new Error(
              "APPROVED_ASSET_SOURCE_INVALID: image_gen requires generationId, model, and the complete prompt.",
            );
          }
          const currentApproved = assetReceipts.getCurrentApprovedForPath(
            projectId,
            path,
          );
          if (supersedesAssetReceiptId) {
            if (
              !currentApproved ||
              currentApproved.assetReceiptId !== supersedesAssetReceiptId
            ) {
              throw new Error(
                "APPROVED_ASSET_SUPERSESSION_INVALID: supersedesAssetReceiptId must identify the current approved version for this project path.",
              );
            }
          }

          let importReceipt;
          if (existingImportReceiptId) {
            importReceipt = assetReceipts.getImport(
              workspaceId,
              existingImportReceiptId,
            );
            if (!importReceipt) {
              throw new Error(
                "ASSET_IMPORT_RECEIPT_NOT_FOUND: The import receipt is not registered for this workspace.",
              );
            }
            if (importReceipt.destinationPath !== path) {
              throw new Error(
                "ASSET_IMPORT_RECEIPT_MISMATCH: Receipt destination does not match path.",
              );
            }
            const currentSha256 = createHash("sha256")
              .update(readFileSync(destination))
              .digest("hex");
            if (currentSha256 !== importReceipt.sha256) {
              throw new Error(
                "ASSET_IMPORT_RECEIPT_MISMATCH: Current file SHA-256 differs from the import receipt.",
              );
            }
            importedOutcome = importReceipt.outcome;
          } else {
            const imported = await importPng({
              destination,
              workspaceRoot: workspace.root,
              file,
              overwrite: Boolean(supersedesAssetReceiptId),
              beforeCommit:
                supersedesAssetReceiptId && existsSync(destination)
                  ? async () => {
                      const snapshot = await snapshotWorkspaceFileToTrash({
                        workspaceRoot: workspace.root,
                        stateDir: config.stateDir,
                        workspaceId,
                        path,
                      });
                      displacedTrashId = snapshot.trashId;
                    }
                  : undefined,
            });
            importedOutcome = imported.outcome;
            const previousArtifact =
              imported.outcome === "replaced" && imported.previousSha256
                ? artifacts.getLatestArtifactForPath(
                    workspaceId,
                    path,
                    imported.previousSha256,
                  )
                : undefined;
            let artifact = artifacts.getLatestArtifactForPath(
              workspaceId,
              path,
              imported.sha256,
            );
            if (!artifact || imported.outcome !== "unchanged") {
              artifact = await artifacts.registerImport({
                workspaceId,
                workspaceRoot: workspace.root,
                relativePath: path,
                importId: `import_${randomUUID()}`,
                source: imported.source,
                sourceFileId: imported.sourceFileId,
                sourceFileName: imported.sourceFileName,
                overwritten: imported.outcome === "replaced",
                previousArtifactId: previousArtifact?.artifactId,
              });
              registeredArtifact = artifact;
            }
            importReceipt = assetReceipts.registerImport({
              workspaceId,
              destinationPath: path,
              outcome: imported.outcome,
              bytes: imported.bytes,
              sha256: imported.sha256,
              width: imported.width,
              height: imported.height,
              mimeType: imported.mimeType,
              sourceKind: imported.source,
              sourceFileId: imported.sourceFileId,
              sourceFileName: imported.sourceFileName,
              artifactId: artifact.artifactId,
              previousSha256: imported.previousSha256,
              previousArtifactId: previousArtifact?.artifactId,
              displacedTrashId,
            });
            createdImportReceiptId = importReceipt.importReceiptId;
          }

          if (
            currentApproved &&
            currentApproved.asset.sha256 !== importReceipt.sha256 &&
            !supersedesAssetReceiptId
          ) {
            throw new Error(
              `APPROVED_ASSET_REPLACEMENT_REQUIRES_SUPERSESSION: Current approved receipt is ${currentApproved.assetReceiptId}.`,
            );
          }
          const candidate = assetReceipts.buildApproved({
            projectId,
            taskId,
            assetRole,
            importReceipt,
            sourceKind,
            generationId,
            model,
            prompt,
            approvedPurpose,
            decisionText,
            evidenceRef,
            supersedesAssetReceiptId,
            receiptDirectory,
          });
          const approved =
            assetReceipts.getApproved(candidate.assetReceiptId) ?? candidate;
          const receiptWrite = await writeImmutableApprovedReceipt(
            workspace.root,
            approved,
          );
          try {
            assetReceipts.registerApproved(approved);
          } catch (error) {
            if (receiptWrite.created) {
              await removeApprovedReceiptFile(
                workspace.root,
                approved.projectReceiptPath,
              );
            }
            throw error;
          }
          const result = `Archived human-approved PNG ${path} as ${approved.assetReceiptId}; project receipt ${approved.projectReceiptPath}. Pipeline execution remains separate.`;
          logToolCall(config, {
            tool: "archive_approved_image",
            workspaceId,
            path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            _meta: {
              tool: "archive_approved_image",
              projectMemory,
              card: {
                workspaceId,
                path,
                summary: {
                  ...approved.asset,
                  outcome: importedOutcome,
                  artifactId: importReceipt.artifactId,
                  importReceiptId: importReceipt.importReceiptId,
                  assetReceiptId: approved.assetReceiptId,
                  assetReceiptPath: approved.projectReceiptPath,
                  humanApproval: approved.humanApproval,
                  supersedesAssetReceiptId,
                  readyForPipeline: true,
                },
              },
            },
            structuredContent: {
              result,
              workspaceId,
              path,
              outcome: importedOutcome,
              ...approved.asset,
              artifactId: importReceipt.artifactId,
              importReceiptId: importReceipt.importReceiptId,
              assetReceiptId: approved.assetReceiptId,
              assetReceiptPath: approved.projectReceiptPath,
              humanApproval: {
                status: approved.humanApproval.status,
                actor: approved.humanApproval.actor,
              },
              supersedesAssetReceiptId,
              readyForPipeline: true,
            },
          };
        } catch (error) {
          if (createdImportReceiptId) {
            try {
              assetReceipts.removeImport(createdImportReceiptId);
              if (registeredArtifact) {
                artifacts.removeArtifact(
                  workspaceId,
                  registeredArtifact.artifactId,
                );
              }
              if (importedOutcome !== "unchanged") {
                await rollbackImportedAsset({
                  workspaceRoot: workspace.root,
                  stateDir: config.stateDir,
                  workspaceId,
                  path,
                  displacedTrashId,
                });
              }
            } catch (rollbackError) {
              throw new Error(
                `APPROVED_ASSET_ROLLBACK_FAILED: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`,
              );
            }
          }
          const message =
            error instanceof Error ? error.message : String(error);
          logToolCall(config, {
            tool: "archive_approved_image",
            workspaceId,
            path,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message,
          });
          return { content: [textBlock(message)], isError: true };
        }
      },
    );

    registerAppTool(
      server,
      "find_approved_assets",
      {
        title: "Find approved assets",
        description:
          "Query the rebuildable approved-asset registry by project, task, role, source file ID, destination path, or receipt ID. Returns summaries by default and never grants access to historical file bytes.",
        inputSchema: {
          workspaceId: z.string(),
          projectId: z.string().min(1).max(512).optional(),
          taskId: z.string().min(1).max(512).optional(),
          assetRole: z.string().min(1).max(512).optional(),
          sourceFileId: z.string().min(1).max(512).optional(),
          path: z.string().min(1).max(512).optional(),
          assetReceiptId: z
            .string()
            .regex(/^asset_receipt_[0-9a-f]{64}$/)
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          assets: z.array(z.unknown()),
          count: z.number().int().nonnegative(),
        }),
        ...interactiveWidgetMeta("find_approved_assets", "review"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({
        workspaceId,
        projectId,
        taskId,
        assetRole,
        sourceFileId,
        path,
        assetReceiptId,
        limit,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "find_approved_assets",
          projectMemoryReceiptId,
        );
        const assets = assetReceipts.findApproved({
          projectId,
          taskId,
          assetRole,
          sourceFileId,
          destinationPath: path,
          assetReceiptId,
          limit,
        });
        const result =
          assets.length === 0
            ? "No approved assets matched the query."
            : assets
                .map(
                  (asset) =>
                    `${asset.assetReceiptId} ${asset.projectId}/${asset.taskId}/${asset.assetRole} ${asset.destinationPath} sha256=${asset.sha256} ${asset.current ? "current" : `superseded-by=${asset.supersededByAssetReceiptId}`}`,
                )
                .join("\n");
        logToolCall(config, {
          tool: "find_approved_assets",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: { tool: "find_approved_assets", projectMemory },
          structuredContent: { result, assets, count: assets.length },
        };
      },
    );

    registerAppTool(
      server,
      "verify_approved_asset",
      {
        title: "Verify approved asset",
        description:
          "Verify that the SQLite index, immutable project receipt, current PNG bytes, exact SHA-256 and supersession state agree. Only a current, exact human-approved asset returns readyForPipeline=true.",
        inputSchema: {
          workspaceId: z.string(),
          assetReceiptId: z.string().regex(/^asset_receipt_[0-9a-f]{64}$/),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          assetReceiptId: z.string(),
          path: z.string(),
          indexed: z.boolean(),
          projectReceiptValid: z.boolean(),
          filePresent: z.boolean(),
          sha256Matches: z.boolean(),
          dimensionsMatch: z.boolean(),
          superseded: z.boolean(),
          supersededByAssetReceiptId: z.string().optional(),
          readyForPipeline: z.boolean(),
        }),
        ...interactiveWidgetMeta("verify_approved_asset", "review"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, assetReceiptId, projectMemoryReceiptId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "verify_approved_asset",
          projectMemoryReceiptId,
        );
        const receipt = assetReceipts.getApproved(assetReceiptId);
        if (!receipt) {
          const result = `Approved asset receipt not found: ${assetReceiptId}.`;
          return {
            content: [textBlock(result)],
            isError: true,
            structuredContent: {
              result,
              assetReceiptId,
              path: "",
              indexed: false,
              projectReceiptValid: false,
              filePresent: false,
              sha256Matches: false,
              dimensionsMatch: false,
              superseded: false,
              readyForPipeline: false,
            },
          };
        }
        let projectReceiptValid = false;
        try {
          const projectReceipt = await readApprovedReceiptFile(
            workspace.root,
            receipt.projectReceiptPath,
          );
          validateApprovedAssetReceipt(projectReceipt);
          projectReceiptValid =
            JSON.stringify(projectReceipt) === JSON.stringify(receipt);
        } catch {
          projectReceiptValid = false;
        }
        let filePresent = false;
        let sha256Matches = false;
        let dimensionsMatch = false;
        try {
          const destination = resolveExistingWorkspacePath(
            workspace.root,
            receipt.asset.destinationPath,
            "file",
          );
          const bytes = readFileSync(destination.absolutePath);
          filePresent = true;
          sha256Matches =
            createHash("sha256").update(bytes).digest("hex") ===
            receipt.asset.sha256;
          const dimensions = await validatePng(bytes);
          dimensionsMatch =
            dimensions.width === receipt.asset.width &&
            dimensions.height === receipt.asset.height;
        } catch {
          filePresent = false;
        }
        const supersededByAssetReceiptId =
          assetReceipts.getSupersedingAssetReceiptId(assetReceiptId);
        const superseded = supersededByAssetReceiptId !== undefined;
        const readyForPipeline =
          projectReceiptValid &&
          filePresent &&
          sha256Matches &&
          dimensionsMatch &&
          !superseded;
        const result = readyForPipeline
          ? `Verified current approved asset ${assetReceiptId} at ${receipt.asset.destinationPath}.`
          : `Approved asset ${assetReceiptId} is not ready for pipeline; receipt=${projectReceiptValid}, file=${filePresent}, sha256=${sha256Matches}, dimensions=${dimensionsMatch}, superseded=${superseded}.`;
        logToolCall(config, {
          tool: "verify_approved_asset",
          workspaceId,
          path: receipt.asset.destinationPath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "verify_approved_asset",
            projectMemory,
            card: {
              workspaceId,
              path: receipt.asset.destinationPath,
              summary: {
                ...receipt.asset,
                assetReceiptId,
                projectReceiptPath: receipt.projectReceiptPath,
                humanApproval: receipt.humanApproval,
                superseded,
                supersededByAssetReceiptId,
                readyForPipeline,
              },
            },
          },
          structuredContent: {
            result,
            assetReceiptId,
            path: receipt.asset.destinationPath,
            indexed: true,
            projectReceiptValid,
            filePresent,
            sha256Matches,
            dimensionsMatch,
            superseded,
            supersededByAssetReceiptId,
            readyForPipeline,
          },
        };
      },
    );

    registerAppTool(
      server,
      "recover_approved_asset",
      {
        title: "Recover approved asset",
        description:
          "Restore a missing approved PNG from a ChatGPT/File Library file after exact registered file ID, SHA-256, dimensions, target path and immutable project receipt verification. Existing different bytes are always rejected; this tool cannot replace an authoritative version.",
        inputSchema: {
          workspaceId: z.string(),
          assetReceiptId: z.string().regex(/^asset_receipt_[0-9a-f]{64}$/),
          file: openAiFileInputSchema,
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          workspaceId: z.string(),
          assetReceiptId: z.string(),
          path: z.string(),
          outcome: z.enum(["created", "unchanged"]),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          artifactId: z.string(),
          importReceiptId: z.string(),
          readyForPipeline: z.literal(true),
        }),
        ...interactiveWidgetMeta(
          "recover_approved_asset",
          "review",
          IMPORT_PNG_FILE_PARAMS_META,
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, assetReceiptId, file, projectMemoryReceiptId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "recover_approved_asset",
          projectMemoryReceiptId,
        );
        const receipt = assetReceipts.getApproved(assetReceiptId);
        if (!receipt) {
          return {
            content: [
              textBlock(`APPROVED_ASSET_RECEIPT_NOT_FOUND: ${assetReceiptId}.`),
            ],
            isError: true,
          };
        }
        if (!receipt.source.fileId || file.file_id !== receipt.source.fileId) {
          return {
            content: [
              textBlock(
                "APPROVED_ASSET_RECOVERY_MISMATCH: File ID does not match the approved receipt.",
              ),
            ],
            isError: true,
          };
        }
        try {
          const projectReceipt = await readApprovedReceiptFile(
            workspace.root,
            receipt.projectReceiptPath,
          );
          validateApprovedAssetReceipt(projectReceipt);
          if (JSON.stringify(projectReceipt) !== JSON.stringify(receipt)) {
            throw new Error(
              "APPROVED_ASSET_RECOVERY_MISMATCH: Project receipt differs from the registry.",
            );
          }
          const destination = workspaces.resolvePath(
            workspace,
            receipt.asset.destinationPath,
          );
          const imported = await importPng({
            destination,
            workspaceRoot: workspace.root,
            file,
            expectedSha256: receipt.asset.sha256,
            overwrite: false,
          });
          if (
            imported.outcome === "replaced" ||
            imported.width !== receipt.asset.width ||
            imported.height !== receipt.asset.height ||
            imported.bytes !== receipt.asset.bytes
          ) {
            if (imported.outcome === "created") {
              await rollbackImportedAsset({
                workspaceRoot: workspace.root,
                stateDir: config.stateDir,
                workspaceId,
                path: receipt.asset.destinationPath,
              });
            }
            throw new Error(
              "APPROVED_ASSET_RECOVERY_MISMATCH: Dimensions or byte count differ from the approved receipt.",
            );
          }
          let artifact = artifacts.getLatestArtifactForPath(
            workspaceId,
            receipt.asset.destinationPath,
            imported.sha256,
          );
          let registeredArtifact = false;
          try {
            if (!artifact) {
              artifact = await artifacts.registerImport({
                workspaceId,
                workspaceRoot: workspace.root,
                relativePath: receipt.asset.destinationPath,
                importId: `import_${randomUUID()}`,
                source: "openai_file",
                sourceFileId: file.file_id,
                sourceFileName: file.file_name,
              });
              registeredArtifact = true;
            }
            const importReceipt = assetReceipts.registerImport({
              workspaceId,
              destinationPath: receipt.asset.destinationPath,
              outcome: imported.outcome,
              bytes: imported.bytes,
              sha256: imported.sha256,
              width: imported.width,
              height: imported.height,
              mimeType: "image/png",
              sourceKind: "openai_file",
              sourceFileId: file.file_id,
              sourceFileName: file.file_name,
              artifactId: artifact.artifactId,
            });
            const result = `${imported.outcome === "created" ? "Recovered" : "Verified unchanged"} approved asset ${assetReceiptId} at ${receipt.asset.destinationPath}.`;
            logToolCall(config, {
              tool: "recover_approved_asset",
              workspaceId,
              path: receipt.asset.destinationPath,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return {
              content: [textBlock(result)],
              _meta: {
                tool: "recover_approved_asset",
                projectMemory,
                card: {
                  workspaceId,
                  path: receipt.asset.destinationPath,
                  summary: {
                    ...receipt.asset,
                    outcome: imported.outcome,
                    artifactId: artifact.artifactId,
                    importReceiptId: importReceipt.importReceiptId,
                    assetReceiptId,
                    projectReceiptPath: receipt.projectReceiptPath,
                    humanApproval: receipt.humanApproval,
                    readyForPipeline: true,
                  },
                },
              },
              structuredContent: {
                result,
                workspaceId,
                assetReceiptId,
                path: receipt.asset.destinationPath,
                outcome: imported.outcome,
                bytes: imported.bytes,
                sha256: imported.sha256,
                width: imported.width,
                height: imported.height,
                artifactId: artifact.artifactId,
                importReceiptId: importReceipt.importReceiptId,
                readyForPipeline: true,
              },
            };
          } catch (error) {
            if (registeredArtifact && artifact) {
              artifacts.removeArtifact(workspaceId, artifact.artifactId);
            }
            if (imported.outcome === "created") {
              await rollbackImportedAsset({
                workspaceRoot: workspace.root,
                stateDir: config.stateDir,
                workspaceId,
                path: receipt.asset.destinationPath,
              });
            }
            throw error;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logToolCall(config, {
            tool: "recover_approved_asset",
            workspaceId,
            path: receipt.asset.destinationPath,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message,
          });
          return { content: [textBlock(message)], isError: true };
        }
      },
    );

    registerAppTool(
      server,
      "reindex_approved_assets",
      {
        title: "Reindex approved assets",
        description:
          "Rebuild the local SQLite approved-asset index by scanning a bounded workspace-relative directory for immutable *.approved-asset-receipt.json files. Project receipts remain authoritative.",
        inputSchema: {
          workspaceId: z.string(),
          receiptRoot: z.string().min(1).max(512),
          maxReceipts: z.number().int().min(1).max(5_000).optional(),
          maxDepth: z.number().int().min(0).max(16).optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          scanned: z.number().int().nonnegative(),
          indexed: z.number().int().nonnegative(),
          existing: z.number().int().nonnegative(),
          errors: z.array(z.string()),
        }),
        ...interactiveWidgetMeta("reindex_approved_assets", "review"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({
        workspaceId,
        receiptRoot,
        maxReceipts,
        maxDepth,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "reindex_approved_assets",
          projectMemoryReceiptId,
        );
        try {
          const indexed = await reindexApprovedAssetReceipts({
            workspaceRoot: workspace.root,
            receiptRoot,
            store: assetReceipts,
            maxReceipts,
            maxDepth,
          });
          const result = `Scanned ${indexed.scanned} approved asset receipts; indexed ${indexed.indexed}, already present ${indexed.existing}, errors ${indexed.errors.length}.`;
          logToolCall(config, {
            tool: "reindex_approved_assets",
            workspaceId,
            path: receiptRoot,
            success: indexed.errors.length === 0,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            _meta: { tool: "reindex_approved_assets", projectMemory },
            structuredContent: { result, ...indexed },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return { content: [textBlock(message)], isError: true };
        }
      },
    );

    registerAppTool(
      server,
      "import_asset",
      {
        title: "Import asset",
        description:
          "Import PNG, JPEG, WEBP, GLB, WAV, or OGG bytes from one public HTTPS URL or standard Base64 source. Validates path, signature, size, hash, and overwrite policy, then registers the immutable version in the Artifact Ledger.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().max(512),
          sourceUrl: z.string().url().optional(),
          base64Data: z.string().optional(),
          expectedSha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
          overwrite: z.boolean().optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          importId: z.string(),
          imported: z.unknown(),
          artifact: z.unknown(),
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
        path,
        sourceUrl,
        base64Data,
        expectedSha256,
        overwrite,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "import_asset",
          projectMemoryReceiptId,
        );
        const destination = resolveWorkspacePath(workspace.root, path);
        let displacedTrashId: string | undefined;
        const imported = await importAsset({
          destination: destination.absolutePath,
          workspaceRoot: workspace.root,
          sourceUrl,
          base64Data,
          expectedSha256,
          overwrite: overwrite ?? false,
          beforeCommit:
            overwrite && existsSync(destination.absolutePath)
              ? async () => {
                  const snapshot = await snapshotWorkspaceFileToTrash({
                    workspaceRoot: workspace.root,
                    stateDir: config.stateDir,
                    workspaceId,
                    path: destination.relativePath,
                  });
                  displacedTrashId = snapshot.trashId;
                }
              : undefined,
        });
        const importId = `import_${randomUUID()}`;
        let artifact;
        try {
          artifact = await artifacts.registerImport({
            workspaceId,
            workspaceRoot: workspace.root,
            relativePath: imported.path,
            importId,
            source: imported.source,
            sourceHost: imported.sourceHost,
          });
        } catch (error) {
          await rollbackImportedAsset({
            workspaceRoot: workspace.root,
            stateDir: config.stateDir,
            workspaceId,
            path: imported.path,
            displacedTrashId,
          });
          throw error;
        }
        const result = `Imported ${imported.format} ${imported.path} (${imported.bytes} bytes, sha256 ${imported.sha256}) as ${artifact.artifactId}.`;
        logToolCall(config, {
          tool: "import_asset",
          workspaceId,
          path: imported.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: { tool: "import_asset", projectMemory },
          structuredContent: {
            result,
            importId,
            imported: { ...imported, displacedTrashId },
            artifact: { ...artifact, presence: "present" as const },
          },
        };
      },
    );

    registerAppTool(
      server,
      "preview_artifact",
      {
        title: "Preview artifact",
        description:
          "Create a ten-minute, hash-bound preview for a PNG, JPEG, WEBP, WAV, or OGG artifact. Unregistered paths are not added to the formal Artifact Ledger.",
        inputSchema: {
          workspaceId: z.string(),
          artifactId: z
            .string()
            .regex(/^artifact_[0-9a-f-]{36}$/)
            .optional(),
          path: z.string().max(512).optional(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({ preview: z.unknown() }),
        ...widgetMeta("preview_artifact", "review"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, artifactId, path, projectMemoryReceiptId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "preview_artifact",
          projectMemoryReceiptId,
        );
        const preview = await publisher.preview({
          workspaceId,
          workspaceRoot: workspace.root,
          artifactId,
          path,
        });
        const content: ToolContent[] = [
          textBlock(
            `Preview ${preview.path}\nURL: ${preview.url}\nExpires: ${preview.expiresAt}\nSHA-256: ${preview.sha256}`,
          ),
        ];
        if (
          preview.previewType === "image" &&
          preview.size <= 8 * 1024 * 1024
        ) {
          const resolved = resolveExistingWorkspacePath(
            workspace.root,
            preview.path,
            "file",
          );
          content.push({
            type: "image",
            data: readFileSync(resolved.absolutePath).toString("base64"),
            mimeType: preview.contentType,
          });
        }
        logToolCall(config, {
          tool: "preview_artifact",
          workspaceId,
          path: preview.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          _meta: { tool: "preview_artifact", projectMemory },
          structuredContent: {
            result: contentText(content),
            preview,
          },
        };
      },
    );

    registerAppTool(
      server,
      "mkdir",
      {
        title: "Create directory",
        description:
          "Create a real nested directory inside the workspace. Existing real directories are idempotent.",
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
        const operation = await createWorkspaceDirectory(workspace.root, path);
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
          "Copy a regular file or symlink-free directory tree inside the workspace. Directory merge and replacement are prohibited.",
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
        const operation = await copyWorkspacePath({
          workspaceRoot: workspace.root,
          stateDir: config.stateDir,
          workspaceId,
          sourcePath,
          destinationPath,
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
          "Atomically move a regular file or real directory inside the workspace. Cross-device moves and directory replacement are prohibited.",
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
        const operation = await moveWorkspacePath({
          workspaceRoot: workspace.root,
          stateDir: config.stateDir,
          workspaceId,
          sourcePath,
          destinationPath,
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
          "Move a workspace-local file or directory into the private DevSpace quarantine. No permanent deletion is performed.",
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
        const trash = await moveWorkspacePathToTrash({
          workspaceRoot: workspace.root,
          stateDir: config.stateDir,
          workspaceId,
          path,
        });
        const result = `Moved ${trash.originalPath} to quarantine as ${trash.trashId}.`;
        return {
          content: [textBlock(result)],
          _meta: { tool: "move_to_trash", projectMemory },
          structuredContent: { result, trash },
        };
      },
    );

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
          const workspace = workspaces.getWorkspace(workspaceId);
          const projectMemory = workspaces.observeProjectMemoryAccess(
            workspaceId,
            tool,
            projectMemoryReceiptId,
          );
          const status =
            tool === "git_stage_paths"
              ? await stageGitPaths(workspace.root, paths)
              : await unstageGitPaths(workspace.root, paths);
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
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_commit",
          projectMemoryReceiptId,
        );
        const commit = await commitGit({
          workspaceRoot: workspace.root,
          message,
          expectedStagedDiffSha256,
        });
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
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_branch",
          projectMemoryReceiptId,
        );
        const branch = await manageGitBranch({
          workspaceRoot: workspace.root,
          action,
          name,
          checkout,
          startPoint,
        });
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
          error: z.object({ code: z.string(), message: z.string() }).optional(),
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
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_fetch",
          projectMemoryReceiptId,
        );
        try {
          const policy = gitRemotePolicyForWorkspace(config, workspace);
          const fetch = await fetchGit({
            workspaceRoot: workspace.root,
            approvedRemotes: policy.approvedRemotes,
            approvedRemoteUrls: policy.approvedRemoteUrls,
            remote,
            prune,
            expectedHeadSha,
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
          error: z.object({ code: z.string(), message: z.string() }).optional(),
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
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "git_merge",
          projectMemoryReceiptId,
        );
        try {
          assertManagedAttachedGitWorkspace(workspace);
          gitRemotePolicyForWorkspace(config, workspace);
          const merge = await mergeGit({
            workspaceRoot: workspace.root,
            sourceRef,
            mode,
            expectedHeadSha,
            commitMessage,
            expectedSourceSha,
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
          const workspace = workspaces.getWorkspace(workspaceId);
          const projectMemory = workspaces.observeProjectMemoryAccess(
            workspaceId,
            "git_push",
            projectMemoryReceiptId,
          );
          try {
            assertManagedAttachedGitWorkspace(workspace);
            const policy = gitRemotePolicyForWorkspace(config, workspace);
            const push = await pushGit({
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

  registerAppTool(
    server,
    "resume_workspace",
    {
      title: "Resume workspace",
      description:
        "Resume a persisted checkout or managed worktree using a workspaceId returned by list_workspaces. Revalidates current path policy and directory existence, reloads project instructions and skills, and optionally runs Project Memory preflight for the current task. This is the supported way to recover a managed worktree whose generated path is outside allowedRoots.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Persisted workspace identifier from list_workspaces."),
        task: z
          .string()
          .optional()
          .describe(
            "Optional current task for Project Memory SHADOW preflight.",
          ),
        additionalRoots: z
          .array(
            z.object({
              path: z
                .string()
                .describe("Absolute path to an additional root directory."),
              access: z
                .enum(["read_only", "read_write"])
                .describe("Access mode for this root."),
            }),
          )
          .optional()
          .describe(
            "Additional root directories the workspace may read/write beyond the primary workspace root.",
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
                .describe("Absolute path to an additional root directory."),
              access: z
                .enum(["read_only", "read_write"])
                .describe("Access mode for this root."),
            }),
          )
          .optional()
          .describe(
            "Additional root directories the workspace may read/write beyond the primary workspace root. Each root must specify an access mode. Junction and symlink targets are resolved before access checks.",
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

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: [
        "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
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
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
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

  if (!config.readOnly) {
    registerAppTool(
      server,
      toolNames.write,
      {
        title: "Write file",
        description: `Create a file inside an open workspace. Existing files are rejected unless overwrite=true; prefer ${toolNames.edit} for targeted changes. Call open_workspace first and pass workspaceId.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe("File path to write, relative to the workspace root."),
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
        const destination = resolveWorkspacePath(workspace.root, input.path);
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
            workspaceRoot: workspace.root,
            stateDir: config.stateDir,
            workspaceId,
            path: destination.relativePath,
          });
        }
        const response = await writeFileTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

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

    registerAppTool(
      server,
      "import_png",
      {
        title: "Import PNG",
        description: `Import original PNG bytes into an open workspace from exactly one source: a ChatGPT file attachment, a public HTTPS result URL, or standard Base64 data. Prefer file for images attached in the conversation. Use this instead of ${toolNames.shell} or the text-only ${toolNames.write} tool. The destination must end in .png, stay inside the workspace, and is not overwritten unless overwrite=true. Imports are limited to ${MAX_PNG_IMPORT_BYTES} bytes and validate PNG structure, dimensions, CRCs, and decoded scanlines before atomic write and provenance registration.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Destination .png path relative to the workspace root, for example managed_worktree/raw/candidate.png.",
            ),
          file: openAiFileInputSchema
            .optional()
            .describe(
              "ChatGPT conversation or library file supplied by the host. Provide exactly one of file, sourceUrl, or base64Data.",
            ),
          sourceUrl: z
            .string()
            .url()
            .optional()
            .describe(
              "Public HTTPS URL containing the PNG bytes. Provide exactly one of file, sourceUrl, or base64Data.",
            ),
          base64Data: z
            .string()
            .optional()
            .describe(
              "Standard Base64-encoded PNG bytes. Provide exactly one of file, base64Data, or sourceUrl.",
            ),
          expectedSha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional()
            .describe(
              "Optional expected SHA-256 digest; the import fails without writing if it does not match.",
            ),
          overwrite: z
            .boolean()
            .optional()
            .describe(
              "Defaults to false. Set true only when intentionally replacing an existing PNG.",
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          workspaceId: z.string(),
          path: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          mimeType: z.literal("image/png"),
          source: z.enum(["openai_file", "https", "base64"]),
          sourceKind: z.enum(["openai_file", "https", "base64"]),
          sourceHost: z.string().optional(),
          sourceFileId: z.string().optional(),
          sourceFileName: z.string().optional(),
          outcome: z.enum(["created", "unchanged", "replaced"]),
          overwritten: z.boolean(),
          artifactId: z.string(),
          importReceiptId: z.string(),
          previousSha256: z.string().optional(),
          previousArtifactId: z.string().optional(),
          projectMemoryReceiptId: z.string().optional(),
          displacedTrashId: z.string().optional(),
        }),
        ...interactiveWidgetMeta(
          "import_png",
          "review",
          IMPORT_PNG_FILE_PARAMS_META,
        ),
        annotations: IMPORT_PNG_TOOL_ANNOTATIONS,
      },
      async ({
        workspaceId,
        path,
        file,
        sourceUrl,
        base64Data,
        expectedSha256,
        overwrite,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "import_png",
          projectMemoryReceiptId,
        );
        const destination = workspaces.resolvePath(workspace, path);
        try {
          let displacedTrashId: string | undefined;
          const imported = await importPng({
            destination,
            workspaceRoot: workspace.root,
            file,
            sourceUrl,
            base64Data,
            expectedSha256,
            overwrite: overwrite ?? false,
            beforeCommit:
              overwrite && existsSync(destination)
                ? async () => {
                    const snapshot = await snapshotWorkspaceFileToTrash({
                      workspaceRoot: workspace.root,
                      stateDir: config.stateDir,
                      workspaceId,
                      path,
                    });
                    displacedTrashId = snapshot.trashId;
                  }
                : undefined,
          });
          const previousArtifact =
            imported.outcome === "replaced" && imported.previousSha256
              ? artifacts.getLatestArtifactForPath(
                  workspaceId,
                  path,
                  imported.previousSha256,
                )
              : undefined;
          let artifact = artifacts.getLatestArtifactForPath(
            workspaceId,
            path,
            imported.sha256,
          );
          let registeredArtifact = false;
          try {
            if (!artifact || imported.outcome !== "unchanged") {
              artifact = await artifacts.registerImport({
                workspaceId,
                workspaceRoot: workspace.root,
                relativePath: path,
                importId: `import_${randomUUID()}`,
                source: imported.source,
                sourceHost: imported.sourceHost,
                sourceFileId: imported.sourceFileId,
                sourceFileName: imported.sourceFileName,
                overwritten: imported.outcome === "replaced",
                previousArtifactId: previousArtifact?.artifactId,
              });
              registeredArtifact = true;
            }
            const importReceipt = assetReceipts.registerImport({
              workspaceId,
              destinationPath: path,
              outcome: imported.outcome,
              bytes: imported.bytes,
              sha256: imported.sha256,
              width: imported.width,
              height: imported.height,
              mimeType: imported.mimeType,
              sourceKind: imported.source,
              sourceHost: imported.sourceHost,
              sourceFileId: imported.sourceFileId,
              sourceFileName: imported.sourceFileName,
              artifactId: artifact.artifactId,
              previousSha256:
                imported.outcome === "replaced"
                  ? imported.previousSha256
                  : undefined,
              previousArtifactId:
                imported.outcome === "replaced"
                  ? previousArtifact?.artifactId
                  : undefined,
              displacedTrashId,
            });
            const overwritten = imported.outcome === "replaced";
            const result = `${imported.outcome === "unchanged" ? "Verified unchanged" : imported.outcome === "replaced" ? "Replaced" : "Imported"} ${path} (${imported.bytes} bytes, ${imported.width}x${imported.height}, sha256 ${imported.sha256}) as ${artifact.artifactId}; receipt ${importReceipt.importReceiptId}.`;
            logToolCall(config, {
              tool: "import_png",
              workspaceId,
              path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return {
              content: [textBlock(result)],
              _meta: {
                tool: "import_png",
                projectMemory,
                card: {
                  workspaceId,
                  path,
                  summary: {
                    ...imported,
                    artifactId: artifact.artifactId,
                    importReceiptId: importReceipt.importReceiptId,
                    overwritten,
                  },
                },
              },
              structuredContent: {
                result,
                workspaceId,
                path,
                ...imported,
                sourceKind: imported.source,
                overwritten,
                artifactId: artifact.artifactId,
                importReceiptId: importReceipt.importReceiptId,
                previousArtifactId:
                  imported.outcome === "replaced"
                    ? previousArtifact?.artifactId
                    : undefined,
                projectMemoryReceiptId: projectMemory.receiptId,
                displacedTrashId,
              },
            };
          } catch (error) {
            if (registeredArtifact && artifact) {
              artifacts.removeArtifact(workspaceId, artifact.artifactId);
            }
            if (imported.outcome !== "unchanged") {
              await rollbackImportedAsset({
                workspaceRoot: workspace.root,
                stateDir: config.stateDir,
                workspaceId,
                path,
                displacedTrashId,
              });
            }
            throw error;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logToolCall(config, {
            tool: "import_png",
            workspaceId,
            path,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message,
          });
          return {
            content: [textBlock(message)],
            isError: true,
          };
        }
      },
    );

    registerAppTool(
      server,
      toolNames.edit,
      {
        title: "Edit file",
        description: `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe("File path to edit, relative to the workspace root."),
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
        workspaces.resolvePath(workspace, input.path);
        const response = await editFileTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

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

  if (config.widgets === "changes") {
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

  if (exposeDedicatedReadTools(config)) {
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
              "Optional path or glob scope relative to the workspace root.",
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
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

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
            .describe("Optional path scope relative to the workspace root."),
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
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

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
              "Directory path to list, relative to the workspace root.",
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
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

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

  if (!config.readOnly) {
    if (EXPOSE_LEGACY_SHELL) {
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

    registerAppTool(
      server,
      "start_job",
      {
        title: "Start background job",
        description:
          "Start a bounded background validation job inside an open workspace. Select an approved build/test/check runner and pass an argument array; arbitrary executables and shell command strings are not accepted. The process is spawned without a shell, its working directory is workspace-scoped, and runtime/output/concurrency are capped. Use poll_job to read progress and cancel_job to stop it.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          runner: z
            .enum(JOB_RUNNERS)
            .describe("Approved validation runner to execute."),
          args: z
            .array(z.string())
            .min(1)
            .max(128)
            .describe(
              'Argument array, for example ["test"] for npm or ["--headless", "--path", ".", "res://scene.tscn"] for godot-mono.',
            ),
          workingDirectory: z
            .string()
            .optional()
            .describe(
              "Optional working directory relative to the workspace root. Defaults to the workspace root.",
            ),
          label: z
            .string()
            .max(200)
            .optional()
            .describe("Optional short human-readable purpose."),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_JOB_TIMEOUT_SECONDS)
            .optional()
            .describe(
              `Defaults to ${DEFAULT_JOB_TIMEOUT_SECONDS}; maximum ${MAX_JOB_TIMEOUT_SECONDS}.`,
            ),
          artifactRoots: z
            .array(z.string().min(1).max(512))
            .min(1)
            .max(MAX_ARTIFACT_ROOTS)
            .optional()
            .describe(
              "Optional workspace-relative output directories to snapshot before the job and discover afterward. Prefer narrow roots such as artifacts/blender; whole-workspace scans are not accepted.",
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          job: jobSnapshotOutputSchema,
        }),
        ...widgetMeta("start_job", "job"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        workspaceId,
        runner,
        args,
        workingDirectory,
        label,
        timeoutSeconds,
        artifactRoots,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "start_job",
          projectMemoryReceiptId,
        );
        const cwd = workspaces.resolveWorkingDirectory(
          workspace,
          workingDirectory,
        );
        const job = await jobs.start({
          workspaceId,
          workspaceRoot: workspace.root,
          workingDirectory: cwd,
          runner,
          args,
          label,
          timeoutSeconds,
          artifactRoots,
        });
        const result = `Started ${job.jobId}: ${runner} ${job.args.join(" ")}. Poll with poll_job.`;
        logToolCall(config, {
          tool: "start_job",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "start_job",
            projectMemory,
            card: {
              workspaceId,
              path: workingDirectory,
              summary: job,
            },
          },
          structuredContent: { result, job },
        };
      },
    );

    registerAppTool(
      server,
      "start_capture",
      {
        title: "Start capture profile",
        description:
          "Load a strict project-owned .devspace/captures/<name>.json profile and start its approved Godot or Godot Mono runner through the existing background Job lifecycle. Profiles cannot select an executable; DevSpace validates the workspace-local profile, runner arguments, output roots, capture metadata, timeout, and screenshot/manifest paths before spawn.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          profile: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,80}$/)
            .describe(
              "Capture profile name without a path or extension, for example asset_review.",
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          job: jobSnapshotOutputSchema,
          profile: captureProfileOutputSchema,
        }),
        ...widgetMeta("start_capture", "job"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, profile, projectMemoryReceiptId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "start_capture",
          projectMemoryReceiptId,
        );
        const loaded = loadCaptureProfile({
          workspaceRoot: workspace.root,
          name: profile,
          runners,
        });
        const job = await jobs.start({
          workspaceId,
          workspaceRoot: workspace.root,
          workingDirectory: loaded.workingDirectoryAbsolute,
          runner: loaded.runner,
          args: loaded.args,
          label: `capture:${loaded.name}`,
          timeoutSeconds: loaded.timeoutSeconds,
          artifactRoots: loaded.artifactRoots,
          captureProfile: loaded.name,
          environment: loaded.environment,
        });
        const publicProfile = {
          name: loaded.name,
          runner: loaded.runner,
          workingDirectory: loaded.workingDirectory,
          args: loaded.args,
          artifactRoots: loaded.artifactRoots,
          timeoutSeconds: loaded.timeoutSeconds,
          capture: loaded.capture,
        };
        const result = `Started capture ${loaded.name} as ${job.jobId}. Poll with poll_job, then use list_artifacts and publish_artifact.`;
        logToolCall(config, {
          tool: "start_capture",
          workspaceId,
          path: `.devspace/captures/${loaded.name}.json`,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "start_capture",
            projectMemory,
            card: {
              workspaceId,
              path: `.devspace/captures/${loaded.name}.json`,
              summary: job,
            },
          },
          structuredContent: { result, job, profile: publicProfile },
        };
      },
    );

    registerAppTool(
      server,
      "poll_job",
      {
        title: "Poll background job",
        description:
          "Read the current status and a bounded byte range of output from a background validation job. Reuse nextOutputOffsetBytes to fetch only new output.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier that owns the job."),
          jobId: z.string().describe("Job identifier returned by start_job."),
          offsetBytes: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Output byte offset. Defaults to 0."),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_POLL_BYTES)
            .optional()
            .describe(
              `Maximum output bytes to return, up to ${MAX_POLL_BYTES}.`,
            ),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          job: jobSnapshotOutputSchema,
        }),
        ...widgetMeta("poll_job", "job"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async ({
        workspaceId,
        jobId,
        offsetBytes,
        maxBytes,
        projectMemoryReceiptId,
      }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "poll_job",
          projectMemoryReceiptId,
        );
        const job = jobs.poll(jobId, offsetBytes, maxBytes);
        assertJobWorkspace(job, workspaceId);
        const result = [
          `${job.jobId}: ${job.status}`,
          `Output bytes: ${job.outputBytes}${job.outputTruncated ? " (truncated)" : ""}`,
          job.exitCode !== undefined ? `Exit code: ${job.exitCode}` : undefined,
          job.signal ? `Signal: ${job.signal}` : undefined,
          job.error ? `Error: ${job.error}` : undefined,
          job.artifactStatus !== "none"
            ? `Artifacts: ${job.artifactStatus} (${job.artifactCount})`
            : undefined,
          job.artifactErrors?.length
            ? `Artifact errors: ${job.artifactErrors.join(" | ")}`
            : undefined,
          job.output ? `Output:\n${job.output}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        logToolCall(config, {
          tool: "poll_job",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "poll_job",
            projectMemory,
            card: { workspaceId, summary: job },
          },
          structuredContent: { result, job },
        };
      },
    );

    registerAppTool(
      server,
      "cancel_job",
      {
        title: "Cancel background job",
        description:
          "Request termination of a running background validation job owned by the given workspace. A graceful termination is followed by forced termination if needed. Completed jobs are returned unchanged.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier that owns the job."),
          jobId: z.string().describe("Job identifier returned by start_job."),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({
          job: jobSnapshotOutputSchema,
        }),
        ...widgetMeta("cancel_job", "job"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, jobId, projectMemoryReceiptId }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "cancel_job",
          projectMemoryReceiptId,
        );
        const existing = jobs.poll(jobId, 0, 1);
        assertJobWorkspace(existing, workspaceId);
        const job = jobs.cancel(jobId);
        const result = `${job.jobId}: ${job.status}`;
        logToolCall(config, {
          tool: "cancel_job",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          _meta: {
            tool: "cancel_job",
            projectMemory,
            card: { workspaceId, summary: job },
          },
          structuredContent: { result, job },
        };
      },
    );
  }

  if (!config.readOnly) {
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
          "Inject exactly one InputMap action or viewport-local mouse click into a DevSpace-owned Godot Session. No global desktop event is generated.",
        inputSchema: {
          workspaceId: z.string(),
          sessionId: z.string(),
          input: z.discriminatedUnion("kind", [
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
              button: z.enum(["left", "right", "middle"]),
            }),
          ]),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({ accepted: z.literal(true) }),
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
          "Capture the running Session viewport as PNG evidence in DevSpace private state and return bounded image content.",
        inputSchema: {
          workspaceId: z.string(),
          sessionId: z.string(),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema({ frame: z.unknown() }),
        ...widgetMeta("capture_game_frame", "review"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, sessionId, projectMemoryReceiptId }) => {
        workspaces.getWorkspace(workspaceId);
        const projectMemory = workspaces.observeProjectMemoryAccess(
          workspaceId,
          "capture_game_frame",
          projectMemoryReceiptId,
        );
        const captured = await games.capture(workspaceId, sessionId);
        const { data, path: _privatePath, ...frame } = captured;
        const result = `Captured ${frame.frameId}: ${frame.width}x${frame.height}, sha256 ${frame.sha256}.`;
        return {
          content: [
            textBlock(result),
            { type: "image", data, mimeType: "image/png" },
          ],
          _meta: { tool: "capture_game_frame", projectMemory },
          structuredContent: { result, frame },
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

  if (!config.readOnly) {
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

  // -----------------------------------------------------------------------
  // project_task / poll_task / stop_task / approve_task_manifest
  // -----------------------------------------------------------------------

  if (!config.readOnly) {
    registerAppTool(
      server,
      "project_task",
      {
        title: "Run a declared project task",
        description:
          "Execute a task declared in the workspace's .devspace/tasks.yaml. Tasks are named, pre-approved commands with fixed arguments and optional declared parameters.",
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
            ? `Task ${result.taskId}: ${result.status} (exit ${result.exitCode}) in ${result.durationMs}ms.`
            : `Task ${result.taskId}: session ${result.sessionId} started (pid ${result.pid}).`;
        return {
          content: [textBlock(text)],
          _meta: { tool: "project_task", projectMemory },
          structuredContent: { result: text, task: result },
        };
      },
    );
  }

  registerAppTool(
    server,
    "poll_task",
    {
      title: "Poll a running task session",
      description:
        "Check the status and recent output of a running task session.",
      inputSchema: {
        sessionId: z.string().describe("Task session ID from project_task."),
      },
      outputSchema: resultOutputSchema({ session: z.unknown() }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const session = tasks.getSession(sessionId);
      if (!session) throw new Error(`TASK_SESSION_NOT_FOUND: ${sessionId}`);
      const output = session.stdout.slice(-8000) + session.stderr.slice(-2000);
      return {
        content: [
          textBlock(`Task ${session.taskId}: ${session.status}
${output}`),
        ],
        _meta: {},
        structuredContent: { result: output, session },
      };
    },
  );

  if (!config.readOnly) {
    registerAppTool(
      server,
      "stop_task",
      {
        title: "Stop a running task session",
        description: "Terminate a running task session.",
        inputSchema: {
          sessionId: z.string().describe("Task session ID from project_task."),
        },
        outputSchema: resultOutputSchema({ stopped: z.boolean() }),
        _meta: {},
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ sessionId }) => {
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

  return server;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const monitorEvents = new MonitorEventStore(config.stateDir);
  const workspaceApp =
    config.widgets === "off"
      ? undefined
      : resolveWorkspaceAppBuild(options.workspaceAppBuild);
  const mcpSessions = new McpSessionRegistry<Transport>({
    transportMode: config.mcpTransportMode,
    idleTtlMs: config.mcpSessionIdleTtlMs,
    maxSessions: config.mcpSessionMaxSessions,
    sweepIntervalMs: config.mcpSessionSweepIntervalMs,
    onClosed: ({ sessionId, reason, source }) => {
      logEvent(config.logging, "info", "mcp_session_closed", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        reason,
        source,
      });
    },
    onCloseError: ({ sessionId, reason, source, error }) => {
      logEvent(config.logging, "warn", "mcp_session_close_error", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        reason,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      monitorEvents.record({
        source: "mcp",
        severity: "warning",
        code: "MCP_SESSION_CLOSE_ERROR",
        message: `MCP session close failed (${reason}, ${source})`,
      });
    },
  });
  const runners = new RunnerRegistry(config.runners);
  const tasks = new TaskRunner();
  const runtime = createServiceRuntime(
    config,
    workspaceApp,
    () => mcpSessions.snapshot(),
    monitorEvents,
  );
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(
    config.oauth,
    mcpUrl,
    config.stateDir,
  );
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl:
      getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const projectMemory = new ProjectMemoryController(
    config.projectMemory,
    config.stateDir,
    options.projectMemoryRunner,
  );
  const workspaces = new WorkspaceRegistry(
    config,
    workspaceStore,
    projectMemory,
  );
  const reviewCheckpoints = createReviewCheckpointManager();
  const artifacts = new ArtifactLedger(config.stateDir);
  const assetReceipts = new AssetReceiptStore(config.stateDir);
  const publisher = new ArtifactPublisher(config.publicBaseUrl, artifacts, {
    audit: (event) =>
      logEvent(config.logging, "info", event.event, {
        artifactId: event.artifactId,
        workspaceId: event.workspaceId,
        path: event.relativePath,
        expiresAt: event.expiresAt,
        tokenHashPrefix: event.tokenHashPrefix,
        purpose: event.purpose,
        reason: event.reason,
      }),
  });
  const jobs = new BackgroundJobManager(config.stateDir, runners, artifacts);
  const games = new GameSessionManager(config.stateDir, runners);
  const inspectors = new ExternalInspectorManager(config.stateDir, runners);
  const requestMonitor = new LiveRequestMonitor();
  const resourceMonitor = new ProcessResourceMonitor();

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const finishMonitoring = requestMonitor.begin(requestPath(req));
    res.locals.requestId = requestId;

    let completed = false;
    const completeRequest = () => {
      if (completed) return;
      completed = true;
      finishMonitoring(res.statusCode, performance.now() - startedAt);
      const path = requestPath(req);
      if (
        res.statusCode >= 400 &&
        path !== "/monitor" &&
        !path.startsWith("/monitor/")
      ) {
        monitorEvents.record({
          source: "http",
          severity: res.statusCode >= 500 ? "error" : "warning",
          code: `HTTP_${res.statusCode}`,
          message: `${req.method} ${safeMonitorPath(path)} returned ${res.statusCode}`,
          statusCode: res.statusCode,
        });
      }
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    };
    res.once("finish", completeRequest);
    res.once("close", completeRequest);

    next();
  });

  app.get("/monitor", (req, res) => {
    if (!requireLocalMonitor(req, res)) return;
    setMonitorSecurityHeaders(res);
    res.type("html").send(liveMonitorHtml());
  });

  app.get("/monitor/api", (req, res) => {
    if (!requireLocalMonitor(req, res)) return;
    setMonitorSecurityHeaders(res);
    const requests = requestMonitor.snapshot();
    const resources = resourceMonitor.snapshot();
    const jobSnapshot = jobs.monitorSnapshot();
    res.json({
      observedAt: new Date().toISOString(),
      service: {
        name: "devspace",
        version: PACKAGE_VERSION,
        bootId: runtime.bootId,
        startedAt: runtime.startedAt,
        uptimeSeconds: Math.max(
          0,
          Math.round((Date.now() - Date.parse(runtime.startedAt)) / 1_000),
        ),
      },
      process: {
        pid: process.pid,
        cpuPercent: resources.processCpuPercent,
        cpuAverage15s: resources.processCpuAverage15s,
      },
      memory: {
        rssMiB: resources.rssMiB,
        heapUsedMiB: resources.heapUsedMiB,
        heapTotalMiB: resources.heapTotalMiB,
        externalMiB: resources.externalMiB,
        rssGrowthMiBPerMinute: resources.rssGrowthMiBPerMinute,
      },
      system: {
        cpuPercent: resources.systemCpuPercent,
        cpuAverage15s: resources.systemCpuAverage15s,
        memoryUsedPercent: resources.systemMemoryUsedPercent,
        memoryAvailableMiB: resources.systemMemoryAvailableMiB,
        memoryTotalMiB: resources.systemMemoryTotalMiB,
        disk: diskSpaceSnapshot(config.stateDir),
      },
      eventLoop: {
        p95Ms: resources.eventLoopP95Ms,
        maxMs: resources.eventLoopMaxMs,
      },
      resourceHistory: resources.history,
      requests,
      sessions: mcpSessions.snapshot(),
      jobs: jobSnapshot,
      errors: {
        recent: monitorEvents.snapshot(50),
        persisted: monitorEvents.isPersistent(),
        retention: 200,
      },
      load: calculateLoadAssessment({
        requests,
        resources,
        jobs: jobSnapshot,
      }),
    });
  });

  app.get("/artifacts/:token", async (req, res) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    await publisher.serve(token, res);
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  if (workspaceApp) {
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
      setAssetHeaders(res);
      res.sendStatus(204);
    });

    app.use(
      "/mcp-app-assets",
      express.static(workspaceApp.uiDirectoryPath, {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
      }),
    );
  }

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "devspace",
      version: PACKAGE_VERSION,
      bootId: runtime.bootId,
      schemaRevision: TOOL_SCHEMA_REVISION,
      schemaFingerprint: runtime.schemaFingerprint,
      tools: runtime.tools.length,
      mcpSessions: mcpSessions.snapshot(),
      memory: processMemorySnapshot(),
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest =
      req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (
      !req.auth?.resource ||
      !checkResourceAllowed({
        requestedResource: req.auth.resource,
        configuredResource: resourceServerUrl,
      })
    ) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });
    if (initializeRequest) mcpSessions.recordInitializeRequest();

    if (config.mcpTransportMode === "stateless") {
      mcpSessions.recordStatelessRequest();
      if (req.method !== "POST") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed");
        return;
      }

      if (initializeRequest) {
        const client = classifyMcpClient(req.body);
        logEvent(config.logging, "info", "mcp_stateless_initialize", {
          requestId,
          source: client.source,
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          ...requestLogFields(req, config),
        });
      }

      const statelessTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const statelessServer = createMcpServer(
        config,
        workspaces,
        reviewCheckpoints,
        jobs,
        games,
        inspectors,
        runners,
        artifacts,
        assetReceipts,
        publisher,
        runtime,
        workspaceApp,
        tasks,
      );
      let statelessClosed = false;
      const closeStatelessServer = (): void => {
        if (statelessClosed) return;
        statelessClosed = true;
        void statelessServer.close().catch((error) => {
          logEvent(config.logging, "warn", "mcp_stateless_close_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          monitorEvents.record({
            source: "mcp",
            severity: "warning",
            code: "MCP_STATELESS_CLOSE_ERROR",
            message: "Stateless MCP server close failed",
          });
        });
      };
      res.once("finish", closeStatelessServer);
      res.once("close", closeStatelessServer);

      try {
        await statelessServer.connect(statelessTransport);
        await statelessTransport.handleRequest(req, res, req.body);
      } catch (error) {
        logEvent(config.logging, "error", "mcp_request_error", {
          requestId,
          transportMode: "stateless",
          error: error instanceof Error ? error.message : String(error),
        });
        monitorEvents.record({
          source: "mcp",
          severity: "error",
          code: "MCP_REQUEST_ERROR",
          message: "Stateless MCP request failed",
        });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
        closeStatelessServer();
      }
      return;
    }

    let transport: Transport | undefined;
    let acquiredSessionId: string | undefined;
    let initializingTransport = false;
    try {
      if (sessionId) {
        transport = mcpSessions.acquire(sessionId);
        if (!transport) {
          logEvent(config.logging, "warn", "mcp_session_unknown", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            reason: mcpSessions.missingReason(sessionId),
          });
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        acquiredSessionId = sessionId;
      } else if (initializeRequest) {
        initializingTransport = true;
        const client = classifyMcpClient(req.body);
        const createdTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            mcpSessions.register(
              newSessionId,
              createdTransport,
              1,
              client.source,
            );
            acquiredSessionId = newSessionId;
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              source: client.source,
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              ...requestLogFields(req, config),
            });
          },
        });
        transport = createdTransport;

        createdTransport.onclose = () => {
          const closedSessionId = createdTransport.sessionId;
          if (closedSessionId) {
            mcpSessions.handleTransportClosed(
              closedSessionId,
              createdTransport,
            );
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          jobs,
          games,
          inspectors,
          runners,
          artifacts,
          assetReceipts,
          publisher,
          runtime,
          workspaceApp,
          tasks,
        );
        await server.connect(createdTransport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      monitorEvents.record({
        source: "mcp",
        severity: "error",
        code: "MCP_REQUEST_ERROR",
        message: "Stateful MCP request failed",
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      if (acquiredSessionId) {
        mcpSessions.release(acquiredSessionId);
      } else if (initializingTransport && transport) {
        try {
          await transport.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_transport_close_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          monitorEvents.record({
            source: "mcp",
            severity: "warning",
            code: "MCP_TRANSPORT_CLOSE_ERROR",
            message: "MCP transport close failed",
          });
        }
      }
    }
  });

  let closed = false;
  return {
    app,
    config,
    close: () => {
      if (closed) return;
      closed = true;
      mcpSessions.close();
      resourceMonitor.close();
      jobs.close();
      games.close();
      publisher.close();
      oauthProvider.close();
      projectMemory.close();
      workspaceStore.close?.();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(
      `request logging: ${config.logging.requests ? "enabled" : "disabled"}`,
    );
    console.log(
      `asset logging: ${config.logging.assets ? "enabled" : "disabled"}`,
    );
    console.log(
      `trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`,
    );
  });

  const shutdown = createShutdownHandler({
    httpServer,
    closeResources: close,
    exit: (code) => process.exit(code),
    logCrash: (reason: ShutdownReason, error: Error) => {
      const ts = new Date().toISOString();
      const label =
        reason === "uncaughtException"
          ? "UNCAUGHT EXCEPTION"
          : "UNHANDLED REJECTION";
      console.error(`[${ts}] ${label}`);
      console.error(error.stack ?? error.message ?? String(error));
    },
  });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => shutdown("uncaughtException", err));
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    shutdown("unhandledRejection", err);
  });
}
