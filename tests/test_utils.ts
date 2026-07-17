import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";

let savedCwd: string;
export const PROJECT_ROOT = join(import.meta.dirname, "..");
export const DEVSPACE_CLI = join(PROJECT_ROOT, "src", "cli.ts");
const require = createRequire(import.meta.url);
export const TSX_CLI = require.resolve("tsx/cli");

export function waitForProcessOutput(
  proc: ChildProcess,
  marker: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let stderr = "";
    const stdout = proc.stdout;
    if (!stdout) {
      reject(new Error("Child process stdout is not piped"));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer) => {
      output = (output + chunk.toString("utf-8")).slice(-marker.length * 2);
      if (output.includes(marker)) finish();
    };
    const onStderr = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-4096);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `Child process exited before readiness (${code ?? signal ?? "unknown"})${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out waiting for child process output: ${marker}${
              stderr.trim() ? `; stderr: ${stderr.trim()}` : ""
            }`,
          ),
        ),
      timeoutMs,
    );

    stdout.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

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
