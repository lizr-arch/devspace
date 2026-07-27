import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  "archive_approved_image",
  "capture_game_frame",
  "find_approved_assets",
  "git_diff",
  "import_png",
  "inspect_artifact",
  "inspect_audio",
  "inspect_blend",
  "inspect_glb",
  "list_artifacts",
  "preview_artifact",
  "publish_artifact",
  "recover_approved_asset",
  "reindex_approved_assets",
  "render_model_preview",
  "verify_approved_asset",
]);

for (const path of [
  "README.md",
  "LLM-SETUP.md",
  "docs/gotchas.md",
  "docs/cloudflare-named-tunnel.md",
  "docs/chatgpt-web-connection.md",
  "docs/configuration.md",
  ".env.example",
]) {
  assert.match(
    readFileSync(path, "utf8"),
    /DEVSPACE_WIDGETS=review_only|`review_only`/,
    `${path} should document review_only`,
  );
}
