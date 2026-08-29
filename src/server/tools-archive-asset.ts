import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ArtifactLedger } from "../artifact-ledger.js";
import { importPng } from "../png-import.js";
import {
  removeApprovedReceiptFile,
  writeImmutableApprovedReceipt,
} from "../approved-assets.js";
import {
  IMPORT_PNG_FILE_PARAMS_META,
  openAiFileInputSchema,
} from "../openai-file.js";
import { snapshotWorkspaceFileToTrash } from "../workspace-files.js";
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

export function registerArchiveAssetTool(
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
        | Awaited<ReturnType<ArtifactLedger["registerImport"]>>
        | undefined;
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
        runtime.monitorEvents.recordToolFailure(
          "archive_approved_image",
          message,
        );
        return { content: [textBlock(message)], isError: true };
      }
    },
  );
}
