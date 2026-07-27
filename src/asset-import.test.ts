import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { importAsset } from "./asset-import.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function grayscalePng(value: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, value]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const REPLACEMENT_PNG = grayscalePng(127);

const root = await mkdtemp(join(tmpdir(), "devspace-asset-import-"));
try {
  const destination = join(root, "assets", "pixel.png");
  const imported = await importAsset({
    workspaceRoot: root,
    destination,
    base64Data: PNG.toString("base64"),
  });
  assert.equal(imported.format, "PNG");
  assert.equal(imported.outcome, "created");
  assert.equal(imported.path, "assets/pixel.png");
  assert.deepEqual(await readFile(destination), PNG);
  const unchanged = await importAsset({
    workspaceRoot: root,
    destination,
    base64Data: PNG.toString("base64"),
  });
  assert.equal(unchanged.outcome, "unchanged");
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination,
      base64Data: REPLACEMENT_PNG.toString("base64"),
    }),
    /ASSET_DESTINATION_CONFLICT/,
  );
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination: join(root, "assets", "pixel.glb"),
      base64Data: PNG.toString("base64"),
    }),
    /ASSET_FORMAT_REJECTED/,
  );
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  assert.equal(
    (
      await importAsset({
        workspaceRoot: root,
        destination: join(root, "assets", "silence.wav"),
        base64Data: wav.toString("base64"),
      })
    ).format,
    "WAV",
  );
  const glb = Buffer.alloc(12);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(12, 8);
  assert.equal(
    (
      await importAsset({
        workspaceRoot: root,
        destination: join(root, "assets", "empty.glb"),
        base64Data: glb.toString("base64"),
      })
    ).format,
    "GLB",
  );
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination: join(root, "assets", "wrong.png"),
      base64Data: PNG.toString("base64"),
      expectedSha256: "0".repeat(64),
    }),
    /ASSET_HASH_MISMATCH/,
  );
  const preserved = join(root, "assets", "preserved.png");
  const original = Buffer.concat([PNG, Buffer.from("original")]);
  await writeFile(preserved, original);
  let beforeCommitCalled = false;
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination: preserved,
      base64Data: PNG.toString("base64"),
      expectedSha256: "0".repeat(64),
      overwrite: true,
      beforeCommit: async () => {
        beforeCommitCalled = true;
      },
    }),
    /ASSET_HASH_MISMATCH/,
  );
  assert.equal(beforeCommitCalled, false);
  assert.deepEqual(await readFile(preserved), original);
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination: preserved,
      base64Data: REPLACEMENT_PNG.toString("base64"),
      overwrite: true,
      beforeCommit: async () => {
        throw new Error("snapshot failed");
      },
    }),
    /snapshot failed/,
  );
  assert.deepEqual(await readFile(preserved), original);
  const replaced = await importAsset({
    workspaceRoot: root,
    destination: preserved,
    base64Data: REPLACEMENT_PNG.toString("base64"),
    overwrite: true,
  });
  assert.equal(replaced.outcome, "replaced");
  assert.match(replaced.previousSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(preserved), REPLACEMENT_PNG);
  console.log("asset import tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
