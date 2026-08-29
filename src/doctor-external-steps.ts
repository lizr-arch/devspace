import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
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
} from "./doctor-http.js";

export function requestedExternalJob(input: {
  backgroundJob?: unknown;
  captureProfile?: string;
}): boolean {
  return Boolean(input.backgroundJob || input.captureProfile);
}

export function requestedExternalArtifacts(input: {
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

export async function runSafeGitProbes(params: {
  info: ChatGptWebInfo;
  accessToken: string;
  sessionId?: string;
  workspaceId: string;
}): Promise<{
  safeGitStructuredErrorCode?: string;
  safeGitMergeCheckoutErrorCode?: string;
  safeGitPushCheckoutErrorCode?: string;
  safeGitUnknownFieldRejected?: boolean;
}> {
  const { info, accessToken, sessionId, workspaceId } = params;

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
  const safeGitStructuredErrorCode = stringField(
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
  const checkoutErrorCode = (response: (typeof checkoutGitCalls)[0]) => {
    const result = asRecord(
      asRecord(parseMcpResponseJson(response.text))?.result,
    );
    const structured = asRecord(result?.structuredContent);
    return stringField(asRecord(structured?.error), "code");
  };
  const safeGitMergeCheckoutErrorCode = checkoutErrorCode(checkoutGitCalls[0]);
  const safeGitPushCheckoutErrorCode = checkoutErrorCode(checkoutGitCalls[1]);

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
  const safeGitUnknownFieldRejected =
    Boolean(asRecord(unknownJson?.error)) ||
    asRecord(unknownJson?.result)?.isError === true;

  return {
    safeGitStructuredErrorCode,
    safeGitMergeCheckoutErrorCode,
    safeGitPushCheckoutErrorCode,
    safeGitUnknownFieldRejected,
  };
}

export async function runJobAndArtifactProbes(params: {
  info: ChatGptWebInfo;
  accessToken: string;
  sessionId?: string;
  operationWorkspaceId: string;
  input: ExternalProbeInput;
  toolNames: string[];
}): Promise<{
  backgroundJobCheck?: DoctorProbeCheck;
  artifactListCheck?: DoctorProbeCheck;
  artifactPublicationCheck?: DoctorProbeCheck;
  backgroundJobId?: string;
  backgroundJobStatus?: string;
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
  const { info, accessToken, sessionId, operationWorkspaceId, input, toolNames } =
    params;

  let backgroundJobCheck: DoctorProbeCheck | undefined;
  let artifactListCheck: DoctorProbeCheck | undefined;
  let artifactPublicationCheck: DoctorProbeCheck | undefined;
  let backgroundJobId: string | undefined;
  let backgroundJobStatus: string | undefined;
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
    toolNames.includes("wait_job") &&
    toolNames.includes("list_jobs")
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
    let outputCursor = stringField(startedJobSnapshot, "outputCursor");
    backgroundJobId = jobId;

    if (startedJob.ok && jobId) {
      await postMcpJsonRpc(
        info.publicMcpUrl,
        accessToken,
        {
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "list_jobs",
            arguments: {
              workspaceId: operationWorkspaceId,
              limit: 10,
            },
          },
        },
        sessionId,
      );
      if (input.backgroundJob?.cancel) {
        await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 22,
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
      const waitSeconds = 5;
      const waitAttempts = Math.ceil(
        ((input.backgroundJob?.timeoutSeconds ?? 120) + 10) / waitSeconds,
      );
      for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
        const waitedJob = await postMcpJsonRpc(
          info.publicMcpUrl,
          accessToken,
          {
            jsonrpc: "2.0",
            id: 23 + attempt,
            method: "tools/call",
            params: {
              name: "wait_job",
              arguments: {
                workspaceId: operationWorkspaceId,
                jobId,
                outputCursor,
                waitSeconds,
              },
            },
          },
          sessionId,
        );
        const waitedResult = asRecord(
          asRecord(parseMcpResponseJson(waitedJob.text))?.result,
        );
        const waitedStructured = asRecord(
          waitedResult?.structuredContent,
        );
        const waitedSnapshot = asRecord(waitedStructured?.job);
        backgroundJobStatus = stringField(waitedSnapshot, "status");
        const output = stringField(waitedSnapshot, "output");
        if (output) {
          backgroundJobOutput = `${backgroundJobOutput ?? ""}${output}`;
        }
        outputCursor =
          stringField(waitedSnapshot, "outputCursor") ?? outputCursor;
        const artifactStatus = stringField(
          waitedSnapshot,
          "artifactStatus",
        );
        backgroundArtifactStatus = artifactStatus;
        backgroundArtifactErrors = Array.isArray(
          waitedSnapshot?.artifactErrors,
        )
          ? waitedSnapshot.artifactErrors.filter(
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
              ? "MCP background validation job started, recovered, cancelled, and was awaited successfully."
              : input.captureProfile
                ? "MCP capture profile started, recovered, completed, and was awaited successfully."
                : "MCP background validation job started, recovered, completed, and was awaited successfully.",
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

  return {
    backgroundJobCheck,
    artifactListCheck,
    artifactPublicationCheck,
    backgroundJobId,
    backgroundJobStatus,
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
