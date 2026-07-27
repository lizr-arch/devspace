import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reindexApprovedAssetReceipts,
  writeImmutableApprovedReceipt,
} from "./approved-assets.js";
import { AssetReceiptStore } from "./asset-receipts.js";
import { openDatabase } from "./db/client.js";

const root = await mkdtemp(join(tmpdir(), "devspace-approved-registry-root-"));
const stateDir = await mkdtemp(
  join(tmpdir(), "devspace-approved-registry-state-"),
);
const workspaceId = "ws_reindex";

try {
  const database = openDatabase(stateDir);
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      `insert into workspace_sessions (
         id, root, status, mode, managed, detached, created_at, last_used_at
       ) values (?, ?, 'active', 'checkout', 'false', 'true', ?, ?)`,
    )
    .run(workspaceId, root, now, now);
  database.close();

  const store = new AssetReceiptStore(stateDir);
  const imported = store.registerImport({
    workspaceId,
    destinationPath: "source_assets/r2/raw/approved.png",
    outcome: "created",
    bytes: 21,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    mimeType: "image/png",
    sourceKind: "openai_file",
    sourceFileId: "file_r2",
    sourceFileName: "approved.png",
    artifactId: "artifact_11111111-1111-4111-8111-111111111111",
  });
  const receipt = store.buildApproved({
    projectId: "threecountries",
    taskId: "r2",
    assetRole: "approved_reference",
    importReceipt: imported,
    sourceKind: "user_upload",
    approvedPurpose: "R2 modeling authority",
    decisionText: "按这张继续。",
    receiptDirectory: "source_assets/r2/provenance/receipts",
  });
  await mkdir(join(root, "source_assets/r2/raw"), { recursive: true });
  await writeFile(
    join(root, "source_assets/r2/raw/approved.png"),
    "approved-source-bytes",
  );
  await writeImmutableApprovedReceipt(root, receipt);
  store.registerApproved(receipt);
  store.removeApproved(receipt.assetReceiptId);
  assert.equal(store.getApproved(receipt.assetReceiptId), undefined);

  const rebuilt = await reindexApprovedAssetReceipts({
    workspaceRoot: root,
    receiptRoot: "source_assets",
    store,
  });
  assert.deepEqual(rebuilt, {
    scanned: 1,
    indexed: 1,
    existing: 0,
    errors: [],
  });
  assert.equal(
    store.getApproved(receipt.assetReceiptId)?.asset.sha256,
    receipt.asset.sha256,
  );

  const retry = await reindexApprovedAssetReceipts({
    workspaceRoot: root,
    receiptRoot: "source_assets",
    store,
  });
  assert.equal(retry.indexed, 0);
  assert.equal(retry.existing, 1);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

console.log("approved asset registry tests passed");
