import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  finishGodotImportReport,
  startGodotImport,
  type GodotImportRunResult,
} from "../godot-import.js";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
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

export function godotImportResultText(result: GodotImportRunResult): string {
  const { import: record, job, census, after, anomaly } = result;
  const lines = [
    `Godot import ${job.status} (job ${job.jobId}).`,
    `Project: ${record.projectRoot} (project.godot verified).`,
    `Engine: ${record.engineVersion ?? "(version probe unavailable)"} via godot-mono.`,
    `Arguments (fixed): ${record.args.join(" ")} [policy ${record.argumentPolicy}]`,
    `Timeout: ${record.timeoutSeconds}s.`,
    job.exitCode !== undefined ? `Exit code: ${job.exitCode}.` : undefined,
    job.signal ? `Signal: ${job.signal}.` : undefined,
    census
      ? `Godot ERROR lines: ${census.errorCount}; import failures: ${census.importFailureCount}; script errors: ${census.scriptErrorCount}${census.truncated ? " (line samples truncated)" : ""}.`
      : "Import still running; use wait_job or poll_job, then repeat godot_import with jobId for the bounded report.",
    after
      ? `Git after import: HEAD ${after.headSha}${after.headUnchanged ? " (unchanged)" : " (CHANGED)"}, branch ${after.branch ?? "(detached)"}${after.branchUnchanged ? "" : " (CHANGED)"}, tracked files ${after.trackedFilesUnchanged ? "unchanged" : "CHANGED"}.`
      : undefined,
    after
      ? `Generated untracked output: ${after.newUntrackedPaths.length} new path(s); ${after.generatedOutsideImportCache.length} outside the .godot import cache (review before committing).`
      : undefined,
    anomaly,
    job.error,
  ]
    .filter(Boolean)
    .join("\n");
  return lines;
}

export function registerGodotImportTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, jobs, runners, godotImport, widgetMeta } = ctx;

  if (config.readOnly) return;
  if (!config.godotImport.enabled) return;

  registerAppTool(
    server,
    "godot_import",
    {
      title: "Import Godot project resources",
      description:
        "Run the first-time Godot editor resource import for one operator-approved Godot project. The tool always executes the workspace's configured Godot Mono executable with the fixed argument vector --headless --editor --import --path . --quit; no executable, path, or additional argument can be supplied. The project root is the workspace root, project.godot must exist there, the workspace must be an approved managed worktree or a clean checkout, and two imports of the same project cannot run concurrently. The bounded report returns the real exit code, a Godot ERROR/import-failure census, and whether the import changed tracked files or Git references.",
      inputSchema: z.strictObject({
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(config.godotImport.maxTimeoutSeconds)
          .optional()
          .describe(
            `Import timeout. Defaults to ${config.godotImport.defaultTimeoutSeconds}; maximum ${config.godotImport.maxTimeoutSeconds}.`,
          ),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe(
            "How long to wait for the import to settle before returning the in-flight status. Defaults to 240. The import keeps running; follow it with wait_job or poll_job.",
          ),
        jobId: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Report only: return the bounded report for an earlier godot_import job id instead of starting a new import.",
          ),
        projectMemoryReceiptId: projectMemoryReceiptInputSchema(),
      }),
      outputSchema: resultOutputSchema({
        import: z.unknown().optional(),
        job: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
      ...widgetMeta("godot_import", "job"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspaceId,
      timeoutSeconds,
      waitSeconds,
      jobId,
      projectMemoryReceiptId,
    }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectMemory = workspaces.observeProjectMemoryAccess(
        workspaceId,
        "godot_import",
        projectMemoryReceiptId,
      );
      try {
        const result = jobId
          ? await reportExistingImport(ctx, workspaceId, jobId, waitSeconds)
          : await startGodotImport({
              config,
              workspace,
              jobs,
              runners,
              registry: godotImport,
              timeoutSeconds,
              waitSeconds,
            });
        const text = godotImportResultText(result);
        logToolCall(config, {
          tool: "godot_import",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(text)],
          _meta: {
            tool: "godot_import",
            projectMemory,
            card: {
              workspaceId,
              path: result.import.projectRoot,
              summary: {
                jobId: result.job.jobId,
                status: result.job.status,
                exitCode: result.job.exitCode,
                engineVersion: result.import.engineVersion,
                errorCount: result.census?.errorCount,
                importFailureCount: result.census?.importFailureCount,
                anomaly: result.anomaly,
              },
            },
          },
          structuredContent: { result: text, ...result },
        };
      } catch (error) {
        return godotImportFailure(error, projectMemory);
      }
    },
  );
}

async function reportExistingImport(
  ctx: ServerContext,
  workspaceId: string,
  jobId: string,
  waitSeconds: number | undefined,
): Promise<GodotImportRunResult> {
  const record = ctx.godotImport.get(jobId);
  if (!record) {
    throw new Error(
      `GODOT_IMPORT_JOB_UNKNOWN: ${jobId} was not started by godot_import for this service instance.`,
    );
  }
  if (record.workspaceId !== workspaceId) {
    throw new Error(
      "GODOT_IMPORT_JOB_UNKNOWN: Job does not belong to this workspaceId.",
    );
  }
  return finishGodotImportReport({
    jobs: ctx.jobs,
    registry: ctx.godotImport,
    jobId,
    waitSeconds,
  });
}

function godotImportFailure(error: unknown, projectMemory: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(raw);
  const detail = {
    code: match?.[1] ?? "GODOT_IMPORT_FAILED",
    message: match?.[2] || raw || "Godot import failed.",
  };
  const result = `${detail.code}: ${detail.message}`;
  return {
    isError: true as const,
    content: [textBlock(result)],
    _meta: { tool: "godot_import", projectMemory },
    structuredContent: { result, error: detail },
  };
}
