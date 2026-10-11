/**
 * Read-only TriaRegna cleanup audit.
 *
 * This script never mutates anything. It opens the live DevSpace workspace
 * database READ-ONLY (SQLite `readonly` + `fileMustExist`), builds the same
 * registry the server uses, and prints the unified cleanup plan plus the raw
 * persisted records for the named historical candidates.
 *
 * Refuses to run if it cannot open the database read-only, and it never calls
 * close_workspace_session, reclaim_workspace or git_delete_merged_branch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const STATE_DIR = process.env.DEVSPACE_STATE_DIR ?? join(homedir(), ".local", "share", "devspace");
const DB_PATH = join(STATE_DIR, "devspace.sqlite");
const REPO = "/Users/liz/agy/TriaRegna";
const CANDIDATES = [
  "TriaRegna-3b500f8e",
  "TriaRegna-f887b774",
  "TriaRegna-6a8a9ecc",
  "TriaRegna-b58942f7",
  "TriaRegna-ae701e26",
];

if (!existsSync(DB_PATH)) {
  console.error(`Missing state database: ${DB_PATH}`);
  process.exit(2);
}

// Hard read-only open. Any write attempt would throw SQLITE_READONLY.
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
// The live database may predate the lifecycle migration, so read the column
// list instead of assuming the new schema exists.
const columns = new Set(
  db.prepare("pragma table_info(workspace_sessions)").all().map((row) => row.name),
);
const lifecycleColumns = [
  "lifecycle_state",
  "closed_at",
  "closed_reason",
].filter((name) => columns.has(name));
const selectColumns = [
  "id",
  "root",
  "mode",
  "managed",
  "branch",
  "status",
  ...lifecycleColumns,
  "created_at",
  "last_used_at",
].join(", ");
const rows = db
  .prepare(
    `select ${selectColumns}
       from workspace_sessions
      where root like '%TriaRegna%'
      order by last_used_at desc`,
  )
  .all();

const allRows = db
  .prepare("select count(*) c from workspace_sessions")
  .get().c;

const worktreeRows = rows.filter((row) => row.mode === "worktree");
const checkoutRows = rows.filter((row) => row.mode !== "worktree");
const missingDirs = rows.filter((row) => !existsSync(row.root));

const git = (args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

const canonical = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
// Git keeps registrations for directories that were deleted outside Git, so a
// raw realpath would throw. Canonicalise defensively and keep the raw spelling.
const registered = new Set(
  git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonical(line.slice("worktree ".length).trim())),
);

const worktreeRoot = join(homedir(), ".devspace", "worktrees");
const onDisk = existsSync(worktreeRoot)
  ? execFileSync("ls", ["-1", worktreeRoot], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  : [];
const recordedRoots = new Set(
  worktreeRows.map((row) => canonical(row.root)),
);
const canonicalWorktreeRoot = canonical(worktreeRoot);
const orphanDirs = onDisk.filter(
  (name) => !recordedRoots.has(canonical(join(canonicalWorktreeRoot, name))),
);

const main = git(["rev-parse", "main"]);
const originMain = git(["rev-parse", "origin/main"]);
const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  .split("\n")
  .filter(Boolean);
const branchVerdicts = branches.map((branch) => {
  const sha = git(["rev-parse", `refs/heads/${branch}`]);
  let isAncestor = "yes";
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", `refs/heads/${branch}`, main],
      { cwd: REPO, stdio: "ignore" },
    );
  } catch {
    isAncestor = "no";
  }
  return { branch, sha, ancestorOfMain: isAncestor };
});

console.log("=== DevSpace state (read-only) ===");
console.log(`db: ${DB_PATH}`);
console.log(`total workspace records: ${allRows}`);
console.log(`TriaRegna records: ${rows.length} (worktree ${worktreeRows.length}, checkout ${checkoutRows.length})`);
console.log(`records whose directory is gone: ${missingDirs.length}`);
console.log(`TriaRegna main:   ${main}`);
console.log(`TriaRegna origin/main: ${originMain}`);
console.log(`registered worktrees (repo): ${registered.size}`);
console.log(`local branches: ${branches.length}`);
console.log(`directories under ${worktreeRoot}: ${onDisk.length}`);
console.log(`  of which no workspace record mentions them: ${orphanDirs.length}`);

console.log("\n=== Persisted lifecycle states (TriaRegna) ===");
const byState = new Map();
for (const row of rows) {
  const key = `${row.mode}/${row.lifecycle_state ?? "(pre-migration)"}`;
  byState.set(key, (byState.get(key) ?? 0) + 1);
}
for (const [key, count] of [...byState].sort()) console.log(`  ${key}: ${count}`);

console.log("\n=== Named historical candidates ===");
for (const name of CANDIDATES) {
  const path = join(worktreeRoot, name);
  const record = worktreeRows.find((row) => row.root.endsWith(`/${name}`));
  const canonicalPath = existsSync(path) ? canonical(path) : null;
  console.log(`\n${name}`);
  console.log(`  path:                 ${path}`);
  console.log(`  directory exists:     ${existsSync(path)}`);
  console.log(`  registered worktree:  ${canonicalPath ? registered.has(canonicalPath) : false}`);
  console.log(`  workspaceId:          ${record?.id ?? "(no record)"}`);
  console.log(`  branch:               ${record?.branch ?? "(none)"}`);
  console.log(`  persisted state:      ${record?.lifecycle_state ?? "(pre-migration: column absent)"} legacy status=${record?.status ?? "-"}`);
  console.log(`  created / last used:  ${record?.created_at ?? "-"} / ${record?.last_used_at ?? "-"}`);
  console.log(`  closed at / reason:   ${record?.closed_at ?? "-"} / ${record?.closed_reason ?? "-"}`);
  if (existsSync(path) && record) {
    console.log(`  HEAD:                 ${execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim()}`);
    const dirty = execFileSync("git", ["status", "--porcelain=v1"], { cwd: path, encoding: "utf8" }).trim();
    console.log(`  dirty/untracked:      ${dirty ? dirty.split("\n").length : 0} entr(ies)`);
    console.log(`  unmerged vs main:     ${execFileSync("git", ["rev-list", "--count", `main..HEAD`], { cwd: path, encoding: "utf8" }).trim()}`);
  }
}

console.log("\n=== Local branch merge status (read-only) ===");
const merged = branchVerdicts.filter((entry) => entry.ancestorOfMain === "yes");
const unmerged = branchVerdicts.filter((entry) => entry.ancestorOfMain === "no");
console.log(`merged into main:   ${merged.length}`);
for (const entry of merged) console.log(`  MERGED   ${entry.branch} ${entry.sha.slice(0, 8)}`);
console.log(`not in main:        ${unmerged.length}`);
for (const entry of unmerged) console.log(`  UNMERGED ${entry.branch} ${entry.sha.slice(0, 8)}`);

console.log("\n=== Protected objects (must never be touched) ===");
for (const protectedPath of [
  REPO,
  join(worktreeRoot, "TriaRegna-ced6820c"),
  join(worktreeRoot, "TriaRegna-ti0"),
  join(worktreeRoot, "TriaRegna-ti1"),
  join(worktreeRoot, "TriaRegna-ti2"),
  join(worktreeRoot, "TriaRegna-ti3"),
]) {
  console.log(`  ${existsSync(protectedPath) ? "present" : "absent"}  ${protectedPath}`);
}

console.log("\nThis audit performed no writes. Nothing was closed, reclaimed or deleted.");
db.close();
