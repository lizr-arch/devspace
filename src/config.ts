import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import {
  DEFAULT_MAX_MCP_SESSIONS,
  DEFAULT_MCP_SESSION_IDLE_TTL_MS,
  DEFAULT_MCP_SESSION_SWEEP_INTERVAL_MS,
} from "./mcp-session-registry.js";
import type { McpTransportMode } from "./mcp-session-registry.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { loadDevspaceFiles } from "./user-config.js";
import type { RunnerRegistryConfig } from "./runner-registry.js";

export type ToolNamingMode = "legacy" | "short";
export type WidgetMode = "off" | "changes" | "review_only" | "full";
export interface ProjectMemoryRepositoryConfig {
  root: string;
  command: [string, ...string[]];
  mode: "SHADOW";
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProjectMemoryConfig {
  repositories: ProjectMemoryRepositoryConfig[];
}
export interface GitRemoteWritePolicy {
  enabled: boolean;
  approvedRemotes: string[];
  approvedDestinationBranches: string[];
  approvedRepositoryRoots: string[];
  approvedRemoteUrls: Record<string, string[]>;
  allowForce: false;
  requireCleanWorkspace: true;
  requireExpectedRemoteSha: true;
  requireFastForward: true;
}
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  readOnly: boolean;
  toolNaming: ToolNamingMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  logging: LoggingConfig;
  mcpTransportMode: McpTransportMode;
  mcpSessionIdleTtlMs: number;
  mcpSessionMaxSessions: number;
  mcpSessionSweepIntervalMs: number;
  projectMemory: ProjectMemoryConfig;
  runners: RunnerRegistryConfig;
  gitRemoteWrite: GitRemoteWritePolicy;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) =>
      resolve(expandHomePath(root)),
    );
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(
  value: string | string[] | undefined,
  derivedHosts: string[],
): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(
  rawHosts: string[],
  derivedHosts: string[],
): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(
  env: NodeJS.ProcessEnv,
  configuredMode?: "minimal" | "full",
): boolean {
  if (env.DEVSPACE_TOOL_MODE === "minimal") return true;
  if (env.DEVSPACE_TOOL_MODE === "full") return false;
  if (env.DEVSPACE_TOOL_MODE) {
    throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${env.DEVSPACE_TOOL_MODE}`);
  }
  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined)
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS);
  if (configuredMode === "minimal") return true;
  if (configuredMode === "full") return false;
  return true;
}

function parseReadOnly(env: NodeJS.ProcessEnv): boolean {
  return parseBoolean(env.DEVSPACE_READ_ONLY);
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value))
    return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHomePath(entry))) ?? []
  );
}

function parseStringList(
  value: string | undefined,
  fallback: string[],
): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseMcpSessionConfig(
  env: NodeJS.ProcessEnv,
  configured:
    | {
        idleTtlSeconds?: number;
        maxSessions?: number;
        sweepIntervalSeconds?: number;
      }
    | undefined,
): {
  idleTtlMs: number;
  maxSessions: number;
  sweepIntervalMs: number;
} {
  const idleTtlSeconds = parseBoundedInteger(
    env.DEVSPACE_MCP_SESSION_IDLE_TTL_SECONDS
      ? Number(env.DEVSPACE_MCP_SESSION_IDLE_TTL_SECONDS)
      : configured?.idleTtlSeconds,
    DEFAULT_MCP_SESSION_IDLE_TTL_MS / 1000,
    30,
    3600,
    "MCP session idle TTL seconds",
  );
  const maxSessions = parseBoundedInteger(
    env.DEVSPACE_MCP_SESSION_MAX_SESSIONS
      ? Number(env.DEVSPACE_MCP_SESSION_MAX_SESSIONS)
      : configured?.maxSessions,
    DEFAULT_MAX_MCP_SESSIONS,
    8,
    1024,
    "MCP session max sessions",
  );
  const sweepIntervalSeconds = parseBoundedInteger(
    env.DEVSPACE_MCP_SESSION_SWEEP_INTERVAL_SECONDS
      ? Number(env.DEVSPACE_MCP_SESSION_SWEEP_INTERVAL_SECONDS)
      : configured?.sweepIntervalSeconds,
    DEFAULT_MCP_SESSION_SWEEP_INTERVAL_MS / 1000,
    5,
    300,
    "MCP session sweep interval seconds",
  );
  if (sweepIntervalSeconds > idleTtlSeconds) {
    throw new Error(
      "MCP session sweep interval seconds must not exceed the idle TTL.",
    );
  }

  return {
    idleTtlMs: idleTtlSeconds * 1000,
    maxSessions,
    sweepIntervalMs: sweepIntervalSeconds * 1000,
  };
}

function parseMcpTransportMode(value: string | undefined): McpTransportMode {
  if (!value || value === "stateless") return "stateless";
  if (value === "stateful") return "stateful";
  throw new Error(`Invalid DEVSPACE_MCP_TRANSPORT_MODE: ${value}`);
}

function parseToolNaming(value: string | undefined): ToolNamingMode {
  if (!value || value === "short") return "short";
  if (value === "legacy") return "legacy";

  throw new Error(`Invalid DEVSPACE_TOOL_NAMING: ${value}`);
}

function parseLoggingConfig(
  env: NodeJS.ProcessEnv,
  configuredTrustProxy = false,
): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests:
      env.DEVSPACE_LOG_REQUESTS === undefined
        ? true
        : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls:
      env.DEVSPACE_LOG_TOOL_CALLS === undefined
        ? true
        : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy:
      env.DEVSPACE_TRUST_PROXY === undefined
        ? configuredTrustProxy
        : parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseProjectMemoryConfig(
  value: DevspaceUserConfigProjectMemory | undefined,
  allowedRoots: string[],
): ProjectMemoryConfig {
  const repositories = value?.repositories ?? [];
  if (!Array.isArray(repositories)) {
    throw new Error("Invalid projectMemory.repositories: expected an array");
  }

  const seenRoots = new Set<string>();
  return {
    repositories: repositories.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Invalid projectMemory repository at index ${index}`);
      }
      const root = resolve(expandHomePath(entry.root));
      if (
        !allowedRoots.some((allowedRoot) => isPathInsideRoot(root, allowedRoot))
      ) {
        throw new Error(
          `Project Memory root is outside allowed roots: ${root}`,
        );
      }
      const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
      if (seenRoots.has(rootKey)) {
        throw new Error(`Duplicate Project Memory root: ${root}`);
      }
      seenRoots.add(rootKey);

      if (!Array.isArray(entry.command) || entry.command.length === 0) {
        throw new Error(`Project Memory command is required for ${root}`);
      }
      const command = entry.command.map((part) => {
        if (typeof part !== "string" || !part.trim() || part.includes("\0")) {
          throw new Error(`Invalid Project Memory command for ${root}`);
        }
        return part;
      }) as [string, ...string[]];
      const executable = basename(command[0]).toLowerCase();
      const expectedArgs = [
        "proxy",
        "py",
        "-3.11",
        "scripts/manage_project_memory.py",
      ];
      if (
        !["rtk", "rtk.exe"].includes(executable) ||
        command.length !== expectedArgs.length + 1 ||
        expectedArgs.some((part, partIndex) => command[partIndex + 1] !== part)
      ) {
        throw new Error(
          `Project Memory command must be rtk proxy py -3.11 scripts/manage_project_memory.py for ${root}`,
        );
      }
      if (entry.mode !== "SHADOW") {
        throw new Error(`Project Memory mode must be SHADOW for ${root}`);
      }

      return {
        root,
        command,
        mode: "SHADOW",
        timeoutMs: parseBoundedInteger(
          entry.timeoutMs,
          30_000,
          1_000,
          120_000,
          `projectMemory.repositories[${index}].timeoutMs`,
        ),
        maxOutputBytes: parseBoundedInteger(
          entry.maxOutputBytes,
          1_048_576,
          16_384,
          4_194_304,
          `projectMemory.repositories[${index}].maxOutputBytes`,
        ),
      };
    }),
  };
}

function parseGitRemoteWritePolicy(
  env: NodeJS.ProcessEnv,
  value: DevspaceUserConfigGitRemoteWrite | undefined,
  allowedRoots: string[],
): GitRemoteWritePolicy {
  const enabled =
    env.DEVSPACE_GIT_REMOTE_WRITE_ENABLED === undefined
      ? value?.enabled === true
      : parseBoolean(env.DEVSPACE_GIT_REMOTE_WRITE_ENABLED);
  const approvedRemotes = parseConfiguredStringList(
    env.DEVSPACE_GIT_APPROVED_REMOTES,
    value?.approvedRemotes,
    ["origin"],
  );
  const approvedDestinationBranches = parseConfiguredStringList(
    env.DEVSPACE_GIT_APPROVED_DESTINATION_BRANCHES,
    value?.approvedDestinationBranches,
    [],
  );
  const approvedRepositoryRoots = parseConfiguredStringList(
    env.DEVSPACE_GIT_APPROVED_REPOSITORY_ROOTS,
    value?.approvedRepositoryRoots,
    [],
  ).map((root) => resolve(expandHomePath(root)));
  const approvedRemoteUrls = value?.approvedRemoteUrls ?? {};

  for (const remote of approvedRemotes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(remote)) {
      throw new Error(`Invalid approved Git remote: ${remote}`);
    }
  }
  for (const branch of approvedDestinationBranches) {
    if (!isSafeConfiguredBranch(branch)) {
      throw new Error(`Invalid approved Git destination branch: ${branch}`);
    }
  }
  for (const root of approvedRepositoryRoots) {
    if (
      !allowedRoots.some((allowedRoot) => isPathInsideRoot(root, allowedRoot))
    ) {
      throw new Error(
        `Approved Git repository root is outside allowed roots: ${root}`,
      );
    }
  }
  for (const [remote, urls] of Object.entries(approvedRemoteUrls)) {
    if (
      !approvedRemotes.includes(remote) ||
      !Array.isArray(urls) ||
      urls.length === 0
    ) {
      throw new Error(`Invalid approved Git remote URL binding for ${remote}`);
    }
    for (const url of urls) {
      if (
        typeof url !== "string" ||
        (!isSafeConfiguredRemoteUrl(url) && !/^file:\/\/\/.+/.test(url))
      ) {
        throw new Error(`Invalid approved Git remote URL for ${remote}`);
      }
    }
  }
  if (value?.allowForce === true) {
    throw new Error("gitRemoteWrite.allowForce must remain false");
  }
  if (value?.requireCleanWorkspace === false) {
    throw new Error("gitRemoteWrite.requireCleanWorkspace must remain true");
  }
  if (value?.requireExpectedRemoteSha === false) {
    throw new Error("gitRemoteWrite.requireExpectedRemoteSha must remain true");
  }
  if (value?.requireFastForward === false) {
    throw new Error("gitRemoteWrite.requireFastForward must remain true");
  }
  if (
    enabled &&
    (approvedRemotes.length === 0 ||
      approvedDestinationBranches.length === 0 ||
      approvedRepositoryRoots.length === 0 ||
      approvedRemotes.some((remote) => !approvedRemoteUrls[remote]?.length))
  ) {
    throw new Error(
      "Enabled gitRemoteWrite requires approvedRemotes, approvedDestinationBranches, approvedRepositoryRoots, and exact approvedRemoteUrls",
    );
  }

  return {
    enabled,
    approvedRemotes,
    approvedDestinationBranches,
    approvedRepositoryRoots,
    approvedRemoteUrls,
    allowForce: false,
    requireCleanWorkspace: true,
    requireExpectedRemoteSha: true,
    requireFastForward: true,
  };
}

type DevspaceUserConfigGitRemoteWrite = NonNullable<
  ReturnType<typeof loadDevspaceFiles>["config"]["gitRemoteWrite"]
>;

function parseConfiguredStringList(
  envValue: string | undefined,
  configuredValue: string[] | undefined,
  fallback: string[],
): string[] {
  const values =
    envValue === undefined
      ? (configuredValue ?? fallback)
      : envValue
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
  if (
    !Array.isArray(values) ||
    values.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Invalid Git policy list: expected an array of strings");
  }
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
}

function isSafeConfiguredBranch(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.split("/").some((part) => part.length === 0 || part.startsWith("."))
  );
}

function isSafeConfiguredRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

type DevspaceUserConfigProjectMemory = NonNullable<
  ReturnType<typeof loadDevspaceFiles>["config"]["projectMemory"]
>;

function parseBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return parsed;
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes" || value === "review_only") {
    return value;
  }

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(
      `${name} is required for DevSpace OAuth. Run: devspace init`,
    );
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(
  env: NodeJS.ProcessEnv,
  ownerToken: string | undefined,
): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(
      env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken,
      "DEVSPACE_OAUTH_OWNER_TOKEN",
    ),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(
      env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS,
      ["chatgpt.com", "localhost", "127.0.0.1"],
    ),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ??
      files.config.publicBaseUrl ??
      localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const allowedRoots = parseAllowedRoots(
    env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots,
  );
  const mcpSessions = parseMcpSessionConfig(env, files.config.mcpSessions);

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots,
    allowedHosts: parseAllowedHosts(
      env.DEVSPACE_ALLOWED_HOSTS,
      derivedAllowedHosts,
    ),
    publicBaseUrl,
    minimalTools: parseMinimalTools(env, files.config.toolMode),
    readOnly: parseReadOnly(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS ?? files.config.widgets),
    stateDir: resolve(
      expandHomePath(
        env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir(),
      ),
    ),
    worktreeRoot: resolve(
      expandHomePath(
        env.DEVSPACE_WORKTREE_ROOT ??
          files.config.worktreeRoot ??
          defaultWorktreeRoot(),
      ),
    ),
    skillsEnabled:
      env.DEVSPACE_SKILLS === undefined
        ? true
        : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(
      expandHomePath(
        env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir(),
      ),
    ),
    logging: parseLoggingConfig(env, files.config.trustProxy),
    mcpTransportMode: parseMcpTransportMode(
      env.DEVSPACE_MCP_TRANSPORT_MODE ?? files.config.mcpTransportMode,
    ),
    mcpSessionIdleTtlMs: mcpSessions.idleTtlMs,
    mcpSessionMaxSessions: mcpSessions.maxSessions,
    mcpSessionSweepIntervalMs: mcpSessions.sweepIntervalMs,
    projectMemory: parseProjectMemoryConfig(
      files.config.projectMemory,
      allowedRoots,
    ),
    runners: files.config.runners ?? {},
    gitRemoteWrite: parseGitRemoteWritePolicy(
      env,
      files.config.gitRemoteWrite,
      allowedRoots,
    ),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost =
    publicHost.includes(":") && !publicHost.startsWith("[")
      ? `[${publicHost}]`
      : publicHost;
  return `http://${formattedHost}:${port}`;
}
