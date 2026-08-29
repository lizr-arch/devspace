import { JOB_RUNNERS } from "./background-jobs.js";
import type { ServerConfig } from "./config.js";
import {
  type ChatGptWebInfo,
  type DoctorProbeCheck,
  type ExternalProbeInput,
} from "./doctor-types.js";
import {
  postMcpJsonRpc,
  parseMcpResponseJson,
  fetchText,
  asRecord,
  stringField,
  numberField,
  okCheck,
  failedCheck,
  mcpToolCallSucceeded,
  extractWorkspaceAppAssetUrls,
  isExpectedWorkspaceAppAssetUrl,
  isJavaScriptContentType,
} from "./doctor-http.js";

export async function runWorkspaceAppProbes(params: {
  config: ServerConfig;
  info: ChatGptWebInfo;
  accessToken: string;
  sessionId?: string;
  requestInit?: RequestInit;
  toolsListStatus?: number;
  advertisedAppResourceUris: string[];
  appOnlyTools: unknown[];
}): Promise<{
  mcpAppResourceUriCheck: DoctorProbeCheck;
  mcpAppResourceCheck: DoctorProbeCheck;
  mcpAppMimeTypeCheck: DoctorProbeCheck;
  mcpAppEntryJavaScriptCheck: DoctorProbeCheck;
  mcpAppStylesheetsCheck: DoctorProbeCheck;
  mcpAppAssetCorsCheck: DoctorProbeCheck;
  mcpAppBuildFingerprintCheck: DoctorProbeCheck;
  workspaceAppTelemetryToolCheck: DoctorProbeCheck;
  workspaceAppResourceUri?: string;
}> {
  const {
    config,
    info,
    accessToken,
    sessionId,
    requestInit,
    toolsListStatus,
    advertisedAppResourceUris,
    appOnlyTools,
  } = params;

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
  let workspaceAppResourceUri: string | undefined;

  if (config.widgets === "off") {
    const disabled = okCheck(
      toolsListStatus,
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
        stringField(asRecord(tool), "name") === "report_workspace_app_error",
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
            toolsListStatus,
            "Workspace App telemetry is app-only and excludes raw messages, stacks, and URLs.",
          )
        : {
            ok: false,
            status: toolsListStatus,
            detail:
              "Workspace App telemetry was missing, not app-only, or accepted unsafe diagnostic fields.",
          };
    workspaceAppResourceUri = advertisedAppResourceUris[0];
    mcpAppResourceUriCheck = okCheck(
      toolsListStatus,
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
        (content) => stringField(content, "uri") === workspaceAppResourceUri,
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
      status: toolsListStatus,
      detail:
        advertisedAppResourceUris.length === 0
          ? "Widget-enabled tools did not advertise an MCP App resource URI."
          : `Widget-enabled tools advertised multiple MCP App resource URIs: ${advertisedAppResourceUris.join(", ")}.`,
    };
  }

  return {
    mcpAppResourceUriCheck,
    mcpAppResourceCheck,
    mcpAppMimeTypeCheck,
    mcpAppEntryJavaScriptCheck,
    mcpAppStylesheetsCheck,
    mcpAppAssetCorsCheck,
    mcpAppBuildFingerprintCheck,
    workspaceAppTelemetryToolCheck,
    workspaceAppResourceUri,
  };
}

export async function runDevspaceInfoProbes(params: {
  config: ServerConfig;
  info: ChatGptWebInfo;
  accessToken: string;
  sessionId?: string;
  input: ExternalProbeInput;
  toolNames: string[];
  workspaceAppResourceUri?: string;
}): Promise<{
  devspaceInfoCheck: DoctorProbeCheck;
  sessionReuseCheck?: DoctorProbeCheck;
  mcpAppBuildFingerprintCheck?: DoctorProbeCheck;
  schemaFingerprint?: string;
  workspaceAppBuildFingerprint?: string;
  workspaceAppManifestSha256?: string;
  runnerNames?: string[];
  sessionReuseCreatedDelta?: number;
  sessionReuseTotalCreatedDelta?: number;
}> {
  const {
    config,
    info,
    accessToken,
    sessionId,
    input,
    toolNames,
    workspaceAppResourceUri,
  } = params;

  let devspaceInfoCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP devspace_info did not run.",
  };
  let sessionReuseCheck: DoctorProbeCheck | undefined;
  let mcpAppBuildFingerprintCheck: DoctorProbeCheck | undefined;
  let schemaFingerprint: string | undefined;
  let workspaceAppBuildFingerprint: string | undefined;
  let workspaceAppManifestSha256: string | undefined;
  let runnerNames: string[] | undefined;
  let sessionReuseCreatedDelta: number | undefined;
  let sessionReuseTotalCreatedDelta: number | undefined;

  const statelessTransport = config.mcpTransportMode === "stateless";

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
    const assetIntake = asRecord(devspaceInfoStructured?.assetIntake);
    const assetDownloadTimeouts = asRecord(assetIntake?.downloadTimeouts);
    const assetIntakeValid =
      numberField(assetIntake, "maxPngBytes") === 25 * 1024 * 1024 &&
      numberField(assetDownloadTimeouts, "connectOrHeadersMs") === 30_000 &&
      numberField(assetDownloadTimeouts, "idleReadMs") === 30_000 &&
      numberField(assetDownloadTimeouts, "totalMs") === 180_000 &&
      assetIntake?.signedUrlsPersisted === false;
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
      runnerRegistryValid &&
      assetIntakeValid
        ? okCheck(
            devspaceInfo.status,
            "MCP devspace_info returned the running tool schema fingerprint.",
          )
        : devspaceInfo.ok
          ? {
              ok: false,
              status: devspaceInfo.status,
              detail:
                "MCP devspace_info responded, but its fingerprint, tool catalog, runner registry, or asset-intake timeout contract was incomplete.",
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

  return {
    devspaceInfoCheck,
    sessionReuseCheck,
    mcpAppBuildFingerprintCheck,
    schemaFingerprint,
    workspaceAppBuildFingerprint,
    workspaceAppManifestSha256,
    runnerNames,
    sessionReuseCreatedDelta,
    sessionReuseTotalCreatedDelta,
  };
}
