import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { inspectHoudini } from "../houdini.js";
import {
  DEFAULT_ARTIFACT_TTL_SECONDS,
  MAX_ARTIFACT_TTL_SECONDS,
  MIN_ARTIFACT_TTL_SECONDS,
} from "../artifact-publisher.js";
import {
  JOB_RUNNERS,
  MAX_CONCURRENT_JOBS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
} from "../background-jobs.js";
import { MAX_PNG_IMPORT_BYTES } from "../png-import.js";
import { DEFAULT_ASSET_DOWNLOAD_TIMEOUTS } from "../asset-import.js";
import {
  PACKAGE_VERSION,
  TOOL_SCHEMA_REVISION,
  resultOutputSchema,
  mcpSessionSourceCountsSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  processMemorySnapshot,
  formatRunnerSummary,
  gitRemoteWriteSummary,
  textBlock,
} from "./server-helpers.js";

export function registerInfoTools(server: McpServer, ctx: ServerContext): void {
  const { config, runners, runtime, tasks, workspaceApp } = ctx;

  if (workspaceApp) {
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
        taskExecution: z.object({
          operatorPythonBootstrapConfigured: z.boolean(),
          operatorPythonBootstrapAvailable: z.boolean(),
          ordinaryPythonFallback: z.literal(false),
          bootstrapTargets: z.tuple([z.literal(".venv"), z.literal("venv")]),
        }),
        assetIntake: z.object({
          maxPngBytes: z.number().int().positive(),
          downloadTimeouts: z.object({
            connectOrHeadersMs: z.number().int().positive(),
            idleReadMs: z.number().int().positive(),
            totalMs: z.number().int().positive(),
          }),
          signedUrlsPersisted: z.literal(false),
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
      const taskExecutionStatus = tasks.getOperatorPythonBootstrapStatus();
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
            "HIP",
            "HIPLC",
            "HIPNC",
            "HDA",
            "HDALC",
            "HDANC",
            "BGEO.SC",
            "ABC",
            "USD",
            "USDA",
            "USDC",
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
        taskExecution: {
          operatorPythonBootstrapConfigured: taskExecutionStatus.configured,
          operatorPythonBootstrapAvailable: taskExecutionStatus.available,
          ordinaryPythonFallback: false as const,
          bootstrapTargets: [".venv", "venv"] as const,
        },
        assetIntake: {
          maxPngBytes: MAX_PNG_IMPORT_BYTES,
          downloadTimeouts: DEFAULT_ASSET_DOWNLOAD_TIMEOUTS,
          signedUrlsPersisted: false as const,
        },
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
        `Task Python: bootstrap=${taskExecutionStatus.available ? "available" : taskExecutionStatus.configured ? "configured-unavailable" : "unconfigured"}, ordinary fallback=false`,
        `Asset intake: PNG max=${MAX_PNG_IMPORT_BYTES} bytes; connect/headers=${DEFAULT_ASSET_DOWNLOAD_TIMEOUTS.connectOrHeadersMs}ms; idle=${DEFAULT_ASSET_DOWNLOAD_TIMEOUTS.idleReadMs}ms; total=${DEFAULT_ASSET_DOWNLOAD_TIMEOUTS.totalMs}ms; signed URLs persisted=false`,
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
    "houdini_info",
    {
      title: "Houdini info",
      description:
        "Inspect trusted Houdini executable discovery, version, architecture, safe product classification, and read-only license availability. The bounded preflight never logs in, activates, modifies licensing, or returns keys, accounts, credentials, environment variables, or raw diagnostic output.",
      inputSchema: {},
      outputSchema: resultOutputSchema({
        detectedExecutable: z.string().optional(),
        version: z.string().optional(),
        hostArchitecture: z.string(),
        executableArchitecture: z.string().optional(),
        productEdition: z.enum([
          "commercial",
          "indie",
          "education",
          "apprentice_non_commercial",
          "engine",
          "unknown",
        ]),
        licenseStatus: z.enum(["available", "unavailable", "unknown"]),
        hythonAvailable: z.boolean(),
        hbatchAvailable: z.boolean(),
        hythonExecutable: z.string().optional(),
        hbatchExecutable: z.string().optional(),
        diagnostic: z.string(),
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const details = await inspectHoudini(runners);
      const result = [
        `Houdini version: ${details.version ?? "not detected"}`,
        `Host architecture: ${details.hostArchitecture}`,
        `Executable architecture: ${details.executableArchitecture ?? "unknown"}`,
        `Product edition: ${details.productEdition}`,
        `License: ${details.licenseStatus}`,
        `hython: ${details.hythonAvailable ? "available" : "unavailable"}`,
        `hbatch: ${details.hbatchAvailable ? "available" : "unavailable"}`,
        `Diagnostic: ${details.diagnostic}`,
      ].join("\n");
      return {
        content: [textBlock(result)],
        _meta: { tool: "houdini_info" },
        structuredContent: { result, ...details },
      };
    },
  );
}
