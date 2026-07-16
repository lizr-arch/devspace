import { createHash, randomBytes } from "node:crypto";
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
  openWorkspace: DoctorProbeCheck;
  toolNames?: string[];
  workspaceId?: string;
  workspaceRoot?: string;
  projectMemoryReceiptId?: string;
  projectMemoryDecision?: string;
  projectMemoryReceiptReadOutcome?: string;
  projectMemoryMissingReadOutcome?: string;
  projectMemoryMissingShellOutcome?: string;
  projectMemoryShellSucceeded?: boolean;
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
    chatgptRedirectAllowed: config.oauth.allowedRedirectHosts.includes(
      "chatgpt.com",
    ),
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
    healthzLabel: "Public /healthz responded through the configured tunnel or reverse proxy.",
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
    task?: string;
    verifyProjectMemoryShadowTools?: boolean;
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
  let openWorkspaceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP open_workspace did not run.",
  };
  let toolNames: string[] | undefined;
  let workspaceId: string | undefined;
  let workspaceRoot: string | undefined;
  let projectMemoryReceiptId: string | undefined;
  let projectMemoryDecision: string | undefined;
  let projectMemoryReceiptReadOutcome: string | undefined;
  let projectMemoryMissingReadOutcome: string | undefined;
  let projectMemoryMissingShellOutcome: string | undefined;
  let projectMemoryShellSucceeded: boolean | undefined;

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
    code = location ? new URL(location).searchParams.get("code") ?? undefined : undefined;

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
    const initialize = await postMcpJsonRpc(
      info.publicMcpUrl,
      accessToken,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "public-doctor", version: "1.0.0" },
        },
      },
    );
    const initializeJson = parseMcpResponseJson(initialize.text);
    sessionId = initialize.headers?.get("mcp-session-id") ?? undefined;
    const initializeResult = asRecord(asRecord(initializeJson)?.result);

    initializeCheck =
      initialize.ok &&
      sessionId &&
      initializeResult?.protocolVersion === "2024-11-05"
        ? okCheck(
            initialize.status,
            "External MCP initialize succeeded through the public URL.",
          )
        : initialize.ok
          ? {
              ok: false,
              status: initialize.status,
              detail:
                "MCP initialize responded, but no MCP session or expected protocolVersion was returned.",
            }
          : failedCheck(initialize, "MCP initialize did not succeed.");

    if (sessionId) {
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
      toolNames = tools
        .map((tool) => stringField(asRecord(tool), "name"))
        .filter((name): name is string => Boolean(name));
      const hasOpenWorkspace = tools.some((tool) => {
        const record = asRecord(tool);
        return record?.name === "open_workspace";
      });

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
        const structuredContent = asRecord(openWorkspaceResult?.structuredContent);
        workspaceId = stringField(structuredContent, "workspaceId");
        workspaceRoot = stringField(structuredContent, "root");
        const projectMemory = asRecord(structuredContent?.projectMemory);
        projectMemoryReceiptId = stringField(projectMemory, "receiptId");
        projectMemoryDecision = stringField(projectMemory, "decision");

        openWorkspaceCheck =
          openWorkspace.ok && workspaceId && workspaceRoot === input.workspacePath
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

        const readToolName = config.toolNaming === "legacy" ? "read_file" : "read";
        const shellToolName = config.toolNaming === "legacy" ? "run_shell" : "bash";
        if (
          input.verifyProjectMemoryShadowTools &&
          workspaceId &&
          projectMemoryReceiptId &&
          toolNames.includes(readToolName) &&
          toolNames.includes(shellToolName)
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

  return {
    publicBaseUrl: info.publicBaseUrl,
    clientRegistration: clientRegistrationCheck,
    authorization: authorizationCheck,
    tokenExchange: tokenExchangeCheck,
    initialize: initializeCheck,
    toolsList: toolsListCheck,
    openWorkspace: openWorkspaceCheck,
    toolNames,
    workspaceId,
    workspaceRoot,
    projectMemoryReceiptId,
    projectMemoryDecision,
    projectMemoryReceiptReadOutcome,
    projectMemoryMissingReadOutcome,
    projectMemoryMissingShellOutcome,
    projectMemoryShellSucceeded,
    ready:
      clientRegistrationCheck.ok &&
      authorizationCheck.ok &&
      tokenExchangeCheck.ok &&
      initializeCheck.ok &&
      toolsListCheck.ok &&
      openWorkspaceCheck.ok,
  };
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

function localUrlFromPublicUrl(localBaseUrl: string, publicEndpoint: string): string {
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

function extractInvalidHostMessage(result: JsonFetchResult): string | undefined {
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
    protectedResourceJson.authorization_servers.includes(params.info.oauthIssuer);
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
    authServerJson.authorization_endpoint === params.info.authorizationEndpoint &&
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
    detail: "Skipped because OAuth authorization-server metadata was not usable.",
  };
  let authorizationPageCheck: DoctorProbeCheck = {
    ok: false,
    detail: "Skipped because client registration did not succeed.",
  };

  if (authServer.ok && authServerJson?.registration_endpoint) {
    const registration = await fetchJson(
      params.rewriteAbsoluteEndpoint(String(authServerJson.registration_endpoint)),
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
      const authorizeUrl = new URL(String(authServerJson.authorization_endpoint));
      const rewrittenAuthorizeUrl = new URL(
        params.rewriteAbsoluteEndpoint(authorizeUrl.toString()),
      );
      rewrittenAuthorizeUrl.searchParams.set("response_type", "code");
      rewrittenAuthorizeUrl.searchParams.set("client_id", clientId);
      rewrittenAuthorizeUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
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
