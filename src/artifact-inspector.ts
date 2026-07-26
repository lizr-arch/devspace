import { createHash } from "node:crypto";
import { createReadStream, openSync, closeSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import {
  ArtifactLedger,
  MAX_HASHABLE_ARTIFACT_BYTES,
  type ArtifactRecord,
} from "./artifact-ledger.js";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";

export interface ArtifactInspection {
  path: string;
  artifactId?: string;
  registered: boolean;
  format: string;
  mimeType: string;
  size: number;
  sha256: string;
  gitStatus?: string;
  metadata: Record<string, unknown>;
}

export async function inspectArtifact(input: {
  ledger: ArtifactLedger;
  workspaceId: string;
  workspaceRoot: string;
  artifactId?: string;
  path?: string;
}): Promise<ArtifactInspection> {
  if (Boolean(input.artifactId) === Boolean(input.path)) {
    throw new Error(
      "ASSET_INPUT_INVALID: Provide exactly one of artifactId or path.",
    );
  }
  let absolutePath: string;
  let relativePath: string;
  let record: ArtifactRecord | undefined;
  if (input.artifactId) {
    const verified = await input.ledger.resolveArtifact({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      artifactId: input.artifactId,
    });
    absolutePath = verified.absolutePath;
    relativePath = verified.artifact.relativePath;
    record = verified.artifact;
  } else {
    const resolved = resolveExistingWorkspacePath(
      input.workspaceRoot,
      input.path ?? "",
      "file",
    );
    absolutePath = resolved.absolutePath;
    relativePath = resolved.relativePath;
    const matching = await input.ledger.listArtifacts({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      pathPrefix: relativePath,
      limit: 20,
    });
    record = matching.find(
      (candidate) =>
        candidate.relativePath === relativePath &&
        candidate.presence === "present",
    );
  }
  const info = statSync(absolutePath);
  if (info.size > MAX_HASHABLE_ARTIFACT_BYTES) {
    throw new Error(
      `ASSET_TOO_LARGE: ${relativePath} exceeds ${MAX_HASHABLE_ARTIFACT_BYTES} bytes.`,
    );
  }
  const header = readHeader(absolutePath, Math.min(info.size, 256 * 1024));
  const format = inspectFormat(relativePath, header);
  const digest = await sha256File(absolutePath);
  if (record && (record.size !== info.size || record.sha256 !== digest)) {
    record = undefined;
  }
  return {
    path: relativePath,
    artifactId: record?.artifactId,
    registered: Boolean(record),
    format: format.format,
    mimeType: format.mimeType,
    size: info.size,
    sha256: digest,
    gitStatus: record?.gitStatus,
    metadata: format.metadata,
  };
}

function inspectFormat(
  path: string,
  data: Buffer,
): { format: string; mimeType: string; metadata: Record<string, unknown> } {
  switch (extname(path).toLowerCase()) {
    case ".png":
      assertBytes(data, "PNG", 24);
      if (
        !data.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
      )
        rejected("PNG");
      return {
        format: "PNG",
        mimeType: "image/png",
        metadata: {
          width: data.readUInt32BE(16),
          height: data.readUInt32BE(20),
          bitDepth: data[24],
          colorType: data[25],
        },
      };
    case ".jpg":
    case ".jpeg": {
      const dimensions = jpegDimensions(data);
      return {
        format: "JPEG",
        mimeType: "image/jpeg",
        metadata: dimensions,
      };
    }
    case ".webp":
      return {
        format: "WEBP",
        mimeType: "image/webp",
        metadata: webpDimensions(data),
      };
    case ".glb":
      assertBytes(data, "GLB", 20);
      if (data.subarray(0, 4).toString("ascii") !== "glTF") rejected("GLB");
      return {
        format: "GLB",
        mimeType: "model/gltf-binary",
        metadata: {
          version: data.readUInt32LE(4),
          declaredLength: data.readUInt32LE(8),
          firstChunkLength: data.readUInt32LE(12),
          firstChunkType: data.subarray(16, 20).toString("ascii"),
        },
      };
    case ".blend":
      assertBytes(data, "BLEND", 12);
      if (data.subarray(0, 7).toString("ascii") !== "BLENDER") rejected("BLEND");
      return {
        format: "BLEND",
        mimeType: "application/x-blender",
        metadata: {
          pointerSize: String.fromCharCode(data[7]) === "-" ? 8 : 4,
          endianness: String.fromCharCode(data[8]) === "v" ? "little" : "big",
          version: data.subarray(9, 12).toString("ascii"),
        },
      };
    case ".wav":
      assertBytes(data, "WAV", 44);
      if (
        data.subarray(0, 4).toString("ascii") !== "RIFF" ||
        data.subarray(8, 12).toString("ascii") !== "WAVE"
      )
        rejected("WAV");
      return {
        format: "WAV",
        mimeType: "audio/wav",
        metadata: wavMetadata(data),
      };
    case ".ogg":
      assertBytes(data, "OGG", 27);
      if (data.subarray(0, 4).toString("ascii") !== "OggS") rejected("OGG");
      return {
        format: "OGG",
        mimeType: "audio/ogg",
        metadata: oggMetadata(data),
      };
    default:
      throw new Error("ASSET_FORMAT_REJECTED: Unsupported artifact extension.");
  }
}

function jpegDimensions(data: Buffer): Record<string, unknown> {
  assertBytes(data, "JPEG", 4);
  if (data[0] !== 0xff || data[1] !== 0xd8) rejected("JPEG");
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9].includes(marker)) {
      return {
        width: data.readUInt16BE(offset + 7),
        height: data.readUInt16BE(offset + 5),
        precision: data[offset + 4],
        components: data[offset + 9],
      };
    }
    if (offset + 4 > data.length) break;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  throw new Error("ASSET_FORMAT_REJECTED: JPEG dimensions were not found.");
}

function webpDimensions(data: Buffer): Record<string, unknown> {
  assertBytes(data, "WEBP", 30);
  if (
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WEBP"
  )
    rejected("WEBP");
  const chunk = data.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
      extended: true,
    };
  }
  return { codecChunk: chunk };
}

function wavMetadata(data: Buffer): Record<string, unknown> {
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + size <= data.length && size >= 16) {
      return {
        codec: data.readUInt16LE(offset + 8),
        channels: data.readUInt16LE(offset + 10),
        sampleRate: data.readUInt32LE(offset + 12),
        byteRate: data.readUInt32LE(offset + 16),
        bitsPerSample: data.readUInt16LE(offset + 22),
      };
    }
    offset += 8 + size + (size % 2);
  }
  return {};
}

function oggMetadata(data: Buffer): Record<string, unknown> {
  const vorbis = data.indexOf(Buffer.from("vorbis"));
  if (vorbis >= 1 && vorbis + 15 < data.length) {
    return {
      codec: "vorbis",
      channels: data[vorbis + 10],
      sampleRate: data.readUInt32LE(vorbis + 11),
    };
  }
  if (data.indexOf(Buffer.from("OpusHead")) >= 0) return { codec: "opus" };
  return {};
}

function readHeader(path: string, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(path, "r");
  try {
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function assertBytes(data: Buffer, format: string, minimum: number): void {
  if (data.length < minimum) {
    throw new Error(`ASSET_FORMAT_REJECTED: ${format} is truncated.`);
  }
}

function rejected(format: string): never {
  throw new Error(`ASSET_FORMAT_REJECTED: File is not ${format}.`);
}
