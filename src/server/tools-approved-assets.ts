import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { importPng } from "../png-import.js";
import { validatePng } from "../png-validator.js";
import {
  readApprovedReceiptFile,
  reindexApprovedAssetReceipts,
} from "../approved-assets.js";
import { validateApprovedAssetReceipt } from "../asset-receipts.js";
import {
  IMPORT_PNG_FILE_PARAMS_META,
  openAiFileInputSchema,
} from "../openai-file.js";
import { resolveExistingWorkspacePath } from "../workspace-paths.js";
import {
  resultOutputSchema,
  type ServerContext,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  textBlock,
  rollbackImportedAsset,
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

export function registerApprovedAssetTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const {
    config,
    workspaces,
    artifacts,
    assetReceipts,
    runtime,
    interactiveWidgetMeta,
  } = ctx;

  if (config.readOnly) return;

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
        runtime.monitorEvents.recordToolFailure(
          "recover_approved_asset",
          message,
        );
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
}
