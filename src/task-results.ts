/**
 * Structured result parsing for declared project tasks.
 *
 * This is purely additive: the raw stdout/stderr, the exit code and the log
 * location are always returned untouched. Parsing exists so a caller can see
 * pass/fail counts, gate counts and durations without grepping, and so a task
 * that exits 0 without ever printing a success marker is NOT silently reported
 * as a pass.
 *
 * The `triaregna_v1` grammar is the one the TriaRegna repository already emits
 * from `tools/triaregna.sh`, `tools/run_all_tests.sh` and
 * `tools/run_editor_tests.sh`. No new test framework is introduced and no
 * keyword is trusted over the process exit code.
 */
import type { TaskResultParserName } from "./task-manifest.js";

export type TaskVerdict = "pass" | "fail" | "indeterminate";

export interface TaskSuiteOutcome {
  name: string;
  status: "pass" | "fail";
  durationSeconds: number | null;
  exitCode: number | null;
}

export interface TaskStructuredResult {
  parser: TaskResultParserName;
  /** Derived from the exit code first, then corroborated by output markers. */
  verdict: TaskVerdict;
  exitCode: number | null;
  passCount: number | null;
  failCount: number | null;
  gateCount: number | null;
  buildSeconds: number | null;
  testSeconds: number | null;
  totalSeconds: number | null;
  suites: TaskSuiteOutcome[];
  /** Every recognised success/failure marker, kept for audit. */
  markers: { pass: string[]; fail: string[] };
  logDirectory: string | null;
  /**
   * True only when the invocation is a real GPU window. A headless run can
   * never be visual acceptance evidence, whatever its markers say.
   */
  realGui: boolean;
  headless: boolean;
  /**
   * Checks this invocation demonstrably did NOT perform, with the evidence for
   * that conclusion. A local pass must never be reported as a project pass.
   */
  skippedChecks: string[];
  /** Human-readable explanation of how the verdict was reached. */
  reasons: string[];
  /** A local scope pass is not a whole-project pass. */
  scope: "local" | "core" | "full" | "release" | "unknown";
}

const SUITE_LINE = /^\[[a-z]+\]\s+(\S+)\s+(PASS|FAIL)\s+(\d+)s(?:\s+\(exit=(-?\d+)\))?/gm;
const FAST_RESULT = /TRIA_REGNA_FAST_RESULT\s+pass=(\d+)\s+fail=(\d+)(?:\s+log_dir=(\S+))?(?:\s+\(([^)]*)\))?/;
const SUITE_RESULT =
  /TRIA_REGNA_SUITE_RESULT\s+pass=(\d+)\s+fail=(\d+)\s+gates=(\d+)(?:\s+core_tests=(\d+))?(?:\s+\(([^)]*)\))?/;
const TIMING =
  /TRIA_REGNA_PIPELINE_TIMING\s+build_s=(\d+)\s+tests_s=(\d+)\s+total_s=(\d+)/;
const EDITOR_TIMING =
  /TRIA_REGNA_EDITOR_TIMING\s+total_s=(\d+)\s+build_mode=(\S+)\s+exit=(-?\d+)/;
const GENERIC_PASS_MARKER = /TRIA_REGNA_[A-Z0-9_]+_PASS/g;
const GATES_PASS_MARKER = /\bALL \d+(?:\/\d+)? GATES PASS(?:ED)?\b|GATES PASS/g;
const FAIL_MARKERS = [
  /\[FAIL\]/g,
  /TRIA_REGNA_TEST_FAIL/g,
  /TRIA_REGNA_CORE_TESTS_FAIL/g,
  /TRIA_REGNA_HARVESTER_FAIL/g,
];

export function parseTaskResult(input: {
  parser: TaskResultParserName;
  output: string;
  exitCode: number | null;
  command: string[];
  /**
   * True when the run was killed by its own timeout. A timeout is always a
   * failure: a scene that never exits must not be reported as indeterminate
   * (or worse, inferred as a pass from a stray marker).
   */
  timedOut?: boolean;
}): TaskStructuredResult {
  if (input.parser === "triaregna_v1") {
    return parseTriaregnaV1(
      input.output,
      input.exitCode,
      input.command,
      input.timedOut === true,
    );
  }
  const exhaustive: never = input.parser;
  throw new Error(`Unknown task result parser: ${String(exhaustive)}`);
}

function parseTriaregnaV1(
  output: string,
  exitCode: number | null,
  command: string[],
  timedOut: boolean,
): TaskStructuredResult {
  const reasons: string[] = [];
  const skippedChecks: string[] = [];
  const passMarkers: string[] = [];
  const failMarkers: string[] = [];

  const suites: TaskSuiteOutcome[] = [];
  for (const match of output.matchAll(SUITE_LINE)) {
    suites.push({
      name: match[1],
      status: match[2] === "PASS" ? "pass" : "fail",
      durationSeconds: Number(match[3]),
      exitCode: match[4] === undefined ? null : Number(match[4]),
    });
  }

  let passCount: number | null = null;
  let failCount: number | null = null;
  let gateCount: number | null = null;
  let logDirectory: string | null = null;
  let scope: TaskStructuredResult["scope"] = "unknown";
  let tailReason: string | null = null;

  const fast = output.match(FAST_RESULT);
  if (fast) {
    passCount = Number(fast[1]);
    failCount = Number(fast[2]);
    logDirectory = fast[3] ?? null;
    tailReason = fast[4] ?? null;
    scope = "local";
    passMarkers.push(fast[0].trim());
  }

  const suite = output.match(SUITE_RESULT);
  if (suite) {
    passCount = Number(suite[1]);
    failCount = Number(suite[2]);
    gateCount = Number(suite[3]);
    tailReason = suite[5] ?? null;
    // `run_all_tests.sh` serves both `core` and `full`; the editor timing line
    // is what distinguishes a full run here.
    scope = /core_tests=/.test(suite[0]) ? "core" : "full";
    passMarkers.push(suite[0].trim());
  }

  const timing = output.match(TIMING);
  const editorTiming = output.match(EDITOR_TIMING);

  for (const match of output.matchAll(GENERIC_PASS_MARKER)) {
    passMarkers.push(match[0]);
  }
  for (const match of output.matchAll(GATES_PASS_MARKER)) {
    passMarkers.push(match[0]);
  }
  for (const pattern of FAIL_MARKERS) {
    for (const match of output.matchAll(pattern)) {
      failMarkers.push(match[0]);
    }
  }

  const headless = command.includes("--headless");
  const realGui = !headless;

  // --- verdict ------------------------------------------------------------
  // The exit code is authoritative. Markers can only ever weaken a pass, never
  // manufacture one.
  let verdict: TaskVerdict;
  if (timedOut) {
    verdict = "fail";
    reasons.push(
      "the run was killed by its own timeout; the process never exited on its own",
    );
    skippedChecks.push(
      "no result can be signed off from a run that had to be killed",
    );
  } else if (exitCode !== 0 && exitCode !== null) {
    verdict = "fail";
    reasons.push(`process exited with code ${exitCode}`);
  } else if (failMarkers.length > 0) {
    verdict = "fail";
    reasons.push(
      `output contains failure markers: ${[...new Set(failMarkers)].join(", ")}`,
    );
  } else if (tailReason) {
    verdict = "fail";
    reasons.push(`pipeline reported a failure reason: ${tailReason}`);
  } else if (passCount !== null && failCount !== null && failCount > 0) {
    verdict = "fail";
    reasons.push(`${failCount} of ${passCount + failCount} suites failed`);
  } else if (passMarkers.length === 0) {
    verdict = "indeterminate";
    reasons.push(
      "no recognised success marker and no failure marker; a zero exit code alone is not a pass",
    );
  } else {
    verdict = "pass";
    reasons.push(`exit code 0 with success markers: ${passMarkers.length}`);
  }

  if (exitCode === null) {
    reasons.push("no exit code was observed (process did not exit normally)");
  }

  // --- explicitly unperformed work ----------------------------------------
  if (tailReason === "build_failed") {
    skippedChecks.push("all test suites (the C# build failed first)");
  }
  if (tailReason === "receipt_failed") {
    skippedChecks.push("all test suites (the build receipt could not be created)");
  }
  if (/godot binary not found/.test(output)) {
    skippedChecks.push("all Godot suites (no Godot binary was found)");
  }
  if (scope === "local") {
    skippedChecks.push(
      "core, full, editor and release suites are not executed by a targeted fast run",
    );
  }
  if (scope === "core") {
    skippedChecks.push(
      "editor and release suites are not executed by the core suite",
    );
  }
  if (!/TRIA_REGNA_MAP_EDITOR_PHASE20/.test(output)) {
    skippedChecks.push("Phase 20 runtime acceptance was not executed");
  }
  if (!/TRIA_REGNA_EDITOR_TIMING/.test(output)) {
    skippedChecks.push("editor suites were not executed");
  }
  if (headless) {
    skippedChecks.push(
      "real GPU visual acceptance (this invocation ran headless, so any capture is not GUI evidence)",
    );
  }

  return {
    parser: "triaregna_v1",
    verdict,
    exitCode,
    passCount,
    failCount,
    gateCount,
    buildSeconds: timing ? Number(timing[1]) : null,
    testSeconds: timing ? Number(timing[2]) : null,
    totalSeconds: timing
      ? Number(timing[3])
      : editorTiming
        ? Number(editorTiming[1])
        : null,
    suites,
    markers: {
      pass: [...new Set(passMarkers)],
      fail: [...new Set(failMarkers)],
    },
    logDirectory,
    realGui,
    headless,
    skippedChecks,
    reasons,
    scope,
  };
}
