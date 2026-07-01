import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import {
  deriveChatGptWebInfo,
  probeLocalChatGptFlow,
  probePublicExternalClientFlow,
  probePublicChatGptFlow,
  publicProbeRequestInitForBaseUrl,
} from "./doctor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "devspace-doctor-test-"));

try {
  await testDerivedChatGptUrls();
  await testPublicProbeHeaders();
  await testLiveChatGptProbe();
  await testPublicChatGptProbe();
  await testPublicExternalClientProbe();
  await testPublicExternalClientProbeReadOnly();
  await testPublicProbeExplainsInvalidHost();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

async function testDerivedChatGptUrls(): Promise<void> {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: mkdtempSync(join(tempRoot, "config-derived-")),
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
  });

  const info = deriveChatGptWebInfo(config);
  assert.equal(info.publicMcpUrl, "https://devspace.example.com/mcp");
  assert.equal(
    info.protectedResourceMetadataUrl,
    "https://devspace.example.com/.well-known/oauth-protected-resource/mcp",
  );
  assert.equal(
    info.authorizationServerMetadataUrl,
    "https://devspace.example.com/.well-known/oauth-authorization-server",
  );
  assert.equal(info.authorizationEndpoint, "https://devspace.example.com/authorize");
  assert.equal(info.tokenEndpoint, "https://devspace.example.com/token");
  assert.equal(info.registrationEndpoint, "https://devspace.example.com/register");
  assert.equal(info.chatgptRedirectAllowed, true);
  assert.match(
    info.planRequirementNote,
    /Verify your current ChatGPT plan/i,
  );
}

async function testPublicProbeHeaders(): Promise<void> {
  const pinggyInit = publicProbeRequestInitForBaseUrl(
    "https://abc.free.pinggy.net",
  );
  const pinggyHeaders = new Headers(pinggyInit?.headers);
  assert.equal(pinggyHeaders.get("X-Pinggy-No-Screen"), "true");
  assert.equal(pinggyHeaders.get("User-Agent"), "DevSpaceDoctor/1.0");

  const genericInit = publicProbeRequestInitForBaseUrl(
    "https://devspace.example.com",
  );
  const genericHeaders = new Headers(genericInit?.headers);
  assert.equal(genericHeaders.get("X-Pinggy-No-Screen"), null);
  assert.equal(genericHeaders.get("User-Agent"), "DevSpaceDoctor/1.0");
}

async function testLiveChatGptProbe(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-live-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-live-"));
  const worktreeRoot = mkdtempSync(join(tempRoot, "worktree-live-"));
  const port = await freePort();
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(port),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
  });

  try {
    const probe = await probeLocalChatGptFlow(config);
    assert.equal(probe.ready, true);
    assert.equal(probe.healthz.ok, true);
    assert.equal(probe.protectedResourceMetadata.ok, true);
    assert.equal(probe.authorizationServerMetadata.ok, true);
    assert.equal(probe.clientRegistration.ok, true);
    assert.equal(probe.authorizationPage.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function testPublicChatGptProbe(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-public-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-public-"));
  const worktreeRoot = mkdtempSync(join(tempRoot, "worktree-public-"));
  const port = await freePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(port),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
  });

  try {
    const probe = await probePublicChatGptFlow(config);
    assert.equal(probe.ready, true);
    assert.equal(probe.healthz.ok, true);
    assert.equal(probe.protectedResourceMetadata.ok, true);
    assert.equal(probe.authorizationServerMetadata.ok, true);
    assert.equal(probe.clientRegistration.ok, true);
    assert.equal(probe.authorizationPage.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function testPublicExternalClientProbe(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-external-client-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-external-client-"));
  const worktreeRoot = mkdtempSync(join(tempRoot, "worktree-external-client-"));
  const port = await freePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(port),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
  });

  try {
    const probe = await probePublicExternalClientFlow(config, {
      workspacePath: process.cwd(),
    });
    assert.equal(probe.ready, true);
    assert.equal(probe.clientRegistration.ok, true);
    assert.equal(probe.authorization.ok, true);
    assert.equal(probe.tokenExchange.ok, true);
    assert.equal(probe.initialize.ok, true);
    assert.equal(probe.toolsList.ok, true);
    assert.equal(probe.openWorkspace.ok, true);
    assert.equal(probe.workspaceRoot, process.cwd());
    assert.match(probe.workspaceId ?? "", /^ws_/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function testPublicExternalClientProbeReadOnly(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-external-client-ro-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-external-client-ro-"));
  const worktreeRoot = mkdtempSync(
    join(tempRoot, "worktree-external-client-ro-"),
  );
  const port = await freePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_READ_ONLY: "1",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(port),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
  });

  try {
    const probe = await probePublicExternalClientFlow(config, {
      workspacePath: process.cwd(),
    });
    assert.equal(probe.ready, true);
    assert.deepEqual((probe as any).toolNames, [
      "open_workspace",
      "read",
      "grep",
      "glob",
      "ls",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function testPublicProbeExplainsInvalidHost(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-invalid-host-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-invalid-host-"));
  const worktreeRoot = mkdtempSync(join(tempRoot, "worktree-invalid-host-"));
  const serverPort = await freePort();
  const proxyPort = await freePort();
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(serverPort),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
  });

  const http = await import("node:http");
  const proxyServer = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: serverPort,
        path: request.url,
        method: request.method,
        headers: {
          ...request.headers,
          host: "mismatch.example.com",
        },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    request.pipe(upstream);
  });

  await new Promise<void>((resolve) => {
    proxyServer.listen(proxyPort, "127.0.0.1", () => resolve());
  });

  try {
    const probe = await probePublicChatGptFlow(config);
    assert.equal(probe.ready, false);
    assert.match(probe.healthz.detail, /DEVSPACE_PUBLIC_BASE_URL/i);
    assert.match(probe.healthz.detail, /Invalid Host/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      proxyServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function freePort(): Promise<number> {
  const net = await import("node:net");

  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine free port."));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}
