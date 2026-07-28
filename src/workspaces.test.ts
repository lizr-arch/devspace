import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));

try {
  await testLegacyWorkspaceMigration(join(root, ".legacy-state"));

  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace", "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } =
    await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );

  const firstAdditionalRoot = join(root, "additional-read");
  const secondAdditionalRoot = join(root, "additional-write");
  const additionalRootFile = join(root, "additional-root-file");
  const additionalRootsWorkspace = join(root, "additional-roots-workspace");
  await mkdir(firstAdditionalRoot);
  await mkdir(secondAdditionalRoot);
  await mkdir(additionalRootsWorkspace);
  await writeFile(join(firstAdditionalRoot, "reference.txt"), "reference\n");
  await writeFile(additionalRootFile, "not a directory\n");
  const authorizedWorkspace = await registry.openWorkspace({
    path: additionalRootsWorkspace,
    additionalRoots: [
      { path: firstAdditionalRoot, access: "read_only" },
      { path: secondAdditionalRoot, access: "read_write" },
    ],
  });
  assert.deepEqual(
    authorizedWorkspace.additionalRootsAuthorization.requestedAdditionalRoots,
    [
      { path: firstAdditionalRoot, access: "read_only" },
      { path: secondAdditionalRoot, access: "read_write" },
    ],
  );
  assert.deepEqual(
    authorizedWorkspace.additionalRootsAuthorization.effectiveAdditionalRoots,
    [
      { path: await realpath(firstAdditionalRoot), access: "read_only" },
      { path: await realpath(secondAdditionalRoot), access: "read_write" },
    ],
  );
  assert.deepEqual(
    authorizedWorkspace.additionalRootsAuthorization.rejectedAdditionalRoots,
    [],
  );
  assert.equal(
    authorizedWorkspace.additionalRootsAuthorization.additionalRootsScope,
    "in_memory_session",
  );
  assert.equal(
    authorizedWorkspace.additionalRootsAuthorization.additionalRootsPersisted,
    false,
  );
  assert.equal(
    registry.resolvePath(
      authorizedWorkspace.workspace,
      join(firstAdditionalRoot, "reference.txt"),
    ),
    join(firstAdditionalRoot, "reference.txt"),
  );
  const effectiveWritableRoot =
    authorizedWorkspace.additionalRootsAuthorization.effectiveAdditionalRoots[1]
      ?.path;
  assert.ok(effectiveWritableRoot);
  assert.equal(
    registry.resolvePath(
      authorizedWorkspace.workspace,
      join(effectiveWritableRoot, "new-output.txt"),
    ),
    join(effectiveWritableRoot, "new-output.txt"),
  );
  const authorizedList = await registry.listWorkspaces();
  assert.deepEqual(
    authorizedList.find(
      (session) => session.workspaceId === authorizedWorkspace.workspace.id,
    )?.effectiveAdditionalRoots,
    authorizedWorkspace.additionalRootsAuthorization.effectiveAdditionalRoots,
  );

  const rejectedUpdate = await registry.resumeWorkspace(
    authorizedWorkspace.workspace.id,
    undefined,
    [
      { path: secondAdditionalRoot, access: "read_write" },
      { path: additionalRootFile, access: "read_only" },
    ],
  );
  assert.deepEqual(
    rejectedUpdate.additionalRootsAuthorization.effectiveAdditionalRoots,
    authorizedWorkspace.workspace.additionalRoots,
  );
  assert.equal(
    rejectedUpdate.additionalRootsAuthorization.rejectedAdditionalRoots[0]
      ?.code,
    "ADDITIONAL_ROOT_NOT_DIRECTORY",
  );
  assert.deepEqual(rejectedUpdate.workspace.additionalRoots, [
    { path: await realpath(firstAdditionalRoot), access: "read_only" },
    { path: await realpath(secondAdditionalRoot), access: "read_write" },
  ]);

  const clearedAuthorization = await registry.resumeWorkspace(
    authorizedWorkspace.workspace.id,
    undefined,
    [],
  );
  assert.deepEqual(clearedAuthorization.workspace.additionalRoots, []);
  assert.deepEqual(
    clearedAuthorization.additionalRootsAuthorization.effectiveAdditionalRoots,
    [],
  );

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError &&
      error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal(
    (await stat(worktreeWorkspace.workspace.root)).isDirectory(),
    true,
  );
  assert.match(
    worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"),
    /global instructions/,
  );
  assert.match(
    worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"),
    /git root instructions/,
  );

  const worktreeReadmePath = registry.resolvePath(
    worktreeWorkspace.workspace,
    "README.md",
  );
  assert.equal(
    worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root),
    true,
  );

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace({
    path: root,
    additionalRoots: [{ path: firstAdditionalRoot, access: "read_only" }],
  });
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(
    persistentWorkspace.workspace.id,
  );
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");
  assert.deepEqual(restoredWorkspace.additionalRoots, []);
  assert.equal(
    restoredWorkspace.additionalRootsAuthorization.additionalRootsPersisted,
    false,
  );

  const restoredWorktree = restoredRegistry.getWorkspace(
    persistentWorktree.workspace.id,
  );
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);

  const listedWorkspaces = await restoredRegistry.listWorkspaces();
  assert.equal(
    listedWorkspaces.some(
      (session) =>
        session.workspaceId === persistentWorkspace.workspace.id &&
        session.resumable,
    ),
    true,
  );
  assert.equal(
    listedWorkspaces.some(
      (session) =>
        session.workspaceId === persistentWorktree.workspace.id &&
        session.mode === "worktree" &&
        session.resumable,
    ),
    true,
  );
  assert.deepEqual(
    listedWorkspaces.find(
      (session) => session.workspaceId === persistentWorkspace.workspace.id,
    )?.effectiveAdditionalRoots,
    [],
  );

  const resumedWorktree = await restoredRegistry.resumeWorkspace(
    persistentWorktree.workspace.id,
  );
  assert.equal(
    resumedWorktree.workspace.root,
    persistentWorktree.workspace.root,
  );
  assert.match(
    resumedWorktree.agentsFiles.map((file) => file.content).join("\n"),
    /git root instructions/,
  );
  const managedBranch = persistentWorktree.workspace.worktree?.branch;
  assert.ok(managedBranch);
  await git(persistentWorktree.workspace.root, ["checkout", "--detach"]);
  const detachedResume = await restoredRegistry.resumeWorkspace(
    persistentWorktree.workspace.id,
  );
  assert.equal(detachedResume.workspace.worktree?.detached, true);
  assert.equal(detachedResume.workspace.worktree?.branch, undefined);
  const detachedList = await restoredRegistry.listWorkspaces();
  assert.equal(
    detachedList.find(
      (session) => session.workspaceId === persistentWorktree.workspace.id,
    )?.detached,
    true,
  );
  assert.equal(
    detachedList.find(
      (session) => session.workspaceId === persistentWorktree.workspace.id,
    )?.branch,
    undefined,
  );
  await git(persistentWorktree.workspace.root, ["switch", managedBranch]);
  const attachedResume = await restoredRegistry.resumeWorkspace(
    persistentWorktree.workspace.id,
  );
  assert.equal(attachedResume.workspace.worktree?.detached, false);
  assert.equal(attachedResume.workspace.worktree?.branch, managedBranch);
  secondStore.close();

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".devspace", "config"),
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(
      aliasConfig,
    ).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(
      aliasWorkspace.workspace.sourceRoot,
      join(aliasRoot, "git-project"),
    );

    const additionalAliasRoot = join(root, "additional-alias-root");
    await symlink(firstAdditionalRoot, additionalAliasRoot, "dir");
    const canonicalizedAdditionalRoot = await registry.resumeWorkspace(
      authorizedWorkspace.workspace.id,
      undefined,
      [{ path: additionalAliasRoot, access: "read_only" }],
    );
    assert.deepEqual(
      canonicalizedAdditionalRoot.additionalRootsAuthorization
        .requestedAdditionalRoots,
      [{ path: additionalAliasRoot, access: "read_only" }],
    );
    assert.deepEqual(
      canonicalizedAdditionalRoot.additionalRootsAuthorization
        .effectiveAdditionalRoots,
      [{ path: await realpath(firstAdditionalRoot), access: "read_only" }],
    );

    const conflictingAdditionalRoot = await registry.resumeWorkspace(
      authorizedWorkspace.workspace.id,
      undefined,
      [
        { path: firstAdditionalRoot, access: "read_only" },
        { path: additionalAliasRoot, access: "read_write" },
      ],
    );
    assert.equal(
      conflictingAdditionalRoot.additionalRootsAuthorization
        .rejectedAdditionalRoots.length,
      2,
    );
    assert.equal(
      conflictingAdditionalRoot.additionalRootsAuthorization.rejectedAdditionalRoots.every(
        (rejection) => rejection.code === "ADDITIONAL_ROOT_ACCESS_CONFLICT",
      ),
      true,
    );
    assert.deepEqual(conflictingAdditionalRoot.workspace.additionalRoots, [
      { path: await realpath(firstAdditionalRoot), access: "read_only" },
    ]);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function testLegacyWorkspaceMigration(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const sqlite = new Database(databasePath(stateDir));
  sqlite.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations (version, name, applied_at) values
      (1, 'workspace-state', '2026-07-26T00:00:00.000Z'),
      (2, 'oauth-state', '2026-07-26T00:00:00.000Z'),
      (3, 'project-memory-shadow-state', '2026-07-26T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
  `);
  sqlite.close();

  const store = new SqliteWorkspaceStore(stateDir);
  const migrated = store.createSession({
    id: "legacy-migration-worktree",
    root: "/tmp/legacy-migration-worktree",
    mode: "worktree",
    managed: true,
    detached: false,
    branch: "devspace/integration/legacy",
  });
  assert.equal(migrated.detached, false);
  assert.equal(migrated.branch, "devspace/integration/legacy");
  assert.equal(
    store.getSession(migrated.id)?.branch,
    "devspace/integration/legacy",
  );
  store.close();
}
