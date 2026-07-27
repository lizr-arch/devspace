import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  assetCardValue,
  genericPayloadText,
  isAssetIntakeTool,
  isJobTool,
  isProjectMemoryTool,
  isToolName,
  isWorkspaceTool,
  payloadText,
  summaryBadgeText,
  TOOL_NAMES,
} from "./card-types.js";
import { normalizeToolResult } from "./normalize-tool-result.js";
import { attachRegisteredToolName } from "../tool-result-metadata.js";

for (const tool of TOOL_NAMES) {
  assert.equal(isToolName(tool), true, `${tool} should be supported`);
  const normalized = normalizeToolResult(
    toolResult(
      attachRegisteredToolName(tool, {
        content: [{ type: "text", text: `${tool} completed` }],
        structuredContent: { result: `${tool} completed` },
      }) as CallToolResult,
    ),
  );
  assert.equal(normalized.tool, tool);
  assert.match(payloadText(normalized.payload), new RegExp(tool));
}

const resumed = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Resumed workspace ws_test" }],
    _meta: {
      tool: "resume_workspace",
      card: { workspaceId: "ws_test", root: "/workspace" },
    },
    structuredContent: {
      workspaceId: "ws_test",
      root: "/workspace",
      summary: { agentsFiles: 1, skills: 2 },
    },
  }),
);
assert.equal(isWorkspaceTool(resumed.tool), true);
assert.equal(resumed.workspaceId, "ws_test");
assert.equal(resumed.root, "/workspace");
assert.match(payloadText(resumed.payload), /Resumed workspace/);

const projectMemory = normalizeToolResult(
  toolResult({
    content: [
      {
        type: "text",
        text: "Project Memory SHADOW status: ready\nDecision: allow",
      },
    ],
    _meta: { tool: "project_memory_preflight" },
    structuredContent: {
      result: "Project Memory SHADOW status: ready",
      projectMemory: { status: "ready", decision: "allow" },
    },
  }),
);
assert.equal(isProjectMemoryTool(projectMemory.tool), true);
assert.match(payloadText(projectMemory.payload), /SHADOW status: ready/);

const started = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Started job_1. Poll with poll_job." }],
    _meta: {
      tool: "start_job",
      card: {
        workspaceId: "ws_test",
        summary: { jobId: "job_1", status: "running" },
      },
    },
    structuredContent: {
      result: "Started job_1",
      job: { jobId: "job_1", status: "running" },
    },
  }),
);
assert.equal(isJobTool(started.tool), true);
assert.equal(started.summary?.jobId, "job_1");
assert.match(payloadText(started.payload), /Poll with poll_job/);

const polled = normalizeToolResult(
  toolResult({
    content: [
      {
        type: "text",
        text: "job_1: succeeded\nOutput:\nformat check passed",
      },
    ],
    _meta: {
      tool: "poll_job",
      card: {
        workspaceId: "ws_test",
        summary: { jobId: "job_1", status: "succeeded" },
      },
    },
    structuredContent: {
      result: "job_1: succeeded",
      job: { jobId: "job_1", status: "succeeded" },
    },
  }),
);
assert.equal(polled.summary?.status, "succeeded");
assert.match(payloadText(polled.payload), /format check passed/);

const unknown = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Future tool completed." }],
    _meta: { tool: "future_tool" },
    structuredContent: { result: "ok", count: 42 },
  }),
);
assert.equal(unknown.tool, "future_tool");
assert.equal(unknown.success, true);
assert.equal(unknown.status, "success");
assert.match(genericPayloadText(unknown), /Future tool completed/);
assert.match(genericPayloadText(unknown), /Structured content/);
assert.match(genericPayloadText(unknown), /"count": 42/);

const failedUnknown = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Future tool failed." }],
    _meta: { tool: "future_tool" },
    isError: true,
  }),
);
assert.equal(failedUnknown.success, false);
assert.equal(failedUnknown.status, "error");

const missingToolMeta = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Result without tool metadata." }],
    structuredContent: { result: "still readable" },
  }),
);
assert.equal(missingToolMeta.tool, "unknown_tool");
assert.equal(missingToolMeta.status, "success");
assert.match(
  genericPayloadText(missingToolMeta),
  /Result without tool metadata/,
);

const structuredPayloadWins = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "raw content" }],
    _meta: {
      tool: "poll_job",
      card: { payload: { content: [{ type: "text", text: "meta payload" }] } },
    },
    structuredContent: {
      payload: {
        content: [{ type: "text", text: "structured payload" }],
      },
    },
  }),
);
assert.equal(payloadText(structuredPayloadWins.payload), "structured payload");

const metaPayloadWins = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "raw content" }],
    _meta: {
      tool: "poll_job",
      card: { payload: { content: [{ type: "text", text: "meta payload" }] } },
    },
  }),
);
assert.equal(payloadText(metaPayloadWins.payload), "meta payload");

const artifactList = normalizeToolResult(
  toolResult({
    content: [
      {
        type: "text",
        text: "artifact_1 | present | PNG\nartifact_2 | present | PNG",
      },
    ],
    _meta: {
      tool: "list_artifacts",
      card: { summary: { count: 2, type: "image" } },
    },
    structuredContent: {
      result: "2 artifacts",
      artifacts: [{ artifactId: "artifact_1" }, { artifactId: "artifact_2" }],
    },
  }),
);
assert.equal(summaryBadgeText(artifactList), "2 artifacts");

const payloadLineFallback = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "first\nsecond" }],
    _meta: { tool: "ls" },
  }),
);
assert.equal(summaryBadgeText(payloadLineFallback), "2 lines");

const importPngCard = normalizeToolResult(
  toolResult({
    content: [
      {
        type: "text",
        text: "Imported reference.png (68 bytes, 1x1, sha256 abc) as artifact_test.",
      },
    ],
    _meta: {
      tool: "import_png",
      card: {
        workspaceId: "ws_test",
        path: "reference.png",
        summary: {
          width: 1,
          height: 1,
          artifactId: "artifact_test",
          overwritten: false,
        },
      },
    },
    structuredContent: {
      result: "Imported reference.png.",
      path: "reference.png",
      artifactId: "artifact_test",
    },
  }),
);
assert.equal(importPngCard.tool, "import_png");
assert.equal(importPngCard.path, "reference.png");
assert.equal(importPngCard.summary?.artifactId, "artifact_test");
assert.match(payloadText(importPngCard.payload), /artifact_test/);
assert.equal(isAssetIntakeTool(importPngCard.tool), true);
assert.equal(summaryBadgeText(importPngCard), "verified");

const approvedAssetCard = normalizeToolResult(
  toolResult({
    content: [
      {
        type: "text",
        text: "Archived human-approved PNG reference.png.",
      },
    ],
    _meta: {
      tool: "archive_approved_image",
      card: {
        workspaceId: "ws_test",
        path: "reference.png",
        summary: {
          sha256: "a".repeat(64),
          width: 1672,
          height: 941,
          artifactId: "artifact_test",
          assetReceiptId: `asset_receipt_${"b".repeat(64)}`,
          humanApproval: { status: "passed", actor: "human_user" },
          readyForPipeline: true,
        },
      },
    },
    structuredContent: {
      result: "Archived human-approved PNG reference.png.",
      path: "reference.png",
      outcome: "created",
      readyForPipeline: true,
    },
  }),
);
assert.equal(isAssetIntakeTool(approvedAssetCard.tool), true);
assert.equal(assetCardValue(approvedAssetCard, "outcome"), "created");
assert.equal(assetCardValue(approvedAssetCard, "sha256"), "a".repeat(64));
assert.equal(summaryBadgeText(approvedAssetCard), "created");

const approvedAssetSearch = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "Found one approved asset." }],
    _meta: { tool: "find_approved_assets" },
    structuredContent: {
      result: "Found one approved asset.",
      count: 1,
      assets: [
        {
          assetReceiptId: `asset_receipt_${"c".repeat(64)}`,
          destinationPath: "source_assets/reference.png",
          sha256: "d".repeat(64),
          sourceFileId: "file_reference",
          current: true,
        },
      ],
    },
  }),
);
assert.equal(summaryBadgeText(approvedAssetSearch), "1 asset");

const gitDiff = normalizeToolResult(
  toolResult({
    content: [{ type: "text", text: "diff --git a/a.ts b/a.ts" }],
    _meta: { tool: "git_diff" },
    structuredContent: {
      result: "diff available",
      diff: { patch: "diff --git a/a.ts b/a.ts\n+const stable = true;" },
    },
  }),
);
assert.match(gitDiff.payload?.patch ?? "", /stable = true/);

const rapidResults = [
  "resume_workspace",
  "project_memory_preflight",
  "read",
  "grep",
].map((tool) =>
  normalizeToolResult(
    toolResult({
      content: [{ type: "text", text: `${tool} result` }],
      _meta: { tool },
    }),
  ),
);
assert.equal(rapidResults.at(-1)?.tool, "grep");
assert.notEqual(rapidResults[1].tool, rapidResults[0].tool);

function toolResult(result: CallToolResult): CallToolResult {
  return result;
}
