import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
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
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
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
import { importPng, MAX_PNG_IMPORT_BYTES } from "./png-import.js";
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
  type WorkspaceContext,
} from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const TOOL_SCHEMA_REVISION = "game-art-v1.preview-c.2026-07-25";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
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
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

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
  | "show_changes";

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

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return (
        kind === "workspace" ||
        kind === "project_memory" ||
        kind === "show_changes"
      );
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
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
    "publish_artifact",
    "resume_workspace",
    "open_workspace",
    "project_memory_preflight",
    toolNames.read,
  ];
  if (!config.readOnly) {
    tools.push(toolNames.write, "import_png", toolNames.edit);
  }
  if (config.widgets === "changes") tools.push("show_changes");
  if (exposeDedicatedReadTools(config)) {
    tools.push(toolNames.grep, toolNames.glob, toolNames.ls);
  }
  if (!config.readOnly) {
    tools.push(
      toolNames.shell,
      "start_job",
      "start_capture",
      "poll_job",
      "cancel_job",
    );
  }
  return tools;
}

function createServiceRuntime(config: ServerConfig): ServiceRuntime {
  const tools = exposedToolNames(config, toolNamesFor(config));
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
      }),
    )
    .digest("hex");
  return {
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
    tools,
    schemaFingerprint,
  };
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

  return `Use DevSpace as a local coding workspace. Call devspace_info when diagnosing tool discovery or server freshness. Use list_workspaces and resume_workspace to recover a persisted checkout or managed worktree by workspaceId after a server or client restart. Call ${toolNames.openWorkspace} once per new project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, shell, job, capture, and artifact tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspectionText}Prefer ${toolNames.edit} for targeted text modifications, ${toolNames.write} only for new text files or complete text rewrites, import_png for original PNG bytes from an HTTPS result URL or Base64 data, ${toolNames.shell} for bounded foreground commands, start_job/poll_job/cancel_job for long-running validation commands, start_capture for a validated project capture profile, list_artifacts for persistent SHA-256 records, and publish_artifact only when a short-lived review/download URL is needed. Do not create, download, or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChanges}${projectMemory}`;
}

export interface CreateServerOptions {
  projectMemoryRunner?: ProjectMemoryCommandRunner;
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

const artifactTypeSchema = z.enum(["blend", "glb", "image", "json", "text"]);

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
  jobId: z.string(),
  runner: z.enum(JOB_RUNNERS),
  runnerVersion: z.string().optional(),
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
  config: ServerConfig,
): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
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
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
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

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(
    readFileSync(uiManifestUrl(), "utf8"),
  ) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
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

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
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
  runners: RunnerRegistry,
  artifacts: ArtifactLedger,
  publisher: ArtifactPublisher,
  runtime: ServiceRuntime,
): McpServer {
  const toolNames = toolNamesFor(config);
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

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

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
        readOnly: z.boolean(),
        toolMode: z.enum(["minimal", "full"]),
        toolNaming: z.enum(["legacy", "short"]),
        widgets: z.enum(["off", "changes", "full"]),
        allowedRoots: z.array(z.string()),
        worktreeRoot: z.string(),
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
        readOnly: config.readOnly,
        toolMode: config.minimalTools
          ? ("minimal" as const)
          : ("full" as const),
        toolNaming: config.toolNaming,
        widgets: config.widgets,
        allowedRoots: config.allowedRoots,
        worktreeRoot: config.worktreeRoot,
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
            "JSON",
            "TXT",
            "LOG",
          ],
          captureProfileDirectory: ".devspace/captures" as const,
        },
      };
      const result = [
        `DevSpace ${PACKAGE_VERSION}`,
        `Boot ID: ${runtime.bootId}`,
        `Schema: ${TOOL_SCHEMA_REVISION} (${runtime.schemaFingerprint})`,
        `Tools (${runtime.tools.length}): ${runtime.tools.join(", ")}`,
        `Mode: ${details.toolMode}, readOnly=${String(config.readOnly)}`,
        `Allowed roots: ${config.allowedRoots.join(", ")}`,
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
      _meta: {},
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
        previewType: z.enum(["image", "text", "json", "download"]),
      }),
      _meta: {},
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
      },
      outputSchema: workspaceContextOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, task }) => {
      const startedAt = performance.now();
      const context = await workspaces.resumeWorkspace(workspaceId, task);
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
      },
      outputSchema: workspaceContextOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef, task }) => {
      const startedAt = performance.now();
      const context = await workspaces.openWorkspace({
        path,
        mode,
        baseRef,
        task,
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
      ...toolWidgetDescriptorMeta(config, "project_memory"),
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
      ...toolWidgetDescriptorMeta(config, "read"),
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
        description: `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe("File path to write, relative to the workspace root."),
          content: z.string().describe("Complete new file content."),
          projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "write"),
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
        workspaces.resolvePath(workspace, input.path);
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
        description: `Import original PNG bytes into an open workspace from exactly one source: a public HTTPS result URL or standard Base64 data. Use this for generated-image or attachment intake instead of ${toolNames.shell} or the text-only ${toolNames.write} tool. The destination must end in .png, stay inside the workspace, and is not overwritten unless overwrite=true. Imports are limited to ${MAX_PNG_IMPORT_BYTES} bytes and return a SHA-256 digest for provenance registration.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Destination .png path relative to the workspace root, for example managed_worktree/raw/candidate.png.",
            ),
          sourceUrl: z
            .string()
            .url()
            .optional()
            .describe(
              "Public HTTPS URL containing the PNG bytes. Provide exactly one of sourceUrl or base64Data.",
            ),
          base64Data: z
            .string()
            .optional()
            .describe(
              "Standard Base64-encoded PNG bytes. Provide exactly one of base64Data or sourceUrl.",
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
          path: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string(),
          source: z.enum(["https", "base64"]),
          sourceHost: z.string().optional(),
        }),
        _meta: {},
        annotations: IMPORT_PNG_TOOL_ANNOTATIONS,
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
          "import_png",
          projectMemoryReceiptId,
        );
        const destination = workspaces.resolvePath(workspace, path);
        try {
          const imported = await importPng({
            destination,
            workspaceRoot: workspace.root,
            sourceUrl,
            base64Data,
            expectedSha256,
            overwrite,
          });
          const result = `Imported ${path} (${imported.bytes} bytes, sha256 ${imported.sha256}).`;
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
                summary: imported,
              },
            },
            structuredContent: {
              result,
              path,
              ...imported,
            },
          };
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
        ...toolWidgetDescriptorMeta(config, "edit"),
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
        ...toolWidgetDescriptorMeta(config, "show_changes"),
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
        ...toolWidgetDescriptorMeta(config, "search"),
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
        ...toolWidgetDescriptorMeta(config, "search"),
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
        ...toolWidgetDescriptorMeta(config, "directory"),
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
        ...toolWidgetDescriptorMeta(config, "shell"),
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
        ...toolWidgetDescriptorMeta(config, "job"),
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
        ...toolWidgetDescriptorMeta(config, "job"),
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
        ...toolWidgetDescriptorMeta(config, "job"),
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
        ...toolWidgetDescriptorMeta(config, "job"),
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

  return server;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const runners = new RunnerRegistry(config.runners);
  const runtime = createServiceRuntime(config);
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
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

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
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
    });

    next();
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

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "devspace",
      version: PACKAGE_VERSION,
      bootId: runtime.bootId,
      schemaRevision: TOOL_SCHEMA_REVISION,
      schemaFingerprint: runtime.schemaFingerprint,
      tools: runtime.tools.length,
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

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          jobs,
          runners,
          artifacts,
          publisher,
          runtime,
        );
        await server.connect(transport);
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
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
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
      jobs.close();
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

  const shutdown = () => {
    httpServer.close(() => {
      close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
