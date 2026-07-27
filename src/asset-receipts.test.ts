import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetReceiptStore } from "./asset-receipts.js";
import { openDatabase } from "./db/client.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-asset-receipts-"));
const workspaceId = "ws_asset_receipts";

try {
  const database = openDatabase(stateDir);
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      `insert into workspace_sessions (
         id, root, status, mode, managed, detached, created_at, last_used_at
       ) values (?, ?, 'active', 'checkout', 'false', 'true', ?, ?)`,
    )
    .run(workspaceId, "/tmp/workspace", now, now);
  database.close();

  const store = new AssetReceiptStore(stateDir);
  const input = {
    workspaceId,
    destinationPath: "source_assets/reference.png",
    outcome: "created" as const,
    bytes: 68,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    mimeType: "image/png" as const,
    sourceKind: "openai_file" as const,
    sourceFileId: "file_reference",
    sourceFileName: "reference.png",
    artifactId: "artifact_11111111-1111-4111-8111-111111111111",
  };
  const first = store.registerImport(input);
  const retry = store.registerImport(input);
  assert.equal(first.importReceiptId, retry.importReceiptId);
  assert.equal(first.createdAt, retry.createdAt);
  assert.deepEqual(store.getImport(workspaceId, first.importReceiptId), first);
  assert.equal(JSON.stringify(first).includes("download_url"), false);
  assert.equal(JSON.stringify(first).includes("https://"), false);

  console.log("asset receipt tests passed");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
