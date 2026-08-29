import {
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";

export const DELEGATE_DIR = ".devspace";
export const CEO_DIR = join(DELEGATE_DIR, "ceo");
export const RUNS_DIR = join(DELEGATE_DIR, "runs");
export const USER_ANSWERS_DIR = join(DELEGATE_DIR, "user_answers");
export const APPROVALS_DIR = join(DELEGATE_DIR, "approvals");

export const MAX_HANDOFF = 65536;
export const MAX_REVIEW = 65536;
export const MAX_TASK = 32768;
export const MAX_ANSWER = 16384;

export function checkSize(value: unknown, max: number, label: string): string | null {
  if (typeof value === "string" && value.length > max) {
    return `${label} exceeds ${max} bytes`;
  }
  return null;
}

export function safePath(requestedPath: string): string | null {
  const full = resolve(DELEGATE_DIR, requestedPath);
  const base = resolve(DELEGATE_DIR);
  if (!full.startsWith(base)) return null;
  if (full.includes("..")) return null;

  if (existsSync(full)) {
    try {
      const real = realpathSync(full);
      if (!real.startsWith(base)) return null;
    } catch {
      return null;
    }
  }

  return full;
}

export function safeRead(filePath: string): {
  ok: boolean;
  content?: string;
  error?: string;
} {
  const safe = safePath(filePath);
  if (!safe) return { ok: false, error: "Path traversal rejected" };
  if (!existsSync(safe))
    return { ok: false, error: `File not found: ${filePath}` };
  try {
    return { ok: true, content: readFileSync(safe, "utf-8") };
  } catch (e) {
    return {
      ok: false,
      error: `Read error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function readJsonSafe(filePath: string): {
  ok: boolean;
  data?: unknown;
  error?: string;
} {
  const result = safeRead(filePath);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.content!) };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function verifyRunToken(args: { run_token: string }): {
  valid: boolean;
  run_id?: string;
} {
  const lockPath = join(DELEGATE_DIR, "run.lock");
  if (!existsSync(lockPath)) {
    return { valid: false };
  }
  let lockData: Record<string, unknown> = {};
  try {
    lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return { valid: false };
  }
  const storedHash = lockData.run_token_hash as string | undefined;
  if (!storedHash) {
    return { valid: true, run_id: lockData.run_id as string | undefined };
  }
  const providedHash = createHash("sha256")
    .update(args.run_token)
    .digest("hex")
    .substring(0, 16);
  if (providedHash !== storedHash) {
    return { valid: false };
  }
  return { valid: true, run_id: lockData.run_id as string | undefined };
}
