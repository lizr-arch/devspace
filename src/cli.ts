#!/usr/bin/env node
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { loadConfig } from "./config.js";
import {
  deriveChatGptWebInfo,
  probePublicExternalClientFlow,
  probeLocalChatGptFlow,
  probePublicChatGptFlow,
} from "./doctor.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import {
  runCoachIngestCommand,
  runCoachPackCommand,
  runCoachSessionCommand,
} from "./bridge/commands.js";
import { runCollabCommand, runWorkerCommand } from "./cli-collab.js";
import {
  runHandoffCommand,
  runDelegateCommand,
  runRunCommand,
  runTimelineCommand,
  runMcpCommand,
} from "./cli-delegate.js";
import {
  printHelp,
  normalizeOptionalPublicBaseUrl,
  normalizePublicBaseUrl,
  validatePort,
  validateRequiredPublicBaseUrl,
  assertSupportedNode,
  nodeVersionStatus,
  SetupCancelledError,
  checkSqliteNative,
  checkGitAvailable,
  checkBashShell,
} from "./cli-help.js";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "config"
  | "help"
  | "collab"
  | "worker"
  | "handoff"
  | "delegate"
  | "run"
  | "timeline"
  | "mcp"
  | "coach-pack"
  | "coach-ingest"
  | "coach-session";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "collab":
      await runCollabCommand(args);
      return;
    case "worker":
      await runWorkerCommand(args);
      return;
    case "handoff":
      await runHandoffCommand(args);
      return;
    case "delegate":
      await runDelegateCommand(args);
      return;
    case "run":
      await runRunCommand(args);
      return;
    case "timeline":
      await runTimelineCommand(args);
      return;
    case "coach-pack":
      await runCoachPackCommand(args);
      return;
    case "coach-ingest":
      await runCoachIngestCommand(args);
      return;
    case "coach-session":
      await runCoachSessionCommand(args);
      return;
    case "mcp":
      await runMcpCommand(args);
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config")
    return command;
  if (command === "help" || command === "--help" || command === "-h")
    return "help";
  if (
    command === "collab" ||
    command === "worker" ||
    command === "handoff" ||
    command === "delegate" ||
    command === "run" ||
    command === "timeline" ||
    command === "mcp" ||
    command === "coach-pack" ||
    command === "coach-ingest" ||
    command === "coach-session"
  )
    return command;
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

type TextPromptOptions = Omit<
  Parameters<typeof prompts.text>[0],
  "validate"
> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) =>
      options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) =>
        value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(
      await textPrompt({
        message: files.config.publicBaseUrl
          ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
          : "What is the public base URL?",
        placeholder:
          files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }),
    );

    const config: DevspaceUserConfig = {
      ...files.config,
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn(
        "warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*",
      );
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runDoctor(args: string[] = []): Promise<void> {
  const isJson = args.includes("--json");
  const live = args.includes("--live");
  const fullLoop = args.includes("--full-loop");
  const publicProbe = args.includes("--public") || fullLoop;
  const files = loadDevspaceFiles();

  if (!isJson) {
    console.log(`Config dir: ${files.dir}`);
    console.log(
      `Config file: ${files.configExists ? files.configPath : "missing"}`,
    );
    console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
    console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
    console.log(`Node ABI: ${process.versions.modules}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
    console.log(`Git: ${checkGitAvailable()}`);
    console.log(`Bash shell: ${checkBashShell()}`);
    console.log(`SQLite native dependency: ${checkSqliteNative()}`);
  }

  try {
    const config = loadConfig();
    const workspaceArgIndex = args.indexOf("--workspace");
    const fullLoopWorkspace =
      workspaceArgIndex !== -1 && args[workspaceArgIndex + 1]
        ? args[workspaceArgIndex + 1]
        : config.allowedRoots[0];
    const chatgpt = deriveChatGptWebInfo(config);

    const jsonReport: Record<string, unknown> = {
      system: {
        configDir: files.dir,
        configFile: files.configExists ? files.configPath : null,
        authFile: files.authExists ? files.authPath : null,
        node: process.version,
        nodeStatus: nodeVersionStatus(),
        nodeAbi: process.versions.modules,
        platform: `${process.platform} ${process.arch}`,
        git: checkGitAvailable(),
        shell: checkBashShell(),
        sqlite: checkSqliteNative(),
      },
      config: {
        localMcpUrl: `http://${config.host}:${config.port}/mcp`,
        publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
        allowedRoots: config.allowedRoots,
        allowedHosts: config.allowedHosts,
        chatgpt,
      },
    };

    if (!isJson) {
      console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
      console.log(
        `Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`,
      );
      console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
      console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
      console.log("");
      console.log("ChatGPT Web:");
      console.log(`  Public base URL: ${chatgpt.publicBaseUrl}`);
      console.log(`  Public MCP URL: ${chatgpt.publicMcpUrl}`);
      console.log(`  OAuth issuer: ${chatgpt.oauthIssuer}`);
      console.log(
        `  OAuth protected-resource metadata: ${chatgpt.protectedResourceMetadataUrl}`,
      );
      console.log(
        `  OAuth authorization-server metadata: ${chatgpt.authorizationServerMetadataUrl}`,
      );
      console.log(`  OAuth authorize endpoint: ${chatgpt.authorizationEndpoint}`);
      console.log(`  OAuth token endpoint: ${chatgpt.tokenEndpoint}`);
      console.log(
        `  ChatGPT redirect allowed: ${chatgpt.chatgptRedirectAllowed ? "yes" : "no"}`,
      );
      console.log(`  Reasoning control: ${chatgpt.reasoningNote}`);
      console.log(`  Plan requirement: ${chatgpt.planRequirementNote}`);
    }
    if (live) {
      const probe = await probeLocalChatGptFlow(config);
      jsonReport.liveProbe = probe;
      if (!isJson) {
        console.log(
          `  Local live probe: ${probe.ready ? "ready" : "attention needed"}`,
        );
        console.log(`    Local base URL: ${probe.localBaseUrl}`);
        console.log(
          `    /healthz: ${probe.healthz.ok ? "OK" : "FAIL"}${probe.healthz.status ? ` (${probe.healthz.status})` : ""} - ${probe.healthz.detail}`,
        );
        console.log(
          `    protected resource metadata: ${probe.protectedResourceMetadata.ok ? "OK" : "FAIL"}${probe.protectedResourceMetadata.status ? ` (${probe.protectedResourceMetadata.status})` : ""} - ${probe.protectedResourceMetadata.detail}`,
        );
        console.log(
          `    authorization server metadata: ${probe.authorizationServerMetadata.ok ? "OK" : "FAIL"}${probe.authorizationServerMetadata.status ? ` (${probe.authorizationServerMetadata.status})` : ""} - ${probe.authorizationServerMetadata.detail}`,
        );
        console.log(
          `    dynamic client registration: ${probe.clientRegistration.ok ? "OK" : "FAIL"}${probe.clientRegistration.status ? ` (${probe.clientRegistration.status})` : ""} - ${probe.clientRegistration.detail}`,
        );
        console.log(
          `    owner password page: ${probe.authorizationPage.ok ? "OK" : "FAIL"}${probe.authorizationPage.status ? ` (${probe.authorizationPage.status})` : ""} - ${probe.authorizationPage.detail}`,
        );
      }
    } else if (!isJson) {
      console.log(
        "  Local live probe: run `devspace doctor --live` while `devspace serve` is running.",
      );
    }
    if (publicProbe) {
      const probe = await probePublicChatGptFlow(config);
      jsonReport.publicProbe = probe;
      if (!isJson) {
        console.log(
          `  Public probe: ${probe.ready ? "ready" : "attention needed"}`,
        );
        if (probe.transportNote) {
          console.log(`    Transport note: ${probe.transportNote}`);
        }
        console.log(
          `    /healthz: ${probe.healthz.ok ? "OK" : "FAIL"}${probe.healthz.status ? ` (${probe.healthz.status})` : ""} - ${probe.healthz.detail}`,
        );
        console.log(
          `    protected resource metadata: ${probe.protectedResourceMetadata.ok ? "OK" : "FAIL"}${probe.protectedResourceMetadata.status ? ` (${probe.protectedResourceMetadata.status})` : ""} - ${probe.protectedResourceMetadata.detail}`,
        );
        console.log(
          `    authorization server metadata: ${probe.authorizationServerMetadata.ok ? "OK" : "FAIL"}${probe.authorizationServerMetadata.status ? ` (${probe.authorizationServerMetadata.status})` : ""} - ${probe.authorizationServerMetadata.detail}`,
        );
        console.log(
          `    dynamic client registration: ${probe.clientRegistration.ok ? "OK" : "FAIL"}${probe.clientRegistration.status ? ` (${probe.clientRegistration.status})` : ""} - ${probe.clientRegistration.detail}`,
        );
        console.log(
          `    owner password page: ${probe.authorizationPage.ok ? "OK" : "FAIL"}${probe.authorizationPage.status ? ` (${probe.authorizationPage.status})` : ""} - ${probe.authorizationPage.detail}`,
        );
      }
      if (fullLoop) {
        const external = await probePublicExternalClientFlow(config, {
          workspacePath: fullLoopWorkspace,
        });
        jsonReport.externalProbe = external;
        if (!isJson) {
          console.log(
            `  Public external client probe: ${external.ready ? "ready" : "attention needed"}`,
          );
          console.log(`    Workspace path: ${fullLoopWorkspace}`);
          console.log(
            `    client registration: ${external.clientRegistration.ok ? "OK" : "FAIL"}${external.clientRegistration.status ? ` (${external.clientRegistration.status})` : ""} - ${external.clientRegistration.detail}`,
          );
          console.log(
            `    owner password approval: ${external.authorization.ok ? "OK" : "FAIL"}${external.authorization.status ? ` (${external.authorization.status})` : ""} - ${external.authorization.detail}`,
          );
          console.log(
            `    token exchange: ${external.tokenExchange.ok ? "OK" : "FAIL"}${external.tokenExchange.status ? ` (${external.tokenExchange.status})` : ""} - ${external.tokenExchange.detail}`,
          );
          console.log(
            `    MCP initialize: ${external.initialize.ok ? "OK" : "FAIL"}${external.initialize.status ? ` (${external.initialize.status})` : ""} - ${external.initialize.detail}`,
          );
          console.log(
            `    MCP tools/list: ${external.toolsList.ok ? "OK" : "FAIL"}${external.toolsList.status ? ` (${external.toolsList.status})` : ""} - ${external.toolsList.detail}`,
          );
          console.log(
            `    MCP App resource URI: ${external.mcpAppResourceUri.ok ? "OK" : "FAIL"}${external.mcpAppResourceUri.status ? ` (${external.mcpAppResourceUri.status})` : ""} - ${external.mcpAppResourceUri.detail}`,
          );
          console.log(
            `    MCP resources/read: ${external.mcpAppResource.ok ? "OK" : "FAIL"}${external.mcpAppResource.status ? ` (${external.mcpAppResource.status})` : ""} - ${external.mcpAppResource.detail}`,
          );
          console.log(
            `    MCP App MIME type: ${external.mcpAppMimeType.ok ? "OK" : "FAIL"}${external.mcpAppMimeType.status ? ` (${external.mcpAppMimeType.status})` : ""} - ${external.mcpAppMimeType.detail}`,
          );
          console.log(
            `    MCP App entry JavaScript: ${external.mcpAppEntryJavaScript.ok ? "OK" : "FAIL"}${external.mcpAppEntryJavaScript.status ? ` (${external.mcpAppEntryJavaScript.status})` : ""} - ${external.mcpAppEntryJavaScript.detail}`,
          );
          console.log(
            `    MCP App stylesheets: ${external.mcpAppStylesheets.ok ? "OK" : "FAIL"}${external.mcpAppStylesheets.status ? ` (${external.mcpAppStylesheets.status})` : ""} - ${external.mcpAppStylesheets.detail}`,
          );
          console.log(
            `    MCP App asset CORS: ${external.mcpAppAssetCors.ok ? "OK" : "FAIL"}${external.mcpAppAssetCors.status ? ` (${external.mcpAppAssetCors.status})` : ""} - ${external.mcpAppAssetCors.detail}`,
          );
          console.log(
            `    MCP App build fingerprint: ${external.mcpAppBuildFingerprint.ok ? "OK" : "FAIL"}${external.mcpAppBuildFingerprint.status ? ` (${external.mcpAppBuildFingerprint.status})` : ""} - ${external.mcpAppBuildFingerprint.detail}`,
          );
          console.log(
            `    Workspace App telemetry: ${external.workspaceAppTelemetryTool.ok ? "OK" : "FAIL"}${external.workspaceAppTelemetryTool.status ? ` (${external.workspaceAppTelemetryTool.status})` : ""} - ${external.workspaceAppTelemetryTool.detail}`,
          );
          console.log(
            `    MCP devspace_info: ${external.devspaceInfo.ok ? "OK" : "FAIL"}${external.devspaceInfo.status ? ` (${external.devspaceInfo.status})` : ""} - ${external.devspaceInfo.detail}`,
          );
          console.log(
            `    MCP open_workspace: ${external.openWorkspace.ok ? "OK" : "FAIL"}${external.openWorkspace.status ? ` (${external.openWorkspace.status})` : ""} - ${external.openWorkspace.detail}`,
          );
          console.log(
            `    MCP list_workspaces: ${external.listWorkspaces.ok ? "OK" : "FAIL"}${external.listWorkspaces.status ? ` (${external.listWorkspaces.status})` : ""} - ${external.listWorkspaces.detail}`,
          );
          console.log(
            `    MCP resume_workspace: ${external.resumeWorkspace.ok ? "OK" : "FAIL"}${external.resumeWorkspace.status ? ` (${external.resumeWorkspace.status})` : ""} - ${external.resumeWorkspace.detail}`,
          );
          if (external.workspaceId) {
            console.log(`    workspaceId: ${external.workspaceId}`);
          }
          if (external.workspaceRoot) {
            console.log(`    workspace root: ${external.workspaceRoot}`);
          }
        }
      } else if (!isJson) {
        console.log(
          "  Public external client probe: run `devspace doctor --public --full-loop` to verify OAuth token exchange and a real open_workspace tool call through the public URL.",
        );
      }
    } else if (!isJson) {
      console.log(
        "  Public probe: run `devspace doctor --public` while your tunnel or reverse proxy is live.",
      );
    }

    if (isJson) {
      console.log(JSON.stringify(jsonReport, null, 2));
    }
  } catch (error) {
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `Config status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error(`Missing ${key ?? "configuration"} value.`);
  }

  if (key === "publicBaseUrl") {
    writeDevspaceConfig({
      ...files.config,
      publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
    });
    console.log(`Updated ${files.configPath}`);
    return;
  }
  if (key === "toolMode") {
    if (value !== "minimal" && value !== "full") {
      throw new Error("toolMode must be `minimal` or `full`.");
    }
    writeDevspaceConfig({
      ...files.config,
      toolMode: value,
    });
    console.log(`Updated ${files.configPath}`);
    return;
  }
  if (key === "widgets") {
    if (
      value !== "off" &&
      value !== "changes" &&
      value !== "review_only" &&
      value !== "full"
    ) {
      throw new Error(
        "widgets must be `off`, `changes`, `review_only`, or `full`.",
      );
    }
    writeDevspaceConfig({
      ...files.config,
      widgets: value,
    });
    console.log(`Updated ${files.configPath}`);
    return;
  }
  if (key === "mcpTransportMode") {
    if (value !== "stateless" && value !== "stateful") {
      throw new Error("mcpTransportMode must be `stateless` or `stateful`.");
    }
    writeDevspaceConfig({
      ...files.config,
      mcpTransportMode: value,
    });
    console.log(`Updated ${files.configPath}`);
    return;
  }
  if (
    key === "mcpSessionIdleTtlSeconds" ||
    key === "mcpSessionMaxSessions" ||
    key === "mcpSessionSweepIntervalSeconds"
  ) {
    const parsed = Number(value);
    const limits =
      key === "mcpSessionIdleTtlSeconds"
        ? { minimum: 30, maximum: 3600 }
        : key === "mcpSessionMaxSessions"
          ? { minimum: 8, maximum: 1024 }
          : { minimum: 5, maximum: 300 };
    if (
      !Number.isInteger(parsed) ||
      parsed < limits.minimum ||
      parsed > limits.maximum
    ) {
      throw new Error(
        `${key} must be an integer from ${limits.minimum} to ${limits.maximum}.`,
      );
    }
    const mcpSessions = {
      ...files.config.mcpSessions,
      ...(key === "mcpSessionIdleTtlSeconds" ? { idleTtlSeconds: parsed } : {}),
      ...(key === "mcpSessionMaxSessions" ? { maxSessions: parsed } : {}),
      ...(key === "mcpSessionSweepIntervalSeconds"
        ? { sweepIntervalSeconds: parsed }
        : {}),
    };
    const effectiveIdleTtlSeconds = mcpSessions.idleTtlSeconds ?? 300;
    const effectiveSweepIntervalSeconds =
      mcpSessions.sweepIntervalSeconds ?? 30;
    if (effectiveSweepIntervalSeconds > effectiveIdleTtlSeconds) {
      throw new Error(
        "mcpSessionSweepIntervalSeconds must not exceed mcpSessionIdleTtlSeconds.",
      );
    }
    writeDevspaceConfig({
      ...files.config,
      mcpSessions,
    });
    console.log(`Updated ${files.configPath}`);
    return;
  }

  throw new Error(
    "Supported configuration keys are `publicBaseUrl`, `toolMode`, `widgets`, `mcpTransportMode`, `mcpSessionIdleTtlSeconds`, `mcpSessionMaxSessions`, and `mcpSessionSweepIntervalSeconds`.",
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
