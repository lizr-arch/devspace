import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { downloadHttpsBytes, importAsset } from "./asset-import.js";

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
  await testDownloadTimeouts(root);
  console.log("asset import tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDownloadTimeouts(root: string): Promise<void> {
  const signedUrl =
    "https://files.example.test/asset.png?signature=must-not-leak";
  const allowPublicHostname = async (): Promise<void> => undefined;

  const activeDownload = await downloadHttpsBytes(signedUrl, PNG.length, {
    assertPublicHostnameImpl: allowPublicHostname,
    fetchImpl: streamingFetch(splitBuffer(PNG, 4), 20),
    timeouts: {
      connectOrHeadersMs: 50,
      idleReadMs: 50,
      totalMs: 250,
    },
  });
  assert.deepEqual(activeDownload.data, PNG);

  const headerTimeoutFetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
  await assert.rejects(
    downloadHttpsBytes(signedUrl, PNG.length, {
      assertPublicHostnameImpl: allowPublicHostname,
      fetchImpl: headerTimeoutFetch,
      timeouts: {
        connectOrHeadersMs: 20,
        idleReadMs: 50,
        totalMs: 100,
      },
    }),
    (error: unknown) => {
      assert.match(
        String(error),
        /ASSET_DOWNLOAD_TIMEOUT: phase=connect_or_headers; timeoutMs=20; receivedBytes=0/,
      );
      assert.doesNotMatch(String(error), /must-not-leak|files\.example\.test/);
      return true;
    },
  );

  const idleTimeoutFetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PNG.subarray(0, 8));
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  await assert.rejects(
    downloadHttpsBytes(signedUrl, PNG.length, {
      assertPublicHostnameImpl: allowPublicHostname,
      fetchImpl: idleTimeoutFetch,
      timeouts: {
        connectOrHeadersMs: 50,
        idleReadMs: 20,
        totalMs: 100,
      },
    }),
    /ASSET_DOWNLOAD_TIMEOUT: phase=body_idle; timeoutMs=20; receivedBytes=8/,
  );

  await assert.rejects(
    downloadHttpsBytes(signedUrl, PNG.length, {
      assertPublicHostnameImpl: allowPublicHostname,
      fetchImpl: streamingFetch(splitBuffer(PNG, PNG.length), 20),
      timeouts: {
        connectOrHeadersMs: 50,
        idleReadMs: 50,
        totalMs: 90,
      },
    }),
    /ASSET_DOWNLOAD_TIMEOUT: phase=total; timeoutMs=90; receivedBytes=[1-9]/,
  );

  const timeoutDestination = join(root, "timeout-assets", "never-written.png");
  await assert.rejects(
    importAsset({
      workspaceRoot: root,
      destination: timeoutDestination,
      file: {
        download_url: signedUrl,
        file_id: "file_timeout_fixture",
        mime_type: "image/png",
        file_name: "fixture.png",
      },
      httpsDownloader: (url, maxBytes) =>
        downloadHttpsBytes(url, maxBytes, {
          assertPublicHostnameImpl: allowPublicHostname,
          fetchImpl: headerTimeoutFetch,
          timeouts: {
            connectOrHeadersMs: 20,
            idleReadMs: 50,
            totalMs: 100,
          },
        }),
    }),
    /ASSET_DOWNLOAD_TIMEOUT: phase=connect_or_headers/,
  );
  await assert.rejects(access(timeoutDestination));
  assert.equal(
    (await readdir(root, { recursive: true })).some((path) =>
      path.includes(".devspace-"),
    ),
    false,
  );
}

function splitBuffer(buffer: Buffer, count: number): Buffer[] {
  const chunkSize = Math.ceil(buffer.length / count);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

function streamingFetch(chunks: Buffer[], intervalMs: number): typeof fetch {
  return (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        const push = () => {
          if (cancelled) return;
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(chunks[index]);
          index += 1;
          timer = setTimeout(push, intervalMs);
        };
        timer = setTimeout(push, intervalMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            controller.error(init.signal?.reason);
          },
          { once: true },
        );
      },
      cancel() {
        cancelled = true;
        if (timer) clearTimeout(timer);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-length": String(chunks.reduce((n, c) => n + c.length, 0)),
      },
    });
  }) as typeof fetch;
}
