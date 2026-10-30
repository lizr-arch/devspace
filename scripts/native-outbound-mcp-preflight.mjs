#!/usr/bin/env node
/**
 * Read-only deploy preflight for the native outbound MCP surface.
 *
 * ROLE-005 item 2: Web GPT must be able to DISCOVER and CALL
 * codex_app_native_send / _native_rework / _native_receipt from the live
 * DevSpaceMac MCP in its own session. This script never deploys, restarts or
 * writes anything; it reports whether the candidate is ready and what a safe
 * user-authorized deployment would do.
 *
 * Usage: node scripts/native-outbound-mcp-preflight.mjs [--json]
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CANDIDATE = process.cwd();
const PROD = "/Users/liz/agy/devspace";
const TOOLS = ["codex_app_native_send", "codex_app_native_rework", "codex_app_native_receipt"];
const out = { generatedAt: new Date().toISOString(), mode: "read-only-preflight", tools: TOOLS };

function git(dir, args) {
  const r = spawnSync("/usr/bin/git", ["-C", dir, ...args], { encoding: "utf8", timeout: 8000 });
  return { exit: r.status, out: (r.stdout || "").trim() };
}
function servicePid() {
  const r = spawnSync("/usr/bin/pgrep", ["-f", "dist/cli.js serve"], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim().split("\n").filter(Boolean)[0] ?? null;
}
const candidateSource = readFileSync(join(CANDIDATE, "src/server/server-helpers.ts"), "utf8");
const deployedHelpers = join(PROD, "dist/server/server-helpers.js");
const deployed = existsSync(deployedHelpers) ? readFileSync(deployedHelpers, "utf8") : "";
out.candidate = {
  root: CANDIDATE,
  head: git(CANDIDATE, ["rev-parse", "HEAD"]).out,
  branch: git(CANDIDATE, ["branch", "--show-current"]).out,
  hasNativeTools: TOOLS.every((name) => candidateSource.includes(name)),
  schemaRevision: /native-outbound-001/.test(readFileSync(join(CANDIDATE, "src/server/server-types.ts"), "utf8")),
};
out.deployed = {
  root: PROD,
  head: git(PROD, ["rev-parse", "HEAD"]).out,
  dirtyCount: git(PROD, ["status", "--porcelain=v1"]).out.split("\n").filter(Boolean).length,
  distServerHelpersMtime: existsSync(deployedHelpers) ? statSync(deployedHelpers).mtime.toISOString() : null,
  hasNativeTools: TOOLS.map((name) => ({ name, present: deployed.includes(name) })),
  servicePid: servicePid(),
};
out.verdict =
  out.candidate.hasNativeTools && out.candidate.schemaRevision && !out.deployed.hasNativeTools.some((t) => t.present)
    ? "CANDIDATE_READY__DEPLOY_NOT_AUTHORIZED"
    : out.deployed.hasNativeTools.every((t) => t.present)
      ? "ALREADY_DEPLOYED__VERIFY_TOOL_CALLS"
      : "PRECONDITION_MISSING__DO_NOT_DEPLOY";
out.deployPlan = [
  "1. (user authorized only) in candidate worktree: npm run build (rebuild dist).",
  "2. Pre-deploy snapshot: copy /Users/liz/agy/devspace/dist -> dist.backup.<UTC>; record sha256 of dist/server/server-helpers.js and service pid.",
  "3. Restart ONLY the DevSpace service: launchctl kickstart -k gui/501/com.liz.devspace (never App/daemon/Chrome).",
  "4. Verify live /health 200, devspace_info schemaRevision ends +native-outbound-001, live tool list contains the 3 native tools, codex_app tool count unchanged for existing tools.",
  "5. Rollback: restore snapshot dist, kickstart again, verify live tool list back to pre-deploy set.",
];
out.safety = {
  writes: "none",
  restarts: "none",
  appOrDaemonTouched: "none",
  note: "Deployment requires explicit user authorization; this preflight must stay read-only.",
};
if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
else {
  console.log("verdict:", out.verdict);
  console.log("candidate:", out.candidate.head, out.candidate.branch, "native tools:", out.candidate.hasNativeTools);
  console.log("deployed:", out.deployed.head, "dirty:", out.deployed.dirtyCount, "service pid:", out.deployed.servicePid);
  console.log("deployed native tools:", out.deployed.hasNativeTools.map((t) => t.name + "=" + t.present).join(", "));
  for (const step of out.deployPlan) console.log(step);
}
process.exit(0);
