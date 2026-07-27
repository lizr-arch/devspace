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

  const approvedCandidate = store.buildApproved({
    projectId: "threecountries",
    taskId: "r2-reference",
    assetRole: "approved_reference",
    importReceipt: first,
    sourceKind: "user_upload",
    approvedPurpose: "Authoritative source for the R2 production pipeline.",
    decisionText: "批准这张，按这张继续。",
    receiptDirectory: "source_assets/r2/provenance/receipts",
  });
  const approved = store.registerApproved(approvedCandidate);
  const approvedRetry = store.registerApproved(
    store.buildApproved({
      projectId: "threecountries",
      taskId: "r2-reference",
      assetRole: "approved_reference",
      importReceipt: first,
      sourceKind: "user_upload",
      approvedPurpose: "Authoritative source for the R2 production pipeline.",
      decisionText: "批准这张，按这张继续。",
      receiptDirectory: "source_assets/r2/provenance/receipts",
    }),
  );
  assert.equal(approvedRetry.assetReceiptId, approved.assetReceiptId);
  assert.equal(approvedRetry.createdAt, approved.createdAt);
  assert.equal(approved.humanApproval.status, "passed");
  assert.equal(approved.humanApproval.actor, "human_user");
  assert.equal(approved.import.originatingWorkspaceId, workspaceId);

  const replacementImport = store.registerImport({
    ...input,
    outcome: "replaced",
    sha256: "b".repeat(64),
    artifactId: "artifact_22222222-2222-4222-8222-222222222222",
    previousSha256: first.sha256,
    previousArtifactId: first.artifactId,
  });
  const replacementInput = {
    projectId: "threecountries",
    taskId: "r2-reference-revision",
    assetRole: "approved_reference",
    importReceipt: replacementImport,
    sourceKind: "user_upload" as const,
    approvedPurpose: "Approved replacement.",
    decisionText: "批准替换。",
    receiptDirectory: "source_assets/r2/provenance/receipts",
  };
  assert.throws(
    () => store.registerApproved(store.buildApproved(replacementInput)),
    /REPLACEMENT_REQUIRES_SUPERSESSION/,
  );
  const replacement = store.registerApproved(
    store.buildApproved({
      ...replacementInput,
      supersedesAssetReceiptId: approved.assetReceiptId,
    }),
  );
  assert.equal(
    store.getSupersedingAssetReceiptId(approved.assetReceiptId),
    replacement.assetReceiptId,
  );
  assert.equal(
    store.getCurrentApprovedForPath("threecountries", input.destinationPath)
      ?.assetReceiptId,
    replacement.assetReceiptId,
  );
  assert.deepEqual(
    store
      .findApproved({
        projectId: "threecountries",
        assetRole: "approved_reference",
      })
      .map((entry) => ({
        id: entry.assetReceiptId,
        current: entry.current,
      })),
    [
      { id: replacement.assetReceiptId, current: true },
      { id: approved.assetReceiptId, current: false },
    ],
  );

  console.log("asset receipt tests passed");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
