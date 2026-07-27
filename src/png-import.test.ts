import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { importPng } from "./png-import.js";

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

function withIhdrDimensions(width: number, height: number): Buffer {
  const changed = Buffer.from(PNG);
  changed.writeUInt32BE(width, 16);
  changed.writeUInt32BE(height, 20);
  changed.writeUInt32BE(crc32(changed.subarray(12, 29)), 29);
  return changed;
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

const root = await mkdtemp(join(tmpdir(), "devspace-png-import-"));
try {
  const first = join(root, "raw", "candidate.png");
  const imported = await importPng({
    destination: first,
    workspaceRoot: root,
    base64Data: PNG.toString("base64"),
  });
  assert.equal(imported.bytes, PNG.length);
  assert.equal(imported.source, "base64");
  assert.equal(imported.outcome, "created");
  assert.deepEqual(await readFile(first), PNG);
  assert.match(imported.sha256, /^[0-9a-f]{64}$/);

  const unchanged = await importPng({
    destination: first,
    workspaceRoot: root,
    base64Data: PNG.toString("base64"),
  });
  assert.equal(unchanged.outcome, "unchanged");

  await assert.rejects(
    importPng({
      destination: first,
      workspaceRoot: root,
      base64Data: REPLACEMENT_PNG.toString("base64"),
    }),
    /ASSET_DESTINATION_CONFLICT/,
  );

  const replacement = await importPng({
    destination: first,
    workspaceRoot: root,
    base64Data: REPLACEMENT_PNG.toString("base64"),
    overwrite: true,
  });
  assert.equal(replacement.outcome, "replaced");
  assert.equal(replacement.previousSha256, imported.sha256);
  assert.deepEqual(await readFile(first), REPLACEMENT_PNG);
  assert.equal(imported.width, 1);
  assert.equal(imported.height, 1);
  assert.equal(imported.mimeType, "image/png");

  const fromFile = await importPng({
    destination: join(root, "raw", "from-chat.png"),
    workspaceRoot: root,
    file: {
      download_url: "https://files.openai.example/temporary-signature",
      file_id: "file_test_attachment",
      mime_type: "image/png",
      file_name: "reference.png",
    },
    httpsDownloader: async (url, maxBytes) => {
      assert.equal(url, "https://files.openai.example/temporary-signature");
      assert.equal(maxBytes, 25 * 1024 * 1024);
      return { data: PNG, sourceHost: "files.openai.example" };
    },
  });
  assert.equal(fromFile.source, "openai_file");
  assert.equal(fromFile.sourceFileId, "file_test_attachment");
  assert.equal(fromFile.sourceFileName, "reference.png");
  assert.equal(fromFile.sourceHost, undefined);
  assert.equal(JSON.stringify(fromFile).includes("temporary-signature"), false);
  assert.deepEqual(await readFile(join(root, "raw", "from-chat.png")), PNG);

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "multiple-sources.png"),
      workspaceRoot: root,
      file: {
        download_url: "https://files.openai.example/temporary-signature",
        file_id: "file_test_attachment",
      },
      base64Data: PNG.toString("base64"),
    }),
    /exactly one of file, sourceUrl, or base64Data/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "wrong-file-mime.png"),
      workspaceRoot: root,
      file: {
        download_url: "https://files.openai.example/temporary-signature",
        file_id: "file_wrong_mime",
        mime_type: "image/jpeg",
        file_name: "reference.png",
      },
      httpsDownloader: async () => ({
        data: PNG,
        sourceHost: "files.openai.example",
      }),
    }),
    /mime_type must be image\/png/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "wrong-file-name.png"),
      workspaceRoot: root,
      file: {
        download_url: "https://files.openai.example/temporary-signature",
        file_id: "file_wrong_name",
        file_name: "renamed.jpg",
      },
      httpsDownloader: async () => ({
        data: PNG,
        sourceHost: "files.openai.example",
      }),
    }),
    /file_name extension must be \.png/,
  );

  const corruptCrc = Buffer.from(PNG);
  corruptCrc[29] = corruptCrc[29]! ^ 0xff;
  await assert.rejects(
    importPng({
      destination: join(root, "raw", "bad-crc.png"),
      workspaceRoot: root,
      base64Data: corruptCrc.toString("base64"),
    }),
    /CRC is invalid/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "trailing.png"),
      workspaceRoot: root,
      base64Data: Buffer.concat([PNG, Buffer.from("trailing")]).toString(
        "base64",
      ),
    }),
    /IEND chunk is malformed|trailing data/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "too-wide.png"),
      workspaceRoot: root,
      base64Data: withIhdrDimensions(16_385, 1).toString("base64"),
    }),
    /dimensions exceed/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "too-many-pixels.png"),
      workspaceRoot: root,
      base64Data: withIhdrDimensions(10_001, 10_000).toString("base64"),
    }),
    /dimensions exceed/,
  );

  const corruptImageData = Buffer.from(PNG);
  corruptImageData[45] = corruptImageData[45]! ^ 0xff;
  corruptImageData.writeUInt32BE(crc32(corruptImageData.subarray(37, 52)), 52);
  await assert.rejects(
    importPng({
      destination: join(root, "raw", "decode-failed.png"),
      workspaceRoot: root,
      base64Data: corruptImageData.toString("base64"),
    }),
    /could not be decoded|decoded data/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "not-png.png"),
      workspaceRoot: root,
      base64Data: Buffer.from("not png").toString("base64"),
    }),
    /ASSET_FORMAT_REJECTED/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "wrong.txt"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
    }),
    /ASSET_FORMAT_REJECTED/,
  );

  await assert.rejects(
    importPng({
      destination: join(root, "raw", "hash.png"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
      expectedSha256: "0".repeat(64),
    }),
    /ASSET_HASH_MISMATCH/,
  );

  const outside = await mkdtemp(join(tmpdir(), "devspace-png-outside-"));
  try {
    await mkdir(join(root, "linked"), { recursive: true });
    await symlink(outside, join(root, "linked", "escape"));
    await assert.rejects(
      importPng({
        destination: join(root, "linked", "escape", "escaped.png"),
        workspaceRoot: root,
        base64Data: PNG.toString("base64"),
      }),
      /WORKSPACE_ESCAPE/,
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }

  await writeFile(join(root, "raw", "link-target.png"), PNG);
  await symlink(
    join(root, "raw", "link-target.png"),
    join(root, "raw", "link.png"),
  );
  await assert.rejects(
    importPng({
      destination: join(root, "raw", "link.png"),
      workspaceRoot: root,
      base64Data: PNG.toString("base64"),
      overwrite: true,
    }),
    /symbolic.?link/i,
  );

  console.log("png import tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
