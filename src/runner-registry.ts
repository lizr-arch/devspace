import { isAbsolute, resolve } from "node:path";
import {
  RUNNER_NAMES,
  type RunnerName,
  type RunnerContainment,
  type RunnerNetworkPolicy,
  type RunnerOverride,
  type RunnerRegistryConfig,
  type RunnerDefinition,
  type RunnerInspection,
  type ResolvedRunner,
  type RunnerSpawnSpec,
  type RunnerValidationContext,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_CONCURRENT_JOBS,
} from "./runner-types.js";
import {
  validateArgumentArray,
  validateActionPolicy,
  assertWorkspaceContainedArguments,
  executableCandidates,
  environmentForExecutable,
  isExecutableFile,
  probeVersion,
  createRunnerSpawnSpec,
  normalizeRunnerVersion,
  applyBoundedOverride,
  argumentPolicyName,
  expandHome,
  cloneDefinition,
  isRunnerName,
  isRecord,
} from "./runner-validation.js";

export {
  RUNNER_NAMES,
  type RunnerName,
  type RunnerContainment,
  type RunnerNetworkPolicy,
  type RunnerOverride,
  type RunnerRegistryConfig,
  type RunnerDefinition,
  type RunnerInspection,
  type ResolvedRunner,
  type RunnerSpawnSpec,
  type RunnerValidationContext,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_CONCURRENT_JOBS,
  createRunnerSpawnSpec,
};

const DEFAULT_DEFINITIONS: Record<RunnerName, RunnerDefinition> =
  Object.fromEntries(
    RUNNER_NAMES.map((name) => [
      name,
      {
        name,
        enabled: true,
        supportedPlatforms: ["darwin", "linux", "win32"],
        argumentPolicy: argumentPolicyName(name),
        workingDirectoryPolicy: "workspace" as const,
        defaultTimeoutSeconds: DEFAULT_JOB_TIMEOUT_SECONDS,
        maxTimeoutSeconds: MAX_JOB_TIMEOUT_SECONDS,
        maxConcurrent: MAX_CONCURRENT_JOBS,
        maxOutputBytes: MAX_JOB_OUTPUT_BYTES,
        networkPolicy: "inherited" as const,
        containment: "trusted_local" as const,
        versionArgs: ["--version"],
        artifactPolicy: "declared_workspace_roots" as const,
      },
    ]),
  ) as Record<RunnerName, RunnerDefinition>;

DEFAULT_DEFINITIONS.blender.supportedPlatforms = ["darwin", "linux", "win32"];
DEFAULT_DEFINITIONS.blender.argumentPolicy = "blender_background_v1";
DEFAULT_DEFINITIONS.blender.defaultTimeoutSeconds = 30 * 60;
DEFAULT_DEFINITIONS.blender.maxTimeoutSeconds = MAX_JOB_TIMEOUT_SECONDS;
DEFAULT_DEFINITIONS.blender.maxConcurrent = 1;
DEFAULT_DEFINITIONS.blender.networkPolicy = "offline_requested";

for (const name of ["hython", "hbatch"] as const) {
  DEFAULT_DEFINITIONS[name].supportedPlatforms = ["darwin", "linux", "win32"];
  DEFAULT_DEFINITIONS[name].defaultTimeoutSeconds = 30 * 60;
  DEFAULT_DEFINITIONS[name].maxTimeoutSeconds = MAX_JOB_TIMEOUT_SECONDS;
  DEFAULT_DEFINITIONS[name].maxConcurrent = 1;
  DEFAULT_DEFINITIONS[name].networkPolicy = "offline_requested";
}
DEFAULT_DEFINITIONS.hython.argumentPolicy = "hython_workspace_script_v1";
DEFAULT_DEFINITIONS.hbatch.argumentPolicy = "hbatch_workspace_source_v1";

export class RunnerRegistry {
  private readonly definitions = new Map<RunnerName, RunnerDefinition>();
  private readonly configuredExecutables = new Map<RunnerName, string>();
  private readonly resolvedCache = new Map<RunnerName, ResolvedRunner>();
  private readonly diagnostics: string[] = [];

  constructor(
    overrides: unknown = {},
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const name of RUNNER_NAMES) {
      this.definitions.set(name, cloneDefinition(DEFAULT_DEFINITIONS[name]));
    }
    this.applyOverrides(overrides);
  }

  get configurationDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  getDefinition(name: string): RunnerDefinition {
    if (!isRunnerName(name)) {
      throw new Error(`RUNNER_UNAVAILABLE: Unregistered runner: ${name}.`);
    }
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`RUNNER_UNAVAILABLE: Unregistered runner: ${name}.`);
    }
    return cloneDefinition(definition);
  }

  async resolve(name: string): Promise<ResolvedRunner> {
    if (!isRunnerName(name)) {
      throw new Error(`RUNNER_UNAVAILABLE: Unregistered runner: ${name}.`);
    }
    const cached = this.resolvedCache.get(name);
    if (cached)
      return {
        ...cached,
        definition: cloneDefinition(cached.definition),
        environment: { ...cached.environment },
      };

    const definition = this.getDefinition(name);
    if (!definition.enabled) {
      throw new Error(`RUNNER_UNAVAILABLE: Runner ${name} is disabled.`);
    }
    if (!definition.supportedPlatforms.includes(this.platform)) {
      throw new Error(
        `RUNNER_UNAVAILABLE: Runner ${name} is not supported on ${this.platform}.`,
      );
    }

    const executable = await this.locateExecutable(name);
    const environment = environmentForExecutable(
      executable,
      this.env,
      this.platform,
    );
    const probedVersion = await probeVersion(
      executable,
      definition.versionArgs,
      environment,
      this.platform,
    ).catch(() => undefined);
    const version = normalizeRunnerVersion(name, executable, probedVersion);
    const resolved = { definition, executable, environment, version };
    this.resolvedCache.set(name, resolved);
    return {
      ...resolved,
      definition: cloneDefinition(definition),
      environment: { ...environment },
    };
  }

  async resolveExecutable(
    name: string,
    executable: string,
    versionArgs?: string[],
  ): Promise<ResolvedRunner> {
    const definition = this.getDefinition(name);
    if (!definition.enabled) {
      throw new Error(`RUNNER_UNAVAILABLE: Runner ${name} is disabled.`);
    }
    if (!definition.supportedPlatforms.includes(this.platform)) {
      throw new Error(
        `RUNNER_UNAVAILABLE: Runner ${name} is not supported on ${this.platform}.`,
      );
    }

    const environment = environmentForExecutable(
      executable,
      this.env,
      this.platform,
    );
    const version = await probeVersion(
      executable,
      versionArgs ?? definition.versionArgs,
      environment,
      this.platform,
    ).catch(() => undefined);
    return {
      definition,
      executable,
      environment,
      version,
    };
  }

  validateArguments(
    name: string,
    args: string[],
    context?: RunnerValidationContext,
  ): void {
    const definition = this.getDefinition(name);
    if (!definition.enabled) {
      throw new Error(`RUNNER_UNAVAILABLE: Runner ${name} is disabled.`);
    }
    validateArgumentArray(args);
    validateActionPolicy(definition.name, args, context);
    if (context) {
      assertWorkspaceContainedArguments(args, context);
    }
  }

  async inspectAll(): Promise<{
    runners: RunnerInspection[];
    diagnostics: string[];
  }> {
    const runners: RunnerInspection[] = [];
    for (const name of RUNNER_NAMES) {
      const definition = this.getDefinition(name);
      const base = {
        name,
        enabled: definition.enabled,
        executableConfigured: this.configuredExecutables.has(name),
        supported: definition.supportedPlatforms.includes(this.platform),
        supportedPlatforms: [...definition.supportedPlatforms],
        argumentPolicy: definition.argumentPolicy,
        workingDirectoryPolicy: definition.workingDirectoryPolicy,
        defaultTimeoutSeconds: definition.defaultTimeoutSeconds,
        maxTimeoutSeconds: definition.maxTimeoutSeconds,
        maxConcurrent: definition.maxConcurrent,
        maxOutputBytes: definition.maxOutputBytes,
        networkPolicy: definition.networkPolicy,
        containment: definition.containment,
        artifactPolicy: definition.artifactPolicy,
      } satisfies Omit<
        RunnerInspection,
        "available" | "executableExists" | "version" | "diagnostic"
      >;

      if (!definition.enabled) {
        runners.push({
          ...base,
          available: false,
          executableExists: false,
          diagnostic: "Runner is disabled by local configuration.",
        });
        continue;
      }
      if (!base.supported) {
        runners.push({
          ...base,
          available: false,
          executableExists: false,
          diagnostic: `Runner is unsupported on ${this.platform}.`,
        });
        continue;
      }

      try {
        const resolved = await this.resolve(name);
        runners.push({
          ...base,
          available: true,
          executableExists: true,
          version: resolved.version,
          diagnostic: resolved.version
            ? undefined
            : "Executable is available, but its version probe failed.",
        });
      } catch (error) {
        runners.push({
          ...base,
          available: false,
          executableExists: false,
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { runners, diagnostics: this.configurationDiagnostics };
  }

  private applyOverrides(value: unknown): void {
    if (value === undefined) return;
    if (!isRecord(value)) {
      this.diagnostics.push(
        "RUNNER_CONFIG_INVALID: runners must be a JSON object.",
      );
      return;
    }

    for (const [rawName, rawOverride] of Object.entries(value)) {
      if (!isRunnerName(rawName)) {
        this.diagnostics.push(
          `RUNNER_CONFIG_INVALID: Unknown runner override ${rawName}.`,
        );
        continue;
      }
      if (!isRecord(rawOverride)) {
        this.diagnostics.push(
          `RUNNER_CONFIG_INVALID: Override for ${rawName} must be an object.`,
        );
        continue;
      }
      const definition = this.definitions.get(rawName);
      if (!definition) continue;

      if (rawOverride.enabled !== undefined) {
        if (typeof rawOverride.enabled === "boolean") {
          definition.enabled = rawOverride.enabled;
        } else {
          this.diagnostics.push(
            `RUNNER_CONFIG_INVALID: ${rawName}.enabled must be boolean.`,
          );
        }
      }

      if (rawOverride.executable !== undefined) {
        if (
          typeof rawOverride.executable === "string" &&
          isAbsolute(expandHome(rawOverride.executable))
        ) {
          this.configuredExecutables.set(
            rawName,
            resolve(expandHome(rawOverride.executable)),
          );
        } else {
          this.diagnostics.push(
            `RUNNER_CONFIG_INVALID: ${rawName}.executable must be an absolute path.`,
          );
        }
      }

      applyBoundedOverride({
        rawOverride,
        key: "maxTimeoutSeconds",
        runner: rawName,
        minimum: 1,
        maximum: MAX_JOB_TIMEOUT_SECONDS,
        update: (next) => {
          definition.maxTimeoutSeconds = next;
          definition.defaultTimeoutSeconds = Math.min(
            definition.defaultTimeoutSeconds,
            next,
          );
        },
        diagnostics: this.diagnostics,
      });
      applyBoundedOverride({
        rawOverride,
        key: "maxConcurrent",
        runner: rawName,
        minimum: 1,
        maximum: MAX_CONCURRENT_JOBS,
        update: (next) => {
          definition.maxConcurrent = next;
        },
        diagnostics: this.diagnostics,
      });
    }
  }

  private async locateExecutable(name: RunnerName): Promise<string> {
    const configured = this.configuredExecutables.get(name);
    if (configured) {
      if (await isExecutableFile(configured)) return configured;
      throw new Error(
        `RUNNER_UNAVAILABLE: Configured executable for ${name} does not exist or is not a file.`,
      );
    }

    for (const candidate of executableCandidates(
      name,
      this.env,
      this.platform,
    )) {
      if (await isExecutableFile(candidate)) return resolve(candidate);
    }
    throw new Error(
      `RUNNER_UNAVAILABLE: Unable to locate executable for ${name}.`,
    );
  }
}

export function validateRunnerArguments(
  runner: RunnerName,
  args: string[],
  context?: RunnerValidationContext,
): void {
  new RunnerRegistry().validateArguments(runner, args, context);
}

