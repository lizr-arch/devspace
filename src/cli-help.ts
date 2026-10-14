import { createRequire } from "node:module";
import process from "node:process";
import { satisfies } from "semver";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
export const SUPPORTED_NODE_RANGE = ">=20.12 <27";

export function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace codex-worker    Run the independent Codex Worker Supervisor",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and ChatGPT Web readiness details",
      "  devspace doctor --live   Probe local health, OAuth metadata, registration, and Owner password page",
      "  devspace doctor --public Probe the configured publicBaseUrl through your tunnel or reverse proxy",
      "  devspace doctor --public --full-loop",
      "                           Verify the full public OAuth flow and a real open_workspace MCP call",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace config set toolMode <minimal|full>",
      "  devspace config set widgets <off|changes|review_only|full>",
      "  devspace config set mcpTransportMode <stateless|stateful>",
      "  devspace config set mcpSessionIdleTtlSeconds <30-3600>",
      "  devspace config set mcpSessionMaxSessions <8-1024>",
      "  devspace config set mcpSessionSweepIntervalSeconds <5-300>",
      '  devspace coach-pack --path <repo> --task "..." --out coach_pack.md',
      "                           Build a bounded read-only context pack and manifest",
      "  devspace coach-ingest <reply.md> [--out summary.json]",
      "                           Parse a coach reply into structured local next steps",
      '  devspace coach-session start --path <repo> --task "..." [--budget n] [--out coach_pack.md]',
      "                           Start a local read-only multi-turn coach session",
      "  devspace coach-session ingest --session <id> <reply.md> [--out summary.json]",
      "                           Attach a coach reply to an existing session",
      '  devspace coach-session next-pack --session <id> [--task "..."] [--budget n] [--out coach_pack.md]',
      "                           Build the next follow-up pack from session state",
      "  devspace coach-session status --session <id>",
      "                           Show session metadata, usage, and pending follow-up reads",
      "",
      "Collaboration Commands:",
      "  devspace collab init     Initialize collaboration workspace (.devspace/)",
      "  devspace collab status   Show collaboration status and recent events",
      "  devspace worker start    Start the local worker (requires Python 3)",
      "",
      "Handoff Commands:",
      "  devspace handoff init                  Create empty Handoff Package",
      "  devspace handoff import <file>         Import brainstorm results from file",
      "  devspace handoff validate              Validate Handoff Package",
      "  devspace handoff show                  Show Handoff Package",
      "",
      "Delegate Commands:",
      "  devspace delegate start                Start delegate mode",
      "  devspace delegate run [options]        Run auto loop",
      "    --mock                                 Use mock provider (testing)",
      "    --provider <type>                      Provider: mock/ollama/openai",
      "    --executor-provider <type>             Executor provider override",
      "    --coach-provider <type>                Coach provider override",
      "    --max-rounds <n>                       Max rounds (default: 10)",
      "    --timeout <seconds>                    Timeout (default: 60)",
      "  devspace delegate status               Show delegate status",
      "  devspace delegate pause                Pause delegate mode",
      "  devspace delegate resume               Resume delegate mode",
      "  devspace delegate stop                 Stop delegate mode",
      "",
      "Timeline:",
      "  devspace timeline               Show conversation timeline",
      "",
      "Run Commands:",
      "  devspace run current [options] Execute the current .devspace task and write .devspace/execution_report.md",
      "    --provider <type>                      Provider: mock/ollama/openai",
      "    --executor-provider <type>             Executor provider override",
      "    --coach-provider <type>                Coach provider override",
      "    --mode <mode>                          Mode: manual/guided/delegate/free",
      "    --max-rounds <n>                       Max rounds (default: 1)",
      "    --timeout <seconds>                    Timeout (default: 60)",
      "  devspace run report            Show latest run summary and artifact paths",
      "",
      "MCP Commands:",
      "  devspace mcp serve              Start MCP server (stdin/stdout)",
      "  devspace mcp tools              List available MCP tools",
      "  devspace mcp smoke              Run MCP smoke tests",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

export function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

export function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

export function validateRequiredPublicBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed)
    return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

export function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

export function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

export function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

export class SetupCancelledError extends Error {}

export function checkSqliteNative(): string {
  try {
    const Database =
      require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function checkGitAvailable(): string {
  try {
    const { execFileSync } =
      require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

export function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}
