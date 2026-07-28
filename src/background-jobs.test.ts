import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BackgroundJobManager,
  MAX_JOB_OUTPUT_BYTES,
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
      slow: "node -e \"setTimeout(() => console.log('slow-job-ok'), 150)\"",
      burst: "node -e \"process.stdout.write('x'.repeat(12000))\"",
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

  const slowStarted = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "slow"],
    timeoutSeconds: 30,
  });
  assert.match(slowStarted.outputCursor ?? "", /^jobc_/);
  const waitStartedAt = performance.now();
  const slowCompleted = await manager.wait(
    slowStarted.jobId,
    slowStarted.outputCursor,
    2,
  );
  assert.equal(slowCompleted.status, "succeeded");
  assert.equal(slowCompleted.waitTimedOut, false);
  assert.match(slowCompleted.output ?? "", /slow-job-ok/);
  assert.ok(performance.now() - waitStartedAt >= 80);
  assert.equal(slowCompleted.outputMode, "tail");
  assert.match(slowCompleted.outputCursor ?? "", /^jobc_/);
  const noRepeatedOutput = await manager.wait(
    slowStarted.jobId,
    slowCompleted.outputCursor,
    1,
  );
  assert.equal(noRepeatedOutput.output, "");

  const burstStarted = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "burst"],
    timeoutSeconds: 30,
  });
  const burstCompleted = await manager.wait(
    burstStarted.jobId,
    burstStarted.outputCursor,
    2,
  );
  assert.equal(burstCompleted.status, "succeeded");
  assert.ok(Buffer.byteLength(burstCompleted.output ?? "") <= 2 * 1024);
  assert.ok((burstCompleted.outputDiscardedBeforeBytes ?? 0) > 0);
  assert.equal(
    manager.list("ws_test", { limit: 2 })[0]?.jobId,
    burstStarted.jobId,
  );
  assert.throws(
    () => manager.list("ws_test", { limit: 51 }),
    /limit must be between/,
  );
  await assert.rejects(
    () => manager.wait(completed.jobId, burstCompleted.outputCursor, 1),
    /Invalid outputCursor/,
  );

  const waitTimeoutJob = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  assert.equal(manager.list("ws_test", { activeOnly: true }).length, 1);
  const waitingHeartbeat = await manager.wait(
    waitTimeoutJob.jobId,
    waitTimeoutJob.outputCursor,
    1,
  );
  assert.equal(waitingHeartbeat.status, "running");
  assert.equal(waitingHeartbeat.waitTimedOut, true);
  manager.cancel(waitTimeoutJob.jobId);
  assert.equal(
    (await manager.wait(waitTimeoutJob.jobId, waitingHeartbeat.outputCursor, 5))
      .status,
    "cancelled",
  );

  if (process.platform !== "win32") {
    const launchdBin = join(root, "launchd-bin");
    mkdirSync(launchdBin);
    symlinkSync(process.execPath, join(launchdBin, "node"));
    const launchdNpm = join(launchdBin, "npm");
    writeFileSync(
      launchdNpm,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("10.9.8-launchd-test");
} else {
  console.log("launchd-job-ok");
}
`,
      { mode: 0o700 },
    );
    const launchdManager = new BackgroundJobManager(
      join(root, "launchd-state"),
      new RunnerRegistry(
        { npm: { executable: launchdNpm } },
        process.platform,
        {
          HOME: root,
          PATH: ["/usr/bin", "/bin"].join(delimiter),
        },
      ),
    );
    const launchdStarted = await launchdManager.start({
      workspaceId: "ws_launchd",
      workspaceRoot,
      workingDirectory: workspaceRoot,
      runner: "npm",
      args: ["run", "verify"],
      timeoutSeconds: 30,
    });
    const launchdCompleted = await waitForTerminal(
      launchdManager,
      launchdStarted.jobId,
    );
    assert.equal(launchdCompleted.status, "succeeded");
    assert.equal(launchdCompleted.runnerVersion, "10.9.8-launchd-test");
    assert.match(launchdCompleted.output ?? "", /launchd-job-ok/);
    launchdManager.close();
  }

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
  assert.equal(cancelled.errorCode, "JOB_CANCELLED");
  assert.match(cancelled.error ?? "", /^JOB_CANCELLED:/);
  assert.equal(manager.cancel(long.jobId).status, "cancelled");

  const parallelA = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  const parallelB = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  await assert.rejects(
    () =>
      manager.start({
        workspaceId: "ws_test",
        workspaceRoot,
        workingDirectory: workspaceRoot,
        runner: "npm",
        args: ["run", "verify"],
        timeoutSeconds: 30,
      }),
    /At most 2 background jobs/,
  );
  manager.cancel(parallelA.jobId);
  assert.equal(
    (await waitForTerminal(manager, parallelA.jobId)).status,
    "cancelled",
  );
  manager.cancel(parallelB.jobId);
  assert.equal(
    (await waitForTerminal(manager, parallelB.jobId)).status,
    "cancelled",
  );
  const thirdLifecycle = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "verify"],
    timeoutSeconds: 30,
  });
  assert.equal(
    (await waitForTerminal(manager, thirdLifecycle.jobId)).status,
    "succeeded",
  );

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
  assert.equal(blenderFailed.errorCode, "BLENDER_FAILED");
  assert.match(blenderFailed.error ?? "", /^BLENDER_FAILED:/);
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
  assert.equal(blenderTimedOut.errorCode, "JOB_TIMEOUT");
  assert.match(blenderTimedOut.error ?? "", /^JOB_TIMEOUT:/);
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
  assert.equal(blenderCancelled.errorCode, "JOB_CANCELLED");
  assert.equal(blenderCancelled.artifactStatus, "incomplete");
  blenderManager.close();

  const fakeHoudiniPath = join(root, "fake-houdini");
  writeFileSync(
    fakeHoudiniPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("Houdini 20.5.410 Test");
  process.exit(0);
}
const args = process.argv.slice(2);
const selected = args.find((value) => /\\.(?:py|hip|hiplc|hipnc)$/i.test(value)) || "";
const script = path.basename(selected);
if (script === "houdini_wait.py") {
  setInterval(() => {}, 1000);
} else if (script === "houdini_output.py") {
  process.stdout.write(Buffer.alloc(${MAX_JOB_OUTPUT_BYTES + 1024}, 0x78));
} else if (script === "houdini_fail.py") {
  process.exit(5);
} else {
  const output = path.join(process.cwd(), "artifacts", "houdini");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "source.hip"), "houdini source fixture");
  fs.writeFileSync(path.join(output, "pieces.bgeo.sc"), "bgeo fixture");
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ runner: script || "hbatch" }));
  console.log("houdini-job-ok");
}
`,
  );
  chmodSync(fakeHoudiniPath, 0o755);
  for (const script of [
    "houdini_job.py",
    "houdini_wait.py",
    "houdini_output.py",
    "houdini_fail.py",
  ]) {
    writeFileSync(join(workspaceRoot, script), "# fake hython fixture");
  }
  writeFileSync(
    join(workspaceRoot, "houdini_build.hscript"),
    "# fake hbatch fixture",
  );
  writeFileSync(join(workspaceRoot, "houdini_scene.hip"), "fake hip fixture");
  const houdiniState = join(root, "houdini-state");
  const houdiniArtifacts = new ArtifactLedger(houdiniState);
  const houdiniManager = new BackgroundJobManager(
    houdiniState,
    new RunnerRegistry({
      hython: {
        executable: fakeHoudiniPath,
        maxConcurrent: 1,
        maxTimeoutSeconds: 2,
      },
      hbatch: {
        executable: fakeHoudiniPath,
        maxConcurrent: 1,
        maxTimeoutSeconds: 2,
      },
    }),
    houdiniArtifacts,
  );
  const hythonSuccess = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hython",
    args: ["houdini_job.py"],
    artifactRoots: ["artifacts/houdini"],
    timeoutSeconds: 2,
  });
  const hythonCompleted = await waitForArtifacts(
    houdiniManager,
    hythonSuccess.jobId,
  );
  assert.equal(hythonCompleted.status, "succeeded");
  assert.equal(hythonCompleted.artifactStatus, "complete");
  assert.equal(hythonCompleted.artifactCount, 3);
  assert.match(hythonCompleted.output ?? "", /houdini-job-ok/);

  const hbatchSuccess = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hbatch",
    args: [
      "-j",
      "2",
      "-c",
      "source houdini_build.hscript",
      "houdini_scene.hip",
    ],
    timeoutSeconds: 2,
  });
  assert.equal(
    (await waitForTerminal(houdiniManager, hbatchSuccess.jobId)).status,
    "succeeded",
  );

  const hythonFailure = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hython",
    args: ["houdini_fail.py"],
    timeoutSeconds: 2,
  });
  const houdiniFailed = await waitForTerminal(
    houdiniManager,
    hythonFailure.jobId,
  );
  assert.equal(houdiniFailed.status, "failed");
  assert.equal(houdiniFailed.errorCode, "HOUDINI_FAILED");

  const hythonOutput = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hython",
    args: ["houdini_output.py"],
    timeoutSeconds: 2,
  });
  const outputCapped = await waitForTerminal(
    houdiniManager,
    hythonOutput.jobId,
  );
  assert.equal(outputCapped.status, "succeeded");
  assert.equal(outputCapped.outputBytes, MAX_JOB_OUTPUT_BYTES);
  assert.equal(outputCapped.outputTruncated, true);

  const hythonLong = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hython",
    args: ["houdini_wait.py"],
    timeoutSeconds: 2,
  });
  await assert.rejects(
    () =>
      houdiniManager.start({
        workspaceId: "ws_test",
        workspaceRoot,
        workingDirectory: workspaceRoot,
        runner: "hython",
        args: ["houdini_job.py"],
        timeoutSeconds: 2,
      }),
    /At most 1 hython job/,
  );
  houdiniManager.cancel(hythonLong.jobId);
  assert.equal(
    (await waitForTerminal(houdiniManager, hythonLong.jobId)).status,
    "cancelled",
  );

  const hythonTimed = await houdiniManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "hython",
    args: ["houdini_wait.py"],
    timeoutSeconds: 1,
  });
  const houdiniTimedOut = await waitForTerminal(
    houdiniManager,
    hythonTimed.jobId,
  );
  assert.equal(houdiniTimedOut.status, "timed_out");
  assert.equal(houdiniTimedOut.errorCode, "JOB_TIMEOUT");
  houdiniManager.close();

  const restoredBlenderArtifacts = new ArtifactLedger(blenderState);
  const restoredBlenderList = await restoredBlenderArtifacts.listArtifacts({
    workspaceId: "ws_test",
    workspaceRoot,
    limit: 20,
  });
  assert.ok(restoredBlenderList.length >= 4);

  const fakeGodotPath = join(root, "fake-godot");
  writeFileSync(
    fakeGodotPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("4.7.1.stable.mono");
  process.exit(0);
}
process.exit(9);
`,
  );
  chmodSync(fakeGodotPath, 0o755);
  const captureManager = new BackgroundJobManager(
    join(root, "capture-state"),
    new RunnerRegistry({
      "godot-mono": {
        executable: fakeGodotPath,
        maxConcurrent: 1,
        maxTimeoutSeconds: 30,
      },
    }),
  );
  const failedCapture = await captureManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "godot-mono",
    args: ["--headless", "--path", ".", "res://capture.tscn"],
    timeoutSeconds: 30,
    captureProfile: "fixture",
  });
  const captureFailed = await waitForTerminal(
    captureManager,
    failedCapture.jobId,
  );
  assert.equal(captureFailed.status, "failed");
  assert.equal(captureFailed.errorCode, "CAPTURE_FAILED");
  assert.match(captureFailed.error ?? "", /^CAPTURE_FAILED:/);
  captureManager.close();

  const interruptedState = join(root, "interrupted-state");
  const interruptedManager = new BackgroundJobManager(interruptedState);
  const interruptedStart = await interruptedManager.start({
    workspaceId: "ws_test",
    workspaceRoot,
    workingDirectory: workspaceRoot,
    runner: "npm",
    args: ["run", "wait"],
    timeoutSeconds: 30,
  });
  const interruptedPid = liveProcessId(
    interruptedManager,
    interruptedStart.jobId,
  );
  interruptedManager.close();
  const interrupted = interruptedManager.poll(interruptedStart.jobId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.errorCode, "JOB_INTERRUPTED");
  assert.match(interrupted.error ?? "", /^JOB_INTERRUPTED:/);
  await waitForProcessExit(interruptedPid);
  const restartedInterruptedManager = new BackgroundJobManager(
    interruptedState,
  );
  const restoredInterrupted = restartedInterruptedManager.poll(
    interruptedStart.jobId,
  );
  assert.equal(restoredInterrupted.status, "interrupted");
  assert.equal(restoredInterrupted.errorCode, "JOB_INTERRUPTED");
  restartedInterruptedManager.close();

  if (process.platform !== "win32") {
    await testCrashProcessGroupRecovery();
  }

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
  // Cancellation allows a 3-second graceful process-group shutdown before
  // SIGKILL. Leave enough CI scheduling margin beyond that production grace.
  for (let attempt = 0; attempt < 200; attempt += 1) {
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

function liveProcessId(manager: BackgroundJobManager, jobId: string): number {
  const internal = manager as unknown as {
    jobs: Map<string, { child?: { pid?: number } }>;
  };
  const pid = internal.jobs.get(jobId)?.child?.pid;
  assert.ok(pid);
  return pid;
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Background process ${pid} remained after manager close.`);
}

async function testCrashProcessGroupRecovery(): Promise<void> {
  const crashState = join(root, "crash-recovery-state");
  const treePidPath = join(workspaceRoot, "crash-tree-pids.json");
  const fakeTreeRunner = join(root, "fake-tree-runner");
  writeFileSync(
    fakeTreeRunner,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("10.0.0");
  process.exit(0);
}
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" }
);
fs.writeFileSync(
  path.join(process.cwd(), "crash-tree-pids.json"),
  JSON.stringify({ parentPid: process.pid, childPid: child.pid })
);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(fakeTreeRunner, 0o755);

  const helperPath = join(root, "crash-manager-helper.mjs");
  const managerModule = pathToFileURL(
    join(process.cwd(), "src", "background-jobs.ts"),
  ).href;
  const registryModule = pathToFileURL(
    join(process.cwd(), "src", "runner-registry.ts"),
  ).href;
  writeFileSync(
    helperPath,
    `import { existsSync } from "node:fs";
import { BackgroundJobManager } from ${JSON.stringify(managerModule)};
import { RunnerRegistry } from ${JSON.stringify(registryModule)};
const manager = new BackgroundJobManager(
  process.env.CRASH_STATE,
  new RunnerRegistry({
    npm: {
      executable: process.env.CRASH_RUNNER,
      maxConcurrent: 1,
      maxTimeoutSeconds: 30
    }
  })
);
const started = await manager.start({
  workspaceId: "ws_crash",
  workspaceRoot: process.env.CRASH_WORKSPACE,
  workingDirectory: process.env.CRASH_WORKSPACE,
  runner: "npm",
  args: ["run", "wait"],
  timeoutSeconds: 30
});
for (let attempt = 0; attempt < 200; attempt += 1) {
  if (existsSync(process.env.CRASH_PID_FILE)) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.stdout.write(JSON.stringify({ jobId: started.jobId }) + "\\n");
process.exit(91);
`,
  );

  const crashed = await runCrashHelper(helperPath, {
    CRASH_STATE: crashState,
    CRASH_RUNNER: fakeTreeRunner,
    CRASH_WORKSPACE: workspaceRoot,
    CRASH_PID_FILE: treePidPath,
  });
  assert.equal(crashed.code, 91);
  assert.equal(existsSync(treePidPath), true);
  const jobId = (JSON.parse(crashed.stdout.trim()) as { jobId: string }).jobId;
  const treePids = JSON.parse(readFileSync(treePidPath, "utf8")) as {
    parentPid: number;
    childPid: number;
  };
  let recoveredManager: BackgroundJobManager | undefined;
  try {
    assert.equal(processAlive(treePids.parentPid), true);
    assert.equal(processAlive(treePids.childPid), true);

    recoveredManager = new BackgroundJobManager(crashState);
    const recovered = recoveredManager.poll(jobId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.errorCode, "JOB_INTERRUPTED");
    await waitForProcessExit(treePids.parentPid);
    await waitForProcessExit(treePids.childPid);

    const persisted = await waitForPersistedCleanup(
      join(crashState, "jobs", `${jobId}.json`),
    );
    assert.equal(persisted.processCleanupPending, false);
    assert.equal("processId" in persisted, false);
    assert.equal("processGroupId" in persisted, false);
    assert.equal("processToken" in persisted, false);
  } finally {
    recoveredManager?.close();
    try {
      process.kill(-treePids.parentPid, "SIGKILL");
    } catch {
      // The recovery path should already have removed the process group.
    }
  }
}

async function runCrashHelper(
  helperPath: string,
  environment: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", helperPath], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPersistedCleanup(
  metadataPath: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const persisted = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (persisted.processCleanupPending === false) return persisted;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Crash-recovered process cleanup remained pending.");
}
