import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
