import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  type ServerConfig,
  loadConfig,
} from "./config.js";
import {
  resolveWorkspaceAppBuild,
  registerWorkspaceAppResources,
  workspaceAppUiMetadata,
  shouldAttachWidget,
  REVIEW_ONLY_WIDGET_TOOLS,
  toolWidgetDescriptorMeta,
} from "./server/server-workspace-app.js";
import {
  TOOL_SCHEMA_REVISION,
  LEGACY_WORKSPACE_APP_RESOURCE_URI,
  VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE,
  PACKAGE_VERSION,
  type WorkspaceAppBuild,
  type ServerContext,
  type Transport,
  type CreateServerOptions,
  type ToolWidgetKind,
  type ToolWidgetDescriptorMeta,
} from "./server/server-types.js";
import {
  serverInstructions,
  createServiceRuntime,
  toolNamesFor,
  setToolLeaseRegistry,
  setToolQuarantineGuard,
} from "./server/server-helpers.js";
import { LsofWorktreeProcessProbe } from "./workspace-process-probe.js";
import { registerInfoTools } from "./server/tools-info.js";
import {
  registerWorkspaceListTools,
  registerWorkspaceCoreTools,
} from "./server/tools-workspace.js";
import {
  registerFsReadTool,
  registerFsWriteTool,
  registerFsEditTool,
  registerFsReviewTool,
} from "./server/tools-fs.js";
import {
  registerFsSearchTools,
  registerFsShellTool,
} from "./server/tools-search-shell.js";
import { registerFileOpsTools } from "./server/tools-files.js";
import {
  registerGitInspectionTools,
  registerGitMutationTools,
} from "./server/tools-git.js";
import { registerJobTools } from "./server/tools-jobs.js";
import {
  registerArtifactInspectionTools,
  registerPublishArtifactTool,
  registerImportAssetAndPreviewTools,
  registerImportPngTool,
} from "./server/tools-artifacts.js";
import { registerArchiveAssetTool } from "./server/tools-archive-asset.js";
import { registerApprovedAssetTools } from "./server/tools-approved-assets.js";
import {
  registerGlbInspectorTool,
  registerOtherInspectorTools,
} from "./server/tools-inspectors.js";
import { registerGameTools } from "./server/tools-game.js";
import {
  registerProjectTaskTool,
  registerTaskSessionReadOnlyTools,
  registerTaskSessionMutationTools,
} from "./server/tools-tasks.js";
import { registerGodotImportTool } from "./server/tools-godot.js";
import { registerSidecarTools } from "./server/tools-sidecar.js";
import { setupExpressRoutes } from "./server/express-routes.js";
import { OperationRegistry } from "./operation-registry.js";
import { MonitorEventStore } from "./monitor-events.js";
import { McpSessionRegistry } from "./mcp-session-registry.js";
import { logEvent, sessionIdPrefix } from "./logger.js";
import { RunnerRegistry } from "./runner-registry.js";
import { TaskRunner } from "./task-runner.js";
import { OperatorServiceEnvironmentResolver } from "./secret-resolver.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { ProjectMemoryController } from "./project-memory.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ArtifactLedger } from "./artifact-ledger.js";
import { AssetReceiptStore } from "./asset-receipts.js";
import { ArtifactPublisher } from "./artifact-publisher.js";
import { BackgroundJobManager } from "./background-jobs.js";
import { GodotImportRegistry } from "./godot-import.js";
import { GameSessionManager } from "./game-sessions.js";
import { ExternalInspectorManager } from "./inspectors.js";
import { ManagedCoachSidecar } from "./managed-coach-sidecar.js";
import { AgentObserverStore } from "./agent-observer.js";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { NativeCodexAgentRunner } from "./codex-agent-runner.js";
import { DevSpaceInstanceLock } from "./devspace-instance-lock.js";
import { registerCodexAgentTools } from "./server/tools-codex-agent.js";
import { registerCodexReviewTools } from "./server/tools-codex-review.js";
import { registerAgentAuditTools } from "./server/tools-agent-audit.js";
import {
  LiveRequestMonitor,
  ProcessResourceMonitor,
} from "./live-monitor.js";
import type express from "express";

export {
  TOOL_SCHEMA_REVISION,
  LEGACY_WORKSPACE_APP_RESOURCE_URI,
  VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE,
  type WorkspaceAppBuild,
  REVIEW_ONLY_WIDGET_TOOLS,
  shouldAttachWidget,
  resolveWorkspaceAppBuild,
  registerWorkspaceAppResources,
  workspaceAppUiMetadata,
  type CreateServerOptions,
};

export interface RunningServer {
  app: express.Express;
  config: ServerConfig;
  /**
   * The fully wired server context, exposed so verification harnesses can drive
   * the exact same registered tool surface the live service serves instead of
   * re-implementing it.
   */
  ctx: ServerContext;
  close: () => Promise<void>;
}

export function createMcpServer(ctx: ServerContext): McpServer {
  const { config, toolNames, workspaceApp } = ctx;
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
    registerWorkspaceAppResources(server, config, workspaceApp);
  }

  registerInfoTools(server, ctx);
  // The tool wrapper leases the workspace for the whole call so occupancy is
  // observable rather than inferred. See setToolLeaseRegistry.
  setToolLeaseRegistry(ctx.workspaces);
  setToolQuarantineGuard((workspaceId)=>ctx.coachReviewEvents.hasInterruptedRun(workspaceId));
  registerWorkspaceListTools(server, ctx);
  registerArtifactInspectionTools(server, ctx);
  registerGitInspectionTools(server, ctx);
  registerPublishArtifactTool(server, ctx);
  registerArchiveAssetTool(server, ctx);
  registerApprovedAssetTools(server, ctx);
  registerImportAssetAndPreviewTools(server, ctx);
  registerFileOpsTools(server, ctx);
  registerGitMutationTools(server, ctx);
  registerWorkspaceCoreTools(server, ctx);
  registerFsReadTool(server, ctx);
  registerFsWriteTool(server, ctx);
  registerImportPngTool(server, ctx);
  registerFsEditTool(server, ctx);
  registerFsReviewTool(server, ctx);
  registerFsSearchTools(server, ctx);
  registerFsShellTool(server, ctx);
  registerJobTools(server, ctx);
  registerGameTools(server, ctx);
  registerGlbInspectorTool(server, ctx);
  registerOtherInspectorTools(server, ctx);
  registerProjectTaskTool(server, ctx);
  registerTaskSessionReadOnlyTools(server, ctx);
  registerTaskSessionMutationTools(server, ctx);
  registerGodotImportTool(server, ctx);
  registerSidecarTools(server, ctx);
  registerCodexAgentTools(server, ctx);
  registerCodexReviewTools(server, ctx);
  registerAgentAuditTools(server, ctx);

  return server;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  // Acquire BEFORE creating any shared-state readers or writers, especially
  // before reconciling persisted RUNNING Codex operations after a crash.
  const owner = new DevSpaceInstanceLock(config.stateDir);
  try {
    const server = createServerWithOwnedState(config, options);
    const close = server.close;
    let pending: Promise<void> | undefined;
    return {...server, close: () => pending ??= Promise.resolve()
      .then(() => close()).finally(() => owner.release())};
  } catch (error) {
    owner.release();
    throw error;
  }
}

function createServerWithOwnedState(
  config: ServerConfig,
  options: CreateServerOptions,
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
  const tasks = new TaskRunner({
    ...(config.taskExecution.operatorPythonExecutable
      ? {
          operatorPythonCommand: [
            config.taskExecution.operatorPythonExecutable,
          ] as [string],
        }
      : {}),
  });

  try {
    const rawMappings = process.env["DEVSPACE_SECRET_MAPPINGS"];
    if (rawMappings) {
      const mappings = JSON.parse(rawMappings);
      if (Array.isArray(mappings) && mappings.length > 0) {
        tasks.setSecretResolver(
          new OperatorServiceEnvironmentResolver({ mappings }),
        );
      }
    }
  } catch {
    // The task runner returns TASK_SECRET_UNAUTHORIZED when no resolver exists.
  }

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
  const reviewCheckpoints = createReviewCheckpointManager();
  const artifacts = new ArtifactLedger(config.stateDir);
  const assetReceipts = new AssetReceiptStore(config.stateDir);
  const operations = new OperationRegistry(config.stateDir);
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
  const godotImport = new GodotImportRegistry();
  const games = new GameSessionManager(config.stateDir, runners);
  const inspectors = new ExternalInspectorManager(config.stateDir, runners);
  const requestMonitor = new LiveRequestMonitor();
  const resourceMonitor = new ProcessResourceMonitor();
  // Native stateDir event persistence; the workspace-local COACH005 database
  // remains an isolated legacy fixture, never a production event source.
  const coachReviewEvents = new CoachReviewEventStore(config.stateDir);
  // On a controlled fresh server start, quarantine unknown old runs. No
  // process auto-replay, signal, PID-based kill or invented success status.
  coachReviewEvents.reconcileInterruptedRuns();
  const agentObserver = new AgentObserverStore();
  const managedCoachSidecar = new ManagedCoachSidecar(undefined, coachReviewEvents.path, agentObserver);
  // Lazy: unsupported hosts may still start DevSpace; Codex is only resolved
  // after an explicitly authorized Agent tool invocation.
  let nativeCodexRunner: NativeCodexAgentRunner | undefined;
  const getNativeCodexRunner = () => nativeCodexRunner ??= new NativeCodexAgentRunner({
    events: coachReviewEvents,
    observer: agentObserver,
    auditStore: coachReviewEvents,
    nodePath: "/Users/liz/.local/bin/node",
    codexPath: "/Users/liz/.local/bin/codex",
  });

  /**
   * The workspace registry needs to see every kind of live work, because
   * "is this workspace actually in use?" cannot be answered from the workspace
   * store alone. These probes are read-only and are consulted at decision time.
   */
  const workspaces = new WorkspaceRegistry(
    config,
    workspaceStore,
    projectMemory,
    {
      // Managed in-process sidecars occupy their source workspace for cleanup
      // purposes, but DO NOT hold the code/build workspace resource mutex.
      activeJobIdsForRoot: (root) => [
        ...jobs.activeJobIdsForRoot(root),
        ...managedCoachSidecar.activeServiceIdsForRoot(root).map((id) => `sidecar:${id}`),
      ],
      activeGameSessionIds: (workspaceId) =>
        games
          .listActiveSessions(workspaceId)
          .map((session) => session.sessionId),
      activeTaskSessionIds: (workspaceId) =>
        [
          ...tasks.listSessions(workspaceId, 50)
            .filter((session) => session.status === "running")
            .map((session) => session.sessionId),
          ...(nativeCodexRunner?.activeOperationsForWorkspace(workspaceId)
            .map((id) => "codex:" + id) ?? []),
          ...(coachReviewEvents.hasInterruptedRun(workspaceId)
            ? ["codex:quarantined-interrupted-operation"] : []),
        ],
      // Read-only OS probe: DevSpace cannot see a shell or editor the operator
      // started by hand inside a worktree, and reclaiming over one is exactly
      // the accident this lifecycle exists to prevent.
      processProbe: new LsofWorktreeProcessProbe({
        timeoutMs: config.worktreeCleanup.processProbeTimeoutMs,
      }),
      requireNoForeignProcess: config.worktreeCleanup.requireNoForeignProcess,
    },
  );

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
    return {
      _meta: {
        ...base,
        ...extraMeta,
      },
    };
  };

  const ctx: ServerContext = {
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
    operations,
    runtime,
    workspaceApp,
    tasks,
    godotImport,
    managedCoachSidecar,
    coachReviewEvents,
    getNativeCodexRunner,
    toolNames,
    widgetMeta,
    interactiveWidgetMeta,
  };

  setupExpressRoutes({
    app,
    ctx,
    mcpSessions,
    resourceServerUrl,
    oauthProvider,
    bearerAuth,
    requestMonitor,
    resourceMonitor,
    createMcpServer,
  });

  let closed = false;
  let closePending: Promise<void> | undefined;
  return {
    app,
    config,
    ctx,
    close: () => {
      if (closed) return closePending ?? Promise.resolve();
      closed = true;
      mcpSessions.close();
      resourceMonitor.close();
      jobs.close();
      games.close();
      publisher.close();
      operations.close();
      oauthProvider.close();
      projectMemory.close();
      // In-process listeners are not detached. Release them as part of server
      // shutdown rather than on individual MCP session expiry.
      workspaceStore.close?.();
      closePending = Promise.allSettled([
        managedCoachSidecar.close(),
        nativeCodexRunner?.close(),
      ]).then(() => {
        coachReviewEvents.close();
      });
      return closePending;
    },
  };
}
