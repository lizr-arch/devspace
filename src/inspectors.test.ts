import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExternalInspectorManager,
  MAX_AUDIO_INSPECT_BYTES,
  MAX_GLB_INSPECT_BYTES,
  inspectAudio,
  inspectGlb,
} from "./inspectors.js";
import { RunnerRegistry } from "./runner-registry.js";

const root = await mkdtemp(join(tmpdir(), "devspace-inspectors-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-inspectors-state-"));
await mkdir(join(root, "fixtures"), { recursive: true });
try {
  const minimalGlb = makeGlb({
    asset: { version: "2.0" },
    nodes: [{ name: "Triangle", mesh: 0 }],
    meshes: [
      {
        name: "KnownMesh",
        primitives: [{ attributes: { POSITION: 0 }, mode: 4 }],
      },
    ],
    accessors: [
      {
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-1, -2, -3],
        max: [1, 2, 3],
      },
    ],
    materials: [{ name: "KnownMaterial" }],
    images: [{ uri: "/missing/absolute.png" }],
    animations: [],
  });
  await writeFile(join(root, "fixtures", "minimal.glb"), minimalGlb);
  const glb = inspectGlb(root, "fixtures/minimal.glb");
  assert.equal(glb.sha256, digest(minimalGlb));
  assert.equal(glb.nodeCount, 1);
  assert.equal(glb.meshCount, 1);
  assert.equal(glb.triangleCount, 1);
  assert.deepEqual(
    (glb.accessorBounds as { min: number[]; max: number[] }[])[0],
    {
      index: 0,
      count: 3,
      type: "VEC3",
      min: [-1, -2, -3],
      max: [1, 2, 3],
    },
  );
  assert.equal((glb.dependencies as { absolute: boolean }[])[0].absolute, true);
  await writeFile(join(root, "fixtures", "broken.glb"), "not glb");
  assert.throws(
    () => inspectGlb(root, "fixtures/broken.glb"),
    /INSPECTOR_CONTAINER_INVALID/,
  );
  const oversizedGlbPath = join(root, "fixtures", "oversized.glb");
  const oversizedGlb = await open(oversizedGlbPath, "w");
  try {
    await oversizedGlb.truncate(MAX_GLB_INSPECT_BYTES + 1);
  } finally {
    await oversizedGlb.close();
  }
  assert.throws(
    () => inspectGlb(root, "fixtures/oversized.glb"),
    /INSPECTOR_INPUT_TOO_LARGE/,
  );

  const wav = makeWav([0, 0.5, 1, -1, 0.25, -0.25], 8000);
  await writeFile(join(root, "fixtures", "known.wav"), wav);
  await convertOgg(
    join(root, "fixtures", "known.wav"),
    join(root, "fixtures", "known.ogg"),
  );
  const audio = await inspectAudio(root, "fixtures/known.wav");
  assert.equal(audio.sampleRate, 8000);
  assert.equal(audio.channels, 1);
  assert.ok(Number(audio.absolutePeak) > 0.99);
  assert.equal(audio.fullScaleSamples, 1);
  assert.ok(Number(audio.clippingRatio) > 0);
  const ogg = await inspectAudio(root, "fixtures/known.ogg");
  assert.equal(ogg.format, "ogg");
  assert.ok(Number(ogg.durationSeconds) > 0);
  const oversizedWavPath = join(root, "fixtures", "oversized.wav");
  const oversizedWav = await open(oversizedWavPath, "w");
  try {
    await oversizedWav.write(wav.subarray(0, 12), 0, 12, 0);
    await oversizedWav.truncate(MAX_AUDIO_INSPECT_BYTES + 1);
  } finally {
    await oversizedWav.close();
  }
  await assert.rejects(
    inspectAudio(root, "fixtures/oversized.wav"),
    /INSPECTOR_INPUT_TOO_LARGE/,
  );

  const sampleLimitFfmpeg = join(stateDir, "sample-limit-ffmpeg");
  await writeFile(
    sampleLimitFfmpeg,
    "#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(4096));\n",
  );
  await chmod(sampleLimitFfmpeg, 0o755);
  await assert.rejects(
    inspectAudio(root, "fixtures/known.wav", {
      ffmpegPath: sampleLimitFfmpeg,
      maxDecodedSamples: 10,
    }),
    /INSPECTOR_DECODE_LIMIT/,
  );

  const timeoutPidPath = join(stateDir, "timeout-ffmpeg.pid");
  const timeoutFfmpeg = join(stateDir, "timeout-ffmpeg");
  await writeFile(
    timeoutFfmpeg,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(timeoutPidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
  );
  await chmod(timeoutFfmpeg, 0o755);
  await assert.rejects(
    inspectAudio(root, "fixtures/known.wav", {
      ffmpegPath: timeoutFfmpeg,
      timeoutMs: 500,
    }),
    /INSPECTOR_TIMEOUT/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const timeoutPid = Number(await readFile(timeoutPidPath, "utf8"));
  assert.equal(isProcessAlive(timeoutPid), false);

  const runners = new RunnerRegistry();
  const blender = await runners.resolve("blender");
  const generator = join(stateDir, "create_fixture.py");
  await writeFile(
    generator,
    `import bpy, os, sys
blend_path, glb_path = sys.argv[sys.argv.index("--")+1:sys.argv.index("--")+3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj=bpy.context.object
obj.name="KnownCube"
obj.scale=(1,2,3)
obj.keyframe_insert(data_path="location", frame=1)
obj.location.x=2
obj.keyframe_insert(data_path="location", frame=25)
image=bpy.data.images.new("MissingTexture", width=2, height=2)
image.filepath="/missing/absolute-texture.png"
material=bpy.data.materials.new("KnownMaterial")
material.use_nodes=True
texture=material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image=image
obj.data.materials.append(material)
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB")
`,
  );
  await run(blender.executable, [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--offline-mode",
    "--python-exit-code",
    "23",
    "--python",
    generator,
    "--",
    join(root, "fixtures", "known.blend"),
    join(root, "fixtures", "known-model.glb"),
  ]);
  const manager = new ExternalInspectorManager(stateDir, runners);
  const blendBefore = digest(
    await readFile(join(root, "fixtures", "known.blend")),
  );
  const blend = await manager.inspectBlend(root, "fixtures/known.blend");
  assert.equal(blend.objectCount, 1);
  assert.equal(blend.meshCount, 1);
  assert.ok(Number(blend.boneCount) === 0);
  assert.ok(
    (blend.missingTextures as string[]).includes(
      "/missing/absolute-texture.png",
    ),
  );
  assert.ok((blend.actions as unknown[]).length >= 1);
  assert.equal(
    digest(await readFile(join(root, "fixtures", "known.blend"))),
    blendBefore,
  );
  const preview = await manager.renderModelPreview({
    workspaceRoot: root,
    path: "fixtures/known.blend",
    view: "front",
    width: 256,
    height: 192,
  });
  assert.equal(preview.width, 256);
  assert.equal(preview.height, 192);
  assert.match(preview.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(pngDimensions(Buffer.from(preview.data, "base64")), {
    width: 256,
    height: 192,
  });
  const glbBefore = digest(
    await readFile(join(root, "fixtures", "known-model.glb")),
  );
  const modelPreview = await manager.renderModelPreview({
    workspaceRoot: root,
    path: "fixtures/known-model.glb",
    view: "perspective",
    width: 128,
    height: 128,
  });
  assert.ok(modelPreview.bytes > 100);
  assert.deepEqual(pngDimensions(Buffer.from(modelPreview.data, "base64")), {
    width: 128,
    height: 128,
  });
  assert.equal(
    digest(await readFile(join(root, "fixtures", "known-model.glb"))),
    glbBefore,
  );
  console.log("inspector tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

function makeGlb(document: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const padding = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const result = Buffer.alloc(20 + chunk.length);
  result.write("glTF", 0, "ascii");
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(chunk.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(result, 20);
  return result;
}

function makeWav(samples: number[], sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) =>
    data.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
      index * 2,
    ),
  );
  const result = Buffer.alloc(44 + data.length);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(data.length, 40);
  data.copy(result, 44);
  return result;
}

async function convertOgg(source: string, destination: string): Promise<void> {
  await run(join(process.env.HOME ?? "", ".local", "bin", "ffmpeg"), [
    "-nostdin",
    "-v",
    "error",
    "-i",
    source,
    "-c:a",
    "libvorbis",
    destination,
  ]);
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { maxBuffer: 8 * 1024 * 1024 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
