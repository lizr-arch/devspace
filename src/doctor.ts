import type { ServerConfig } from "./config.js";
import {
  type ChatGptWebInfo,
  type DoctorProbeCheck,
  type ChatGptLiveProbe,
  type ChatGptPublicProbe,
  type PublicExternalClientProbe,
  type ExternalProbeInput,
  CHATGPT_REDIRECT_URI,
} from "./doctor-types.js";
import {
  publicProbeRequestInitForBaseUrl,
  publicUrl,
  stripTrailingSlash,
  localBaseUrlFor,
  localUrlFromPublicUrl,
  okCheck,
  failedCheck,
  asRecord,
  stringField,
  toolVisibility,
  publicProbeTransportNote,
  probeChatGptFlowAtBaseUrl,
  withJsonBody,
  withFormBody,
  fetchJson,
  fetchText,
  createPkcePair,
  postMcpJsonRpc,
  parseMcpResponseJson,
} from "./doctor-http.js";
import {
  requestedExternalJob,
  requestedExternalArtifacts,
} from "./doctor-external-steps.js";
import {
  runWorkspaceAppProbes,
  runDevspaceInfoProbes,
} from "./doctor-app-steps.js";
import { runWorkspaceSessionProbes } from "./doctor-workspace-steps.js";

export {
  CHATGPT_REDIRECT_URI,
  type ChatGptWebInfo,
  type DoctorProbeCheck,
  type ChatGptLiveProbe,
  type ChatGptPublicProbe,
  type PublicExternalClientProbe,
  publicProbeRequestInitForBaseUrl,
};

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
  input: ExternalProbeInput,
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
  let houdiniInfoCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP houdini_info did not run.",
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

      const appRes = await runWorkspaceAppProbes({
        config,
        info,
        accessToken,
        sessionId,
        requestInit,
        toolsListStatus: toolsList.status,
        advertisedAppResourceUris,
        appOnlyTools,
      });
      mcpAppResourceUriCheck = appRes.mcpAppResourceUriCheck;
      mcpAppResourceCheck = appRes.mcpAppResourceCheck;
      mcpAppMimeTypeCheck = appRes.mcpAppMimeTypeCheck;
      mcpAppEntryJavaScriptCheck = appRes.mcpAppEntryJavaScriptCheck;
      mcpAppStylesheetsCheck = appRes.mcpAppStylesheetsCheck;
      mcpAppAssetCorsCheck = appRes.mcpAppAssetCorsCheck;
      mcpAppBuildFingerprintCheck = appRes.mcpAppBuildFingerprintCheck;
      workspaceAppTelemetryToolCheck = appRes.workspaceAppTelemetryToolCheck;
      workspaceAppResourceUri = appRes.workspaceAppResourceUri;

      const infoRes = await runDevspaceInfoProbes({
        config,
        info,
        accessToken,
        sessionId,
        input,
        toolNames,
        workspaceAppResourceUri,
      });
      devspaceInfoCheck = infoRes.devspaceInfoCheck;
      if (infoRes.sessionReuseCheck) {
        sessionReuseCheck = infoRes.sessionReuseCheck;
      }
      if (infoRes.mcpAppBuildFingerprintCheck) {
        mcpAppBuildFingerprintCheck = infoRes.mcpAppBuildFingerprintCheck;
      }
      schemaFingerprint = infoRes.schemaFingerprint;
      workspaceAppBuildFingerprint = infoRes.workspaceAppBuildFingerprint;
      workspaceAppManifestSha256 = infoRes.workspaceAppManifestSha256;
      runnerNames = infoRes.runnerNames;
      sessionReuseCreatedDelta = infoRes.sessionReuseCreatedDelta;
      sessionReuseTotalCreatedDelta = infoRes.sessionReuseTotalCreatedDelta;

      if (toolNames.includes("houdini_info")) {
        const houdiniInfo = await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: { name: "houdini_info", arguments: {} },
          },
          sessionId,
        );
        const houdiniInfoResult = asRecord(
          asRecord(parseMcpResponseJson(houdiniInfo.text))?.result,
        );
        const structured = asRecord(houdiniInfoResult?.structuredContent);
        const productEdition = stringField(structured, "productEdition");
        const licenseStatus = stringField(structured, "licenseStatus");
        const diagnostic = stringField(structured, "diagnostic");
        const valid =
          typeof structured?.hythonAvailable === "boolean" &&
          typeof structured?.hbatchAvailable === "boolean" &&
          [
            "commercial",
            "indie",
            "education",
            "apprentice_non_commercial",
            "engine",
            "unknown",
          ].includes(productEdition ?? "") &&
          ["available", "unavailable", "unknown"].includes(
            licenseStatus ?? "",
          ) &&
          Boolean(diagnostic) &&
          !/(?:license_?key|password|secret|bearer\s+[A-Za-z0-9])/i.test(
            diagnostic ?? "",
          );
        houdiniInfoCheck =
          houdiniInfo.ok && valid
            ? okCheck(
                houdiniInfo.status,
                "MCP houdini_info returned sanitized discovery and license-safe preflight state.",
              )
            : houdiniInfo.ok
              ? {
                  ok: false,
                  status: houdiniInfo.status,
                  detail:
                    "MCP houdini_info responded, but its safe structured contract was incomplete.",
                }
              : failedCheck(houdiniInfo, "MCP houdini_info did not succeed.");
      }

      if (hasOpenWorkspace) {
        const wsRes = await runWorkspaceSessionProbes({
          config,
          info,
          accessToken,
          sessionId,
          input,
          toolNames,
        });
        openWorkspaceCheck = wsRes.openWorkspaceCheck;
        listWorkspacesCheck = wsRes.listWorkspacesCheck;
        resumeWorkspaceCheck = wsRes.resumeWorkspaceCheck;
        backgroundJobCheck = wsRes.backgroundJobCheck;
        artifactListCheck = wsRes.artifactListCheck;
        artifactPublicationCheck = wsRes.artifactPublicationCheck;
        safeGitStructuredErrorCode = wsRes.safeGitStructuredErrorCode;
        safeGitMergeCheckoutErrorCode = wsRes.safeGitMergeCheckoutErrorCode;
        safeGitPushCheckoutErrorCode = wsRes.safeGitPushCheckoutErrorCode;
        safeGitUnknownFieldRejected = wsRes.safeGitUnknownFieldRejected;
        workspaceId = wsRes.workspaceId;
        workspaceRoot = wsRes.workspaceRoot;
        projectMemoryReceiptId = wsRes.projectMemoryReceiptId;
        projectMemoryDecision = wsRes.projectMemoryDecision;
        projectMemoryReceiptReadOutcome = wsRes.projectMemoryReceiptReadOutcome;
        projectMemoryMissingReadOutcome = wsRes.projectMemoryMissingReadOutcome;
        projectMemoryMissingShellOutcome =
          wsRes.projectMemoryMissingShellOutcome;
        projectMemoryShellSucceeded = wsRes.projectMemoryShellSucceeded;
        backgroundJobStatus = wsRes.backgroundJobStatus;
        backgroundJobId = wsRes.backgroundJobId;
        backgroundArtifactStatus = wsRes.backgroundArtifactStatus;
        backgroundArtifactErrors = wsRes.backgroundArtifactErrors;
        backgroundJobOutput = wsRes.backgroundJobOutput;
        artifactCount = wsRes.artifactCount;
        artifactSha256s = wsRes.artifactSha256s;
        artifactPaths = wsRes.artifactPaths;
        artifactSizes = wsRes.artifactSizes;
        publishedArtifactUrl = wsRes.publishedArtifactUrl;
        publishedArtifactSha256 = wsRes.publishedArtifactSha256;
        publishedArtifactBytes = wsRes.publishedArtifactBytes;
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
    houdiniInfo: houdiniInfoCheck,
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
      houdiniInfoCheck.ok &&
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
