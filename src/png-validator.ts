import { Readable } from "node:stream";
import { createInflate } from "node:zlib";

export const MAX_PNG_WIDTH = 16_384;
export const MAX_PNG_HEIGHT = 16_384;
export const MAX_PNG_PIXEL_COUNT = 100_000_000;

export interface PngDimensions {
  width: number;
  height: number;
}

interface PngHeader extends PngDimensions {
  bitDepth: number;
  colorType: number;
  interlaceMethod: number;
}

interface DecodePass {
  rowBytes: number;
  rows: number;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const COLOR_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const VALID_BIT_DEPTHS = new Map<number, Set<number>>([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const ADAM7_PASSES = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
] as const;

const CRC_TABLE = createCrcTable();

export async function validatePng(data: Buffer): Promise<PngDimensions> {
  if (
    data.length < PNG_SIGNATURE.length ||
    !data.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw pngRejected("PNG signature is missing.");
  }

  let offset = PNG_SIGNATURE.length;
  let header: PngHeader | undefined;
  let paletteEntries: number | undefined;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  const idatChunks: Buffer[] = [];
  let idatBytes = 0;

  while (offset < data.length) {
    if (seenIend) {
      throw pngRejected("PNG contains trailing data after IEND.");
    }
    if (offset + 12 > data.length) {
      throw pngRejected("PNG chunk header is truncated.");
    }
    const length = data.readUInt32BE(offset);
    const typeStart = offset + 4;
    const chunkStart = typeStart + 4;
    const chunkEnd = chunkStart + length;
    const crcOffset = chunkEnd;
    if (chunkEnd < chunkStart || crcOffset + 4 > data.length) {
      throw pngRejected("PNG chunk is truncated.");
    }

    const typeBytes = data.subarray(typeStart, chunkStart);
    if (!isValidChunkType(typeBytes)) {
      throw pngRejected("PNG chunk type is invalid.");
    }
    const type = typeBytes.toString("ascii");
    const chunk = data.subarray(chunkStart, chunkEnd);
    const declaredCrc = data.readUInt32BE(crcOffset);
    if (crc32(typeBytes, chunk) !== declaredCrc) {
      throw pngRejected(`PNG ${type} chunk CRC is invalid.`);
    }
    offset = crcOffset + 4;

    if (!header && type !== "IHDR") {
      throw pngRejected("IHDR must be the first PNG chunk.");
    }
    if (!KNOWN_CRITICAL_CHUNKS.has(type) && (typeBytes[0]! & 0x20) === 0) {
      throw pngRejected(`PNG contains unknown critical chunk ${type}.`);
    }

    switch (type) {
      case "IHDR":
        if (header || length !== 13) {
          throw pngRejected("PNG must contain one 13-byte IHDR chunk.");
        }
        header = parseHeader(chunk);
        break;
      case "PLTE":
        if (
          paletteEntries !== undefined ||
          seenIdat ||
          length === 0 ||
          length % 3 !== 0 ||
          length > 768
        ) {
          throw pngRejected("PNG PLTE chunk is malformed or out of order.");
        }
        if (header!.colorType === 0 || header!.colorType === 4) {
          throw pngRejected("PNG color type does not permit a palette.");
        }
        paletteEntries = length / 3;
        break;
      case "IDAT":
        if (idatEnded) {
          throw pngRejected("PNG IDAT chunks must be consecutive.");
        }
        seenIdat = true;
        idatBytes += length;
        idatChunks.push(chunk);
        break;
      case "IEND":
        if (length !== 0 || !seenIdat || offset !== data.length) {
          throw pngRejected("PNG IEND chunk is malformed or out of order.");
        }
        seenIend = true;
        break;
      default:
        if (seenIdat) idatEnded = true;
        break;
    }
  }

  if (!header || !seenIend || idatBytes === 0) {
    throw pngRejected("PNG is missing IHDR, IDAT, or IEND data.");
  }
  if (header.colorType === 3) {
    if (paletteEntries === undefined || paletteEntries > 2 ** header.bitDepth) {
      throw pngRejected("Indexed PNG has an invalid or missing palette.");
    }
  }

  await validateDecodedScanlines(
    Buffer.concat(idatChunks, idatBytes),
    decodePasses(header),
  );
  return { width: header.width, height: header.height };
}

function parseHeader(chunk: Buffer): PngHeader {
  const width = chunk.readUInt32BE(0);
  const height = chunk.readUInt32BE(4);
  const bitDepth = chunk[8]!;
  const colorType = chunk[9]!;
  const compressionMethod = chunk[10]!;
  const filterMethod = chunk[11]!;
  const interlaceMethod = chunk[12]!;

  if (
    width === 0 ||
    height === 0 ||
    width > MAX_PNG_WIDTH ||
    height > MAX_PNG_HEIGHT ||
    width * height > MAX_PNG_PIXEL_COUNT
  ) {
    throw pngRejected(
      `PNG dimensions exceed ${MAX_PNG_WIDTH}x${MAX_PNG_HEIGHT} or ${MAX_PNG_PIXEL_COUNT} pixels.`,
    );
  }
  if (!VALID_BIT_DEPTHS.get(colorType)?.has(bitDepth)) {
    throw pngRejected("PNG bit depth and color type are incompatible.");
  }
  if (
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  ) {
    throw pngRejected(
      "PNG compression, filter, or interlace method is unsupported.",
    );
  }
  return { width, height, bitDepth, colorType, interlaceMethod };
}

function decodePasses(header: PngHeader): DecodePass[] {
  const channels = COLOR_CHANNELS.get(header.colorType)!;
  const rowBytes = (width: number) =>
    Math.ceil((width * channels * header.bitDepth) / 8);
  if (header.interlaceMethod === 0) {
    return [{ rowBytes: rowBytes(header.width), rows: header.height }];
  }
  return ADAM7_PASSES.flatMap((pass) => {
    const width = passLength(header.width, pass.x, pass.dx);
    const height = passLength(header.height, pass.y, pass.dy);
    return width === 0 || height === 0
      ? []
      : [{ rowBytes: rowBytes(width), rows: height }];
  });
}

function passLength(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

async function validateDecodedScanlines(
  compressed: Buffer,
  passes: DecodePass[],
): Promise<void> {
  const inflater = createInflate();
  let passIndex = 0;
  let rowsRemaining = passes[0]?.rows ?? 0;
  let rowBytesRemaining = 0;
  let expectingFilter = true;

  try {
    for await (const rawChunk of Readable.from([compressed]).pipe(inflater)) {
      const chunk = Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        if (passIndex >= passes.length) {
          throw pngRejected(
            "PNG decoded data exceeds the declared dimensions.",
          );
        }
        if (expectingFilter) {
          if (chunk[offset]! > 4) {
            throw pngRejected("PNG scanline uses an invalid filter type.");
          }
          offset += 1;
          rowBytesRemaining = passes[passIndex]!.rowBytes;
          expectingFilter = false;
        }
        const consumed = Math.min(rowBytesRemaining, chunk.length - offset);
        rowBytesRemaining -= consumed;
        offset += consumed;
        if (rowBytesRemaining === 0) {
          rowsRemaining -= 1;
          expectingFilter = true;
          if (rowsRemaining === 0) {
            passIndex += 1;
            rowsRemaining = passes[passIndex]?.rows ?? 0;
          }
        }
      }
    }
  } catch (error) {
    inflater.destroy();
    if (
      error instanceof Error &&
      error.message.startsWith("ASSET_FORMAT_REJECTED:")
    ) {
      throw error;
    }
    throw pngRejected("PNG image data could not be decoded.");
  }

  if (
    passIndex !== passes.length ||
    !expectingFilter ||
    inflater.bytesWritten !== compressed.length
  ) {
    throw pngRejected("PNG decoded data is truncated or has trailing bytes.");
  }
}

function isValidChunkType(type: Buffer): boolean {
  return (
    type.length === 4 &&
    [...type].every(
      (value) =>
        (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a),
    )
  );
}

function crc32(type: Buffer, data: Buffer): number {
  let crc = 0xffffffff;
  for (const buffer of [type, data]) {
    for (const byte of buffer) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function pngRejected(message: string): Error {
  return new Error(`ASSET_FORMAT_REJECTED: ${message}`);
}
