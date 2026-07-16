import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { runShellTool } from "./pi-tools.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-memory-characterization-"));

try {
  const stateDir = join(root, "state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  assert.equal("projectMemory" in config, false);

  const registry = new WorkspaceRegistry(config);
  const context = await registry.openWorkspace({
    path: root,
    task: "This field was not part of the baseline contract.",
  } as { path: string; task: string });
  assert.equal("projectMemory" in context.workspace, false);

  const database = openDatabase(stateDir);
  const tables = (
    database.sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.equal(tables.some((name) => name.startsWith("project_memory_")), false);
  database.close();

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
