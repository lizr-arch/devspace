import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApprovedAssetReceipt } from "./asset-receipts.js";
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
