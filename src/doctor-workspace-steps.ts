import type { ServerConfig } from "./config.js";
import {
  type ChatGptWebInfo,
  type DoctorProbeCheck,
  type ExternalProbeInput,
} from "./doctor-types.js";
import {
  postMcpJsonRpc,
  parseMcpResponseJson,
  asRecord,
  stringField,
  okCheck,
  failedCheck,
  hasAdditionalRootsAuthorization,
  projectMemoryOutcome,
  mcpToolCallSucceeded,
} from "./doctor-http.js";
import {
  runSafeGitProbes,
  runJobAndArtifactProbes,
} from "./doctor-external-steps.js";

export async function runWorkspaceSessionProbes(params: {
  config: ServerConfig;
  info: ChatGptWebInfo;
  accessToken: string;
  sessionId?: string;
  input: ExternalProbeInput;
  toolNames: string[];
}): Promise<{
  openWorkspaceCheck: DoctorProbeCheck;
  listWorkspacesCheck: DoctorProbeCheck;
  resumeWorkspaceCheck: DoctorProbeCheck;
  backgroundJobCheck?: DoctorProbeCheck;
  artifactListCheck?: DoctorProbeCheck;
  artifactPublicationCheck?: DoctorProbeCheck;
  safeGitStructuredErrorCode?: string;
  safeGitMergeCheckoutErrorCode?: string;
  safeGitPushCheckoutErrorCode?: string;
  safeGitUnknownFieldRejected?: boolean;
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
}> {
  const { config, info, accessToken, sessionId, input, toolNames } = params;

  let openWorkspaceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP open_workspace did not run.",
  };
  let listWorkspacesCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP list_workspaces did not run.",
  };
  let resumeWorkspaceCheck: DoctorProbeCheck = {
    ok: false,
    detail: "MCP resume_workspace did not run.",
  };
  let backgroundJobCheck: DoctorProbeCheck | undefined;
  let artifactListCheck: DoctorProbeCheck | undefined;
  let artifactPublicationCheck: DoctorProbeCheck | undefined;
  let safeGitStructuredErrorCode: string | undefined;
  let safeGitMergeCheckoutErrorCode: string | undefined;
  let safeGitPushCheckoutErrorCode: string | undefined;
  let safeGitUnknownFieldRejected: boolean | undefined;
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
  const openWorkspaceResult = asRecord(asRecord(openWorkspaceJson)?.result);
  const structuredContent = asRecord(openWorkspaceResult?.structuredContent);
  workspaceId = stringField(structuredContent, "workspaceId");
  workspaceRoot = stringField(structuredContent, "root");
  const projectMemory = asRecord(structuredContent?.projectMemory);
  projectMemoryReceiptId = stringField(projectMemory, "receiptId");
  projectMemoryDecision = stringField(projectMemory, "decision");

  openWorkspaceCheck =
    openWorkspace.ok &&
    workspaceId &&
    workspaceRoot === input.workspacePath &&
    hasAdditionalRootsAuthorization(structuredContent)
      ? okCheck(
          openWorkspace.status,
          "External MCP open_workspace succeeded through the public tunnel.",
        )
      : openWorkspace.ok
        ? {
            ok: false,
            status: openWorkspace.status,
            detail:
              "MCP open_workspace responded, but the expected workspace identity or additional-root authorization state was missing.",
          }
        : failedCheck(openWorkspace, "MCP open_workspace did not succeed.");

  if (
    input.verifySafeGitTools &&
    workspaceId &&
    toolNames.includes("git_fetch")
  ) {
    const gitRes = await runSafeGitProbes({
      info,
      accessToken,
      sessionId,
      workspaceId,
    });
    safeGitStructuredErrorCode = gitRes.safeGitStructuredErrorCode;
    safeGitMergeCheckoutErrorCode = gitRes.safeGitMergeCheckoutErrorCode;
    safeGitPushCheckoutErrorCode = gitRes.safeGitPushCheckoutErrorCode;
    safeGitUnknownFieldRejected = gitRes.safeGitUnknownFieldRejected;
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
    const expectedListedWorkspaceId = input.resumeWorkspaceId ?? workspaceId;
    const listedWorkspace = listed
      .map(asRecord)
      .find(
        (entry) =>
          stringField(entry, "workspaceId") === expectedListedWorkspaceId,
      );
    const containsWorkspace =
      Boolean(listedWorkspace) &&
      hasAdditionalRootsAuthorization(listedWorkspace) &&
      Array.isArray(listedWorkspace?.additionalRoots);
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
                "MCP list_workspaces responded, but the workspace or additional-root authorization state was missing.",
            }
          : failedCheck(listWorkspaces, "MCP list_workspaces did not succeed.");
  }

  const resumeTargetWorkspaceId = input.resumeWorkspaceId ?? workspaceId;
  const resumeTargetRoot = input.resumeWorkspaceRoot ?? input.workspacePath;
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
      stringField(resumeStructured, "root") === resumeTargetRoot &&
      hasAdditionalRootsAuthorization(resumeStructured)
        ? okCheck(
            resumeWorkspace.status,
            "MCP resume_workspace restored the persisted session.",
          )
        : resumeWorkspace.ok
          ? {
              ok: false,
              status: resumeWorkspace.status,
              detail:
                "MCP resume_workspace responded, but the workspace identity, root, or additional-root authorization state was invalid.",
            }
          : failedCheck(
              resumeWorkspace,
              "MCP resume_workspace did not succeed.",
            );
  }

  const operationWorkspaceId = input.resumeWorkspaceId ?? workspaceId;
  if (operationWorkspaceId) {
    const jobRes = await runJobAndArtifactProbes({
      info,
      accessToken,
      sessionId,
      operationWorkspaceId,
      input,
      toolNames,
    });
    backgroundJobCheck = jobRes.backgroundJobCheck;
    artifactListCheck = jobRes.artifactListCheck;
    artifactPublicationCheck = jobRes.artifactPublicationCheck;
    backgroundJobId = jobRes.backgroundJobId;
    backgroundJobStatus = jobRes.backgroundJobStatus;
    backgroundArtifactStatus = jobRes.backgroundArtifactStatus;
    backgroundArtifactErrors = jobRes.backgroundArtifactErrors;
    backgroundJobOutput = jobRes.backgroundJobOutput;
    artifactCount = jobRes.artifactCount;
    artifactSha256s = jobRes.artifactSha256s;
    artifactPaths = jobRes.artifactPaths;
    artifactSizes = jobRes.artifactSizes;
    publishedArtifactUrl = jobRes.publishedArtifactUrl;
    publishedArtifactSha256 = jobRes.publishedArtifactSha256;
    publishedArtifactBytes = jobRes.publishedArtifactBytes;
  }

  const readToolName = config.toolNaming === "legacy" ? "read_file" : "read";
  const shellToolName = config.toolNaming === "legacy" ? "run_shell" : "bash";
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
    projectMemoryReceiptReadOutcome = projectMemoryOutcome(receiptRead.text);

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
    projectMemoryMissingReadOutcome = projectMemoryOutcome(missingRead.text);

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

  return {
    openWorkspaceCheck,
    listWorkspacesCheck,
    resumeWorkspaceCheck,
    backgroundJobCheck,
    artifactListCheck,
    artifactPublicationCheck,
    safeGitStructuredErrorCode,
    safeGitMergeCheckoutErrorCode,
    safeGitPushCheckoutErrorCode,
    safeGitUnknownFieldRejected,
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
  };
}
