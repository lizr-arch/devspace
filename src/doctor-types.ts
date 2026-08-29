import { type JobRunner } from "./background-jobs.js";

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
  houdiniInfo: DoctorProbeCheck;
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
  sessionConcurrentCalls?: number;
  sessionReuseCreatedDelta?: number;
  sessionReuseTotalCreatedDelta?: number;
  ready: boolean;
}

export interface JsonFetchResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  json?: unknown;
  headers?: Headers;
  error?: string;
}

export interface TextFetchResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  headers?: Headers;
  error?: string;
}

export interface ExternalProbeInput {
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
}
