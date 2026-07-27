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

export type ApprovedAssetSourceKind =
  "user_upload" | "image_gen" | "file_library" | "historical_conversation";

export interface ApprovedAssetReceipt {
  schemaVersion: 1;
  assetReceiptId: string;
  project: {
    projectId: string;
    taskId: string;
    assetRole: string;
  };
  asset: {
    destinationPath: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    mimeType: "image/png";
  };
  source: {
    kind: ApprovedAssetSourceKind;
    fileId?: string;
    fileName?: string;
    generationId?: string;
    model?: string;
    prompt?: string;
  };
  import: {
    importReceiptId: string;
    originatingWorkspaceId: string;
    importedAt: string;
  };
  humanApproval: {
    status: "passed";
    actor: "human_user";
    approvedPurpose: string;
    decisionText: string;
    evidenceRef?: string;
    approvedAt: string;
  };
  revision: {
    supersedesAssetReceiptId?: string;
  };
  projectReceiptPath: string;
  createdAt: string;
}

export interface RegisterApprovedAssetReceiptInput {
  projectId: string;
  taskId: string;
  assetRole: string;
  importReceipt: AssetImportReceipt;
  sourceKind: ApprovedAssetSourceKind;
  generationId?: string;
  model?: string;
  prompt?: string;
  approvedPurpose: string;
  decisionText: string;
  evidenceRef?: string;
  supersedesAssetReceiptId?: string;
  receiptDirectory: string;
}

export interface FindApprovedAssetsInput {
  projectId?: string;
  taskId?: string;
  assetRole?: string;
  sourceFileId?: string;
  destinationPath?: string;
  assetReceiptId?: string;
  limit?: number;
}

export interface ApprovedAssetSummary {
  assetReceiptId: string;
  projectId: string;
  taskId: string;
  assetRole: string;
  destinationPath: string;
  sha256: string;
  width: number;
  height: number;
  sourceKind: ApprovedAssetSourceKind;
  sourceFileId?: string;
  projectReceiptPath: string;
  createdAt: string;
  supersededByAssetReceiptId?: string;
  current: boolean;
}

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

  removeImport(importReceiptId: string): void {
    if (!/^import_receipt_[0-9a-f]{64}$/.test(importReceiptId)) {
      throw new Error("ASSET_RECEIPT_INVALID: Invalid importReceiptId.");
    }
    this.database.sqlite
      .prepare("delete from asset_import_receipts where import_receipt_id = ?")
      .run(importReceiptId);
  }

  buildApproved(
    input: RegisterApprovedAssetReceiptInput,
    createdAt = new Date().toISOString(),
  ): ApprovedAssetReceipt {
    validateApprovedReceiptInput(input);
    const identity = approvedReceiptIdentity(input);
    const assetReceiptId = `asset_receipt_${createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")}`;
    const projectReceiptPath = `${normalizeReceiptDirectory(input.receiptDirectory)}/${assetReceiptId}.approved-asset-receipt.json`;
    return JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        assetReceiptId,
        project: {
          projectId: input.projectId,
          taskId: input.taskId,
          assetRole: input.assetRole,
        },
        asset: {
          destinationPath: input.importReceipt.destinationPath,
          bytes: input.importReceipt.bytes,
          sha256: input.importReceipt.sha256,
          width: input.importReceipt.width,
          height: input.importReceipt.height,
          mimeType: "image/png",
        },
        source: {
          kind: input.sourceKind,
          fileId: input.importReceipt.sourceFileId,
          fileName: input.importReceipt.sourceFileName,
          generationId: input.generationId,
          model: input.model,
          prompt: input.prompt,
        },
        import: {
          importReceiptId: input.importReceipt.importReceiptId,
          originatingWorkspaceId: input.importReceipt.workspaceId,
          importedAt: input.importReceipt.createdAt,
        },
        humanApproval: {
          status: "passed",
          actor: "human_user",
          approvedPurpose: input.approvedPurpose,
          decisionText: input.decisionText,
          evidenceRef: input.evidenceRef,
          approvedAt: createdAt,
        },
        revision: {
          supersedesAssetReceiptId: input.supersedesAssetReceiptId,
        },
        projectReceiptPath,
        createdAt,
      }),
    ) as ApprovedAssetReceipt;
  }

  registerApproved(receipt: ApprovedAssetReceipt): ApprovedAssetReceipt {
    validateApprovedReceipt(receipt);
    const existing = this.getApproved(receipt.assetReceiptId);
    if (existing) {
      if (
        approvedReceiptIdentityFromReceipt(existing) !==
        approvedReceiptIdentityFromReceipt(receipt)
      ) {
        throw new Error(
          "APPROVED_ASSET_RECEIPT_CONFLICT: Receipt ID has different immutable content.",
        );
      }
      return existing;
    }
    const supersedes = receipt.revision.supersedesAssetReceiptId;
    const insert = this.database.sqlite.transaction(() => {
      if (supersedes) {
        const previous = this.getApproved(supersedes);
        if (!previous) {
          throw new Error(
            "APPROVED_ASSET_SUPERSESSION_INVALID: Superseded receipt was not found.",
          );
        }
        if (
          previous.project.projectId !== receipt.project.projectId ||
          previous.project.assetRole !== receipt.project.assetRole ||
          previous.asset.destinationPath !== receipt.asset.destinationPath
        ) {
          throw new Error(
            "APPROVED_ASSET_SUPERSESSION_INVALID: Superseded receipt belongs to a different project, role, or path.",
          );
        }
        const alreadySuperseded = this.database.sqlite
          .prepare(
            `select superseding_asset_receipt_id
               from approved_asset_supersessions
              where superseded_asset_receipt_id = ?`,
          )
          .get(supersedes) as
          { superseding_asset_receipt_id: string } | undefined;
        if (alreadySuperseded) {
          throw new Error(
            `APPROVED_ASSET_SUPERSESSION_CONFLICT: Receipt is already superseded by ${alreadySuperseded.superseding_asset_receipt_id}.`,
          );
        }
      } else {
        const current = this.getCurrentApprovedForPath(
          receipt.project.projectId,
          receipt.asset.destinationPath,
        );
        if (current && current.asset.sha256 !== receipt.asset.sha256) {
          throw new Error(
            `APPROVED_ASSET_REPLACEMENT_REQUIRES_SUPERSESSION: Current approved receipt is ${current.assetReceiptId}.`,
          );
        }
      }
      this.database.sqlite
        .prepare(
          `insert into approved_asset_receipts (
             asset_receipt_id, originating_workspace_session_id, project_id,
             task_id, asset_role, destination_path, sha256, source_file_id,
             import_receipt_id, project_receipt_path, receipt_json, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.assetReceiptId,
          receipt.import.originatingWorkspaceId,
          receipt.project.projectId,
          receipt.project.taskId,
          receipt.project.assetRole,
          receipt.asset.destinationPath,
          receipt.asset.sha256,
          receipt.source.fileId ?? null,
          receipt.import.importReceiptId,
          receipt.projectReceiptPath,
          JSON.stringify(receipt),
          receipt.createdAt,
        );
      if (supersedes) {
        this.database.sqlite
          .prepare(
            `insert into approved_asset_supersessions (
               superseded_asset_receipt_id, superseding_asset_receipt_id, created_at
             ) values (?, ?, ?)`,
          )
          .run(supersedes, receipt.assetReceiptId, receipt.createdAt);
      }
    });
    insert.immediate();
    return receipt;
  }

  getApproved(assetReceiptId: string): ApprovedAssetReceipt | undefined {
    validateAssetReceiptId(assetReceiptId);
    const row = this.database.sqlite
      .prepare(
        `select receipt_json
           from approved_asset_receipts
          where asset_receipt_id = ?`,
      )
      .get(assetReceiptId) as { receipt_json: string } | undefined;
    return row
      ? (JSON.parse(row.receipt_json) as ApprovedAssetReceipt)
      : undefined;
  }

  getCurrentApprovedForPath(
    projectId: string,
    destinationPath: string,
  ): ApprovedAssetReceipt | undefined {
    validateTextField("projectId", projectId);
    validateDestinationPath(destinationPath);
    const row = this.database.sqlite
      .prepare(
        `select current.receipt_json
           from approved_asset_receipts current
           left join approved_asset_supersessions s
             on s.superseded_asset_receipt_id = current.asset_receipt_id
          where current.project_id = ?
            and current.destination_path = ?
            and s.superseded_asset_receipt_id is null
          order by current.created_at desc
          limit 1`,
      )
      .get(projectId, destinationPath) as { receipt_json: string } | undefined;
    return row
      ? (JSON.parse(row.receipt_json) as ApprovedAssetReceipt)
      : undefined;
  }

  getSupersedingAssetReceiptId(assetReceiptId: string): string | undefined {
    validateAssetReceiptId(assetReceiptId);
    const row = this.database.sqlite
      .prepare(
        `select superseding_asset_receipt_id
           from approved_asset_supersessions
          where superseded_asset_receipt_id = ?`,
      )
      .get(assetReceiptId) as
      { superseding_asset_receipt_id: string } | undefined;
    return row?.superseding_asset_receipt_id;
  }

  findApproved(input: FindApprovedAssetsInput): ApprovedAssetSummary[] {
    const conditions: string[] = [];
    const values: string[] = [];
    const filters: Array<[string, string | undefined]> = [
      ["r.project_id", input.projectId],
      ["r.task_id", input.taskId],
      ["r.asset_role", input.assetRole],
      ["r.source_file_id", input.sourceFileId],
      ["r.destination_path", input.destinationPath],
      ["r.asset_receipt_id", input.assetReceiptId],
    ];
    for (const [column, value] of filters) {
      if (value === undefined) continue;
      validateTextField(column, value);
      conditions.push(`${column} = ?`);
      values.push(value);
    }
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error(
        "APPROVED_ASSET_QUERY_INVALID: limit must be between 1 and 200.",
      );
    }
    const rows = this.database.sqlite
      .prepare(
        `select r.receipt_json, s.superseding_asset_receipt_id
           from approved_asset_receipts r
           left join approved_asset_supersessions s
             on s.superseded_asset_receipt_id = r.asset_receipt_id
          ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
          order by r.created_at desc
          limit ?`,
      )
      .all(...values, limit) as Array<{
      receipt_json: string;
      superseding_asset_receipt_id: string | null;
    }>;
    return rows.map((row) => {
      const receipt = JSON.parse(row.receipt_json) as ApprovedAssetReceipt;
      const supersededByAssetReceiptId =
        row.superseding_asset_receipt_id ?? undefined;
      return {
        assetReceiptId: receipt.assetReceiptId,
        projectId: receipt.project.projectId,
        taskId: receipt.project.taskId,
        assetRole: receipt.project.assetRole,
        destinationPath: receipt.asset.destinationPath,
        sha256: receipt.asset.sha256,
        width: receipt.asset.width,
        height: receipt.asset.height,
        sourceKind: receipt.source.kind,
        sourceFileId: receipt.source.fileId,
        projectReceiptPath: receipt.projectReceiptPath,
        createdAt: receipt.createdAt,
        supersededByAssetReceiptId,
        current: supersededByAssetReceiptId === undefined,
      };
    });
  }

  removeApproved(assetReceiptId: string): void {
    validateAssetReceiptId(assetReceiptId);
    const remove = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `delete from approved_asset_supersessions
            where superseding_asset_receipt_id = ?`,
        )
        .run(assetReceiptId);
      this.database.sqlite
        .prepare(
          "delete from approved_asset_receipts where asset_receipt_id = ?",
        )
        .run(assetReceiptId);
    });
    remove.immediate();
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

function validateApprovedReceiptInput(
  input: RegisterApprovedAssetReceiptInput,
): void {
  validateTextField("projectId", input.projectId);
  validateTextField("taskId", input.taskId);
  validateTextField("assetRole", input.assetRole);
  validateTextField("approvedPurpose", input.approvedPurpose, 4096);
  validateTextField("decisionText", input.decisionText, 16_384);
  if (input.evidenceRef !== undefined) {
    validateTextField("evidenceRef", input.evidenceRef, 4096);
  }
  if (input.sourceKind === "image_gen") {
    validateTextField("generationId", input.generationId);
    validateTextField("model", input.model);
    validateTextField("prompt", input.prompt, 100_000);
  }
  normalizeReceiptDirectory(input.receiptDirectory);
  validateImportReceiptInput(input.importReceipt);
  if (input.supersedesAssetReceiptId) {
    validateAssetReceiptId(input.supersedesAssetReceiptId);
  }
}

function validateApprovedReceipt(receipt: ApprovedAssetReceipt): void {
  validateAssetReceiptId(receipt.assetReceiptId);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.humanApproval.status !== "passed" ||
    receipt.humanApproval.actor !== "human_user"
  ) {
    throw new Error(
      "APPROVED_ASSET_RECEIPT_INVALID: Invalid schema or human approval state.",
    );
  }
  validateDestinationPath(receipt.asset.destinationPath);
  if (!/^[0-9a-f]{64}$/.test(receipt.asset.sha256)) {
    throw new Error("APPROVED_ASSET_RECEIPT_INVALID: Invalid SHA-256.");
  }
  if (approvedAssetReceiptId(receipt) !== receipt.assetReceiptId) {
    throw new Error(
      "APPROVED_ASSET_RECEIPT_INVALID: Receipt ID does not match immutable content.",
    );
  }
}

export function validateApprovedAssetReceipt(
  receipt: ApprovedAssetReceipt,
): void {
  validateApprovedReceipt(receipt);
}

export function approvedAssetReceiptId(receipt: ApprovedAssetReceipt): string {
  return `asset_receipt_${createHash("sha256")
    .update(JSON.stringify(approvedReceiptIdentityFromReceipt(receipt)))
    .digest("hex")}`;
}

function approvedReceiptIdentity(
  input: RegisterApprovedAssetReceiptInput,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectId: input.projectId,
    taskId: input.taskId,
    assetRole: input.assetRole,
    destinationPath: input.importReceipt.destinationPath,
    bytes: input.importReceipt.bytes,
    sha256: input.importReceipt.sha256,
    width: input.importReceipt.width,
    height: input.importReceipt.height,
    mimeType: input.importReceipt.mimeType,
    sourceKind: input.sourceKind,
    sourceFileId: input.importReceipt.sourceFileId,
    sourceFileName: input.importReceipt.sourceFileName,
    generationId: input.generationId,
    model: input.model,
    prompt: input.prompt,
    approvedPurpose: input.approvedPurpose,
    decisionText: input.decisionText,
    evidenceRef: input.evidenceRef,
    supersedesAssetReceiptId: input.supersedesAssetReceiptId,
  });
}

function approvedReceiptIdentityFromReceipt(
  receipt: ApprovedAssetReceipt,
): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    projectId: receipt.project.projectId,
    taskId: receipt.project.taskId,
    assetRole: receipt.project.assetRole,
    destinationPath: receipt.asset.destinationPath,
    bytes: receipt.asset.bytes,
    sha256: receipt.asset.sha256,
    width: receipt.asset.width,
    height: receipt.asset.height,
    mimeType: receipt.asset.mimeType,
    sourceKind: receipt.source.kind,
    sourceFileId: receipt.source.fileId,
    sourceFileName: receipt.source.fileName,
    generationId: receipt.source.generationId,
    model: receipt.source.model,
    prompt: receipt.source.prompt,
    approvedPurpose: receipt.humanApproval.approvedPurpose,
    decisionText: receipt.humanApproval.decisionText,
    evidenceRef: receipt.humanApproval.evidenceRef,
    supersedesAssetReceiptId: receipt.revision.supersedesAssetReceiptId,
  });
}

function normalizeReceiptDirectory(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  validateDestinationPath(`${normalized}/placeholder`);
  return normalized;
}

function validateDestinationPath(value: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid workspace-relative path.");
  }
}

function validateAssetReceiptId(value: string): void {
  if (!/^asset_receipt_[0-9a-f]{64}$/.test(value)) {
    throw new Error("APPROVED_ASSET_RECEIPT_INVALID: Invalid assetReceiptId.");
  }
}

function validateTextField(
  name: string,
  value: string | undefined,
  maxLength = 512,
): asserts value is string {
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`APPROVED_ASSET_RECEIPT_INVALID: Invalid ${name}.`);
  }
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^ws_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new Error("ASSET_RECEIPT_INVALID: Invalid workspaceId.");
  }
}
