import { spawn } from "node:child_process";
import {
  existsSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { isPathInsideRoot } from "./roots.js";

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
] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];
export type RunnerContainment = "strict" | "best_effort" | "trusted_local";
export type RunnerNetworkPolicy =
  "inherited" | "offline_requested" | "disabled";

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
  version?: string;
}

export interface RunnerValidationContext {
  workspaceRoot: string;
  workingDirectory: string;
}

export const DEFAULT_JOB_TIMEOUT_SECONDS = 15 * 60;
export const MAX_JOB_TIMEOUT_SECONDS = 60 * 60;
export const MAX_JOB_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENT_JOBS = 2;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_OUTPUT_BYTES = 16 * 1024;
const SHELL_CONTROL_PATTERN = /[;&|`$><\n\r\0]/;

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
      return { ...cached, definition: cloneDefinition(cached.definition) };

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
    const version = await probeVersion(
      executable,
      definition.versionArgs,
      this.env,
    ).catch(() => undefined);
    const resolved = { definition, executable, version };
    this.resolvedCache.set(name, resolved);
    return { ...resolved, definition: cloneDefinition(definition) };
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

    for (const candidate of executableCandidates(name, this.env)) {
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

function validateArgumentArray(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0 || args.length > 128) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: Job args must contain between 1 and 128 arguments.",
    );
  }
  for (const argument of args) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > 4096 ||
      SHELL_CONTROL_PATTERN.test(argument)
    ) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: Arguments must be non-empty single-line values without shell control characters.",
      );
    }
    rejectExternalPathSyntax(argument);
  }
}

function validateActionPolicy(
  runner: RunnerName,
  args: string[],
  context?: RunnerValidationContext,
): void {
  if (runner === "blender") {
    validateBlenderArguments(args, context);
    return;
  }
  const action = args[0];
  const allowedActions: Partial<Record<RunnerName, string[]>> = {
    npm: ["test", "run"],
    pnpm: ["test", "run", "build", "check", "lint", "typecheck"],
    yarn: ["test", "run", "build", "check", "lint", "typecheck"],
    bun: ["test", "run", "build"],
    dotnet: ["build", "test", "format"],
    cargo: ["build", "test", "check", "clippy", "fmt"],
  };
  const allowed = allowedActions[runner];
  if (allowed && !allowed.includes(action)) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: ${runner} only allows these actions: ${allowed.join(", ")}.`,
    );
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(runner) &&
    action === "run" &&
    (!args[1] || !/^[A-Za-z0-9:_-]+$/.test(args[1]))
  ) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: ${runner} run requires a safe script name.`,
    );
  }
  if (
    (runner === "godot" || runner === "godot-mono") &&
    !args.includes("--headless")
  ) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: ${runner} jobs must include --headless.`,
    );
  }
  if (
    (runner === "godot" || runner === "godot-mono") &&
    args.includes("--editor")
  ) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: ${runner} background jobs cannot open the editor.`,
    );
  }
}

function validateBlenderArguments(
  args: string[],
  context?: RunnerValidationContext,
): void {
  const flagsWithoutValues = new Set([
    "--background",
    "-b",
    "--factory-startup",
    "--disable-autoexec",
    "-Y",
    "--offline-mode",
  ]);
  const flagsWithValues = new Set([
    "--python",
    "-P",
    "--python-exit-code",
    "--render-output",
    "-o",
    "--render-format",
    "-F",
    "--render-frame",
    "-f",
    "--scene",
    "-S",
    "--engine",
    "-E",
  ]);
  const forbidden = new Set([
    "--python-expr",
    "--python-text",
    "--python-console",
    "--python-use-system-env",
    "--enable-autoexec",
    "-y",
    "--addons",
    "--command",
  ]);

  if (!args.includes("--background") && !args.includes("-b")) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: Blender jobs must include --background.",
    );
  }

  let afterSeparator = false;
  let pythonScripts = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (afterSeparator) continue;
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    if (forbidden.has(argument)) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: Blender option ${argument} is disabled by the V1 policy.`,
      );
    }
    if (flagsWithoutValues.has(argument)) continue;
    if (flagsWithValues.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(
          `RUNNER_ARGUMENT_REJECTED: Blender option ${argument} requires a value.`,
        );
      }
      validateBlenderOptionValue(argument, value, context);
      if (argument === "--python" || argument === "-P") pythonScripts += 1;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: Blender option ${argument} is not allowed.`,
      );
    }
    if (!argument.toLowerCase().endsWith(".blend")) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: Unexpected Blender positional argument: ${argument}.`,
      );
    }
  }

  if (pythonScripts > 1) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: Blender jobs may run at most one --python script.",
    );
  }
  const pythonIndex = Math.max(args.indexOf("--python"), args.indexOf("-P"));
  const exitCodeIndex = args.indexOf("--python-exit-code");
  if (pythonIndex >= 0 && (exitCodeIndex < 0 || exitCodeIndex > pythonIndex)) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: --python-exit-code must appear before --python so Blender applies it to script failures.",
    );
  }
}

function validateBlenderOptionValue(
  option: string,
  value: string,
  context?: RunnerValidationContext,
): void {
  if (option === "--python" || option === "-P") {
    if (!value.toLowerCase().endsWith(".py")) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: Blender --python must reference a .py file.",
      );
    }
    if (context) assertExistingRegularWorkspaceFile(value, context);
    return;
  }
  if (option === "--python-exit-code") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 255) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: --python-exit-code must be from 1 to 255.",
      );
    }
    return;
  }
  if (option === "--render-format" || option === "-F") {
    if (!["PNG", "JPEG", "WEBP", "OPEN_EXR"].includes(value)) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: Blender render format is not allowed.",
      );
    }
    return;
  }
  if (option === "--render-frame" || option === "-f") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: Blender render frame is invalid.",
      );
    }
    return;
  }
  if (option === "--engine" || option === "-E") {
    if (
      ![
        "BLENDER_EEVEE",
        "BLENDER_EEVEE_NEXT",
        "BLENDER_WORKBENCH",
        "CYCLES",
      ].includes(value)
    ) {
      throw new Error(
        "RUNNER_ARGUMENT_REJECTED: Blender render engine is not allowed.",
      );
    }
  }
}

function assertExistingRegularWorkspaceFile(
  candidate: string,
  context: RunnerValidationContext,
): void {
  const workspaceRoot = canonicalExistingPath(context.workspaceRoot);
  const target = resolve(context.workingDirectory, candidate);
  const canonical = canonicalExistingPath(target);
  if (!isPathInsideRoot(canonical, workspaceRoot)) {
    throw new Error(
      `WORKSPACE_ESCAPE: Blender script is outside the workspace: ${candidate}`,
    );
  }
  if (!statSync(canonical).isFile()) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: Blender script is not a regular file: ${candidate}`,
    );
  }
}

function assertWorkspaceContainedArguments(
  args: string[],
  context: RunnerValidationContext,
): void {
  const workspaceRoot = canonicalExistingPath(context.workspaceRoot);
  const workingDirectory = canonicalExistingPath(context.workingDirectory);
  if (!isPathInsideRoot(workingDirectory, workspaceRoot)) {
    throw new Error(
      "WORKSPACE_ESCAPE: Job working directory is outside the workspace.",
    );
  }

  for (const argument of args) {
    const candidate = pathCandidate(argument);
    if (!candidate || candidate.startsWith("-")) continue;
    if (candidate.startsWith("res://")) {
      if (candidate.slice("res://".length).split(/[\\/]/).includes("..")) {
        throw new Error(
          `WORKSPACE_ESCAPE: Runner argument escapes the workspace: ${argument}`,
        );
      }
      continue;
    }
    const target = resolve(context.workingDirectory, candidate);
    const existingAncestor = nearestExistingPath(target);
    const canonical = canonicalExistingPath(existingAncestor);
    if (!isPathInsideRoot(canonical, workspaceRoot)) {
      throw new Error(
        `WORKSPACE_ESCAPE: Runner argument escapes the workspace: ${argument}`,
      );
    }
  }
}

function rejectExternalPathSyntax(argument: string): void {
  const candidate = pathCandidate(argument) ?? argument;
  if (
    isAbsolute(candidate) ||
    candidate.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: Arguments may not reference absolute or parent paths: ${argument}`,
    );
  }
}

function pathCandidate(argument: string): string | undefined {
  if (argument.includes("=")) {
    return argument.slice(argument.indexOf("=") + 1);
  }
  if (argument.startsWith("-")) return undefined;
  return argument;
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

function canonicalExistingPath(target: string): string {
  try {
    const info = lstatSync(target);
    if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Unsupported filesystem object: ${target}`);
    }
    return realpathSync(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `WORKSPACE_ESCAPE: Unable to validate ${target}: ${reason}`,
    );
  }
}

function executableCandidates(
  runner: RunnerName,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = homedir();
  const fixed: Partial<Record<RunnerName, string[]>> = {
    npm: [
      join(home, ".hermes", "node", "bin", "npm"),
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
    ],
    pnpm: [
      join(home, ".hermes", "node", "bin", "pnpm"),
      "/opt/homebrew/bin/pnpm",
    ],
    yarn: [
      join(home, ".hermes", "node", "bin", "yarn"),
      "/opt/homebrew/bin/yarn",
    ],
    bun: [join(home, ".bun", "bin", "bun"), "/opt/homebrew/bin/bun"],
    dotnet: ["/usr/local/share/dotnet/dotnet", "/opt/homebrew/bin/dotnet"],
    cargo: [join(home, ".cargo", "bin", "cargo"), "/opt/homebrew/bin/cargo"],
    pytest: ["/opt/homebrew/bin/pytest", "/usr/local/bin/pytest"],
    godot: [
      "/Applications/Godot.app/Contents/MacOS/Godot",
      "/opt/homebrew/bin/godot",
    ],
    "godot-mono": [
      "/Applications/Godot_mono.app/Contents/MacOS/Godot",
      "/Applications/Godot Mono.app/Contents/MacOS/Godot",
      "/opt/homebrew/bin/godot-mono",
    ],
    blender: [
      "/Applications/Blender.app/Contents/MacOS/Blender",
      "/opt/homebrew/bin/blender",
      "/usr/local/bin/blender",
    ],
  };
  const fromPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, runner));
  return Array.from(new Set([...(fixed[runner] ?? []), ...fromPath]));
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

async function probeVersion(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let completed = false;
    const finish = (value?: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const append = (chunk: Buffer | string) => {
      if (Buffer.byteLength(output) >= VERSION_PROBE_OUTPUT_BYTES) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > VERSION_PROBE_OUTPUT_BYTES) {
        output = Buffer.from(output)
          .subarray(0, VERSION_PROBE_OUTPUT_BYTES)
          .toString("utf8");
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => finish(undefined));
    child.once("exit", (code) => {
      const version = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      finish(code === 0 ? version : undefined);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, VERSION_PROBE_TIMEOUT_MS);
  });
}

function applyBoundedOverride(input: {
  rawOverride: Record<string, unknown>;
  key: "maxTimeoutSeconds" | "maxConcurrent";
  runner: RunnerName;
  minimum: number;
  maximum: number;
  update: (next: number) => void;
  diagnostics: string[];
}): void {
  const value = input.rawOverride[input.key];
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < input.minimum ||
    value > input.maximum
  ) {
    input.diagnostics.push(
      `RUNNER_CONFIG_INVALID: ${input.runner}.${input.key} must be an integer from ${input.minimum} to ${input.maximum}.`,
    );
    return;
  }
  input.update(value);
}

function argumentPolicyName(name: RunnerName): string {
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) return "package_script_v1";
  if (name === "dotnet") return "dotnet_validation_v1";
  if (name === "cargo") return "cargo_validation_v1";
  if (name === "pytest") return "pytest_validation_v1";
  if (name === "blender") return "blender_background_v1";
  return "godot_headless_v1";
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function cloneDefinition(definition: RunnerDefinition): RunnerDefinition {
  return {
    ...definition,
    supportedPlatforms: [...definition.supportedPlatforms],
    versionArgs: [...definition.versionArgs],
  };
}

function isRunnerName(value: string): value is RunnerName {
  return (RUNNER_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
