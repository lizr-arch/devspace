import assert from "node:assert/strict";
import { REVIEW_ONLY_WIDGET_TOOLS, shouldAttachWidget } from "./server.js";

const richTools = new Set<string>(REVIEW_ONLY_WIDGET_TOOLS);
const ordinaryTools = [
  ["open_workspace", "workspace"],
  ["project_memory_preflight", "project_memory"],
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["grep", "search"],
  ["ls", "directory"],
  ["bash", "shell"],
  ["start_job", "job"],
  ["show_changes", "show_changes"],
] as const;

for (const [tool, kind] of ordinaryTools) {
  assert.equal(shouldAttachWidget("off", tool, kind), false);
  assert.equal(shouldAttachWidget("full", tool, kind), true);
}

assert.equal(
  shouldAttachWidget("changes", "open_workspace", "workspace"),
  true,
);
assert.equal(
  shouldAttachWidget("changes", "project_memory_preflight", "project_memory"),
  true,
);
assert.equal(
  shouldAttachWidget("changes", "show_changes", "show_changes"),
  true,
);
assert.equal(shouldAttachWidget("changes", "read", "read"), false);
assert.equal(shouldAttachWidget("changes", "start_job", "job"), false);

for (const tool of richTools) {
  assert.equal(shouldAttachWidget("review_only", tool, "review"), true);
  assert.equal(shouldAttachWidget("off", tool, "review"), false);
  assert.equal(shouldAttachWidget("full", tool, "review"), true);
}

for (const [tool, kind] of ordinaryTools) {
  assert.equal(shouldAttachWidget("review_only", tool, kind), false);
}

assert.deepEqual([...richTools].sort(), [
  "capture_game_frame",
  "git_diff",
  "inspect_artifact",
  "inspect_audio",
  "inspect_blend",
  "inspect_glb",
  "list_artifacts",
  "preview_artifact",
  "publish_artifact",
  "render_model_preview",
]);
