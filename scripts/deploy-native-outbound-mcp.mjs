#!/usr/bin/env node
/**
 * Atomic, reversible promotion of the candidate DevSpace build that exposes the
 * native Codex App MCP tools (codex_app_native_send / _native_rework / _native_receipt).
 *
 * ROLE-005-R2 P0-04: building `dist` inside a worktree and restarting the
 * production launchd service does NOT install the candidate artifact. This
 * script performs a real staged -> atomic-rename promotion with a rollback.
 *
 * Safety:
 *  - Default is `--dry-run` (read-only). Promotion requires BOTH `--promote`
 *    and an explicit authorization env var `DEVSPACE_DEPLOY_AUTHORIZED=<release-id>`.
 *  - Never touches git-tracked source; only the gitignored `dist/` artifact
 *    directory is swapped, with a timestamped backup kept outside `dist/`.
 *  - Never restarts ChatGPT App, the Codex daemon, Chrome or the 8765 sidecar
 *    directly; only the DevSpace LaunchAgent (label com.liz.devspace).
 *  - Refuses if the candidate worktree has uncommitted tracked changes.
 *
 * Usage:
 *   node scripts/deploy-native-outbound-mcp.mjs --dry-run
 *   DEVSPACE_DEPLOY_AUTHORIZED=release-<sha> node scripts/deploy-native-outbound-mcp.mjs --promote
 *   DEVSPACE_DEPLOY_AUTHORIZED=rollback-<id> node scripts/deploy-native-outbound-mcp.mjs --rollback --backup <dir>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const CANDIDATE = resolve(process.env.DEVSPACE_CANDIDATE_ROOT ?? process.cwd());
const PROD = "/Users/liz/agy/devspace";
const LABEL = "com.liz.devspace";
const RELEASES = join(PROD, ".devspace", "releases");
const BACKUPS = join(PROD, ".devspace", "dist-backups");
const TOOLS = ["codex_app_native_send", "codex_app_native_rework", "codex_app_native_receipt"];
const SCHEMA_MARK = "+native-outbound-001";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 60_000, maxBuffer: 8_000_000, cwd: opts.cwd });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", error: r.error ?? null };
}
function git(args) { return run("/usr/bin/git", ["-C", CANDIDATE, ...args], { timeout: 15_000 }); }
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function serviceState() {
  const r = run("/bin/launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]);
  const pid = /pid = (\d+)/.exec(r.out)?.[1] ?? null;
  const program = /program = (.+)/.exec(r.out)?.[1]?.trim() ?? null;
  const cwd = /working directory = (.+)/.exec(r.out)?.[1]?.trim() ?? null;
  return { pid: pid ? Number(pid) : null, program, cwd, state: /state = (\w+)/.exec(r.out)?.[1] ?? null };
}
function plistPath() {
  return join(process.env.HOME ?? "/Users/liz", "Library/LaunchAgents", `${LABEL}.plist`);
}
function plistEnv(valueKey) {
  const path = plistPath();
  if (!existsSync(path)) return { path, exists: false, value: null };
  const r = run("/usr/bin/plutil", ["-extract", `EnvironmentVariables.${valueKey}`, "raw", "-o", "-", path]);
  return { path, exists: true, value: r.status === 0 ? r.out.trim() : null };
}
function ensurePlistEnv(key, value, backupPath) {
  const path = plistPath();
  if (!existsSync(path)) throw new Error("LaunchAgent plist missing");
  if (!existsSync(backupPath)) cpSync(path, backupPath);
  const update = run("/usr/bin/plutil", ["-replace", `EnvironmentVariables.${key}`, "-string", value, path]);
  if (update.status !== 0) {
    const insert = run("/usr/bin/plutil", ["-insert", `EnvironmentVariables.${key}`, "-string", value, path]);
    if (insert.status !== 0) throw new Error("failed to set LaunchAgent environment");
  }
}
function waitLive(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = run("/usr/bin/curl", ["-sS", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:7676/healthz"], { timeout: 5000 });
    last = r.out.trim();
    if (last === "200") {
      const svc = serviceState();
      if (svc.state === "running" && Number.isInteger(svc.pid)) return { ok: true, health: 200, service: svc };
    }
    spawnSync("/bin/sleep", ["1"]);
  }
  return { ok: false, health: last, service: serviceState() };
}
function restartService() {
  // bootout/bootstrap re-reads the plist (kickstart alone keeps cached env).
  run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { timeout: 20_000 });
  // Wait for the old process to disappear before bootstrapping; bootstrapping
  // while launchd still tears the job down can fail transiently.
  for (let i = 0; i < 20; i++) {
    const svc = serviceState();
    if (!Number.isInteger(svc.pid)) break;
    spawnSync("/bin/sleep", ["1"]);
  }
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const boot = run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath()], { timeout: 30_000 });
    last = boot;
    if (boot.status === 0) break;
    spawnSync("/bin/sleep", ["2"]);
  }
  if (!last || last.status !== 0) return { status: last?.status ?? null, err: last?.err ?? "bootstrap failed" };
  const live = waitLive();
  return { status: live.ok ? 0 : 1, err: live.ok ? "" : `service did not become healthy (health=${live.health})` };
}

function distInfo(root) {
  const helpers = join(root, "dist/server/server-helpers.js");
  const types = join(root, "dist/server/server-types.js");
  const tools = join(root, "dist/server/tools-codex-app.js");
  if (!existsSync(helpers)) return { exists: false };
  const text = readFileSync(helpers, "utf8") + (existsSync(types) ? readFileSync(types, "utf8") : "");
  const toolText = existsSync(tools) ? readFileSync(tools, "utf8") : "";
  return {
    exists: true,
    helpersSha256: sha256(helpers),
    mtime: statSync(helpers).mtime.toISOString(),
    schemaNative: text.includes(SCHEMA_MARK),
    nativeTools: Object.fromEntries(TOOLS.map((t) => [t, toolText.includes(t) && text.includes(t)])),
  };
}
function assertCandidateClean() {
  const tracked = git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (tracked.status !== 0) throw new Error("cannot read candidate git status");
  if (tracked.out.trim()) throw new Error("candidate worktree has uncommitted tracked changes; commit before deploy");
  return git(["rev-parse", "HEAD"]).out.trim();
}
function releaseId(commit) {
  return `native-outbound-${commit.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
function buildCandidate() {
  const r = run("/bin/sh", ["-c", "npm run build"], { cwd: CANDIDATE, timeout: 20 * 60_000 });
  if (r.status !== 0) throw new Error(`npm run build failed (exit ${r.status}): ${r.err.slice(-800)}`);
}
function stageRelease(id) {
  const dir = join(RELEASES, id);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  cpSync(join(CANDIDATE, "dist"), join(dir, "dist"), { recursive: true, dereference: false });
  const info = distInfo(dir);
  if (!info.schemaNative || !Object.values(info.nativeTools).every(Boolean))
    throw new Error("staged release does not contain the native MCP tools/schema revision");
  return dir;
}
function promote(stagedDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(BACKUPS, `dist-${stamp}`);
  const plistBackup = join(BACKUPS, `plist-${stamp}.plist`);
  mkdirSync(BACKUPS, { recursive: true, mode: 0o755 });
  // 1. Move the live artifact aside (same filesystem => atomic rename).
  renameSync(join(PROD, "dist"), backup);
  try {
    // 2. Atomic rename of the staged artifact into the launchd WorkingDirectory.
    renameSync(join(stagedDir, "dist"), join(PROD, "dist"));
  } catch (e) {
    renameSync(backup, join(PROD, "dist"));
    throw e;
  }
  // 3. Make the wake-sidecar snapshot refresh explicit (read-only source) and
  //    restart only the DevSpace LaunchAgent so the plist env is re-read.
  ensurePlistEnv("DEVSPACE_NATIVE_EVENT_SNAPSHOT_PATH", "/Users/liz/agy/dsh-wake-e2e/state/coach-review-events.sqlite", plistBackup);
  const boot = restartService();
  if (boot.status !== 0) {
    // Stop the failed/crash-looping job BEFORE touching dist again: swapping
    // the artifact under a booting process makes lazy imports fail with ENOENT.
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { timeout: 20_000 });
    if (existsSync(join(PROD, "dist"))) renameSync(join(PROD, "dist"), join(stagedDir, "rejected-dist-" + stamp));
    renameSync(backup, join(PROD, "dist"));
    if (existsSync(plistBackup)) cpSync(plistBackup, plistPath());
    const rollback = restartService();
    if (!rollback || rollback.status !== 0) {
      throw new Error("service restart failed AND rollback restart failed: " + (rollback?.err ?? "unknown"));
    }
    throw new Error("service restart failed; rolled back dist and plist env");
  }
  return { backup, plistBackup };
}
function verifyLive() {
  const checks = [];
  const dist = distInfo(PROD);
  checks.push({ name: "dist has native schema revision", ok: dist.schemaNative });
  checks.push({ name: "dist has all three native tools", ok: Object.values(dist.nativeTools).every(Boolean) });
  let health = null;
  for (let i = 0; i < 30; i++) {
    const r = run("/usr/bin/curl", ["-sS", "-m", "2", "-o", "-", "-w", "\n%{http_code}", "http://127.0.0.1:7676/healthz"], { timeout: 5000 });
    const code = r.out.trim().split("\n").pop();
    if (code === "200") { health = 200; break; }
    spawnSync("/bin/sleep", ["1"]);
  }
  checks.push({ name: "service /health 200", ok: health === 200 });
  const svc = serviceState();
  checks.push({ name: "launchd service running", ok: svc.state === "running" && Number.isInteger(svc.pid) });
  return { ok: checks.every((c) => c.ok), checks, dist, service: svc };
}
function dryRun() {
  const commit = git(["rev-parse", "HEAD"]).out.trim();
  const id = releaseId(commit);
  const prodDist = distInfo(PROD);
  const candidateDist = distInfo(CANDIDATE);
  const svc = serviceState();
  const snapshotEnv = plistEnv("DEVSPACE_NATIVE_EVENT_SNAPSHOT_PATH");
  const snapshotPath = "/Users/liz/agy/dsh-wake-e2e/state/coach-review-events.sqlite";
  const plan = [
    `candidate commit ${commit}`,
    `stage: cp -a ${CANDIDATE}/dist -> ${join(RELEASES, id, "dist")}`,
    `backup: mv ${PROD}/dist -> ${join(BACKUPS, "dist-<UTC>")}`,
    `promote: mv <staged>/dist -> ${PROD}/dist (same filesystem atomic rename)`,
    `plist env: DEVSPACE_NATIVE_EVENT_SNAPSHOT_PATH=${snapshotEnv.value ?? "<missing>"} (will set ${snapshotPath}; backup plist)` ,
    `restart: launchctl bootout + bootstrap gui/${process.getuid()}/${LABEL} (re-reads plist; brief service downtime)`,
    `verify: /health 200, dist contains ${SCHEMA_MARK} and ${TOOLS.join(", ")}, service running`,
    `rollback: mv ${PROD}/dist -> <rejected>, mv <backup> -> ${PROD}/dist, kickstart again`,
  ];
  const blockers = [];
  if (prodDist.schemaNative) blockers.push("production dist already claims the native schema revision; verify before deploying");
  if (!candidateDist.exists) blockers.push("candidate dist missing (run npm run build first)");
  if (candidateDist.exists && (!candidateDist.schemaNative || !Object.values(candidateDist.nativeTools).every(Boolean)))
    blockers.push("candidate dist is stale / lacks native tools: rebuild before promoting");
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    commit,
    releaseId: id,
    candidateDist,
    productionDist: prodDist,
    service: svc,
    plist: { path: snapshotEnv.path, exists: snapshotEnv.exists, snapshotEnv: snapshotEnv.value, snapshotPath },
    authorizationRequired: `DEVSPACE_DEPLOY_AUTHORIZED=release-${commit.slice(0, 12)}`,
    plan,
    blockers,
    safe: { trackedSourcesTouched: false, appOrDaemonRestarted: false, chromeTouched: false, productionGitDirtyUntouched: true },
  };
}

const args = process.argv.slice(2);
try {
  if (args.includes("--promote")) {
    const auth = process.env.DEVSPACE_DEPLOY_AUTHORIZED;
    const commit = assertCandidateClean();
    if (!auth || !auth.includes(commit.slice(0, 12))) throw new Error("missing/incorrect DEVSPACE_DEPLOY_AUTHORIZED for this commit");
    buildCandidate();
    if (!process.env.DEVSPACE_DEPLOY_SKIP_CHECKS) {
      const t = run("/bin/sh", ["-c", "npm run typecheck"], { cwd: CANDIDATE, timeout: 10 * 60_000 });
      if (t.status !== 0) throw new Error("candidate typecheck failed; refusing deploy");
    }
    const staged = stageRelease(releaseId(commit));
    const { backup } = promote(staged);
    const live = verifyLive();
    const report = { mode: "promote", commit, staged, backup, live, ok: live.ok };
    console.log(JSON.stringify(report, null, 2));
    process.exit(live.ok ? 0 : 3);
  } else if (args.includes("--rollback")) {
    const auth = process.env.DEVSPACE_DEPLOY_AUTHORIZED;
    const i = args.indexOf("--backup");
    const backup = i >= 0 ? args[i + 1] : null;
    if (!auth || !auth.startsWith("rollback-")) throw new Error("rollback requires DEVSPACE_DEPLOY_AUTHORIZED=rollback-...");
    if (!backup || !existsSync(backup)) throw new Error("backup dir not found");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rejected = join(BACKUPS, `rejected-${stamp}`);
    const plistArg = args.indexOf("--plist-backup");
    const plistBackup = plistArg >= 0 ? args[plistArg + 1] : null;
    renameSync(join(PROD, "dist"), rejected);
    renameSync(backup, join(PROD, "dist"));
    if (plistBackup && existsSync(plistBackup)) cpSync(plistBackup, plistPath());
    restartService();
    const live = verifyLive();
    console.log(JSON.stringify({ mode: "rollback", rejected, restoredFrom: backup, live }, null, 2));
    process.exit(live.ok ? 0 : 3);
  } else {
    console.log(JSON.stringify(dryRun(), null, 2));
    process.exit(0);
  }
} catch (e) {
  console.error("DEPLOY_REFUSED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(2);
}
