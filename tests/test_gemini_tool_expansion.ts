import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SingleUserOAuthProvider } from "../src/oauth-provider.js";
import { setupWorkspace, teardownWorkspace } from "./test_utils.js";

type Json = Record<string, any>;

async function listTools(baseUrl: string, token: string, name: string) {
  const request = async (body: Json, sessionId?: string) => {
    const response = await fetch(`${baseUrl}/mcp`, {
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
    const line = text.split("\n").find((entry) => entry.startsWith("data: "));
    assert.ok(line, `MCP response had no SSE data: ${text.slice(0, 250)}`);
    return { response, result: JSON.parse(line.slice(6)) as Json };
  };
  const init = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name, version: name === "mcp" ? "0.1.0" : "test" },
    },
  });
  assert.equal(init.response.status, 200);
  const sessionId = init.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const listed = await request(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  assert.equal(listed.response.status, 200);
  await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId,
    },
  });
  return listed.result.result.tools as Json[];
}

async function run() {
  const root = setupWorkspace();
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: `${root}/state`,
    DEVSPACE_CONFIG_DIR: `${root}/config`,
    DEVSPACE_OAUTH_OWNER_TOKEN: "gemini-expansion-owner-token",
    DEVSPACE_MCP_TRANSPORT_MODE: "stateful",
    DEVSPACE_GIT_REMOTE_WRITE_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  const server = createServer(config);
  const oauth = new SingleUserOAuthProvider(
    config.oauth,
    new URL(`${config.publicBaseUrl}/mcp`),
    config.stateDir,
  );
  const client = await oauth.clientsStore.registerClient({
    redirect_uris: ["http://localhost/callback"],
    client_name: "Gemini tool list regression",
  });
  const code = `test-${Date.now()}`;
  const redirectUri = "http://localhost/callback";
  const resource = new URL(`${config.publicBaseUrl}/mcp`);
  (oauth as any).oauthStore.saveAuthorizationCode({
    code,
    clientId: client.client_id,
    expiresAtMs: Date.now() + 60_000,
    params: {
      clientId: client.client_id,
      redirectUri,
      scopes: ["devspace"],
      state: "test",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource,
    },
  });
  const token = await oauth.exchangeAuthorizationCode(
    client,
    code,
    "verifier",
    redirectUri,
    resource,
  );
  const listener = server.app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const gemini = await listTools(url, token.access_token, "mcp");
    const regular = await listTools(url, token.access_token, "ChatGPT");
    assert.ok(gemini.length > 0 && gemini.length <= 50,
      `Gemini should receive a bounded toolset; got ${gemini.length}`);
    assert.ok(regular.length >= 73 && gemini.length < regular.length,
      `ChatGPT must keep the full catalog even when both sessions share a bearer token (Gemini ${gemini.length}, ChatGPT ${regular.length})`);
    assert.ok(gemini.some(tool => tool.name === "open_workspace"));
    assert.ok(!gemini.some(tool => tool.name === "codex_agent_start"),
      "Gemini subset must not expose unrestricted Codex dispatch");
    for (const tool of gemini) {
      const encoded = JSON.stringify(tool);
      assert.ok(!encoded.includes("$schema"), `${tool.name} retained $schema`);
      assert.ok(!encoded.includes("additionalProperties"), `${tool.name} retained additionalProperties`);
      assert.ok(!("outputSchema" in tool), `${tool.name} retained outputSchema`);
      assert.ok(!("_meta" in tool), `${tool.name} retained _meta`);
    }
    assert.ok(regular.some((tool) => "outputSchema" in tool));
    console.log(`Gemini bounded catalog passed (${gemini.length} tools; ChatGPT full ${regular.length})`);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    oauth.close();
    await server.close();
    teardownWorkspace();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
