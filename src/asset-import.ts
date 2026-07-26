import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
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

export interface ImportAssetInput {
  destination: string;
  workspaceRoot: string;
  sourceUrl?: string;
  base64Data?: string;
  expectedSha256?: string;
  overwrite?: boolean;
  beforeCommit?: () => Promise<void>;
}

export interface ImportAssetResult {
  path: string;
  bytes: number;
  sha256: string;
  format: ImportAssetFormat;
  mimeType: string;
  source: "https" | "base64";
  sourceHost?: string;
}

export async function importAsset(
  input: ImportAssetInput,
): Promise<ImportAssetResult> {
  if ((input.sourceUrl === undefined) === (input.base64Data === undefined)) {
    throw new Error(
      "ASSET_SOURCE_INVALID: Provide exactly one of sourceUrl or base64Data.",
    );
  }
  const expectedFormat = formatForExtension(input.destination);
  const source =
    input.sourceUrl !== undefined
      ? await downloadAsset(input.sourceUrl, MAX_IMPORT_BYTES[expectedFormat])
      : {
          data: decodeBase64(input.base64Data ?? ""),
          source: "base64" as const,
          sourceHost: undefined,
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
  validateContainer(source.data, detectedFormat);
  const sha256 = createHash("sha256").update(source.data).digest("hex");
  if (
    input.expectedSha256 !== undefined &&
    sha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new Error(
      `ASSET_HASH_MISMATCH: Expected ${input.expectedSha256.toLowerCase()}, received ${sha256}.`,
    );
  }
  await writeAtomicAsset({
    destination: input.destination,
    workspaceRoot: input.workspaceRoot,
    data: source.data,
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
): Promise<{ data: Buffer; source: "https"; sourceHost: string }> {
  let current = parsePublicHttpsUrl(sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHostname(current.hostname);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { accept: "application/octet-stream,*/*;q=0.8" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
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
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new Error(`ASSET_TOO_LARGE: Asset exceeds ${maxBytes} bytes.`);
      }
      chunks.push(buffer);
    }
    return {
      data: Buffer.concat(chunks, bytes),
      source: "https",
      sourceHost: current.hostname,
    };
  }
  throw new Error("ASSET_DOWNLOAD_FAILED: Download did not complete.");
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
  overwrite: boolean;
  beforeCommit?: () => Promise<void>;
}): Promise<void> {
  const relativeDestination = isAbsolute(input.destination)
    ? workspaceRelativeFromAbsolute(input.workspaceRoot, input.destination)
    : input.destination;
  const resolved = resolveWorkspacePath(
    input.workspaceRoot,
    relativeDestination,
  );
  await mkdir(dirname(resolved.absolutePath), { recursive: true });
  try {
    const target = await lstat(resolved.absolutePath);
    if (target.isSymbolicLink()) {
      throw new Error("WORKSPACE_ESCAPE: Refusing to replace a symbolic link.");
    }
    if (!target.isFile()) {
      throw new Error("PATH_TYPE_REJECTED: Destination is not a regular file.");
    }
    if (!input.overwrite) {
      throw new Error("PATH_EXISTS: Destination already exists.");
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
    if (input.overwrite) {
      await rename(temporary, resolved.absolutePath);
    } else {
      await link(temporary, resolved.absolutePath);
      await unlink(temporary);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error("PATH_EXISTS: Destination already exists.");
    }
    throw error;
  }
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

function validateContainer(data: Buffer, format: ImportAssetFormat): void {
  if (format === "GLB") {
    const version = data.readUInt32LE(4);
    const declaredLength = data.readUInt32LE(8);
    if (version !== 2 || declaredLength !== data.length) {
      throw new Error("ASSET_FORMAT_REJECTED: GLB header is malformed.");
    }
  }
  if (format === "PNG" && data.length < 24) {
    throw new Error("ASSET_FORMAT_REJECTED: PNG is truncated.");
  }
  if (format === "JPEG" && data.length < 4) {
    throw new Error("ASSET_FORMAT_REJECTED: JPEG is truncated.");
  }
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
