import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { resolveWorkspacePythonEnvironment } from "./task-runner.js";
import {
  computeEnvironmentFingerprint,
  computeCapabilityFingerprint,
} from "./task-manifest.js";
import { TaskError } from "./task-errors.js";

const isWin = process.platform === "win32";
const scriptsDir = isWin ? "Scripts" : "bin";
const pythonName = isWin ? "python.exe" : "python";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake .venv/venv structure. Returns the python path.
 *
 * On Unix: creates a shell script that uses process.execPath (Node.js) to
 * handle --version output. This lets us test version extraction.
 *
 * On Windows: creates a .cmd file pointing to a Node.js wrapper. Since
 * execFileSync can't run .cmd files directly (needs shell), version detection
 * will gracefully fail (null) — but path resolution and lock file detection
 * are still tested.
 */
function createFakeVenv(
  base: string,
  venvName: string,
  versionStr: string,
  lockContent?: string,
): string {
  const venvRoot = join(base, venvName);
  const venvScripts = join(venvRoot, scriptsDir);
  mkdirSync(venvScripts, { recursive: true });

  if (isWin) {
    // Windows: create a minimal file that passes existsSync + statSync.isFile().
    // execFileSync will fail (not a valid PE), but version detection gracefully
    // returns null. Path resolution and lock file detection still work.
    const pythonExe = join(venvScripts, pythonName);
    writeFileSync(pythonExe, " ");
  } else {
    // Unix: shell script wrapper
    const python = join(venvScripts, pythonName);
    const wrapperJs = join(venvScripts, "_python_wrapper.js");

    writeFileSync(
      wrapperJs,
      `const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${versionStr}');
  process.exit(0);
}
if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'list') {
  console.log('[]');
  process.exit(0);
}
console.log(JSON.stringify({ argv: args }));
`,
    );
    writeFileSync(
      python,
      `#!/bin/sh\nexec "${process.execPath}" "${wrapperJs}" "$@"\n`,
    );
    chmodSync(python, 0o700);
  }

  if (lockContent !== undefined) {
    writeFileSync(join(base, "requirements.txt"), lockContent, "utf8");
  }

  return join(venvScripts, pythonName);
}

// ---------------------------------------------------------------------------
// Test 1: .venv is correctly resolved
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test1-"));
  try {
    const python = createFakeVenv(root, ".venv", "Python 3.11.9");
    const info = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.resolvedExecutable, python);
    assert.equal(info.environmentSource, ".venv");
    console.log("PASS: test1 - .venv resolved correctly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 2: venv (no dot) resolved
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test2-"));
  try {
    createFakeVenv(root, "venv", "Python 3.10.1");
    const info = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.environmentSource, "venv");
    console.log("PASS: test2 - venv (no dot) resolved correctly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 3: Python version extraction (Unix only)
// ---------------------------------------------------------------------------
if (!isWin) {
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test3-"));
  try {
    createFakeVenv(root, ".venv", "Python 3.12.4");
    const info = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.pythonVersion, "3.12.4");
    console.log("PASS: test3 - Python version correct");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  console.log("SKIP: test3 - version extraction (needs shell on Windows exec)");
}

// ---------------------------------------------------------------------------
// Test 4: Dependency lock SHA
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test4-"));
  try {
    const lockContent = "package==1.0.0\nother-package==2.0.0\n";
    createFakeVenv(root, ".venv", "Python 3.11.9", lockContent);

    const info = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.dependencyLockPath, "requirements.txt");
    assert.ok(info.dependencyLockSha256);
    assert.equal(info.dependencyLockSha256.length, 64);

    const info2 = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.dependencyLockSha256, info2.dependencyLockSha256);
    console.log("PASS: test4 - dependency lock SHA correct and deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 5: TASK_ENVIRONMENT_UNAVAILABLE when no .venv
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test5-"));
  try {
    assert.throws(
      () => resolveWorkspacePythonEnvironment(root),
      (err: unknown) => {
        if (!(err instanceof TaskError)) return false;
        return err.code === "TASK_ENVIRONMENT_UNAVAILABLE";
      },
    );
    console.log("PASS: test5 - TASK_ENVIRONMENT_UNAVAILABLE when no .venv");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6: TASK_ENVIRONMENT_UNAVAILABLE field-level detail
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test6-"));
  try {
    try {
      resolveWorkspacePythonEnvironment(root);
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof TaskError);
      const taskErr = err as TaskError;
      assert.equal(taskErr.code, "TASK_ENVIRONMENT_UNAVAILABLE");
      assert.equal(taskErr.field, "runtime.venv");
      assert.ok(taskErr.message.includes("virtual environment"));
      assert.ok(taskErr.recoverable);
    }
    console.log("PASS: test6 - field-level detail on error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 7: No silent switch to another Python
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test7-"));
  try {
    assert.throws(
      () => resolveWorkspacePythonEnvironment(root),
      (err: unknown) => {
        if (!(err instanceof TaskError)) return false;
        return err.code === "TASK_ENVIRONMENT_UNAVAILABLE";
      },
      "Should throw TASK_ENVIRONMENT_UNAVAILABLE, not silently fall back",
    );
    console.log("PASS: test7 - no silent switch to another Python");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 8: MCP caller cannot override executable
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test8-"));
  try {
    createFakeVenv(root, ".venv", "Python 3.11.9");
    const info = resolveWorkspacePythonEnvironment(root);
    assert.ok(info.resolvedExecutable.includes(".venv"));
    assert.equal(resolveWorkspacePythonEnvironment.length, 1);
    console.log("PASS: test8 - MCP caller cannot override executable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 9: computeEnvironmentFingerprint
// ---------------------------------------------------------------------------
{
  const fp = computeEnvironmentFingerprint({
    environmentSource: ".venv",
    pythonVersion: "3.11.9",
    dependencyLockPath: "requirements.txt",
    dependencyLockSha256: "abc123",
  });
  assert.equal(fp.environmentSource, ".venv");
  assert.equal(fp.pythonVersion, "3.11.9");
  assert.equal(fp.dependencyLockPath, "requirements.txt");
  assert.equal(fp.dependencyLockSha256, "abc123");
  console.log("PASS: test9 - computeEnvironmentFingerprint works");
}

// ---------------------------------------------------------------------------
// Test 10: computeCapabilityFingerprint with environment
// ---------------------------------------------------------------------------
{
  const fp = computeCapabilityFingerprint({
    manifestSha256: "sha256abc",
    taskIds: ["task1", "task2"],
    environment: {
      environmentSource: ".venv",
      pythonVersion: "3.11.9",
      dependencyLockPath: null,
      dependencyLockSha256: null,
    },
  });
  assert.equal(fp.manifestSha256, "sha256abc");
  assert.deepEqual(fp.taskIds, ["task1", "task2"]);
  assert.ok(fp.environment);
  assert.equal(fp.environment.environmentSource, ".venv");
  assert.ok(fp.computedAt);
  console.log("PASS: test10 - computeCapabilityFingerprint with env");
}

// ---------------------------------------------------------------------------
// Test 11: computeCapabilityFingerprint without environment
// ---------------------------------------------------------------------------
{
  const fp = computeCapabilityFingerprint({
    manifestSha256: null,
    taskIds: [],
  });
  assert.equal(fp.environment, undefined);
  console.log("PASS: test11 - CapabilityFingerprint without env");
}

// ---------------------------------------------------------------------------
// Test 12: .venv preferred over venv
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), "devspace-task-env-test12-"));
  try {
    createFakeVenv(root, ".venv", "Python 3.11.9");
    createFakeVenv(root, "venv", "Python 3.10.1");
    const info = resolveWorkspacePythonEnvironment(root);
    assert.equal(info.environmentSource, ".venv");
    console.log("PASS: test12 - .venv preferred over venv");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\nAll tests passed!");
