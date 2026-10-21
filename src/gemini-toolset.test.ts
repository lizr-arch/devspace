import assert from "node:assert/strict";
import {
  bearerTokenFingerprint,
  GEMINI_TOOLSET_LIMIT,
  geminiClientMatches,
  geminiToolAllowlist,
  selectGeminiTools,
} from "./gemini-toolset.js";

const names = geminiToolAllowlist({
  openWorkspace: "open_workspace",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  grep: "grep_files",
  glob: "find_files",
  ls: "list_directory",
  shell: "run_shell",
});
assert.ok(names.size <= GEMINI_TOOLSET_LIMIT);
assert.ok(names.size < 50);
assert.ok(names.has("open_workspace"));
assert.ok(names.has("run_shell"));
assert.ok(names.has("capture_game_frame"));

const shortNames = geminiToolAllowlist({
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
});
assert.ok(shortNames.has("read"));
assert.ok(shortNames.has("bash"));

const selected = selectGeminiTools(
  [
    { name: "open_workspace", inputSchema: {} },
    { name: "codex_agent_start", inputSchema: {} },
    { name: "run_shell", inputSchema: {} },
    { name: 17 },
  ],
  names,
);
assert.deepEqual(selected.map((tool) => tool.name), ["open_workspace", "run_shell"]);
assert.equal(geminiClientMatches("mcp", "0.1.0"), true);
assert.equal(geminiClientMatches("other", "0.1.0"), false);

const fingerprint = bearerTokenFingerprint("Bearer secret-token");
assert.equal(fingerprint, bearerTokenFingerprint("bearer secret-token"));
assert.notEqual(fingerprint, bearerTokenFingerprint("Bearer different-token"));
assert.equal(bearerTokenFingerprint("Basic secret-token"), undefined);
assert.equal(bearerTokenFingerprint(undefined), undefined);
console.log(`Gemini toolset tests passed (${names.size}/${GEMINI_TOOLSET_LIMIT} maximum)`);
