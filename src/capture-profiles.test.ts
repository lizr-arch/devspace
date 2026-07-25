import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCaptureProfile } from "./capture-profiles.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capture-profiles-"));
const workspaceRoot = join(root, "workspace");
const profilesRoot = join(workspaceRoot, ".devspace", "captures");
const outputRoot = join(workspaceRoot, "artifacts", "captures");
const outsideRoot = join(root, "outside");
mkdirSync(profilesRoot, { recursive: true });
mkdirSync(outputRoot, { recursive: true });
mkdirSync(outsideRoot, { recursive: true });
writeFileSync(join(workspaceRoot, "capture.tscn"), "[gd_scene format=3]");
const runners = new RunnerRegistry({
  "godot-mono": { maxTimeoutSeconds: 300 },
});

const validProfile = {
  schemaVersion: 1,
  runner: "godot-mono",
  workingDirectory: ".",
  args: ["--headless", "--path", ".", "res://capture.tscn"],
  artifactRoots: ["artifacts/captures"],
  timeoutSeconds: 120,
  capture: {
    project: "fixture",
    scene: "res://capture.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
    randomSeed: 42,
    warmupFrames: 3,
    captureFrame: 4,
    outputPath: "artifacts/captures/game_capture.png",
    manifestPath: "artifacts/captures/capture_manifest.json",
  },
};

try {
  writeProfile("valid", validProfile);
  const loaded = loadCaptureProfile({
    workspaceRoot,
    name: "valid",
    runners,
  });
  assert.equal(loaded.runner, "godot-mono");
  assert.equal(loaded.capture.viewportWidth, 640);
  assert.equal(loaded.capture.sourceCommit, "unversioned");
  assert.equal(loaded.environment.DEVSPACE_CAPTURE_RANDOM_SEED, "42");
  assert.equal(
    loaded.environment.DEVSPACE_CAPTURE_OUTPUT_PATH,
    validProfile.capture.outputPath,
  );
  assert.equal(loaded.workingDirectoryAbsolute, workspaceRoot);

  writeProfile("executable", {
    ...validProfile,
    executable: "/Applications/Godot.app/Contents/MacOS/Godot",
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "executable",
        runners,
      }),
    /CAPTURE_PROFILE_INVALID/,
  );

  writeProfile("wrong-runner", {
    ...validProfile,
    runner: "blender",
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "wrong-runner",
        runners,
      }),
    /CAPTURE_PROFILE_INVALID/,
  );

  writeProfile("outside-output", {
    ...validProfile,
    capture: {
      ...validProfile.capture,
      outputPath: "outside/game_capture.png",
    },
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "outside-output",
        runners,
      }),
    /outside artifactRoots/,
  );

  writeProfile("editor", {
    ...validProfile,
    args: ["--headless", "--editor", "res://capture.tscn"],
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "editor",
        runners,
      }),
    /cannot open the editor/,
  );

  writeProfile("missing-scene", {
    ...validProfile,
    args: ["--headless", "--path", "."],
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "missing-scene",
        runners,
      }),
    /must include capture.scene/,
  );

  writeProfile("outside-script", {
    ...validProfile,
    args: [
      "--headless",
      "--path",
      ".",
      "res://capture.tscn",
      "../outside/capture.gd",
    ],
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "outside-script",
        runners,
      }),
    /RUNNER_ARGUMENT_REJECTED/,
  );

  writeProfile("timeout", {
    ...validProfile,
    timeoutSeconds: 301,
  });
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "timeout",
        runners,
      }),
    /exceeds the godot-mono runner cap/,
  );

  symlinkSync(
    join(profilesRoot, "valid.json"),
    join(profilesRoot, "linked.json"),
  );
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "linked",
        runners,
      }),
    /regular file/,
  );
  assert.throws(
    () =>
      loadCaptureProfile({
        workspaceRoot,
        name: "../valid",
        runners,
      }),
    /Invalid capture profile name/,
  );

  console.log("capture profile tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeProfile(name: string, value: unknown): void {
  writeFileSync(
    join(profilesRoot, `${name}.json`),
    JSON.stringify(value, null, 2),
  );
}
