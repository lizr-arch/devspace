import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open, opendir, readFile, unlink } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  AssetReceiptStore,
  type ApprovedAssetReceipt,
  validateApprovedAssetReceipt,
} from "./asset-receipts.js";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-paths.js";

export interface ApprovedReceiptWriteResult {
  path: string;
  created: boolean;
}

export async function writeImmutableApprovedReceipt(
  workspaceRoot: string,
  receipt: ApprovedAssetReceipt,
): Promise<ApprovedReceiptWriteResult> {
  const resolved = resolveWorkspacePath(
    workspaceRoot,
    receipt.projectReceiptPath,
  );
  const serialized = serializeApprovedReceipt(receipt);
  if (existsSync(resolved.absolutePath)) {
    const existing = await readFile(resolved.absolutePath, "utf8");
    if (existing !== serialized) {
      throw new Error(
        "APPROVED_ASSET_RECEIPT_CONFLICT: Project receipt already exists with different content.",
      );
    }
    return { path: resolved.relativePath, created: false };
  }

  await mkdir(dirname(resolved.absolutePath), { recursive: true });
  const checked = resolveWorkspacePath(
    workspaceRoot,
    receipt.projectReceiptPath,
  );
  const temporary = `${checked.absolutePath}.devspace-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, checked.absolutePath);
    await unlink(temporary);
    return { path: checked.relativePath, created: true };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      const existing = await readFile(checked.absolutePath, "utf8");
      if (existing === serialized) {
        return { path: checked.relativePath, created: false };
      }
      throw new Error(
        "APPROVED_ASSET_RECEIPT_CONFLICT: Project receipt was created concurrently with different content.",
      );
    }
    throw error;
  }
}

export async function readApprovedReceiptFile(
  workspaceRoot: string,
  receiptPath: string,
): Promise<ApprovedAssetReceipt> {
  const resolved = resolveExistingWorkspacePath(
    workspaceRoot,
    receiptPath,
    "file",
  );
  const parsed = JSON.parse(
    await readFile(resolved.absolutePath, "utf8"),
  ) as ApprovedAssetReceipt;
  return parsed;
}

export async function removeApprovedReceiptFile(
  workspaceRoot: string,
  receiptPath: string,
): Promise<void> {
  const resolved = resolveWorkspacePath(workspaceRoot, receiptPath);
  await unlink(resolved.absolutePath);
}

export function serializeApprovedReceipt(
  receipt: ApprovedAssetReceipt,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export interface ReindexApprovedAssetsResult {
  scanned: number;
  indexed: number;
  existing: number;
  errors: string[];
}

export async function reindexApprovedAssetReceipts(input: {
  workspaceRoot: string;
  receiptRoot: string;
  store: AssetReceiptStore;
  maxReceipts?: number;
  maxDepth?: number;
}): Promise<ReindexApprovedAssetsResult> {
  const maxReceipts = input.maxReceipts ?? 1_000;
  const maxDepth = input.maxDepth ?? 8;
  if (
    !Number.isInteger(maxReceipts) ||
    maxReceipts < 1 ||
    maxReceipts > 5_000
  ) {
    throw new Error(
      "APPROVED_ASSET_REINDEX_INVALID: maxReceipts must be between 1 and 5000.",
    );
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
    throw new Error(
      "APPROVED_ASSET_REINDEX_INVALID: maxDepth must be between 0 and 16.",
    );
  }
  const root = resolveExistingWorkspacePath(
    input.workspaceRoot,
    input.receiptRoot,
    "directory",
  );
  const files: string[] = [];
  const errors: string[] = [];

  async function scan(directory: string, depth: number): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        errors.push(
          `WORKSPACE_ESCAPE: Skipped symbolic link ${relative(root.canonicalWorkspaceRoot, absolute)}.`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < maxDepth) await scan(absolute, depth + 1);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".approved-asset-receipt.json")
      ) {
        if (files.length >= maxReceipts) {
          throw new Error(
            `APPROVED_ASSET_REINDEX_LIMIT: More than ${maxReceipts} receipts were found.`,
          );
        }
        files.push(absolute);
      }
    }
  }
  await scan(root.absolutePath, 0);

  const receipts: ApprovedAssetReceipt[] = [];
  for (const absolute of files) {
    const receiptPath = relative(root.canonicalWorkspaceRoot, absolute)
      .split("\\")
      .join("/");
    try {
      const receipt = JSON.parse(
        await readFile(absolute, "utf8"),
      ) as ApprovedAssetReceipt;
      validateApprovedAssetReceipt(receipt);
      if (receipt.projectReceiptPath !== receiptPath) {
        throw new Error(
          "APPROVED_ASSET_RECEIPT_INVALID: Embedded projectReceiptPath does not match the scanned file.",
        );
      }
      receipts.push(receipt);
    } catch (error) {
      errors.push(
        `${receiptPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const pending = receipts.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  let indexed = 0;
  let existing = 0;
  while (pending.length > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const receipt = pending[index];
      const parent = receipt.revision.supersedesAssetReceiptId;
      if (parent && !input.store.getApproved(parent)) continue;
      const wasExisting = input.store.getApproved(receipt.assetReceiptId);
      input.store.registerApproved(receipt);
      if (wasExisting) existing += 1;
      else indexed += 1;
      pending.splice(index, 1);
      progressed = true;
    }
    if (progressed) continue;
    for (const receipt of pending) {
      errors.push(
        `${receipt.projectReceiptPath}: APPROVED_ASSET_SUPERSESSION_INVALID: Missing parent ${receipt.revision.supersedesAssetReceiptId}.`,
      );
    }
    break;
  }
  return { scanned: files.length, indexed, existing, errors };
}
