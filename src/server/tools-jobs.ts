import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  DEFAULT_JOB_TIMEOUT_SECONDS,
  DEFAULT_LIST_JOBS_LIMIT,
  DEFAULT_WAIT_OUTPUT_BYTES,
  DEFAULT_WAIT_SECONDS,
  JOB_RUNNERS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_LIST_JOBS_LIMIT,
  MAX_POLL_BYTES,
  MAX_WAIT_OUTPUT_BYTES,
  MAX_WAIT_SECONDS,
} from "../background-jobs.js";
import { MAX_ARTIFACT_ROOTS } from "../artifact-ledger.js";
import { JOB_RETENTION_CLASSES } from "../job-retention.js";
import { loadCaptureProfile } from "../capture-profiles.js";
import {
  resultOutputSchema,
  jobSnapshotOutputSchema,
  captureProfileOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  textBlock,
  assertJobWorkspace,
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

export function registerJobTools(server: McpServer, ctx: ServerContext): void {
  const { config, workspaces, jobs, runners, widgetMeta } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "start_job",
    {
      title: "Start background job",
      description:
        "Start a bounded background validation job inside an open workspace. Select an approved build/test/check runner and pass an argument array; arbitrary executables and shell command strings are not accepted. The process is spawned without a shell, its working directory is workspace-scoped, and runtime/output/concurrency are capped. Use wait_job for normal completion waiting, list_jobs after a client interruption, poll_job only for explicit paginated log reads, and cancel_job to stop it.",
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
      const result = `Started ${job.jobId}: ${runner} ${job.args.join(" ")}. Wait with wait_job using outputCursor ${job.outputCursor}.`;
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
      const result = `Started capture ${loaded.name} as ${job.jobId}. Wait with wait_job using outputCursor ${job.outputCursor}, then use list_artifacts and publish_artifact.`;
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
    "wait_job",
    {
      title: "Wait for background job",
      description: `Wait up to ${DEFAULT_WAIT_SECONDS} seconds for a background job to settle, without model-side polling. Return only new output since the opaque outputCursor, capped to a small tail. Reuse the returned outputCursor if another wait is needed. If the client reconnects without a jobId, call list_jobs first.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier that owns the job."),
        jobId: z.string().describe("Job identifier returned by start_job."),
        outputCursor: z
          .string()
          .optional()
          .describe(
            "Opaque cursor returned by start_job or a previous wait_job. Omit it after reconnecting if the latest output tail is needed.",
          ),
        waitSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(
            `Long-poll duration. Defaults to ${DEFAULT_WAIT_SECONDS} seconds and is capped at ${MAX_WAIT_SECONDS}.`,
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_OUTPUT_BYTES)
          .optional()
          .describe(
            `Maximum new output bytes to return. Defaults to ${DEFAULT_WAIT_OUTPUT_BYTES}; capped at ${MAX_WAIT_OUTPUT_BYTES}.`,
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        job: jobSnapshotOutputSchema,
      }),
      ...widgetMeta("wait_job", "job"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      jobId,
      outputCursor,
      waitSeconds,
      maxBytes,
      projectMemoryReceiptId,
    }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "wait_job",
        projectMemoryReceiptId,
      );
      const existing = jobs.poll(jobId, 0, 1);
      assertJobWorkspace(existing, workspaceId);
      const job = await jobs.wait(jobId, outputCursor, waitSeconds, maxBytes);
      const result = [
        `${job.jobId}: ${job.status}`,
        job.waitTimedOut
          ? `No terminal state within ${waitSeconds ?? DEFAULT_WAIT_SECONDS} seconds; reuse outputCursor with wait_job.`
          : undefined,
        `Output bytes: ${job.outputBytes}${job.outputTruncated ? " (truncated)" : ""}`,
        job.outputDiscardedBeforeBytes
          ? `Skipped ${job.outputDiscardedBeforeBytes} older output bytes to keep this response bounded.`
          : undefined,
        job.exitCode !== undefined ? `Exit code: ${job.exitCode}` : undefined,
        job.signal ? `Signal: ${job.signal}` : undefined,
        job.error ? `Error: ${job.error}` : undefined,
        job.artifactStatus !== "none"
          ? `Artifacts: ${job.artifactStatus} (${job.artifactCount})`
          : undefined,
        job.output ? `Latest output:\n${job.output}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      logToolCall(config, {
        tool: "wait_job",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {
          tool: "wait_job",
          projectMemory,
          card: { workspaceId, summary: job },
        },
        structuredContent: { result, job },
      };
    },
  );

  registerAppTool(
    server,
    "list_jobs",
    {
      title: "List background jobs",
      description:
        "Recover recent background jobs for one workspace after a client interruption or lost jobId. Returns bounded metadata only; call wait_job without outputCursor to obtain the latest small output tail.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier whose jobs should be listed."),
        activeOnly: z
          .boolean()
          .optional()
          .describe("Return only running or cancelling jobs."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_JOBS_LIMIT)
          .optional()
          .describe(
            `Maximum jobs to return. Defaults to ${DEFAULT_LIST_JOBS_LIMIT}; capped at ${MAX_LIST_JOBS_LIMIT}.`,
          ),
        retention: z
          .boolean()
          .optional()
          .describe(
            "Also return a READ-ONLY lifecycle preview of the whole job store: per-class counts and bytes, the only records a cleanup could ever consider, and the records that are protected (running, recovery-pending, failure evidence, unattributed). Nothing is deleted.",
          ),
        succeededRetentionDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            "Retention window applied to succeeded job records when retention=true. Defaults to 30 days. Failed, cancelled, timed-out and interrupted records are never eligible.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      },
      outputSchema: resultOutputSchema({
        jobs: z.array(jobSnapshotOutputSchema),
        retention: z.unknown().optional(),
      }),
      ...widgetMeta("list_jobs", "job"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      activeOnly,
      limit,
      retention,
      succeededRetentionDays,
      projectMemoryReceiptId,
    }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "list_jobs",
        projectMemoryReceiptId,
      );
      const listed = jobs.list(workspaceId, { activeOnly, limit });
      const retentionPreview = retention
        ? jobs.jobRetentionPreview(succeededRetentionDays)
        : undefined;
      const active = listed.filter(
        (job) => job.status === "running" || job.status === "cancelling",
      ).length;
      const retentionText = retentionPreview
        ? [
            "",
            `Job store retention preview (READ-ONLY, deletes nothing): ${retentionPreview.totalRecords} record(s), ${(retentionPreview.totalBytes / 1024 / 1024).toFixed(1)} MiB.`,
            ...JOB_RETENTION_CLASSES.map(
              (kind) =>
                `  ${kind}: ${retentionPreview.byClass[kind].count}`,
            ),
            `  eligible for a future cleanup: ${retentionPreview.expirableCandidates.length}`,
            ...retentionPreview.notes.map((note) => `  note: ${note}`),
          ].join("\n")
        : "";
      const result =
        (listed.length === 0
          ? "No background jobs found for this workspace."
          : [
              `Found ${listed.length} background job(s); ${active} active.`,
              ...listed.map(
                (job) =>
                  `${job.jobId}: ${job.status} · ${job.runner} · ${job.label ?? job.args.join(" ")}`,
              ),
            ].join("\n")) + retentionText;
      logToolCall(config, {
        tool: "list_jobs",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {
          tool: "list_jobs",
          projectMemory,
          card: {
            workspaceId,
            summary: { count: listed.length, active },
          },
        },
        structuredContent: { result, jobs: listed, retention: retentionPreview },
      };
    },
  );

  registerAppTool(
    server,
    "poll_job",
    {
      title: "Poll background job",
      description:
        "Compatibility and explicit log-reading tool. Read one bounded byte range from a background job, reusing nextOutputOffsetBytes. For normal completion waiting use wait_job instead, so the model does not create a rapid polling loop.",
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
