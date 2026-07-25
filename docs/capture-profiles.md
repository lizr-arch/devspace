# Capture Profiles

DevSpace uses project-owned capture adapters instead of hard-coding a game,
scene, camera, or art standard. An approved workspace may define:

```text
.devspace/captures/<profile>.json
```

The MCP client calls `start_capture(workspaceId, profile)`. DevSpace loads the
strict profile, resolves the named Godot runner from the local Runner Registry,
validates every argument and output root, then starts the existing persistent
Job lifecycle. The client continues with `poll_job`, `list_artifacts`, and
optionally `publish_artifact`.

## Schema

```json
{
  "schemaVersion": 1,
  "runner": "godot-mono",
  "workingDirectory": ".",
  "args": [
    "--headless",
    "--display-driver",
    "macos",
    "--audio-driver",
    "Dummy",
    "--path",
    ".",
    "res://tools/devspace_capture.tscn"
  ],
  "artifactRoots": ["artifacts/captures"],
  "timeoutSeconds": 120,
  "capture": {
    "project": "Example Game",
    "scene": "res://tools/devspace_capture.tscn",
    "viewportWidth": 1280,
    "viewportHeight": 720,
    "randomSeed": 42,
    "warmupFrames": 30,
    "captureFrame": 31,
    "outputPath": "artifacts/captures/game_capture.png",
    "manifestPath": "artifacts/captures/capture_manifest.json"
  }
}
```

Unknown fields are rejected. The profile cannot declare an executable or a
runner other than `godot`/`godot-mono`. Its file must be a regular non-symlink
inside the workspace and is limited to 64 KiB. Working directory, scene and
argument paths, output paths, manifest path, and artifact roots must remain
inside the workspace. `--editor`, parent/absolute paths, shell control
characters, and runner-cap violations are rejected.

The profile name is a short identifier, not a path. DevSpace injects only these
adapter values:

```text
DEVSPACE_CAPTURE_PROFILE
DEVSPACE_CAPTURE_PROJECT
DEVSPACE_CAPTURE_SCENE
DEVSPACE_CAPTURE_VIEWPORT_WIDTH
DEVSPACE_CAPTURE_VIEWPORT_HEIGHT
DEVSPACE_CAPTURE_RANDOM_SEED
DEVSPACE_CAPTURE_WARMUP_FRAMES
DEVSPACE_CAPTURE_FRAME
DEVSPACE_CAPTURE_OUTPUT_PATH
DEVSPACE_CAPTURE_MANIFEST_PATH
DEVSPACE_CAPTURE_SOURCE_COMMIT
DEVSPACE_JOB_ID
```

The executable path and parent process environment are never accepted from the
MCP client or profile.

## Adapter responsibilities

The project adapter loads its scene or asset, fixes the random seed, viewport,
camera, lighting, warm-up duration and capture frame, writes the PNG and JSON
manifest to the declared roots, and exits with a meaningful non-zero code on
failure. At minimum the manifest records:

```text
engine and engine version
project and scene
viewport width and height
random seed
warm-up and capture frames
capture timestamp
source commit
image SHA-256
Job ID
```

DevSpace owns profile validation, registered-runner selection, timeout and
process termination, Job persistence, artifact discovery, and publication. It
does not decide which camera looks best or whether the art is acceptable.

## macOS rendering note

Godot 4.7 on macOS selects the dummy renderer for plain `--headless`, so a
viewport texture is unavailable. The included fixture retains the required
headless policy flag but selects the `macos` display driver and `Dummy` audio
driver. This produces a short-lived compatibility-rendered game window without
opening the editor. Projects should test their exact Godot version and renderer
before adopting the same profile.

The fixture under `tests/fixtures/godot_capture` uses Godot's runtime
`GLTFDocument` API. That lets it consume a newly generated GLB without invoking
the editor import daemon, render a deterministic review scene, and emit both
`game_capture.png` and `capture_manifest.json`.

## Failure and recovery

`CAPTURE_PROFILE_INVALID` identifies schema, profile, path, runner, or limit
failures before spawn. `CAPTURE_FAILED` identifies an adapter/runtime failure.
Timeout, cancellation, and service shutdown use the normal Job states; any
valid partial output is recorded as incomplete. Finished capture Jobs and
artifacts survive restart, while publication URLs intentionally do not.
