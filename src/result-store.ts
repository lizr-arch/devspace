import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface DiffStats {
  additions: number;
  removals: number;
}

export type StoredToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell";

type StoredContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface StoredToolPayload {
  content?: StoredContent[];
  diff?: string;
  patch?: string;
}

export interface StoredToolResult {
  id: string;
  workspaceId?: string;
  workspaceRoot?: string;
  tool: StoredToolName;
  path?: string;
  label?: string;
  createdAt: string;
  summary: Record<string, unknown>;
  payload: StoredToolPayload;
}

export type NewStoredToolResult = Omit<StoredToolResult, "id" | "createdAt">;

export interface ToolResultStore {
  put(input: NewStoredToolResult): StoredToolResult;
  get(resultId: string, workspaceId?: string): StoredToolResult;
  close?(): void;
}

interface ToolResultRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string | null;
  tool: StoredToolName;
  path: string | null;
  label: string | null;
  created_at: string;
  summary_json: string;
  payload_json: string;
}

export class SqliteResultStore implements ToolResultStore {
  private readonly db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "pi-on-mcp.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  put(input: NewStoredToolResult): StoredToolResult {
    const result: StoredToolResult = {
      ...input,
      id: `res_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `insert into tool_results (
          id,
          workspace_id,
          workspace_root,
          tool,
          path,
          label,
          created_at,
          summary_json,
          payload_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.workspaceId ?? null,
        result.workspaceRoot ?? null,
        result.tool,
        result.path ?? null,
        result.label ?? null,
        result.createdAt,
        JSON.stringify(result.summary),
        JSON.stringify(result.payload),
      );

    return result;
  }

  get(resultId: string, workspaceId?: string): StoredToolResult {
    const row = this.db
      .prepare("select * from tool_results where id = ?")
      .get(resultId) as ToolResultRow | undefined;

    if (!row || (workspaceId && row.workspace_id !== workspaceId)) {
      throw new Error(`Unknown tool result: ${resultId}`);
    }

    return rowToStoredToolResult(row);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists tool_results (
        id text primary key,
        workspace_id text,
        workspace_root text,
        tool text not null,
        path text,
        label text,
        created_at text not null,
        summary_json text not null,
        payload_json text not null
      );

      create index if not exists tool_results_workspace_idx
        on tool_results(workspace_id, created_at desc);

      create index if not exists tool_results_root_idx
        on tool_results(workspace_root, created_at desc);

      create index if not exists tool_results_tool_idx
        on tool_results(tool, created_at desc);
    `);
  }
}

export function createResultStore(stateDir: string): ToolResultStore {
  return new SqliteResultStore(stateDir);
}

function rowToStoredToolResult(row: ToolResultRow): StoredToolResult {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root ?? undefined,
    tool: row.tool,
    path: row.path ?? undefined,
    label: row.label ?? undefined,
    createdAt: row.created_at,
    summary: JSON.parse(row.summary_json) as Record<string, unknown>,
    payload: JSON.parse(row.payload_json) as StoredToolPayload,
  };
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
