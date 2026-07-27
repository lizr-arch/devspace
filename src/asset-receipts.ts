import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type AssetImportOutcome = "created" | "unchanged" | "replaced";
export type AssetImportSourceKind = "openai_file" | "https" | "base64";

export interface AssetImportReceipt {
  schemaVersion: 1;
  importReceiptId: string;
  workspaceId: string;
  destinationPath: string;
  outcome: AssetImportOutcome;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  mimeType: "image/png";
  sourceKind: AssetImportSourceKind;
  sourceHost?: string;
  sourceFileId?: string;
  sourceFileName?: string;
  artifactId: string;
  previousSha256?: string;
  previousArtifactId?: string;
  displacedTrashId?: string;
  createdAt: string;
}

export type RegisterAssetImportReceiptInput = Omit<
  AssetImportReceipt,
  "schemaVersion" | "importReceiptId" | "createdAt"
>;

export class AssetReceiptStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  registerImport(input: RegisterAssetImportReceiptInput): AssetImportReceipt {
    validateImportReceiptInput(input);
    const stable = {
      schemaVersion: 1 as const,
      workspaceId: input.workspaceId,
      destinationPath: input.destinationPath,
      outcome: input.outcome,
      bytes: input.bytes,
      sha256: input.sha256,
      width: input.width,
      height: input.height,
      mimeType: input.mimeType,
      sourceKind: input.sourceKind,
      sourceHost: input.sourceHost,
      sourceFileId: input.sourceFileId,
      sourceFileName: input.sourceFileName,
      artifactId: input.artifactId,
      previousSha256: input.previousSha256,
      previousArtifactId: input.previousArtifactId,
      displacedTrashId: input.displacedTrashId,
    };
    const importReceiptId = `import_receipt_${createHash("sha256")
      .update(JSON.stringify(stable))
      .digest("hex")}`;
    const existing = this.getImport(input.workspaceId, importReceiptId);
    if (existing) return existing;

    const receipt = JSON.parse(
      JSON.stringify({
        ...stable,
        importReceiptId,
        createdAt: new Date().toISOString(),
      }),
    ) as AssetImportReceipt;
    this.database.sqlite
      .prepare(
        `insert into asset_import_receipts (
           import_receipt_id, workspace_session_id, destination_path, outcome,
           sha256, artifact_id, source_kind, source_file_id, receipt_json,
           created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.importReceiptId,
        receipt.workspaceId,
        receipt.destinationPath,
        receipt.outcome,
        receipt.sha256,
        receipt.artifactId,
        receipt.sourceKind,
        receipt.sourceFileId ?? null,
        JSON.stringify(receipt),
        receipt.createdAt,
      );
    return receipt;
  }

  getImport(
    workspaceId: string,
    importReceiptId: string,
  ): AssetImportReceipt | undefined {
    validateWorkspaceId(workspaceId);
    if (!/^import_receipt_[0-9a-f]{64}$/.test(importReceiptId)) {
      throw new Error("ASSET_RECEIPT_INVALID: Invalid importReceiptId.");
    }
    const row = this.database.sqlite
      .prepare(
        `select receipt_json
           from asset_import_receipts
          where workspace_session_id = ? and import_receipt_id = ?`,
      )
      .get(workspaceId, importReceiptId) as
      { receipt_json: string } | undefined;
    return row
      ? (JSON.parse(row.receipt_json) as AssetImportReceipt)
      : undefined;
  }
}

function validateImportReceiptInput(
  input: RegisterAssetImportReceiptInput,
): void {
  validateWorkspaceId(input.workspaceId);
  if (
    !input.destinationPath ||
    input.destinationPath.startsWith("/") ||
    input.destinationPath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid destination path.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid SHA-256.");
  }
  if (!/^artifact_[0-9a-f-]{36}$/.test(input.artifactId)) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid artifactId.");
  }
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid workspaceId.");
  }
}
