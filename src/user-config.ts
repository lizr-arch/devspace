import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface DevspaceUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  toolMode?: "minimal" | "full";
  widgets?: "off" | "changes" | "review_only" | "full";
  mcpTransportMode?: "stateful" | "stateless";
  mcpSessions?: {
    idleTtlSeconds?: number;
    maxSessions?: number;
    sweepIntervalSeconds?: number;
  };
  trustProxy?: boolean;
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  runners?: Record<
    string,
    {
      executable?: string;
      enabled?: boolean;
      maxTimeoutSeconds?: number;
      maxConcurrent?: number;
    }
  >;
  taskExecution?: {
    operatorPythonExecutable?: string;
  };
  projectMemory?: {
    repositories?: Array<{
      root: string;
      command: string[];
      mode: "SHADOW";
      timeoutMs?: number;
      maxOutputBytes?: number;
    }>;
  };
  gitRemoteWrite?: {
    enabled?: boolean;
    approvedRemotes?: string[];
    approvedDestinationBranches?: string[];
    /**
     * Scoped, optionally expiring and revocable grants that add to the static
     * destination-branch list. This is the only way to authorize a protected
     * default branch such as main.
     */
    branchAuthorizations?: Array<{
      branch: string;
      repositoryRoot: string;
      grantedAt: string;
      expiresAt?: string;
      grantedBy?: string;
      note?: string;
      revokedAt?: string;
    }>;
    approvedRepositoryRoots?: string[];
    approvedRemoteUrls?: Record<string, string[]>;
    allowForce?: boolean;
    requireCleanWorkspace?: boolean;
    requireExpectedRemoteSha?: boolean;
    requireFastForward?: boolean;
  };
  godotImport?: {
    enabled?: boolean;
    approvedProjectRoots?: string[];
    defaultTimeoutSeconds?: number;
    maxTimeoutSeconds?: number;
  };
  worktreeCleanup?: {
    /** Exact branch names that `git_delete_merged_branch` must never remove. */
    protectedBranches?: string[];
    /** Branch patterns such as `feat/terrain-*` that stay protected. */
    protectedBranchPatterns?: string[];
    /** Worktree directory basenames excluded from reclamation candidates. */
    protectedWorktreePatterns?: string[];
    /** Refs that count as the official mainline for merge proof. */
    mainlineRefs?: string[];
    /** Require reclamation candidates to have no foreign process inside them. */
    requireNoForeignProcess?: boolean;
    /** Hard bound on the read-only process probe, in milliseconds. */
    processProbeTimeoutMs?: number;
  };
}

export interface DevspaceAuthConfig {
  ownerToken?: string;
}

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
}

export function devspaceConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")),
  );
}

export function devspaceConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function loadDevspaceFiles(
  env: NodeJS.ProcessEnv = process.env,
): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<DevspaceUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<DevspaceAuthConfig>(authPath) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceConfigPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
