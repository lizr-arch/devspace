import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export function registerAgentAuditTools(server: McpServer, ctx: ServerContext): void {
  registerAppTool(server, "get_agent_efficiency_audit", {
    title: "Get native Codex efficiency audit", description: "Read a bounded, redacted offline audit for one completed DevSpace-launched native Codex operation.",
    inputSchema: { workspaceId: id, operationId: id }, outputSchema: resultOutputSchema({ snapshot: z.unknown().optional(), error: z.unknown().optional() }),
    _meta: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, operationId }) => {
    ctx.workspaces.getWorkspace(workspaceId);
    const snapshot = ctx.coachReviewEvents.getEfficiencyAudit(workspaceId, operationId);
    if (!snapshot) return { content: [textBlock("No efficiency audit is available for this authorized operation.")], structuredContent: { result: "unavailable" } };
    return { content: [textBlock(`Audit ${operationId}: ${snapshot.status}; ${snapshot.confirmedToolCompletions}/${snapshot.confirmedToolStarts} confirmed tool steps.`)], structuredContent: { result: "ok", snapshot } };
  });
}
