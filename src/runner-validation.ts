import { spawn } from "node:child_process";
import {
  existsSync,
  constants as fsConstants,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { isPathInsideRoot } from "./roots.js";
import {
  type RunnerName,
  type RunnerDefinition,
  type RunnerSpawnSpec,
  type RunnerValidationContext,
  RUNNER_NAMES,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  MAX_JOB_TIMEOUT_SECONDS,
  MAX_JOB_OUTPUT_BYTES,
  MAX_CONCURRENT_JOBS,
  VERSION_PROBE_TIMEOUT_MS,
  VERSION_PROBE_OUTPUT_BYTES,
  SHELL_CONTROL_PATTERN,
} from "./runner-types.js";

export {
  SHELL_CONTROL_PATTERN,
};

export function validateArgumentArray(args: string[]): void {
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

export function validateActionPolicy(
  runner: RunnerName,
  args: string[],
  context?: RunnerValidationContext,
): void {
  if (runner === "blender") {
    validateBlenderArguments(args, context);
    return;
  }
  if (runner === "hython") {
    validateHythonArguments(args, context);
    return;
  }
  if (runner === "hbatch") {
    validateHbatchArguments(args, context);
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

export function validateHythonArguments(
  args: string[],
  context?: RunnerValidationContext,
): void {
  const script = args[0];
  if (
    !script ||
    script.startsWith("-") ||
    !script.toLowerCase().endsWith(".py")
  ) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: hython requires one workspace-local .py script as its first argument.",
    );
  }
  if (context) {
    assertExistingRegularWorkspaceFile(script, context, "Hython script");
  }
  for (const argument of args.slice(1)) {
    if (["-c", "-m", "-i", "-"].includes(argument)) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: hython option ${argument} is disabled by the V1 policy.`,
      );
    }
  }
}

export function validateHbatchArguments(
  args: string[],
  context?: RunnerValidationContext,
): void {
  let commandScript: string | undefined;
  let hipFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-j") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 256) {
        throw new Error(
          "RUNNER_ARGUMENT_REJECTED: hbatch -j must be an integer from 1 to 256.",
        );
      }
      index += 1;
      continue;
    }
    if (argument === "-c") {
      if (commandScript) {
        throw new Error(
          "RUNNER_ARGUMENT_REJECTED: hbatch accepts exactly one -c source command.",
        );
      }
      const value = args[index + 1];
      const match = /^source ([A-Za-z0-9._/-]+\.(?:cmd|hscript))$/i.exec(
        value ?? "",
      );
      if (!match?.[1]) {
        throw new Error(
          "RUNNER_ARGUMENT_REJECTED: hbatch -c must be exactly 'source <workspace-relative .cmd or .hscript>'.",
        );
      }
      commandScript = match[1];
      rejectExternalPathSyntax(commandScript);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: hbatch option ${argument} is not allowed.`,
      );
    }
    if (!/\.(?:hip|hiplc|hipnc)$/i.test(argument) || hipFile) {
      throw new Error(
        `RUNNER_ARGUMENT_REJECTED: Unexpected hbatch positional argument: ${argument}.`,
      );
    }
    hipFile = argument;
  }
  if (!commandScript || !hipFile) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: hbatch requires one workspace-local HIP file and one bounded source command.",
    );
  }
  if (context) {
    assertExistingRegularWorkspaceFile(commandScript, context, "Hbatch script");
    assertExistingRegularWorkspaceFile(hipFile, context, "Houdini scene");
  }
}

export function validateBlenderArguments(
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

export function validateBlenderOptionValue(
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
    if (context) {
      assertExistingRegularWorkspaceFile(value, context, "Blender script");
    }
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

export function assertExistingRegularWorkspaceFile(
  candidate: string,
  context: RunnerValidationContext,
  description: string,
): void {
  const workspaceRoot = canonicalExistingPath(context.workspaceRoot);
  const target = resolve(context.workingDirectory, candidate);
  const canonical = canonicalExistingPath(target);
  if (!isPathInsideRoot(canonical, workspaceRoot)) {
    throw new Error(
      `WORKSPACE_ESCAPE: ${description} is outside the workspace: ${candidate}`,
    );
  }
  if (!statSync(canonical).isFile()) {
    throw new Error(
      `RUNNER_ARGUMENT_REJECTED: ${description} is not a regular file: ${candidate}`,
    );
  }
}

export function assertWorkspaceContainedArguments(
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

export function rejectExternalPathSyntax(argument: string): void {
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

export function pathCandidate(argument: string): string | undefined {
  if (argument.includes("=")) {
    return argument.slice(argument.indexOf("=") + 1);
  }
  if (argument.startsWith("-")) return undefined;
  return argument;
}

export function nearestExistingPath(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function canonicalExistingPath(target: string): string {
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

export function executableCandidates(
  runner: RunnerName,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
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
    hython: houdiniExecutableCandidates("hython", platform),
    hbatch: houdiniExecutableCandidates("hbatch", platform),
  };
  const pathValue =
    env.PATH ??
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ??
    "";
  const executableNames =
    platform === "win32" ? windowsExecutableNames(runner, env) : [runner];
  const fromPath = pathValue
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      executableNames.map((executable) => join(directory, executable)),
    );
  return Array.from(new Set([...(fixed[runner] ?? []), ...fromPath]));
}

export function windowsExecutableNames(
  runner: RunnerName,
  env: NodeJS.ProcessEnv,
): string[] {
  const pathExt =
    Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1] ??
    ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension))
    .map((extension) => `${runner}${extension.toLowerCase()}`);
}

export function houdiniExecutableCandidates(
  executableName: "hython" | "hbatch",
  platform: NodeJS.Platform,
): string[] {
  const executable =
    platform === "win32" ? `${executableName}.exe` : executableName;
  const candidates: string[] = [];
  if (platform === "darwin") {
    const root = "/Applications/Houdini";
    for (const installation of safeDirectoryEntries(root)) {
      const installRoot = join(root, installation);
      candidates.push(
        join(
          installRoot,
          "Frameworks",
          "Houdini.framework",
          "Resources",
          "bin",
          executable,
        ),
        join(
          installRoot,
          "Frameworks",
          "Houdini.framework",
          "Versions",
          "Current",
          "Resources",
          "bin",
          executable,
        ),
      );
      const versionsRoot = join(
        installRoot,
        "Frameworks",
        "Houdini.framework",
        "Versions",
      );
      for (const version of safeDirectoryEntries(versionsRoot)) {
        candidates.push(
          join(versionsRoot, version, "Resources", "bin", executable),
        );
      }
    }
  } else if (platform === "linux") {
    for (const root of ["/opt", "/usr/local"]) {
      for (const installation of safeDirectoryEntries(root)) {
        if (!/^hfs\d/i.test(installation)) continue;
        candidates.push(join(root, installation, "bin", executable));
      }
    }
  } else if (platform === "win32") {
    const root = "C:\\Program Files\\Side Effects Software";
    for (const installation of safeDirectoryEntries(root)) {
      if (!/^Houdini/i.test(installation)) continue;
      candidates.push(join(root, installation, "bin", executable));
    }
  }
  return candidates;
}

export function safeDirectoryEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function environmentForExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const executableDirectory = dirname(executable);
  const currentPath = env[pathKey] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);
  const normalizedExecutableDirectory =
    platform === "win32"
      ? executableDirectory.toLowerCase()
      : executableDirectory;
  const withoutDuplicate = entries.filter((entry) => {
    const normalized = platform === "win32" ? entry.toLowerCase() : entry;
    return normalized !== normalizedExecutableDirectory;
  });
  return {
    ...env,
    [pathKey]: [executableDirectory, ...withoutDuplicate].join(delimiter),
  };
}

export async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export async function probeVersion(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const invocation = createRunnerSpawnSpec(executable, args, platform, env);
    const child = spawn(invocation.command, invocation.args, {
      env,
      shell: invocation.shell,
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

export function createRunnerSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): RunnerSpawnSpec {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args, shell: false };
  }
  const shell =
    Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1] ??
    "cmd.exe";
  return {
    command: `call ${[executable, ...args]
      .map(quoteWindowsCommandToken)
      .join(" ")}`,
    args: [],
    shell,
  };
}

export function quoteWindowsCommandToken(value: string): string {
  if (/["\r\n\0%!^]/.test(value)) {
    throw new Error(
      "RUNNER_ARGUMENT_REJECTED: Windows command-shim arguments contain unsafe shell characters.",
    );
  }
  return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

export function normalizeRunnerVersion(
  name: RunnerName,
  executable: string,
  probedVersion: string | undefined,
): string | undefined {
  if (name !== "hython" && name !== "hbatch") return probedVersion;
  for (const candidate of [probedVersion, executable]) {
    if (!candidate) continue;
    const match =
      /\bHoudini(?:\s+(?:FX|Core|Indie|Education|Apprentice))?\s+(\d+\.\d+(?:\.\d+)?)/i.exec(
        candidate,
      ) ??
      /(?:Houdini|Versions)[/\\](?:Houdini)?(\d+\.\d+(?:\.\d+)?)/i.exec(
        candidate,
      );
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function applyBoundedOverride(input: {
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

export function argumentPolicyName(name: RunnerName): string {
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) return "package_script_v1";
  if (name === "dotnet") return "dotnet_validation_v1";
  if (name === "cargo") return "cargo_validation_v1";
  if (name === "pytest") return "pytest_validation_v1";
  if (name === "blender") return "blender_background_v1";
  if (name === "hython") return "hython_workspace_script_v1";
  if (name === "hbatch") return "hbatch_workspace_source_v1";
  return "godot_headless_v1";
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function cloneDefinition(definition: RunnerDefinition): RunnerDefinition {
  return {
    ...definition,
    supportedPlatforms: [...definition.supportedPlatforms],
    versionArgs: [...definition.versionArgs],
  };
}

export function isRunnerName(value: string): value is RunnerName {
  return (RUNNER_NAMES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
