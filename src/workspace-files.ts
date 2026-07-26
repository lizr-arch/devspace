import { randomUUID } from "node:crypto";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-paths.js";

export interface FileOperationSummary {
  sourcePath?: string;
  destinationPath?: string;
  kind: "file" | "directory";
  bytes: number;
  entries: number;
}

export interface TrashRecord extends FileOperationSummary {
  trashId: string;
  originalPath: string;
  movedAt: string;
}

interface TrashManifest extends TrashRecord {
  schemaVersion: 1;
  workspaceId: string;
  snapshot?: boolean;
}

export async function createWorkspaceDirectory(
  workspaceRoot: string,
  path: string,
): Promise<{ path: string; created: boolean }> {
  const destination = resolveWorkspacePath(workspaceRoot, path);
  try {
    const info = await lstat(destination.absolutePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `PATH_TYPE_REJECTED: Destination is not a real directory: ${path}`,
      );
    }
    return { path: destination.relativePath, created: false };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await mkdir(destination.absolutePath, { recursive: true });
  resolveExistingWorkspacePath(workspaceRoot, path, "directory");
  return { path: destination.relativePath, created: true };
}

export async function copyWorkspacePath(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}): Promise<FileOperationSummary & { displacedTrashId?: string }> {
  const source = resolveExistingWorkspacePath(
    input.workspaceRoot,
    input.sourcePath,
  );
  const destination = resolveWorkspacePath(
    input.workspaceRoot,
    input.destinationPath,
  );
  const summary = await summarizePath(source.absolutePath);
  const destinationExists = await pathExists(destination.absolutePath);
  let displacedTrashId: string | undefined;
  if (destinationExists) {
    const existing = await lstat(destination.absolutePath);
    if (existing.isSymbolicLink()) {
      throw new Error("WORKSPACE_ESCAPE: Refusing to replace a symbolic link.");
    }
    if (!input.overwrite) {
      throw new Error("PATH_EXISTS: Destination already exists.");
    }
    if (summary.kind === "directory" || !existing.isFile()) {
      throw new Error(
        "PATH_OVERWRITE_REJECTED: Directory merge or replacement is not supported.",
      );
    }
  }

  await assertTreeContainsNoSymlinks(source.absolutePath);
  await mkdir(dirname(destination.absolutePath), { recursive: true });
  const temporary = `${destination.absolutePath}.devspace-${randomUUID()}.tmp`;
  try {
    if (summary.kind === "directory") {
      await cp(source.absolutePath, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      await cp(source.absolutePath, temporary, {
        errorOnExist: true,
        force: false,
      });
    }
    if (destinationExists) {
      const trashed = await moveWorkspacePathToTrash({
        workspaceRoot: input.workspaceRoot,
        stateDir: input.stateDir,
        workspaceId: input.workspaceId,
        path: destination.relativePath,
      });
      displacedTrashId = trashed.trashId;
    }
    await rename(temporary, destination.absolutePath);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  return {
    ...summary,
    sourcePath: source.relativePath,
    destinationPath: destination.relativePath,
    displacedTrashId,
  };
}

export async function moveWorkspacePath(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}): Promise<FileOperationSummary & { displacedTrashId?: string }> {
  const source = resolveExistingWorkspacePath(
    input.workspaceRoot,
    input.sourcePath,
  );
  const destination = resolveWorkspacePath(
    input.workspaceRoot,
    input.destinationPath,
  );
  if (destination.absolutePath.startsWith(`${source.absolutePath}/`)) {
    throw new Error("PATH_INVALID: Cannot move a directory inside itself.");
  }
  const summary = await summarizePath(source.absolutePath);
  let displacedTrashId: string | undefined;
  if (await pathExists(destination.absolutePath)) {
    const existing = await lstat(destination.absolutePath);
    if (existing.isSymbolicLink()) {
      throw new Error("WORKSPACE_ESCAPE: Refusing to replace a symbolic link.");
    }
    if (!input.overwrite) {
      throw new Error("PATH_EXISTS: Destination already exists.");
    }
    if (summary.kind === "directory" || !existing.isFile()) {
      throw new Error(
        "PATH_OVERWRITE_REJECTED: Directory replacement is not supported.",
      );
    }
    const trashed = await moveWorkspacePathToTrash({
      workspaceRoot: input.workspaceRoot,
      stateDir: input.stateDir,
      workspaceId: input.workspaceId,
      path: destination.relativePath,
    });
    displacedTrashId = trashed.trashId;
  }
  await mkdir(dirname(destination.absolutePath), { recursive: true });
  try {
    await rename(source.absolutePath, destination.absolutePath);
  } catch (error) {
    if (isCrossDeviceError(error)) {
      throw new Error(
        "CROSS_DEVICE_MOVE_UNSUPPORTED: Move requires source and destination on the same filesystem.",
      );
    }
    throw error;
  }
  return {
    ...summary,
    sourcePath: source.relativePath,
    destinationPath: destination.relativePath,
    displacedTrashId,
  };
}

export async function moveWorkspacePathToTrash(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  path: string;
}): Promise<TrashRecord> {
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId)) {
    throw new Error("WORKSPACE_INVALID: Invalid workspaceId.");
  }
  const source = resolveExistingWorkspacePath(input.workspaceRoot, input.path);
  const summary = await summarizePath(source.absolutePath);
  const trashId = `trash_${randomUUID()}`;
  const trashRoot = join(input.stateDir, "trash", input.workspaceId, trashId);
  const payloadPath = join(trashRoot, "payload");
  const movedAt = new Date().toISOString();
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(trashRoot, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        trashId,
        workspaceId: input.workspaceId,
        originalPath: source.relativePath,
        movedAt,
        ...summary,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  try {
    await rename(source.absolutePath, payloadPath);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    await cp(source.absolutePath, payloadPath, {
      recursive: summary.kind === "directory",
      errorOnExist: true,
      force: false,
    });
    const copied = await summarizePath(payloadPath);
    if (
      copied.kind !== summary.kind ||
      copied.entries !== summary.entries ||
      copied.bytes !== summary.bytes
    ) {
      throw new Error(
        "PATH_COPY_VERIFY_FAILED: Trash quarantine copy did not verify.",
      );
    }
    await rm(source.absolutePath, {
      recursive: summary.kind === "directory",
      force: false,
    });
  }
  return {
    trashId,
    originalPath: source.relativePath,
    movedAt,
    ...summary,
  };
}

export async function snapshotWorkspaceFileToTrash(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  path: string;
}): Promise<TrashRecord> {
  validateWorkspaceId(input.workspaceId);
  const source = resolveExistingWorkspacePath(
    input.workspaceRoot,
    input.path,
    "file",
  );
  const summary = await summarizePath(source.absolutePath);
  const trashId = `trash_${randomUUID()}`;
  const trashRoot = join(input.stateDir, "trash", input.workspaceId, trashId);
  const payloadPath = join(trashRoot, "payload");
  const movedAt = new Date().toISOString();
  const manifest: TrashManifest = {
    schemaVersion: 1,
    trashId,
    workspaceId: input.workspaceId,
    originalPath: source.relativePath,
    movedAt,
    snapshot: true,
    ...summary,
  };
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(trashRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  try {
    await copyFile(source.absolutePath, payloadPath);
    const copied = await summarizePath(payloadPath);
    if (
      copied.kind !== "file" ||
      copied.entries !== summary.entries ||
      copied.bytes !== summary.bytes
    ) {
      throw new Error(
        "PATH_COPY_VERIFY_FAILED: Trash snapshot copy did not verify.",
      );
    }
  } catch (error) {
    await rm(trashRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  return {
    trashId,
    originalPath: source.relativePath,
    movedAt,
    ...summary,
  };
}

export async function restoreWorkspaceFileFromTrash(input: {
  workspaceRoot: string;
  stateDir: string;
  workspaceId: string;
  trashId: string;
  path: string;
}): Promise<void> {
  validateWorkspaceId(input.workspaceId);
  if (!/^trash_[0-9a-f-]{36}$/.test(input.trashId)) {
    throw new Error("PATH_INVALID: Invalid trashId.");
  }
  const destination = resolveWorkspacePath(input.workspaceRoot, input.path);
  const trashRoot = join(
    input.stateDir,
    "trash",
    input.workspaceId,
    input.trashId,
  );
  const manifest = JSON.parse(
    await readFile(join(trashRoot, "manifest.json"), "utf8"),
  ) as TrashManifest;
  if (
    manifest.workspaceId !== input.workspaceId ||
    manifest.trashId !== input.trashId ||
    manifest.originalPath !== destination.relativePath ||
    manifest.kind !== "file" ||
    manifest.snapshot !== true
  ) {
    throw new Error("PATH_TRASH_MISMATCH: Trash snapshot does not match.");
  }
  const payloadPath = join(trashRoot, "payload");
  const payload = await lstat(payloadPath);
  if (payload.isSymbolicLink() || !payload.isFile()) {
    throw new Error("PATH_TYPE_REJECTED: Trash snapshot is not a real file.");
  }
  try {
    const existing = await lstat(destination.absolutePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        "PATH_TYPE_REJECTED: Restore destination is not a real file.",
      );
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await mkdir(dirname(destination.absolutePath), { recursive: true });
  const temporary = `${destination.absolutePath}.devspace-${randomUUID()}.restore`;
  try {
    await copyFile(payloadPath, temporary);
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination.absolutePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function summarizePath(
  path: string,
): Promise<Pick<FileOperationSummary, "kind" | "bytes" | "entries">> {
  const info = await stat(path);
  if (info.isFile()) return { kind: "file", bytes: info.size, entries: 1 };
  if (!info.isDirectory()) {
    throw new Error("PATH_TYPE_REJECTED: Unsupported filesystem object.");
  }
  let bytes = 0;
  let entries = 1;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const children = await import("node:fs/promises").then(({ readdir }) =>
      readdir(current, { withFileTypes: true }),
    );
    for (const child of children) {
      entries += 1;
      const childPath = join(current, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(
          "WORKSPACE_ESCAPE: Directory tree contains a symbolic link.",
        );
      }
      if (child.isDirectory()) pending.push(childPath);
      else if (child.isFile()) bytes += (await stat(childPath)).size;
      else
        throw new Error("PATH_TYPE_REJECTED: Unsupported filesystem object.");
    }
  }
  return { kind: "directory", bytes, entries };
}

async function assertTreeContainsNoSymlinks(path: string): Promise<void> {
  await summarizePath(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new Error("WORKSPACE_INVALID: Invalid workspaceId.");
  }
}

function isCrossDeviceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EXDEV"
  );
}
