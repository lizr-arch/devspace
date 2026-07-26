import type { App } from "@modelcontextprotocol/ext-apps";

export type ToolName =
  | "open_workspace"
  | "resume_workspace"
  | "project_memory_preflight"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell"
  | "show_changes"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash"
  | "start_job"
  | "start_capture"
  | "poll_job"
  | "cancel_job";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export interface ToolResultCard {
  tool: string;
  success?: boolean;
  workspaceId?: string;
  path?: string;
  root?: string;
  status?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    type?: string;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  skillDiagnostics?: unknown[];
  instruction?: string;
  structuredContent?: unknown;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "resume_workspace" ||
    value === "project_memory_preflight" ||
    value === "read_file" ||
    value === "write_file" ||
    value === "edit_file" ||
    value === "grep_files" ||
    value === "find_files" ||
    value === "list_directory" ||
    value === "run_shell" ||
    value === "show_changes" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash" ||
    value === "start_job" ||
    value === "start_capture" ||
    value === "poll_job" ||
    value === "cancel_job"
  );
}

export function isWorkspaceTool(tool: string): boolean {
  return tool === "open_workspace" || tool === "resume_workspace";
}

export function isProjectMemoryTool(tool: string): boolean {
  return tool === "project_memory_preflight";
}

export function isJobTool(tool: string): boolean {
  return (
    tool === "start_job" ||
    tool === "start_capture" ||
    tool === "poll_job" ||
    tool === "cancel_job"
  );
}

export function isReadTool(tool: string): boolean {
  return tool === "read_file" || tool === "read";
}

export function isWriteTool(tool: string): boolean {
  return tool === "write_file" || tool === "write";
}

export function isEditTool(tool: string): boolean {
  return tool === "edit_file" || tool === "edit";
}

export function isSearchTool(tool: string): boolean {
  return (
    tool === "grep_files" ||
    tool === "find_files" ||
    tool === "grep" ||
    tool === "glob"
  );
}

export function isShellTool(tool: string): boolean {
  return tool === "run_shell" || tool === "bash";
}

export function isReviewTool(tool: string): boolean {
  return tool === "show_changes";
}

export function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function genericPayloadText(card: ToolResultCard): string {
  const sections: string[] = [];
  const content = payloadText(card.payload);
  if (content) sections.push(content);
  if (card.structuredContent !== undefined) {
    sections.push(
      `Structured content:\n${formatStructuredContent(card.structuredContent)}`,
    );
  }
  return sections.join("\n\n");
}

function formatStructuredContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (isWorkspaceTool(card.tool)) {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.skillDiagnostics ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.skillDiagnostics?.length)
    );
  }

  if (isReviewTool(card.tool))
    return Boolean(card.files?.length || card.payload?.patch);

  return Boolean(card.payload || card.structuredContent !== undefined);
}
