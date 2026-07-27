import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export type AdditionalRootAccess = "read_only" | "read_write";

export interface AdditionalRoot {
  path: string;
  access: AdditionalRootAccess;
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Fall through — if the path doesn't exist (e.g. writing a new file),
    // we still validate the unresolved path against roots.
    return resolve(path);
  }
}

export function isPathInsideAnyRoot(
  path: string,
  roots: string[],
): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  if (roots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return true;
  }
  // Also check the real path to catch junctions/symlinks that resolve
  // into an allowed root.
  try {
    const realPath = resolveRealPath(resolvedPath);
    if (realPath !== resolvedPath) {
      return roots.some((root) => isPathInsideRoot(realPath, root));
    }
  } catch {
    // Unresolvable — already rejected above.
  }
  return false;
}

export function assertAllowedPath(
  path: string,
  allowedRoots: string[],
): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (isPathInsideAnyRoot(resolvedPath, allowedRoots)) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function assertWriteAllowed(
  path: string,
  allowedRoots: string[],
  additionalRoots: AdditionalRoot[] = [],
): string {
  const resolvedPath = resolve(expandHomePath(path));

  // Check if path is in a read_write root.
  const allWriteRoots = [
    ...allowedRoots,
    ...additionalRoots
      .filter((r) => r.access === "read_write")
      .map((r) => r.path),
  ];

  if (isPathInsideAnyRoot(resolvedPath, allWriteRoots)) {
    return resolvedPath;
  }

  // Check if path is in a read_only additional root.
  const allReadRoots = [
    ...allowedRoots,
    ...additionalRoots.map((r) => r.path),
  ];

  if (isPathInsideAnyRoot(resolvedPath, allReadRoots)) {
    throw new AccessDeniedError(
      `Write denied: path is in a read-only additional root: ${path}`,
    );
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(
  inputPath: string,
  cwd: string,
  allowedRoots: string[],
): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

export function normalizeAdditionalRoots(
  raw: unknown,
): AdditionalRoot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: AdditionalRoot[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== "string" || !obj.path) return undefined;
    const access = obj.access;
    if (access !== "read_only" && access !== "read_write") return undefined;
    result.push({
      path: resolve(expandHomePath(obj.path)),
      access,
    });
  }
  return result;
}
