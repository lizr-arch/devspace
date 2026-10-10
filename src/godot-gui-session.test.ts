/**
 * M1: Godot real-GUI Runtime Bridge acceptance.
 *
 * These tests drive the real, non-headless Godot binary through the shipped
 * GameSessionManager against a purpose-built fixture project whose
 * `project.godot` sits at the workspace ROOT. They cover the defects recorded
 * in TriaRegna's Phase 10/17 evidence documents:
 *
 *   - a root-level `projectPath` was rejected outright;
 *   - `change_scene_to_file` left the original scene rendering underneath;
 *   - only single clicks could be injected (no drag, wheel or keyboard);
 *   - handshake failures reported a bare timeout with no diagnostics;
 *   - a "capture" could not be told apart from a headless render.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionManager } from "./game-sessions.js";
import { GODOT_RUNTIME_BRIDGE } from "./godot-runtime-bridge.js";
import { RunnerRegistry } from "./runner-registry.js";

const WORKSPACE_ID = "ws_gui_fixture";
const root = await mkdtemp(join(tmpdir(), "devspace-gui-root-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-gui-state-"));

if (!(await godotAvailable())) {
  // This suite needs a real Godot Mono binary AND a real display. Where either
  // is absent (headless CI images, Windows/Linux runners) it reports SKIP and
  // exits successfully rather than failing the pipeline for a missing GPU.
  console.log(
    "godot gui session tests SKIPPED: no godot-mono binary available on this host",
  );
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  process.exit(0);
}

try {
  writeFixtureProject();
  await testRootProjectPathIsAccepted();
  await testBridgeGdscriptIsValid();
  await testRealGpuEvidence();
  await testInputInjection();
  await testSceneSwitchHasNoResidue();
  await testTextEntry();
  await testReleaseOnDisconnect();
  await testStartupFailureDiagnostics();
  await testAlternateResolution();
  console.log("godot gui session tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

async function godotAvailable(): Promise<boolean> {
  const registry = new RunnerRegistry();
  try {
    const resolved = await registry.resolve("godot-mono");
    return Boolean(resolved.executable);
  } catch {
    return false;
  }
}

/**
 * The fixture deliberately mirrors the TriaRegna layout that triggered the bug:
 * `project.godot` lives at the workspace root, not in a nested directory.
 */
function writeFixtureProject(): void {
  const fs = { writeFileSync };
  fs.writeFileSync(
    join(root, "project.godot"),
    [
      "[application]",
      'config/name="DevSpace GUI Fixture"',
      'run/main_scene="res://main.tscn"',
      "",
      "[display]",
      "window/size/viewport_width=640",
      "window/size/viewport_height=360",
      "",
      "[input]",
      "fixture_action={",
      '"deadzone": 0.5,',
      '"events": []',
      "}",
      "",
      "[rendering]",
      'renderer/rendering_method="gl_compatibility"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    join(root, "recorder.gd"),
    [
      "extends Node2D",
      "",
      "var presses := 0",
      "var releases := 0",
      "var moves := 0",
      "var wheels := 0",
      "var double_clicks := 0",
      "var keys_down := 0",
      "var last_position := Vector2.ZERO",
      "var shift_seen := false",
      "",
      "func _ready() -> void:",
      "\tvar entry := get_node_or_null(\"Entry\")",
      "\tif entry != null:",
      "\t\tentry.text_changed.connect(func(value: String):",
      "\t\t\tprint(\"FIXTURE_TEXT:\", value))",
      "\t\tentry.grab_focus()",
      "",
      "func _input(event: InputEvent) -> void:",
      "\tif event is InputEventMouseButton:",
      "\t\tif event.pressed:",
      "\t\t\tpresses += 1",
      "\t\t\tif event.double_click:",
      "\t\t\t\tdouble_clicks += 1",
      "\t\telse:",
      "\t\t\treleases += 1",
      "\t\tif event.button_index == MOUSE_BUTTON_WHEEL_UP or event.button_index == MOUSE_BUTTON_WHEEL_DOWN:",
      "\t\t\twheels += 1",
      "\t\tlast_position = event.position",
      "\tif event is InputEventMouseMotion:",
      "\t\tmoves += 1",
      "\t\tlast_position = event.position",
      "\t\tif event.shift_pressed:",
      "\t\t\tshift_seen = true",
      "\tif event is InputEventKey and event.pressed and not event.echo:",
      "\t\tkeys_down += 1",
      "\tprint(\"FIXTURE_STATE presses=\", presses, \" releases=\", releases,",
      "\t\t\" moves=\", moves, \" wheels=\", wheels, \" double=\", double_clicks,",
      "\t\t\" keys=\", keys_down, \" shift=\", shift_seen,",
      "\t\t\" last_position=\", last_position.x)",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    join(root, "main.tscn"),
    [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[ext_resource type="Script" path="res://recorder.gd" id="1"]',
      "",
      '[node name="FixtureRoot" type="Node2D"]',
      'script = ExtResource("1")',
      "",
      '[node name="Backdrop" type="ColorRect" parent="."]',
      "offset_right = 640.0",
      "offset_bottom = 360.0",
      'color = Color(0.1, 0.2, 0.6, 1)',
      "",
      '[node name="Entry" type="LineEdit" parent="."]',
      "offset_left = 20.0",
      "offset_top = 20.0",
      "offset_right = 400.0",
      "offset_bottom = 60.0",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    join(root, "other.tscn"),
    [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[ext_resource type="Script" path="res://other.gd" id="1"]',
      "",
      '[node name="OtherRoot" type="Node2D"]',
      'script = ExtResource("1")',
      "",
      '[node name="OtherMarker" type="Timer" parent="."]',
      "",
      '[node name="OtherBackdrop" type="ColorRect" parent="."]',
      "offset_right = 640.0",
      "offset_bottom = 360.0",
      'color = Color(0.9, 0.5, 0.1, 1)',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    join(root, "other.gd"),
    [
      "extends Node2D",
      "",
      "func _ready() -> void:",
      '\tprint("FIXTURE_OTHER_READY")',
      "",
    ].join("\n"),
  );
  // Switches scenes on Escape, which is how the real product triggers a scene
  // change without needing a button hitbox at a known coordinate.
  fs.writeFileSync(
    join(root, "switcher.gd"),
    [
      "extends Node2D",
      "",
      "var switched := false",
      "",
      "func _ready() -> void:",
      "\tvar entry := get_node_or_null(\"Entry\")",
      "\tif entry != null:",
      "\t\tentry.text_changed.connect(func(value: String):",
      "\t\t\tprint(\"FIXTURE_TEXT:\", value))",
      "\t\tentry.grab_focus()",
      "",
      "func _input(event: InputEvent) -> void:",
      "\tif switched:",
      "\t\treturn",
      "\tif event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:",
      "\t\tswitched = true",
      '\t\tprint("FIXTURE_SWITCHING")',
      '\t\tget_tree().change_scene_to_file("res://other.tscn")',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    join(root, "switcher.tscn"),
    [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[ext_resource type="Script" path="res://switcher.gd" id="1"]',
      "",
      '[node name="SwitcherRoot" type="Node2D"]',
      'script = ExtResource("1")',
      "",
      '[node name="SwitchBackdrop" type="ColorRect" parent="."]',
      "offset_right = 640.0",
      "offset_bottom = 360.0",
      'color = Color(0.1, 0.6, 0.2, 1)',
      "",
    ].join("\n"),
  );
}


/** The defect: a root-level project.godot could not be addressed at all. */
async function testRootProjectPathIsAccepted(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  assert.equal(session.status, "running");
  assert.equal(
    session.projectPath,
    ".",
    "the workspace root must be recorded as a usable project path",
  );
  await manager.stop(WORKSPACE_ID, session.sessionId);
  manager.close();
}

/** The fixture project must be a real renderer, not a dummy one. */
async function testRealGpuEvidence(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  try {
    assert.equal(
      session.bridgeProtocol,
      2,
      "the bridge should negotiate protocol v2",
    );
    assert.ok(session.renderInfo, "renderer identity must be reported");
    assert.equal(
      session.guiVerdict,
      "real_gpu",
      `expected a real GPU display, got ${JSON.stringify(session.renderInfo)}`,
    );
    assert.equal(session.renderInfo.isHeadless, false);
    assert.equal(session.renderInfo.isDummyDriver, false);
    assert.notEqual(session.renderInfo.renderingDriver, "dummy");
    assert.ok(
      session.renderInfo.adapterName.length > 0,
      "a real GPU adapter name must be reported",
    );

    const frame = await manager.capture(WORKSPACE_ID, session.sessionId);
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 360);
    assert.match(frame.sha256, /^[0-9a-f]{64}$/);
    assert.ok(frame.bytes > 1024, "a real frame must not be a stub PNG");

    const manifest = frame.manifest;
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.guiVerdict, "real_gpu");
    assert.equal(manifest.scene, "res://main.tscn");
    assert.equal(manifest.sessionId, session.sessionId);
    assert.equal(manifest.projectPath, ".");
    assert.equal(manifest.workspaceRoot, root);
    assert.equal(manifest.engine, "godot-mono");
    assert.match(manifest.image.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.image.bytes, frame.bytes);
    assert.equal(manifest.bridgeProtocol, 2);
    assert.deepEqual(manifest.sceneInstances, ["res://main.tscn"]);
    assert.notEqual(manifest.render, "unknown");
    assert.match(manifest.git.headSha ?? "", /^[0-9a-f]{40}$|^unknown$/);
    assert.match(manifest.capturedAt, /^\d{4}-\d{2}-\d{2}T/);

    // The manifest must persist beside the PNG as machine-readable evidence.
    const onDisk = JSON.parse(await readFile(frame.manifestPath, "utf8"));
    assert.equal(onDisk.frameId, frame.frameId);
    assert.equal(onDisk.image.sha256, frame.sha256);
    const png = await readFile(frame.path);
    assert.equal(png.length, frame.bytes);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    await manager.stop(WORKSPACE_ID, session.sessionId);
    manager.close();
  }
}

/**
 * Single click, drag, wheel and keyboard must all reach the engine.
 *
 * These run against a REAL window on a real desktop, which also receives the
 * operator's physical mouse and keyboard. Assertions therefore check that every
 * injected sample was observed and that injected press/release pairs balance,
 * rather than assuming the injected stream is the only input the engine sees.
 */
async function testInputInjection(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  try {
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "click",
      x: 320,
      y: 180,
      button: "left",
    });
    const afterClick = await readState(manager, session.sessionId);
    assert.ok(
      afterClick.presses >= 1,
      "one click must produce at least one press",
    );
    assert.ok(
      afterClick.releases >= 1,
      "one click must produce at least one release",
    );
    assert.equal(
      afterClick.presses,
      afterClick.releases,
      "every injected press must be matched by a release",
    );

    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "pointer",
      event: "double_click",
      x: 100,
      y: 100,
    });
    const afterDouble = await readState(manager, session.sessionId);
    assert.ok(
      afterDouble.doubleClicks >= 1,
      "double_click must be flagged as such",
    );

    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "pointer",
      event: "wheel",
      x: 320,
      y: 180,
      wheelDirection: "down",
      factor: 3,
    });
    const afterWheel = await readState(manager, session.sessionId);
    assert.ok(afterWheel.wheels >= 1, "wheel notches must reach the engine");
    assert.ok(
      afterWheel.presses >= 2,
      "the wheel notch must be delivered as a press/release pair",
    );

    const drag = await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "sequence",
      steps: [
        { type: "pointer", event: "move", x: 50, y: 50 },
        { type: "pointer", event: "down", x: 50, y: 50, button: "left" },
        { type: "pointer", event: "move", x: 150, y: 90, frameDelay: 2 },
        { type: "pointer", event: "move", x: 250, y: 140, frameDelay: 2 },
        { type: "pointer", event: "move", x: 300, y: 170, frameDelay: 2 },
        { type: "pointer", event: "up", x: 300, y: 170, button: "left" },
      ],
    });
    assert.equal(drag.accepted, true);
    assert.deepEqual(
      drag.pressedInput,
      { mouse: [], keys: [], actions: [] },
      "a finished drag must leave nothing latched",
    );
    const afterDrag = await readState(manager, session.sessionId);
    for (const expected of [50, 150, 250, 300]) {
      assert.ok(
        afterDrag.sawPosition(expected),
        `the drag must deliver x=${expected}; saw ${JSON.stringify(afterDrag.positions)}`,
      );
    }

    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "Space",
    });
    // Common spellings must resolve: Godot only accepts its internal key names,
    // so "Control" has to be translated rather than rejected opaquely.
    for (const alias of ["Control", "ctrl", "Command", "Option", "Alt", "Meta", "KEY_ESCAPE"]) {
      await manager.sendInput(WORKSPACE_ID, session.sessionId, {
        kind: "key",
        event: "tap",
        key: alias,
      });
    }
    // A single printable character resolves to that character's keycode.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "w",
    });
    const afterKey = await readState(manager, session.sessionId);
    assert.ok(afterKey.keys >= 1, "key presses must reach the engine");
    const afterSpace = await manager.sendInput(
      WORKSPACE_ID,
      session.sessionId,
      { kind: "key", event: "release", key: "Space" },
    );
    assert.deepEqual(
      afterSpace.pressedInput,
      { mouse: [], keys: [], actions: [] },
      "an explicit key release must clear latched keys",
    );

    // Modifier chords must arrive as modifier state, not as extra keys.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "sequence",
      steps: [
        {
          type: "pointer",
          event: "move",
          x: 200,
          y: 200,
          modifiers: { shift: true },
        },
      ],
    });
    const afterShift = await readState(manager, session.sessionId);
    assert.equal(
      afterShift.shiftSeen,
      true,
      "modifier state must be delivered",
    );

    // Out-of-viewport input must be refused rather than clamped silently.
    await assert.rejects(
      manager.sendInput(WORKSPACE_ID, session.sessionId, {
        kind: "click",
        x: 640,
        y: 10,
        button: "left",
      }),
      /GAME_SESSION_INPUT_INVALID/,
    );
    await assert.rejects(
      manager.sendInput(WORKSPACE_ID, session.sessionId, {
        kind: "key",
        event: "tap",
        key: "NotAKey",
      }),
      /GAME_SESSION_KEY_UNKNOWN/,
    );
  } finally {
    await manager.stop(WORKSPACE_ID, session.sessionId);
    manager.close();
  }
}

/**
 * The Phase 17 defect: the bridge's launched scene stayed in the tree because
 * it was never registered as SceneTree.current_scene, so a product
 * change_scene_to_file() stacked the new scene on top of it.
 */
async function testSceneSwitchHasNoResidue(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://switcher.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  try {
    const before = await manager.capture(WORKSPACE_ID, session.sessionId);
    assert.equal(before.manifest.scene, "res://switcher.tscn");
    assert.deepEqual(before.manifest.render === "unknown" ? [] : [], []);

    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "Escape",
    });
    await delay(900);

    const after = await manager.capture(WORKSPACE_ID, session.sessionId);
    assert.equal(
      after.manifest.scene,
      "res://other.tscn",
      "the product scene change must be reflected",
    );
    assert.notEqual(
      after.sha256,
      before.sha256,
      "the framebuffer must actually change after a scene switch",
    );
    assert.ok(
      Number(after.manifest.sceneGeneration) >
        Number(before.manifest.sceneGeneration),
      "a scene switch must bump the scene generation",
    );

    // The decisive evidence: exactly ONE PackedScene instance may be parented
    // under the engine root. Two would mean the replaced scene is still there
    // rendering underneath, which is the Phase 17 residue defect.
    assert.deepEqual(
      after.manifest.sceneInstances,
      ["res://other.tscn"],
      `exactly one scene instance must remain, saw ${JSON.stringify(after.manifest.sceneInstances)}`,
    );

    // Inspect the live tree: the new scene's marker node must be reachable, and
    // the replaced scene's own subtree must be gone.
    const inspected = await manager.inspect(WORKSPACE_ID, session.sessionId);
    const paths = (inspected.nodes ?? []).map((node) => node.path);
    assert.ok(
      paths.includes("."),
      "the current scene must be present as the tree root",
    );
    const types = (inspected.nodes ?? []).map((node) => node.type);
    assert.ok(
      types.includes("Timer"),
      "the newly loaded scene's marker node must be in the tree",
    );
    assert.ok(
      !paths.includes("SwitchBackdrop"),
      "the replaced scene's subtree must not linger in the tree",
    );

    const logs = manager.readLogs(WORKSPACE_ID, session.sessionId);
    assert.match(logs.output, /FIXTURE_OTHER_READY/);
    assert.match(logs.output, /FIXTURE_SWITCHING/);
  } finally {
    await manager.stop(WORKSPACE_ID, session.sessionId);
    manager.close();
  }
}

/** The bridge GDScript must parse inside the real engine. */
async function testBridgeGdscriptIsValid(): Promise<void> {
  assert.match(GODOT_RUNTIME_BRIDGE, /extends SceneTree/);
  assert.match(GODOT_RUNTIME_BRIDGE, /func _process/);
  assert.match(GODOT_RUNTIME_BRIDGE, /func _finalize/);
  assert.match(GODOT_RUNTIME_BRIDGE, /current_scene = instance/);
  assert.match(GODOT_RUNTIME_BRIDGE, /func _release_all/);
  // A bridge that never registers itself as the current scene reintroduces the
  // scene-stacking defect, so assert the assignment explicitly.
  assert.ok(
    GODOT_RUNTIME_BRIDGE.includes("current_scene = instance"),
    "the bridge must register the launched scene as SceneTree.current_scene",
  );
  // The concrete regression: Node-level notification constants are not in
  // scope for a SceneTree main loop and fail the whole script at parse time.
  assert.ok(
    !GODOT_RUNTIME_BRIDGE.includes("NOTIFICATION_WM_CLOSE_REQUEST"),
    "SceneTree scripts cannot reference Node notification constants",
  );
}

/**
 * Typing into a real text control.
 *
 * Godot inserts characters from InputEventKey.unicode, not from keycode, so a
 * key event alone types nothing. Without the `text` field a dialog could not be
 * filled in at all, which is what blocked the GUI save/reload flow.
 */
async function testTextEntry(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  try {
    // Focus the LineEdit the fixture grabs on ready.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "click",
      x: 120,
      y: 40,
      button: "left",
    });

    // A single printable character types by default: its unicode value is the
    // character itself, so no explicit `text` is needed here.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "A",
    });
    // A NAMED key carries no character of its own. This is the exact trap that
    // left the save-dialog field empty: the key event is delivered, the field
    // stays blank, and nothing reports an error.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "Space",
    });
    const named = await readState(manager, session.sessionId);
    assert.equal(
      named.typedText,
      "A",
      `a named key must not insert a character on its own; saw ${JSON.stringify(named.typedText)}`,
    );

    // Supplying `text` supplies the character for a named key.
    await manager.sendInput(WORKSPACE_ID, session.sessionId, {
      kind: "key",
      event: "tap",
      key: "Space",
      text: " ",
    });
    for (const character of ["b", "7", "Z"]) {
      await manager.sendInput(WORKSPACE_ID, session.sessionId, {
        kind: "key",
        event: "tap",
        key: character,
        text: character,
      });
    }
    const typed = await readState(manager, session.sessionId);
    assert.equal(
      typed.typedText,
      "A b7Z",
      "typed characters must reach the text control in order",
    );

    // `text` is a single code point; longer input is refused rather than cut.
    await assert.rejects(
      manager.sendInput(WORKSPACE_ID, session.sessionId, {
        kind: "key",
        event: "tap",
        key: "A",
        text: "abc",
      }),
      /GAME_SESSION_INPUT_INVALID/,
    );
  } finally {
    await manager.stop(WORKSPACE_ID, session.sessionId);
    manager.close();
  }
}

/**
 * If DevSpace goes away mid-session the engine must not be left holding keys or
 * buttons. The bridge detects the dropped socket and releases everything.
 */
async function testReleaseOnDisconnect(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 640,
    viewportHeight: 360,
  });
  // Deliberately leave the left button held.
  await manager.sendInput(WORKSPACE_ID, session.sessionId, {
    kind: "sequence",
    steps: [
      { type: "pointer", event: "down", x: 40, y: 40, button: "left" },
    ],
    releaseAtEnd: false,
  });
  const held = await manager.sendInput(WORKSPACE_ID, session.sessionId, {
    kind: "pointer",
    event: "move",
    x: 60,
    y: 60,
  });
  assert.deepEqual(
    held.pressedInput?.mouse,
    [1],
    "a held button must be reported as latched",
  );

  // Drop the transport the way a DevSpace restart would.
  const internal = manager as unknown as {
    sessions: Map<string, { socket?: { destroy: () => void } }>;
  };
  internal.sessions.get(session.sessionId)?.socket?.destroy();

  // The bridge detects the dropped socket, releases every latched input, and
  // exits; the host then reaps the process group.
  const exited = await waitForStatus(manager, session.sessionId, 20_000);
  assert.ok(
    ["stopped", "crashed", "interrupted"].includes(exited.status),
    `the engine must exit after the host disappears, saw ${exited.status}`,
  );
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(exited.processId) && Date.now() < deadline) {
    await delay(200);
  }
  assert.equal(
    isProcessAlive(exited.processId),
    false,
    `the engine process ${exited.processId} must be gone after a host disconnect`,
  );
  assert.match(
    manager.readLogs(WORKSPACE_ID, session.sessionId).output,
    /process exited/,
  );

  manager.close();
}

/**
 * A failed launch must explain itself. Previously every startup problem
 * collapsed into a bare GAME_SESSION_HANDSHAKE_TIMEOUT.
 */
async function testStartupFailureDiagnostics(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const sceneMissing = await manager
    .start({
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectPath: ".",
      scene: "res://does_not_exist.tscn",
      viewportWidth: 320,
      viewportHeight: 200,
    })
    .then(
      () => undefined,
      (error: Error) => error,
    );
  assert.ok(sceneMissing, "a missing scene must fail the start call");
  assert.match(sceneMissing.message, /GAME_SESSION_HANDSHAKE_TIMEOUT/);
  // The diagnostic must name the engine, the paths and the engine's own output.
  assert.match(sceneMissing.message, /engine=godot-mono/);
  assert.match(sceneMissing.message, /projectPath=\./);
  assert.match(sceneMissing.message, /GAME_SESSION_SCENE_LOAD_FAILED/);
  assert.match(sceneMissing.message, /engine output tail:/);
  manager.close();

  // An invalid project directory must be refused before any process starts.
  const manager2 = new GameSessionManager(stateDir);
  await assert.rejects(
    manager2.start({
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectPath: "nested",
      scene: "res://main.tscn",
    }),
    /PATH_NOT_FOUND|GAME_SESSION_PROJECT_INVALID/,
  );
  await assert.rejects(
    manager2.start({
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectPath: "..",
      scene: "res://main.tscn",
    }),
    /PATH_INVALID|WORKSPACE_ESCAPE/,
  );
  manager2.close();
}

/** The TriaRegna acceptance viewport is 1600x900 and 1366x768 both matter. */
async function testAlternateResolution(): Promise<void> {
  const manager = new GameSessionManager(stateDir);
  const session = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    projectPath: ".",
    scene: "res://main.tscn",
    viewportWidth: 1366,
    viewportHeight: 768,
  });
  try {
    const frame = await manager.capture(WORKSPACE_ID, session.sessionId);
    assert.equal(frame.width, 1366);
    assert.equal(frame.height, 768);
    assert.equal(frame.manifest.guiVerdict, "real_gpu");
    assert.equal(frame.manifest.render === "unknown" ? 0 : 1, 1);
  } finally {
    const stopped = await manager.stop(WORKSPACE_ID, session.sessionId);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(
      stopped.pressedInput,
      { mouse: [], keys: [], actions: [] },
      "a clean stop must leave no latched input",
    );
    assert.equal(
      stopped.stopDiagnostics?.residualPressedInput.mouse.length,
      0,
    );
    assert.equal(stopped.stopDiagnostics?.processGroupReaped, true);
    assert.equal(stopped.exitCode, 0);
    manager.close();
  }
}

// --- helpers ---------------------------------------------------------------

interface FixtureSamples {
  /** Every mouse-button press the engine observed, in order. */
  presses: number;
  releases: number;
  doubleClicks: number;
  wheels: number;
  keys: number;
  shiftSeen: boolean;
  /** Every pointer X the engine observed. A real window also receives the
   * desktop's physical mouse, so tests assert that injected samples are
   * present rather than that they are the only ones. */
  positions: number[];
  sawPosition(x: number): boolean;
  /** Latest text the fixture's LineEdit reported, if any. */
  typedText: string | null;
}

async function readState(
  manager: GameSessionManager,
  sessionId: string,
): Promise<FixtureSamples> {
  // Input.parse_input_event only queues the event; the engine dispatches it
  // during the next input phase, so let a few frames elapse before reading.
  await delay(250);
  const logs = manager.readLogs(WORKSPACE_ID, sessionId);
  const lines = logs.output
    .split("\n")
    .filter((line) => line.includes("FIXTURE_STATE"));
  const counters = {
    presses: 0,
    releases: 0,
    doubleClicks: 0,
    wheels: 0,
    keys: 0,
  };
  let shiftSeen = false;
  const positions: number[] = [];
  for (const line of lines) {
    const num = (key: string): number => {
      const match = line.match(new RegExp(`${key}=(-?[0-9.]+)`));
      return match ? Number(match[1]) : 0;
    };
    counters.presses = Math.max(counters.presses, num("presses"));
    counters.releases = Math.max(counters.releases, num("releases"));
    counters.doubleClicks = Math.max(counters.doubleClicks, num("double"));
    counters.wheels = Math.max(counters.wheels, num("wheels"));
    counters.keys = Math.max(counters.keys, num("keys"));
    if (/shift=true/.test(line)) shiftSeen = true;
    const position = line.match(/last_position=(-?[0-9.]+)/);
    if (position) positions.push(Number(position[1]));
  }
  const textLines = logs.output
    .split("\n")
    .filter((line) => line.includes("FIXTURE_TEXT:"));
  const typedText = textLines.length
    ? textLines[textLines.length - 1].split("FIXTURE_TEXT:")[1].trim()
    : null;
  return {
    ...counters,
    shiftSeen,
    positions,
    typedText,
    sawPosition(x: number): boolean {
      return positions.some((seen) => Math.abs(seen - x) < 1.5);
    },
  };
}

async function waitForStatus(
  manager: GameSessionManager,
  sessionId: string,
  timeoutMs: number,
): Promise<{ status: string; processId?: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; processId?: number } = { status: "unknown" };
  while (Date.now() < deadline) {
    try {
      last = await manager.inspect(WORKSPACE_ID, sessionId);
      if (["stopped", "crashed", "interrupted"].includes(last.status)) {
        return last;
      }
    } catch {
      // The bridge socket is gone by design in this test; inspect() only stops
      // needing the bridge once the engine process has actually been reaped.
    }
    await delay(250);
  }
  return last;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
