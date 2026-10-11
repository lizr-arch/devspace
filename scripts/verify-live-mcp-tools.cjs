/**
 * Reads the live service's MCP tool catalogue over the real HTTP endpoint.
 *
 * Issues a short-lived operator access token into the existing OAuth client so
 * the authenticated path is exercised exactly as a real client would use it.
 * Read-only: no workspace is opened and no tool is invoked.
 */
const { createHash, randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");

const STATE = "/Users/liz/.local/share/devspace/devspace.sqlite";
const db = new Database(STATE);

const client = db.prepare("select client_id from oauth_clients limit 1").get();
if (!client) {
  console.error("no registered OAuth client; cannot probe authenticated tools/list");
  process.exit(3);
}

const token = `probe-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("base64url");
const expiresAt = Math.floor(Date.now() / 1000) + 600;

db.prepare(
  `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
   values (?, ?, ?, ?, ?)`,
).run(
  tokenHash,
  client.client_id,
  JSON.stringify(["devspace"]),
  expiresAt,
  "https://mcp.workspaceport.com/mcp",
);
db.prepare("delete from oauth_access_tokens where expires_at < strftime('%s','now')").run();

const url = "http://127.0.0.1:7676/mcp";
const call = async (body, sessionId) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const session = response.headers.get("mcp-session-id");
  let parsed;
  try {
    parsed = text.includes("data:")
      ? JSON.parse(text.split("data:").slice(1).join("data:").trim())
      : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, session, parsed };
};

(async () => {
  const init = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "devspace-lifecycle-probe", version: "1.0.0" },
    },
  });
  console.log("initialize status:", init.status, "session:", Boolean(init.session));
  await call(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    init.session,
  );
  const list = await call(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.session,
  );
  console.log("tools/list status:", list.status);
  const tools = list.parsed?.result?.tools ?? [];
  console.log("tool count:", tools.length);
  for (const name of [
    "close_workspace_session",
    "git_delete_merged_branch",
    "list_workspaces",
    "reclaim_workspace",
    "git_status",
    "git_branch",
    "git_fetch",
    "git_merge",
    "git_push",
  ]) {
    const tool = tools.find((entry) => entry.name === name);
    console.log(`  ${tool ? "PRESENT" : "MISSING"} ${name}`);
  }
  const closeTool = tools.find((tool) => tool.name === "close_workspace_session");
  if (closeTool) {
    console.log(
      "close_workspace_session schema keys:",
      Object.keys(closeTool.inputSchema?.properties ?? {}).sort().join(","),
    );
    console.log(
      "close_workspace_session required:",
      (closeTool.inputSchema?.required ?? []).join(","),
    );
  }
  const deleteTool = tools.find(
    (tool) => tool.name === "git_delete_merged_branch",
  );
  if (deleteTool) {
    console.log(
      "git_delete_merged_branch schema keys:",
      Object.keys(deleteTool.inputSchema?.properties ?? {}).sort().join(","),
    );
    console.log(
      "git_delete_merged_branch required:",
      (deleteTool.inputSchema?.required ?? []).join(","),
    );
  }

  // Read-only lifecycle tool call: prove the new plan path works live.
  const plan = await call(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_workspaces",
        arguments: { limit: 3, audit: true, cleanupPlan: true },
      },
    },
    init.session,
  );
  const content = plan.parsed?.result?.structuredContent;
  console.log("list_workspaces(audit,cleanupPlan) status:", plan.status);
  console.log(
    "  cleanupPlan.readOnly:", content?.cleanupPlan?.readOnly,
    "entries:", content?.cleanupPlan?.entries?.length,
    "summary:", JSON.stringify(content?.cleanupPlan?.summary),
  );
  console.log(
    "  first entry verdict:",
    content?.cleanupPlan?.entries?.[0]?.verdict,
    "| sessionState:", content?.cleanupPlan?.entries?.[0]?.sessionState,
    "| reclaimable:", content?.cleanupPlan?.entries?.[0]?.reclaimable,
  );

  // Clean up the probe token.
  db.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  db.close();
})().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
