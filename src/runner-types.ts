export const RUNNER_NAMES = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "dotnet",
  "cargo",
  "pytest",
  "godot",
  "godot-mono",
  "blender",
  "hython",
  "hbatch",
] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];
export type RunnerContainment = "strict" | "best_effort" | "trusted_local";
export type RunnerNetworkPolicy =
  | "inherited"
  | "offline_requested"
  | "disabled";

export interface RunnerOverride {
  executable?: string;
  enabled?: boolean;
  maxTimeoutSeconds?: number;
  maxConcurrent?: number;
}

export interface RunnerRegistryConfig {
  [runnerName: string]: RunnerOverride | unknown;
}

export interface RunnerDefinition {
  name: RunnerName;
  enabled: boolean;
  supportedPlatforms: NodeJS.Platform[];
  argumentPolicy: string;
  workingDirectoryPolicy: "workspace";
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  maxConcurrent: number;
  maxOutputBytes: number;
  networkPolicy: RunnerNetworkPolicy;
  containment: RunnerContainment;
  versionArgs: string[];
  artifactPolicy: "declared_workspace_roots";
}

export interface RunnerInspection {
  name: RunnerName;
  enabled: boolean;
  available: boolean;
  executableExists: boolean;
  executableConfigured: boolean;
  supported: boolean;
  version?: string;
  diagnostic?: string;
  supportedPlatforms: NodeJS.Platform[];
  argumentPolicy: string;
  workingDirectoryPolicy: "workspace";
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  maxConcurrent: number;
  maxOutputBytes: number;
  networkPolicy: RunnerNetworkPolicy;
  containment: RunnerContainment;
  artifactPolicy: "declared_workspace_roots";
}

export interface ResolvedRunner {
  definition: RunnerDefinition;
  executable: string;
  environment: NodeJS.ProcessEnv;
  version?: string;
}

export interface RunnerSpawnSpec {
  command: string;
  args: string[];
  shell: false | string;
}

export interface RunnerValidationContext {
  workspaceRoot: string;
  workingDirectory: string;
}

export const DEFAULT_JOB_TIMEOUT_SECONDS = 15 * 60;
export const MAX_JOB_TIMEOUT_SECONDS = 60 * 60;
export const MAX_JOB_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENT_JOBS = 2;
export const VERSION_PROBE_TIMEOUT_MS = 5_000;
export const VERSION_PROBE_OUTPUT_BYTES = 16 * 1024;
export const SHELL_CONTROL_PATTERN = /[;&|`$><\n\r\0]/;
