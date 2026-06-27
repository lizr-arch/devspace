import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

let savedCwd: string;
export const PROJECT_ROOT = join(import.meta.dirname, "..");
export const DEVSPACE_CLI = join(PROJECT_ROOT, "src", "cli.ts");

export function setupWorkspace(): string {
  savedCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), "devspace-test-"));
  process.chdir(workspace);
  return workspace;
}

export function teardownWorkspace(): void {
  const workspace = process.cwd();
  process.chdir(savedCwd);
  if (existsSync(workspace) && workspace !== savedCwd) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function withIsolatedWorkspace(
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const workspace = setupWorkspace();
    try {
      await fn();
    } finally {
      process.chdir(savedCwd);
      if (existsSync(workspace) && workspace !== savedCwd) {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
}

export function treeKill(proc: ChildProcess): void {
  if (!proc.pid || proc.killed) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
