import {
  lstatSync,
  realpathSync,
  statSync,
  existsSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export type WorkspaceObjectKind = "file" | "directory";

export interface ResolvedWorkspacePath {
  relativePath: string;
  absolutePath: string;
  canonicalWorkspaceRoot: string;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw new Error(`PATH_INVALID: Invalid workspace-relative path: ${value}`);
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error(`PATH_INVALID: Invalid workspace-relative path: ${value}`);
  }
  return parts.join("/");
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  value: string,
): ResolvedWorkspacePath {
  const relativePath = normalizeWorkspaceRelativePath(value);
  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const absolutePath = resolve(canonicalWorkspaceRoot, relativePath);
  if (!isPathInsideRoot(absolutePath, canonicalWorkspaceRoot)) {
    throw new Error(`WORKSPACE_ESCAPE: Path leaves workspace: ${value}`);
  }
  const ancestor = nearestExistingPath(absolutePath);
  const canonicalAncestor = realpathSync(ancestor);
  if (!isPathInsideRoot(canonicalAncestor, canonicalWorkspaceRoot)) {
    throw new Error(`WORKSPACE_ESCAPE: Path resolves outside workspace: ${value}`);
  }
  assertNoSymlinkComponents(
    canonicalWorkspaceRoot,
    absolutePath,
    existsSync(absolutePath),
  );
  return { relativePath, absolutePath, canonicalWorkspaceRoot };
}

export function resolveExistingWorkspacePath(
  workspaceRoot: string,
  value: string,
  kind?: WorkspaceObjectKind,
): ResolvedWorkspacePath & { stats: Stats } {
  const resolved = resolveWorkspacePath(workspaceRoot, value);
  if (!existsSync(resolved.absolutePath)) {
    throw new Error(`PATH_NOT_FOUND: Path does not exist: ${value}`);
  }
  const info = lstatSync(resolved.absolutePath);
  if (info.isSymbolicLink()) {
    throw new Error(`WORKSPACE_ESCAPE: Symbolic links are not allowed: ${value}`);
  }
  const canonicalPath = realpathSync(resolved.absolutePath);
  if (!isPathInsideRoot(canonicalPath, resolved.canonicalWorkspaceRoot)) {
    throw new Error(`WORKSPACE_ESCAPE: Path resolves outside workspace: ${value}`);
  }
  const stats = statSync(canonicalPath);
  if (kind === "file" && !stats.isFile()) {
    throw new Error(`PATH_TYPE_REJECTED: Expected a regular file: ${value}`);
  }
  if (kind === "directory" && !stats.isDirectory()) {
    throw new Error(`PATH_TYPE_REJECTED: Expected a directory: ${value}`);
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`PATH_TYPE_REJECTED: Unsupported filesystem object: ${value}`);
  }
  return { ...resolved, absolutePath: canonicalPath, stats };
}

export function workspaceRelativeFromAbsolute(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const candidate = relative(workspaceRoot, absolutePath)
    .split("\\")
    .join("/");
  return normalizeWorkspaceRelativePath(candidate);
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertNoSymlinkComponents(
  canonicalRoot: string,
  target: string,
  includeTarget: boolean,
): void {
  const relationship = relative(canonicalRoot, target);
  if (
    relationship === "" ||
    relationship === "." ||
    relationship.startsWith("..")
  ) {
    if (relationship.startsWith("..")) {
      throw new Error("WORKSPACE_ESCAPE: Path leaves workspace.");
    }
    return;
  }
  const parts = relationship.split(/[\\/]/).filter(Boolean);
  let current = canonicalRoot;
  const count = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < count; index += 1) {
    current = resolve(current, parts[index]);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(
        `WORKSPACE_ESCAPE: Symbolic-link path component is not allowed: ${parts[index]}`,
      );
    }
  }
}
