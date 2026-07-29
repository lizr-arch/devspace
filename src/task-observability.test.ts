import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRunner } from "./task-runner.js";

const root = await mkdtemp(join(tmpdir(), "devspace-task-observability-"));

try {
  await mkdir(join(root, ".devspace"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "tasks.yaml"),
    `version: 1
tasks:
  delayed:
    mode: run
    command:
      - node
      - -e
      - "console.log('started'); setTimeout(() => console.log('finished'), 250)"
    runtime: system
    timeout_seconds: 5
`,
  );

  const runner = new TaskRunner();
  const runPromise = runner.runTask({
    workspaceId: "ws_task_observability",
    workspaceRoot: root,
    taskId: "delayed",
    params: {},
    additionalRoots: [],
  });

  let running = runner.listSessions("ws_task_observability")[0];
  for (let attempt = 0; !running && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    running = runner.listSessions("ws_task_observability")[0];
  }

  assert.ok(running, "run-mode task should be discoverable before completion");
  assert.equal(running.status, "running");
  assert.equal(runner.listSessions("ws_other").length, 0);

  const settled = await runner.waitSession(running.sessionId, 2_000);
  assert.ok(settled);
  assert.equal(settled.status, "succeeded");
  assert.match(settled.stdout, /started/);
  assert.match(settled.stdout, /finished/);

  const result = await runPromise;
  assert.equal(result.sessionId, running.sessionId);
  assert.equal(result.status, "succeeded");

  console.log(
    "PASS: run-mode task sessions can be listed and waited after interruption",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
