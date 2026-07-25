import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundJobManager,
  validateJobArguments,
} from "./background-jobs.js";
import { RunnerRegistry } from "./runner-registry.js";
import { ArtifactLedger } from "./artifact-ledger.js";

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

  const fakeBlenderPath = join(root, "fake-blender");
  writeFileSync(
    fakeBlenderPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("Blender 5.2.0 Test");
  process.exit(0);
}
const pythonIndex = process.argv.indexOf("--python");
const script = pythonIndex >= 0 ? path.basename(process.argv[pythonIndex + 1] || "") : "";
const output = path.join(process.cwd(), "artifacts", "blender");
fs.mkdirSync(output, { recursive: true });
if (script === "wait.py") {
  setInterval(() => {}, 1000);
} else {
  const stamp = script + String(Date.now());
  fs.writeFileSync(path.join(output, "source.blend"), Buffer.from("BLENDER-v305" + stamp));
  fs.writeFileSync(path.join(output, "ship.glb"), Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0, 16, 0, 0, 0]), Buffer.from(stamp)]));
  fs.writeFileSync(path.join(output, "preview.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(stamp)]));
  fs.writeFileSync(path.join(output, "asset_manifest.json"), JSON.stringify({ stamp, vertexCount: 24, triangleCount: 12 }));
  if (script === "fail.py") process.exit(7);
}
`,
  );
  chmodSync(fakeBlenderPath, 0o755);
  for (const script of ["create_asset.py", "fail.py", "wait.py"]) {
    writeFileSync(join(workspaceRoot, script), "# fake blender fixture");
  }
  const blenderState = join(root, "blender-state");
  const blenderArtifacts = new ArtifactLedger(blenderState);
  const blenderManager = new BackgroundJobManager(
    blenderState,
    new RunnerRegistry({
      blender: {
        executable: fakeBlenderPath,
        maxConcurrent: 1,
        maxTimeoutSeconds: 2,
      },
    }),
    blenderArtifacts,
  );
  const blenderSuccess = await blenderManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "blender",
    args: [
      "--background",
      "--factory-startup",
      "--offline-mode",
      "--disable-autoexec",
      "--python-exit-code",
      "23",
      "--python",
      "create_asset.py",
    ],
    artifactRoots: ["artifacts/blender"],
    timeoutSeconds: 2,
  });
  const blenderCompleted = await waitForArtifacts(
    blenderManager,
    blenderSuccess.jobId,
  );
  assert.equal(blenderCompleted.status, "succeeded");
  assert.equal(blenderCompleted.artifactStatus, "complete");
  assert.equal(blenderCompleted.artifactCount, 4);
  const blenderList = await blenderArtifacts.listArtifacts({
    workspaceId: "ws_test",
    workspaceRoot,
    jobId: blenderSuccess.jobId,
  });
  assert.equal(blenderList.length, 4);
  assert.ok(blenderList.every((artifact) => artifact.presence === "present"));
  assert.ok(blenderList.every((artifact) => artifact.sha256.length === 64));

  const blenderFailure = await blenderManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "blender",
    args: ["--background", "--python-exit-code", "23", "--python", "fail.py"],
    artifactRoots: ["artifacts/blender"],
    timeoutSeconds: 2,
  });
  const blenderFailed = await waitForArtifacts(
    blenderManager,
    blenderFailure.jobId,
  );
  assert.equal(blenderFailed.status, "failed");
  assert.equal(blenderFailed.artifactStatus, "incomplete");
  assert.ok(blenderFailed.artifactCount > 0);

  const blenderTimeout = await blenderManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "blender",
    args: ["--background", "--python-exit-code", "23", "--python", "wait.py"],
    artifactRoots: ["artifacts/blender"],
    timeoutSeconds: 1,
  });
  const blenderTimedOut = await waitForArtifacts(
    blenderManager,
    blenderTimeout.jobId,
  );
  assert.equal(blenderTimedOut.status, "timed_out");
  assert.equal(blenderTimedOut.artifactStatus, "incomplete");

  const blenderCancel = await blenderManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "blender",
    args: ["--background", "--python-exit-code", "23", "--python", "wait.py"],
    artifactRoots: ["artifacts/blender"],
    timeoutSeconds: 2,
  });
  blenderManager.cancel(blenderCancel.jobId);
  const blenderCancelled = await waitForArtifacts(
    blenderManager,
    blenderCancel.jobId,
  );
  assert.equal(blenderCancelled.status, "cancelled");
  assert.equal(blenderCancelled.artifactStatus, "incomplete");
  blenderManager.close();

  const restoredBlenderArtifacts = new ArtifactLedger(blenderState);
  const restoredBlenderList = await restoredBlenderArtifacts.listArtifacts({
    workspaceId: "ws_test",
    workspaceRoot,
    limit: 20,
  });
  assert.ok(restoredBlenderList.length >= 4);

  console.log("background job tests passed");
} finally {
  manager.close();
  rmSync(root, { recursive: true, force: true });
}

async function waitForArtifacts(manager: BackgroundJobManager, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = manager.poll(jobId);
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
        snapshot.status,
      ) &&
      snapshot.artifactStatus !== "pending"
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for artifacts from ${jobId}`);
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
