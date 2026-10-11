/**
 * Read-only TriaRegna cleanup plan, produced by the SAME registry and policies
 * the live service uses.
 *
 * Opens the live DevSpace database read-only, builds the registry with the real
 * configuration, and prints the unified plan plus the five named historical
 * candidates. It never closes, reclaims or deletes anything.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const ROOT = process.env.DEVSPACE_SOURCE ?? process.cwd();
const STATE_DIR = join(homedir(), ".local", "share", "devspace");
const DB_PATH = join(STATE_DIR, "devspace.sqlite");
const WORKTREE_ROOT = join(homedir(), ".devspace", "worktrees");
const CANDIDATES = [
  "TriaRegna-3b500f8e",
  "TriaRegna-f887b774",
  "TriaRegna-6a8a9ecc",
  "TriaRegna-b58942f7",
  "TriaRegna-ae701e26",
];

// Never open the live database for writing from this script.
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.close();

const { loadConfig } = await import(pathToFileURL(join(ROOT, "dist/config.js")).href);
const { SqliteWorkspaceStore } = await import(
  pathToFileURL(join(ROOT, "dist/workspace-store.js")).href
);
const { WorkspaceRegistry } = await import(
  pathToFileURL(join(ROOT, "dist/workspaces.js")).href
);
const { LsofWorktreeProcessProbe } = await import(
  pathToFileURL(join(ROOT, "dist/workspace-process-probe.js")).href
);

// The registry writes lifecycle state, which is the whole point of the
// reconciliation — but it must never be used to delete anything here.
const config = loadConfig(process.env);
const store = new SqliteWorkspaceStore(STATE_DIR);
// Same probes the live service wires, including the read-only OS probe for
// processes DevSpace did not start.
const registry = new WorkspaceRegistry(config, store, undefined, {
  processProbe: new LsofWorktreeProcessProbe({
    timeoutMs: config.worktreeCleanup.processProbeTimeoutMs,
  }),
  requireNoForeignProcess: config.worktreeCleanup.requireNoForeignProcess,
});

const plan = await registry.cleanupPlan({
  limit: 200,
  includeOrphans: false,
});

console.log("=== Unified cleanup plan (read-only) ===");
console.log(`auditedAt: ${plan.auditedAt}`);
console.log(`worktreeRoot: ${plan.orphans.worktreeRoot}`);
console.log(`worktree directories on disk: ${plan.orphans.directoryCount}`);
console.log(`directories with no workspace record: ${plan.orphans.orphanedCount}`);
console.log("summary:", JSON.stringify(plan.summary));
console.log("protected branch patterns:", JSON.stringify(config.worktreeCleanup.protectedBranchPatterns));
console.log("protected worktree patterns:", JSON.stringify(config.worktreeCleanup.protectedWorktreePatterns));

const triaregna = plan.entries.filter((entry) => entry.root.includes("TriaRegna"));
console.log(`\nTriaRegna entries: ${triaregna.length}`);

console.log("\n=== Named historical candidates ===");
for (const name of CANDIDATES) {
  const path = `${WORKTREE_ROOT}/${name}`;
  const entry = plan.entries.find((item) => item.root === path);
  console.log(`\n${name}`);
  if (!entry) {
    console.log("  (not present in the plan)");
    continue;
  }
  console.log(`  workspaceId:        ${entry.workspaceId}`);
  console.log(`  verdict:            ${entry.verdict}`);
  console.log(`  sessionState:       ${entry.sessionState}`);
  console.log(`  sessionIsLive:      ${entry.sessionIsLive}`);
  console.log(`  liveLeases:         ${entry.liveLeases}`);
  console.log(`  branch:             ${entry.branch}`);
  console.log(`  headSha:            ${entry.headSha}`);
  console.log(`  clean:              ${entry.clean} (dirty=${entry.dirtyFileCount} untracked=${entry.untrackedFileCount})`);
  console.log(`  unmergedCommits:    ${entry.unmergedCommitCount}`);
  console.log(`  activeJobs:         ${entry.activeJobIds.join(",") || "none"}`);
  console.log(`  activeGames:        ${entry.activeGameSessionIds.join(",") || "none"}`);
  console.log(`  activeTasks:        ${entry.activeTaskSessionIds.join(",") || "none"}`);
  console.log(`  managedWorktree:    ${entry.isManagedWorktree}`);
  console.log(`  reclaimable:        ${entry.reclaimable}`);
  console.log(`  blockedReasons:     ${entry.blockedReasons.join("; ") || "none"}`);
  if (entry.branchDelete) {
    console.log(`  branchDelete:       ${entry.branchDelete.verdict} (${entry.branchDelete.reasons.join("; ")})`);
  }
}

console.log("\n=== Full plan (one line per worktree) ===");
for (const entry of plan.entries
  .filter((item) => item.mode === "worktree")
  .sort((left, right) => left.verdict.localeCompare(right.verdict) || left.root.localeCompare(right.root))) {
  const branch = entry.branchDelete ? entry.branchDelete.verdict : "n/a";
  console.log(
    `${entry.verdict.padEnd(18)} ${entry.sessionState ?? "-"}`.padEnd(44) +
      `| ${(entry.branch ?? "(detached)").slice(0, 46).padEnd(46)}` +
      `| branch=${branch} | ${entry.root.replace(WORKTREE_ROOT + "/", "")}`,
  );
}

store.close();
console.log("\nRead-only plan complete. Nothing was closed, reclaimed or deleted.");
