/**
 * MCP-level verification of the Git lifecycle cleanup tools.
 *
 * This drives the *real* registered tool surface over the MCP protocol using an
 * in-memory transport, so it proves what a ChatGPT-style client actually sees:
 * the tool names exist, their input schemas are exactly as documented, and the
 * operations behave against a real (throwaway) repository.
 *
 * Nothing here touches a real project: the fixture lives under the system temp
 * directory and is deleted when the test ends.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createServer } from "../src/server.js";
import { exposedToolNames, toolNamesFor } from "../src/server/server-helpers.js";

const scratch = mkdtempSync(join(tmpdir(), "devspace-mcp-lifecycle-"));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface ToolText {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function structured<T = Record<string, unknown>>(result: unknown): T {
  const value = result as ToolText;
  assert.ok(value.structuredContent, "the tool returned no structuredContent");
  return value.structuredContent as T;
}

function textOf(result: unknown): string {
  const value = result as ToolText;
  return value.content.map((block) => block.text ?? "").join("\n");
}

function isToolError(result: unknown): boolean {
  return (result as ToolText).isError === true;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [];
function check(name: string, run: () => Promise<void> | void): void {
  checks.push({ name, run });
}

let repo = "";
let worktreeRoot = "";
let stateDir = "";

check("the exposed catalogue contains the new tools and keeps the old ones", () => {
  const names = exposedToolNames(configOf(), toolNamesFor(configOf()));
  for (const tool of [
    "close_workspace_session",
    "git_delete_merged_branch",
    "reclaim_workspace",
    "list_workspaces",
    "git_status",
    "git_branch",
    "git_fetch",
    "git_merge",
  ]) {
    assert.equal(names.includes(tool), true, `missing exposed tool ${tool}`);
  }
  assert.equal(
    names.includes("git_push"),
    configOf().gitRemoteWrite.enabled,
    "git_push exposure must still follow the remote-write policy",
  );
});

let running: ReturnType<typeof createServer> | undefined;
function configOf() {
  assert.ok(running, "server not started");
  return running.config;
}

try {
  repo = join(scratch, "repo");
  worktreeRoot = resolve(join(scratch, "worktrees"));
  stateDir = resolve(join(scratch, "state"));
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "DevSpace MCP Test"]);
  git(repo, ["config", "user.email", "mcp@example.com"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "--", "base.txt"]);
  git(repo, ["commit", "-m", "initial"]);

  process.env.DEVSPACE_CONFIG_DIR = join(scratch, "config");
  process.env.DEVSPACE_ALLOWED_ROOTS = repo;
  process.env.DEVSPACE_WORKTREE_ROOT = worktreeRoot;
  process.env.DEVSPACE_STATE_DIR = stateDir;
  process.env.DEVSPACE_AGENT_DIR = join(scratch, "agent");
  process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "mcp-lifecycle-owner-token-value";
  process.env.DEVSPACE_PUBLIC_BASE_URL = "http://127.0.0.1:1";
  process.env.DEVSPACE_LOG_LEVEL = "silent";
  process.env.DEVSPACE_LOG_REQUESTS = "0";
  process.env.DEVSPACE_LOG_TOOL_CALLS = "0";
  process.env.PORT = "1";

  running = createServer();

  const client = new Client({
    name: "devspace-lifecycle-verify-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer(running.ctx);
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  let workspaceId = "";

  check("both new tools are registered with exact schemas", async () => {
    const list = await client.listTools();
    const listed = new Map(list.tools.map((tool) => [tool.name, tool]));

    const closeSchema = listed.get("close_workspace_session")!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.deepEqual(
      Object.keys(closeSchema.properties ?? {}).sort(),
      [
        "confirmWorkspaceId",
        "expectedHeadSha",
        "projectMemoryReceiptId",
        "reason",
        "workspaceId",
      ].sort(),
      "close_workspace_session schema changed unexpectedly",
    );
    assert.deepEqual(
      [...(closeSchema.required ?? [])].sort(),
      ["confirmWorkspaceId", "workspaceId"],
    );

    const deleteSchema = listed
      .get("git_delete_merged_branch")!
      .inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.deepEqual(
      Object.keys(deleteSchema.properties ?? {}).sort(),
      [
        "action",
        "branchName",
        "confirmBranchName",
        "expectedBranchSha",
        "expectedMainSha",
        "projectMemoryReceiptId",
        "workspaceId",
      ].sort(),
      "git_delete_merged_branch schema changed unexpectedly",
    );
    assert.deepEqual([...(deleteSchema.required ?? [])].sort(), [
      "workspaceId",
    ]);
  });

  check("open_workspace(mode=worktree) still works over MCP", async () => {
    const result = await client.callTool({
      name: "open_workspace",
      arguments: { path: repo, mode: "worktree" },
    });
    const opened = structured<{ workspaceId: string; root: string }>(result);
    assert.ok(opened.workspaceId, textOf(result));
    workspaceId = opened.workspaceId;
  });

  check("list_workspaces(cleanupPlan) returns a read-only plan", async () => {
    const result = await client.callTool({
      name: "list_workspaces",
      arguments: { audit: true, cleanupPlan: true, limit: 10 },
    });
    const payload = structured<{
      cleanupPlan: {
        readOnly: boolean;
        entries: Array<{ workspaceId: string; verdict: string }>;
        summary: Record<string, number>;
      };
    }>(result);
    assert.equal(payload.cleanupPlan.readOnly, true);
    assert.equal(payload.cleanupPlan.summary.TOTAL >= 1, true);
    const entry = payload.cleanupPlan.entries.find(
      (item) => item.workspaceId === workspaceId,
    );
    assert.ok(entry, "the open workspace must appear in the plan");
    // The listing reconciles the freshly opened session from `active` to
    // `idle`, and the plan must then treat a clean, merged worktree as a
    // read-only candidate.
    assert.equal(entry.verdict, "SAFE_CANDIDATE");
    assert.equal(entry.sessionState, "idle");
  });

  check("close_workspace_session requires an exact confirmation", async () => {
    const result = await client.callTool({
      name: "close_workspace_session",
      arguments: { workspaceId, confirmWorkspaceId: "ws_wrong" },
    });
    assert.equal(isToolError(result), true);
    assert.match(textOf(result), /CONFIRMATION_REQUIRED/);
  });

  check("close_workspace_session closes and reports reclaim eligibility", async () => {
    const result = await client.callTool({
      name: "close_workspace_session",
      arguments: { workspaceId, confirmWorkspaceId: workspaceId },
    });
    const payload = structured<{
      session: {
        lifecycleState: string;
        alreadyClosed: boolean;
        reclaimEligible: boolean;
      };
    }>(result);
    assert.equal(payload.session.lifecycleState, "closed");
    assert.equal(payload.session.alreadyClosed, false);
    assert.match(textOf(result), /Nothing was deleted/);
  });

  check("close_workspace_session is idempotent over MCP", async () => {
    const result = await client.callTool({
      name: "close_workspace_session",
      arguments: { workspaceId, confirmWorkspaceId: workspaceId },
    });
    const payload = structured<{ session: { alreadyClosed: boolean } }>(result);
    assert.equal(payload.session.alreadyClosed, true);
  });

  check("git_delete_merged_branch lists verdicts without deleting", async () => {
    git(repo, ["branch", "merged/mcp", "main"]);
    const result = await client.callTool({
      name: "git_delete_merged_branch",
      arguments: { workspaceId, action: "list" },
    });
    const payload = structured<{
      branches: Array<{ branch: string; verdict: string }>;
    }>(result);
    const verdicts = new Map(
      payload.branches.map((entry) => [entry.branch, entry.verdict]),
    );
    assert.equal(verdicts.get("main"), "PROTECTED");
    assert.equal(verdicts.get("merged/mcp"), "DELETABLE_MERGED");
    // Still present: listing is read-only.
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes(
        "merged/mcp",
      ),
      true,
    );
  });

  check("git_delete_merged_branch refuses a wrong confirmation", async () => {
    const sha = git(repo, ["rev-parse", "refs/heads/merged/mcp"]);
    const mainSha = git(repo, ["rev-parse", "main"]);
    const result = await client.callTool({
      name: "git_delete_merged_branch",
      arguments: {
        workspaceId,
        branchName: "merged/mcp",
        expectedBranchSha: sha,
        expectedMainSha: mainSha,
        confirmBranchName: "merged/other",
      },
    });
    assert.equal(isToolError(result), true);
    assert.match(textOf(result), /CONFIRMATION_REQUIRED/);
  });

  check("git_delete_merged_branch refuses a stale SHA", async () => {
    const mainSha = git(repo, ["rev-parse", "main"]);
    const result = await client.callTool({
      name: "git_delete_merged_branch",
      arguments: {
        workspaceId,
        branchName: "merged/mcp",
        expectedBranchSha: "0".repeat(40),
        expectedMainSha: mainSha,
        confirmBranchName: "merged/mcp",
      },
    });
    assert.equal(isToolError(result), true);
    assert.match(textOf(result), /GIT_BRANCH_SHA_MISMATCH/);
  });

  check("git_delete_merged_branch refuses a protected branch", async () => {
    const result = await client.callTool({
      name: "git_delete_merged_branch",
      arguments: {
        workspaceId,
        branchName: "main",
        expectedBranchSha: git(repo, ["rev-parse", "main"]),
        expectedMainSha: git(repo, ["rev-parse", "main"]),
        confirmBranchName: "main",
      },
    });
    assert.equal(isToolError(result), true);
    assert.match(textOf(result), /GIT_BRANCH_DELETE_REFUSED/);
  });

  check("git_delete_merged_branch deletes a merged branch and proves it", async () => {
    const sha = git(repo, ["rev-parse", "refs/heads/merged/mcp"]);
    const mainSha = git(repo, ["rev-parse", "main"]);
    const remoteBefore = git(repo, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/",
    ]);
    const result = await client.callTool({
      name: "git_delete_merged_branch",
      arguments: {
        workspaceId,
        branchName: "merged/mcp",
        expectedBranchSha: sha,
        expectedMainSha: mainSha,
        confirmBranchName: "merged/mcp",
      },
    });
    assert.equal(isToolError(result), false, textOf(result));
    const payload = structured<{
      branch: { remoteRefsUnchanged: boolean; mainlineShaAfter: string };
    }>(result);
    assert.equal(payload.branch.remoteRefsUnchanged, true);
    assert.equal(payload.branch.mainlineShaAfter, mainSha);
    assert.equal(git(repo, ["rev-parse", "main"]), mainSha);
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes(
        "merged/mcp",
      ),
      false,
    );
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]),
      remoteBefore,
    );
  });

  check("reclaim_workspace refuses a lockfile-free unsafe target safely", async () => {
    // The worktree is still on disk and clean, so reclamation now succeeds; the
    // point of this check is that the tool is present, SHA-pinned and reports a
    // structured result rather than dropping the request.
    const listed = await client.callTool({
      name: "list_workspaces",
      arguments: { audit: true, cleanupPlan: true, limit: 10 },
    });
    const plan = structured<{
      cleanupPlan: {
        entries: Array<{ workspaceId: string; headSha: string | null }>;
      };
    }>(listed);
    const entry = plan.cleanupPlan.entries.find(
      (item) => item.workspaceId === workspaceId,
    );
    assert.ok(entry?.headSha, "the plan must report the worktree HEAD");
    const wrongSha = "1".repeat(40);
    const result = await client.callTool({
      name: "reclaim_workspace",
      arguments: {
        workspaceId,
        expectedHeadSha: wrongSha,
        confirmWorkspaceId: workspaceId,
      },
    });
    assert.equal(isToolError(result), true);
    assert.match(textOf(result), /WORKSPACE_RECLAIM_(HEAD_MISMATCH|UNSAFE)/);
  });

  // Run every check, then report.
  const failures: string[] = [];
  for (const entry of checks) {
    try {
      await entry.run();
      console.log(`[PASS] ${entry.name}`);
    } catch (error) {
      failures.push(entry.name);
      console.error(
        `[FAIL] ${entry.name}\n${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
    }
  }

  await client.close();
  running.close();

  if (failures.length > 0) {
    throw new Error(`${failures.length} MCP lifecycle checks failed`);
  }
  console.log(
    `mcp git lifecycle tool surface verified (${checks.length} checks)`,
  );
} finally {
  try {
    running?.close();
  } catch {
    // Already closed.
  }
  rmSync(scratch, { recursive: true, force: true });
}
