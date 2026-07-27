import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeApprovedReceiptFile,
  writeImmutableApprovedReceipt,
} from "./approved-assets.js";
import type { ApprovedAssetReceipt } from "./asset-receipts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-approved-assets-"));
const receipt: ApprovedAssetReceipt = {
  schemaVersion: 1,
  assetReceiptId: `asset_receipt_${"a".repeat(64)}`,
  project: {
    projectId: "threecountries",
    taskId: "r2",
    assetRole: "approved_reference",
  },
  asset: {
    destinationPath: "source_assets/r2/reference.png",
    bytes: 68,
    sha256: "b".repeat(64),
    width: 1,
    height: 1,
    mimeType: "image/png",
  },
  source: {
    kind: "user_upload",
    fileId: "file_r2",
    fileName: "reference.png",
  },
  import: {
    importReceiptId: `import_receipt_${"c".repeat(64)}`,
    originatingWorkspaceId: "ws_r2",
    importedAt: "2026-07-28T00:00:00.000Z",
  },
  humanApproval: {
    status: "passed",
    actor: "human_user",
    approvedPurpose: "R2 source",
    decisionText: "批准这张。",
    approvedAt: "2026-07-28T00:01:00.000Z",
  },
  revision: {},
  projectReceiptPath: `source_assets/r2/provenance/receipts/asset_receipt_${"a".repeat(64)}.approved-asset-receipt.json`,
  createdAt: "2026-07-28T00:01:00.000Z",
};

try {
  const first = await writeImmutableApprovedReceipt(root, receipt);
  assert.equal(first.created, true);
  const retry = await writeImmutableApprovedReceipt(root, receipt);
  assert.equal(retry.created, false);
  const contents = await readFile(
    join(root, receipt.projectReceiptPath),
    "utf8",
  );
  assert.equal(contents.includes("download_url"), false);

  await writeFile(
    join(root, receipt.projectReceiptPath),
    `${contents.trimEnd()} \n`,
  );
  await assert.rejects(
    writeImmutableApprovedReceipt(root, receipt),
    /RECEIPT_CONFLICT/,
  );
  await removeApprovedReceiptFile(root, receipt.projectReceiptPath);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("approved asset receipt file tests passed");
