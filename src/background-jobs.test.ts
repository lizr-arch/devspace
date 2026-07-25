import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundJobManager,
  validateJobArguments,
} from "./background-jobs.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-background-jobs-"));
const stateDir = join(root, "state");
const workspaceRoot = join(root, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(
  join(workspaceRoot, "package.json"),
  JSON.stringify({
    private: true,
    scripts: {
      verify: "node -e \"console.log('job-ok')\"",
      wait: 'node -e "setTimeout(() => {}, 30000)"',
    },
  }),
);

const manager = new BackgroundJobManager(stateDir);
try {
  assert.throws(() => validateJobArguments("npm", ["install"]), /only allow/);
  assert.throws(
    () => validateJobArguments("dotnet", ["test", "/tmp/outside.csproj"]),
    /absolute or parent paths/,
  );
  assert.throws(
    () => validateJobArguments("godot-mono", ["--path", "."]),
    /--headless/,
  );

  const started = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "verify"],
    timeoutSeconds: 30,
  });
  assert.equal(started.status, "running");

  const completed = await waitForTerminal(manager, started.jobId);
  assert.equal(completed.status, "succeeded");
  assert.match(completed.output ?? "", /job-ok/);
  assert.equal(completed.exitCode, 0);

  const long = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  const cancelling = manager.cancel(long.jobId);
  assert.equal(cancelling.status, "cancelling");
  const cancelled = await waitForTerminal(manager, long.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(manager.cancel(long.jobId).status, "cancelled");

  const singleRunnerManager = new BackgroundJobManager(
    join(root, "single-runner-state"),
    new RunnerRegistry({ npm: { maxConcurrent: 1, maxTimeoutSeconds: 30 } }),
  );
  const singleLong = await singleRunnerManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  await assert.rejects(
    () =>
      singleRunnerManager.start({
        workspaceId: "ws_test",
        workspaceRoot,
        workingDirectory: workspaceRoot,
        runner: "npm",
        args: ["run", "verify"],
        timeoutSeconds: 30,
      }),
    /At most 1 npm job/,
  );
  singleRunnerManager.cancel(singleLong.jobId);
  await waitForTerminal(singleRunnerManager, singleLong.jobId);
  singleRunnerManager.close();

  const restoredManager = new BackgroundJobManager(stateDir);
  const restored = restoredManager.poll(completed.jobId);
  assert.equal(restored.status, "succeeded");
  assert.match(restored.output ?? "", /job-ok/);
  restoredManager.close();

  console.log("background job tests passed");
} finally {
  manager.close();
  rmSync(root, { recursive: true, force: true });
}

async function waitForTerminal(manager: BackgroundJobManager, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = manager.poll(jobId);
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
        snapshot.status,
      )
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}
