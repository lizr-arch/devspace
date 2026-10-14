import { readFileSync } from "node:fs";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import type { MonitorEventStore } from "../monitor-events.js";
import type { McpSessionSnapshot } from "../mcp-session-registry.js";
import type { ProjectMemoryCommandRunner } from "../project-memory.js";
import { JOB_RUNNERS } from "../background-jobs.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { createReviewCheckpointManager } from "../review-checkpoints.js";
import type { BackgroundJobManager } from "../background-jobs.js";
import type { GameSessionManager } from "../game-sessions.js";
import type { ExternalInspectorManager } from "../inspectors.js";
import type { RunnerRegistry } from "../runner-registry.js";
import type { ArtifactLedger } from "../artifact-ledger.js";
import type { AssetReceiptStore } from "../asset-receipts.js";
import type { ArtifactPublisher } from "../artifact-publisher.js";
import type { TaskRunner } from "../task-runner.js";
import type { GodotImportRegistry } from "../godot-import.js";
import type { ManagedCoachSidecar } from "../managed-coach-sidecar.js";
import type { CoachReviewEventStore } from "../coach-review-events.js";
import type { NativeCodexAgentRunner } from "../codex-agent-runner.js";
import type { AgentObserverStore } from "../agent-observer.js";
import type { CoachRealtimeEngine } from "../coach-realtime.js";

export type Transport = StreamableHTTPServerTransport;

export const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export const TOOL_SCHEMA_REVISION =
  "devspacemac-approved-asset-intake-p1.5-houdini-security-python-bootstrap-p0-workspace-resume-p0.5-asset-download-timeout-p0-additional-root-permissions-shell-tasks-p0-job-wait-resume-p0.1-task-wait-resume-p0.1-cnb-git-remote-godot-import-v1-git-lifecycle-cleanup-p0.1-coach-feed-p0.2-codex-agent-b1-review-b2-recovery-b3-guardian-os001.2026-10-14+coach-runtime-dynamic-observe-v2+agent-efficiency-audit-v1+coach-realtime-001";

export const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
export const LEGACY_WORKSPACE_APP_RESOURCE_URI =
  "ui://devspace/workspace-app.html";
export const VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE =
  "ui://devspace/workspace-app-{buildFingerprint}.html";
export const WORKSPACE_APP_RESOURCE_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const IMPORT_PNG_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export interface ServiceRuntime {
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

export type ToolCapability =
  | "workspace.read"
  | "workspace.write"
  | "artifact.inspect"
  | "artifact.publish"
  | "runner.execute"
  | "git.read"
  | "git.write"
  | "game.control";

export const EXPOSE_LEGACY_SHELL = false;

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

export type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export interface WorkspaceAppBuild {
  entry: WorkspaceAppManifestEntry;
  uiDirectoryPath: string;
  resourceUri: string;
  buildFingerprint: string;
  manifestSha256: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export type ToolWidgetKind =
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

export interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

export type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

export interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

export interface ToolNames {
  openWorkspace: "open_workspace";
  read: "read_file" | "read";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
}

export interface ToolLogFields {
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

export interface CreateServerOptions {
  projectMemoryRunner?: ProjectMemoryCommandRunner;
  workspaceAppBuild?: {
    manifestUrl?: URL;
    uiDirectoryUrl?: URL;
  };
}

/**
 * The structured error every DevSpace tool returns when it refuses an action.
 *
 * Matches `DevSpaceErrorPayload` exactly. It is part of the tool output schema
 * on purpose: a refusal must be a valid, inspectable payload rather than a
 * transport-level failure the model cannot reason about.
 */
export const toolErrorOutputSchema = z
  .object({
    code: z.string(),
    // The wrapper's `DevSpaceErrorPayload` carries all of these; the in-handler
    // `gitToolFailure` helper carries only code+message. Both are valid.
    layer: z.string().optional(),
    message: z.string(),
    retryable: z.boolean().optional(),
    safeToRetry: z.boolean().optional(),
    recoveryHint: z.string().optional(),
    nextRecommendedTools: z.array(z.string()).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export function mcpSessionSourceCountsSchema() {
  return z.object({
    main_connector: z.number().int().nonnegative(),
    workspace_app: z.number().int().nonnegative(),
    doctor: z.number().int().nonnegative(),
    test_client: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  });
}

export const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

export const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

export const projectMemoryPreflightOutputSchema = z.object({
  status: z.enum(["ready", "unconfigured", "error"]),
  receiptId: z.string().optional(),
  decision: z.enum(["allow", "observe_would_deny", "deny"]).optional(),
  wouldDeny: z.boolean(),
  denialReasons: z.array(z.string()),
  bundle: z.unknown().optional(),
  error: z.string().optional(),
});

export const requestedAdditionalRootOutputSchema = z.object({
  path: z.string(),
  access: z.enum(["inherit", "read_only", "read_write"]),
});

export const effectiveAdditionalRootOutputSchema = z.object({
  path: z.string(),
  access: z.enum(["read_only", "read_write"]),
});

export const rejectedAdditionalRootOutputSchema =
  requestedAdditionalRootOutputSchema.extend({
    code: z.enum([
      "ADDITIONAL_ROOT_NOT_FOUND",
      "ADDITIONAL_ROOT_NOT_DIRECTORY",
      "ADDITIONAL_ROOT_ACCESS_CONFLICT",
    ]),
    message: z.string(),
  });

export const additionalRootsAuthorizationOutputSchema: z.ZodRawShape = {
  requestedAdditionalRoots: z.array(requestedAdditionalRootOutputSchema),
  effectiveAdditionalRoots: z.array(effectiveAdditionalRootOutputSchema),
  rejectedAdditionalRoots: z.array(rejectedAdditionalRootOutputSchema),
  additionalRootsScope: z.literal("in_memory_session"),
  additionalRootsPersisted: z.literal(false),
};

export const workspaceContextOutputSchema: z.ZodRawShape = {
  workspaceId: z.string(),
  root: z.string(),
  mode: z.enum(["checkout", "worktree"]),
  /** Authoritative lifecycle state of this session. */
  lifecycleState: z
    .enum(["active", "idle", "closing", "closed", "stale", "unknown"])
    .optional(),
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
  ...additionalRootsAuthorizationOutputSchema,
  reused: z.boolean().optional(),
  instruction: z.string(),
};

export const workspaceSessionOutputSchema = z.object({
  workspaceId: z.string(),
  root: z.string(),
  mode: z.enum(["checkout", "worktree"]),
  sourceRoot: z.string().optional(),
  /**
   * Authoritative persisted lifecycle state. The legacy `status` column is a
   * mirror and must not be used to decide whether a session is live.
   */
  lifecycleState: z
    .enum(["active", "idle", "closing", "closed", "stale", "unknown"])
    .optional(),
  additionalRoots: z.array(effectiveAdditionalRootOutputSchema),
  ...additionalRootsAuthorizationOutputSchema,
  managed: z.boolean(),
  detached: z.boolean().optional(),
  branch: z.string().optional(),
  status: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  resumable: z.boolean(),
  unavailableReason: z.string().optional(),
});

export const jobStatusSchema = z.enum([
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export const jobSnapshotOutputSchema = z.object({
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
      "HOUDINI_FAILED",
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
  outputCursor: z.string().optional(),
  outputMode: z.enum(["range", "tail"]).optional(),
  outputDiscardedBeforeBytes: z.number().int().nonnegative().optional(),
  waitTimedOut: z.boolean().optional(),
});

export const artifactTypeSchema = z.enum([
  "blend",
  "glb",
  "houdini",
  "geometry",
  "scene",
  "image",
  "audio",
  "json",
  "text",
]);

export const artifactOutputSchema = z.object({
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

export const captureProfileOutputSchema = z.object({
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

export const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

export const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

import type { OperationRegistry } from "../operation-registry.js";

export interface ServerContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  jobs: BackgroundJobManager;
  games: GameSessionManager;
  inspectors: ExternalInspectorManager;
  runners: RunnerRegistry;
  artifacts: ArtifactLedger;
  assetReceipts: AssetReceiptStore;
  publisher: ArtifactPublisher;
  operations: OperationRegistry;
  runtime: ServiceRuntime;
  workspaceApp: WorkspaceAppBuild | undefined;
  tasks: TaskRunner;
  godotImport: GodotImportRegistry;
  managedCoachSidecar: ManagedCoachSidecar;
  coachReviewEvents: CoachReviewEventStore;
  coachRealtime: CoachRealtimeEngine;
  agentObserver: AgentObserverStore;
  getNativeCodexRunner: () => NativeCodexAgentRunner;
  toolNames: ToolNames;
  widgetMeta: (
    toolName: string,
    kind: ToolWidgetKind,
  ) => ToolWidgetDescriptorMeta;
  interactiveWidgetMeta: (
    toolName: string,
    kind: ToolWidgetKind,
    extraMeta?: Record<string, unknown>,
  ) => ToolWidgetDescriptorMeta;
}
