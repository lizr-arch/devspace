import type { JobRunner, JobStatus } from "./background-jobs.js";

export const MAX_ARTIFACT_ROOTS = 8;
export const MAX_ARTIFACT_FILES_PER_JOB = 512;
export const MAX_ARTIFACT_DIRECTORIES_PER_JOB = 2_048;
export const MAX_HASHABLE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_LIST_ARTIFACTS = 100;
export const MAX_JSON_VALIDATION_BYTES = 4 * 1024 * 1024;

export type ArtifactType =
  | "blend"
  | "glb"
  | "houdini"
  | "geometry"
  | "scene"
  | "image"
  | "audio"
  | "json"
  | "text";
export type ArtifactChange = "created" | "modified";
export type ArtifactCompletion = "complete" | "incomplete";
export type ArtifactPresence =
  | "present"
  | "missing"
  | "superseded"
  | "unsafe"
  | "unverified";
export type ArtifactGitStatus = "tracked" | "untracked" | "ignored" | "unknown";

export interface ArtifactFileBaseline {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ArtifactBaseline {
  roots: string[];
  files: Record<string, ArtifactFileBaseline>;
}

export interface ArtifactRecord {
  artifactId: string;
  relativePath: string;
  artifactType: ArtifactType;
  mimeType: string;
  format: string;
  size: number;
  sha256: string;
  change: ArtifactChange;
  completion: ArtifactCompletion;
  jobId?: string;
  runner?: JobRunner;
  runnerVersion?: string;
  previousArtifactId?: string;
  origin:
    | {
        kind: "job";
        jobId: string;
        runner: JobRunner;
        runnerVersion?: string;
      }
    | {
        kind: "import";
        importId: string;
        source: "openai_file" | "https" | "base64";
        sourceHost?: string;
        sourceFileId?: string;
        sourceFileName?: string;
      };
  workspaceId: string;
  createdAt: string;
  gitStatus: ArtifactGitStatus;
}

export interface ListedArtifact extends ArtifactRecord {
  presence: ArtifactPresence;
}

export interface VerifiedArtifactFile {
  artifact: ListedArtifact;
  absolutePath: string;
}

export interface ArtifactDiscoveryResult {
  artifacts: ArtifactRecord[];
  errors: string[];
  completion: ArtifactCompletion;
}

export interface ArtifactJobContext {
  workspaceId: string;
  workspaceRoot: string;
  jobId: string;
  runner: JobRunner;
  runnerVersion?: string;
  status: JobStatus;
  artifactRoots: string[];
  baseline: ArtifactBaseline;
}

export interface ListArtifactsInput {
  workspaceId: string;
  workspaceRoot: string;
  jobId?: string;
  pathPrefix?: string;
  type?: ArtifactType;
  limit?: number;
}

export interface PersistedLedger {
  schemaVersion: 3;
  workspaceId: string;
  artifacts: ArtifactRecord[];
}

export interface ScannedArtifact {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export const ARTIFACT_FORMATS: Record<
  string,
  { artifactType: ArtifactType; mimeType: string; format: string }
> = {
  ".blend": {
    artifactType: "blend",
    mimeType: "application/x-blender",
    format: "BLEND",
  },
  ".glb": {
    artifactType: "glb",
    mimeType: "model/gltf-binary",
    format: "GLB",
  },
  ".hip": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HIP",
  },
  ".hiplc": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HIPLC",
  },
  ".hipnc": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HIPNC",
  },
  ".hda": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HDA",
  },
  ".hdalc": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HDALC",
  },
  ".hdanc": {
    artifactType: "houdini",
    mimeType: "application/octet-stream",
    format: "HDANC",
  },
  ".bgeo.sc": {
    artifactType: "geometry",
    mimeType: "application/octet-stream",
    format: "BGEO.SC",
  },
  ".abc": {
    artifactType: "geometry",
    mimeType: "application/vnd.abc",
    format: "ABC",
  },
  ".usd": {
    artifactType: "scene",
    mimeType: "model/vnd.usd",
    format: "USD",
  },
  ".usda": {
    artifactType: "scene",
    mimeType: "model/vnd.usd",
    format: "USDA",
  },
  ".usdc": {
    artifactType: "scene",
    mimeType: "model/vnd.usd",
    format: "USDC",
  },
  ".png": { artifactType: "image", mimeType: "image/png", format: "PNG" },
  ".jpg": { artifactType: "image", mimeType: "image/jpeg", format: "JPEG" },
  ".jpeg": { artifactType: "image", mimeType: "image/jpeg", format: "JPEG" },
  ".webp": { artifactType: "image", mimeType: "image/webp", format: "WEBP" },
  ".wav": { artifactType: "audio", mimeType: "audio/wav", format: "WAV" },
  ".ogg": { artifactType: "audio", mimeType: "audio/ogg", format: "OGG" },
  ".json": {
    artifactType: "json",
    mimeType: "application/json",
    format: "JSON",
  },
  ".txt": { artifactType: "text", mimeType: "text/plain", format: "TEXT" },
  ".log": { artifactType: "text", mimeType: "text/plain", format: "LOG" },
};
