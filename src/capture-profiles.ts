import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import { validateArtifactRoots } from "./artifact-ledger.js";
import { RunnerRegistry, type RunnerName } from "./runner-registry.js";
import { isPathInsideRoot } from "./roots.js";

export const MAX_CAPTURE_PROFILE_BYTES = 64 * 1024;

const captureProfileSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    runner: z.enum(["godot", "godot-mono"]),
    workingDirectory: z.string().min(1).max(512),
    args: z.array(z.string().min(1).max(4096)).min(1).max(128),
    artifactRoots: z.array(z.string().min(1).max(512)).min(1).max(8),
    timeoutSeconds: z.number().int().min(1).max(3600),
    capture: z
      .object({
        project: z.string().min(1).max(200),
        scene: z.string().startsWith("res://").max(512),
        viewportWidth: z.number().int().min(64).max(8192),
        viewportHeight: z.number().int().min(64).max(8192),
        randomSeed: z.number().int(),
        warmupFrames: z.number().int().min(0).max(10_000),
        captureFrame: z.number().int().min(0).max(1_000_000),
        outputPath: z.string().endsWith(".png").max(512),
        manifestPath: z.string().endsWith(".json").max(512),
      })
      .strict(),
  })
  .strict();

export interface CaptureProfile {
  name: string;
  runner: Extract<RunnerName, "godot" | "godot-mono">;
  workingDirectory: string;
  workingDirectoryAbsolute: string;
  args: string[];
  artifactRoots: string[];
  timeoutSeconds: number;
  capture: {
    project: string;
    scene: string;
    viewportWidth: number;
    viewportHeight: number;
    randomSeed: number;
    warmupFrames: number;
    captureFrame: number;
    outputPath: string;
    manifestPath: string;
    sourceCommit: string;
  };
  environment: Record<string, string>;
}

export function loadCaptureProfile(input: {
  workspaceRoot: string;
  name: string;
  runners: RunnerRegistry;
}): CaptureProfile {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.name)) {
    throw new Error("CAPTURE_PROFILE_INVALID: Invalid capture profile name.");
  }
  const canonicalWorkspace = realpathSync(input.workspaceRoot);
  const profilePath = join(
    input.workspaceRoot,
    ".devspace",
    "captures",
    `${input.name}.json`,
  );
  let profileInfo;
  try {
    profileInfo = lstatSync(profilePath);
  } catch {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: Capture profile does not exist: ${input.name}`,
    );
  }
  if (profileInfo.isSymbolicLink() || !profileInfo.isFile()) {
    throw new Error(
      "CAPTURE_PROFILE_INVALID: Capture profile must be a regular file.",
    );
  }
  if (profileInfo.size > MAX_CAPTURE_PROFILE_BYTES) {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: Capture profile exceeds ${MAX_CAPTURE_PROFILE_BYTES} bytes.`,
    );
  }
  const canonicalProfile = realpathSync(profilePath);
  if (!isPathInsideRoot(canonicalProfile, canonicalWorkspace)) {
    throw new Error(
      "WORKSPACE_ESCAPE: Capture profile is outside the workspace.",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `CAPTURE_PROFILE_INVALID: Capture profile is not valid JSON: ${reason}`,
    );
  }
  const parsed = captureProfileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: ${z.prettifyError(parsed.error)}`,
    );
  }
  const profile = parsed.data;
  const workingDirectory = normalizeRelativeDirectory(profile.workingDirectory);
  const workingDirectoryAbsolute = resolve(
    input.workspaceRoot,
    workingDirectory,
  );
  const canonicalWorkingDirectory = realpathSync(workingDirectoryAbsolute);
  if (
    !statSync(canonicalWorkingDirectory).isDirectory() ||
    !isPathInsideRoot(canonicalWorkingDirectory, canonicalWorkspace)
  ) {
    throw new Error(
      "WORKSPACE_ESCAPE: Capture working directory is outside the workspace.",
    );
  }
  const artifactRoots = validateArtifactRoots(
    input.workspaceRoot,
    profile.artifactRoots,
  );
  assertOutputCovered(profile.capture.outputPath, artifactRoots, "outputPath");
  assertOutputCovered(
    profile.capture.manifestPath,
    artifactRoots,
    "manifestPath",
  );
  if (!profile.args.includes(profile.capture.scene)) {
    throw new Error(
      "CAPTURE_PROFILE_INVALID: Capture args must include capture.scene.",
    );
  }
  input.runners.validateArguments(profile.runner, profile.args, {
    workspaceRoot: input.workspaceRoot,
    workingDirectory: workingDirectoryAbsolute,
  });
  const definition = input.runners.getDefinition(profile.runner);
  if (profile.timeoutSeconds > definition.maxTimeoutSeconds) {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: timeoutSeconds exceeds the ${profile.runner} runner cap.`,
    );
  }

  const sourceCommit = inspectSourceCommit(input.workspaceRoot);
  const capture = { ...profile.capture, sourceCommit };
  return {
    name: input.name,
    runner: profile.runner,
    workingDirectory,
    workingDirectoryAbsolute,
    args: [...profile.args],
    artifactRoots,
    timeoutSeconds: profile.timeoutSeconds,
    capture,
    environment: {
      DEVSPACE_CAPTURE_PROFILE: input.name,
      DEVSPACE_CAPTURE_PROJECT: capture.project,
      DEVSPACE_CAPTURE_SCENE: capture.scene,
      DEVSPACE_CAPTURE_VIEWPORT_WIDTH: String(capture.viewportWidth),
      DEVSPACE_CAPTURE_VIEWPORT_HEIGHT: String(capture.viewportHeight),
      DEVSPACE_CAPTURE_RANDOM_SEED: String(capture.randomSeed),
      DEVSPACE_CAPTURE_WARMUP_FRAMES: String(capture.warmupFrames),
      DEVSPACE_CAPTURE_FRAME: String(capture.captureFrame),
      DEVSPACE_CAPTURE_OUTPUT_PATH: capture.outputPath,
      DEVSPACE_CAPTURE_MANIFEST_PATH: capture.manifestPath,
      DEVSPACE_CAPTURE_SOURCE_COMMIT: sourceCommit,
    },
  };
}

function normalizeRelativeDirectory(value: string): string {
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  ) {
    throw new Error(
      "CAPTURE_PROFILE_INVALID: workingDirectory must be workspace-relative.",
    );
  }
  const normalized = value
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  return normalized || ".";
}

function assertOutputCovered(
  value: string,
  artifactRoots: string[],
  field: string,
): void {
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  ) {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: capture.${field} must be workspace-relative.`,
    );
  }
  const normalized = value
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (
    !artifactRoots.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    )
  ) {
    throw new Error(
      `CAPTURE_PROFILE_INVALID: capture.${field} is outside artifactRoots.`,
    );
  }
}

function inspectSourceCommit(workspaceRoot: string): string {
  const result = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  const candidate = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(candidate) ? candidate : "unversioned";
}
