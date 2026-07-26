import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionManager } from "./game-sessions.js";

const root = await mkdtemp(join(tmpdir(), "devspace-game-session-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-game-session-state-"));
await testEagerCrashRecovery();
const projectRoot = join(root, "fixture");
await mkdir(projectRoot, { recursive: true });
await writeFile(
  join(projectRoot, "project.godot"),
  `[application]
config/name="DevSpace Session Fixture"
run/main_scene="res://main.tscn"

[display]
window/size/viewport_width=320
window/size/viewport_height=180

[input]
fixture_action={
"deadzone": 0.5,
"events": []
}

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`,
);
await writeFile(
  join(projectRoot, "fixture.gd"),
  `extends Node2D

var action_count := 0
var click_count := 0

func _input(event: InputEvent) -> void:
	if event is InputEventAction and event.action == "fixture_action" and event.pressed:
		action_count += 1
		print("DEVSPACE_FIXTURE_ACTION:", action_count)
	if event is InputEventMouseButton and event.pressed:
		click_count += 1
		print("DEVSPACE_FIXTURE_CLICK:", click_count)
`,
);
await writeFile(
  join(projectRoot, "main.tscn"),
  `[gd_scene load_steps=2 format=3]

[ext_resource path="res://fixture.gd" type="Script" id="1"]

[node name="FixtureRoot" type="Node2D"]
script = ExtResource("1")

[node name="Backdrop" type="ColorRect" parent="."]
offset_right = 320.0
offset_bottom = 180.0
color = Color(0.12, 0.25, 0.5, 1)
`,
);
await writeFile(
  join(projectRoot, "crash.gd"),
  `extends Node

func _ready() -> void:
	await get_tree().create_timer(0.25).timeout
	get_tree().quit(7)
`,
);
await writeFile(
  join(projectRoot, "crash.tscn"),
  `[gd_scene load_steps=2 format=3]

[ext_resource path="res://crash.gd" type="Script" id="1"]

[node name="CrashFixture" type="Node"]
script = ExtResource("1")
`,
);

const manager = new GameSessionManager(stateDir);
let activeSessionId: string | undefined;
try {
  const started = await manager.start({
    workspaceId: "ws_game_fixture",
    workspaceRoot: root,
    projectPath: "fixture",
    scene: "res://main.tscn",
    engine: "auto",
    viewportWidth: 320,
    viewportHeight: 180,
  });
  assert.equal(started.status, "running");
  activeSessionId = started.sessionId;
  assert.match(started.sessionId, /^session_/);
  assert.ok(started.engineVersion);
  assert.equal(started.viewport.width, 320);
  assert.equal("processToken" in started, false);

  await assert.rejects(
    manager.start({
      workspaceId: "ws_game_fixture",
      workspaceRoot: root,
      projectPath: "fixture",
      scene: "res://main.tscn",
    }),
    /GAME_SESSION_WORKSPACE_BUSY/,
  );
  await assert.rejects(
    manager.inspect("ws_other", started.sessionId),
    /GAME_SESSION_WORKSPACE_MISMATCH/,
  );
  await assert.rejects(
    manager.start({
      workspaceId: "ws_bad_scene",
      workspaceRoot: root,
      projectPath: "fixture",
      scene: "res://../main.tscn",
    }),
    /GAME_SESSION_SCENE_INVALID/,
  );

  const inspected = await manager.inspect("ws_game_fixture", started.sessionId);
  assert.ok(inspected.nodes?.some((node) => node.path === "."));
  assert.ok(inspected.nodes?.some((node) => node.path === "Backdrop"));
  assert.ok((inspected.nodes?.length ?? 0) <= 500);

  assert.deepEqual(
    await manager.sendInput("ws_game_fixture", started.sessionId, {
      kind: "action",
      action: "fixture_action",
      operation: "tap",
      frames: 2,
    }),
    { accepted: true },
  );
  await assert.rejects(
    manager.sendInput("ws_game_fixture", started.sessionId, {
      kind: "action",
      action: "not_registered",
      operation: "tap",
    }),
    /GAME_SESSION_ACTION_UNKNOWN/,
  );
  await manager.sendInput("ws_game_fixture", started.sessionId, {
    kind: "click",
    x: 100,
    y: 80,
    button: "left",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    manager.sendInput("ws_game_fixture", started.sessionId, {
      kind: "click",
      x: 321,
      y: 80,
      button: "left",
    }),
    /GAME_SESSION_INPUT_INVALID/,
  );

  const frame = await manager.capture("ws_game_fixture", started.sessionId);
  assert.equal(frame.width, 320);
  assert.equal(frame.height, 180);
  assert.match(frame.sha256, /^[0-9a-f]{64}$/);
  assert.ok(frame.bytes > 100);
  assert.deepEqual(
    Buffer.from(frame.data, "base64").subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const logs = manager.readLogs(
    "ws_game_fixture",
    started.sessionId,
    0,
    256 * 1024,
  );
  assert.match(logs.output, /\[bridge\] authenticated/);
  assert.match(logs.output, /DEVSPACE_FIXTURE_ACTION:1/);
  assert.match(logs.output, /DEVSPACE_FIXTURE_CLICK:1/);
  assert.equal(logs.nextOutputOffsetBytes, logs.totalBytes);

  const stopped = await manager.stop("ws_game_fixture", started.sessionId);
  assert.equal(stopped.status, "stopped");
  assert.equal(
    (await manager.stop("ws_game_fixture", started.sessionId)).status,
    "stopped",
  );

  const persisted = JSON.parse(
    await readFile(
      join(stateDir, "game-sessions", `${started.sessionId}.json`),
      "utf8",
    ),
  ) as {
    status: string;
    dirtyDiffSha256: string;
    statusSha256: string;
    workspaceRoot: string;
    processToken?: string;
  };
  assert.equal(persisted.status, "stopped");
  assert.match(persisted.dirtyDiffSha256, /^[0-9a-f]{64}$/);
  assert.match(persisted.statusSha256, /^[0-9a-f]{64}$/);
  assert.equal(persisted.workspaceRoot, root);
  assert.match(persisted.processToken ?? "", /^[0-9a-f-]{36}$/);

  const crash = await manager.start({
    workspaceId: "ws_crash_fixture",
    workspaceRoot: root,
    projectPath: "fixture",
    scene: "res://crash.tscn",
    viewportWidth: 320,
    viewportHeight: 180,
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const crashed = await manager.inspect("ws_crash_fixture", crash.sessionId);
  assert.equal(crashed.status, "crashed");
  assert.equal(crashed.exitCode, 7);

  const interrupted = await manager.start({
    workspaceId: "ws_restart_fixture",
    workspaceRoot: root,
    projectPath: "fixture",
    scene: "res://main.tscn",
    viewportWidth: 320,
    viewportHeight: 180,
  });
  manager.close();
  const restoredManager = new GameSessionManager(stateDir);
  try {
    const restored = await restoredManager.inspect(
      "ws_restart_fixture",
      interrupted.sessionId,
    );
    assert.equal(restored.status, "interrupted");
  } finally {
    restoredManager.close();
  }

  console.log("game session tests passed");
} catch (error) {
  if (activeSessionId) {
    console.error(
      manager.readLogs("ws_game_fixture", activeSessionId, 0, 256 * 1024)
        .output,
    );
  }
  throw error;
} finally {
  manager.close();
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

async function testEagerCrashRecovery(): Promise<void> {
  const recoveryStateDir = await mkdtemp(
    join(tmpdir(), "devspace-game-session-recovery-"),
  );
  let child: ChildProcess | undefined;
  try {
    const sessionsDir = join(recoveryStateDir, "game-sessions");
    await mkdir(sessionsDir, { recursive: true });
    const processToken = randomUUID();
    child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],
      {
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          DEVSPACE_PROCESS_TOKEN: processToken,
        },
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
    child.unref();
    const sessionId = `session_${randomUUID()}`;
    const emptyHash = "0".repeat(64);
    await writeFile(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(
        {
          sessionId,
          workspaceId: "ws_recovery_fixture",
          workspaceRoot: root,
          projectPath: "fixture",
          scene: "res://main.tscn",
          engine: "godot",
          viewport: { width: 320, height: 180 },
          status: "running",
          startedAt: new Date().toISOString(),
          dirtyDiffSha256: emptyHash,
          statusSha256: emptyHash,
          untrackedCount: 0,
          processId: child.pid,
          processGroupId: process.platform === "win32" ? undefined : child.pid,
          processToken,
        },
        null,
        2,
      ),
    );

    const recovered = new GameSessionManager(recoveryStateDir);
    const immediate = JSON.parse(
      await readFile(join(sessionsDir, `${sessionId}.json`), "utf8"),
    ) as { status: string };
    assert.equal(immediate.status, "interrupted");
    if (process.platform !== "win32") {
      await waitUntilExited(child, 6_000);
      assert.equal(isProcessAlive(child.pid), false);
    }
    recovered.close();
  } finally {
    if (child?.pid && isProcessAlive(child.pid)) {
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          "SIGKILL",
        );
      } catch {
        // Already exited.
      }
    }
    await rm(recoveryStateDir, { recursive: true, force: true });
  }
}

async function waitUntilExited(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (!child.pid || !isProcessAlive(child.pid)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Recovery process did not exit.")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
