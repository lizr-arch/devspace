import { importAsset } from "./asset-import.js";

export const MAX_PNG_IMPORT_BYTES = 25 * 1024 * 1024;

export interface ImportPngInput {
  destination: string;
  workspaceRoot: string;
  sourceUrl?: string;
  base64Data?: string;
  expectedSha256?: string;
  overwrite?: boolean;
}

export interface ImportPngResult {
  bytes: number;
  sha256: string;
  source: "https" | "base64";
  sourceHost?: string;
}

export async function importPng(
  input: ImportPngInput,
): Promise<ImportPngResult> {
  if (!input.destination.toLowerCase().endsWith(".png")) {
    throw new Error(
      "ASSET_FORMAT_REJECTED: PNG imports must use a .png destination.",
    );
  }
  const imported = await importAsset(input);
  return {
    bytes: imported.bytes,
    sha256: imported.sha256,
    source: imported.source,
    sourceHost: imported.sourceHost,
  };
}
