import { createHash } from "node:crypto";
import { accessSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ServerConfig, WidgetMode } from "../config.js";
import { logEvent } from "../logger.js";
import {
  PACKAGE_VERSION,
  TOOL_SCHEMA_REVISION,
  WORKSPACE_APP_MANIFEST_ENTRY,
  LEGACY_WORKSPACE_APP_RESOURCE_URI,
  VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE,
  WORKSPACE_APP_RESOURCE_FINGERPRINT_PATTERN,
  type WorkspaceAppBuild,
  type WorkspaceAppManifest,
  type ToolWidgetKind,
  type ToolWidgetDescriptorMeta,
} from "./server-types.js";

export const REVIEW_ONLY_WIDGET_TOOLS = [
  "git_diff",
  "list_artifacts",
  "inspect_artifact",
  "publish_artifact",
  "import_png",
  "archive_approved_image",
  "find_approved_assets",
  "verify_approved_asset",
  "recover_approved_asset",
  "reindex_approved_assets",
  "preview_artifact",
  "inspect_glb",
  "inspect_blend",
  "inspect_audio",
  "render_model_preview",
  "capture_game_frame",
] as const;

export const reviewOnlyWidgetToolNames = new Set<string>(
  REVIEW_ONLY_WIDGET_TOOLS,
);

export function shouldAttachWidget(
  mode: WidgetMode,
  toolName: string,
  kind: ToolWidgetKind,
): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return (
        kind === "workspace" ||
        kind === "project_memory" ||
        kind === "show_changes"
      );
    case "review_only":
      return reviewOnlyWidgetToolNames.has(toolName);
    case "full":
      return true;
  }
}

export function toolWidgetDescriptorMeta(
  config: ServerConfig,
  toolName: string,
  kind: ToolWidgetKind,
  workspaceApp: WorkspaceAppBuild | undefined,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, toolName, kind)) return { _meta: {} };
  if (!workspaceApp) {
    throw new Error(
      `Workspace App build is required when DEVSPACE_WIDGETS=${config.widgets}.`,
    );
  }

  return {
    _meta: {
      ui: {
        resourceUri: workspaceApp.resourceUri,
        visibility: ["model"],
      },
    },
  };
}

export function uiManifestUrl(): URL {
  return new URL("../../dist/ui/.vite/manifest.json", import.meta.url);
}

export function uiBuildDirectoryUrl(): URL {
  return new URL("../../dist/ui/", import.meta.url);
}

export function webGptTestBuildDirectoryUrl(): URL {
  return new URL("../../dist/webgpt-test/", import.meta.url);
}

export function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

export function resolveWorkspaceAppBuild(
  input: {
    manifestUrl?: URL;
    uiDirectoryUrl?: URL;
  } = {},
): WorkspaceAppBuild {
  const manifestUrl = input.manifestUrl ?? uiManifestUrl();
  const uiDirectoryUrl = input.uiDirectoryUrl ?? uiBuildDirectoryUrl();
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestUrl, "utf8");
  } catch (error) {
    throw new Error(
      `Workspace App manifest is unavailable. Run npm run build before starting DevSpace: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let manifest: WorkspaceAppManifest;
  try {
    manifest = JSON.parse(manifestText) as WorkspaceAppManifest;
  } catch (error) {
    throw new Error(
      `Workspace App manifest is invalid. Run npm run build before starting DevSpace: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  const candidates = [entry.file, ...(entry.css ?? [])].map((assetPath) => {
    if (
      !assetPath ||
      assetPath.startsWith("/") ||
      assetPath.includes("\\") ||
      assetPath.split("/").includes("..")
    ) {
      throw new Error(
        `Workspace App manifest contains an invalid asset path: ${assetPath}.`,
      );
    }
    return {
      assetPath,
      url: new URL(assetPath, uiDirectoryUrl),
    };
  });
  for (const candidate of candidates) {
    try {
      accessSync(candidate.url);
    } catch (error) {
      throw new Error(
        `Workspace App asset is unavailable: ${candidate.assetPath}. Run npm run build before starting DevSpace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const manifestSha256 = createHash("sha256")
    .update(manifestText)
    .digest("hex");
  const buildFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        packageVersion: PACKAGE_VERSION,
        schemaRevision: TOOL_SCHEMA_REVISION,
        manifestSha256,
      }),
    )
    .digest("hex");

  return {
    entry,
    uiDirectoryPath: fileURLToPath(uiDirectoryUrl),
    manifestSha256,
    buildFingerprint,
    resourceUri: `ui://devspace/workspace-app-${buildFingerprint.slice(0, 16)}.html`,
  };
}

export function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

export function workspaceAppHtml(
  config: ServerConfig,
  workspaceApp: WorkspaceAppBuild,
  baseUrl = assetBaseUrl(config),
): string {
  const entry = workspaceApp.entry;
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

export function workspaceAppResourceResult(
  config: ServerConfig,
  workspaceApp: WorkspaceAppBuild,
  requestedResourceUri: string,
) {
  return {
    contents: [
      {
        uri: requestedResourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: workspaceAppHtml(config, workspaceApp),
        _meta: {
          ui: workspaceAppUiMetadata(config),
        },
      },
    ],
  };
}

export function registerWorkspaceAppResources(
  server: McpServer,
  config: ServerConfig,
  workspaceApp: WorkspaceAppBuild,
): void {
  const appResourceConfig = {
    description:
      "Versioned interactive card for viewing DevSpace workspace and tool results.",
    _meta: {
      ui: workspaceAppUiMetadata(config),
    },
  };

  registerAppResource(
    server,
    "DevSpace Workspace App",
    workspaceApp.resourceUri,
    appResourceConfig,
    async () =>
      workspaceAppResourceResult(
        config,
        workspaceApp,
        workspaceApp.resourceUri,
      ),
  );

  registerAppResource(
    server,
    "DevSpace Workspace App legacy compatibility",
    LEGACY_WORKSPACE_APP_RESOURCE_URI,
    {
      ...appResourceConfig,
      description:
        "Compatibility alias for DevSpace Workspace App cards created before versioned resource URIs.",
    },
    async () => {
      logEvent(config.logging, "info", "workspace_app_compat_resource_read", {
        compatibilityKind: "legacy",
        requestedResourceUri: LEGACY_WORKSPACE_APP_RESOURCE_URI,
        currentResourceUri: workspaceApp.resourceUri,
      });
      return workspaceAppResourceResult(
        config,
        workspaceApp,
        LEGACY_WORKSPACE_APP_RESOURCE_URI,
      );
    },
  );

  server.registerResource(
    "DevSpace Workspace App version compatibility",
    new ResourceTemplate(VERSIONED_WORKSPACE_APP_RESOURCE_TEMPLATE, {
      list: undefined,
    }),
    {
      ...appResourceConfig,
      mimeType: RESOURCE_MIME_TYPE,
      description:
        "Compatibility template for DevSpace Workspace App cards created by earlier builds.",
    },
    async (uri, variables) => {
      const requestedFingerprint = variables.buildFingerprint;
      if (
        typeof requestedFingerprint !== "string" ||
        !WORKSPACE_APP_RESOURCE_FINGERPRINT_PATTERN.test(requestedFingerprint)
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${uri.toString()} not found`,
        );
      }

      const requestedResourceUri = uri.toString();
      logEvent(config.logging, "info", "workspace_app_compat_resource_read", {
        compatibilityKind: "versioned",
        requestedResourceUri,
        currentResourceUri: workspaceApp.resourceUri,
      });
      return workspaceAppResourceResult(
        config,
        workspaceApp,
        requestedResourceUri,
      );
    },
  );
}

export function appCsp(config: Pick<ServerConfig, "publicBaseUrl">): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

export function workspaceAppUiMetadata(
  config: Pick<ServerConfig, "publicBaseUrl">,
): {
  prefersBorder: true;
  domain: string;
  csp: ReturnType<typeof appCsp>;
} {
  const domain = new URL(config.publicBaseUrl).origin;
  return {
    prefersBorder: true,
    domain,
    csp: appCsp(config),
  };
}

export function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
