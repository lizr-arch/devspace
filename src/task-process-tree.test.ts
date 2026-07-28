import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRunner, type TaskSessionResult } from "./task-runner.js";

const root = await mkdtemp(join(tmpdir(), "devspace-task-tree-"));

try {
  await mkdir(join(root, ".devspace"), { recursive: true });
  const scriptPath = join(root, "process-tree.mjs");
  await writeFile(
    scriptPath,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  const timeoutPidFile = join(root, "timeout-pids.json");
  const sessionPidFile = join(root, "session-pids.json");
  await writeFile(
    join(root, ".devspace", "tasks.yaml"),
    `version: 1
tasks:
  timeout-tree:
    mode: run
    runtime: system
    timeout_seconds: 1
    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(scriptPath)}, ${JSON.stringify(timeoutPidFile)}]
  session-tree:
    mode: session
    runtime: system
    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(scriptPath)}, ${JSON.stringify(sessionPidFile)}]
`,
  );

  const runner = new TaskRunner();
  const timedOut = await runner.runTask({
    workspaceId: "ws_tree",
    workspaceRoot: root,
    taskId: "timeout-tree",
    params: {},
    additionalRoots: [],
  });
  assert.equal(timedOut.mode, "run");
  assert.equal(timedOut.status, "timed_out");
  const timeoutPids = await waitForPids(timeoutPidFile);
  await assertTreeStopped(timeoutPids);

  const started = (await runner.runTask({
    workspaceId: "ws_tree",
    workspaceRoot: root,
    taskId: "session-tree",
    params: {},
    additionalRoots: [],
  })) as TaskSessionResult;
  const sessionPids = await waitForPids(sessionPidFile);
  assert.equal(runner.stopSession(started.sessionId), true);
  await assertTreeStopped(sessionPids);
  assert.equal(runner.getSession(started.sessionId)?.status, "stopped");

  console.log("PASS: task timeout and stop terminate the process tree");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function waitForPids(
  path: string,
): Promise<{ parent: number; child: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        parent: number;
        child: number;
      };
    } catch {
      await delay(25);
    }
  }
  throw new Error(`PID file was not created: ${path}`);
}

async function assertTreeStopped(pids: {
  parent: number;
  child: number;
}): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isProcessAlive(pids.parent) && !isProcessAlive(pids.child)) return;
    await delay(25);
  }
  assert.fail(
    `Process tree still alive: parent=${pids.parent}, child=${pids.child}`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
