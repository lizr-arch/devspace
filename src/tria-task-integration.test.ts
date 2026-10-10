/**
 * M2: TriaRegna test-task integration.
 *
 * Verifies the DevSpace-side contract that lets a remote agent run the
 * repository's own test entrypoints as structured tasks:
 *
 *   - a declared parameter can only ever be an allowlisted value, and the
 *     previously-dead `pattern` field is now actually enforced;
 *   - a tool named as `command[0]` resolves through the runner registry so
 *     launchd's minimal PATH cannot break `dotnet`/`godot-mono` tasks;
 *   - structured parsing never turns a non-zero exit code into a pass, and
 *     never reports a headless run as GUI evidence;
 *   - a result whose source/assembly inputs moved underneath it is flagged.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTaskManifest,
  validateAndSubstitute,
  computeManifestSha256,
} from "./task-manifest.js";
import { TaskRunner } from "./task-runner.js";
import { parseTaskResult } from "./task-results.js";
import { compareTaskInputs, captureTaskInputFingerprint } from "./task-fingerprint.js";
import { withDotnetRuntime, dotnetRootCandidates } from "./runner-validation.js";

const root = mkdtempSync(join(tmpdir(), "devspace-tria-"));

try {
  testPatternAndEnumAreEnforced();
  testStructuredParser();
  testFingerprintStability();
  testRunnerPathAugmentation();
  await testFastRejectsUnknownRunnerArgs();
  await testTaskRunnerResolvesDeclaredTool();
  await testRealTriaManifest();
  console.log("tria task integration tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** Assert a load failure carries the documented structured error code. */
function assertTaskErrorCode(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    assert.equal(
      (error as { code?: string }).code,
      "TASK_PARAMETER_SCHEMA_INVALID",
      `expected TASK_PARAMETER_SCHEMA_INVALID, got ${String(error)}`,
    );
    return;
  }
  assert.fail("expected the manifest to be rejected");
}

function writeManifest(body: string): string {
  const dir = mkdtempSync(join(root, "ws-"));
  mkdirSync(join(dir, ".devspace"), { recursive: true });
  writeFileSync(join(dir, ".devspace", "tasks.yaml"), body);
  return dir;
}

/**
 * `pattern` was declared in the schema, parsed, type-checked — and then never
 * read. A manifest could therefore claim a constraint that did nothing.
 */
function testPatternAndEnumAreEnforced(): void {
  const dir = writeManifest(`version: 1
tasks:
  guarded:
    mode: run
    runtime: system
    command: ["echo", "\${suite}"]
    parameters:
      suite:
        type: string
        required: true
        pattern: "^[A-Za-z0-9_]+$"
  choose:
    mode: run
    runtime: system
    command: ["echo", "\${mode}"]
    parameters:
      mode:
        type: string
        required: true
        enum: ["build", "core"]
`);
  const manifest = loadTaskManifest(dir);
  assert.ok(manifest, "the fixture manifest must load");
  assert.equal(computeManifestSha256(dir)?.length, 64);

  const guarded = manifest.tasks.guarded;
  assert.equal(guarded.parameters?.suite.pattern, "^[A-Za-z0-9_]+$");

  for (const good of ["CoreTestRunner", "MapEditorPhase19M2TerrainAcceptanceTestRunner"]) {
    const result = validateAndSubstitute(guarded, { suite: good }, dir, [dir]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.command, ["echo", good]);
  }
  // Every one of these would be dangerous if it reached argv unchecked.
  for (const bad of [
    "bad name",
    "../escape",
    "a;rm -rf /",
    "x$(whoami)",
    "a|b",
    "a`b`",
    "a>b",
    "",
    "a/b",
  ]) {
    const result = validateAndSubstitute(guarded, { suite: bad }, dir, [dir]);
    assert.equal(
      result.errors.length,
      1,
      `pattern must reject ${JSON.stringify(bad)}`,
    );
    assert.match(result.errors[0].message, /pattern/);
  }
  // A missing required parameter must fail, not substitute an empty string.
  const missing = validateAndSubstitute(guarded, {}, dir, [dir]);
  assert.match(missing.errors[0].message, /Required parameter suite is missing/);

  const choose = manifest.tasks.choose;
  assert.deepEqual(choose.parameters?.mode.enum, ["build", "core"]);
  assert.deepEqual(
    validateAndSubstitute(choose, { mode: "core" }, dir, [dir]).command,
    ["echo", "core"],
  );
  const rejected = validateAndSubstitute(choose, { mode: "release" }, dir, [dir]);
  assert.equal(rejected.errors.length, 1);
  assert.match(rejected.errors[0].message, /must be one of: build, core/);

  // Undeclared parameters stay rejected: no general-purpose argument channel.
  const undeclared = validateAndSubstitute(
    guarded,
    { suite: "ok", extra: "--force" },
    dir,
    [dir],
  );
  assert.match(undeclared.errors[0].message, /Undeclared parameter/);

  // A malformed declaration must fail at load, not silently disable the guard.
  const brokenDir = writeManifest(`version: 1
tasks:
  broken:
    mode: run
    runtime: system
    command: ["echo", "x"]
    parameters:
      p:
        type: string
        pattern: "([unclosed"
`);
  assertTaskErrorCode(() => loadTaskManifest(brokenDir));

  const badEnumDir = writeManifest(`version: 1
tasks:
  broken:
    mode: run
    runtime: system
    command: ["echo", "x"]
    parameters:
      p:
        type: string
        enum: []
`);
  assertTaskErrorCode(() => loadTaskManifest(badEnumDir));
}

/** Real marker lines emitted by tools/triaregna.sh and tools/run_all_tests.sh. */
function testStructuredParser(): void {
  const fastPass = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: ["bash", "tools/triaregna.sh", "fast", "--suite", "X"],
    output: [
      "[fast] build (logs: /tmp/triaregna-fast.abc)",
      "[fast] CoreTestRunner PASS 42s",
      "TRIA_REGNA_PIPELINE_TIMING build_s=31 tests_s=42 total_s=73",
      "TRIA_REGNA_FAST_RESULT pass=1 fail=0 log_dir=/tmp/triaregna-fast.abc",
    ].join("\n"),
  });
  assert.equal(fastPass.verdict, "pass");
  assert.equal(fastPass.passCount, 1);
  assert.equal(fastPass.failCount, 0);
  assert.equal(fastPass.buildSeconds, 31);
  assert.equal(fastPass.testSeconds, 42);
  assert.equal(fastPass.totalSeconds, 73);
  assert.equal(fastPass.logDirectory, "/tmp/triaregna-fast.abc");
  assert.equal(fastPass.scope, "local");
  assert.equal(fastPass.suites.length, 1);
  assert.equal(fastPass.suites[0].name, "CoreTestRunner");
  assert.equal(fastPass.suites[0].durationSeconds, 42);
  assert.equal(fastPass.headless, false);
  assert.equal(fastPass.realGui, true);
  assert.ok(
    fastPass.skippedChecks.some((entry) => /core, full, editor and release/.test(entry)),
    "a fast run must declare that it is not a full regression",
  );

  // A build failure exits non-zero and must never read as a pass.
  const buildFailed = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 1,
    command: ["bash", "tools/triaregna.sh", "fast", "--suite", "X"],
    output: "TRIA_REGNA_FAST_RESULT pass=0 fail=1 (build_failed)",
  });
  assert.equal(buildFailed.verdict, "fail");
  assert.match(buildFailed.reasons.join(" "), /exited with code 1/);
  assert.ok(
    buildFailed.skippedChecks.some((entry) => /build failed/.test(entry)),
  );

  // Exit 0 but a failure marker present: markers must weaken a pass.
  const markerFail = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: ["bash", "tools/run_all_tests.sh"],
    output: [
      "[FAIL] something broke",
      "TRIA_REGNA_SUITE_RESULT pass=3 fail=0 gates=10",
    ].join("\n"),
  });
  assert.equal(markerFail.verdict, "fail");
  assert.match(markerFail.reasons.join(" "), /failure markers/);

  // Exit 0 with no success marker is NOT a pass.
  const silent = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: ["bash", "tools/triaregna.sh", "build"],
    output: "Build succeeded.\n",
  });
  assert.equal(silent.verdict, "indeterminate");
  assert.match(silent.reasons.join(" "), /zero exit code alone is not a pass/);

  // A core suite reports gate counts.
  const core = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: ["bash", "tools/run_all_tests.sh"],
    output: [
      "ALL 118/118 GATES PASSED",
      "TRIA_REGNA_PIPELINE_TIMING build_s=5 tests_s=600 total_s=605",
      "TRIA_REGNA_SUITE_RESULT pass=24 fail=0 gates=118 core_tests=9",
    ].join("\n"),
  });
  assert.equal(core.verdict, "pass");
  assert.equal(core.gateCount, 118);
  assert.equal(core.scope, "core");
  assert.ok(core.skippedChecks.some((entry) => /editor and release/.test(entry)));

  // Headless runs can never be GUI visual evidence, whatever else they prove.
  const headless = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: [
      "godot-mono",
      "--headless",
      "--scene",
      "res://tests/MapEditorPhase20ReleaseHardeningAcceptanceTestRunner.tscn",
      "--",
      "--runtime-only",
    ],
    output: "TRIA_REGNA_MAP_EDITOR_PHASE20_RUNTIME_PASS",
  });
  assert.equal(headless.headless, true);
  assert.equal(headless.realGui, false);
  assert.equal(headless.verdict, "pass");
  assert.ok(
    headless.skippedChecks.some((entry) => /not GUI evidence/.test(entry)),
  );

  // A run killed by its own timeout is always a failure, never indeterminate.
  const timedOut = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: null,
    command: ["godot-mono", "--path", ".", "--scene", "res://tests/X.tscn"],
    output: "[godot] starting\n",
    timedOut: true,
  });
  assert.equal(timedOut.verdict, "fail");
  assert.match(timedOut.reasons.join(" "), /killed by its own timeout/);
  assert.ok(
    timedOut.skippedChecks.some((entry) => /had to be killed/.test(entry)),
  );

  // Counted suite failures fail even on a zero exit code.
  const counted = parseTaskResult({
    parser: "triaregna_v1",
    exitCode: 0,
    command: ["bash", "tools/triaregna.sh", "fast", "--suite", "X"],
    output: "[fast] X FAIL 3s (exit=1)\nTRIA_REGNA_FAST_RESULT pass=0 fail=1",
  });
  assert.equal(counted.verdict, "fail");
  assert.equal(counted.suites[0].status, "fail");
  assert.equal(counted.suites[0].exitCode, 1);
}

/**
 * The staleness guard: a result must not sign off inputs that changed while it
 * was running.
 */
function testFingerprintStability(): void {
  const dir = mkdtempSync(join(root, "fp-"));
  const before = captureTaskInputFingerprint(dir);
  assert.equal(before.assembly, null, "no assembly exists yet");
  assert.equal(typeof before.dirtyDiffSha256, "string");

  const stable = compareTaskInputs(before, captureTaskInputFingerprint(dir));
  assert.equal(stable.status, "stable");
  assert.deepEqual(stable.changes, []);

  // Simulate a parallel agent writing a new managed assembly mid-run.
  const binDir = join(dir, ".godot", "mono", "temp", "bin", "Debug");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "TriaRegna.dll"), Buffer.from("assembly-v1"));
  const withAssembly = captureTaskInputFingerprint(dir);
  assert.ok(withAssembly.assembly, "the assembly must be fingerprinted");
  assert.match(withAssembly.assembly.sha256, /^[0-9a-f]{64}$/);

  writeFileSync(join(binDir, "TriaRegna.dll"), Buffer.from("assembly-v2-changed"));
  const moved = compareTaskInputs(withAssembly, captureTaskInputFingerprint(dir));
  assert.equal(moved.status, "changed_during_run");
  assert.match(moved.changes.join(" "), /managed assembly changed/);

  const unknown = compareTaskInputs(null, withAssembly);
  assert.equal(unknown.status, "unknown");
}

/**
 * `TaskRunner` spawns with `{...process.env, ...env}`, so under launchd a
 * `dotnet`-based task could not find the SDK. The augmentation must add the
 * real SDK root without inventing one.
 */
function testRunnerPathAugmentation(): void {
  const bare = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const augmented = withDotnetRuntime(bare, process.platform);
  const roots = dotnetRootCandidates(process.platform);
  assert.ok(roots.length > 0, "expected at least one dotnet root candidate");
  const installed = roots.filter((candidate) =>
    existsSync(join(candidate, "dotnet")),
  );
  if (installed.length === 0) {
    // Nothing to assert on a host without the SDK; the helper must no-op.
    assert.equal(augmented.PATH, bare.PATH);
    return;
  }
  assert.notEqual(
    augmented.PATH,
    bare.PATH,
    "an installed dotnet root must be added to PATH",
  );
  assert.ok(augmented.PATH?.split(":").some((entry) => installed.includes(entry)));
  assert.ok(augmented.DOTNET_ROOT);
}

/** The project script must reject a runner that does not exist. */
async function testFastRejectsUnknownRunnerArgs(): Promise<void> {
  const runner = new TaskRunner();
  // Run the real TriaRegna entrypoint only when the repository is present.
  const realRoot = "/Users/liz/agy/TriaRegna";
  if (!existsSync(join(realRoot, "tools", "triaregna.sh"))) return;

  const manifest = loadTaskManifest(realRoot);
  assert.ok(manifest, "the real TriaRegna manifest must load");
  const fast = manifest.tasks["tria-fast"];
  assert.equal(fast.result_parser, "triaregna_v1");
  assert.equal(fast.runtime, "system");

  // Shell metacharacters never reach the project script.
  for (const suite of ["x; rm -rf /", "$(whoami)", "../../etc/passwd"]) {
    const result = validateAndSubstitute(fast, { suite }, realRoot, [realRoot]);
    assert.ok(result.errors.length > 0, `${suite} must be rejected`);
  }

  // A syntactically valid but nonexistent runner must be refused by the
  // project script itself, not silently treated as a pass.
  const run = await runner.runTask({
    workspaceId: "ws_tria_manifest",
    workspaceRoot: realRoot,
    taskId: "tria-fast",
    params: { suite: "ThisRunnerDoesNotExist" },
    additionalRoots: [],
  });
  assert.equal(run.mode, "run");
  if (run.mode !== "run") return;
  assert.notEqual(run.exitCode, 0, "an unknown runner must not exit 0");
  assert.match(run.stderr + run.stdout, /invalid suite/);
  assert.equal(run.structured?.verdict, "fail");
}

/** A declared tool name must resolve to an absolute executable. */
async function testTaskRunnerResolvesDeclaredTool(): Promise<void> {
  const dir = writeManifest(`version: 1
tasks:
  declared-tool:
    mode: run
    runtime: system
    command: ["dotnet", "--version"]
`);
  const runner = new TaskRunner();
  const result = await runner.runTask({
    workspaceId: "ws_declared_tool",
    workspaceRoot: dir,
    taskId: "declared-tool",
    params: {},
    additionalRoots: [],
  });
  assert.equal(result.mode, "run");
  if (result.mode !== "run") return;
  // If the SDK is genuinely absent, the task must fail loudly rather than
  // silently resolving to something else.
  const roots = dotnetRootCandidates(process.platform);
  const installed = roots.some((candidate) =>
    existsSync(join(candidate, "dotnet")),
  );
  if (!installed) {
    assert.notEqual(result.exitCode, 0);
    return;
  }
  assert.equal(
    result.exitCode,
    0,
    `declared dotnet must run under a minimal PATH: ${result.stderr}`,
  );
  assert.match(result.stdout, /^\d+\.\d+\.\d+/m);
  assert.equal(result.runtime.interpreter.startsWith("/"), true);

  // Regression: the resolved absolute path must REPLACE argv[0], not be
  // prepended to it. `<abs>/npm npm --prefix ... test` made npm report
  // "Unknown command: npm", which is how the tria-doc-check task failed.
  const npmDir = writeManifest(`version: 1
tasks:
  declared-npm:
    mode: run
    runtime: system
    command: ["npm", "--version"]
`);
  const npmResult = await runner.runTask({
    workspaceId: "ws_declared_npm",
    workspaceRoot: npmDir,
    taskId: "declared-npm",
    params: {},
    additionalRoots: [],
  });
  assert.equal(npmResult.mode, "run");
  if (npmResult.mode !== "run") return;
  if (npmResult.exitCode !== 0) {
    // npm may be absent on some hosts; the host we ship for has it.
    assert.match(npmResult.stderr, /RUNNER_UNAVAILABLE|not found/i);
    return;
  }
  assert.doesNotMatch(
    npmResult.stderr + npmResult.stdout,
    /Unknown command/i,
    "argv[0] must not be duplicated for a declared tool",
  );
  assert.match(npmResult.stdout, /^\d+\.\d+\.\d+/m);
}

/** The shipped TriaRegna manifest must expose every documented task. */
async function testRealTriaManifest(): Promise<void> {
  const realRoot = "/Users/liz/agy/TriaRegna";
  if (!existsSync(join(realRoot, ".devspace", "tasks.yaml"))) return;
  const manifest = loadTaskManifest(realRoot);
  assert.ok(manifest);
  for (const id of [
    "tria-build",
    "tria-fast",
    "tria-core",
    "tria-full",
    "tria-doc-check",
    "tria-phase20",
    "tria-gui",
    "tria-gui-forward",
    "tria-release",
  ]) {
    assert.ok(manifest.tasks[id], `manifest must declare ${id}`);
    assert.equal(
      manifest.tasks[id].runtime,
      "system",
      `${id} must not depend on a workspace .venv`,
    );
  }
  // Ordinary development must not be able to reach release by accident.
  assert.equal(manifest.tasks["tria-release"].result_parser, undefined);
  assert.notEqual(manifest.tasks["tria-fast"].command.join(" "), "full");
  // A GUI acceptance task must NOT be headless, and must be bounded so a scene
  // that never exits cannot hold a real window indefinitely.
  for (const guiTask of ["tria-gui", "tria-gui-forward"]) {
    const gui = manifest.tasks[guiTask];
    assert.equal(
      gui.command.includes("--headless"),
      false,
      `${guiTask} must open a real window`,
    );
    assert.ok(
      gui.command.includes("--rendering-method"),
      `${guiTask} must pin an explicit renderer`,
    );
    assert.ok(
      (gui.timeout_seconds ?? 0) > 0 && (gui.timeout_seconds ?? 0) <= 1800,
      `${guiTask} needs a bounded timeout`,
    );
    assert.equal(gui.result_parser, "triaregna_v1");
    const cmd = validateAndSubstitute(
      gui,
      { suite: "UiAdaptiveLayoutAcceptanceTestRunner" },
      realRoot,
      [realRoot],
    );
    assert.deepEqual(cmd.errors, []);
    const bad = validateAndSubstitute(gui, { suite: "../escape" }, realRoot, [
      realRoot,
    ]);
    assert.ok(bad.errors.length > 0);
  }
  assert.ok(
    manifest.tasks["tria-gui-forward"].command.includes("forward_plus"),
    "the Forward+ task must select the Forward+ renderer",
  );
  // The Forward+ task must be a command-line override, never a project edit.
  assert.equal(
    readFileSync(join(realRoot, "project.godot"), "utf8").includes(
      'rendering_method="forward_plus"',
    ),
    false,
    "the repository default renderer must stay Compatibility",
  );
  // The Phase 20 task must pass the runtime-only gate the policy documents.
  assert.ok(manifest.tasks["tria-phase20"].command.includes("--runtime-only"));
  assert.ok(manifest.tasks["tria-phase20"].command.includes("--headless"));
}
