/**
 * Real Godot GUI map save -> full quit -> new process reload round trip.
 *
 * This is the M1 closure test. `Ctrl+S` being accepted only proves the input
 * path; it does not prove that map data reached the disk and came back. This
 * test proves disk provenance across two independent Godot processes:
 *
 *   Process 1  load a real map, paint terrain, Save As to a named file, quit.
 *   (Godot is now completely gone.)
 *   On disk    mutate the saved file's terrain, keeping every value legal.
 *   Process 2  a BRAND NEW Godot process loads that file and saves it back.
 *              The terrain semantic hash of what it writes MUST equal the
 *              mutated on-disk hash. A process that had somehow reused stale
 *              in-memory state would write the pre-mutation hash instead.
 *
 * The semantic hash is deliberately not a byte hash: the editor may normalise
 * key order or formatting on save, but the (x, y, terrain, elevation) tuples
 * must survive exactly.
 *
 * This drives the real editor UI through the Runtime Bridge, so it needs a
 * display and a Godot Mono binary. It is an opt-in acceptance test, not part of
 * the default unit chain.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionManager } from "../src/game-sessions.js";
import { RunnerRegistry } from "../src/runner-registry.js";

const PROJECT_ROOT = process.env.TRIA_ROOT ?? "/Users/liz/agy/TriaRegna";
const USER_MAPS = join(
  process.env.HOME ?? "",
  "Library/Application Support/Godot/app_userdata/TriaRegna/maps",
);
const EVIDENCE = process.env.DS12_EVIDENCE ?? "/tmp/devspace12-e2e";
const WORKSPACE_ID = "ws_save_reload";
const VIEWPORT = { width: 1600, height: 900 };

// Editor UI coordinates (1600x900). These are the real control positions of the
// shipped editor; the test fails loudly if the flow stops matching.
const UI = {
  terrainTool: { x: 45, y: 178 },
  terrainWater: { x: 265, y: 293 },
  brush7: { x: 210, y: 501 },
  moreMenu: { x: 1560, y: 30 },
  saveAsItem: { x: 1382, y: 134 },
  nameField: { x: 790, y: 314 },
  dialogConfirm: { x: 1052, y: 687 },
  recentSearch: { x: 790, y: 289 },
  recentFirstRow: { x: 790, y: 360 },
} as const;

const stateDir = mkdtempSync(join(tmpdir(), "devspace-save-reload-"));
const manager = new GameSessionManager(stateDir);
const stamp = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);
const mapName = `DS12 Roundtrip ${stamp}`;
const mapFile = join(USER_MAPS, `${mapName.replace(/ /g, "_")}.json`);

try {
  if (!(await godotAvailable())) {
    console.log("save/reload round trip SKIPPED: no godot-mono on this host");
    process.exit(0);
  }

  const sourceFile = pickSourceMap();
  console.log(`source map      : ${sourceFile}`);
  console.log(`target map file : ${mapFile}`);

  // ---------------------------------------------------------------- process 1
  const session1 = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: PROJECT_ROOT,
    projectPath: ".",
    scene: "res://scenes/MapEditor.tscn",
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
  });
  assert.equal(session1.guiVerdict, "real_gpu", "process 1 must be a real GPU window");

  await loadMap(session1.sessionId, basename(sourceFile));
  await paintTerrain(session1.sessionId);
  const frameBeforeSave = await captureFrame(session1.sessionId, "01-before-saveas");
  await saveAs(session1.sessionId, mapName);

  assert.ok(
    existsSyncSafe(mapFile),
    `Save As must create ${mapFile}. Files now present: ${readdirSync(USER_MAPS)
      .filter((f) => f.endsWith(".json"))
      .slice(-5)
      .join(", ")}`,
  );
  const onDiskAfterSave = readTerrain(mapFile);
  const hashAfterSave = terrainHash(onDiskAfterSave);
  console.log(
    `process 1 saved : ${onDiskAfterSave.cells.length} cells, terrain=${JSON.stringify(onDiskAfterSave.terrains)}, hash=${hashAfterSave.slice(0, 16)}`,
  );

  const stopped1 = await manager.stop(WORKSPACE_ID, session1.sessionId);
  assert.equal(stopped1.status, "stopped");
  assert.equal(stopped1.stopDiagnostics?.processGroupReaped, true);
  console.log(`process 1 exited: exit=${stopped1.exitCode}`);

  // ------------------------------------------------------- external on-disk edit
  // Godot is not running. Only the file changes from here on, so anything
  // process 2 shows afterwards cannot have come from process 1's memory.
  const targetTerrain = pickDistinctTerrain(onDiskAfterSave);
  const mutated = JSON.parse(readFileSync(mapFile, "utf8")) as {
    Cells: Array<{ X: number; Y: number; Terrain: string; Elevation: number }>;
  };
  for (const cell of mutated.Cells) cell.Terrain = targetTerrain;
  writeFileSync(mapFile, JSON.stringify(mutated, null, 2) + "\n");

  const onDiskMutated = readTerrain(mapFile);
  const hashMutated = terrainHash(onDiskMutated);
  assert.notEqual(
    hashMutated,
    hashAfterSave,
    "the external edit must actually change the terrain semantics",
  );
  console.log(
    `disk mutated    : all cells -> ${targetTerrain}, hash=${hashMutated.slice(0, 16)} (was ${hashAfterSave.slice(0, 16)})`,
  );

  // ---------------------------------------------------------------- process 2
  const session2 = await manager.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: PROJECT_ROOT,
    projectPath: ".",
    scene: "res://scenes/MapEditor.tscn",
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
  });
  assert.notEqual(
    session2.processId,
    session1.processId,
    "process 2 must be a different OS process",
  );
  assert.equal(session2.projectPath, ".");
  console.log(`process 2 pid   : ${session2.processId} (process 1 was ${session1.processId})`);

  await loadMap(session2.sessionId, basename(mapFile));
  const frameAfterReload = await captureFrame(session2.sessionId, "02-after-reload");
  // Save As rather than plain Save: this proves the reloaded model was written
  // back out, without ever writing over the file that was loaded.
  await saveAs(session2.sessionId, `${mapName} B`);
  const secondFile = join(USER_MAPS, `${`${mapName} B`.replace(/ /g, "_")}.json`);
  assert.ok(
    existsSyncSafe(secondFile),
    `process 2 must write the reloaded map to ${secondFile}`,
  );

  const onDiskAfterResave = readTerrain(secondFile);
  const hashAfterResave = terrainHash(onDiskAfterResave);
  console.log(
    `process 2 saved : terrain=${JSON.stringify(onDiskAfterResave.terrains)}, hash=${hashAfterResave.slice(0, 16)}`,
  );

  // THE decisive assertion: a fresh process re-saved exactly the terrain that
  // only existed on disk after process 1 had exited.
  assert.equal(
    hashAfterResave,
    hashMutated,
    "a new process must re-save the terrain it read from disk, not any earlier state",
  );
  assert.notEqual(
    hashAfterResave,
    hashAfterSave,
    "the round trip must not resurrect the pre-mutation terrain",
  );
  assert.equal(
    onDiskAfterResave.cells.length,
    onDiskMutated.cells.length,
    "the cell count must survive the round trip",
  );

  // Visual corroboration: the reloaded map must not look like the pre-mutation
  // frame, because every cell changed terrain type.
  assert.notEqual(
    frameAfterReload,
    frameBeforeSave,
    "the reloaded frame must differ from the pre-save frame",
  );

  const stopped2 = await manager.stop(WORKSPACE_ID, session2.sessionId);
  assert.equal(stopped2.status, "stopped");
  assert.equal(stopped2.stopDiagnostics?.processGroupReaped, true);
  assert.deepEqual(stopped2.pressedInput, {
    mouse: [],
    keys: [],
    actions: [],
  });

  writeFileSync(
    join(EVIDENCE, "save-reload-roundtrip.json"),
    JSON.stringify(
      {
        sourceMap: sourceFile,
        targetMap: mapFile,
        mapName,
        process1: {
          pid: session1.processId,
          engine: session1.engine,
          guiVerdict: session1.guiVerdict,
          renderer: session1.renderInfo,
          terrainHash: hashAfterSave,
          terrains: onDiskAfterSave.terrains,
          frame: frameBeforeSave,
        },
        diskMutation: { terrain: targetTerrain, terrainHash: hashMutated },
        secondFile,
        process2: {
          pid: session2.processId,
          terrainHashAfterResave: hashAfterResave,
          terrainsAfterResave: onDiskAfterResave.terrains,
          frame: frameAfterReload,
        },
        verdict: "disk_backed_roundtrip_verified",
      },
      null,
      2,
    ) + "\n",
  );

  console.log("\nsave/reload round trip PASSED");
  console.log(`  process 1 wrote  ${hashAfterSave.slice(0, 16)}`);
  console.log(`  disk mutated to  ${hashMutated.slice(0, 16)}`);
  console.log(`  process 2 re-saved ${hashAfterResave.slice(0, 16)}  -> matches disk`);
  console.log(`  evidence: ${join(EVIDENCE, "save-reload-roundtrip.json")}`);
  console.log(`  temp maps left in place for inspection:`);
  console.log(`    ${mapFile}`);
  console.log(`    ${secondFile}`);
} finally {
  manager.close();
}

// --- helpers ---------------------------------------------------------------

async function godotAvailable(): Promise<boolean> {
  try {
    return Boolean((await new RunnerRegistry().resolve("godot-mono")).executable);
  } catch {
    return false;
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

interface TerrainRead {
  cells: Array<{ X: number; Y: number; Terrain: string; Elevation: number }>;
  terrains: string[];
}

function readTerrain(path: string): TerrainRead {
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    Cells: Array<{ X: number; Y: number; Terrain: string; Elevation: number }>;
  };
  const cells = [...doc.Cells].sort((a, b) => a.Y - b.Y || a.X - b.X);
  return {
    cells,
    terrains: [...new Set(cells.map((cell) => cell.Terrain))].sort(),
  };
}

/** Hash over the terrain semantics only, so formatting cannot mask a change. */
function terrainHash(read: TerrainRead): string {
  const canonical = read.cells
    .map((cell) => `${cell.X},${cell.Y},${cell.Terrain},${cell.Elevation}`)
    .join(";");
  return createHash("sha256").update(canonical).digest("hex");
}

function pickDistinctTerrain(read: TerrainRead): string {
  const used = read.terrains;
  assert.ok(used.length > 0, "the saved map must declare at least one terrain");
  // Prefer a terrain already present in this file so the mutation stays legal.
  const preferred = ["water", "ocean", "lake", "mountain", "hills"].find((name) =>
    used.includes(name),
  );
  if (preferred) return preferred;
  // Otherwise flip to whichever declared value differs from the first cell's.
  const first = read.cells[0].Terrain;
  return used.find((name) => name !== first) ?? first;
}

function pickSourceMap(): string {
  const candidates = readdirSync(USER_MAPS)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        !name.endsWith(".recovery.json") &&
        !name.startsWith("DS12") &&
        !name.startsWith("."),
    )
    .map((name) => join(USER_MAPS, name));
  assert.ok(candidates.length > 0, `no source maps found in ${USER_MAPS}`);
  // Most recently modified first: the editor's own recent list is ordered the
  // same way, which is what the UI flow relies on.
  return candidates.sort(
    (left, right) => mtime(right) - mtime(left),
  )[0];
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function sendCtrl(sessionId: string, key: string): Promise<void> {
  await manager.sendInput(WORKSPACE_ID, sessionId, {
    kind: "key",
    event: "tap",
    key,
    modifiers: { ctrl: true },
  });
}

/**
 * Empty a focused text field deterministically.
 *
 * Select-all is not usable here: Godot's LineEdit resolves it through
 * is_command_or_control_pressed(), and neither the Command nor the Ctrl chord
 * selected the text in this dialog. Driving Home followed by forward-deletes
 * has no such ambiguity and does not depend on the field's current contents.
 */
async function clearTextField(sessionId: string): Promise<void> {
  await manager.sendInput(WORKSPACE_ID, sessionId, {
    kind: "key",
    event: "tap",
    key: "Home",
  });
  const deletes = Array.from({ length: 80 }, () => ({
    type: "key" as const,
    event: "tap" as const,
    key: "Delete",
  }));
  await manager.sendInput(WORKSPACE_ID, sessionId, {
    kind: "sequence",
    steps: deletes,
  });
  await delay(400);
}

async function typeText(sessionId: string, text: string): Promise<void> {
  for (const character of text) {
    // `text` carries the code point: Godot text controls insert from
    // InputEventKey.unicode, so a bare key event types nothing.
    await manager.sendInput(WORKSPACE_ID, sessionId, {
      kind: "key",
      event: "tap",
      key: character === " " ? "Space" : character,
      text: character,
    });
    await delay(60);
  }
}

async function clickAt(
  sessionId: string,
  point: { x: number; y: number },
): Promise<void> {
  await manager.sendInput(WORKSPACE_ID, sessionId, {
    kind: "click",
    x: point.x,
    y: point.y,
    button: "left",
  });
  await delay(500);
}

/**
 * Capture the real GPU framebuffer and persist it as evidence. Returns the
 * frame sha256 so the caller can assert the picture actually changed.
 */
async function captureFrame(
  sessionId: string,
  label: string,
): Promise<string> {
  const frame = await manager.capture(WORKSPACE_ID, sessionId);
  assert.equal(frame.manifest.guiVerdict, "real_gpu");
  assert.equal(frame.width, VIEWPORT.width);
  assert.equal(frame.height, VIEWPORT.height);
  writeFileSync(
    join(EVIDENCE, `save-reload-${label}.png`),
    Buffer.from(frame.data, "base64"),
  );
  writeFileSync(
    join(EVIDENCE, `save-reload-${label}.manifest.json`),
    JSON.stringify(frame.manifest, null, 2) + "\n",
  );
  console.log(`frame ${label}: sha=${frame.sha256.slice(0, 16)} gui=${frame.manifest.guiVerdict}`);
  return frame.sha256;
}

async function loadMap(sessionId: string, fileName: string): Promise<void> {
  // Ctrl+O opens the editor's own recent-maps dialog.
  await sendCtrl(sessionId, "O");
  await delay(1500);
  // Narrow the list deterministically instead of relying on ordering.
  await clickAt(sessionId, UI.recentSearch);
  await typeText(sessionId, fileName.replace(/\.json$/, ""));
  await delay(1200);
  await clickAt(sessionId, UI.recentFirstRow);
  await clickAt(sessionId, UI.dialogConfirm);
  await delay(2500);
}

async function paintTerrain(sessionId: string): Promise<void> {
  await clickAt(sessionId, UI.terrainTool);
  await clickAt(sessionId, UI.terrainWater);
  await clickAt(sessionId, UI.brush7);
  await manager.sendInput(WORKSPACE_ID, sessionId, {
    kind: "sequence",
    steps: [
      { type: "pointer", event: "move", x: 700, y: 300 },
      { type: "pointer", event: "down", x: 700, y: 300, button: "left" },
      { type: "pointer", event: "move", x: 780, y: 360, frameDelay: 2 },
      { type: "pointer", event: "move", x: 860, y: 420, frameDelay: 2 },
      { type: "pointer", event: "move", x: 940, y: 480, frameDelay: 2 },
      { type: "pointer", event: "up", x: 940, y: 480, button: "left" },
    ],
  });
  await delay(1200);
}

async function saveAs(sessionId: string, name: string): Promise<void> {
  await clickAt(sessionId, UI.moreMenu);
  await clickAt(sessionId, UI.saveAsItem);
  await clickAt(sessionId, UI.nameField);
  // Clear the pre-filled default so the typed name is exactly what is used.
  await clearTextField(sessionId);
  await typeText(sessionId, name);
  await delay(400);
  await clickAt(sessionId, UI.dialogConfirm);
  await delay(2500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
