import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const BASELINE_COMMIT = "ce332740";

const root = await mkdtemp(join(tmpdir(), "devspace-memory-characterization-"));

try {
  assert.equal(gitShow("src/config.ts").includes("projectMemory"), false);
  assert.equal(gitShow("src/workspaces.ts").includes("task?: string"), false);
  assert.equal(
    gitShow("src/db/migrations.ts").includes("project_memory_"),
    false,
  );

  const proofPath = join(root, "raw-shell-proof.txt");
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('raw-shell-proof.txt','proof')"`;
  const shellResult = await runShellTool(
    { command, timeout: 30 },
    { cwd: root, root },
  );
  assert.equal(shellResult.isError, undefined);
  assert.equal(existsSync(proofPath), true);
} finally {
  await rm(root, { recursive: true, force: true });
}

function gitShow(path: string): string {
  return execFileSync("git", ["show", `${BASELINE_COMMIT}:${path}`], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}
