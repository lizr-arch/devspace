import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export const MAX_PNG_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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
  if ((input.sourceUrl === undefined) === (input.base64Data === undefined)) {
    throw new Error("Provide exactly one of sourceUrl or base64Data.");
  }
  if (extname(input.destination).toLowerCase() !== ".png") {
    throw new Error("PNG imports must use a destination path ending in .png.");
  }

  const source =
    input.sourceUrl !== undefined
      ? await downloadPng(input.sourceUrl)
      : {
          data: decodeBase64(input.base64Data ?? ""),
          source: "base64" as const,
          sourceHost: undefined,
        };
  assertPng(source.data);

  const sha256 = createHash("sha256").update(source.data).digest("hex");
  if (
    input.expectedSha256 !== undefined &&
    sha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new Error(
      `SHA-256 mismatch: expected ${input.expectedSha256.toLowerCase()}, received ${sha256}.`,
    );
  }

  await writeAtomicPng(
    input.destination,
    input.workspaceRoot,
    source.data,
    input.overwrite ?? false,
  );
  return {
    bytes: source.data.length,
    sha256,
    source: source.source,
    sourceHost: source.sourceHost,
  };
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > Math.ceil((MAX_PNG_IMPORT_BYTES * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("base64Data is not valid standard Base64 PNG data.");
  }
  const data = Buffer.from(value, "base64");
  if (data.length > MAX_PNG_IMPORT_BYTES) {
    throw new Error(`PNG exceeds the ${MAX_PNG_IMPORT_BYTES} byte limit.`);
  }
  return data;
}

async function downloadPng(sourceUrl: string): Promise<{
  data: Buffer;
  source: "https";
  sourceHost: string;
}> {
  let current = parsePublicHttpsUrl(sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHostname(current.hostname);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { accept: "image/png,application/octet-stream;q=0.8" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `PNG download redirect ${response.status} had no location.`,
        );
      }
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`PNG download exceeded ${MAX_REDIRECTS} redirects.`);
      }
      current = parsePublicHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`PNG download failed with HTTP ${response.status}.`);
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType &&
      contentType !== "image/png" &&
      contentType !== "application/octet-stream"
    ) {
      throw new Error(
        `PNG download returned unsupported content type ${contentType}.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_PNG_IMPORT_BYTES
    ) {
      throw new Error(`PNG exceeds the ${MAX_PNG_IMPORT_BYTES} byte limit.`);
    }

    const data = await readLimitedBody(response);
    return {
      data,
      source: "https",
      sourceHost: current.hostname,
    };
  }

  throw new Error("PNG download did not complete.");
}

function parsePublicHttpsUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("sourceUrl must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("sourceUrl must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("sourceUrl must not contain embedded credentials.");
  }
  return parsed;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("sourceUrl must resolve to a public Internet host.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error(
      "sourceUrl must resolve only to public Internet addresses.",
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

async function readLimitedBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("PNG download returned an empty body.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PNG_IMPORT_BYTES) {
      throw new Error(`PNG exceeds the ${MAX_PNG_IMPORT_BYTES} byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function assertPng(data: Buffer): void {
  if (
    data.length < PNG_SIGNATURE.length ||
    !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Imported data is not a PNG file.");
  }
}

async function writeAtomicPng(
  destination: string,
  workspaceRoot: string,
  data: Buffer,
  overwrite: boolean,
): Promise<void> {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedDestination = resolve(destination);
  if (!isPathInsideRoot(resolvedDestination, resolvedRoot)) {
    throw new Error("Destination is outside the workspace root.");
  }

  const realRoot = await realpath(resolvedRoot);
  const parent = dirname(resolvedDestination);
  await assertNearestExistingAncestorInside(parent, realRoot);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!isPathInsideRoot(realParent, realRoot)) {
    throw new Error("Destination parent resolves outside the workspace root.");
  }

  try {
    const target = await lstat(resolvedDestination);
    if (target.isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link destination.");
    }
    if (!overwrite) {
      throw new Error(
        "Destination already exists; set overwrite=true to replace it.",
      );
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  const temporary = `${resolvedDestination}.devspace-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (overwrite) {
      await rename(temporary, resolvedDestination);
    } else {
      await link(temporary, resolvedDestination);
      await unlink(temporary);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isAlreadyExistsError(error)) {
      throw new Error(
        "Destination already exists; set overwrite=true to replace it.",
      );
    }
    throw error;
  }
}

async function assertNearestExistingAncestorInside(
  path: string,
  realRoot: string,
): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const existing = await realpath(current);
      if (!isPathInsideRoot(existing, realRoot)) {
        throw new Error(
          "Destination path resolves outside the workspace root.",
        );
      }
      return;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve a safe destination parent.");
    }
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
