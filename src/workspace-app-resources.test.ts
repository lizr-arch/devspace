import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import {
  LEGACY_WORKSPACE_APP_RESOURCE_URI,
  registerWorkspaceAppResources,
  VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE,
  type WorkspaceAppBuild,
} from "./server.js";

const tempRoot = mkdtempSync(join(tmpdir(), "devspace-app-resource-test-"));

try {
  await testWorkspaceAppResourceCompatibility();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

async function testWorkspaceAppResourceCompatibility(): Promise<void> {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(tempRoot, "config"),
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: join(tempRoot, "state"),
    DEVSPACE_WORKTREE_ROOT: join(tempRoot, "worktrees"),
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
  });
  const workspaceApp: WorkspaceAppBuild = {
    entry: {
      file: "assets/workspace-app-current.js",
      css: ["assets/workspace-app-current.css"],
    },
    uiDirectoryPath: tempRoot,
    resourceUri: "ui://devspace/workspace-app-0123456789abcdef.html",
    buildFingerprint:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    manifestSha256:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
  const server = new McpServer({
    name: "devspace-app-resource-test",
    version: "1.0.0",
  });
  registerWorkspaceAppResources(server, config, workspaceApp);

  const client = new Client({
    name: "devspace-app-resource-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const resources = await client.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri).sort(),
      [LEGACY_WORKSPACE_APP_RESOURCE_URI, workspaceApp.resourceUri].sort(),
    );

    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate),
      [VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE],
    );

    for (const resourceUri of [
      workspaceApp.resourceUri,
      LEGACY_WORKSPACE_APP_RESOURCE_URI,
      "ui://devspace/workspace-app-fedcba9876543210.html",
    ]) {
      const result = await client.readResource({ uri: resourceUri });
      assert.equal(result.contents.length, 1);
      const content = result.contents[0];
      assert.equal(content.uri, resourceUri);
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.equal(
        "text" in content &&
          content.text.includes(
            "https://devspace.example.com/mcp-app-assets/assets/workspace-app-current.js",
          ),
        true,
      );
      assert.equal(
        "text" in content &&
          content.text.includes(
            "https://devspace.example.com/mcp-app-assets/assets/workspace-app-current.css",
          ),
        true,
      );
    }

    for (const invalidResourceUri of [
      "ui://devspace/workspace-app-not-a-fingerprint.html",
      "ui://devspace/workspace-app-ABCDEF0123456789.html",
      "ui://devspace/workspace-app-0123456789abcde.html",
      "ui://other/workspace-app-0123456789abcdef.html",
    ]) {
      await assert.rejects(
        () => client.readResource({ uri: invalidResourceUri }),
        /not found/i,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
}
