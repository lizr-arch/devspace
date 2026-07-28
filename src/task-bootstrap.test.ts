import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkManifestIntegrity,
  computeManifestSha256,
  loadTaskManifest,
} from "./task-manifest.js";
import {
  type EnvironmentInfo,
  TaskRunner,
  resolveWorkspacePythonEnvironment,
} from "./task-runner.js";
import { TaskError } from "./task-errors.js";
import { InMemorySecretResolver } from "./secret-resolver.js";

const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
const pythonName = process.platform === "win32" ? "python.exe" : "python";

function createFixture(): {
  root: string;
  operatorScript: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "devspace-bootstrap-"));
  mkdirSync(join(root, ".devspace"), { recursive: true });
  const operatorScript = join(root, "operator-bootstrap.mjs");
  writeFileSync(
    operatorScript,
    `import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const target = args[2];
appendFileSync(join(process.cwd(), "operator-invocations.log"), JSON.stringify(args) + "\\n");
if (existsSync(join(process.cwd(), "slow-bootstrap"))) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const targetPath = join(process.cwd(), target);
const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
const pythonName = process.platform === "win32" ? "python.exe" : "python";
mkdirSync(join(targetPath, scriptsDir), { recursive: true });
writeFileSync(join(targetPath, scriptsDir, pythonName), "placeholder");
process.stdout.write(process.env.BOOTSTRAP_SECRET ?? "bootstrapped");
process.stderr.write(" operator=" + process.execPath);
if (existsSync(join(process.cwd(), "fail-bootstrap"))) process.exit(9);
writeFileSync(join(targetPath, "pyvenv.cfg"), "home = operator\\n");
writeFileSync(join(targetPath, ".ready"), "ready\\n");
`,
    "utf8",
  );
  return {
    root,
    operatorScript,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeManifest(root: string, body: string): void {
  writeFileSync(
    join(root, ".devspace", "tasks.yaml"),
    `version: 1\ntasks:\n${body}`,
    "utf8",
  );
}

function bootstrapManifest(extra = ""): string {
  return `  bootstrap:
    mode: run
    command: ["-m", "venv", ".venv"]
    runtime: operator-python-bootstrap
    timeout_seconds: 5
${extra}`;
}

function fakeWorkspaceResolver(
  executableOverride?: string,
): (
  root: string,
  platform?: NodeJS.Platform,
  options?: { allowIncompleteTarget?: ".venv" | "venv" },
) => EnvironmentInfo {
  return (root, platform = process.platform, options = {}) => {
    for (const target of [".venv", "venv"] as const) {
      const targetPath = join(root, target);
      const markerPath = join(targetPath, ".devspace-bootstrap-incomplete");
      if (existsSync(markerPath) && options.allowIncompleteTarget !== target) {
        continue;
      }
      if (
        existsSync(join(targetPath, "pyvenv.cfg")) &&
        existsSync(join(targetPath, ".ready"))
      ) {
        return {
          resolvedExecutable:
            executableOverride ??
            join(
              targetPath,
              platform === "win32" ? "Scripts" : "bin",
              platform === "win32" ? "python.exe" : "python",
            ),
          pythonVersion: "3.11.test",
          environmentSource: target,
          dependencyLockPath: null,
          dependencyLockSha256: null,
        };
      }
    }
    throw new TaskError({
      code: "TASK_ENVIRONMENT_UNAVAILABLE",
      message: "No valid fixture venv.",
      recoverable: true,
    });
  };
}

function createRunner(
  fixture: ReturnType<typeof createFixture>,
  executableOverride?: string,
): TaskRunner {
  return new TaskRunner({
    operatorPythonCommand: [process.execPath, fixture.operatorScript],
    workspacePythonResolver: fakeWorkspaceResolver(executableOverride),
  });
}

async function run(
  runner: TaskRunner,
  root: string,
  taskId: string,
  params: Record<string, string> = {},
) {
  return runner.runTask({
    workspaceId: "ws_bootstrap",
    workspaceRoot: root,
    taskId,
    params,
    additionalRoots: [],
  });
}

// Ordinary Python tasks fail closed without a workspace venv.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      `  ordinary:
    mode: run
    command: ["-c", "print('ordinary')"]
    runtime: workspace-python
`,
    );
    await assert.rejects(
      () => run(createRunner(fixture), fixture.root, "ordinary"),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_ENVIRONMENT_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
}

// Bootstrap is unavailable unless the operator configured an interpreter.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    await assert.rejects(
      () => run(new TaskRunner(), fixture.root, "bootstrap"),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_BOOTSTRAP_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
}

// A bootstrap creates only the declared workspace target and hides operator paths.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    const result = await run(createRunner(fixture), fixture.root, "bootstrap");
    assert.equal(result.mode, "run");
    assert.equal(result.status, "succeeded");
    if (result.mode === "run") {
      assert.deepEqual(result.bootstrap, {
        outcome: "created",
        target: ".venv",
      });
      assert.ok(!JSON.stringify(result).includes(fixture.operatorScript));
      assert.ok(!JSON.stringify(result).includes(process.execPath));
      assert.ok(result.stderr.includes("[OPERATOR_PYTHON]"));
    }
    assert.ok(existsSync(join(fixture.root, ".venv", "pyvenv.cfg")));
    assert.ok(!existsSync(join(dirname(fixture.root), "venv")));
  } finally {
    fixture.cleanup();
  }
}

// Bootstrap target traversal and parameterized targets are rejected at parse time.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      `  escape:
    mode: run
    command: ["-m", "venv", "../venv"]
    runtime: operator-python-bootstrap
`,
    );
    assert.throws(
      () => loadTaskManifest(fixture.root),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_MANIFEST_SCHEMA_ERROR",
    );
  } finally {
    fixture.cleanup();
  }
}

// Callers cannot smuggle an executable or destination through task parameters.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    await assert.rejects(
      () =>
        run(createRunner(fixture), fixture.root, "bootstrap", {
          operatorPython: "/tmp/attacker-python",
          target: "../venv",
        }),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_PARAMETER_SCHEMA_INVALID",
    );
    assert.ok(!existsSync(join(fixture.root, "operator-invocations.log")));
  } finally {
    fixture.cleanup();
  }
}

// Manifest approval is invalidated before a changed bootstrap can execute.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    const approved = {
      manifestSha256: computeManifestSha256(fixture.root)!,
      taskIds: ["bootstrap"],
    };
    assert.ok(checkManifestIntegrity(fixture.root, approved));
    writeManifest(fixture.root, bootstrapManifest("    timeout_seconds: 10\n"));
    assert.equal(checkManifestIntegrity(fixture.root, approved), false);
  } finally {
    fixture.cleanup();
  }
}

// Bootstrap transitions the workspace into the ordinary workspace-python state.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      `${bootstrapManifest()}  ordinary:
    mode: run
    command: ["-e", "console.log(process.env.VIRTUAL_ENV)"]
    runtime: workspace-python
`,
    );
    const runner = createRunner(fixture, process.execPath);
    const bootstrap = await run(runner, fixture.root, "bootstrap");
    assert.equal(bootstrap.mode, "run");
    assert.equal(bootstrap.status, "succeeded");
    const ordinary = await run(runner, fixture.root, "ordinary");
    assert.equal(ordinary.mode, "run");
    assert.equal(ordinary.status, "succeeded");
    if (ordinary.mode === "run") {
      assert.equal(ordinary.runtime.environmentSource, ".venv");
      assert.ok(ordinary.stdout.includes(join(fixture.root, ".venv")));
    }
  } finally {
    fixture.cleanup();
  }
}

// Configuring an operator interpreter never becomes an ordinary-task fallback.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      `  ordinary:
    mode: run
    command: ["-c", "print('ordinary')"]
    runtime: workspace-python
`,
    );
    await assert.rejects(
      () => run(createRunner(fixture), fixture.root, "ordinary"),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_ENVIRONMENT_UNAVAILABLE",
    );
    assert.ok(!existsSync(join(fixture.root, "operator-invocations.log")));
  } finally {
    fixture.cleanup();
  }
}

// Bootstrap output uses the same secret redaction path as ordinary tasks.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      bootstrapManifest(`    secrets:
      - secret_ref: bootstrap_secret
        target_env: BOOTSTRAP_SECRET
`),
    );
    const runner = createRunner(fixture);
    const secrets = new InMemorySecretResolver();
    secrets.set("bootstrap_secret", "BOOTSTRAP_SECRET_VALUE");
    runner.setSecretResolver(secrets);
    const result = await run(runner, fixture.root, "bootstrap");
    assert.equal(result.mode, "run");
    if (result.mode === "run") {
      assert.ok(result.stdout.includes("[REDACTED_SECRET]"));
      assert.ok(!JSON.stringify(result).includes("BOOTSTRAP_SECRET_VALUE"));
    }
  } finally {
    fixture.cleanup();
  }
}

// A failed creation removes or quarantines the half environment.
{
  const fixture = createFixture();
  try {
    writeManifest(
      fixture.root,
      `${bootstrapManifest()}  ordinary:
    mode: run
    command: ["-c", "print('ordinary')"]
    runtime: workspace-python
`,
    );
    writeFileSync(join(fixture.root, "fail-bootstrap"), "fail\n");
    const runner = createRunner(fixture);
    const result = await run(runner, fixture.root, "bootstrap");
    assert.equal(result.mode, "run");
    assert.equal(result.status, "failed");
    assert.ok(!existsSync(join(fixture.root, ".venv")));
    await assert.rejects(
      () => run(runner, fixture.root, "ordinary"),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_ENVIRONMENT_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
}

// A second identical bootstrap is an idempotent no-op.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    const runner = createRunner(fixture);
    await run(runner, fixture.root, "bootstrap");
    const before = readFileSync(
      join(fixture.root, "operator-invocations.log"),
      "utf8",
    );
    const second = await run(runner, fixture.root, "bootstrap");
    assert.equal(second.mode, "run");
    if (second.mode === "run") {
      assert.deepEqual(second.bootstrap, {
        outcome: "unchanged",
        target: ".venv",
      });
    }
    assert.equal(
      readFileSync(join(fixture.root, "operator-invocations.log"), "utf8"),
      before,
    );
  } finally {
    fixture.cleanup();
  }
}

// Concurrent bootstrap attempts are serialized per workspace target.
{
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    writeFileSync(join(fixture.root, "slow-bootstrap"), "slow\n");
    const runner = createRunner(fixture);
    const first = run(runner, fixture.root, "bootstrap");
    await assert.rejects(
      () => run(runner, fixture.root, "bootstrap"),
      (error: unknown) =>
        error instanceof TaskError && error.code === "TASK_BOOTSTRAP_CONFLICT",
    );
    const completed = await first;
    assert.equal(completed.mode, "run");
    assert.equal(completed.status, "succeeded");
  } finally {
    fixture.cleanup();
  }
}

// Symlinked bootstrap targets are never adopted.
if (process.platform !== "win32") {
  const fixture = createFixture();
  const outside = mkdtempSync(join(tmpdir(), "devspace-bootstrap-outside-"));
  try {
    writeManifest(fixture.root, bootstrapManifest());
    symlinkSync(outside, join(fixture.root, ".venv"), "dir");
    await assert.rejects(
      () => run(createRunner(fixture), fixture.root, "bootstrap"),
      (error: unknown) =>
        error instanceof TaskError && error.code === "TASK_BOOTSTRAP_CONFLICT",
    );
    assert.equal(existsSync(join(outside, "pyvenv.cfg")), false);
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
}

// The production resolver rejects python-shaped half environments.
{
  const fixture = createFixture();
  try {
    const target = join(fixture.root, ".venv");
    mkdirSync(join(target, scriptsDir), { recursive: true });
    writeFileSync(join(target, "pyvenv.cfg"), "home = broken\n");
    writeFileSync(join(target, scriptsDir, pythonName), "not executable\n");
    assert.throws(
      () => resolveWorkspacePythonEnvironment(fixture.root),
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "TASK_ENVIRONMENT_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
}

// Opt-in real-interpreter smoke for deployment and release gates.
if (process.env.DEVSPACE_TEST_OPERATOR_PYTHON) {
  const fixture = createFixture();
  try {
    writeManifest(fixture.root, bootstrapManifest());
    const runner = new TaskRunner({
      operatorPythonCommand: [process.env.DEVSPACE_TEST_OPERATOR_PYTHON],
    });
    const result = await run(runner, fixture.root, "bootstrap");
    assert.equal(result.mode, "run");
    assert.equal(result.status, "succeeded");
    const environment = resolveWorkspacePythonEnvironment(fixture.root);
    assert.equal(environment.environmentSource, ".venv");
  } finally {
    fixture.cleanup();
  }
}

console.log("PASS: operator Python bootstrap state and rollback tests");
