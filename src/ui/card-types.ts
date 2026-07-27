import type { App } from "@modelcontextprotocol/ext-apps";

export const TOOL_NAMES = [
  "devspace_info",
  "list_workspaces",
  "list_artifacts",
  "inspect_artifact",
  "publish_artifact",
  "git_status",
  "git_diff",
  "inspect_glb",
  "resume_workspace",
  "open_workspace",
  "project_memory_preflight",
  "read",
  "read_file",
  "write",
  "write_file",
  "import_asset",
  "import_png",
  "archive_approved_image",
  "find_approved_assets",
  "verify_approved_asset",
  "recover_approved_asset",
  "reindex_approved_assets",
  "edit",
  "edit_file",
  "preview_artifact",
  "mkdir",
  "copy",
  "move",
  "move_to_trash",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_branch",
  "git_fetch",
  "git_merge",
  "git_push",
  "start_game_session",
  "inspect_game_session",
  "send_game_input",
  "capture_game_frame",
  "read_game_logs",
  "stop_game_session",
  "inspect_blend",
  "inspect_audio",
  "render_model_preview",
  "show_changes",
  "grep",
  "grep_files",
  "glob",
  "find_files",
  "ls",
  "list_directory",
  "bash",
  "run_shell",
  "start_job",
  "start_capture",
  "poll_job",
  "cancel_job",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const toolNameSet = new Set<string>(TOOL_NAMES);

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
  return typeof value === "string" && toolNameSet.has(value);
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
  return tool === "show_changes" || tool === "git_diff";
}

export function isAssetIntakeTool(tool: string): boolean {
  return (
    tool === "import_png" ||
    tool === "archive_approved_image" ||
    tool === "find_approved_assets" ||
    tool === "verify_approved_asset" ||
    tool === "recover_approved_asset" ||
    tool === "reindex_approved_assets"
  );
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

export function summaryBadgeText(card: ToolResultCard): string {
  if (isAssetIntakeTool(card.tool)) {
    if (card.tool === "find_approved_assets") {
      const count =
        summaryNumber(card.summary, "count") ??
        numberValue(assetCardValue(card, "count")) ??
        0;
      return `${count} ${count === 1 ? "asset" : "assets"}`;
    }
    if (card.tool === "reindex_approved_assets") {
      const indexed =
        summaryNumber(card.summary, "indexed") ??
        numberValue(assetCardValue(card, "indexed")) ??
        0;
      return `${indexed} indexed`;
    }
    const outcome = assetCardValue(card, "outcome");
    const ready = assetCardValue(card, "readyForPipeline");
    if (typeof outcome === "string") return outcome;
    if (ready === true) return "pipeline ready";
    if (ready === false) return "blocked";
    return card.success === false ? "failed" : "verified";
  }

  if (card.tool === "list_artifacts") {
    const count = summaryNumber(card.summary, "count") ?? 0;
    return `${count} ${count === 1 ? "artifact" : "artifacts"}`;
  }

  const explicitLines = summaryNumber(card.summary, "lines");
  const text = payloadText(card.payload);
  const lines =
    explicitLines ?? (text.length === 0 ? 0 : text.split(/\r?\n/u).length);
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

export function assetCardValue(card: ToolResultCard, key: string): unknown {
  const direct = (card as unknown as Record<string, unknown>)[key];
  return direct ?? card.summary?.[key];
}

function numberValue(value: unknown): number | undefined {
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
