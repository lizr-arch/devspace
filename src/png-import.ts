import {
  importAsset,
  type HttpsDownloader,
  type OpenAiFileSource,
} from "./asset-import.js";

export const MAX_PNG_IMPORT_BYTES = 25 * 1024 * 1024;

export interface ImportPngInput {
  destination: string;
  workspaceRoot: string;
  file?: OpenAiFileSource;
  sourceUrl?: string;
  base64Data?: string;
  expectedSha256?: string;
  overwrite?: boolean;
  beforeCommit?: () => Promise<void>;
  httpsDownloader?: HttpsDownloader;
}

export interface ImportPngResult {
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  mimeType: "image/png";
  source: "openai_file" | "https" | "base64";
  sourceHost?: string;
  sourceFileId?: string;
  sourceFileName?: string;
  outcome: "created" | "unchanged" | "replaced";
  previousSha256?: string;
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
    width: imported.dimensions!.width,
    height: imported.dimensions!.height,
    mimeType: "image/png",
    source: imported.source,
    sourceHost: imported.sourceHost,
    sourceFileId: imported.sourceFileId,
    sourceFileName: imported.sourceFileName,
    outcome: imported.outcome,
    previousSha256: imported.previousSha256,
  };
}
