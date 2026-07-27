import { createHash, randomBytes } from "node:crypto";
import { JOB_RUNNERS, type JobRunner } from "./background-jobs.js";
import type { ServerConfig } from "./config.js";

export const CHATGPT_REDIRECT_URI =
  "https://chatgpt.com/connector_platform_oauth_redirect";

export interface ChatGptWebInfo {
  publicBaseUrl: string;
  publicMcpUrl: string;
  oauthIssuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  protectedResourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  chatgptRedirectAllowed: boolean;
  reasoningNote: string;
  planRequirementNote: string;
}

export interface DoctorProbeCheck {
  ok: boolean;
  status?: number;
  detail: string;
}

export interface ChatGptLiveProbe {
  localBaseUrl: string;
  healthz: DoctorProbeCheck;
  protectedResourceMetadata: DoctorProbeCheck;
  authorizationServerMetadata: DoctorProbeCheck;
  clientRegistration: DoctorProbeCheck;
  authorizationPage: DoctorProbeCheck;
  ready: boolean;
}

export interface ChatGptPublicProbe {
  publicBaseUrl: string;
  transportNote?: string;
  healthz: DoctorProbeCheck;
  protectedResourceMetadata: DoctorProbeCheck;
  authorizationServerMetadata: DoctorProbeCheck;
  clientRegistration: DoctorProbeCheck;
  authorizationPage: DoctorProbeCheck;
  ready: boolean;
}

export interface PublicExternalClientProbe {
  publicBaseUrl: string;
  clientRegistration: DoctorProbeCheck;
  authorization: DoctorProbeCheck;
  tokenExchange: DoctorProbeCheck;
  initialize: DoctorProbeCheck;
  toolsList: DoctorProbeCheck;
  mcpAppResourceUri: DoctorProbeCheck;
  mcpAppResource: DoctorProbeCheck;
  mcpAppMimeType: DoctorProbeCheck;
  mcpAppEntryJavaScript: DoctorProbeCheck;
  mcpAppStylesheets: DoctorProbeCheck;
  mcpAppAssetCors: DoctorProbeCheck;
  mcpAppBuildFingerprint: DoctorProbeCheck;
  workspaceAppTelemetryTool: DoctorProbeCheck;
  devspaceInfo: DoctorProbeCheck;
  openWorkspace: DoctorProbeCheck;
  listWorkspaces: DoctorProbeCheck;
  resumeWorkspace: DoctorProbeCheck;
  sessionReuse?: DoctorProbeCheck;
  backgroundJob?: DoctorProbeCheck;
  artifactList?: DoctorProbeCheck;
  artifactPublication?: DoctorProbeCheck;
  toolNames?: string[];
  appOnlyToolNames?: string[];
  widgetToolNames?: string[];
  safeGitToolDefinitions?: Record<string, Record<string, unknown>>;
  safeGitStructuredErrorCode?: string;
  safeGitMergeCheckoutErrorCode?: string;
  safeGitPushCheckoutErrorCode?: string;
  safeGitUnknownFieldRejected?: boolean;
  runnerNames?: string[];
  schemaFingerprint?: string;
  workspaceAppResourceUri?: string;
  workspaceAppBuildFingerprint?: string;
  workspaceAppManifestSha256?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  projectMemoryReceiptId?: string;
  projectMemoryDecision?: string;
  projectMemoryReceiptReadOutcome?: string;
  projectMemoryMissingReadOutcome?: string;
  projectMemoryMissingShellOutcome?: string;
  projectMemoryShellSucceeded?: boolean;
  backgroundJobStatus?: string;
  backgroundJobId?: string;
  backgroundArtifactStatus?: string;
  backgroundArtifactErrors?: string[];
  backgroundJobOutput?: string;
  artifactCount?: number;
  artifactSha256s?: string[];
  artifactPaths?: string[];
  artifactSizes?: number[];
  publishedArtifactUrl?: string;
  publishedArtifactSha256?: string;
  publishedArtifactBytes?: number;
  sessionReuseCalls?: number;
  sessionReuseCreatedDelta?: number;
  sessionReuseTotalCreatedDelta?: number;
  sessionConcurrentCalls?: number;
  ready: boolean;
}

interface JsonFetchResult {
  ok: boolean;
  status?: number;
  text?: string;
  json?: unknown;
  error?: string;
}

export function deriveChatGptWebInfo(config: ServerConfig): ChatGptWebInfo {
  const publicBaseUrl = stripTrailingSlash(config.publicBaseUrl);

  return {
    publicBaseUrl,
    publicMcpUrl: publicUrl(publicBaseUrl, "/mcp"),
    oauthIssuer: publicUrl(publicBaseUrl, "/"),
    authorizationEndpoint: publicUrl(publicBaseUrl, "/authorize"),
    tokenEndpoint: publicUrl(publicBaseUrl, "/token"),
    registrationEndpoint: publicUrl(publicBaseUrl, "/register"),
    protectedResourceMetadataUrl: publicUrl(
      publicBaseUrl,
      "/.well-known/oauth-protected-resource/mcp",
    ),
    authorizationServerMetadataUrl: publicUrl(
      publicBaseUrl,
      "/.well-known/oauth-authorization-server",
    ),
    chatgptRedirectAllowed:
      config.oauth.allowedRedirectHosts.includes("chatgpt.com"),
    reasoningNote:
      "Choose the highest reasoning option in ChatGPT itself. DevSpace cannot force the model or reasoning tier from the MCP server.",
    planRequirementNote:
      "OpenAI controls developer mode eligibility and MCP write permissions. Verify your current ChatGPT plan, developer mode availability, and connector tool permissions in ChatGPT before assuming the blocker is on DevSpace.",
  };
}

export async function probeLocalChatGptFlow(
  config: ServerConfig,
): Promise<ChatGptLiveProbe> {
  const info = deriveChatGptWebInfo(config);
  const localBaseUrl = localBaseUrlFor(config);
  const probe = await probeChatGptFlowAtBaseUrl({
    baseUrl: localBaseUrl,
    info,
    healthzLabel: "Local /healthz responded.",
    transportNote: undefined,
    rewriteAbsoluteEndpoint: (endpoint) =>
      localUrlFromPublicUrl(localBaseUrl, endpoint),
  });

  return {
    localBaseUrl,
    healthz: probe.healthz,
    protectedResourceMetadata: probe.protectedResourceMetadata,
    authorizationServerMetadata: probe.authorizationServerMetadata,
    clientRegistration: probe.clientRegistration,
    authorizationPage: probe.authorizationPage,
    ready: probe.ready,
  };
}

export async function probePublicChatGptFlow(
  config: ServerConfig,
): Promise<ChatGptPublicProbe> {
  const info = deriveChatGptWebInfo(config);
  const transportNote = publicProbeTransportNote(info.publicBaseUrl);
  const probe = await probeChatGptFlowAtBaseUrl({
    baseUrl: info.publicBaseUrl,
    info,
    healthzLabel:
      "Public /healthz responded through the configured tunnel or reverse proxy.",
    requestInit: publicProbeRequestInitForBaseUrl(info.publicBaseUrl),
    transportNote,
    rewriteAbsoluteEndpoint: (endpoint) => endpoint,
  });

  return {
    publicBaseUrl: info.publicBaseUrl,
    transportNote,
    healthz: probe.healthz,
    protectedResourceMetadata: probe.protectedResourceMetadata,
    authorizationServerMetadata: probe.authorizationServerMetadata,
    clientRegistration: probe.clientRegistration,
    authorizationPage: probe.authorizationPage,
    ready: probe.ready,
  };
}

export async function probePublicExternalClientFlow(
  config: ServerConfig,
  input: {
    workspacePath: string;
    resumeWorkspaceId?: string;
    resumeWorkspaceRoot?: string;
    task?: string;
    verifyProjectMemoryShadowTools?: boolean;
    verifySafeGitTools?: boolean;
    backgroundJob?: {
      runner: JobRunner;
      args: string[];
      cancel?: boolean;
      artifactRoots?: string[];
      timeoutSeconds?: number;
    };
    captureProfile?: string;
    inspectArtifactJobId?: string;
    publishArtifactPath?: string;
    sessionReuseCalls?: number;
    sessionConcurrentCalls?: number;
  },
): Promise<PublicExternalClientProbe> {
  const info = deriveChatGptWebInfo(config);
  const requestInit = publicProbeRequestInitForBaseUrl(info.publicBaseUrl);
  const pkce = createPkcePair();

  let clientRegistrationCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Dynamic OAuth client registration did not run.",
  };
  let authorizationCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Authorization did not run.",
  };
  let tokenExchangeCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Token exchange did not run.",
  };
  let initializeCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP initialize did not run.",
  };
  let toolsListCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP tools/list did not run.",
  };
  let mcpAppResourceUriCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App resource URI discovery did not run.",
  };
  let mcpAppResourceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP resources/read did not run.",
  };
  let mcpAppMimeTypeCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App MIME type validation did not run.",
  };
  let mcpAppEntryJavaScriptCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App entry JavaScript validation did not run.",
  };
  let mcpAppStylesheetsCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App stylesheet validation did not run.",
  };
  let mcpAppAssetCorsCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App asset CORS validation did not run.",
  };
  let mcpAppBuildFingerprintCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP App build fingerprint validation did not run.",
  };
  let workspaceAppTelemetryToolCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Workspace App telemetry tool validation did not run.",
  };
  let openWorkspaceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP open_workspace did not run.",
  };
  let devspaceInfoCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP devspace_info did not run.",
  };
  let listWorkspacesCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP list_workspaces did not run.",
  };
  let resumeWorkspaceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP resume_workspace did not run.",
  };
  let sessionReuseCheck: DoctorProbeCheck | undefined;
  let sessionReuseCreatedDelta: number | undefined;
  let sessionReuseTotalCreatedDelta: number | undefined;
  let backgroundJobCheck: DoctorProbeCheck | undefined;
  let artifactListCheck: DoctorProbeCheck | undefined;
  let artifactPublicationCheck: DoctorProbeCheck | undefined;
  let toolNames: string[] | undefined;
  let appOnlyToolNames: string[] | undefined;
  let widgetToolNames: string[] | undefined;
  let safeGitToolDefinitions:
    Record<string, Record<string, unknown>> | undefined;
  let safeGitStructuredErrorCode: string | undefined;
  let safeGitMergeCheckoutErrorCode: string | undefined;
  let safeGitPushCheckoutErrorCode: string | undefined;
  let safeGitUnknownFieldRejected: boolean | undefined;
  let runnerNames: string[] | undefined;
  let schemaFingerprint: string | undefined;
  let workspaceAppResourceUri: string | undefined;
  let workspaceAppBuildFingerprint: string | undefined;
  let workspaceAppManifestSha256: string | undefined;
  let workspaceId: string | undefined;
  let workspaceRoot: string | undefined;
  let projectMemoryReceiptId: string | undefined;
  let projectMemoryDecision: string | undefined;
  let projectMemoryReceiptReadOutcome: string | undefined;
  let projectMemoryMissingReadOutcome: string | undefined;
  let projectMemoryMissingShellOutcome: string | undefined;
  let projectMemoryShellSucceeded: boolean | undefined;
  let backgroundJobStatus: string | undefined;
  let backgroundJobId: string | undefined;
  let backgroundArtifactStatus: string | undefined;
  let backgroundArtifactErrors: string[] | undefined;
  let backgroundJobOutput: string | undefined;
  let artifactCount: number | undefined;
  let artifactSha256s: string[] | undefined;
  let artifactPaths: string[] | undefined;
  let artifactSizes: number[] | undefined;
  let publishedArtifactUrl: string | undefined;
  let publishedArtifactSha256: string | undefined;
  let publishedArtifactBytes: number | undefined;

  const registration = await fetchJson(
    info.registrationEndpoint,
    withJsonBody(requestInit, {
      redirect_uris: [CHATGPT_REDIRECT_URI],
      client_name: "ChatGPT",
    }),
  );
  const registrationJson = asRecord(registration.json);
  const clientId = stringField(registrationJson, "client_id");
  const clientSecret = stringField(registrationJson, "client_secret");
  clientRegistrationCheck =
    registration.ok && clientId
      ? okCheck(
          registration.status,
          "Dynamic OAuth client registration succeeded for the external client probe.",
        )
      : registration.ok
        ? {
            ok: false,
            status: registration.status,
            detail:
              "Dynamic OAuth client registration responded, but no client_id was issued.",
          }
        : failedCheck(
            registration,
            "Dynamic OAuth client registration did not succeed.",
          );

  let code: string | undefined;
  if (clientId) {
    const authorizeForm = new URLSearchParams();
    authorizeForm.set("response_type", "code");
    authorizeForm.set("client_id", clientId);
    authorizeForm.set("redirect_uri", CHATGPT_REDIRECT_URI);
    authorizeForm.set("code_challenge", pkce.challenge);
    authorizeForm.set("code_challenge_method", "S256");
    authorizeForm.set("scope", config.oauth.scopes.join(" "));
    authorizeForm.set("state", "devspace-doctor");
    authorizeForm.set("resource", info.publicMcpUrl);
    authorizeForm.set("owner_token", config.oauth.ownerToken);

    const authorization = await fetchText(
      info.authorizationEndpoint,
      withFormBody(requestInit, authorizeForm),
    );
    const location = authorization.headers?.get("location") ?? undefined;
    code = location
      ? (new URL(location).searchParams.get("code") ?? undefined)
      : undefined;

    authorizationCheck =
      authorization.status === 302 && code
        ? okCheck(
            authorization.status,
            "Owner password approval completed and an authorization code was issued.",
          )
        : authorization.ok
          ? {
              ok: false,
              status: authorization.status,
              detail:
                "Authorization responded, but no authorization code redirect was returned.",
            }
          : failedCheck(
              authorization,
              "Authorization did not complete successfully.",
            );
  }

  let accessToken: string | undefined;
  if (clientId && code) {
    const tokenForm = new URLSearchParams();
    tokenForm.set("grant_type", "authorization_code");
    tokenForm.set("client_id", clientId);
    if (clientSecret) tokenForm.set("client_secret", clientSecret);
    tokenForm.set("code", code);
    tokenForm.set("redirect_uri", CHATGPT_REDIRECT_URI);
    tokenForm.set("code_verifier", pkce.verifier);
    tokenForm.set("resource", info.publicMcpUrl);

    const tokenExchange = await fetchJson(
      info.tokenEndpoint,
      withFormBody(requestInit, tokenForm),
    );
    const tokenExchangeJson = asRecord(tokenExchange.json);
    accessToken = stringField(tokenExchangeJson, "access_token");

    tokenExchangeCheck =
      tokenExchange.ok && accessToken
        ? okCheck(
            tokenExchange.status,
            "OAuth token exchange succeeded and returned an access token.",
          )
        : tokenExchange.ok
          ? {
              ok: false,
              status: tokenExchange.status,
              detail:
                "OAuth token exchange responded, but no access_token was returned.",
            }
          : failedCheck(tokenExchange, "OAuth token exchange did not succeed.");
  }

  let sessionId: string | undefined;
  if (accessToken) {
    const initialize = await postMcpJsonRpc(info.publicMcpUrl, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "public-doctor", version: "1.0.0" },
      },
    });
    const initializeJson = parseMcpResponseJson(initialize.text);
    sessionId = initialize.headers?.get("mcp-session-id") ?? undefined;
    const initializeResult = asRecord(asRecord(initializeJson)?.result);

    const statelessTransport = config.mcpTransportMode === "stateless";
    initializeCheck =
      initialize.ok &&
      (statelessTransport || Boolean(sessionId)) &&
      initializeResult?.protocolVersion === "2024-11-05"
        ? okCheck(
            initialize.status,
            statelessTransport
              ? "External stateless MCP initialize succeeded through the public URL."
              : "External MCP initialize succeeded through the public URL.",
          )
        : initialize.ok
          ? {
              ok: false,
              status: initialize.status,
              detail:
                "MCP initialize responded, but its transport/session contract or expected protocolVersion was not returned.",
            }
          : failedCheck(initialize, "MCP initialize did not succeed.");

    if (sessionId || statelessTransport) {
      const toolsList = await postMcpJsonRpc(
        info.publicMcpUrl,
        accessToken,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );
      const toolsListJson = parseMcpResponseJson(toolsList.text);
      const toolsListResult = asRecord(asRecord(toolsListJson)?.result);
      const tools = Array.isArray(toolsListResult?.tools)
        ? toolsListResult.tools
        : [];
      const modelTools = tools.filter((tool) => {
        const visibility = toolVisibility(tool);
        return visibility === undefined || visibility.includes("model");
      });
      const appOnlyTools = tools.filter((tool) => {
        const visibility = toolVisibility(tool);
        return (
          visibility?.includes("app") === true && !visibility.includes("model")
        );
      });
      toolNames = modelTools
        .map((tool) => stringField(asRecord(tool), "name"))
        .filter((name): name is string => Boolean(name));
      appOnlyToolNames = appOnlyTools
        .map((tool) => stringField(asRecord(tool), "name"))
        .filter((name): name is string => Boolean(name));
      widgetToolNames = modelTools
        .filter((tool) =>
          Boolean(
            stringField(
              asRecord(asRecord(asRecord(tool)?._meta)?.ui),
              "resourceUri",
            ),
          ),
        )
        .map((tool) => stringField(asRecord(tool), "name"))
        .filter((name): name is string => Boolean(name));
      safeGitToolDefinitions = Object.fromEntries(
        modelTools
          .map((tool) => asRecord(tool))
          .filter(
            (tool): tool is Record<string, unknown> =>
              tool !== undefined &&
              ["git_fetch", "git_merge", "git_push"].includes(
                stringField(tool, "name") ?? "",
              ),
          )
          .map((tool) => [String(tool.name), tool]),
      );
      const hasOpenWorkspace = modelTools.some((tool) => {
        const record = asRecord(tool);
        return record?.name === "open_workspace";
      });
      const advertisedAppResourceUris = Array.from(
        new Set(
          modelTools
            .map((tool) =>
              stringField(
                asRecord(asRecord(asRecord(tool)?._meta)?.ui),
                "resourceUri",
              ),
            )
            .filter((uri): uri is string => Boolean(uri)),
        ),
      );

      toolsListCheck =
        toolsList.ok && hasOpenWorkspace
          ? okCheck(
              toolsList.status,
              "External MCP tools/list succeeded and exposed open_workspace.",
            )
          : toolsList.ok
            ? {
                ok: false,
                status: toolsList.status,
                detail:
                  "MCP tools/list responded, but open_workspace was not present.",
              }
            : failedCheck(toolsList, "MCP tools/list did not succeed.");

      if (config.widgets === "off") {
        const disabled = okCheck(
          toolsList.status,
          "MCP App validation skipped because DEVSPACE_WIDGETS=off.",
        );
        mcpAppResourceUriCheck = disabled;
        mcpAppResourceCheck = disabled;
        mcpAppMimeTypeCheck = disabled;
        mcpAppEntryJavaScriptCheck = disabled;
        mcpAppStylesheetsCheck = disabled;
        mcpAppAssetCorsCheck = disabled;
        mcpAppBuildFingerprintCheck = disabled;
        workspaceAppTelemetryToolCheck = disabled;
      } else if (advertisedAppResourceUris.length === 1) {
        const telemetryTool = appOnlyTools.find(
          (tool) =>
            stringField(asRecord(tool), "name") ===
            "report_workspace_app_error",
        );
        const telemetryInputProperties = asRecord(
          asRecord(asRecord(telemetryTool)?.inputSchema)?.properties,
        );
        const forbiddenTelemetryFields = ["message", "stack", "url"].filter(
          (field) => telemetryInputProperties?.[field] !== undefined,
        );
        workspaceAppTelemetryToolCheck =
          telemetryTool &&
          appOnlyTools.length === 1 &&
          forbiddenTelemetryFields.length === 0
            ? okCheck(
                toolsList.status,
                "Workspace App telemetry is app-only and excludes raw messages, stacks, and URLs.",
              )
            : {
                ok: false,
                status: toolsList.status,
                detail:
                  "Workspace App telemetry was missing, not app-only, or accepted unsafe diagnostic fields.",
              };
        workspaceAppResourceUri = advertisedAppResourceUris[0];
        mcpAppResourceUriCheck = okCheck(
          toolsList.status,
          `All widget-enabled tools advertise ${workspaceAppResourceUri}.`,
        );

        const resourceRead = await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 30,
            method: "resources/read",
            params: { uri: workspaceAppResourceUri },
          },
          sessionId,
        );
        const resourceResult = asRecord(
          asRecord(parseMcpResponseJson(resourceRead.text))?.result,
        );
        const contents = Array.isArray(resourceResult?.contents)
          ? resourceResult.contents
          : [];
        const appContent = contents
          .map(asRecord)
          .find(
            (content) =>
              stringField(content, "uri") === workspaceAppResourceUri,
          );
        const appHtml = stringField(appContent, "text");
        const appMimeType = stringField(appContent, "mimeType");

        mcpAppResourceCheck =
          resourceRead.ok && appHtml
            ? okCheck(
                resourceRead.status,
                "MCP resources/read returned the advertised Workspace App template.",
              )
            : resourceRead.ok
              ? {
                  ok: false,
                  status: resourceRead.status,
                  detail:
                    "MCP resources/read responded, but the advertised Workspace App HTML was missing.",
                }
              : failedCheck(
                  resourceRead,
                  "MCP resources/read did not return the Workspace App template.",
                );
        mcpAppMimeTypeCheck =
          appMimeType === "text/html;profile=mcp-app"
            ? okCheck(
                resourceRead.status,
                "Workspace App resource uses text/html;profile=mcp-app.",
              )
            : {
                ok: false,
                status: resourceRead.status,
                detail: `Workspace App resource returned ${appMimeType ?? "no MIME type"} instead of text/html;profile=mcp-app.`,
              };

        if (appHtml) {
          const assetUrls = extractWorkspaceAppAssetUrls(appHtml);
          const invalidAssetUrls = [
            ...assetUrls.scripts,
            ...assetUrls.stylesheets,
          ].filter(
            (url) => !isExpectedWorkspaceAppAssetUrl(url, info.publicBaseUrl),
          );
          const scriptResults =
            invalidAssetUrls.length === 0
              ? await Promise.all(
                  assetUrls.scripts.map(async (url) => ({
                    url,
                    result: await fetchText(url, requestInit),
                  })),
                )
              : [];
          const stylesheetResults =
            invalidAssetUrls.length === 0
              ? await Promise.all(
                  assetUrls.stylesheets.map(async (url) => ({
                    url,
                    result: await fetchText(url, requestInit),
                  })),
                )
              : [];
          const fetchedAssets = [...scriptResults, ...stylesheetResults];

          mcpAppEntryJavaScriptCheck =
            invalidAssetUrls.length === 0 &&
            scriptResults.length === 1 &&
            scriptResults[0]?.result.ok === true &&
            isJavaScriptContentType(
              scriptResults[0].result.headers?.get("content-type"),
            )
              ? okCheck(
                  scriptResults[0].result.status,
                  "Workspace App entry JavaScript is publicly retrievable.",
                )
              : {
                  ok: false,
                  status: scriptResults[0]?.result.status,
                  detail:
                    invalidAssetUrls.length > 0
                      ? `Workspace App HTML referenced an unexpected asset URL: ${invalidAssetUrls[0]}.`
                      : `Expected one retrievable Workspace App entry JavaScript asset; found ${assetUrls.scripts.length}.`,
                };
          mcpAppStylesheetsCheck =
            invalidAssetUrls.length === 0 &&
            stylesheetResults.length > 0 &&
            stylesheetResults.every(
              ({ result }) =>
                result.ok &&
                result.headers
                  ?.get("content-type")
                  ?.toLowerCase()
                  .startsWith("text/css") === true,
            )
              ? okCheck(
                  stylesheetResults[0]?.result.status,
                  `All ${stylesheetResults.length} Workspace App stylesheet assets are publicly retrievable.`,
                )
              : {
                  ok: false,
                  status: stylesheetResults[0]?.result.status,
                  detail:
                    invalidAssetUrls.length > 0
                      ? `Workspace App HTML referenced an unexpected asset URL: ${invalidAssetUrls[0]}.`
                      : `Expected retrievable Workspace App stylesheets; found ${assetUrls.stylesheets.length}.`,
                };
          mcpAppAssetCorsCheck =
            fetchedAssets.length > 0 &&
            fetchedAssets.every(
              ({ result }) =>
                result.ok &&
                result.headers?.get("access-control-allow-origin") === "*" &&
                result.headers?.get("cross-origin-resource-policy") ===
                  "cross-origin",
            )
              ? okCheck(
                  fetchedAssets[0]?.result.status,
                  "All Workspace App assets allow cross-origin loading with CORS and CORP headers.",
                )
              : {
                  ok: false,
                  status: fetchedAssets.find(({ result }) => !result.ok)?.result
                    .status,
                  detail:
                    "One or more Workspace App assets were unavailable or missing Access-Control-Allow-Origin: * and Cross-Origin-Resource-Policy: cross-origin.",
                };
        }
      } else {
        mcpAppResourceUriCheck = {
          ok: false,
          status: toolsList.status,
          detail:
            advertisedAppResourceUris.length === 0
              ? "Widget-enabled tools did not advertise an MCP App resource URI."
              : `Widget-enabled tools advertised multiple MCP App resource URIs: ${advertisedAppResourceUris.join(", ")}.`,
        };
      }

      if (toolNames.includes("devspace_info")) {
        const devspaceInfo = await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: { name: "devspace_info", arguments: {} },
          },
          sessionId,
        );
        const devspaceInfoResult = asRecord(
          asRecord(parseMcpResponseJson(devspaceInfo.text))?.result,
        );
        const devspaceInfoStructured = asRecord(
          devspaceInfoResult?.structuredContent,
        );
        schemaFingerprint = stringField(
          devspaceInfoStructured,
          "schemaFingerprint",
        );
        const workspaceApp = asRecord(devspaceInfoStructured?.workspaceApp);
        workspaceAppBuildFingerprint = stringField(
          workspaceApp,
          "buildFingerprint",
        );
        workspaceAppManifestSha256 = stringField(
          workspaceApp,
          "manifestSha256",
        );
        const reportedWorkspaceAppResourceUri = stringField(
          workspaceApp,
          "resourceUri",
        );
        const reportedTools = Array.isArray(devspaceInfoStructured?.tools)
          ? devspaceInfoStructured.tools
          : [];
        const runnerRegistry = asRecord(devspaceInfoStructured?.runnerRegistry);
        const runnerEntries = Array.isArray(runnerRegistry?.runners)
          ? runnerRegistry.runners
          : [];
        runnerNames = runnerEntries
          .map((runner) => stringField(asRecord(runner), "name"))
          .filter((name): name is string => Boolean(name));
        const runnerRegistryValid =
          runnerNames.length === JOB_RUNNERS.length &&
          runnerEntries.every((runner) => {
            const record = asRecord(runner);
            return (
              typeof record?.enabled === "boolean" &&
              typeof record?.available === "boolean" &&
              typeof record?.executableExists === "boolean" &&
              typeof record?.maxTimeoutSeconds === "number" &&
              typeof record?.maxConcurrent === "number" &&
              typeof record?.containment === "string"
            );
          });
        devspaceInfoCheck =
          devspaceInfo.ok &&
          schemaFingerprint &&
          reportedTools.length === toolNames.length &&
          runnerRegistryValid
            ? okCheck(
                devspaceInfo.status,
                "MCP devspace_info returned the running tool schema fingerprint.",
              )
            : devspaceInfo.ok
              ? {
                  ok: false,
                  status: devspaceInfo.status,
                  detail:
                    "MCP devspace_info responded, but its fingerprint, tool catalog, or runner registry was incomplete.",
                }
              : failedCheck(devspaceInfo, "MCP devspace_info did not succeed.");

        if (
          !statelessTransport &&
          (input.sessionReuseCalls || input.sessionConcurrentCalls)
        ) {
          const requestedCalls = input.sessionReuseCalls ?? 0;
          const concurrentCalls = input.sessionConcurrentCalls ?? 0;
          if (
            !Number.isInteger(requestedCalls) ||
            requestedCalls < 0 ||
            requestedCalls > 100
          ) {
            throw new Error("sessionReuseCalls must be between 0 and 100.");
          }
          if (
            !Number.isInteger(concurrentCalls) ||
            concurrentCalls < 0 ||
            concurrentCalls > 20
          ) {
            throw new Error("sessionConcurrentCalls must be between 0 and 20.");
          }
          const initialSessionStats = asRecord(
            devspaceInfoStructured?.mcpSessions,
          );
          const initialCreated = numberField(initialSessionStats, "created");
          const initialCreatedBySource = asRecord(
            initialSessionStats?.createdBySource,
          );
          const initialDoctorCreated = numberField(
            initialCreatedBySource,
            "doctor",
          );
          let successfulCalls = 0;
          let sessionChanged = false;

          for (let call = 0; call < requestedCalls; call += 1) {
            const reused = await postMcpJsonRpc(
              info.publicMcpUrl,
              accessToken,
              {
                jsonrpc: "2.0",
                id: 10_000 + call,
                method: "tools/call",
                params: { name: "list_workspaces", arguments: { limit: 1 } },
              },
              sessionId,
            );
            const responseSessionId = reused.headers?.get("mcp-session-id");
            if (responseSessionId && responseSessionId !== sessionId) {
              sessionChanged = true;
            }
            if (reused.ok && mcpToolCallSucceeded(reused)) {
              successfulCalls += 1;
            }
          }

          const concurrentResults = await Promise.all(
            Array.from({ length: concurrentCalls }, (_, call) =>
              postMcpJsonRpc(
                info.publicMcpUrl,
                accessToken,
                {
                  jsonrpc: "2.0",
                  id: 20_000 + call,
                  method: "tools/call",
                  params: {
                    name: "list_workspaces",
                    arguments: { limit: 1 },
                  },
                },
                sessionId,
              ),
            ),
          );
          for (const reused of concurrentResults) {
            const responseSessionId = reused.headers?.get("mcp-session-id");
            if (responseSessionId && responseSessionId !== sessionId) {
              sessionChanged = true;
            }
            if (reused.ok && mcpToolCallSucceeded(reused)) {
              successfulCalls += 1;
            }
          }

          const finalInfo = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 30_000,
              method: "tools/call",
              params: { name: "devspace_info", arguments: {} },
            },
            sessionId,
          );
          const finalInfoResult = asRecord(
            asRecord(parseMcpResponseJson(finalInfo.text))?.result,
          );
          const finalInfoStructured = asRecord(
            finalInfoResult?.structuredContent,
          );
          const finalStats = asRecord(finalInfoStructured?.mcpSessions);
          const finalCreated = numberField(finalStats, "created");
          const finalCreatedBySource = asRecord(finalStats?.createdBySource);
          const finalDoctorCreated = numberField(
            finalCreatedBySource,
            "doctor",
          );
          sessionReuseCreatedDelta =
            initialDoctorCreated === undefined ||
            finalDoctorCreated === undefined
              ? undefined
              : finalDoctorCreated - initialDoctorCreated;
          sessionReuseTotalCreatedDelta =
            initialCreated === undefined || finalCreated === undefined
              ? undefined
              : finalCreated - initialCreated;
          sessionReuseCheck =
            successfulCalls === requestedCalls + concurrentCalls &&
            sessionChanged === false &&
            sessionReuseCreatedDelta === 0
              ? okCheck(
                  devspaceInfo.status,
                  `One MCP session handled ${requestedCalls} sequential and ${concurrentCalls} concurrent tool calls without creating another session.`,
                )
              : {
                  ok: false,
                  status: devspaceInfo.status,
                  detail: `Session reuse probe completed ${successfulCalls}/${requestedCalls + concurrentCalls} calls; sessionChanged=${String(sessionChanged)}; doctorCreatedDelta=${String(sessionReuseCreatedDelta)}; totalCreatedDelta=${String(sessionReuseTotalCreatedDelta)}.`,
                };
        }

        if (config.widgets !== "off") {
          const fingerprintPrefix = workspaceAppBuildFingerprint?.slice(0, 16);
          mcpAppBuildFingerprintCheck =
            Boolean(workspaceAppResourceUri) &&
            reportedWorkspaceAppResourceUri === workspaceAppResourceUri &&
            /^[0-9a-f]{64}$/.test(workspaceAppBuildFingerprint ?? "") &&
            /^[0-9a-f]{64}$/.test(workspaceAppManifestSha256 ?? "") &&
            workspaceAppResourceUri?.endsWith(`-${fingerprintPrefix}.html`) ===
              true
              ? okCheck(
                  devspaceInfo.status,
                  "devspace_info build fingerprint matches the advertised versioned Workspace App URI.",
                )
              : {
                  ok: false,
                  status: devspaceInfo.status,
                  detail:
                    "devspace_info Workspace App metadata did not match the advertised resource URI or valid build hashes.",
                };
        }
      }

      if (hasOpenWorkspace) {
        const openWorkspace = await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "open_workspace",
              arguments: {
                path: input.workspacePath,
                mode: "checkout",
                ...(input.task ? { task: input.task } : {}),
              },
            },
          },
          sessionId,
        );
        const openWorkspaceJson = parseMcpResponseJson(openWorkspace.text);
        const openWorkspaceResult = asRecord(
          asRecord(openWorkspaceJson)?.result,
        );
        const structuredContent = asRecord(
          openWorkspaceResult?.structuredContent,
        );
        workspaceId = stringField(structuredContent, "workspaceId");
        workspaceRoot = stringField(structuredContent, "root");
        const projectMemory = asRecord(structuredContent?.projectMemory);
        projectMemoryReceiptId = stringField(projectMemory, "receiptId");
        projectMemoryDecision = stringField(projectMemory, "decision");

        openWorkspaceCheck =
          openWorkspace.ok &&
          workspaceId &&
          workspaceRoot === input.workspacePath
            ? okCheck(
                openWorkspace.status,
                "External MCP open_workspace succeeded through the public tunnel.",
              )
            : openWorkspace.ok
              ? {
                  ok: false,
                  status: openWorkspace.status,
                  detail:
                    "MCP open_workspace responded, but the expected workspaceId or root was missing.",
                }
              : failedCheck(
                  openWorkspace,
                  "MCP open_workspace did not succeed.",
                );

        if (
          input.verifySafeGitTools &&
          workspaceId &&
          toolNames.includes("git_fetch")
        ) {
          const structuredFailure = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 31,
              method: "tools/call",
              params: {
                name: "git_fetch",
                arguments: { workspaceId, remote: "origin" },
              },
            },
            sessionId,
          );
          const structuredFailureResult = asRecord(
            asRecord(parseMcpResponseJson(structuredFailure.text))?.result,
          );
          const structuredFailureContent = asRecord(
            structuredFailureResult?.structuredContent,
          );
          safeGitStructuredErrorCode = stringField(
            asRecord(structuredFailureContent?.error),
            "code",
          );

          const checkoutGitCalls = await Promise.all([
            postMcpJsonRpc(
              info.publicMcpUrl,
              accessToken,
              {
                jsonrpc: "2.0",
                id: 33,
                method: "tools/call",
                params: {
                  name: "git_merge",
                  arguments: {
                    workspaceId,
                    sourceRef: "HEAD",
                    mode: "ff_only",
                    expectedHeadSha: "0".repeat(40),
                  },
                },
              },
              sessionId,
            ),
            postMcpJsonRpc(
              info.publicMcpUrl,
              accessToken,
              {
                jsonrpc: "2.0",
                id: 34,
                method: "tools/call",
                params: {
                  name: "git_push",
                  arguments: {
                    workspaceId,
                    destinationBranch: "main",
                    expectedLocalSha: "0".repeat(40),
                    expectedRemoteSha: "0".repeat(40),
                  },
                },
              },
              sessionId,
            ),
          ]);
          const checkoutErrorCode = (
            response: (typeof checkoutGitCalls)[0],
          ) => {
            const result = asRecord(
              asRecord(parseMcpResponseJson(response.text))?.result,
            );
            const structured = asRecord(result?.structuredContent);
            return stringField(asRecord(structured?.error), "code");
          };
          safeGitMergeCheckoutErrorCode = checkoutErrorCode(
            checkoutGitCalls[0],
          );
          safeGitPushCheckoutErrorCode = checkoutErrorCode(checkoutGitCalls[1]);

          const unknownField = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 32,
              method: "tools/call",
              params: {
                name: "git_fetch",
                arguments: {
                  workspaceId,
                  remote: "origin",
                  force: true,
                },
              },
            },
            sessionId,
          );
          const unknownJson = asRecord(parseMcpResponseJson(unknownField.text));
          safeGitUnknownFieldRejected =
            Boolean(asRecord(unknownJson?.error)) ||
            asRecord(unknownJson?.result)?.isError === true;
        }

        if (workspaceId && toolNames.includes("list_workspaces")) {
          const listWorkspaces = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 11,
              method: "tools/call",
              params: {
                name: "list_workspaces",
                arguments: { limit: 100 },
              },
            },
            sessionId,
          );
          const listResult = asRecord(
            asRecord(parseMcpResponseJson(listWorkspaces.text))?.result,
          );
          const listStructured = asRecord(listResult?.structuredContent);
          const listed = Array.isArray(listStructured?.workspaces)
            ? listStructured.workspaces
            : [];
          const expectedListedWorkspaceId =
            input.resumeWorkspaceId ?? workspaceId;
          const containsWorkspace = listed.some(
            (entry) =>
              stringField(asRecord(entry), "workspaceId") ===
              expectedListedWorkspaceId,
          );
          listWorkspacesCheck =
            listWorkspaces.ok && containsWorkspace
              ? okCheck(
                  listWorkspaces.status,
                  "MCP list_workspaces returned the newly opened session.",
                )
              : listWorkspaces.ok
                ? {
                    ok: false,
                    status: listWorkspaces.status,
                    detail:
                      "MCP list_workspaces responded, but the opened workspaceId was missing.",
                  }
                : failedCheck(
                    listWorkspaces,
                    "MCP list_workspaces did not succeed.",
                  );
        }

        const resumeTargetWorkspaceId = input.resumeWorkspaceId ?? workspaceId;
        const resumeTargetRoot =
          input.resumeWorkspaceRoot ?? input.workspacePath;
        if (resumeTargetWorkspaceId && toolNames.includes("resume_workspace")) {
          const resumeWorkspace = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 12,
              method: "tools/call",
              params: {
                name: "resume_workspace",
                arguments: { workspaceId: resumeTargetWorkspaceId },
              },
            },
            sessionId,
          );
          const resumeResult = asRecord(
            asRecord(parseMcpResponseJson(resumeWorkspace.text))?.result,
          );
          const resumeStructured = asRecord(resumeResult?.structuredContent);
          resumeWorkspaceCheck =
            resumeWorkspace.ok &&
            stringField(resumeStructured, "workspaceId") ===
              resumeTargetWorkspaceId &&
            stringField(resumeStructured, "root") === resumeTargetRoot
              ? okCheck(
                  resumeWorkspace.status,
                  "MCP resume_workspace restored the persisted session.",
                )
              : resumeWorkspace.ok
                ? {
                    ok: false,
                    status: resumeWorkspace.status,
                    detail:
                      "MCP resume_workspace responded, but the workspace identity or root changed.",
                  }
                : failedCheck(
                    resumeWorkspace,
                    "MCP resume_workspace did not succeed.",
                  );
        }

        const operationWorkspaceId = input.resumeWorkspaceId ?? workspaceId;
        const inspectArtifacts = async (jobId: string): Promise<void> => {
          if (!operationWorkspaceId || !toolNames?.includes("list_artifacts")) {
            return;
          }
          const listedArtifacts = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 130,
              method: "tools/call",
              params: {
                name: "list_artifacts",
                arguments: {
                  workspaceId: operationWorkspaceId,
                  jobId,
                  limit: 100,
                },
              },
            },
            sessionId,
          );
          const listedResult = asRecord(
            asRecord(parseMcpResponseJson(listedArtifacts.text))?.result,
          );
          const listedStructured = asRecord(listedResult?.structuredContent);
          const listed = Array.isArray(listedStructured?.artifacts)
            ? listedStructured.artifacts
            : [];
          artifactSha256s = listed
            .map((artifact) => stringField(asRecord(artifact), "sha256"))
            .filter((value): value is string => Boolean(value));
          artifactPaths = listed
            .map((artifact) => stringField(asRecord(artifact), "relativePath"))
            .filter((value): value is string => Boolean(value));
          artifactSizes = listed
            .map((artifact) => asRecord(artifact)?.size)
            .filter(
              (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
            );
          artifactCount = listed.length;
          artifactListCheck =
            listedArtifacts.ok &&
            listed.length > 0 &&
            artifactSha256s.length === listed.length &&
            artifactPaths.length === listed.length &&
            artifactSizes.length === listed.length &&
            artifactSha256s.every((value) => /^[0-9a-f]{64}$/.test(value))
              ? okCheck(
                  listedArtifacts.status,
                  "MCP list_artifacts returned the produced artifacts and SHA-256 digests.",
                )
              : listedArtifacts.ok
                ? {
                    ok: false,
                    status: listedArtifacts.status,
                    detail:
                      "MCP list_artifacts responded, but produced artifacts or SHA-256 digests were missing.",
                  }
                : failedCheck(
                    listedArtifacts,
                    "MCP list_artifacts did not succeed.",
                  );

          if (
            !artifactListCheck.ok ||
            !input.publishArtifactPath ||
            !toolNames?.includes("publish_artifact")
          ) {
            return;
          }
          const published = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 131,
              method: "tools/call",
              params: {
                name: "publish_artifact",
                arguments: {
                  workspaceId: operationWorkspaceId,
                  path: input.publishArtifactPath,
                  purpose: "inspection",
                  ttlSeconds: 30,
                },
              },
            },
            sessionId,
          );
          const publishedResult = asRecord(
            asRecord(parseMcpResponseJson(published.text))?.result,
          );
          const publishedStructured = asRecord(
            publishedResult?.structuredContent,
          );
          publishedArtifactUrl = stringField(publishedStructured, "url");
          publishedArtifactSha256 = stringField(publishedStructured, "sha256");
          if (published.ok && publishedArtifactUrl) {
            const artifactResponse = await fetch(publishedArtifactUrl);
            const bytes = Buffer.from(await artifactResponse.arrayBuffer());
            publishedArtifactBytes = bytes.length;
            const downloadedHash = createHash("sha256")
              .update(bytes)
              .digest("hex");
            artifactPublicationCheck =
              artifactResponse.ok &&
              downloadedHash === publishedArtifactSha256 &&
              artifactResponse.headers
                .get("cache-control")
                ?.includes("no-store") === true &&
              artifactResponse.headers.get("x-content-type-options") ===
                "nosniff"
                ? okCheck(
                    artifactResponse.status,
                    "MCP publish_artifact returned a retrievable, hash-matching, no-store artifact URL.",
                  )
                : {
                    ok: false,
                    status: artifactResponse.status,
                    detail:
                      "Published artifact bytes, digest, or security headers did not match.",
                  };
          } else {
            artifactPublicationCheck = failedCheck(
              published,
              "MCP publish_artifact did not succeed.",
            );
          }
        };
        const requestedJob = input.backgroundJob ?? input.captureProfile;
        const startToolName = input.captureProfile
          ? "start_capture"
          : "start_job";
        if (
          operationWorkspaceId &&
          requestedJob &&
          toolNames.includes(startToolName) &&
          toolNames.includes("poll_job")
        ) {
          const startedJob = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 20,
              method: "tools/call",
              params: {
                name: startToolName,
                arguments: input.captureProfile
                  ? {
                      workspaceId: operationWorkspaceId,
                      profile: input.captureProfile,
                    }
                  : {
                      workspaceId: operationWorkspaceId,
                      runner: input.backgroundJob?.runner,
                      args: input.backgroundJob?.args,
                      timeoutSeconds: input.backgroundJob?.timeoutSeconds ?? 30,
                      artifactRoots: input.backgroundJob?.artifactRoots,
                    },
              },
            },
            sessionId,
          );
          const startedJobResult = asRecord(
            asRecord(parseMcpResponseJson(startedJob.text))?.result,
          );
          const startedJobStructured = asRecord(
            startedJobResult?.structuredContent,
          );
          const startedJobSnapshot = asRecord(startedJobStructured?.job);
          const jobId = stringField(startedJobSnapshot, "jobId");
          backgroundJobId = jobId;

          if (startedJob.ok && jobId) {
            if (input.backgroundJob?.cancel) {
              await postMcpJsonRpc(
                info.publicMcpUrl,
                accessToken,
                {
                  jsonrpc: "2.0",
                  id: 21,
                  method: "tools/call",
                  params: {
                    name: "cancel_job",
                    arguments: {
                      workspaceId: operationWorkspaceId,
                      jobId,
                    },
                  },
                },
                sessionId,
              );
            }
            const pollAttempts =
              ((input.backgroundJob?.timeoutSeconds ?? 120) + 10) * 20;
            for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
              const polledJob = await postMcpJsonRpc(
                info.publicMcpUrl,
                accessToken,
                {
                  jsonrpc: "2.0",
                  id: 22 + attempt,
                  method: "tools/call",
                  params: {
                    name: "poll_job",
                    arguments: {
                      workspaceId: operationWorkspaceId,
                      jobId,
                    },
                  },
                },
                sessionId,
              );
              const polledResult = asRecord(
                asRecord(parseMcpResponseJson(polledJob.text))?.result,
              );
              const polledStructured = asRecord(
                polledResult?.structuredContent,
              );
              const polledSnapshot = asRecord(polledStructured?.job);
              backgroundJobStatus = stringField(polledSnapshot, "status");
              backgroundJobOutput = stringField(polledSnapshot, "output");
              const artifactStatus = stringField(
                polledSnapshot,
                "artifactStatus",
              );
              backgroundArtifactStatus = artifactStatus;
              backgroundArtifactErrors = Array.isArray(
                polledSnapshot?.artifactErrors,
              )
                ? polledSnapshot.artifactErrors.filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined;
              if (
                backgroundJobStatus &&
                !["running", "cancelling"].includes(backgroundJobStatus) &&
                (!(
                  input.captureProfile || input.backgroundJob?.artifactRoots
                ) ||
                  artifactStatus !== "pending")
              ) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }

          const expectedStatus = input.backgroundJob?.cancel
            ? "cancelled"
            : "succeeded";
          const expectedArtifactStatus = input.backgroundJob?.cancel
            ? "incomplete"
            : "complete";
          const artifactsExpected = Boolean(
            input.captureProfile || input.backgroundJob?.artifactRoots,
          );
          backgroundJobCheck =
            backgroundJobStatus === expectedStatus &&
            (!artifactsExpected ||
              backgroundArtifactStatus === expectedArtifactStatus)
              ? okCheck(
                  startedJob.status,
                  input.backgroundJob?.cancel
                    ? "MCP background validation job started, cancelled, and was polled successfully."
                    : input.captureProfile
                      ? "MCP capture profile started, completed, and was polled successfully."
                      : "MCP background validation job started, completed, and was polled successfully.",
                )
              : startedJob.ok
                ? {
                    ok: false,
                    status: startedJob.status,
                    detail: `MCP ${input.captureProfile ? "capture" : "background job"} did not reach ${expectedStatus} with artifact state ${artifactsExpected ? expectedArtifactStatus : "not required"}; final status was ${backgroundJobStatus ?? "unknown"} with artifacts ${backgroundArtifactStatus ?? "unknown"}.`,
                  }
                : failedCheck(startedJob, "MCP start_job did not succeed.");

          if (backgroundJobCheck.ok && jobId && artifactsExpected) {
            await inspectArtifacts(jobId);
          }
        } else if (input.inspectArtifactJobId) {
          await inspectArtifacts(input.inspectArtifactJobId);
        }

        const readToolName =
          config.toolNaming === "legacy" ? "read_file" : "read";
        const shellToolName =
          config.toolNaming === "legacy" ? "run_shell" : "bash";
        if (
          input.verifyProjectMemoryShadowTools &&
          workspaceId &&
          projectMemoryReceiptId &&
          toolNames.includes(readToolName)
        ) {
          const receiptRead = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 4,
              method: "tools/call",
              params: {
                name: readToolName,
                arguments: {
                  workspaceId,
                  path: "project-memory-probe.txt",
                  projectMemoryReceiptId,
                },
              },
            },
            sessionId,
          );
          projectMemoryReceiptReadOutcome = projectMemoryOutcome(
            receiptRead.text,
          );

          const missingRead = await postMcpJsonRpc(
            info.publicMcpUrl,
            accessToken,
            {
              jsonrpc: "2.0",
              id: 5,
              method: "tools/call",
              params: {
                name: readToolName,
                arguments: {
                  workspaceId,
                  path: "project-memory-probe.txt",
                },
              },
            },
            sessionId,
          );
          projectMemoryMissingReadOutcome = projectMemoryOutcome(
            missingRead.text,
          );

          if (toolNames.includes(shellToolName)) {
            const missingShell = await postMcpJsonRpc(
              info.publicMcpUrl,
              accessToken,
              {
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: {
                  name: shellToolName,
                  arguments: {
                    workspaceId,
                    command: "git --version",
                  },
                },
              },
              sessionId,
            );
            projectMemoryMissingShellOutcome = projectMemoryOutcome(
              missingShell.text,
            );
            projectMemoryShellSucceeded = mcpToolCallSucceeded(missingShell);
          }
        }
      }
    }
  }

  return {
    publicBaseUrl: info.publicBaseUrl,
    clientRegistration: clientRegistrationCheck,
    authorization: authorizationCheck,
    tokenExchange: tokenExchangeCheck,
    initialize: initializeCheck,
    toolsList: toolsListCheck,
    mcpAppResourceUri: mcpAppResourceUriCheck,
    mcpAppResource: mcpAppResourceCheck,
    mcpAppMimeType: mcpAppMimeTypeCheck,
    mcpAppEntryJavaScript: mcpAppEntryJavaScriptCheck,
    mcpAppStylesheets: mcpAppStylesheetsCheck,
    mcpAppAssetCors: mcpAppAssetCorsCheck,
    mcpAppBuildFingerprint: mcpAppBuildFingerprintCheck,
    workspaceAppTelemetryTool: workspaceAppTelemetryToolCheck,
    devspaceInfo: devspaceInfoCheck,
    openWorkspace: openWorkspaceCheck,
    listWorkspaces: listWorkspacesCheck,
    resumeWorkspace: resumeWorkspaceCheck,
    sessionReuse: sessionReuseCheck,
    backgroundJob: backgroundJobCheck,
    artifactList: artifactListCheck,
    artifactPublication: artifactPublicationCheck,
    toolNames,
    appOnlyToolNames,
    widgetToolNames,
    safeGitToolDefinitions,
    safeGitStructuredErrorCode,
    safeGitMergeCheckoutErrorCode,
    safeGitPushCheckoutErrorCode,
    safeGitUnknownFieldRejected,
    runnerNames,
    schemaFingerprint,
    workspaceAppResourceUri,
    workspaceAppBuildFingerprint,
    workspaceAppManifestSha256,
    workspaceId,
    workspaceRoot,
    projectMemoryReceiptId,
    projectMemoryDecision,
    projectMemoryReceiptReadOutcome,
    projectMemoryMissingReadOutcome,
    projectMemoryMissingShellOutcome,
    projectMemoryShellSucceeded,
    backgroundJobStatus,
    backgroundJobId,
    backgroundArtifactStatus,
    backgroundArtifactErrors,
    backgroundJobOutput,
    artifactCount,
    artifactSha256s,
    artifactPaths,
    artifactSizes,
    publishedArtifactUrl,
    publishedArtifactSha256,
    publishedArtifactBytes,
    sessionReuseCalls: input.sessionReuseCalls,
    sessionReuseCreatedDelta,
    sessionReuseTotalCreatedDelta,
    sessionConcurrentCalls: input.sessionConcurrentCalls,
    ready:
      clientRegistrationCheck.ok &&
      authorizationCheck.ok &&
      tokenExchangeCheck.ok &&
      initializeCheck.ok &&
      toolsListCheck.ok &&
      mcpAppResourceUriCheck.ok &&
      mcpAppResourceCheck.ok &&
      mcpAppMimeTypeCheck.ok &&
      mcpAppEntryJavaScriptCheck.ok &&
      mcpAppStylesheetsCheck.ok &&
      mcpAppAssetCorsCheck.ok &&
      mcpAppBuildFingerprintCheck.ok &&
      workspaceAppTelemetryToolCheck.ok &&
      devspaceInfoCheck.ok &&
      openWorkspaceCheck.ok &&
      listWorkspacesCheck.ok &&
      resumeWorkspaceCheck.ok &&
      (!(input.sessionReuseCalls || input.sessionConcurrentCalls) ||
        sessionReuseCheck?.ok === true) &&
      (!requestedExternalJob(input) || backgroundJobCheck?.ok === true) &&
      (!requestedExternalArtifacts(input) || artifactListCheck?.ok === true) &&
      (!input.publishArtifactPath || artifactPublicationCheck?.ok === true),
  };
}

function requestedExternalJob(input: {
  backgroundJob?: unknown;
  captureProfile?: string;
}): boolean {
  return Boolean(input.backgroundJob || input.captureProfile);
}

function requestedExternalArtifacts(input: {
  backgroundJob?: { artifactRoots?: string[] };
  captureProfile?: string;
  inspectArtifactJobId?: string;
}): boolean {
  return Boolean(
    input.captureProfile ||
    input.backgroundJob?.artifactRoots ||
    input.inspectArtifactJobId,
  );
}

export function publicProbeRequestInitForBaseUrl(
  baseUrl: string,
): RequestInit | undefined {
  const hostname = new URL(baseUrl).hostname;
  const headers: Record<string, string> = {
    "User-Agent": "DevSpaceDoctor/1.0",
  };

  if (hostname.includes("pinggy")) {
    headers["X-Pinggy-No-Screen"] = "true";
  }

  return Object.keys(headers).length > 0 ? { headers } : undefined;
}

function publicUrl(baseUrl: string, path: string): string {
  return new URL(path, `${stripTrailingSlash(baseUrl)}/`).toString();
}

function extractWorkspaceAppAssetUrls(html: string): {
  scripts: string[];
  stylesheets: string[];
} {
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>/gi))
    .map(([tag]) => htmlAttribute(tag, "src"))
    .filter((url): url is string => Boolean(url));
  const stylesheets = Array.from(html.matchAll(/<link\b[^>]*>/gi))
    .filter(([tag]) =>
      (htmlAttribute(tag, "rel") ?? "")
        .split(/\s+/)
        .some((value) => value.toLowerCase() === "stylesheet"),
    )
    .map(([tag]) => htmlAttribute(tag, "href"))
    .filter((url): url is string => Boolean(url));
  return { scripts, stylesheets };
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match?.[1] ?? match?.[2];
}

function isExpectedWorkspaceAppAssetUrl(
  candidate: string,
  publicBaseUrl: string,
): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const baseUrl = new URL(publicBaseUrl);
    return (
      candidateUrl.origin === baseUrl.origin &&
      candidateUrl.pathname.startsWith("/mcp-app-assets/") &&
      !candidateUrl.username &&
      !candidateUrl.password
    );
  } catch {
    return false;
  }
}

function isJavaScriptContentType(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return (
    normalized.startsWith("text/javascript") ||
    normalized.startsWith("application/javascript")
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function localBaseUrlFor(config: ServerConfig): string {
  const host =
    config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
  const formattedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${config.port}`;
}

function localUrl(baseUrl: string, path: string): string {
  return new URL(path, `${stripTrailingSlash(baseUrl)}/`).toString();
}

function localUrlFromPublicUrl(
  localBaseUrl: string,
  publicEndpoint: string,
): string {
  const parsed = new URL(publicEndpoint);
  return new URL(
    `${parsed.pathname}${parsed.search}`,
    `${stripTrailingSlash(localBaseUrl)}/`,
  ).toString();
}

function okCheck(status: number | undefined, detail: string): DoctorProbeCheck {
  return { ok: true, status, detail };
}

function failedCheck(
  result: JsonFetchResult,
  fallbackDetail: string,
): DoctorProbeCheck {
  return {
    ok: false,
    status: result.status,
    detail: describeFailedProbe(result, fallbackDetail),
  };
}

function describeFailedProbe(
  result: JsonFetchResult,
  fallbackDetail: string,
): string {
  const invalidHostMessage = extractInvalidHostMessage(result);
  if (invalidHostMessage) {
    return `${fallbackDetail} ${invalidHostMessage} Restart DevSpace with DEVSPACE_PUBLIC_BASE_URL set to this exact hostname, or intentionally widen DEVSPACE_ALLOWED_HOSTS for debugging.`;
  }

  return result.error ? `${fallbackDetail} ${result.error}` : fallbackDetail;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberField(
  value: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const candidate = value?.[field];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function toolVisibility(value: unknown): string[] | undefined {
  const visibility = asRecord(asRecord(asRecord(value)?._meta)?.ui)?.visibility;
  if (!Array.isArray(visibility)) return undefined;
  return visibility.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function projectMemoryOutcome(text: string | undefined): string | undefined {
  const response = asRecord(parseMcpResponseJson(text));
  const result = asRecord(response?.result);
  const metadata = asRecord(result?._meta);
  return stringField(asRecord(metadata?.projectMemory), "outcome");
}

function mcpToolCallSucceeded(result: JsonFetchResult): boolean {
  if (!result.ok) return false;
  const response = asRecord(parseMcpResponseJson(result.text));
  const toolResult = asRecord(response?.result);
  return Boolean(toolResult) && toolResult?.isError !== true;
}

function extractInvalidHostMessage(
  result: JsonFetchResult,
): string | undefined {
  for (const candidate of [result.text, result.error]) {
    if (!candidate) continue;
    const match = candidate.match(/Invalid Host:\s*([^\s"}\]]+)/i);
    if (match) {
      return `Invalid Host: ${match[1]}. DevSpace rejected the public Host header.`;
    }
  }
  return undefined;
}

function publicProbeTransportNote(baseUrl: string): string | undefined {
  const hostname = new URL(baseUrl).hostname;
  if (hostname.includes("pinggy")) {
    return "Pinggy detected. The public probe sends X-Pinggy-No-Screen=true to bypass Pinggy's browser caution page for non-browser checks. On Windows, prefer ssh -T -p 443 -R0:127.0.0.1:7676 qr@a.pinggy.io over localhost to avoid tunnel-side 502 errors.";
  }
  return undefined;
}

async function probeChatGptFlowAtBaseUrl(params: {
  baseUrl: string;
  info: ChatGptWebInfo;
  healthzLabel: string;
  requestInit?: RequestInit;
  transportNote?: string;
  rewriteAbsoluteEndpoint: (endpoint: string) => string;
}): Promise<Omit<ChatGptPublicProbe, "publicBaseUrl">> {
  const healthz = await fetchJson(
    publicUrl(params.baseUrl, "/healthz"),
    params.requestInit,
  );
  const healthzCheck = healthz.ok
    ? okCheck(healthz.status, params.healthzLabel)
    : failedCheck(healthz, "The probed /healthz endpoint did not respond.");

  const protectedResource = await fetchJson(
    publicUrl(params.baseUrl, "/.well-known/oauth-protected-resource/mcp"),
    params.requestInit,
  );
  const protectedResourceJson = asRecord(protectedResource.json);
  const protectedResourceMatches =
    protectedResource.ok &&
    protectedResourceJson?.resource === params.info.publicMcpUrl &&
    Array.isArray(protectedResourceJson.authorization_servers) &&
    protectedResourceJson.authorization_servers.includes(
      params.info.oauthIssuer,
    );
  const protectedResourceCheck = protectedResourceMatches
    ? okCheck(
        protectedResource.status,
        "OAuth protected-resource metadata matches the configured public MCP URL.",
      )
    : protectedResource.ok
      ? {
          ok: false,
          status: protectedResource.status,
          detail:
            "OAuth protected-resource metadata responded, but it does not match the configured public MCP URL or issuer.",
        }
      : failedCheck(
          protectedResource,
          "OAuth protected-resource metadata did not respond.",
        );

  const authServer = await fetchJson(
    publicUrl(params.baseUrl, "/.well-known/oauth-authorization-server"),
    params.requestInit,
  );
  const authServerJson = asRecord(authServer.json);
  const authServerMatches =
    authServer.ok &&
    authServerJson?.issuer === params.info.oauthIssuer &&
    authServerJson.authorization_endpoint ===
      params.info.authorizationEndpoint &&
    authServerJson.registration_endpoint === params.info.registrationEndpoint;
  const authServerCheck = authServerMatches
    ? okCheck(
        authServer.status,
        "OAuth authorization-server metadata matches the configured public base URL.",
      )
    : authServer.ok
      ? {
          ok: false,
          status: authServer.status,
          detail:
            "OAuth authorization-server metadata responded, but its issuer or endpoints do not match the configured public base URL.",
        }
      : failedCheck(
          authServer,
          "OAuth authorization-server metadata did not respond.",
        );

  let clientRegistrationCheck: DoctorProbeCheck = {
    ok: false,
    detail:
      "Skipped because OAuth authorization-server metadata was not usable.",
  };
  let authorizationPageCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Skipped because client registration did not succeed.",
  };

  if (authServer.ok && authServerJson?.registration_endpoint) {
    const registration = await fetchJson(
      params.rewriteAbsoluteEndpoint(
        String(authServerJson.registration_endpoint),
      ),
      withJsonBody(params.requestInit, {
        redirect_uris: [CHATGPT_REDIRECT_URI],
        client_name: "ChatGPT",
      }),
    );
    const registrationJson = asRecord(registration.json);
    const clientId = registrationJson?.client_id;

    clientRegistrationCheck =
      registration.ok && typeof clientId === "string" && clientId.length > 0
        ? okCheck(
            registration.status,
            "Dynamic OAuth client registration succeeded for the ChatGPT redirect URI.",
          )
        : registration.ok
          ? {
              ok: false,
              status: registration.status,
              detail:
                "Dynamic OAuth client registration responded, but no client_id was issued.",
            }
          : failedCheck(
              registration,
              "Dynamic OAuth client registration did not succeed.",
            );

    if (
      registration.ok &&
      typeof clientId === "string" &&
      clientId.length > 0 &&
      authServerJson.authorization_endpoint &&
      protectedResourceJson?.resource
    ) {
      const authorizeUrl = new URL(
        String(authServerJson.authorization_endpoint),
      );
      const rewrittenAuthorizeUrl = new URL(
        params.rewriteAbsoluteEndpoint(authorizeUrl.toString()),
      );
      rewrittenAuthorizeUrl.searchParams.set("response_type", "code");
      rewrittenAuthorizeUrl.searchParams.set("client_id", clientId);
      rewrittenAuthorizeUrl.searchParams.set(
        "redirect_uri",
        CHATGPT_REDIRECT_URI,
      );
      rewrittenAuthorizeUrl.searchParams.set(
        "code_challenge",
        "devspace-doctor-check",
      );
      rewrittenAuthorizeUrl.searchParams.set("code_challenge_method", "S256");
      rewrittenAuthorizeUrl.searchParams.set(
        "resource",
        String(protectedResourceJson.resource),
      );

      const authorizationPage = await fetchJson(
        rewrittenAuthorizeUrl.toString(),
        params.requestInit,
      );
      const hasOwnerPasswordPrompt =
        authorizationPage.ok &&
        (authorizationPage.text?.includes("Owner password") ?? false);

      authorizationPageCheck = hasOwnerPasswordPrompt
        ? okCheck(
            authorizationPage.status,
            "Owner password approval page rendered successfully.",
          )
        : authorizationPage.ok
          ? {
              ok: false,
              status: authorizationPage.status,
              detail:
                "Authorization page responded, but the Owner password prompt was not detected.",
            }
          : failedCheck(
              authorizationPage,
              "Authorization page did not respond.",
            );
    }
  }

  return {
    transportNote: params.transportNote,
    healthz: healthzCheck,
    protectedResourceMetadata: protectedResourceCheck,
    authorizationServerMetadata: authServerCheck,
    clientRegistration: clientRegistrationCheck,
    authorizationPage: authorizationPageCheck,
    ready:
      healthzCheck.ok &&
      protectedResourceCheck.ok &&
      authServerCheck.ok &&
      clientRegistrationCheck.ok &&
      authorizationPageCheck.ok,
  };
}

function withJsonBody(
  init: RequestInit | undefined,
  body: Record<string, unknown>,
): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Content-Type", "application/json");
  return {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
}

function withFormBody(
  init: RequestInit | undefined,
  body: URLSearchParams,
): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  return {
    ...init,
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "manual",
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<JsonFetchResult> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json: unknown;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
      ...(response.ok
        ? {}
        : { error: `HTTP ${response.status}${text ? `: ${text}` : ""}` }),
    };
  } catch (error) {
    const cause =
      error instanceof Error && "cause" in error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;
    const causeText =
      cause && typeof cause === "object" && cause !== null
        ? String(
            (cause as { code?: unknown; message?: unknown }).code ??
              (cause as { message?: unknown }).message ??
              cause,
          )
        : cause
          ? String(cause)
          : undefined;
    return {
      ok: false,
      error:
        error instanceof Error
          ? causeText
            ? `${error.message} (${causeText})`
            : error.message
          : String(error),
    };
  }
}

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<JsonFetchResult & { headers?: Headers }> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json: unknown;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
      headers: response.headers,
      ...(response.ok
        ? {}
        : { error: `HTTP ${response.status}${text ? `: ${text}` : ""}` }),
    };
  } catch (error) {
    return {
      ...(await fetchJson(url, init)),
    };
  }
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = hashSha256Base64Url(verifier);
  return { verifier, challenge };
}

function hashSha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function postMcpJsonRpc(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<JsonFetchResult & { headers?: Headers }> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  if (sessionId) headers.set("mcp-session-id", sessionId);

  return fetchText(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function parseMcpResponseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const parsed = tryParseJson(line.slice(5).trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
