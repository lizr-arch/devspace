import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_ITEMS = 500;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_DIMENSION = 2048;
export const PROCESS_TIMEOUT_MS = 120_000;
export const PROCESS_KILL_GRACE_MS = 1_000;
export const MAX_GLB_INSPECT_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_INSPECT_BYTES = 256 * 1024 * 1024;
export const MAX_BLEND_INSPECT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_GLB_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 30 * 60;
export const MAX_DECODED_AUDIO_SAMPLES = 100_000_000;

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

export function terminateInspectorProcess(child: ReturnType<typeof spawn>): void {
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

export function locateFfmpeg(): string | undefined {
  const candidates = [
    join(homedir(), ".local", "bin", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function runFixed(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
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

export function boundedResult(value: Record<string, unknown>): InspectorResult {
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

export function assertInspectorFileSize(
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

export function readExactly(
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

export function sha256FileDescriptor(fileDescriptor: number, size: number): string {
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

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function numericArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 1024) : undefined;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

export function previewDimension(value: number): number {
  if (!Number.isInteger(value) || value < 64 || value > MAX_PREVIEW_DIMENSION) {
    throw new Error("INSPECTOR_PREVIEW_SIZE_INVALID");
  }
  return value;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function unavailable(name: string): never {
  throw new Error(`INSPECTOR_UNAVAILABLE: ${name} is unavailable.`);
}
