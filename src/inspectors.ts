import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { parseFile } from "music-metadata";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";
import { RunnerRegistry } from "./runner-registry.js";

const MAX_ITEMS = 500;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_DIMENSION = 2048;
const PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_KILL_GRACE_MS = 1_000;
export const MAX_GLB_INSPECT_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_INSPECT_BYTES = 256 * 1024 * 1024;
export const MAX_BLEND_INSPECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GLB_JSON_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 30 * 60;
const MAX_DECODED_AUDIO_SAMPLES = 100_000_000;

export interface InspectAudioOptions {
  ffmpegPath?: string;
  timeoutMs?: number;
  maxDecodedSamples?: number;
}

export interface InspectorResult {
  path: string;
  sha256: string;
  size: number;
  truncated: boolean;
  [key: string]: unknown;
}

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

export class ExternalInspectorManager {
  private readonly evidenceDir: string;
  private readonly scriptDir: string;

  constructor(
    private readonly stateDir: string,
    private readonly runners = new RunnerRegistry(),
  ) {
    this.evidenceDir = join(stateDir, "inspector-evidence");
    this.scriptDir = join(stateDir, "inspectors");
  }

  async inspectBlend(
    workspaceRoot: string,
    path: string,
  ): Promise<InspectorResult> {
    const source = resolveExistingWorkspacePath(workspaceRoot, path, "file");
    if (extname(source.relativePath).toLowerCase() !== ".blend") {
      throw new Error("INSPECTOR_FORMAT_REJECTED: Expected a BLEND file.");
    }
    const size = assertInspectorFileSize(
      source.absolutePath,
      MAX_BLEND_INSPECT_BYTES,
      "BLEND",
    );
    const originalSha256 = await sha256File(source.absolutePath);
    const output = this.privateOutput("blend-inspection", ".json");
    const script = this.writeScript("inspect_blend.py", BLEND_INSPECTOR);
    const runner = await this.runners
      .resolve("blender")
      .catch(() => unavailable("Blender"));
    await runFixed(
      runner.executable,
      [
        "--background",
        "--disable-autoexec",
        "--offline-mode",
        source.absolutePath,
        "--python-exit-code",
        "23",
        "--python",
        script,
        "--",
        output,
      ],
      this.stateDir,
    );
    if (!existsSync(output)) {
      throw new Error("INSPECTOR_FAILED: Blender returned no inspection.");
    }
    const data = JSON.parse(readFileSync(output, "utf8")) as Record<
      string,
      unknown
    >;
    if ((await sha256File(source.absolutePath)) !== originalSha256) {
      throw new Error("INSPECTOR_SOURCE_MUTATED");
    }
    return boundedResult({
      path: source.relativePath,
      sha256: originalSha256,
      size,
      ...data,
    });
  }

  async renderModelPreview(input: {
    workspaceRoot: string;
    path: string;
    view?: "perspective" | "front" | "right" | "top";
    width?: number;
    height?: number;
  }): Promise<{
    path: string;
    view: string;
    width: number;
    height: number;
    sha256: string;
    bytes: number;
    data: string;
  }> {
    const source = resolveExistingWorkspacePath(
      input.workspaceRoot,
      input.path,
      "file",
    );
    const extension = extname(source.relativePath).toLowerCase();
    if (![".blend", ".glb"].includes(extension)) {
      throw new Error("INSPECTOR_FORMAT_REJECTED: Expected BLEND or GLB.");
    }
    const width = previewDimension(input.width ?? 512);
    const height = previewDimension(input.height ?? 512);
    const view = input.view ?? "perspective";
    const output = this.privateOutput("model-preview", ".png");
    assertInspectorFileSize(
      source.absolutePath,
      extension === ".glb" ? MAX_GLB_INSPECT_BYTES : MAX_BLEND_INSPECT_BYTES,
      extension === ".glb" ? "GLB" : "BLEND",
    );
    const sourceBefore = await sha256File(source.absolutePath);
    if (extension === ".glb") {
      await this.renderGlbWithGodot(
        source.absolutePath,
        output,
        view,
        width,
        height,
      );
    } else {
      const script = this.writeScript("render_model.py", MODEL_RENDERER);
      const runner = await this.runners
        .resolve("blender")
        .catch(() => unavailable("Blender"));
      await runFixed(
        runner.executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "23",
          "--python",
          script,
          "--",
          source.absolutePath,
          output,
          view,
          String(width),
          String(height),
        ],
        this.stateDir,
      );
    }
    if ((await sha256File(source.absolutePath)) !== sourceBefore) {
      throw new Error("INSPECTOR_SOURCE_MUTATED");
    }
    const bytes = readFileSync(output);
    if (
      bytes.length < 8 ||
      bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a"
    ) {
      throw new Error("INSPECTOR_PREVIEW_FAILED");
    }
    return {
      path: source.relativePath,
      view,
      width,
      height,
      sha256: sha256(bytes),
      bytes: bytes.length,
      data: bytes.toString("base64"),
    };
  }

  private writeScript(name: string, content: string): string {
    mkdirSync(this.scriptDir, { recursive: true, mode: 0o700 });
    const path = join(this.scriptDir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  private async renderGlbWithGodot(
    source: string,
    output: string,
    view: string,
    width: number,
    height: number,
  ): Promise<void> {
    const project = join(this.evidenceDir, `godot-preview-${randomUUID()}`);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    copyFileSync(source, join(project, "model.glb"));
    writeFileSync(
      join(project, "project.godot"),
      `[application]\nconfig/name="DevSpace Model Preview"\n[display]\nwindow/size/viewport_width=${width}\nwindow/size/viewport_height=${height}\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`,
      { mode: 0o600 },
    );
    const script = join(project, "preview.gd");
    writeFileSync(script, GODOT_MODEL_PREVIEW, { mode: 0o600 });
    const runner = await this.runners
      .resolve("godot")
      .catch(async () =>
        this.runners.resolve("godot-mono").catch(() => unavailable("Godot")),
      );
    await runFixed(
      runner.executable,
      ["--headless", "--editor", "--path", project, "--quit-after", "3"],
      project,
    );
    await runFixed(
      runner.executable,
      [
        "--path",
        project,
        "--resolution",
        `${width}x${height}`,
        "--script",
        script,
      ],
      project,
      {
        DEVSPACE_PREVIEW_OUTPUT: output,
        DEVSPACE_PREVIEW_VIEW: view,
      },
    );
  }

  private privateOutput(prefix: string, extension: string): string {
    mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    chmodSync(this.evidenceDir, 0o700);
    return join(this.evidenceDir, `${prefix}_${randomUUID()}${extension}`);
  }
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

function terminateInspectorProcess(child: ReturnType<typeof spawn>): void {
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, value);
      } else {
        child.kill(value);
      }
    } catch {
      // Already exited.
    }
  };
  signal("SIGTERM");
  const killHandle = setTimeout(() => signal("SIGKILL"), PROCESS_KILL_GRACE_MS);
  killHandle.unref();
}

function locateFfmpeg(): string | undefined {
  const candidates = [
    join(homedir(), ".local", "bin", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function runFixed(
  executable: string,
  args: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("INSPECTOR_TIMEOUT"));
    }, PROCESS_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-64 * 1024);
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`INSPECTOR_FAILED: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`INSPECTOR_FAILED: ${output || `exit ${code}`}`));
    });
  });
}

function boundedResult(value: Record<string, unknown>): InspectorResult {
  let truncated = false;
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length > MAX_ITEMS) {
      value[key] = entry.slice(0, MAX_ITEMS);
      truncated = true;
    }
  }
  const result = { ...value, truncated } as InspectorResult;
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
    throw new Error("INSPECTOR_OUTPUT_TOO_LARGE");
  }
  return result;
}

function assertInspectorFileSize(
  path: string,
  maxBytes: number,
  label: string,
): number {
  const info = statSync(path);
  if (!info.isFile()) {
    throw new Error("INSPECTOR_FORMAT_REJECTED: Expected a regular file.");
  }
  if (info.size > maxBytes) {
    throw new Error(
      `INSPECTOR_INPUT_TOO_LARGE: ${label} exceeds ${maxBytes} bytes.`,
    );
  }
  return info.size;
}

function readExactly(
  fileDescriptor: number,
  length: number,
  position: number,
): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(
      fileDescriptor,
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (read === 0) {
      throw new Error("INSPECTOR_CONTAINER_INVALID: Unexpected end of file.");
    }
    offset += read;
  }
  return bytes;
}

function sha256FileDescriptor(fileDescriptor: number, size: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const read = readSync(
      fileDescriptor,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position,
    );
    if (read === 0) {
      throw new Error("INSPECTOR_CONTAINER_INVALID: Unexpected end of file.");
    }
    hash.update(chunk.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 1024) : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function previewDimension(value: number): number {
  if (!Number.isInteger(value) || value < 64 || value > MAX_PREVIEW_DIMENSION) {
    throw new Error("INSPECTOR_PREVIEW_SIZE_INVALID");
  }
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(name: string): never {
  throw new Error(`INSPECTOR_UNAVAILABLE: ${name} is unavailable.`);
}

const BLEND_INSPECTOR = String.raw`import bpy, json, math, os, sys
from mathutils import Vector
output = sys.argv[sys.argv.index("--") + 1]
objects = []
absolute_paths = []
missing = []
for obj in bpy.data.objects:
    bound = [list(obj.matrix_world @ Vector(corner)) for corner in obj.bound_box] if obj.type == "MESH" else []
    scale = list(obj.scale)
    objects.append({"name": obj.name, "type": obj.type, "scale": scale, "bounds": bound[:8],
        "warning": "extreme_scale" if min(abs(v) for v in scale) < 0.0001 or max(abs(v) for v in scale) > 10000 else
        "non_uniform_scale" if min(abs(v) for v in scale) > 0 and max(abs(v) for v in scale) / min(abs(v) for v in scale) > 100 else None})
for image in bpy.data.images:
    path = bpy.path.abspath(image.filepath) if image.filepath else ""
    if path and os.path.isabs(image.filepath): absolute_paths.append(image.filepath)
    if path and not os.path.exists(path): missing.append(image.filepath)
dependencies = [lib.filepath for lib in bpy.data.libraries] + [image.filepath for image in bpy.data.images if image.filepath]
meshes = [{"name": m.name, "vertices": len(m.vertices), "polygons": len(m.polygons),
    "triangles": sum(max(0, len(p.vertices)-2) for p in m.polygons)} for m in bpy.data.meshes]
actions = [{"name": a.name, "durationFrames": a.frame_range[1]-a.frame_range[0],
    "durationSeconds": (a.frame_range[1]-a.frame_range[0]) / max(1, bpy.context.scene.render.fps)} for a in bpy.data.actions]
result = {"blenderVersion": bpy.app.version_string, "objectCount": len(bpy.data.objects),
 "collectionCount": len(bpy.data.collections), "meshCount": len(bpy.data.meshes),
 "materialCount": len(bpy.data.materials), "imageCount": len(bpy.data.images),
 "armatureCount": len(bpy.data.armatures), "boneCount": sum(len(a.bones) for a in bpy.data.armatures),
 "objects": objects[:500], "meshes": meshes[:500], "collections": [c.name for c in bpy.data.collections][:500],
 "materials": [m.name for m in bpy.data.materials][:500], "images": [i.filepath for i in bpy.data.images][:500],
 "dependencies": dependencies[:500],
 "absolutePaths": absolute_paths[:500], "missingTextures": missing[:500], "actions": actions[:500],
 "truncated": any(len(x)>500 for x in [bpy.data.objects,bpy.data.meshes,bpy.data.collections,bpy.data.materials,bpy.data.images,bpy.data.actions])}
with open(output, "w", encoding="utf8") as f: json.dump(result, f)
`;

const MODEL_RENDERER = String.raw`import bpy, math, os, sys
from mathutils import Vector
source, output, view, width, height = sys.argv[sys.argv.index("--")+1:sys.argv.index("--")+6]
if source.lower().endswith(".glb"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes: raise RuntimeError("No mesh objects")
points = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
minimum = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
maximum = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (minimum + maximum) / 2
radius = max((maximum-minimum).length / 2, 0.01)
bpy.ops.object.camera_add()
camera = bpy.context.object
directions = {"front": Vector((0,-1,0)), "right": Vector((1,0,0)), "top": Vector((0,0,1)), "perspective": Vector((1,-1,0.75)).normalized()}
camera.location = center + directions[view] * radius * 3
camera.rotation_euler = (center-camera.location).to_track_quat("-Z","Y").to_euler()
camera.data.type = "ORTHO" if view != "perspective" else "PERSP"
camera.data.ortho_scale = radius * 2.5
bpy.context.scene.camera = camera
for direction, energy in [((4,-4,6),1200),((-3,2,2),500)]:
    bpy.ops.object.light_add(type="AREA", location=center+Vector(direction)*radius)
    bpy.context.object.data.energy=energy; bpy.context.object.data.shape="DISK"; bpy.context.object.data.size=radius*2
bpy.context.scene.world = bpy.context.scene.world or bpy.data.worlds.new("DevSpaceWorld")
bpy.context.scene.world.color=(0.035,0.035,0.05)
scene=bpy.context.scene
scene.render.engine="BLENDER_EEVEE"
scene.render.resolution_x=int(width); scene.render.resolution_y=int(height); scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"; scene.render.filepath=output; scene.render.film_transparent=False
bpy.ops.render.render(write_still=True)
`;

const GODOT_MODEL_PREVIEW = String.raw`extends SceneTree

func _initialize() -> void:
	_render.call_deferred()

func _render() -> void:
	var packed = load("res://model.glb")
	if packed == null or not packed is PackedScene:
		push_error("INSPECTOR_PREVIEW_IMPORT_FAILED")
		quit(23)
		return
	var model = packed.instantiate()
	root.add_child(model)
	var bounds := AABB()
	var found := false
	for node in model.find_children("*", "MeshInstance3D", true, false):
		var local: AABB = node.get_aabb()
		var world: AABB = node.global_transform * local
		bounds = world if not found else bounds.merge(world)
		found = true
	if not found:
		push_error("INSPECTOR_PREVIEW_NO_MESH")
		quit(23)
		return
	var center = bounds.get_center()
	var radius = max(bounds.size.length() * 0.5, 0.01)
	var world_environment := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.035, 0.035, 0.05)
	world_environment.environment = environment
	root.add_child(world_environment)
	var camera := Camera3D.new()
	var directions = {
		"front": Vector3(0, 0, 1),
		"right": Vector3(1, 0, 0),
		"top": Vector3(0, 1, 0),
		"perspective": Vector3(1, 0.75, 1).normalized()
	}
	var view = OS.get_environment("DEVSPACE_PREVIEW_VIEW")
	camera.position = center + directions.get(view, directions.perspective) * radius * 3.0
	camera.look_at(center, Vector3.UP if view != "top" else Vector3.FORWARD)
	if view != "perspective":
		camera.projection = Camera3D.PROJECTION_ORTHOGONAL
		camera.size = radius * 2.5
	root.add_child(camera)
	for rotation in [Vector3(-0.7, -0.7, 0), Vector3(0.5, 2.4, 0)]:
		var light := DirectionalLight3D.new()
		light.rotation = rotation
		light.light_energy = 1.2 if rotation.x < 0 else 0.5
		root.add_child(light)
	await process_frame
	await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	var error = image.save_png(OS.get_environment("DEVSPACE_PREVIEW_OUTPUT"))
	quit(0 if error == OK else 23)
`;
