import type { McpSessionSource } from "./mcp-session-registry.js";

export interface McpClientDiagnostics {
  source: McpSessionSource;
  clientName?: string;
  clientVersion?: string;
}

export function classifyMcpClient(
  initializeBody: unknown,
): McpClientDiagnostics {
  const params = objectValue(objectValue(initializeBody)?.params);
  const clientInfo = objectValue(params?.clientInfo);
  const clientName = boundedDiagnosticValue(clientInfo?.name, 48);
  const clientVersion = boundedDiagnosticValue(clientInfo?.version, 24);

  if (!clientName) return { source: "unknown" };
  if (clientName === "devspace-tool-cards") {
    return { source: "workspace_app", clientName, clientVersion };
  }
  if (clientName === "public-doctor") {
    return { source: "doctor", clientName, clientVersion };
  }
  if (clientName.startsWith("devspace-test-")) {
    return { source: "test_client", clientName, clientVersion };
  }
  return { source: "main_connector", clientName, clientVersion };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedDiagnosticValue(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, maxLength);
  return safe || undefined;
}
