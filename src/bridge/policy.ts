import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { expandHomePath } from "../roots.js";
import { loadDevspaceFiles } from "../user-config.js";

export const DEFAULT_MAX_FILES = 8;
export const DEFAULT_MAX_LINES_PER_FILE = 160;
export const DEFAULT_MAX_TOTAL_CHARACTERS = 24_000;

const DEFAULT_DENY_DIRECTORIES = new Set([
  ".git",
  ".trae",
  ".devspace",
  ".vscode",
  ".idea",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".cpp",
  ".cs",
  ".css",
  ".env.example",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mdx",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export interface CoachPackPolicy {
  allowedRoots: string[];
  maxFiles: number;
  maxLinesPerFile: number;
  maxTotalCharacters: number;
}

export interface OmittedEntry {
  path: string;
  reason: string;
}

interface IgnoreRule {
  matches(relativePath: string, isDirectory: boolean): boolean;
}

export function loadCoachPackPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CoachPackPolicy {
  return {
    allowedRoots: parseAllowedRoots(
      env.DEVSPACE_ALLOWED_ROOTS ?? loadDevspaceFiles(env).config.allowedRoots,
    ),
    maxFiles: DEFAULT_MAX_FILES,
    maxLinesPerFile: DEFAULT_MAX_LINES_PER_FILE,
    maxTotalCharacters: DEFAULT_MAX_TOTAL_CHARACTERS,
  };
}

export function isDeniedDirectoryName(name: string): boolean {
  return DEFAULT_DENY_DIRECTORIES.has(name);
}

export function createSensitiveOmission(
  relativePath: string,
): OmittedEntry | null {
  const fileName = basename(relativePath).toLowerCase();
  if (isEnvTemplateFile(fileName)) {
    return null;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return {
      path: "[redacted-sensitive-path]",
      reason: "Sensitive file matched but omitted (.env-family)",
    };
  }
  if (fileName.endsWith(".pem") || fileName.endsWith(".key")) {
    return {
      path: "[redacted-sensitive-path]",
      reason: "Sensitive file matched but omitted (key material)",
    };
  }
  if (
    fileName === "id_rsa" ||
    fileName.startsWith("secrets.") ||
    fileName.startsWith("credentials.") ||
    fileName.startsWith("token.")
  ) {
    return {
      path: "[redacted-sensitive-path]",
      reason: "Sensitive file matched but omitted (credential-like file)",
    };
  }

  return null;
}

export function isLikelyTextFile(path: string): boolean {
  const baseName = basename(path).toLowerCase();
  if (
    baseName === "agents.md" ||
    baseName === "readme.md" ||
    baseName === "package.json" ||
    isEnvTemplateFile(baseName)
  ) {
    return true;
  }

  const extension = extname(path).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(extension);
}

export function loadRepoIgnoreRules(repoRoot: string): IgnoreRule[] {
  const ignorePath = resolve(repoRoot, ".devspaceignore");
  if (!existsSync(ignorePath)) return [];

  return readFileSync(ignorePath, "utf-8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((pattern) => createIgnoreRule(pattern));
}

export function shouldIgnoreRepoPath(
  relativePath: string,
  isDirectory: boolean,
  ignoreRules: IgnoreRule[],
): boolean {
  return ignoreRules.some((rule) => rule.matches(relativePath, isDirectory));
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.length > 0 ? value : [process.cwd()];
    return roots.map((entry) => resolve(expandHomePath(entry)));
  }

  const entries =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = entries.length > 0 ? entries : [process.cwd()];
  return roots.map((entry) => resolve(expandHomePath(entry)));
}

function createIgnoreRule(pattern: string): IgnoreRule {
  const normalized = pattern.replaceAll("\\", "/");

  if (normalized.startsWith("*.")) {
    return {
      matches(relativePath) {
        return relativePath.toLowerCase().endsWith(normalized.slice(1).toLowerCase());
      },
    };
  }

  const directoryPrefix = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized.endsWith("/**")
      ? normalized.slice(0, -3)
      : null;

  if (directoryPrefix) {
    return {
      matches(relativePath, isDirectory) {
        if (!relativePath.startsWith(directoryPrefix)) return false;
        if (relativePath === directoryPrefix) return true;
        return isDirectory || relativePath.startsWith(`${directoryPrefix}/`);
      },
    };
  }

  const exactPath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  return {
    matches(relativePath) {
      return relativePath === exactPath || basename(relativePath) === exactPath;
    },
  };
}

function isEnvTemplateFile(fileName: string): boolean {
  return fileName === ".env.example" || (fileName.startsWith(".env.") && fileName.endsWith(".example"));
}
