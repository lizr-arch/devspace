import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  MAX_CONCURRENT_JOBS,
  MAX_JOB_TIMEOUT_SECONDS,
  RUNNER_NAMES,
  RunnerRegistry,
  validateRunnerArguments,
} from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-runner-registry-"));
const workspaceRoot = join(root, "workspace");
const outsideRoot = join(root, "outside");
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(outsideRoot, { recursive: true });
symlinkSync(outsideRoot, join(workspaceRoot, "escape"));

try {
  assert.deepEqual(RUNNER_NAMES, [
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
  ]);

  for (const [runner, args] of [
    ["npm", ["test"]],
    ["pnpm", ["typecheck"]],
    ["yarn", ["lint"]],
    ["bun", ["build"]],
    ["dotnet", ["build"]],
    ["cargo", ["check"]],
    ["pytest", ["tests"]],
    ["godot", ["--headless", "--path", "."]],
    ["godot-mono", ["--headless", "--path", "."]],
  ] as const) {
    validateRunnerArguments(runner, [...args], {
      workspaceRoot,
      workingDirectory: workspaceRoot,
    });
  }

  const blenderScript = join(workspaceRoot, "create_asset.py");
  mkdirSync(join(workspaceRoot, "render"), { recursive: true });
  writeFileSync(blenderScript, "# fixture");
  validateRunnerArguments(
    "blender",
    [
      "--background",
      "--factory-startup",
      "--offline-mode",
      "--disable-autoexec",
      "--python-exit-code",
      "23",
      "--python",
      "create_asset.py",
      "--render-output",
      "render/preview.png",
      "--render-format",
      "PNG",
      "--engine",
      "BLENDER_EEVEE_NEXT",
    ],
    {
      workspaceRoot,
      workingDirectory: workspaceRoot,
    },
  );
  assert.throws(
    () =>
      validateRunnerArguments(
        "blender",
        ["--background", "--python-expr", "print(1)"],
        { workspaceRoot, workingDirectory: workspaceRoot },
      ),
    /disabled by the V1 policy/,
  );
  assert.throws(
    () =>
      validateRunnerArguments(
        "blender",
        ["--background", "--python", "escape/outside.py"],
        { workspaceRoot, workingDirectory: workspaceRoot },
      ),
    /WORKSPACE_ESCAPE/,
  );
  assert.throws(
    () =>
      validateRunnerArguments("blender", ["--python", "create_asset.py"], {
        workspaceRoot,
        workingDirectory: workspaceRoot,
      }),
    /must include --background/,
  );
  assert.throws(
    () =>
      validateRunnerArguments(
        "blender",
        [
          "--background",
          "--python",
          "create_asset.py",
          "--python-exit-code",
          "23",
        ],
        { workspaceRoot, workingDirectory: workspaceRoot },
      ),
    /must appear before --python/,
  );

  assert.throws(
    () => new RunnerRegistry().getDefinition("unregistered"),
    /RUNNER_UNAVAILABLE/,
  );
  assert.throws(
    () => validateRunnerArguments("npm", ["run typecheck"]),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  assert.throws(
    () => validateRunnerArguments("npm", ["run", "typecheck && whoami"]),
    /RUNNER_ARGUMENT_REJECTED/,
  );
  assert.throws(
    () =>
      validateRunnerArguments("pytest", ["escape/result.json"], {
        workspaceRoot,
        workingDirectory: workspaceRoot,
      }),
    /WORKSPACE_ESCAPE/,
  );

  const disabled = new RunnerRegistry({
    npm: { enabled: false },
  });
  await assert.rejects(() => disabled.resolve("npm"), /disabled/);

  const missing = new RunnerRegistry({
    npm: { executable: join(root, "missing-npm") },
  });
  await assert.rejects(() => missing.resolve("npm"), /does not exist/);

  const configured = new RunnerRegistry({
    npm: {
      executable: process.execPath,
      maxTimeoutSeconds: 30,
      maxConcurrent: 1,
    },
  });
  const resolved = await configured.resolve("npm");
  assert.equal(resolved.executable, process.execPath);
  assert.equal(resolved.definition.maxTimeoutSeconds, 30);
  assert.equal(resolved.definition.maxConcurrent, 1);
  assert.match(resolved.version ?? "", /^v\d+/);

  if (process.platform !== "win32") {
    const launchdBin = join(root, "launchd-bin");
    mkdirSync(launchdBin);
    symlinkSync(process.execPath, join(launchdBin, "node"));
    const launchdNpm = join(launchdBin, "npm");
    writeFileSync(
      launchdNpm,
      '#!/usr/bin/env node\nconsole.log("10.9.8-launchd-test");\n',
      { mode: 0o700 },
    );
    const launchdRegistry = new RunnerRegistry(
      { npm: { executable: launchdNpm } },
      process.platform,
      {
        HOME: root,
        PATH: ["/usr/bin", "/bin"].join(delimiter),
      },
    );
    const launchdResolved = await launchdRegistry.resolve("npm");
    assert.equal(launchdResolved.version, "10.9.8-launchd-test");
    assert.equal(
      launchdResolved.environment.PATH?.split(delimiter)[0],
      launchdBin,
    );
    launchdResolved.environment.PATH = "/mutated";
    const cachedLaunchdResolved = await launchdRegistry.resolve("npm");
    assert.equal(
      cachedLaunchdResolved.environment.PATH?.split(delimiter)[0],
      launchdBin,
    );
  }

  const invalid = new RunnerRegistry({
    npm: {
      executable: "relative/npm",
      maxTimeoutSeconds: MAX_JOB_TIMEOUT_SECONDS + 1,
      maxConcurrent: MAX_CONCURRENT_JOBS + 1,
    },
    arbitrary: {
      executable: process.execPath,
    },
  });
  assert.equal(invalid.configurationDiagnostics.length, 4);
  assert.ok(
    invalid.configurationDiagnostics.every((entry) =>
      entry.startsWith("RUNNER_CONFIG_INVALID:"),
    ),
  );

  const unsupported = new RunnerRegistry({}, "aix");
  const inspection = await unsupported.inspectAll();
  assert.equal(inspection.runners.length, RUNNER_NAMES.length);
  assert.ok(inspection.runners.every((runner) => !runner.available));
  assert.ok(inspection.runners.every((runner) => !runner.supported));

  console.log("runner registry tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
