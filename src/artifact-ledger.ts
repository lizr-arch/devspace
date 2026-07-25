import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { JobRunner, JobStatus } from "./background-jobs.js";
import { isPathInsideRoot } from "./roots.js";

export const MAX_ARTIFACT_ROOTS = 8;
export const MAX_ARTIFACT_FILES_PER_JOB = 512;
export const MAX_ARTIFACT_DIRECTORIES_PER_JOB = 2_048;
export const MAX_HASHABLE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_LIST_ARTIFACTS = 100;
const MAX_JSON_VALIDATION_BYTES = 4 * 1024 * 1024;

export type ArtifactType = "blend" | "glb" | "image" | "json" | "text";
export type ArtifactChange = "created" | "modified";
export type ArtifactCompletion = "complete" | "incomplete";
export type ArtifactPresence =
  "present" | "missing" | "superseded" | "unsafe" | "unverified";
export type ArtifactGitStatus = "tracked" | "untracked" | "ignored" | "unknown";

interface ArtifactFileBaseline {
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
  jobId: string;
  runner: JobRunner;
  runnerVersion?: string;
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

interface PersistedLedger {
  schemaVersion: 1;
  workspaceId: string;
  artifacts: ArtifactRecord[];
}

interface ScannedArtifact {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const ARTIFACT_FORMATS: Record<
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
  ".png": { artifactType: "image", mimeType: "image/png", format: "PNG" },
  ".jpg": { artifactType: "image", mimeType: "image/jpeg", format: "JPEG" },
  ".jpeg": { artifactType: "image", mimeType: "image/jpeg", format: "JPEG" },
  ".webp": { artifactType: "image", mimeType: "image/webp", format: "WEBP" },
  ".json": {
    artifactType: "json",
    mimeType: "application/json",
    format: "JSON",
  },
  ".txt": { artifactType: "text", mimeType: "text/plain", format: "TEXT" },
  ".log": { artifactType: "text", mimeType: "text/plain", format: "LOG" },
};

export class ArtifactLedger {
  private readonly artifactsDir: string;

  constructor(private readonly stateDir: string) {
    this.artifactsDir = join(stateDir, "artifacts");
    mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.artifactsDir, 0o700);
  }

  captureBaseline(
    workspaceRoot: string,
    artifactRoots: string[],
  ): ArtifactBaseline {
    const roots = validateArtifactRoots(workspaceRoot, artifactRoots);
    const files = scanArtifactRoots(workspaceRoot, roots);
    return {
      roots,
      files: Object.fromEntries(
        files.map((file) => [
          file.relativePath,
          {
            size: file.size,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs,
          },
        ]),
      ),
    };
  }

  async discoverArtifacts(
    context: ArtifactJobContext,
  ): Promise<ArtifactDiscoveryResult> {
    const roots = validateArtifactRoots(
      context.workspaceRoot,
      context.artifactRoots,
    );
    const scanned = scanArtifactRoots(context.workspaceRoot, roots);
    const changed = scanned.filter((file) => {
      const before = context.baseline.files[file.relativePath];
      return (
        !before ||
        before.size !== file.size ||
        before.mtimeMs !== file.mtimeMs ||
        before.ctimeMs !== file.ctimeMs
      );
    });
    const completion: ArtifactCompletion =
      context.status === "succeeded" ? "complete" : "incomplete";
    const artifacts: ArtifactRecord[] = [];
    const errors: string[] = [];

    for (const file of changed) {
      try {
        const format = artifactFormat(file.relativePath);
        if (!format) continue;
        if (file.size > MAX_HASHABLE_ARTIFACT_BYTES) {
          throw new Error(
            `ARTIFACT_TOO_LARGE: ${file.relativePath} exceeds ${MAX_HASHABLE_ARTIFACT_BYTES} bytes.`,
          );
        }
        assertArtifactFileSafe(
          context.workspaceRoot,
          file.absolutePath,
          file.relativePath,
        );
        validateArtifactSignature(file.absolutePath, format.format, file.size);
        const sha256 = await sha256File(file.absolutePath);
        artifacts.push({
          artifactId: `artifact_${randomUUID()}`,
          relativePath: file.relativePath,
          artifactType: format.artifactType,
          mimeType: format.mimeType,
          format: format.format,
          size: file.size,
          sha256,
          change: context.baseline.files[file.relativePath]
            ? "modified"
            : "created",
          completion,
          jobId: context.jobId,
          runner: context.runner,
          runnerVersion: context.runnerVersion,
          workspaceId: context.workspaceId,
          createdAt: new Date().toISOString(),
          gitStatus: inspectGitStatus(context.workspaceRoot, file.relativePath),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    this.appendRecords(context.workspaceId, artifacts);
    return { artifacts, errors, completion };
  }

  async listArtifacts(input: ListArtifactsInput): Promise<ListedArtifact[]> {
    validateWorkspaceId(input.workspaceId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_ARTIFACTS) {
      throw new Error(`limit must be between 1 and ${MAX_LIST_ARTIFACTS}.`);
    }
    const pathPrefix =
      input.pathPrefix === undefined
        ? undefined
        : normalizeRelativePath(input.pathPrefix);
    const ledger = this.readLedger(input.workspaceId);
    const selected = [...ledger.artifacts]
      .reverse()
      .filter((artifact) =>
        input.jobId ? artifact.jobId === input.jobId : true,
      )
      .filter((artifact) =>
        pathPrefix ? artifact.relativePath.startsWith(pathPrefix) : true,
      )
      .filter((artifact) =>
        input.type ? artifact.artifactType === input.type : true,
      )
      .slice(0, limit);

    const output: ListedArtifact[] = [];
    for (const artifact of selected) {
      output.push({
        ...artifact,
        presence: await inspectPresence(input.workspaceRoot, artifact),
      });
    }
    return output;
  }

  getArtifact(
    workspaceId: string,
    artifactId: string,
  ): ArtifactRecord | undefined {
    validateWorkspaceId(workspaceId);
    if (!/^artifact_[0-9a-f-]{36}$/.test(artifactId)) {
      throw new Error("Invalid artifactId.");
    }
    return this.readLedger(workspaceId).artifacts.find(
      (artifact) => artifact.artifactId === artifactId,
    );
  }

  async resolveArtifact(input: {
    workspaceId: string;
    workspaceRoot: string;
    artifactId?: string;
    path?: string;
  }): Promise<VerifiedArtifactFile> {
    if (Boolean(input.artifactId) === Boolean(input.path)) {
      throw new Error(
        "Provide exactly one of artifactId or path when resolving an artifact.",
      );
    }
    validateWorkspaceId(input.workspaceId);
    const ledger = this.readLedger(input.workspaceId);
    let record: ArtifactRecord | undefined;
    if (input.artifactId) {
      if (!/^artifact_[0-9a-f-]{36}$/.test(input.artifactId)) {
        throw new Error("Invalid artifactId.");
      }
      record = ledger.artifacts.find(
        (artifact) => artifact.artifactId === input.artifactId,
      );
    } else {
      const path = normalizeRelativePath(input.path ?? "");
      record = [...ledger.artifacts]
        .reverse()
        .find((artifact) => artifact.relativePath === path);
    }
    if (!record) {
      throw new Error("ARTIFACT_NOT_FOUND: Artifact is not registered.");
    }
    return verifyArtifactRecord(input.workspaceRoot, record);
  }

  private appendRecords(
    workspaceId: string,
    artifacts: ArtifactRecord[],
  ): void {
    if (artifacts.length === 0) return;
    validateWorkspaceId(workspaceId);
    const ledger = this.readLedger(workspaceId);
    const existing = new Set(
      ledger.artifacts.map(
        (artifact) =>
          `${artifact.jobId}\0${artifact.relativePath}\0${artifact.sha256}`,
      ),
    );
    for (const artifact of artifacts) {
      const key = `${artifact.jobId}\0${artifact.relativePath}\0${artifact.sha256}`;
      if (!existing.has(key)) {
        ledger.artifacts.push(artifact);
        existing.add(key);
      }
    }
    this.writeLedger(ledger);
  }

  private readLedger(workspaceId: string): PersistedLedger {
    validateWorkspaceId(workspaceId);
    const path = this.ledgerPath(workspaceId);
    if (!existsSync(path)) {
      return { schemaVersion: 1, workspaceId, artifacts: [] };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedLedger;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.workspaceId !== workspaceId ||
      !Array.isArray(parsed.artifacts)
    ) {
      throw new Error("Artifact ledger is malformed.");
    }
    return parsed;
  }

  private writeLedger(ledger: PersistedLedger): void {
    const workspaceDir = dirname(this.ledgerPath(ledger.workspaceId));
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    chmodSync(workspaceDir, 0o700);
    const target = this.ledgerPath(ledger.workspaceId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(ledger, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, target);
  }

  private ledgerPath(workspaceId: string): string {
    return join(this.artifactsDir, workspaceId, "ledger.json");
  }
}

export function validateArtifactRoots(
  workspaceRoot: string,
  artifactRoots: string[],
): string[] {
  if (
    !Array.isArray(artifactRoots) ||
    artifactRoots.length < 1 ||
    artifactRoots.length > MAX_ARTIFACT_ROOTS
  ) {
    throw new Error(
      `artifactRoots must contain between 1 and ${MAX_ARTIFACT_ROOTS} workspace-relative directories.`,
    );
  }
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const normalized = Array.from(
    new Set(artifactRoots.map(normalizeRelativePath)),
  );
  for (const root of normalized) {
    const target = resolve(workspaceRoot, root);
    const ancestor = nearestExistingPath(target);
    const canonicalAncestor = realpathSync(ancestor);
    if (!isPathInsideRoot(canonicalAncestor, canonicalWorkspace)) {
      throw new Error(
        `WORKSPACE_ESCAPE: Artifact root escapes the workspace: ${root}`,
      );
    }
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(
          `WORKSPACE_ESCAPE: Artifact root is not a real directory: ${root}`,
        );
      }
      const canonicalTarget = realpathSync(target);
      if (!isPathInsideRoot(canonicalTarget, canonicalWorkspace)) {
        throw new Error(
          `WORKSPACE_ESCAPE: Artifact root escapes the workspace: ${root}`,
        );
      }
    }
  }
  return normalized;
}

function scanArtifactRoots(
  workspaceRoot: string,
  roots: string[],
): ScannedArtifact[] {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const files = new Map<string, ScannedArtifact>();
  let visitedDirectories = 0;
  let visitedFiles = 0;

  for (const root of roots) {
    const absoluteRoot = resolve(workspaceRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    const pending = [absoluteRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      visitedDirectories += 1;
      if (visitedDirectories > MAX_ARTIFACT_DIRECTORIES_PER_JOB) {
        throw new Error(
          `Artifact scan exceeded ${MAX_ARTIFACT_DIRECTORIES_PER_JOB} directories.`,
        );
      }
      const canonicalDirectory = realpathSync(directory);
      if (!isPathInsideRoot(canonicalDirectory, canonicalWorkspace)) {
        throw new Error("WORKSPACE_ESCAPE: Artifact scan left the workspace.");
      }
      const handle = opendirSync(directory);
      try {
        for (
          let entry = handle.readSync();
          entry !== null;
          entry = handle.readSync()
        ) {
          const absolutePath = join(directory, entry.name);
          const info = lstatSync(absolutePath);
          if (info.isSymbolicLink()) {
            throw new Error(
              `WORKSPACE_ESCAPE: Artifact scan encountered a symbolic link: ${normalizeWorkspaceRelative(workspaceRoot, absolutePath)}`,
            );
          }
          if (info.isDirectory()) {
            pending.push(absolutePath);
            continue;
          }
          if (!info.isFile()) continue;
          visitedFiles += 1;
          if (visitedFiles > MAX_ARTIFACT_FILES_PER_JOB) {
            throw new Error(
              `Artifact scan exceeded ${MAX_ARTIFACT_FILES_PER_JOB} files.`,
            );
          }
          const relativePath = normalizeWorkspaceRelative(
            workspaceRoot,
            absolutePath,
          );
          if (!artifactFormat(relativePath)) continue;
          files.set(relativePath, {
            relativePath,
            absolutePath,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
          });
        }
      } finally {
        handle.closeSync();
      }
    }
  }
  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw new Error(`Invalid workspace-relative path: ${String(value)}`);
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error(`Invalid workspace-relative path: ${value}`);
  }
  return parts.join("/");
}

function normalizeWorkspaceRelative(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const value = relative(workspaceRoot, absolutePath).split("\\").join("/");
  return normalizeRelativePath(value);
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function artifactFormat(
  relativePath: string,
):
  { artifactType: ArtifactType; mimeType: string; format: string } | undefined {
  return ARTIFACT_FORMATS[extname(relativePath).toLowerCase()];
}

function assertArtifactFileSafe(
  workspaceRoot: string,
  absolutePath: string,
  relativePath: string,
): void {
  const info = lstatSync(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `WORKSPACE_ESCAPE: Artifact is not a regular file: ${relativePath}`,
    );
  }
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const canonicalFile = realpathSync(absolutePath);
  if (!isPathInsideRoot(canonicalFile, canonicalWorkspace)) {
    throw new Error(
      `WORKSPACE_ESCAPE: Artifact is outside the workspace: ${relativePath}`,
    );
  }
}

function validateArtifactSignature(
  absolutePath: string,
  format: string,
  size: number,
): void {
  const header = Buffer.alloc(16);
  const descriptor = openSync(absolutePath, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (format === "PNG" && !header.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not PNG.`,
    );
  }
  if (format === "GLB" && header.subarray(0, 4).toString("ascii") !== "glTF") {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not GLB.`,
    );
  }
  if (
    format === "BLEND" &&
    header.subarray(0, 7).toString("ascii") !== "BLENDER"
  ) {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not BLEND.`,
    );
  }
  if (
    format === "JPEG" &&
    !(header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
  ) {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not JPEG.`,
    );
  }
  if (
    format === "WEBP" &&
    !(
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    )
  ) {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not WEBP.`,
    );
  }
  if (format === "JSON") {
    if (size > MAX_JSON_VALIDATION_BYTES) {
      throw new Error(
        `ARTIFACT_TOO_LARGE: JSON artifact exceeds ${MAX_JSON_VALIDATION_BYTES} bytes.`,
      );
    }
    try {
      JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch {
      throw new Error(
        `ARTIFACT_MIME_REJECTED: ${basename(absolutePath)} is not valid JSON.`,
      );
    }
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function inspectGitStatus(
  workspaceRoot: string,
  relativePath: string,
): ArtifactGitStatus {
  const tracked = spawnSync(
    "git",
    ["-C", workspaceRoot, "ls-files", "--error-unmatch", "--", relativePath],
    { shell: false, stdio: "ignore", timeout: 5_000 },
  );
  if (tracked.status === 0) return "tracked";
  const ignored = spawnSync(
    "git",
    ["-C", workspaceRoot, "check-ignore", "-q", "--", relativePath],
    { shell: false, stdio: "ignore", timeout: 5_000 },
  );
  if (ignored.status === 0) return "ignored";
  if (tracked.error || ignored.error) return "unknown";
  return "untracked";
}

async function inspectPresence(
  workspaceRoot: string,
  artifact: ArtifactRecord,
): Promise<ArtifactPresence> {
  try {
    const absolutePath = resolve(workspaceRoot, artifact.relativePath);
    if (!existsSync(absolutePath)) return "missing";
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) return "unsafe";
    const canonicalWorkspace = realpathSync(workspaceRoot);
    const canonicalFile = realpathSync(absolutePath);
    if (!isPathInsideRoot(canonicalFile, canonicalWorkspace)) return "unsafe";
    if (info.size !== artifact.size) return "superseded";
    if (info.size > MAX_HASHABLE_ARTIFACT_BYTES) return "unverified";
    return (await sha256File(absolutePath)) === artifact.sha256
      ? "present"
      : "superseded";
  } catch {
    return "unsafe";
  }
}

export async function verifyArtifactRecord(
  workspaceRoot: string,
  artifact: ArtifactRecord,
): Promise<VerifiedArtifactFile> {
  const absolutePath = resolve(workspaceRoot, artifact.relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(
      `ARTIFACT_NOT_FOUND: Registered artifact is missing: ${artifact.relativePath}`,
    );
  }
  assertArtifactFileSafe(workspaceRoot, absolutePath, artifact.relativePath);
  const info = statSync(absolutePath);
  if (info.size > MAX_HASHABLE_ARTIFACT_BYTES) {
    throw new Error(
      `ARTIFACT_TOO_LARGE: ${artifact.relativePath} exceeds ${MAX_HASHABLE_ARTIFACT_BYTES} bytes.`,
    );
  }
  const format = artifactFormat(artifact.relativePath);
  if (
    !format ||
    format.artifactType !== artifact.artifactType ||
    format.mimeType !== artifact.mimeType ||
    format.format !== artifact.format
  ) {
    throw new Error(
      `ARTIFACT_MIME_REJECTED: Artifact metadata no longer matches ${artifact.relativePath}.`,
    );
  }
  validateArtifactSignature(absolutePath, artifact.format, info.size);
  const sha256 = await sha256File(absolutePath);
  if (info.size !== artifact.size || sha256 !== artifact.sha256) {
    throw new Error(
      `ARTIFACT_NOT_FOUND: Registered artifact version has been superseded: ${artifact.relativePath}`,
    );
  }
  return {
    artifact: { ...artifact, presence: "present" },
    absolutePath,
  };
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new Error("Invalid workspaceId.");
  }
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
