import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MAX_LIST_ARTIFACTS } from "../artifact-ledger.js";
import {
  DEFAULT_ARTIFACT_TTL_SECONDS,
  MAX_ARTIFACT_TTL_SECONDS,
  MIN_ARTIFACT_TTL_SECONDS,
} from "../artifact-publisher.js";
import { importPng, MAX_PNG_IMPORT_BYTES } from "../png-import.js";
import {
  IMPORT_PNG_FILE_PARAMS_META,
  openAiFileInputSchema,
} from "../openai-file.js";
import { importAsset } from "../asset-import.js";
import { inspectArtifact } from "../artifact-inspector.js";
import { snapshotWorkspaceFileToTrash } from "../workspace-files.js";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "../workspace-paths.js";
import {
  resultOutputSchema,
  artifactTypeSchema,
  artifactOutputSchema,
  IMPORT_PNG_TOOL_ANNOTATIONS,
  type ServerContext,
  type ToolContent,
} from "./server-types.js";
import {
  registerAppTool,
  logToolCall,
  textBlock,
  contentText,
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

export function registerArtifactInspectionTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, artifacts, widgetMeta } = ctx;

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
}

export function registerPublishArtifactTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, publisher, interactiveWidgetMeta } = ctx;

  if (config.readOnly) return;

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
}

export function registerImportAssetAndPreviewTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, artifacts, publisher, widgetMeta } = ctx;

  if (config.readOnly) return;

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
}

export function registerImportPngTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, artifacts, assetReceipts, runtime, interactiveWidgetMeta } = ctx;

  if (config.readOnly) return;

  registerAppTool(
    server,
    "import_png",
    {
      title: "Import PNG",
      description: `Import original PNG bytes into an open workspace from exactly one source: a ChatGPT file attachment, a public HTTPS result URL, or standard Base64 data. Prefer file for images attached in the conversation. Use this instead of shell commands or the text-only write tool. The destination must end in .png, stay inside the workspace, and is not overwritten unless overwrite=true. Imports are limited to ${MAX_PNG_IMPORT_BYTES} bytes and validate PNG structure, dimensions, CRCs, and decoded scanlines before atomic write and provenance registration.`,
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
            previousSha256: imported.previousSha256,
            previousArtifactId: previousArtifact?.artifactId,
            displacedTrashId,
          });
          const result = `Imported PNG ${path} (${imported.width}x${imported.height}, ${imported.bytes} bytes, sha256 ${imported.sha256}) as ${artifact.artifactId}.`;
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
                  displacedTrashId,
                },
              },
            },
            structuredContent: {
              result,
              workspaceId,
              path,
              bytes: imported.bytes,
              sha256: imported.sha256,
              width: imported.width,
              height: imported.height,
              mimeType: imported.mimeType,
              source: imported.source,
              sourceKind: imported.source,
              sourceHost: imported.sourceHost,
              sourceFileId: imported.sourceFileId,
              sourceFileName: imported.sourceFileName,
              outcome: imported.outcome,
              overwritten: imported.outcome === "replaced",
              artifactId: artifact.artifactId,
              importReceiptId: importReceipt.importReceiptId,
              previousSha256: imported.previousSha256,
              previousArtifactId: previousArtifact?.artifactId,
              projectMemoryReceiptId,
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
        runtime.monitorEvents.recordToolFailure("import_png", message);
        return { content: [textBlock(message)], isError: true };
      }
    },
  );
}

export function registerArtifactTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerArtifactInspectionTools(server, ctx);
  registerPublishArtifactTool(server, ctx);
  registerImportAssetAndPreviewTools(server, ctx);
  registerImportPngTool(server, ctx);
}
