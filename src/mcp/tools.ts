import { TOOL_SCHEMAS, ALL_TOOL_NAMES } from "./schemas.js";
import { handleToolCall } from "./handlers.js";
import { writeAudit, createAuditEntry, type ResultStatus } from "./audit.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listTools(): McpTool[] {
  return ALL_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_SCHEMAS[name].description,
    inputSchema: TOOL_SCHEMAS[name].inputSchema,
  }));
}

export interface ToolEnvelope {
  ok: boolean;
  status: string;
  data?: unknown;
  error?: string;
  safety_flags?: string[];
}

function wrapEnvelope(result: unknown, safetyFlags: string[]): ToolEnvelope {
  const obj =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
  if (!obj) {
    return {
      ok: true,
      status: "OK",
      data: result,
      safety_flags: safetyFlags.length > 0 ? safetyFlags : undefined,
    };
  }
  const hasError = typeof obj.error === "string" && obj.error.length > 0;
  const isRejected =
    obj.status === "REJECTED" ||
    obj.status === "INVALID" ||
    obj.status === "INVALID_STATE" ||
    obj.status === "INVALID_INPUT" ||
    obj.status === "INVALID_DECISION" ||
    obj.status === "NO_STATE";
  const ok = !hasError && !isRejected;
  return {
    ...obj,
    ok,
    status: (obj.status as string) || (ok ? "OK" : "ERROR"),
    data: result,
    error: hasError ? (obj.error as string) : undefined,
    safety_flags: safetyFlags.length > 0 ? safetyFlags : undefined,
  };
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  if (!TOOL_SCHEMAS[name]) {
    writeAudit(createAuditEntry(name, args, "UNKNOWN_TOOL"));
    return wrapEnvelope({ error: `Unknown tool: ${name}` }, []);
  }

  const rawParentId = args?._parent_event_id;
  const parentEventId =
    typeof rawParentId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawParentId,
    )
      ? rawParentId
      : null;

  try {
    const result = await handleToolCall(name, args);

    const resultObj = result as Record<string, unknown>;
    let resultStatus: ResultStatus = "OK";
    if (resultObj?.error) resultStatus = "ERROR";
    else if (resultObj?.status === "REJECTED") resultStatus = "REJECTED";
    else if (resultObj?.status === "RECOVERED") resultStatus = "RECOVERED";

    const runId = (resultObj?.run_id as string) || null;

    const safetyFlags: string[] = [];
    if (resultObj?.safety_flags)
      safetyFlags.push(...(resultObj.safety_flags as string[]));

    writeAudit(
      createAuditEntry(
        name,
        args,
        resultStatus,
        runId,
        safetyFlags,
        parentEventId,
      ),
    );
    return wrapEnvelope(result, safetyFlags);
  } catch (e) {
    const error = `Handler error: ${e instanceof Error ? e.message : String(e)}`;
    writeAudit(createAuditEntry(name, args, "ERROR", null, [], parentEventId));
    return wrapEnvelope({ error }, []);
  }
}
