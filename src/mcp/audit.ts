import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DELEGATE_DIR = ".devspace";
const AUDIT_FILE = "mcp_audit.jsonl";

export type ResultStatus =
  "OK" | "ERROR" | "REJECTED" | "RECOVERED" | "UNKNOWN_TOOL";

export interface AuditEntry {
  event_id: string;
  parent_event_id: string | null;
  time: string;
  tool: string;
  args_summary: string;
  result_status: ResultStatus;
  workspace: string;
  run_id: string | null;
  safety_flags: string[];
}

export function writeAudit(entry: AuditEntry): void {
  try {
    const dir = DELEGATE_DIR;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(join(dir, AUDIT_FILE), line, "utf-8");
  } catch {
    console.error("[audit] Failed to write audit entry:", entry.tool);
  }
}

const SENSITIVE_KEYS = [
  "api_key",
  "token",
  "password",
  "authorization",
  "secret",
  "openai_api_key",
];

function argsToSummary(args: unknown): string {
  if (!args) return "";
  try {
    const redacted = JSON.parse(
      JSON.stringify(args, (key, value) => {
        if (SENSITIVE_KEYS.includes(key.toLowerCase())) return "[REDACTED]";
        return value;
      }),
    );
    return JSON.stringify(redacted).substring(0, 200);
  } catch {
    return String(args).substring(0, 200);
  }
}

export function createAuditEntry(
  tool: string,
  args: Record<string, unknown>,
  resultStatus: ResultStatus,
  runId: string | null = null,
  safetyFlags: string[] = [],
  parentEventId: string | null = null,
): AuditEntry {
  return {
    event_id: randomUUID(),
    parent_event_id: parentEventId,
    time: new Date().toISOString(),
    tool,
    args_summary: argsToSummary(args),
    result_status: resultStatus,
    workspace: process.cwd(),
    run_id: runId,
    safety_flags: safetyFlags,
  };
}
