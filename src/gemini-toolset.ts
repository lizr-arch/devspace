import { createHash } from "node:crypto";
import type { ToolNames } from "./server/server-types.js";

/** Bounded coding and Godot tools exposed to Gemini MCP clients. */
export const GEMINI_TOOLSET_LIMIT = 50;

const GEMINI_CORE_TOOLS = [
  "devspace_info",
  "list_workspaces",
  "resume_workspace",
  "open_workspace",
  "query_operation",
  "project_memory_preflight",
  "git_status",
  "git_diff",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_branch",
  "git_fetch",
  "git_merge",
  "git_push",
  "project_task",
  "list_task_sessions",
  "wait_task",
  "poll_task",
  "stop_task",
  "approve_task_manifest",
  "start_job",
  "wait_job",
  "list_jobs",
  "poll_job",
  "cancel_job",
  "start_capture",
  "list_artifacts",
  "inspect_artifact",
  "godot_import",
  "show_changes",
  "start_game_session",
  "inspect_game_session",
  "send_game_input",
  "capture_game_frame",
  "read_game_logs",
  "stop_game_session",
  "inspect_glb",
  "inspect_blend",
] as const;

export function geminiToolAllowlist(toolNames: ToolNames): Set<string> {
  const names = new Set<string>([
    ...GEMINI_CORE_TOOLS,
    toolNames.read,
    toolNames.write,
    toolNames.edit,
    toolNames.grep,
    toolNames.glob,
    toolNames.ls,
    toolNames.shell,
  ]);
  if (names.size > GEMINI_TOOLSET_LIMIT) {
    throw new Error(`Gemini toolset exceeds ${GEMINI_TOOLSET_LIMIT} tools`);
  }
  return names;
}

export function selectGeminiTools<T extends { name?: unknown }>(
  tools: readonly T[],
  allowlist: ReadonlySet<string>,
): T[] {
  return tools.filter(
    (tool) => typeof tool.name === "string" && allowlist.has(tool.name),
  );
}

export function geminiClientMatches(name: unknown, version: unknown): boolean {
  return name === "mcp" && version === "0.1.0";
}

/** Store only a one-way fingerprint so stateless requests can be correlated. */
export function bearerTokenFingerprint(
  authorization: string | undefined,
): string | undefined {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match ? createHash("sha256").update(match[1]).digest("hex") : undefined;
}
