import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BackgroundJobManager } from "./background-jobs.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-background-recovery-"));
const workspaceRoot = join(root, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(
  join(workspaceRoot, "package.json"),
  JSON.stringify({
    private: true,
    scripts: {
      wait: 'node -e "setTimeout(() => {}, 30000)"',
    },
  }),
);

if (process.platform !== "win32") {
  await testCrashProcessGroupRecovery();
  console.log("background job crash recovery tests passed");
} else {
  console.log("background job crash recovery tests skipped on Windows");
}

rmSync(root, {
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 20 : 0,
  retryDelay: 50,
});

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
