/**
 * Process-wide state-directory ownership. Uses a dedicated SQLite database
 * and a long-lived EXCLUSIVE transaction, whose OS lock is automatically
 * released on process exit / SIGKILL. Never heuristically unlink a PID lock.
 *
 * Every createServer() must acquire ownership BEFORE opening shared state,
 * including before reconciliation of interrupted Codex runs.
 */
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const LOCK_BASENAME = "devspace-owner-lock.sqlite";

export class DevSpaceInstanceLock {
  private db: Database.Database | undefined;
  readonly path: string;
  private released = false;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(stateDir, 0o700);
    const canonical = realpathSync(stateDir);
    const path = join(canonical, LOCK_BASENAME);
    this.path = path;
    const db = new Database(path, { timeout: 80, fileMustExist: false });
    this.db = db;
    try {
      if (!statSync(path).isFile() || realpathSync(path) !== path)
        throw new Error("DEVSPACE_INSTANCE_LOCK_UNSAFE_PATH");
      if (process.platform !== "win32") chmodSync(path, 0o600);
      db.pragma("journal_mode=DELETE");
      db.pragma("busy_timeout=80");
      // SQLite itself owns the file/OS lock, so a SIGKILL releases it.
      // BEGIN EXCLUSIVE blocks every independent process/connection.
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      this.db = undefined;
      if (error instanceof Error &&
          /SQLITE_BUSY|database is locked/i.test(String(error))) {
        throw new Error("DEVSPACE_INSTANCE_ALREADY_RUNNING");
      }
      throw error;
    }
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    const db = this.db;
    this.db = undefined;
    if (!db) return;
    try { db.exec("ROLLBACK"); }
    finally { db.close(); }
  }
}
