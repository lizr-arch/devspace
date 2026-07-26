import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, resolveWorkspaceAppBuild } from "./server.js";
import { loadConfig } from "./config.js";
import { canonicalJson } from "./project-memory.js";
import { isToolName } from "./ui/card-types.js";
import {
  deriveChatGptWebInfo,
  probeLocalChatGptFlow,
  probePublicExternalClientFlow,
  probePublicChatGptFlow,
  publicProbeRequestInitForBaseUrl,
} from "./doctor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "devspace-doctor-test-"));
const testWorkspaceAppBuild = createWorkspaceAppFixture("shared");

try {
  await testWorkspaceAppBuildResolution();
  await testWorkspaceAppStartupValidation();
  await testDerivedChatGptUrls();
  await testPublicProbeHeaders();
  await testLiveChatGptProbe();
  await testPublicChatGptProbe();
  await testPublicExternalClientProbe();
  await testPublicExternalClientProbeReadOnly();
  await testProjectMemoryHttpMcpFlow();
  await testPublicProbeExplainsInvalidHost();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function createWorkspaceAppFixture(prefix: string): {
  manifestUrl: URL;
  uiDirectoryUrl: URL;
} {
  const uiDirectory = mkdtempSync(
    join(tempRoot, `workspace-app-${prefix}-build-`),
  );
  const manifestDirectory = join(uiDirectory, ".vite");
  const assetsDirectory = join(uiDirectory, "assets");
  mkdirSync(manifestDirectory, { recursive: true });
  mkdirSync(assetsDirectory, { recursive: true });
  writeFileSync(join(assetsDirectory, "workspace-app-test.js"), "export {};\n");
  writeFileSync(
    join(assetsDirectory, "workspace-app-test.css"),
    "body { color: black; }\n",
  );
  const manifestPath = join(manifestDirectory, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      "workspace-app.html": {
        file: "assets/workspace-app-test.js",
        css: ["assets/workspace-app-test.css"],
      },
    }),
  );
  return {
    manifestUrl: pathToFileURL(manifestPath),
    uiDirectoryUrl: pathToFileURL(`${uiDirectory}${sep}`),
  };
}

async function testWorkspaceAppBuildResolution(): Promise<void> {
  const uiDirectory = mkdtempSync(join(tempRoot, "workspace-app-build-"));
  const manifestDirectory = join(uiDirectory, ".vite");
  const assetsDirectory = join(uiDirectory, "assets");
  mkdirSync(manifestDirectory, { recursive: true });
  mkdirSync(assetsDirectory, { recursive: true });
  writeFileSync(join(assetsDirectory, "workspace-app-test.js"), "export {};\n");
  writeFileSync(
    join(assetsDirectory, "workspace-app-test.css"),
    "body { color: black; }\n",
  );
  const manifestPath = join(manifestDirectory, "manifest.json");
  const manifest = {
    "workspace-app.html": {
      file: "assets/workspace-app-test.js",
      css: ["assets/workspace-app-test.css"],
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const paths = {
    manifestUrl: pathToFileURL(manifestPath),
    uiDirectoryUrl: pathToFileURL(`${uiDirectory}${sep}`),
  };
  const first = resolveWorkspaceAppBuild(paths);
  assert.match(
    first.resourceUri,
    /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/,
  );
  assert.match(first.buildFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);

  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const second = resolveWorkspaceAppBuild(paths);
  assert.notEqual(second.resourceUri, first.resourceUri);
  assert.notEqual(second.buildFingerprint, first.buildFingerprint);
  assert.notEqual(second.manifestSha256, first.manifestSha256);

  writeFileSync(
    manifestPath,
    JSON.stringify({
      "workspace-app.html": {
        file: "../outside.js",
      },
    }),
  );
  assert.throws(() => resolveWorkspaceAppBuild(paths), /invalid asset path/i);
}

async function testWorkspaceAppStartupValidation(): Promise<void> {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: mkdtempSync(join(tempRoot, "config-app-startup-")),
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: mkdtempSync(join(tempRoot, "state-app-startup-")),
    DEVSPACE_WORKTREE_ROOT: mkdtempSync(
      join(tempRoot, "worktree-app-startup-"),
    ),
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
  });
  const missingManifest = pathToFileURL(
    join(tempRoot, "missing-workspace-app-manifest.json"),
  );
  assert.throws(
    () =>
      createServer(config, {
        workspaceAppBuild: { manifestUrl: missingManifest },
      }),
    /Workspace App manifest is unavailable.*npm run build/i,
  );

  const widgetsOffConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: mkdtempSync(join(tempRoot, "config-app-startup-off-")),
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: mkdtempSync(join(tempRoot, "state-app-startup-off-")),
    DEVSPACE_WORKTREE_ROOT: mkdtempSync(
      join(tempRoot, "worktree-app-startup-off-"),
    ),
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
  });
  const widgetsOff = createServer(widgetsOffConfig, {
    workspaceAppBuild: { manifestUrl: missingManifest },
  });
  widgetsOff.close();
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
  assert.equal(
    info.authorizationEndpoint,
    "https://devspace.example.com/authorize",
  );
  assert.equal(info.tokenEndpoint, "https://devspace.example.com/token");
  assert.equal(
    info.registrationEndpoint,
    "https://devspace.example.com/register",
  );
  assert.equal(info.chatgptRedirectAllowed, true);
  assert.match(info.planRequirementNote, /Verify your current ChatGPT plan/i);
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

  const { app, close } = createServer(config, {
    workspaceAppBuild: testWorkspaceAppBuild,
  });
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

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

  const { app, close } = createServer(config, {
    workspaceAppBuild: testWorkspaceAppBuild,
  });
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

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
  const artifactWorkspace = mkdtempSync(join(tempRoot, "artifact-workspace-"));
  writeFileSync(
    join(artifactWorkspace, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        artifact:
          "node -e \"const fs=require('fs');fs.mkdirSync('artifacts/probe',{recursive:true});fs.writeFileSync('artifacts/probe/result.png',Buffer.from([137,80,78,71,13,10,26,10,100,111,99,116,111,114]))\"",
      },
    }),
  );
  const port = await freePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      gitRemoteWrite: {
        enabled: true,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        approvedRepositoryRoots: [process.cwd()],
        approvedRemoteUrls: {
          origin: ["https://github.com/example/devspace.git"],
        },
      },
    }),
  );
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: `${process.cwd()},${artifactWorkspace}`,
    DEVSPACE_TOOL_MODE: "full",
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

  const { app, close } = createServer(config, {
    workspaceAppBuild: testWorkspaceAppBuild,
  });
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

  try {
    const probe = await probePublicExternalClientFlow(config, {
      workspacePath: process.cwd(),
      verifySafeGitTools: true,
      backgroundJob: {
        runner: "npm",
        args: ["run", "typecheck"],
      },
    });
    assert.equal(probe.ready, true);
    assert.equal(probe.clientRegistration.ok, true);
    assert.equal(probe.authorization.ok, true);
    assert.equal(probe.tokenExchange.ok, true);
    assert.equal(probe.initialize.ok, true);
    assert.equal(probe.toolsList.ok, true);
    assert.equal(probe.toolNames?.length, 44);
    assert.equal(probe.toolNames?.includes("git_fetch"), true);
    assert.equal(probe.toolNames?.includes("git_merge"), true);
    assert.equal(probe.toolNames?.includes("git_push"), true);
    assert.equal(probe.safeGitStructuredErrorCode, "GIT_REMOTE_URL_MISMATCH");
    assert.equal(
      probe.safeGitMergeCheckoutErrorCode,
      "GIT_MANAGED_WORKTREE_REQUIRED",
    );
    assert.equal(
      probe.safeGitPushCheckoutErrorCode,
      "GIT_MANAGED_WORKTREE_REQUIRED",
    );
    assert.equal(probe.safeGitUnknownFieldRejected, true);
    const safeGitDefinitions = probe.safeGitToolDefinitions ?? {};
    assert.deepEqual(Object.keys(safeGitDefinitions).sort(), [
      "git_fetch",
      "git_merge",
      "git_push",
    ]);
    for (const tool of Object.values(safeGitDefinitions)) {
      const inputSchema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };
      assert.equal(inputSchema.additionalProperties, false);
      for (const forbidden of [
        "force",
        "forceWithLease",
        "delete",
        "tags",
        "mirror",
        "all",
        "setUpstream",
        "arbitraryRefspec",
        "pushOptions",
        "url",
        "args",
      ]) {
        assert.equal(forbidden in (inputSchema.properties ?? {}), false);
      }
      assert.equal(
        (tool._meta as { devspace?: { requiredCapability?: string } }).devspace
          ?.requiredCapability,
        "git.write",
      );
    }
    assert.deepEqual(
      Object.keys(
        (
          safeGitDefinitions.git_push.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties,
      ).sort(),
      [
        "destinationBranch",
        "expectedLocalSha",
        "expectedRemoteSha",
        "projectMemoryReceiptId",
        "remote",
        "sourceRef",
        "verifyAncestor",
        "workspaceId",
      ],
    );
    assert.equal(probe.mcpAppResourceUri.ok, true);
    assert.equal(probe.mcpAppResource.ok, true);
    assert.equal(probe.mcpAppMimeType.ok, true);
    assert.equal(probe.mcpAppEntryJavaScript.ok, true);
    assert.equal(probe.mcpAppStylesheets.ok, true);
    assert.equal(probe.mcpAppAssetCors.ok, true);
    assert.equal(probe.mcpAppBuildFingerprint.ok, true);
    assert.equal(probe.devspaceInfo.ok, true);
    assert.equal(probe.openWorkspace.ok, true);
    assert.equal(probe.listWorkspaces.ok, true);
    assert.equal(probe.resumeWorkspace.ok, true);
    for (const tool of probe.widgetToolNames ?? []) {
      assert.equal(
        isToolName(tool),
        true,
        `${tool} declares a widget but is unsupported by Workspace App`,
      );
    }
    assert.deepEqual(
      [
        "resume_workspace",
        "project_memory_preflight",
        "start_job",
        "start_capture",
        "poll_job",
        "cancel_job",
      ].filter((tool) => !probe.widgetToolNames?.includes(tool)),
      [],
    );
    assert.equal(probe.backgroundJob?.ok, true);
    assert.equal(probe.backgroundJobStatus, "succeeded");
    assert.match(probe.backgroundJobOutput ?? "", /typecheck/);
    assert.match(probe.schemaFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(
      probe.workspaceAppResourceUri ?? "",
      /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/,
    );
    assert.match(probe.workspaceAppBuildFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(probe.workspaceAppManifestSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(probe.runnerNames, [
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "dotnet",
      "cargo",
      "pytest",
      "godot",
      "godot-mono",
      "blender",
    ]);
    assert.equal(probe.workspaceRoot, process.cwd());
    assert.match(probe.workspaceId ?? "", /^ws_/);

    const cancellationProbe = await probePublicExternalClientFlow(config, {
      workspacePath: process.cwd(),
      backgroundJob: {
        runner: "npm",
        args: ["run", "test:unit"],
        cancel: true,
      },
    });
    assert.equal(cancellationProbe.ready, true);
    assert.equal(cancellationProbe.backgroundJob?.ok, true);
    assert.equal(cancellationProbe.backgroundJobStatus, "cancelled");

    const artifactProbe = await probePublicExternalClientFlow(config, {
      workspacePath: artifactWorkspace,
      backgroundJob: {
        runner: "npm",
        args: ["run", "artifact"],
        artifactRoots: ["artifacts/probe"],
      },
    });
    assert.equal(artifactProbe.ready, true);
    assert.equal(artifactProbe.backgroundJob?.ok, true);
    assert.equal(artifactProbe.artifactList?.ok, true);
    assert.equal(artifactProbe.artifactCount, 1);
    assert.match(artifactProbe.artifactSha256s?.[0] ?? "", /^[0-9a-f]{64}$/);
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
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    HOST: "127.0.0.1",
    PORT: String(port),
  });

  const { app, close } = createServer(config);
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

  try {
    const probe = await probePublicExternalClientFlow(config, {
      workspacePath: process.cwd(),
    });
    assert.equal(probe.ready, true);
    assert.equal(probe.mcpAppResourceUri.ok, true);
    assert.equal(probe.mcpAppResource.ok, true);
    assert.equal(probe.mcpAppBuildFingerprint.ok, true);
    assert.match(probe.mcpAppResourceUri.detail, /DEVSPACE_WIDGETS=off/);
    assert.equal(probe.workspaceAppResourceUri, undefined);
    assert.deepEqual(probe.toolNames, [
      "devspace_info",
      "list_workspaces",
      "list_artifacts",
      "inspect_artifact",
      "git_status",
      "git_diff",
      "resume_workspace",
      "open_workspace",
      "project_memory_preflight",
      "read",
      "grep",
      "glob",
      "ls",
      "inspect_glb",
    ]);
    assert.equal(probe.toolNames.includes("git_fetch"), false);
    assert.equal(probe.toolNames.includes("git_merge"), false);
    assert.equal(probe.toolNames.includes("git_push"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    close();
  }
}

async function testProjectMemoryHttpMcpFlow(): Promise<void> {
  const configDir = mkdtempSync(join(tempRoot, "config-project-memory-"));
  const stateDir = mkdtempSync(join(tempRoot, "state-project-memory-"));
  const workspaceRoot = mkdtempSync(
    join(tempRoot, "workspace-project-memory-"),
  );
  const worktreeRoot = mkdtempSync(join(tempRoot, "worktree-project-memory-"));
  const port = await freePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(workspaceRoot, "project-memory-probe.txt"),
    "Project Memory SHADOW HTTP probe\n",
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      allowedRoots: [workspaceRoot],
      projectMemory: {
        repositories: [
          {
            root: workspaceRoot,
            command: [
              "rtk",
              "proxy",
              "py",
              "-3.11",
              "scripts/manage_project_memory.py",
            ],
            mode: "SHADOW",
          },
        ],
      },
    }),
  );
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
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
  const task = "HTTP Project Memory SHADOW task";
  const { app, close } = createServer(config, {
    workspaceAppBuild: testWorkspaceAppBuild,
    projectMemoryRunner: async (_repository, receivedTask) => {
      assert.equal(receivedTask, task);
      return fakeProjectMemoryPreflight(receivedTask);
    },
  });
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

  try {
    const probe = await probePublicExternalClientFlow(config, {
      workspacePath: workspaceRoot,
      task,
      verifyProjectMemoryShadowTools: true,
    });
    assert.equal(probe.ready, true);
    assert.equal(probe.toolNames?.includes("project_memory_preflight"), true);
    assert.match(probe.projectMemoryReceiptId ?? "", /^[0-9a-f]{64}$/);
    assert.equal(probe.projectMemoryDecision, "observe_would_deny");
    assert.equal(probe.projectMemoryReceiptReadOutcome, "receipt_match");
    assert.equal(probe.projectMemoryMissingReadOutcome, "receipt_missing");
    assert.equal(probe.projectMemoryMissingShellOutcome, undefined);
    assert.equal(probe.projectMemoryShellSucceeded, undefined);
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

  const { app, close } = createServer(config, {
    workspaceAppBuild: testWorkspaceAppBuild,
  });
  const httpServer = await new Promise<import("node:http").Server>(
    (resolve) => {
      const server = app.listen(config.port, config.host, () =>
        resolve(server),
      );
    },
  );

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

function fakeProjectMemoryPreflight(task: string): Record<string, unknown> {
  const bundle = {
    schema_version: 1,
    selectors: { terms: [task] },
    records: ["feature:project-memory-coding-gateway"],
  };
  const unsigned = {
    schema_version: 1,
    mode: "SHADOW",
    issued_at: "2026-07-16T10:00:00Z",
    expires_at: "2099-07-16T10:15:00Z",
    task_sha256: sha256(task.trim()),
    repository_head: "0".repeat(40),
    catalog_sha256: "1".repeat(64),
    policy_sha256: "2".repeat(64),
    selected_owners: [
      {
        kind: "feature",
        id: "project-memory-coding-gateway",
        source: ".project-memory/features/project-memory-coding-gateway.yaml",
        source_sha256: "3".repeat(64),
        owner_schema_version: 2,
        safety_tier: "critical",
      },
    ],
    query_iterations: [
      {
        iteration: 1,
        engine: "v2",
        selector_sha256: "4".repeat(64),
        max_tokens: 4000,
      },
    ],
    bundle_sha256: sha256(canonicalJson(bundle)),
  };
  return {
    schema_version: 1,
    mode: "SHADOW",
    policy_mode: "SHADOW",
    decision: "observe_would_deny",
    would_deny: true,
    denial_reasons: ["legacy_owner:feature:legacy"],
    bundle,
    receipt: {
      ...unsigned,
      receipt_id: sha256(canonicalJson(unsigned)),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
