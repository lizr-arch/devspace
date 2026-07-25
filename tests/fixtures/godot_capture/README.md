# Godot capture fixture

This fixture exercises `start_capture` with a strict
`.devspace/captures/fixture.json` profile. It renders a deterministic fallback
mesh when no Blender output exists. When
`artifacts/blender_fixture/ship.glb` exists, it imports and captures that asset
instead.

The capture writes a PNG and a JSON manifest under
`artifacts/captures/`. The manifest records the profile, source commit, engine
version, viewport, seed, frame timing, job ID, asset load result, and screenshot
SHA-256.

On macOS, plain `--headless` selects Godot's dummy renderer and therefore cannot
produce a viewport texture. The fixture keeps the required headless policy flag
but explicitly selects the `macos` display driver and `Dummy` audio driver so
the process renders a short-lived compatibility viewport without opening the
editor.
