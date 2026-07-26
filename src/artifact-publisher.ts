import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename } from "node:path";
import type { Response } from "express";
import {
  ArtifactLedger,
  verifyArtifactRecord,
  type ArtifactRecord,
  type ListedArtifact,
} from "./artifact-ledger.js";
import { inspectArtifact } from "./artifact-inspector.js";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";

export const DEFAULT_ARTIFACT_TTL_SECONDS = 10 * 60;
export const MIN_ARTIFACT_TTL_SECONDS = 30;
export const MAX_ARTIFACT_TTL_SECONDS = 60 * 60;
export const MAX_IMAGE_PUBLISH_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_PUBLISH_BYTES = 4 * 1024 * 1024;
export const MAX_BINARY_PUBLISH_BYTES = 128 * 1024 * 1024;

export type ArtifactPreviewType =
  "image" | "audio" | "text" | "json" | "download";

export interface ArtifactPublication {
  artifact: ListedArtifact;
  url: string;
  expiresAt: string;
  contentType: string;
  size: number;
  sha256: string;
  previewType: ArtifactPreviewType;
}

export interface ArtifactPublicationAudit {
  event:
    "artifact_published" | "artifact_accessed" | "artifact_access_rejected";
  artifactId?: string;
  workspaceId?: string;
  relativePath?: string;
  expiresAt?: string;
  tokenHashPrefix: string;
  reason?: string;
  purpose?: "review" | "download" | "inspection";
}

interface PublicationGrant {
  tokenHash: string;
  artifactId?: string;
  workspaceId: string;
  workspaceRoot: string;
  relativePath: string;
  expectedSize: number;
  expectedSha256: string;
  mimeType: string;
  expiresAtMs: number;
  previewType: ArtifactPreviewType;
  purpose: "review" | "download" | "inspection";
}

export class ArtifactPublisher {
  private readonly grants = new Map<string, PublicationGrant>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly publicBaseUrl: string,
    private readonly ledger: ArtifactLedger,
    private readonly options: {
      now?: () => number;
      audit?: (event: ArtifactPublicationAudit) => void;
    } = {},
  ) {
    assertSafePublicationBaseUrl(publicBaseUrl);
    this.cleanupTimer = setInterval(() => this.removeExpired(), 60_000);
    this.cleanupTimer.unref();
  }

  async publish(input: {
    workspaceId: string;
    workspaceRoot: string;
    artifactId?: string;
    path?: string;
    ttlSeconds?: number;
    purpose?: "review" | "download" | "inspection";
  }): Promise<ArtifactPublication> {
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_ARTIFACT_TTL_SECONDS;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < MIN_ARTIFACT_TTL_SECONDS ||
      ttlSeconds > MAX_ARTIFACT_TTL_SECONDS
    ) {
      throw new Error(
        `ttlSeconds must be from ${MIN_ARTIFACT_TTL_SECONDS} to ${MAX_ARTIFACT_TTL_SECONDS}.`,
      );
    }
    const verified = await this.ledger.resolveArtifact({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      artifactId: input.artifactId,
      path: input.path,
    });
    assertPublishableSize(verified.artifact);

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAtMs = this.now() + ttlSeconds * 1000;
    const previewType = previewTypeFor(verified.artifact);
    const purpose = input.purpose ?? "review";
    this.grants.set(tokenHash, {
      tokenHash,
      artifactId: verified.artifact.artifactId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      relativePath: verified.artifact.relativePath,
      expectedSize: verified.artifact.size,
      expectedSha256: verified.artifact.sha256,
      mimeType: verified.artifact.mimeType,
      expiresAtMs,
      previewType,
      purpose,
    });
    this.audit({
      event: "artifact_published",
      artifactId: verified.artifact.artifactId,
      workspaceId: input.workspaceId,
      relativePath: verified.artifact.relativePath,
      expiresAt: new Date(expiresAtMs).toISOString(),
      tokenHashPrefix: tokenHash.slice(0, 12),
      purpose,
    });

    return {
      artifact: verified.artifact,
      url: new URL(
        `/artifacts/${encodeURIComponent(token)}`,
        this.publicBaseUrl,
      ).toString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      contentType: verified.artifact.mimeType,
      size: verified.artifact.size,
      sha256: verified.artifact.sha256,
      previewType,
    };
  }

  async preview(input: {
    workspaceId: string;
    workspaceRoot: string;
    artifactId?: string;
    path?: string;
    ttlSeconds?: number;
  }): Promise<
    Omit<ArtifactPublication, "artifact"> & {
      artifact?: ListedArtifact;
      path: string;
    }
  > {
    if (Boolean(input.artifactId) === Boolean(input.path)) {
      throw new Error(
        "ASSET_INPUT_INVALID: Provide exactly one of artifactId or path.",
      );
    }
    if (input.artifactId) {
      const published = await this.publish({
        ...input,
        purpose: "inspection",
      });
      if (!["image", "audio"].includes(published.previewType)) {
        throw new Error(
          "PREVIEW_UNAVAILABLE: Only images and audio can be previewed in M1.",
        );
      }
      return {
        artifact: published.artifact,
        path: published.artifact.relativePath,
        url: published.url,
        expiresAt: published.expiresAt,
        contentType: published.contentType,
        size: published.size,
        sha256: published.sha256,
        previewType: published.previewType,
      };
    }
    const inspection = await inspectArtifact({
      ledger: this.ledger,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      path: input.path,
    });
    const resolved = resolveExistingWorkspacePath(
      input.workspaceRoot,
      input.path!,
      "file",
    );
    const format = previewFormat(inspection.format, inspection.mimeType);
    const descriptor = openSync(
      resolved.absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    let digest: string;
    let size: number;
    try {
      const info = fstatSync(descriptor);
      size = info.size;
      assertPreviewSize(format.previewType, size);
      digest = sha256Descriptor(descriptor, size);
    } finally {
      closeSync(descriptor);
    }
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_ARTIFACT_TTL_SECONDS;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < MIN_ARTIFACT_TTL_SECONDS ||
      ttlSeconds > MAX_ARTIFACT_TTL_SECONDS
    ) {
      throw new Error(
        `ttlSeconds must be from ${MIN_ARTIFACT_TTL_SECONDS} to ${MAX_ARTIFACT_TTL_SECONDS}.`,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAtMs = this.now() + ttlSeconds * 1000;
    this.grants.set(tokenHash, {
      tokenHash,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      relativePath: resolved.relativePath,
      expectedSize: size,
      expectedSha256: digest,
      mimeType: format.mimeType,
      expiresAtMs,
      previewType: format.previewType,
      purpose: "inspection",
    });
    this.audit({
      event: "artifact_published",
      workspaceId: input.workspaceId,
      relativePath: resolved.relativePath,
      expiresAt: new Date(expiresAtMs).toISOString(),
      tokenHashPrefix: tokenHash.slice(0, 12),
      purpose: "inspection",
    });
    return {
      path: resolved.relativePath,
      url: new URL(
        `/artifacts/${encodeURIComponent(token)}`,
        this.publicBaseUrl,
      ).toString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      contentType: format.mimeType,
      size,
      sha256: digest,
      previewType: format.previewType,
    };
  }

  async serve(token: string, response: Response): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.reject(response, 404, "ARTIFACT_NOT_FOUND", "", "invalid token");
      return;
    }
    const tokenHash = hashToken(token);
    const grant = this.grants.get(tokenHash);
    if (!grant) {
      this.reject(
        response,
        404,
        "ARTIFACT_NOT_FOUND",
        tokenHash,
        "unknown token",
      );
      return;
    }
    if (this.now() >= grant.expiresAtMs) {
      this.grants.delete(tokenHash);
      this.reject(
        response,
        410,
        "PUBLISH_TOKEN_EXPIRED",
        tokenHash,
        "expired token",
      );
      return;
    }

    let descriptor: number | undefined;
    try {
      const record = grant.artifactId
        ? this.ledger.getArtifact(grant.workspaceId, grant.artifactId)
        : undefined;
      if (
        grant.artifactId &&
        (!record || record.relativePath !== grant.relativePath)
      ) {
        throw new Error("ARTIFACT_NOT_FOUND: Artifact grant is stale.");
      }
      const absolutePath = record
        ? (await verifyArtifactRecord(grant.workspaceRoot, record)).absolutePath
        : resolveExistingWorkspacePath(
            grant.workspaceRoot,
            grant.relativePath,
            "file",
          ).absolutePath;
      if (record) assertPublishableSize(record);
      descriptor = openSync(
        absolutePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const info = fstatSync(descriptor);
      if (
        !info.isFile() ||
        info.size !== grant.expectedSize ||
        sha256Descriptor(descriptor, info.size) !== grant.expectedSha256
      ) {
        throw new Error(
          "ARTIFACT_NOT_FOUND: Artifact changed before publication.",
        );
      }

      response.status(200);
      response.setHeader("Content-Type", grant.mimeType);
      response.setHeader("Content-Length", String(grant.expectedSize));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "private, no-store, max-age=0");
      response.setHeader("Pragma", "no-cache");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; sandbox",
      );
      response.setHeader(
        "Content-Disposition",
        `${grant.previewType === "image" || grant.previewType === "audio" ? "inline" : "attachment"}; filename="${safeFilename(grant.relativePath)}"`,
      );

      const stream = createReadStream(absolutePath, {
        fd: descriptor,
        autoClose: true,
        start: 0,
      });
      descriptor = undefined;
      stream.once("error", () => {
        if (!response.headersSent) {
          response.status(500).json({ error: "ARTIFACT_NOT_FOUND" });
        } else {
          response.destroy();
        }
      });
      stream.pipe(response);
      this.audit({
        event: "artifact_accessed",
        artifactId: record?.artifactId,
        workspaceId: grant.workspaceId,
        relativePath: grant.relativePath,
        tokenHashPrefix: tokenHash.slice(0, 12),
        purpose: grant.purpose,
      });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      const reason = error instanceof Error ? error.message : String(error);
      this.reject(
        response,
        reason.startsWith("ARTIFACT_TOO_LARGE") ? 413 : 409,
        reason.split(":")[0] || "ARTIFACT_NOT_FOUND",
        tokenHash,
        reason,
      );
    }
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.grants.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [tokenHash, grant] of this.grants) {
      if (now >= grant.expiresAtMs) this.grants.delete(tokenHash);
    }
  }

  private reject(
    response: Response,
    status: number,
    code: string,
    tokenHash: string,
    reason: string,
  ): void {
    this.audit({
      event: "artifact_access_rejected",
      tokenHashPrefix: tokenHash.slice(0, 12),
      reason,
    });
    response.status(status).setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.json({ error: code });
  }

  private audit(event: ArtifactPublicationAudit): void {
    this.options.audit?.(event);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function assertPublishableSize(artifact: ArtifactRecord): void {
  const maximum =
    artifact.artifactType === "image"
      ? MAX_IMAGE_PUBLISH_BYTES
      : artifact.artifactType === "json" || artifact.artifactType === "text"
        ? MAX_TEXT_PUBLISH_BYTES
        : MAX_BINARY_PUBLISH_BYTES;
  if (artifact.size > maximum) {
    throw new Error(
      `ARTIFACT_TOO_LARGE: ${artifact.relativePath} exceeds its ${maximum}-byte publication limit.`,
    );
  }
}

function previewTypeFor(artifact: ArtifactRecord): ArtifactPreviewType {
  if (artifact.artifactType === "image") return "image";
  if (artifact.artifactType === "audio") return "audio";
  if (artifact.artifactType === "json") return "json";
  if (artifact.artifactType === "text") return "text";
  return "download";
}

function previewFormat(
  format: string,
  mimeType: string,
): {
  previewType: Extract<ArtifactPreviewType, "image" | "audio">;
  mimeType: string;
} {
  if (["PNG", "JPEG", "WEBP"].includes(format)) {
    return { previewType: "image", mimeType };
  }
  if (["WAV", "OGG"].includes(format)) {
    return { previewType: "audio", mimeType };
  }
  throw new Error(
    "PREVIEW_UNAVAILABLE: Only PNG, JPEG, WEBP, WAV, and OGG can be previewed in M1.",
  );
}

function assertPreviewSize(
  previewType: Extract<ArtifactPreviewType, "image" | "audio">,
  size: number,
): void {
  const maximum =
    previewType === "image"
      ? MAX_IMAGE_PUBLISH_BYTES
      : MAX_BINARY_PUBLISH_BYTES;
  if (size > maximum) {
    throw new Error(
      `ARTIFACT_TOO_LARGE: Preview exceeds its ${maximum}-byte limit.`,
    );
  }
}

function safeFilename(relativePath: string): string {
  return basename(relativePath).replace(/["\r\n\\]/g, "_");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sha256Descriptor(descriptor: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const read = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (read <= 0) break;
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  if (offset !== size) {
    throw new Error("ARTIFACT_NOT_FOUND: Artifact could not be read fully.");
  }
  return hash.digest("hex");
}

function assertSafePublicationBaseUrl(value: string): void {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    )
  ) {
    throw new Error(
      "Artifact publication requires HTTPS, except for loopback tests.",
    );
  }
}
