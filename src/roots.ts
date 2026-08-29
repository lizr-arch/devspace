import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export type AdditionalRootAccess = "inherit" | "read_only" | "read_write";
export type EffectiveRootAccess = Exclude<AdditionalRootAccess, "inherit">;

export interface AdditionalRoot {
  path: string;
  access: AdditionalRootAccess;
}

export interface EffectiveAdditionalRoot {
  path: string;
  access: EffectiveRootAccess;
}

export function effectiveAdditionalRootAccess(
  access: AdditionalRootAccess,
  workspaceWritable: boolean,
): EffectiveRootAccess {
  if (!workspaceWritable) return "read_only";
  return access === "read_only" ? "read_only" : "read_write";
}

export function normalizeCrossPlatformPath(path: string): string {
  let normalized = path.split("\\").join("/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = normalizeCrossPlatformPath(resolve(expandHomePath(path)));
  const resolvedRoot = normalizeCrossPlatformPath(resolve(expandHomePath(root)));
  const relationship = relative(resolvedRoot, resolvedPath)
    .split("\\")
    .join("/");

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes("../"))
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

// Roots are often supplied via symlinks (macOS: /var/folders -> /private/var/folders),
// while resolved paths may already be canonical. Cache canonical root forms so
// comparisons never fail due to symlinked root vs canonical path mismatch.
const canonicalRootCache = new Map<string, string>();

export function canonicalRootPath(root: string): string {
  const cacheKey = resolve(expandHomePath(root));
  const cached = canonicalRootCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let canonical = cacheKey;
  try {
    canonical = resolve(realpathSync.native(cacheKey));
  } catch {
    // Nonexistent root — keep the resolved form.
  }
  canonicalRootCache.set(cacheKey, canonical);
  return canonical;
}

export function isPathInsideAnyRoot(path: string, roots: string[]): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const realPath = resolveRealPath(resolvedPath);
  const pathVariants =
    realPath === resolvedPath ? [resolvedPath] : [resolvedPath, realPath];
  return roots.some((root) => {
    const rootVariants = [
      resolve(expandHomePath(root)),
      canonicalRootPath(root),
    ];
    for (const pathVariant of pathVariants) {
      for (const rootVariant of rootVariants) {
        if (isPathInsideRoot(pathVariant, rootVariant)) {
          return true;
        }
      }
    }
    return false;
  });
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
  const allReadRoots = [...allowedRoots, ...additionalRoots.map((r) => r.path)];

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
    const access = obj.access ?? "inherit";
    if (
      access !== "inherit" &&
      access !== "read_only" &&
      access !== "read_write"
    ) {
      return undefined;
    }
    result.push({
      path: resolve(expandHomePath(obj.path)),
      access,
    });
  }
  return result;
}
