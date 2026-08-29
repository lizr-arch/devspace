import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
} from "node:fs";
import { extname } from "node:path";
import { parseFile } from "music-metadata";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";
import {
  type InspectAudioOptions,
  type InspectorResult,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_INSPECT_BYTES,
  MAX_DECODED_AUDIO_SAMPLES,
  MAX_GLB_INSPECT_BYTES,
  MAX_GLB_JSON_BYTES,
  PROCESS_TIMEOUT_MS,
  arrayOfRecords,
  assertInspectorFileSize,
  boundedResult,
  integerOrNull,
  locateFfmpeg,
  numberValue,
  numericArray,
  readExactly,
  recordValue,
  sha256File,
  sha256FileDescriptor,
  stringValue,
  terminateInspectorProcess,
  unavailable,
} from "./inspectors-common.js";

export {
  MAX_GLB_INSPECT_BYTES,
  MAX_AUDIO_INSPECT_BYTES,
  MAX_BLEND_INSPECT_BYTES,
  type InspectAudioOptions,
  type InspectorResult,
} from "./inspectors-common.js";

export { ExternalInspectorManager } from "./inspectors-external.js";

export function inspectGlb(
  workspaceRoot: string,
  path: string,
): InspectorResult {
  const source = resolveExistingWorkspacePath(workspaceRoot, path, "file");
  const fileSize = assertInspectorFileSize(
    source.absolutePath,
    MAX_GLB_INSPECT_BYTES,
    "GLB",
  );
  const handle = openSync(source.absolutePath, "r");
  let jsonBytes: Buffer;
  let fileSha256: string;
  try {
    const header = readExactly(handle, 20, 0);
    if (
      fileSize < 20 ||
      header.toString("ascii", 0, 4) !== "glTF" ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== fileSize
    ) {
      throw new Error("INSPECTOR_CONTAINER_INVALID: Invalid GLB v2 header.");
    }
    const jsonLength = header.readUInt32LE(12);
    const jsonType = header.readUInt32LE(16);
    if (jsonLength > MAX_GLB_JSON_BYTES) {
      throw new Error(
        `INSPECTOR_INPUT_TOO_LARGE: GLB JSON chunk exceeds ${MAX_GLB_JSON_BYTES} bytes.`,
      );
    }
    if (
      jsonType !== 0x4e4f534a ||
      jsonLength < 2 ||
      20 + jsonLength > fileSize
    ) {
      throw new Error("INSPECTOR_CONTAINER_INVALID: Missing GLB JSON chunk.");
    }
    jsonBytes = readExactly(handle, jsonLength, 20);
    fileSha256 = sha256FileDescriptor(handle, fileSize);
  } finally {
    closeSync(handle);
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(jsonBytes.toString("utf8").trim()) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("INSPECTOR_CONTAINER_INVALID: Malformed GLB JSON.");
  }
  const nodes = arrayOfRecords(document.nodes);
  const meshes = arrayOfRecords(document.meshes);
  const accessors = arrayOfRecords(document.accessors);
  const materials = arrayOfRecords(document.materials);
  const textures = arrayOfRecords(document.textures);
  const images = arrayOfRecords(document.images);
  const skins = arrayOfRecords(document.skins);
  const animations = arrayOfRecords(document.animations);
  let primitiveCount = 0;
  let triangleCount = 0;
  for (const mesh of meshes) {
    for (const primitive of arrayOfRecords(mesh.primitives)) {
      primitiveCount++;
      const mode = numberValue(primitive.mode, 4);
      const index = numberValue(primitive.indices, -1);
      const attributes = recordValue(primitive.attributes);
      const position = numberValue(attributes.POSITION, -1);
      const count =
        index >= 0
          ? numberValue(accessors[index]?.count, 0)
          : numberValue(accessors[position]?.count, 0);
      if (mode === 4) triangleCount += Math.floor(count / 3);
      if (mode === 5 || mode === 6) triangleCount += Math.max(0, count - 2);
    }
  }
  const dependencies = [
    ...arrayOfRecords(document.buffers).map((entry) => entry.uri),
    ...images.map((entry) => entry.uri),
  ]
    .filter((uri): uri is string => typeof uri === "string")
    .map((uri) => ({
      uri: uri.slice(0, 2048),
      absolute: /^([A-Za-z]:[\\/]|\/)/.test(uri),
      dataUri: uri.startsWith("data:"),
    }));
  const animationSummaries = animations.map((animation) => {
    let durationSeconds = 0;
    for (const sampler of arrayOfRecords(animation.samplers)) {
      const accessor = accessors[numberValue(sampler.input, -1)];
      const maximum = Array.isArray(accessor?.max) ? accessor.max : [];
      durationSeconds = Math.max(
        durationSeconds,
        ...maximum.filter(
          (value): value is number => typeof value === "number",
        ),
      );
    }
    return {
      name: stringValue(animation.name),
      channels: arrayOfRecords(animation.channels).length,
      durationSeconds,
    };
  });
  return boundedResult({
    path: source.relativePath,
    sha256: fileSha256,
    size: fileSize,
    version: 2,
    nodeCount: nodes.length,
    meshCount: meshes.length,
    primitiveCount,
    triangleCount,
    materialCount: materials.length,
    textureCount: textures.length,
    skinCount: skins.length,
    nodes: nodes.map((node, index) => ({
      index,
      name: stringValue(node.name),
      mesh: integerOrNull(node.mesh),
      skin: integerOrNull(node.skin),
      children: Array.isArray(node.children) ? node.children.length : 0,
    })),
    meshes: meshes.map((mesh, index) => ({
      index,
      name: stringValue(mesh.name),
      primitives: arrayOfRecords(mesh.primitives).length,
    })),
    accessorBounds: accessors
      .map((accessor, index) => ({
        index,
        count: numberValue(accessor.count, 0),
        type: stringValue(accessor.type),
        min: numericArray(accessor.min),
        max: numericArray(accessor.max),
      }))
      .filter((entry) => entry.min.length || entry.max.length),
    materials: materials.map((material, index) => ({
      index,
      name: stringValue(material.name),
    })),
    skins: skins.map((skin, index) => ({
      index,
      name: stringValue(skin.name),
      joints: Array.isArray(skin.joints) ? skin.joints.length : 0,
    })),
    animations: animationSummaries,
    dependencies,
  });
}

export async function inspectAudio(
  workspaceRoot: string,
  path: string,
  options: InspectAudioOptions = {},
): Promise<InspectorResult> {
  const source = resolveExistingWorkspacePath(workspaceRoot, path, "file");
  const extension = extname(source.relativePath).toLowerCase();
  if (![".wav", ".ogg"].includes(extension)) {
    throw new Error("INSPECTOR_FORMAT_REJECTED: Audio must be WAV or OGG.");
  }
  const fileSize = assertInspectorFileSize(
    source.absolutePath,
    MAX_AUDIO_INSPECT_BYTES,
    "audio",
  );
  const handle = openSync(source.absolutePath, "r");
  let header: Buffer;
  try {
    header = readExactly(handle, 12, 0);
  } finally {
    closeSync(handle);
  }
  if (
    (extension === ".wav" &&
      !(
        header.toString("ascii", 0, 4) === "RIFF" &&
        header.toString("ascii", 8, 12) === "WAVE"
      )) ||
    (extension === ".ogg" && header.toString("ascii", 0, 4) !== "OggS")
  ) {
    throw new Error("INSPECTOR_CONTAINER_INVALID: Audio signature mismatch.");
  }
  const metadata = await parseFile(source.absolutePath, { duration: true });
  if (
    metadata.format.duration !== undefined &&
    metadata.format.duration > MAX_AUDIO_DURATION_SECONDS
  ) {
    throw new Error(
      `INSPECTOR_INPUT_TOO_LARGE: Audio duration exceeds ${MAX_AUDIO_DURATION_SECONDS} seconds.`,
    );
  }
  const analysis = await decodeAudio(source.absolutePath, options);
  return boundedResult({
    path: source.relativePath,
    sha256: await sha256File(source.absolutePath),
    size: fileSize,
    format: extension.slice(1),
    durationSeconds: metadata.format.duration,
    sampleRate: metadata.format.sampleRate,
    channels: metadata.format.numberOfChannels,
    codec: metadata.format.codec,
    bitrate: metadata.format.bitrate,
    ...analysis,
  });
}

async function decodeAudio(
  path: string,
  options: InspectAudioOptions,
): Promise<{
  absolutePeak: number;
  peakDbfs: number | null;
  fullScaleSamples: number;
  clippingRatio: number;
  analyzedSamples: number;
}> {
  const ffmpeg = options.ffmpegPath ?? locateFfmpeg();
  if (!ffmpeg) unavailable("ffmpeg");
  const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
  const maxDecodedSamples =
    options.maxDecodedSamples ?? MAX_DECODED_AUDIO_SAMPLES;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PROCESS_TIMEOUT_MS ||
    !Number.isInteger(maxDecodedSamples) ||
    maxDecodedSamples < 1 ||
    maxDecodedSamples > MAX_DECODED_AUDIO_SAMPLES
  ) {
    throw new Error("INSPECTOR_INPUT_INVALID: Invalid audio decode limits.");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        path,
        "-map_metadata",
        "-1",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
      ],
      {
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let carry = Buffer.alloc(0);
    let peak = 0;
    let samples = 0;
    let fullScale = 0;
    let errorOutput = "";
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("INSPECTOR_TIMEOUT"));
    }, timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.pause();
      terminateInspectorProcess(child);
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const data = Buffer.concat([carry, chunk]);
      const length = data.length - (data.length % 4);
      for (let offset = 0; offset < length; offset += 4) {
        const value = Math.abs(data.readFloatLE(offset));
        if (!Number.isFinite(value)) continue;
        peak = Math.max(peak, value);
        samples++;
        if (samples > maxDecodedSamples) {
          fail(
            new Error(
              `INSPECTOR_DECODE_LIMIT: Audio exceeds ${maxDecodedSamples} decoded samples.`,
            ),
          );
          return;
        }
        if (value >= 1) fullScale++;
      }
      carry = data.subarray(length);
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-16_384);
    });
    child.once("error", () => fail(unavailable("ffmpeg")));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `INSPECTOR_DECODE_FAILED: ${errorOutput || `ffmpeg exit ${code}`}`,
          ),
        );
        return;
      }
      resolve({
        absolutePeak: peak,
        peakDbfs: peak > 0 ? 20 * Math.log10(peak) : null,
        fullScaleSamples: fullScale,
        clippingRatio: samples ? fullScale / samples : 0,
        analyzedSamples: samples,
      });
    });
  });
}
