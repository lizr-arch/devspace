import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { RunnerRegistry, validateRunnerArguments } from "./runner-registry.js";
import { BackgroundJobManager } from "./background-jobs.js";
import { ArtifactLedger } from "./artifact-ledger.js";
import {
  GODOT_EDITOR_IMPORT_ARGS,
  validateGodotEditorImportArguments,
  withDotnetRuntime,
} from "./runner-validation.js";
import {
  GodotImportRegistry,
  censusGodotImportLog,
  finishGodotImportReport,
  godotImportTimeoutSeconds,
  godotProjectKey,
  resolveGodotImportProject,
  startGodotImport,
} from "./godot-import.js";

const root = mkdtempSync(join(tmpdir(), "devspace-godot-import-"));
const stateDir = join(root, "state");
const configDir = join(root, "config");
const projectRoot = join(root, "project");
const checkoutRoot = join(root, "checkout");
const otherRoot = join(root, "other");
const executableRoot = join(root, "bin");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--initial-branch=main"]);
  git(path, ["config", "user.name", "DevSpace Godot Test"]);
  git(path, ["config", "user.email", "devspace-godot-test@example.com"]);
  writeFileSync(join(path, "project.godot"), "[application]\nconfig/name=\"Test\"\n");
  writeFileSync(join(path, ".gitignore"), ".godot/\n.mono/\n");
  writeFileSync(join(path, "tracked.txt"), "original\n");
  git(path, ["add", "--", "project.godot", ".gitignore", "tracked.txt"]);
  git(path, ["commit", "-m", "initial"]);
}

function writeExecutableScript(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

initRepo(projectRoot);
initRepo(checkoutRoot);
initRepo(otherRoot);
mkdirSync(executableRoot, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fastGodot = join(executableRoot, "godot-fast");
const slowGodot = join(executableRoot, "godot-slow");
const mutatingGodot = join(executableRoot, "godot-mutating");
const failingGodot = join(executableRoot, "godot-failing");
const argsRecord = join(root, "observed-args.txt");

writeExecutableScript(
  fastGodot,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "4.7.1.stable.mono.official.a13da4feb"; exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(argsRecord)}
echo "Godot Engine v4.7.1.stable.mono.official.a13da4feb - https://godotengine.org"
echo "ERROR: Cannot open file \\"res://missing.tscn\\"."
echo "Failed loading resource: res://broken.gd"
echo "Import complete."
exit 0
`,
);
writeExecutableScript(
  slowGodot,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "4.7.1.stable.mono.official.a13da4feb"; exit 0; fi
sleep 2
echo "Import complete."
exit 0
`,
);
writeExecutableScript(
  mutatingGodot,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "4.7.1.stable.mono.official.a13da4feb"; exit 0; fi
echo "mutated" >> tracked.txt
echo "Import complete."
exit 0
`,
);
writeExecutableScript(
  failingGodot,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "4.7.1.stable.mono.official.a13da4feb"; exit 0; fi
echo "ERROR: Failed to import res://scenes/missing.tscn"
echo "Failed to load resource: res://scenes/missing.tscn"
exit 7
`,
);

function writeConfig(
  directory: string,
  overrides: Record<string, unknown>,
): void {
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify(
      {
        allowedRoots: [root],
        stateDir,
        runners: { "godot-mono": { executable: fastGodot } },
        godotImport: {
          enabled: true,
          approvedProjectRoots: [projectRoot, checkoutRoot],
          defaultTimeoutSeconds: 60,
          maxTimeoutSeconds: 120,
        },
        ...overrides,
      },
      null,
      2,
    ),
  );
}

const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function managedWorktreeWorkspace(workspaceRoot: string) {
  return {
    id: `ws_${workspaceRoot.split("/").pop()}`,
    root: workspaceRoot,
    mode: "worktree" as const,
    sourceRoot: workspaceRoot,
    worktree: {
      path: workspaceRoot,
      baseRef: "HEAD",
      baseSha: "0".repeat(40),
      dirtySource: false,
      detached: false,
      managed: true,
      branch: "main",
    },
  };
}

function checkoutWorkspace(workspaceRoot: string) {
  return {
    id: `ws_${workspaceRoot.split("/").pop()}`,
    root: workspaceRoot,
    mode: "checkout" as const,
    sourceRoot: undefined,
    worktree: undefined,
  };
}

try {
  // --- Argument policy: the fixed vector is the only accepted input. -------
  validateGodotEditorImportArguments([...GODOT_EDITOR_IMPORT_ARGS]);
  assert.throws(
    () => validateGodotEditorImportArguments(["--editor", "--import"]),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  assert.throws(
    () =>
      validateGodotEditorImportArguments([
        ...GODOT_EDITOR_IMPORT_ARGS,
        "--path",
        "/tmp",
      ]),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  assert.throws(
    () =>
      validateGodotEditorImportArguments(
        GODOT_EDITOR_IMPORT_ARGS.map((argument) =>
          argument === "." ? ".." : argument,
        ),
      ),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  // The ordinary start_job runner policy still refuses the editor entirely.
  assert.throws(
    () =>
      validateRunnerArguments(
        "godot-mono",
        [...GODOT_EDITOR_IMPORT_ARGS],
        { workspaceRoot: projectRoot, workingDirectory: projectRoot },
      ),
    /RUNNER_ARGUMENT_REJECTED/,
  );

  // --- Godot Mono needs the .NET SDK on PATH ------------------------------
  const minimalEnv = { PATH: "/usr/bin:/bin" };
  const augmented = withDotnetRuntime(minimalEnv, "darwin");
  assert.equal(
    withDotnetRuntime(augmented, "darwin").PATH,
    augmented.PATH,
    "dotnet PATH augmentation must be idempotent",
  );
  if (existsSync("/usr/local/share/dotnet/dotnet")) {
    assert.equal(augmented.DOTNET_ROOT, "/usr/local/share/dotnet");
    assert.equal(
      augmented.PATH?.startsWith("/usr/local/share/dotnet:"),
      true,
      "the .NET SDK directory must be prepended to PATH for Godot Mono",
    );
  } else {
    assert.deepEqual(augmented, minimalEnv);
  }

  // --- Error census ------------------------------------------------------
  const census = censusGodotImportLog(
    [
      "\u001b[31mERROR: Cannot open file 'res://a.tscn'.\u001b[0m",
      "Failed loading resource: res://b.gd",
      "SCRIPT ERROR: Invalid call. Nonexistent function 'foo'",
      "Import complete.",
    ].join("\n"),
  );
  assert.equal(census.errorCount, 1);
  assert.equal(census.importFailureCount, 1);
  assert.equal(census.scriptErrorCount, 1);
  assert.equal(census.truncated, false);
  assert.match(census.errorLines[0], /^ERROR: Cannot open file/);

  // --- Happy path -------------------------------------------------------
  writeConfig(configDir, {});
  const config = loadConfig(baseEnv);
  assert.deepEqual(config.godotImport.fixedArgs, [...GODOT_EDITOR_IMPORT_ARGS]);
  assert.equal(config.godotImport.runner, "godot-mono");
  assert.equal(config.godotImport.argumentPolicy, "godot_editor_import_v1");
  const registry = new GodotImportRegistry();
  const runners = new RunnerRegistry(config.runners);
  const jobs = new BackgroundJobManager(
    config.stateDir,
    runners,
    new ArtifactLedger(config.stateDir),
  );

  const happy = await startGodotImport({
    config,
    workspace: managedWorktreeWorkspace(projectRoot),
    jobs,
    runners,
    registry,
    waitSeconds: 30,
  });
  assert.equal(happy.job.status, "succeeded");
  assert.equal(happy.job.exitCode, 0);
  assert.equal(happy.import.engineVersion, "4.7.1.stable.mono.official.a13da4feb");
  assert.deepEqual(happy.import.args, [...GODOT_EDITOR_IMPORT_ARGS]);
  assert.equal(happy.import.argumentPolicy, "godot_editor_import_v1");
  assert.equal(happy.census?.errorCount, 1);
  assert.equal(happy.census?.importFailureCount, 1);
  assert.equal(happy.after?.headUnchanged, true);
  assert.equal(happy.after?.trackedFilesUnchanged, true);
  assert.equal(happy.anomaly, undefined);
  assert.equal(
    execFileSync("cat", [argsRecord], { encoding: "utf8" }).trim().split("\n").join(" "),
    GODOT_EDITOR_IMPORT_ARGS.join(" "),
    "the spawned Godot process must receive exactly the fixed argument vector",
  );

  // --- Concurrent import of the same project is refused ------------------
  writeConfig(configDir, {
    runners: { "godot-mono": { executable: slowGodot } },
  });
  const slowConfig = loadConfig(baseEnv);
  const slowRunners = new RunnerRegistry(slowConfig.runners);
  const slowJobs = new BackgroundJobManager(
    slowConfig.stateDir,
    slowRunners,
    new ArtifactLedger(slowConfig.stateDir),
  );
  const slowRegistry = new GodotImportRegistry();
  const first = await startGodotImport({
    config: slowConfig,
    workspace: managedWorktreeWorkspace(projectRoot),
    jobs: slowJobs,
    runners: slowRunners,
    registry: slowRegistry,
    waitSeconds: 0,
  });
  assert.equal(first.job.status, "running");
  assert.ok(slowRegistry.activeForProject(godotProjectKey(realpathSync(projectRoot))));

  await assert.rejects(
    () =>
      startGodotImport({
        config: slowConfig,
        workspace: managedWorktreeWorkspace(projectRoot),
        jobs: slowJobs,
        runners: slowRunners,
        registry: slowRegistry,
        waitSeconds: 0,
      }),
    /GODOT_IMPORT_ALREADY_RUNNING/,
  );

  const settled = await finishGodotImportReport({
    jobs: slowJobs,
    registry: slowRegistry,
    jobId: first.job.jobId,
    waitSeconds: 30,
  });
  assert.equal(settled.job.status, "succeeded");
  assert.equal(settled.after?.trackedFilesUnchanged, true);
  assert.equal(
    slowRegistry.activeForProject(godotProjectKey(realpathSync(projectRoot))),
    undefined,
    "the per-project import lock must be released once the job settles",
  );
  slowJobs.close();

  // --- Non-zero exit code is reported, not swallowed ---------------------
  writeConfig(configDir, {
    runners: { "godot-mono": { executable: failingGodot } },
  });
  const failingConfig = loadConfig(baseEnv);
  const failingRunners = new RunnerRegistry(failingConfig.runners);
  const failingJobs = new BackgroundJobManager(
    failingConfig.stateDir,
    failingRunners,
    new ArtifactLedger(failingConfig.stateDir),
  );
  const failing = await startGodotImport({
    config: failingConfig,
    workspace: managedWorktreeWorkspace(projectRoot),
    jobs: failingJobs,
    runners: failingRunners,
    registry: new GodotImportRegistry(),
    waitSeconds: 30,
  });
  assert.equal(failing.job.status, "failed");
  assert.equal(failing.job.exitCode, 7);
  assert.equal(failing.census?.importFailureCount, 1);
  failingJobs.close();

  // --- Tracked-file tampering is reported as an anomaly ------------------
  writeConfig(configDir, {
    runners: { "godot-mono": { executable: mutatingGodot } },
  });
  const mutatingConfig = loadConfig(baseEnv);
  const mutatingRunners = new RunnerRegistry(mutatingConfig.runners);
  const mutatingJobs = new BackgroundJobManager(
    mutatingConfig.stateDir,
    mutatingRunners,
    new ArtifactLedger(mutatingConfig.stateDir),
  );
  const mutating = await startGodotImport({
    config: mutatingConfig,
    workspace: managedWorktreeWorkspace(projectRoot),
    jobs: mutatingJobs,
    runners: mutatingRunners,
    registry: new GodotImportRegistry(),
    waitSeconds: 30,
  });
  assert.equal(mutating.after?.trackedFilesUnchanged, false);
  assert.match(String(mutating.anomaly), /GODOT_IMPORT_MODIFIED_TRACKED_FILES/);
  git(projectRoot, ["checkout", "--", "tracked.txt"]);
  mutatingJobs.close();

  // --- Project / workspace policy rejections ----------------------------
  writeConfig(configDir, {});
  const policyConfig = loadConfig(baseEnv);
  const policyRunners = new RunnerRegistry(policyConfig.runners);

  await assert.rejects(
    () =>
      resolveGodotImportProject(
        policyConfig,
        managedWorktreeWorkspace(otherRoot),
      ),
    /GODOT_PROJECT_NOT_APPROVED/,
  );

  await assert.rejects(
    () =>
      resolveGodotImportProject(policyConfig, {
        root: join(root, "missing-project"),
        mode: "checkout",
        sourceRoot: projectRoot,
        worktree: undefined,
      }),
    /GODOT_PROJECT_NOT_FOUND/,
  );

  // A dirty non-managed checkout is refused before any editor process runs.
  writeFileSync(join(checkoutRoot, "tracked.txt"), "dirty\n");
  await assert.rejects(
    () =>
      resolveGodotImportProject(policyConfig, checkoutWorkspace(checkoutRoot)),
    /GODOT_IMPORT_WORKSPACE_NOT_TRUSTED/,
  );
  git(checkoutRoot, ["checkout", "--", "tracked.txt"]);
  const cleanCheckout = await resolveGodotImportProject(
    policyConfig,
    checkoutWorkspace(checkoutRoot),
  );
  assert.equal(cleanCheckout.managedWorktree, false);
  assert.equal(cleanCheckout.root, realpathSync(checkoutRoot));

  // A disabled policy fails closed.
  const disabledDir = join(root, "config-disabled");
  mkdirSync(disabledDir, { recursive: true });
  writeConfig(disabledDir, {
    godotImport: {
      enabled: false,
      approvedProjectRoots: [projectRoot],
    },
  });
  const disabledConfig = loadConfig({
    ...baseEnv,
    DEVSPACE_CONFIG_DIR: disabledDir,
  });
  await assert.rejects(
    () =>
      resolveGodotImportProject(
        disabledConfig,
        managedWorktreeWorkspace(projectRoot),
      ),
    /GODOT_IMPORT_POLICY_DISABLED/,
  );

  // An enabled policy without approved projects is rejected at load time.
  const badDir = join(root, "config-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(
    join(badDir, "config.json"),
    JSON.stringify({
      allowedRoots: [root],
      stateDir,
      godotImport: { enabled: true, approvedProjectRoots: [] },
    }),
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, DEVSPACE_CONFIG_DIR: badDir }),
    /Enabled godotImport requires at least one approvedProjectRoots entry/,
  );

  // Timeout policy is bounded by the operator maximum.
  assert.equal(godotImportTimeoutSeconds(policyConfig, undefined), 60);
  assert.equal(godotImportTimeoutSeconds(policyConfig, 5), 5);
  assert.throws(
    () => godotImportTimeoutSeconds(policyConfig, 121),
    /GODOT_IMPORT_INPUT_INVALID/,
  );
  assert.throws(
    () => godotImportTimeoutSeconds(policyConfig, 0),
    /GODOT_IMPORT_INPUT_INVALID/,
  );

  // The runner registry still refuses a non-godot-mono runner for the flag.
  await assert.rejects(
    () =>
      jobs.start({
        workspaceId: "ws_test",
        workspaceRoot: projectRoot,
        workingDirectory: projectRoot,
        runner: "godot",
        args: [...GODOT_EDITOR_IMPORT_ARGS],
        godotEditorImport: true,
      }),
    /Godot editor import requires the godot-mono runner/,
  );
  await assert.rejects(
    () =>
      jobs.start({
        workspaceId: "ws_test",
        workspaceRoot: projectRoot,
        workingDirectory: projectRoot,
        runner: "godot-mono",
        args: ["--headless", "--import"],
        godotEditorImport: true,
      }),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  jobs.close();

  console.log("godot-import tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
