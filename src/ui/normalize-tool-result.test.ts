import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  genericPayloadText,
  isJobTool,
  isProjectMemoryTool,
  isToolName,
  isWorkspaceTool,
  payloadText,
} from "./card-types.js";
import { normalizeToolResult } from "./normalize-tool-result.js";

for (const tool of [
  "resume_workspace",
  "project_memory_preflight",
  "start_job",
  "start_capture",
  "poll_job",
  "cancel_job",
]) {
  assert.equal(isToolName(tool), true, `${tool} should be supported`);
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

function toolResult(result: CallToolResult): CallToolResult {
  return result;
}
