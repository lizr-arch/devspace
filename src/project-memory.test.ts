import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  type ProjectMemoryRepositoryConfig,
} from "./config.js";
import { openDatabase } from "./db/client.js";
import {
  canonicalJson,
  ProjectMemoryController,
  ProjectMemoryStore,
  runProjectMemoryCommand,
  type ProjectMemoryCommandRunner,
} from "./project-memory.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-project-memory-test-"));

try {
  const repositoryRoot = join(root, "trusted-repository");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      allowedRoots: [root],
      projectMemory: {
        repositories: [
          {
            root: repositoryRoot,
            command: [
              "rtk",
              "proxy",
              "py",
              "-3.11",
              "scripts/manage_project_memory.py",
            ],
            mode: "SHADOW",
            timeoutMs: 5_000,
            maxOutputBytes: 131_072,
          },
        ],
      },
    }),
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const observedCommands: string[][] = [];
  const runner: ProjectMemoryCommandRunner = async (repository, task) => {
    observedCommands.push([...repository.command]);
    return fakePreflight(task);
  };

  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const controller = new ProjectMemoryController(
    config.projectMemory,
    stateDir,
    runner,
  );
  const registry = new WorkspaceRegistry(config, workspaceStore, controller);
  const secretTask =
    "Implement gateway without storing credential secret-value-4a1d9e";
  const context = await registry.openWorkspace({
    path: repositoryRoot,
    task: secretTask,
  });

  assert.equal(context.projectMemory?.status, "ready");
  assert.equal(context.projectMemory?.decision, "observe_would_deny");
  assert.match(context.projectMemory?.receiptId ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(context.projectMemory?.bundle, {
    schema_version: 1,
    selectors: { terms: [secretTask] },
    records: ["feature:project-memory-coding-gateway"],
  });
  assert.deepEqual(observedCommands, [
    [
      "rtk",
      "proxy",
      "py",
      "-3.11",
      "scripts/manage_project_memory.py",
    ],
  ]);
  assert.equal("task" in context.workspace, false);

  const receiptId = context.projectMemory?.receiptId;
  const missing = registry.observeProjectMemoryAccess(
    context.workspace.id,
    "read",
    undefined,
  );
  const matching = registry.observeProjectMemoryAccess(
    context.workspace.id,
    "read",
    receiptId,
  );
  assert.equal(missing.outcome, "receipt_missing");
  assert.equal(matching.outcome, "receipt_match");
  assert.equal(missing.mode, "SHADOW");

  workspaceStore.close();
  controller.close();

  const restoredWorkspaceStore = new SqliteWorkspaceStore(stateDir);
  const restoredController = new ProjectMemoryController(
    config.projectMemory,
    stateDir,
    runner,
  );
  const restoredRegistry = new WorkspaceRegistry(
    config,
    restoredWorkspaceStore,
    restoredController,
  );
  const restored = restoredRegistry.getWorkspace(context.workspace.id);
  assert.equal(restored.projectMemory?.receiptId, receiptId);
  assert.ok(restored.projectMemory?.bundleDeliveredAt);
  restoredWorkspaceStore.close();
  restoredController.close();

  const projectMemoryStore = new ProjectMemoryStore(stateDir);
  assert.deepEqual(projectMemoryStore.listTableNames(), [
    "project_memory_access_events",
    "project_memory_active_state",
    "project_memory_privilege_authorizations",
    "project_memory_receipts",
  ]);
  assert.equal(
    projectMemoryStore.observeAccess(
      context.workspace.id,
      "read",
      "f".repeat(64),
    ).outcome,
    "receipt_mismatch",
  );
  assert.equal(
    projectMemoryStore.observeAccess(
      context.workspace.id,
      "read",
      receiptId,
      new Date("2100-01-01T00:00:00Z"),
    ).outcome,
    "receipt_expired",
  );
  const taskSha256 = sha256(secretTask);
  const authorizationId = projectMemoryStore.createPrivilegeAuthorization({
    workspaceId: context.workspace.id,
    taskSha256,
    mode: "AUDIT",
  });
  assert.equal(
    projectMemoryStore.consumePrivilegeAuthorization({
      authorizationId,
      workspaceId: context.workspace.id,
      taskSha256,
      mode: "AUDIT",
    }),
    true,
  );
  assert.equal(
    projectMemoryStore.consumePrivilegeAuthorization({
      authorizationId,
      workspaceId: context.workspace.id,
      taskSha256,
      mode: "AUDIT",
    }),
    false,
  );
  projectMemoryStore.close();

  const database = openDatabase(stateDir);
  const receiptRows = database.sqlite
    .prepare("select receipt_json from project_memory_receipts")
    .all() as Array<{ receipt_json: string }>;
  const events = database.sqlite
    .prepare(
      "select event_type, outcome, details_json from project_memory_access_events order by created_at",
    )
    .all() as Array<{
    event_type: string;
    outcome: string;
    details_json: string;
  }>;
  database.close();

  assert.equal(receiptRows.length, 1);
  assert.equal(receiptRows[0].receipt_json.includes(secretTask), false);
  assert.equal(events.some((event) => event.event_type === "preflight"), true);
  assert.equal(
    events.some((event) => event.event_type === "bundle_delivery"),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.event_type === "tool_access" && event.outcome === "receipt_match",
    ),
    true,
  );
  assert.equal(
    events.some((event) => event.details_json.includes(secretTask)),
    false,
  );
  assert.equal(
    readFileSync(join(stateDir, "devspace.sqlite")).includes(
      Buffer.from(secretTask, "utf8"),
    ),
    false,
  );

  const tamperedStateDir = join(root, "tampered-state");
  const tamperedWorkspaceStore = new SqliteWorkspaceStore(tamperedStateDir);
  const tamperedController = new ProjectMemoryController(
    config.projectMemory,
    tamperedStateDir,
    async (_repository, task) => {
      const payload = fakePreflight(task);
      const bundle = payload.bundle as { records: string[] };
      bundle.records.push("contract:tampered-after-receipt");
      return payload;
    },
  );
  const tamperedRegistry = new WorkspaceRegistry(
    config,
    tamperedWorkspaceStore,
    tamperedController,
  );
  const tampered = await tamperedRegistry.openWorkspace({
    path: repositoryRoot,
    task: "reject a bundle that does not match its receipt",
  });
  assert.equal(tampered.projectMemory?.status, "error");
  tamperedWorkspaceStore.close();
  tamperedController.close();

  await testBoundedCommandRunner(repositoryRoot);

  const unconfiguredStateDir = join(root, "unconfigured-state");
  const unconfiguredStore = new SqliteWorkspaceStore(unconfiguredStateDir);
  const unconfiguredController = new ProjectMemoryController(
    { repositories: [] },
    unconfiguredStateDir,
    runner,
  );
  const unconfiguredRegistry = new WorkspaceRegistry(
    config,
    unconfiguredStore,
    unconfiguredController,
  );
  const unconfigured = await unconfiguredRegistry.openWorkspace({
    path: repositoryRoot,
    task: "task that has no operator mapping",
  });
  assert.equal(unconfigured.projectMemory?.status, "unconfigured");
  assert.equal(unconfigured.projectMemory?.bundle, undefined);
  unconfiguredStore.close();
  unconfiguredController.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

function fakePreflight(task: string): Record<string, unknown> {
  const bundle = {
    schema_version: 1,
    selectors: { terms: [task] },
    records: ["feature:project-memory-coding-gateway"],
  };
  const unsigned = {
    schema_version: 1,
    mode: "SHADOW",
    issued_at: "2026-07-16T10:00:00Z",
    expires_at: "2099-07-16T10:15:00Z",
    task_sha256: sha256(task.trim()),
    repository_head: "0".repeat(40),
    catalog_sha256: "1".repeat(64),
    policy_sha256: "2".repeat(64),
    selected_owners: [
      {
        kind: "feature",
        id: "project-memory-coding-gateway",
        source: ".project-memory/features/project-memory-coding-gateway.yaml",
        source_sha256: "3".repeat(64),
        owner_schema_version: 2,
        safety_tier: "critical",
      },
    ],
    query_iterations: [
      {
        iteration: 1,
        engine: "v2",
        selector_sha256: "4".repeat(64),
        max_tokens: 4000,
      },
    ],
    bundle_sha256: sha256(canonicalJson(bundle)),
  };
  return {
    schema_version: 1,
    mode: "SHADOW",
    policy_mode: "SHADOW",
    decision: "observe_would_deny",
    would_deny: true,
    denial_reasons: ["legacy_owner:feature:legacy"],
    bundle,
    receipt: {
      ...unsigned,
      receipt_id: sha256(canonicalJson(unsigned)),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function testBoundedCommandRunner(root: string): Promise<void> {
  const repository = (
    script: string,
    overrides: Partial<ProjectMemoryRepositoryConfig> = {},
  ): ProjectMemoryRepositoryConfig => ({
    root,
    command: [process.execPath, "-e", script],
    mode: "SHADOW",
    timeoutMs: 2_000,
    maxOutputBytes: 16_384,
    ...overrides,
  });

  const result = await runProjectMemoryCommand(
    repository(
      'let task = ""; process.stdin.setEncoding("utf8"); ' +
        'process.stdin.on("data", (chunk) => task += chunk); ' +
        'process.stdin.on("end", () => process.stdout.write(JSON.stringify({ task })));',
    ),
    "runner task",
  );
  assert.deepEqual(result, { task: "runner task" });

  await assert.rejects(
    runProjectMemoryCommand(
      repository('process.stdout.write("x".repeat(20000));'),
      "output limit task",
    ),
    /output exceeded operator limit/,
  );
  await assert.rejects(
    runProjectMemoryCommand(
      repository("setTimeout(() => {}, 10000);", { timeoutMs: 25 }),
      "timeout task",
    ),
    /exceeded operator timeout/,
  );
  await assert.rejects(
    runProjectMemoryCommand(
      repository("process.stdout.write(Buffer.from([255]));"),
      "invalid utf8 task",
    ),
    /invalid UTF-8 JSON/,
  );
}
