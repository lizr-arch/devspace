import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isToolName,
  type ToolContent,
  type ToolPayload,
  type ToolResultCard,
} from "./card-types.js";

export function normalizeToolResult(result: CallToolResult): ToolResultCard {
  const tool = toolNameFromMeta(result);
  if (!tool || !isToolName(tool)) {
    return createGenericResultCard(result, tool);
  }

  const structured = objectValue(result.structuredContent);
  const metaCard = objectValue(metaValue(result)?.card);
  const payload =
    payloadValue(structured?.payload) ??
    payloadValue(metaCard?.payload) ??
    contentPayload(result);

  return {
    ...structured,
    ...metaCard,
    tool,
    success: result.isError !== true,
    ...(payload ? { payload } : {}),
  };
}

export function createGenericResultCard(
  result: CallToolResult,
  tool = toolNameFromMeta(result),
): ToolResultCard {
  const payload = contentPayload(result);
  return {
    tool: tool ?? "unknown_tool",
    success: result.isError !== true,
    status: result.isError === true ? "error" : "success",
    summary: {
      contentItems: payload?.content?.length ?? 0,
      hasStructuredContent: result.structuredContent !== undefined,
    },
    ...(payload ? { payload } : {}),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
  };
}

function toolNameFromMeta(result: CallToolResult): string | undefined {
  const tool = metaValue(result)?.tool;
  return typeof tool === "string" && tool.trim() ? tool : undefined;
}

function metaValue(
  result: CallToolResult,
): Record<string, unknown> | undefined {
  return objectValue(result._meta);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function payloadValue(value: unknown): ToolPayload | undefined {
  return objectValue(value) as ToolPayload | undefined;
}

function contentPayload(result: CallToolResult): ToolPayload | undefined {
  const content = result.content.flatMap<ToolContent>((item) => {
    if (item.type === "text") {
      return [{ type: "text", text: item.text }];
    }
    if (item.type === "image") {
      return [
        {
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        },
      ];
    }
    return [];
  });
  return content.length > 0 ? { content } : undefined;
}
