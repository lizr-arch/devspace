import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.js";
import {
  type ChatGptWebInfo,
  type DoctorProbeCheck,
  type ChatGptPublicProbe,
  type JsonFetchResult,
  CHATGPT_REDIRECT_URI,
} from "./doctor-types.js";

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

export function publicUrl(baseUrl: string, path: string): string {
  return new URL(path, `${stripTrailingSlash(baseUrl)}/`).toString();
}

export function extractWorkspaceAppAssetUrls(html: string): {
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

export function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match?.[1] ?? match?.[2];
}

export function isExpectedWorkspaceAppAssetUrl(
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

export function isJavaScriptContentType(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return (
    normalized.startsWith("text/javascript") ||
    normalized.startsWith("application/javascript")
  );
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function localBaseUrlFor(config: ServerConfig): string {
  const host =
    config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
  const formattedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${config.port}`;
}

export function localUrl(baseUrl: string, path: string): string {
  return new URL(path, `${stripTrailingSlash(baseUrl)}/`).toString();
}

export function localUrlFromPublicUrl(
  localBaseUrl: string,
  publicEndpoint: string,
): string {
  const parsed = new URL(publicEndpoint);
  return new URL(
    `${parsed.pathname}${parsed.search}`,
    `${stripTrailingSlash(localBaseUrl)}/`,
  ).toString();
}

export function okCheck(status: number | undefined, detail: string): DoctorProbeCheck {
  return { ok: true, status, detail };
}

export function failedCheck(
  result: JsonFetchResult,
  fallbackDetail: string,
): DoctorProbeCheck {
  return {
    ok: false,
    status: result.status,
    detail: describeFailedProbe(result, fallbackDetail),
  };
}

export function describeFailedProbe(
  result: JsonFetchResult,
  fallbackDetail: string,
): string {
  const invalidHostMessage = extractInvalidHostMessage(result);
  if (invalidHostMessage) {
    return `${fallbackDetail} ${invalidHostMessage} Restart DevSpace with DEVSPACE_PUBLIC_BASE_URL set to this exact hostname, or intentionally widen DEVSPACE_ALLOWED_HOSTS for debugging.`;
  }

  return result.error ? `${fallbackDetail} ${result.error}` : fallbackDetail;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === "string" ? candidate : undefined;
}

export function numberField(
  value: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const candidate = value?.[field];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

export function hasAdditionalRootsAuthorization(
  value: Record<string, unknown> | undefined,
): boolean {
  return (
    Array.isArray(value?.requestedAdditionalRoots) &&
    Array.isArray(value?.effectiveAdditionalRoots) &&
    Array.isArray(value?.rejectedAdditionalRoots) &&
    value?.additionalRootsScope === "in_memory_session" &&
    value?.additionalRootsPersisted === false
  );
}

export function toolVisibility(value: unknown): string[] | undefined {
  const visibility = asRecord(asRecord(asRecord(value)?._meta)?.ui)?.visibility;
  if (!Array.isArray(visibility)) return undefined;
  return visibility.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

export function projectMemoryOutcome(text: string | undefined): string | undefined {
  const response = asRecord(parseMcpResponseJson(text));
  const result = asRecord(response?.result);
  const metadata = asRecord(result?._meta);
  return stringField(asRecord(metadata?.projectMemory), "outcome");
}

export function mcpToolCallSucceeded(result: JsonFetchResult): boolean {
  if (!result.ok) return false;
  const response = asRecord(parseMcpResponseJson(result.text));
  const toolResult = asRecord(response?.result);
  return Boolean(toolResult) && toolResult?.isError !== true;
}

export function extractInvalidHostMessage(
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

export function publicProbeTransportNote(baseUrl: string): string | undefined {
  const hostname = new URL(baseUrl).hostname;
  if (hostname.includes("pinggy")) {
    return "Pinggy detected. The public probe sends X-Pinggy-No-Screen=true to bypass Pinggy's browser caution page for non-browser checks. On Windows, prefer ssh -T -p 443 -R0:127.0.0.1:7676 qr@a.pinggy.io over localhost to avoid tunnel-side 502 errors.";
  }
  return undefined;
}

export async function probeChatGptFlowAtBaseUrl(params: {
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

export function withJsonBody(
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

export function withFormBody(
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

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<JsonFetchResult> {
  const probeSampleId=randomUUID(),started=Date.now(),startedAt=new Date(started).toISOString();
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
      probeSampleId,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-started,
      requestId:response.headers.get("x-devspace-request-id")??undefined,
      traceId:response.headers.get("x-devspace-trace-id")??undefined,
      mcpResponsePresent:json!==undefined,
      ...(response.ok
        ? {}
        : { error: sanitizeProbeError(`HTTP ${response.status}${text ? `: ${text}` : ""}`),errorClass:response.status===401?"AUTH_FAILURE":response.status>=500?"HTTP_RESPONSE_ERROR":"MCP_PROTOCOL_ERROR" }),
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
      probeSampleId,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-started,
      errorClass:"NETWORK_OR_TUNNEL_ERROR",
      mcpResponsePresent:false,
      error:sanitizeProbeError(
        error instanceof Error
          ? causeText
            ? `${error.message} (${causeText})`
            : error.message
          : String(error)),
    };
  }
}

function sanitizeProbeError(value:string):string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|authorization)=?[^\s&]*/gi,"$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g,"[redacted-token]").slice(0,512);
}

export async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<JsonFetchResult & { headers?: Headers }> {
  const probeSampleId=randomUUID(),started=Date.now(),startedAt=new Date(started).toISOString();
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
      probeSampleId,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-started,
      requestId:response.headers.get("x-devspace-request-id")??undefined,
      traceId:response.headers.get("x-devspace-trace-id")??undefined,
      mcpResponsePresent:json!==undefined,
      ...(response.ok
        ? {}
        : { error: sanitizeProbeError(`HTTP ${response.status}${text ? `: ${text}` : ""}`),errorClass:response.status===401?"AUTH_FAILURE":response.status>=500?"HTTP_RESPONSE_ERROR":"MCP_PROTOCOL_ERROR" }),
    };
  } catch (error) {
    const cause=error instanceof Error&&"cause" in error?(error as Error&{cause?:unknown}).cause:undefined;
    const causeCode=cause&&typeof cause==="object"?String((cause as {code?:unknown}).code??""):"";
    return {
      ok:false,probeSampleId,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-started,
      errorClass:/TIMEOUT|timed out|abort/i.test(error instanceof Error?error.message:"")?"TOOL_TIMEOUT":
        causeCode?"NETWORK_OR_TUNNEL_ERROR":"UNKNOWN",
      mcpResponsePresent:false,
      error:sanitizeProbeError(error instanceof Error?`${error.message}${causeCode?` (${causeCode})`:""}`:String(error)),
    };
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = hashSha256Base64Url(verifier);
  return { verifier, challenge };
}

export function hashSha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export async function postMcpJsonRpc(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<JsonFetchResult & { headers?: Headers }> {
  const traceId=randomUUID();
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  headers.set("X-DevSpace-Trace-Id",traceId);
  if (sessionId) headers.set("mcp-session-id", sessionId);

  const response=await fetchText(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {...response,traceId:response.traceId??traceId};
}

export function parseMcpResponseJson(text: string | undefined): unknown {
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

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
