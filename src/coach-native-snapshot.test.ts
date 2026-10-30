/**
 * P0-03 tests: read-only snapshot refresh from the live DevSpace Coach event
 * store into the file the isolated 8788 wake sidecar holds open.
 *
 * No production path is touched: the "source" is a throwaway SQLite database in
 * a temp dir; the "snapshot" is another temp file. One test uses the real
 * /usr/bin/sqlite3 to prove in-place refresh (same inode, new rows visible to a
 * read-only reader) and the rest inject a fake runtime for failure paths.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  buildSnapshotRefreshArgv,
  quoteSqlitePath,
  refreshNativeEventSnapshot,
  snapshotFreshness,
  startNativeEventSnapshotRefresher,
} from "./coach-native-snapshot.js";

let pass = 0;
const dir = mkdtempSync(join(tmpdir(), "native-snapshot-"));

function makeDb(path: string, rows: Array<{ id: string; workspace: string }>) {
  const db = new Database(path);
  // Fixture deliberately uses rollback journal (no WAL/shm) so a read-only
  // `mode=ro` open works without a writer; the production store keeps WAL and
  // has a live -shm because the DevSpace service holds it open.
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE IF NOT EXISTS coach_review_events (event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, event_type TEXT NOT NULL)");
  for (const row of rows) db.prepare("INSERT OR IGNORE INTO coach_review_events(event_id,workspace_id,event_type) VALUES(?,?,'CODEX_APP_READY_FOR_GPT_REVIEW')").run(row.id, row.workspace);
  db.close();
}
function readRows(path: string): Array<{ event_id: string; workspace_id: string }> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT event_id,workspace_id FROM coach_review_events ORDER BY event_id").all() as Array<{ event_id: string; workspace_id: string }>;
  } finally {
    db.close();
  }
}
function sqlite3(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000 });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

try {
  const source = join(dir, "live.sqlite");
  const snapshot = join(dir, "snapshot.sqlite");

  // 1. arg builder: read-only source URI + quoted absolute target, no production write mode.
  const argv = buildSnapshotRefreshArgv(source, snapshot);
  assert.deepEqual(argv, ["/usr/bin/sqlite3", `file:${source}?mode=ro`, `.backup "${snapshot}"`]);
  assert.equal(argv[1].includes("mode=ro"), true);
  pass++;

  // 2. quoting/validation fail closed.
  assert.equal(quoteSqlitePath('/tmp/a"b.sqlite'), '"/tmp/a""b.sqlite"');
  assert.throws(() => buildSnapshotRefreshArgv("relative.sqlite", snapshot), /SNAPSHOT_PATH_NOT_ABSOLUTE/);
  assert.throws(() => buildSnapshotRefreshArgv(source, source), /SNAPSHOT_SOURCE_EQUALS_TARGET/);
  assert.throws(() => buildSnapshotRefreshArgv(source, "/tmp/a\nb"), /SNAPSHOT_PATH_INVALID/);
  pass++;

  // 3. missing source => structured failure, no throw; missing snapshot allowed by default.
  const missing = refreshNativeEventSnapshot({ sourcePath: join(dir, "nope.sqlite"), snapshotPath: snapshot });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "SOURCE_DATABASE_MISSING");
  pass++;

  // 4. injected failure paths: spawn error / nonzero exit / target missing after success.
  const spawnErr = refreshNativeEventSnapshot(
    { sourcePath: "/tmp/s.sqlite", snapshotPath: "/tmp/t.sqlite" },
    {
      exists: () => true,
      run: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
      statMtimeMs: () => 1_000,
    },
  );
  assert.equal(spawnErr.ok, false);
  assert.match(spawnErr.error ?? "", /spawn_error/);
  const nonZero = refreshNativeEventSnapshot(
    { sourcePath: "/tmp/s.sqlite", snapshotPath: "/tmp/t.sqlite" },
    { exists: () => true, run: () => ({ status: 5, stdout: "", stderr: "database is locked" }), statMtimeMs: () => 1_000 },
  );
  assert.equal(nonZero.ok, false);
  assert.match(nonZero.error ?? "", /sqlite_backup_exit_5:database is locked/);
  const targetMissing = refreshNativeEventSnapshot(
    { sourcePath: "/tmp/s.sqlite", snapshotPath: "/tmp/t.sqlite" },
    { exists: (p) => p === "/tmp/s.sqlite", run: () => ({ status: 0, stdout: "", stderr: "" }), statMtimeMs: () => 1_000 },
  );
  assert.equal(targetMissing.ok, false);
  assert.equal(targetMissing.error, "SNAPSHOT_MISSING_AFTER_BACKUP");
  pass++;

  // 5. REAL sqlite3 in-place refresh: new row in source becomes visible in the
  //    snapshot file; inode is preserved so a sidecar holding it open sees it.
  makeDb(source, [{ id: "app:aaa", workspace: "ws_bound" }]);
  sqlite3(buildSnapshotRefreshArgv(source, snapshot));
  assert.deepEqual(readRows(snapshot).map((r) => r.event_id), ["app:aaa"]);
  const inodeBefore = statSync(snapshot).ino;
  const sourceDb = new Database(source);
  sourceDb.prepare("INSERT INTO coach_review_events(event_id,workspace_id,event_type) VALUES(?,?,'CODEX_APP_READY_FOR_GPT_REVIEW')").run("app:bbb", "ws_bound");
  sourceDb.close();
  const refresh = refreshNativeEventSnapshot({ sourcePath: source, snapshotPath: snapshot });
  assert.equal(refresh.ok, true, refresh.error);
  assert.equal(statSync(snapshot).ino, inodeBefore, "inode must be preserved for the running sidecar");
  assert.deepEqual(readRows(snapshot).map((r) => r.event_id), ["app:aaa", "app:bbb"]);
  pass++;

  // 6. freshness: lag computed from mtimes; stale past threshold.
  const fresh = snapshotFreshness({ sourcePath: source, snapshotPath: snapshot, staleAfterMs: 60_000 });
  assert.equal(fresh.fresh, true);
  const stale = snapshotFreshness(
    { sourcePath: source, snapshotPath: snapshot, staleAfterMs: 1_000 },
    { statMtimeMs: (p) => (p === source ? 10_000 : 1_000) },
  );
  assert.equal(stale.fresh, false);
  assert.match(stale.reason ?? "", /SNAPSHOT_LAG_9000MS/);
  pass++;

  // 7. refresher: bounded interval, single-flight, failure counter and recovery.
  const calls: Array<() => void> = [];
  let now = 0;
  let mode: "fail" | "ok" = "fail";
  const refresher = startNativeEventSnapshotRefresher({
    sourcePath: source,
    snapshotPath: snapshot,
    intervalMs: 2_000,
    deps: {
      exists: () => true,
      statMtimeMs: () => 1_000,
      now: () => now++,
      setInterval: (fn) => {
        calls.push(fn);
        return calls.length;
      },
      clearInterval: () => undefined,
      log: () => undefined,
      run: () =>
        mode === "fail"
          ? { status: 1, stdout: "", stderr: "SQLITE_BUSY" }
          : { status: 0, stdout: "", stderr: "" },
    },
  });
  const first = await refresher.tick();
  assert.equal(first.ok, false);
  mode = "ok";
  const second = await refresher.tick();
  assert.equal(second.ok, true);
  const status = refresher.status();
  assert.equal(status.running, true);
  assert.equal(status.totalRefreshes >= 2, true);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(calls.length, 1);
  refresher.stop();
  assert.equal(refresher.status().running, false);
  pass++;

  process.stdout.write("NATIVE_SNAPSHOT_TEST_PASS " + pass + "\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
