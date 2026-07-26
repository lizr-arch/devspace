# DevSpaceMac game-development milestones

This document is the implementation and review contract for the local
game-development MCP surface. Automatic verification never substitutes for
human visual, audio, or play-feel acceptance.

## M1: assets, files, and local Git

M1 provides:

- `import_asset`, with deprecated `import_png` compatibility;
- `inspect_artifact`, `preview_artifact`, `list_artifacts`, and
  `publish_artifact`;
- `mkdir`, `copy`, `move`, and `move_to_trash`;
- `git_status`, `git_diff`, path-scoped staging/unstaging, guarded local commit,
  and bounded local branch operations.

All caller-provided paths are workspace-relative and canonicalized. Symlink
components are rejected for mutation and artifact inspection. New files and
imports do not overwrite by default. Trash is a private, non-expiring
quarantine under the DevSpace state directory; the caller cannot select its
destination.

The primary DevSpaceMac surface does not expose arbitrary shell commands.
Builds and tests use named Runner Registry entries. Git tools do not implement
merge, rebase, reset, fetch, pull, push, tag, force, amend, remote tracking, or
branch deletion.

Artifact Ledger schema v2 records either a Job or Import origin and reads
existing v1 Job ledgers without rewriting them. Audio records support WAV and
OGG.

## Tool capability metadata

Every primary MCP tool descriptor includes:

```json
{
  "_meta": {
    "devspace": {
      "requiredCapability": "workspace.read"
    }
  }
}
```

The value is also reported by `devspace_info` and included in the schema
fingerprint. It is descriptive metadata only; the current `readOnly/full`
registration boundary remains authoritative.

## Read-only boundary

Read-only mode includes pure workspace/artifact inspection plus
`git_status`/`git_diff`. It does not register import, preview publication,
file mutation, Git mutation, Runner, capture, or game-session tools.

## Later milestones

- M2 adds DevSpace-owned, Runtime-Bridge Godot sessions and input limited to
  those sessions.
- M3 adds fixed BLEND, GLB, and audio inspectors plus bounded model previews.
- M4 remains deferred: capability enforcement, permanent deletion, trash
  restore, merge/push, release/export, arbitrary Python, and desktop control.

## M2: Godot game sessions

M2 uses a distinct interactive Session lifecycle rather than representing a
game process as a background job. A bundled `SceneTree` bridge connects to an
ephemeral `127.0.0.1` port using a per-session random secret. DevSpace
constructs the process arguments and resolves only registered `godot` or
`godot-mono` executables.

The MCP surface is `start_game_session`, `inspect_game_session`,
`send_game_input`, `capture_game_frame`, `read_game_logs`, and
`stop_game_session`. Inputs are restricted to `InputMap` actions and
viewport-local mouse clicks. Screenshots, logs, and pinned source/engine
snapshots remain in private DevSpace state rather than the project.

Each workspace can own one active Session and the service can own two. A
service shutdown marks live Sessions interrupted. Restart cleanup signals only
a persisted process group whose random identity token can still be verified.
