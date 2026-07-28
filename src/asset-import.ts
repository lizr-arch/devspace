import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, isAbsolute } from "node:path";
import {
  resolveWorkspacePath,
  workspaceRelativeFromAbsolute,
} from "./workspace-paths.js";
import { isPathInsideRoot } from "./roots.js";
import { validatePng, type PngDimensions } from "./png-validator.js";

export type ImportAssetFormat = "PNG" | "JPEG" | "WEBP" | "GLB" | "WAV" | "OGG";

export const MAX_IMPORT_BYTES: Record<ImportAssetFormat, number> = {
  PNG: 25 * 1024 * 1024,
  JPEG: 25 * 1024 * 1024,
  WEBP: 25 * 1024 * 1024,
  GLB: 512 * 1024 * 1024,
  WAV: 256 * 1024 * 1024,
  OGG: 256 * 1024 * 1024,
};

const MAX_REDIRECTS = 5;
const MAX_BASE64_CHARACTERS = Math.ceil((MAX_IMPORT_BYTES.GLB * 4) / 3) + 4;
export const DEFAULT_ASSET_DOWNLOAD_TIMEOUTS = Object.freeze({
  connectOrHeadersMs: 30_000,
  idleReadMs: 30_000,
  totalMs: 180_000,
});

export interface AssetDownloadTimeouts {
  connectOrHeadersMs: number;
  idleReadMs: number;
  totalMs: number;
}

export interface HttpsDownloadOptions {
  fetchImpl?: typeof fetch;
  assertPublicHostnameImpl?: (hostname: string) => Promise<void>;
  timeouts?: Partial<AssetDownloadTimeouts>;
}

export interface ImportAssetInput {
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

export interface OpenAiFileSource {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type HttpsDownloader = (
  sourceUrl: string,
  maxBytes: number,
) => Promise<{ data: Buffer; sourceHost: string }>;

export interface ImportAssetResult {
  path: string;
  bytes: number;
  sha256: string;
  format: ImportAssetFormat;
  mimeType: string;
  source: "openai_file" | "https" | "base64";
  sourceHost?: string;
  sourceFileId?: string;
  sourceFileName?: string;
  dimensions?: PngDimensions;
  outcome: ImportAssetOutcome;
  previousSha256?: string;
}

export type ImportAssetOutcome = "created" | "unchanged" | "replaced";

export async function importAsset(
  input: ImportAssetInput,
): Promise<ImportAssetResult> {
  const sourceCount = [input.file, input.sourceUrl, input.base64Data].filter(
    (value) => value !== undefined,
  ).length;
  if (sourceCount !== 1) {
    throw new Error(
      "ASSET_SOURCE_INVALID: Provide exactly one of file, sourceUrl, or base64Data.",
    );
  }
  const expectedFormat = formatForExtension(input.destination);
  const source =
    input.file !== undefined
      ? await downloadOpenAiFile(
          input.file,
          MAX_IMPORT_BYTES[expectedFormat],
          input.httpsDownloader ?? downloadHttpsBytes,
        )
      : input.sourceUrl !== undefined
        ? await downloadAsset(
            input.sourceUrl,
            MAX_IMPORT_BYTES[expectedFormat],
            input.httpsDownloader ?? downloadHttpsBytes,
          )
        : {
            data: decodeBase64(input.base64Data ?? ""),
            source: "base64" as const,
            sourceHost: undefined,
            sourceFileId: undefined,
            sourceFileName: undefined,
          };
  if (source.data.length > MAX_IMPORT_BYTES[expectedFormat]) {
    throw new Error(
      `ASSET_TOO_LARGE: ${expectedFormat} exceeds ${MAX_IMPORT_BYTES[expectedFormat]} bytes.`,
    );
  }
  const detectedFormat = detectAssetFormat(source.data);
  if (detectedFormat !== expectedFormat) {
    throw new Error(
      `ASSET_FORMAT_REJECTED: Extension requires ${expectedFormat}, detected ${detectedFormat ?? "unknown"}.`,
    );
  }
  const dimensions = await validateContainer(source.data, detectedFormat);
  const sha256 = createHash("sha256").update(source.data).digest("hex");
  if (
    input.expectedSha256 !== undefined &&
    sha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new Error(
      `ASSET_HASH_MISMATCH: Expected ${input.expectedSha256.toLowerCase()}, received ${sha256}.`,
    );
  }
  const writeResult = await writeAtomicAsset({
    destination: input.destination,
    workspaceRoot: input.workspaceRoot,
    data: source.data,
    sha256,
    overwrite: input.overwrite ?? false,
    beforeCommit: input.beforeCommit,
  });
  return {
    path: workspaceRelativeFromAbsolute(input.workspaceRoot, input.destination),
    bytes: source.data.length,
    sha256,
    format: detectedFormat,
    mimeType: assetMimeType(detectedFormat),
    source: source.source,
    sourceHost: source.sourceHost,
    sourceFileId: source.sourceFileId,
    sourceFileName: source.sourceFileName,
    dimensions,
    ...writeResult,
  };
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error(
      "ASSET_SOURCE_INVALID: base64Data is not valid standard Base64.",
    );
  }
  return Buffer.from(value, "base64");
}

async function downloadAsset(
  sourceUrl: string,
  maxBytes: number,
  downloader: HttpsDownloader,
): Promise<{
  data: Buffer;
  source: "https";
  sourceHost: string;
  sourceFileId?: undefined;
  sourceFileName?: undefined;
}> {
  const downloaded = await downloader(sourceUrl, maxBytes);
  return {
    ...downloaded,
    source: "https",
    sourceFileId: undefined,
    sourceFileName: undefined,
  };
}

async function downloadOpenAiFile(
  file: OpenAiFileSource,
  maxBytes: number,
  downloader: HttpsDownloader,
): Promise<{
  data: Buffer;
  source: "openai_file";
  sourceHost?: undefined;
  sourceFileId: string;
  sourceFileName?: string;
}> {
  if (file.mime_type !== undefined && file.mime_type !== "image/png") {
    throw new Error(
      "ASSET_FORMAT_REJECTED: OpenAI file mime_type must be image/png.",
    );
  }
  if (
    file.file_name !== undefined &&
    extname(file.file_name) !== "" &&
    extname(file.file_name).toLowerCase() !== ".png"
  ) {
    throw new Error(
      "ASSET_FORMAT_REJECTED: OpenAI file_name extension must be .png.",
    );
  }
  const downloaded = await downloader(file.download_url, maxBytes);
  return {
    data: downloaded.data,
    source: "openai_file",
    sourceHost: undefined,
    sourceFileId: file.file_id,
    sourceFileName: file.file_name,
  };
}

export async function downloadHttpsBytes(
  sourceUrl: string,
  maxBytes: number,
  options: HttpsDownloadOptions = {},
): Promise<{ data: Buffer; sourceHost: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const assertPublicHostnameImpl =
    options.assertPublicHostnameImpl ?? assertPublicHostname;
  const timeouts = normalizedDownloadTimeouts(options.timeouts);
  let bytes = 0;
  let current = parsePublicHttpsUrl(sourceUrl);
  const totalTimeout = createDownloadTimeout(
    timeouts.totalMs,
    () => new AssetDownloadTimeoutError("total", timeouts.totalMs, bytes),
  );
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const requestTimeout = createDownloadTimeout(
        timeouts.connectOrHeadersMs,
        () =>
          new AssetDownloadTimeoutError(
            "connect_or_headers",
            timeouts.connectOrHeadersMs,
            bytes,
          ),
      );
      const requestSignal = AbortSignal.any([
        totalTimeout.controller.signal,
        requestTimeout.controller.signal,
      ]);
      let response: Response;
      try {
        await awaitWithSignal(
          assertPublicHostnameImpl(current.hostname),
          requestSignal,
        );
        response = await fetchImpl(current, {
          redirect: "manual",
          signal: requestSignal,
          headers: { accept: "application/octet-stream,*/*;q=0.8" },
        });
      } catch (error) {
        throw normalizedDownloadError(
          error,
          totalTimeout.controller.signal,
          requestTimeout.controller.signal,
        );
      } finally {
        requestTimeout.clear();
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_REDIRECTS) {
          throw new Error("ASSET_DOWNLOAD_FAILED: Redirect policy rejected.");
        }
        current = parsePublicHttpsUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `ASSET_DOWNLOAD_FAILED: HTTPS download returned ${response.status}.`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`ASSET_TOO_LARGE: Asset exceeds ${maxBytes} bytes.`);
      }
      if (!response.body) {
        throw new Error(
          "ASSET_DOWNLOAD_FAILED: Download returned an empty body.",
        );
      }
      const chunks: Buffer[] = [];
      const reader = response.body.getReader();
      try {
        while (true) {
          const idleTimeout = createDownloadTimeout(
            timeouts.idleReadMs,
            () =>
              new AssetDownloadTimeoutError(
                "body_idle",
                timeouts.idleReadMs,
                bytes,
              ),
          );
          let read: ReadableStreamReadResult<Uint8Array>;
          try {
            read = await awaitWithSignal(
              reader.read(),
              AbortSignal.any([
                totalTimeout.controller.signal,
                idleTimeout.controller.signal,
              ]),
            );
          } catch (error) {
            const normalized = normalizedDownloadError(
              error,
              totalTimeout.controller.signal,
              idleTimeout.controller.signal,
            );
            void reader.cancel(normalized).catch(() => undefined);
            throw normalized;
          } finally {
            idleTimeout.clear();
          }
          if (read.done) break;
          const buffer = Buffer.from(read.value);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            throw new Error(
              `ASSET_TOO_LARGE: Asset exceeds ${maxBytes} bytes.`,
            );
          }
          chunks.push(buffer);
        }
      } finally {
        reader.releaseLock();
      }
      return {
        data: Buffer.concat(chunks, bytes),
        sourceHost: current.hostname,
      };
    }
    throw new Error("ASSET_DOWNLOAD_FAILED: Download did not complete.");
  } finally {
    totalTimeout.clear();
  }
}

type AssetDownloadTimeoutPhase = "connect_or_headers" | "body_idle" | "total";

class AssetDownloadTimeoutError extends Error {
  constructor(
    phase: AssetDownloadTimeoutPhase,
    timeoutMs: number,
    receivedBytes: number,
  ) {
    super(
      `ASSET_DOWNLOAD_TIMEOUT: phase=${phase}; timeoutMs=${timeoutMs}; receivedBytes=${receivedBytes}.`,
    );
    this.name = "AssetDownloadTimeoutError";
  }
}

function normalizedDownloadTimeouts(
  input: Partial<AssetDownloadTimeouts> | undefined,
): AssetDownloadTimeouts {
  const timeouts = {
    ...DEFAULT_ASSET_DOWNLOAD_TIMEOUTS,
    ...input,
  };
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `ASSET_DOWNLOAD_CONFIG_INVALID: ${name} must be a positive integer.`,
      );
    }
  }
  if (timeouts.totalMs < timeouts.connectOrHeadersMs) {
    throw new Error(
      "ASSET_DOWNLOAD_CONFIG_INVALID: totalMs must be at least connectOrHeadersMs.",
    );
  }
  return timeouts;
}

function createDownloadTimeout(
  timeoutMs: number,
  reason: () => AssetDownloadTimeoutError,
): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(reason()), timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

async function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizedDownloadError(
  error: unknown,
  totalSignal: AbortSignal,
  phaseSignal: AbortSignal,
): unknown {
  if (totalSignal.aborted) return totalSignal.reason;
  if (phaseSignal.aborted) return phaseSignal.reason;
  return error;
}

function parsePublicHttpsUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ASSET_SOURCE_INVALID: sourceUrl must be valid HTTPS.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "ASSET_SOURCE_INVALID: sourceUrl must use HTTPS without embedded credentials.",
    );
  }
  return parsed;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("ASSET_SOURCE_INVALID: sourceUrl must be public.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error(
      "ASSET_SOURCE_INVALID: sourceUrl must resolve only to public addresses.",
    );
  }
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPublicAddress(normalized.slice("::ffff:".length));
    }
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

async function writeAtomicAsset(input: {
  destination: string;
  workspaceRoot: string;
  data: Buffer;
  sha256: string;
  overwrite: boolean;
  beforeCommit?: () => Promise<void>;
}): Promise<{
  outcome: ImportAssetOutcome;
  previousSha256?: string;
}> {
  const relativeDestination = isAbsolute(input.destination)
    ? workspaceRelativeFromAbsolute(input.workspaceRoot, input.destination)
    : input.destination;
  const resolved = resolveWorkspacePath(
    input.workspaceRoot,
    relativeDestination,
  );
  await mkdir(dirname(resolved.absolutePath), { recursive: true });
  let previousSha256: string | undefined;
  try {
    const target = await lstat(resolved.absolutePath);
    if (target.isSymbolicLink()) {
      throw new Error("WORKSPACE_ESCAPE: Refusing to replace a symbolic link.");
    }
    if (!target.isFile()) {
      throw new Error("PATH_TYPE_REJECTED: Destination is not a regular file.");
    }
    previousSha256 = await sha256File(resolved.absolutePath);
    if (previousSha256 === input.sha256) {
      return { outcome: "unchanged", previousSha256 };
    }
    if (!input.overwrite) {
      throw new Error(
        `ASSET_DESTINATION_CONFLICT: Destination exists with sha256 ${previousSha256}; incoming sha256 is ${input.sha256}.`,
      );
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const canonicalParent = await realpath(dirname(resolved.absolutePath));
  if (!isPathInsideRoot(canonicalParent, resolved.canonicalWorkspaceRoot)) {
    throw new Error("WORKSPACE_ESCAPE: Destination parent leaves workspace.");
  }
  const temporary = `${resolved.absolutePath}.devspace-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(input.data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await input.beforeCommit?.();
    if (input.overwrite && previousSha256 !== undefined) {
      const currentSha256 = await sha256File(resolved.absolutePath);
      if (currentSha256 !== previousSha256) {
        throw new Error(
          "ASSET_DESTINATION_CHANGED: Destination changed during import.",
        );
      }
      await rename(temporary, resolved.absolutePath);
    } else {
      await link(temporary, resolved.absolutePath);
      await unlink(temporary);
    }
    return {
      outcome: previousSha256 === undefined ? "created" : "replaced",
      previousSha256,
    };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      const concurrentSha256 = await sha256File(resolved.absolutePath).catch(
        () => undefined,
      );
      if (concurrentSha256 === input.sha256) {
        return {
          outcome: "unchanged",
          previousSha256: concurrentSha256,
        };
      }
      throw new Error(
        `ASSET_DESTINATION_CONFLICT: Destination was created concurrently${concurrentSha256 ? ` with sha256 ${concurrentSha256}` : ""}; incoming sha256 is ${input.sha256}.`,
      );
    }
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function detectAssetFormat(data: Buffer): ImportAssetFormat | undefined {
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "PNG";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "JPEG";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "WEBP";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "glTF")
    return "GLB";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WAVE"
  )
    return "WAV";
  if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "OggS")
    return "OGG";
  return undefined;
}

async function validateContainer(
  data: Buffer,
  format: ImportAssetFormat,
): Promise<PngDimensions | undefined> {
  if (format === "GLB") {
    const version = data.readUInt32LE(4);
    const declaredLength = data.readUInt32LE(8);
    if (version !== 2 || declaredLength !== data.length) {
      throw new Error("ASSET_FORMAT_REJECTED: GLB header is malformed.");
    }
  }
  if (format === "PNG") {
    return validatePng(data);
  }
  if (format === "JPEG" && data.length < 4) {
    throw new Error("ASSET_FORMAT_REJECTED: JPEG is truncated.");
  }
  return undefined;
}

function formatForExtension(path: string): ImportAssetFormat {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "PNG";
    case ".jpg":
    case ".jpeg":
      return "JPEG";
    case ".webp":
      return "WEBP";
    case ".glb":
      return "GLB";
    case ".wav":
      return "WAV";
    case ".ogg":
      return "OGG";
    default:
      throw new Error(
        "ASSET_FORMAT_REJECTED: Supported extensions are PNG, JPEG, WEBP, GLB, WAV, and OGG.",
      );
  }
}

export function assetMimeType(format: ImportAssetFormat): string {
  switch (format) {
    case "PNG":
      return "image/png";
    case "JPEG":
      return "image/jpeg";
    case "WEBP":
      return "image/webp";
    case "GLB":
      return "model/gltf-binary";
    case "WAV":
      return "audio/wav";
    case "OGG":
      return "audio/ogg";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
