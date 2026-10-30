#!/usr/bin/env node
/**
 * Falsifiable, fail-closed launch check for the ChatGPT desktop App on the
 * *existing* managed Codex app-server daemon (DEVSPACE-CODEX-APP-ONEPASS-003).
 *
 * Replaces the weaker b6e5218 verifier. Probe + decision logic lives in
 * `scripts/lib/launch-guard.mjs` and is exercised by
 * `scripts/tests/verify-chatgpt-shared-launch.test.mjs` with injected / fake
 * probe data. This CLI is a thin wrapper.
 *
 * Safety contract:
 * - Never quit/restart/kill an App, daemon or lock holder; never delete lock
 *   files; never repair the socket alias; never touch ~/.codex history.
 * - Every probe returns ABSENT | PRESENT | UNKNOWN and any UNKNOWN blocks.
 * - `--launch` performs at most ONE `open -a ChatGPT.app --env
 *   CODEX_APP_SERVER_WS_URL=ws+unix://localhost<canonical socket>:/rpc` after a
 *   full preflight that is re-collected immediately before the open call. Any
 *   drift, any failure => zero/one open, no retry, no kill.
 * - L2 machine proof is all-or-nothing: the only three outputs are
 *   L2_MACHINE_PASS_USER_VISUAL_REQUIRED / L2_MACHINE_INCOMPLETE /
 *   L2_MACHINE_FAIL. Machine pass NEVER claims user-visible validation.
 *
 * Exit codes:
 *   --check: 0 launch permitted (all L0 gates proven)
 *            2 blocked by a known state (GUI present, daemon/socket/writer wrong)
 *            3 blocked because a probe is UNKNOWN (fail closed)
 *            1 usage / unexpected internal error
 *   --launch: 0 L2_MACHINE_PASS_USER_VISUAL_REQUIRED (machine gates only)
 *             2/3 preflight blocked as above
 *             4 L2_MACHINE_INCOMPLETE (a required gate could not be checked)
 *             5 L2_MACHINE_FAIL (a required gate failed)
 *             6 open failed (no retry, no kill)
 *             1 usage / unexpected internal error
 *
 * Usage:
 *   node scripts/verify-chatgpt-shared-launch.mjs --check    # read-only
 *   node scripts/verify-chatgpt-shared-launch.mjs --launch   # needs explicit
 *                                                            # user authorization
 *   node scripts/verify-chatgpt-shared-launch.mjs --help
 */
import {
  L2_FAIL,
  L2_INCOMPLETE,
  L2_PASS,
  PROBE,
  checkReport,
  defaultConfig,
  decidePreflight,
  isEntrypoint,
  runCheck,
  runLaunch,
} from "./lib/launch-guard.mjs";

const ACTION = process.argv[2] ?? "--check";

function printHelp() {
  console.log(
    [
      "Fail-closed shared-Codex ChatGPT launch verifier.",
      "",
      "  --check   read-only L0 preflight; one JSON line; exit 0/2/3",
      "  --launch  L0 (rechecked immediately before open) + one open + L2 machine gates;",
      "            exit 0 only for L2_MACHINE_PASS_USER_VISUAL_REQUIRED (which is NOT",
      "            user-visible validation); 4 incomplete, 5 fail, 6 open failed.",
      "",
      "Never kills/restarts/relaunches. Launch requires separate explicit user authorization.",
    ].join("\n"),
  );
}

async function main() {
  if (ACTION === "--help" || ACTION === "-h") {
    printHelp();
    return 0;
  }
  const cfg = defaultConfig();

  if (ACTION === "--check") {
    const { obs, decision } = await runCheck({ config: cfg });
    const report = checkReport(cfg, obs, decision);
    console.log(JSON.stringify(report));
    if (decision.ok) return 0;
    return decision.severity === "UNKNOWN" ? 3 : 2;
  }

  if (ACTION === "--launch") {
    // NOTE: --launch is only to be executed after separate explicit user
    // authorization. This wrapper itself never runs it during checks/tests;
    // every test uses the injectable `runLaunch` runner with a fake open().
    const result = await runLaunch({ config: cfg });
    const decision = result.decision;
    if (result.phase === "preflight") {
      // Zero opens: fail closed on the preflight state.
      console.error(JSON.stringify(result));
      return decision?.severity === "UNKNOWN" ? 3 : 2;
    }
    if (result.code === "BLOCK_PREFLIGHT_DRIFT") {
      console.error(JSON.stringify(result));
      return 3;
    }
    if (result.code === "APP_SHARED_LAUNCH_FAILED") {
      console.error(JSON.stringify(result));
      return 6;
    }
    if (!decision) {
      console.error(JSON.stringify(result));
      return 1;
    }
    console.log(
      JSON.stringify({
        action: "--launch",
        openCalls: result.openCalls,
        outcome: decision.outcome,
        userVisualRequired: decision.userVisualRequired,
        note: decision.note,
        gates: decision.gates,
        failures: decision.failures,
        unknowns: decision.unknowns,
        post: result.post,
      }),
    );
    if (decision.outcome === L2_PASS) return 0;
    if (decision.outcome === L2_INCOMPLETE) return 4;
    if (decision.outcome === L2_FAIL) return 5;
    return 1;
  }

  console.error("Usage: node scripts/verify-chatgpt-shared-launch.mjs [--check|--launch|--help]");
  return 1;
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          action: ACTION,
          code: "VERIFIER_INTERNAL_ERROR",
          detail: error?.stack ?? String(error),
        }),
      );
      process.exitCode = 1;
    });
}

export { PROBE, decidePreflight };
