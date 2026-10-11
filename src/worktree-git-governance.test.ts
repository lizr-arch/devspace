/**
 * M3: worktree / Git / parallel-task governance.
 *
 * Covers the three governance gaps found in the baseline audit:
 *
 *   1. background jobs had no notion of *where* they run, so two build jobs in
 *      one workspace raced on the same `obj/`, `bin/` and managed assembly;
 *   2. a workspace record could not be reclaimed at all, and the persisted
 *      `status` column always claimed "active" regardless of reality;
 *   3. a destination branch was authorized by a flat, permanent, repo-agnostic
 *      list, with no scope, expiry or revocation — and `main` was on it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobManager } from "./background-jobs.js";
import { TaskRunner } from "./task-runner.js";
import {
  JobResourceLocks,
  ResourceLockBusyError,
  sharedResourceLocks,
} from "./job-resource-locks.js";
import {
  auditWorkspace,
  listRegisteredWorktrees,
  scanWorktreeDirectories,
} from "./workspace-audit.js";
import { previewJobRetention } from "./job-retention.js";
import {
  authorizeDestinationBranch,
  describeAuthorizations,
  isProtectedDefaultBranch,
  isSafeAuthorizationBranch,
  type GitBranchAuthorization,
} from "./git-branch-authorization.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "devspace-m3-"));
const stateDir = mkdtempSync(join(tmpdir(), "devspace-m3-state-"));
// A dedicated workspace whose npm script holds the build lock long enough for a
// second job to contend, without any shell metacharacter in our own argv.
const holderRoot = mkdtempSync(join(tmpdir(), "devspace-m3-hold-"));
const otherRoot = mkdtempSync(join(tmpdir(), "devspace-m3-other-"));
for (const dir of [holderRoot, otherRoot]) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "devspace-lock-fixture",
      version: "1.0.0",
      private: true,
      scripts: { hold: "node -e \"setTimeout(() => {}, 20000)\"" },
    }),
  );
}

try {
  testResourceLockIdentity();
  await testLockBlocksRacingBuild();
  await testLockReleasedOnCancelAndTimeout();
  testLockReleasedOnSpawnFailure();
  await testTaskRunnerContendsWithJobs();
  await testAuditClassification();
  await testRegisteredWorktreeListing();
  testWorktreeDirectoryScan();
  testJobRetentionClassification();
  testBranchAuthorization();
  testProtectedDefaultBranchConfig();
  await testLiveConfigHasNoStandingMainGrant();
  console.log("worktree and git governance tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(holderRoot, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Two spellings of one directory must contend for the same lock. */
function testResourceLockIdentity(): void {
  const dir = join(root, "identity");
  mkdirSync(dir, { recursive: true });
  const a = JobResourceLocks.keyFor({ kind: "workspace", value: dir });
  const b = JobResourceLocks.keyFor({
    kind: "workspace",
    value: `${dir}/`,
  });
  assert.equal(a, b, "trailing slash must not create a second lock");
  const c = JobResourceLocks.keyFor({
    kind: "workspace",
    value: join(dir, "..", "identity"),
  });
  assert.equal(a, c, "a parent-relative spelling must canonicalise to the same lock");
  assert.notEqual(
    a,
    JobResourceLocks.keyFor({ kind: "godot-project", value: dir }),
    "different resource kinds must not collide",
  );

  // Which runners take which locks.
  assert.deepEqual(
    JobResourceLocks.requestsFor({ runner: "dotnet", workspaceRoot: dir }).map(
      (request) => request.kind,
    ),
    ["workspace"],
  );
  assert.deepEqual(
    JobResourceLocks.requestsFor({ runner: "godot-mono", workspaceRoot: dir }).map(
      (request) => request.kind,
    ),
    ["godot-project"],
  );
  assert.deepEqual(
    JobResourceLocks.requestsFor({ runner: "godot-mono", workspaceRoot: dir, godotEditorImport: true })
      .map((request) => request.kind)
      .sort(),
    ["godot-project"],
  );
  // A read-only runner takes nothing, so unrelated work stays parallel.
  assert.deepEqual(
    JobResourceLocks.requestsFor({ runner: "pytest", workspaceRoot: dir }).map(
      (request) => request.kind,
    ),
    ["workspace"],
  );

  // Independent workspaces must not block each other.
  const locks = new JobResourceLocks();
  locks.acquire({
    jobId: "job_a",
    runner: "dotnet",
    workspaceRoot: dir,
    requests: [{ kind: "workspace", value: dir }],
  });
  const other = join(root, "independent");
  mkdirSync(other, { recursive: true });
  locks.acquire({
    jobId: "job_b",
    runner: "dotnet",
    workspaceRoot: other,
    requests: [{ kind: "workspace", value: other }],
  });
  assert.equal(locks.snapshot().length, 2);
  locks.releaseAll();
}

/** Two build jobs in one workspace must not be allowed to race. */
async function testLockBlocksRacingBuild(): Promise<void> {
  const manager = new BackgroundJobManager(stateDir);
  // A job that holds the workspace long enough for a second job to contend.
  const first = await manager.start({
    workspaceId: "ws_lock",
    workspaceRoot: holderRoot,
    workingDirectory: holderRoot,
    runner: "npm",
    args: ["run", "hold"],
    timeoutSeconds: 60,
  });
  try {
    assert.equal(manager.resourceLockSnapshot().length, 1);
    await assert.rejects(
      manager.start({
        workspaceId: "ws_lock",
        workspaceRoot: holderRoot,
        workingDirectory: holderRoot,
        runner: "dotnet",
        args: ["build"],
        timeoutSeconds: 30,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "JOB_RESOURCE_BUSY",
          `expected JOB_RESOURCE_BUSY, got ${String(error)}`,
        );
        assert.equal(
          (error as ResourceLockBusyError).heldBy.jobId,
          first.jobId,
          "the error must name the job holding the resource",
        );
        return true;
      },
    );
    // An INDEPENDENT workspace must still be accepted in parallel.
    const parallel = await manager.start({
      workspaceId: "ws_other",
      workspaceRoot: otherRoot,
      workingDirectory: otherRoot,
      runner: "npm",
      args: ["run", "hold"],
      timeoutSeconds: 60,
    });
    assert.ok(parallel.jobId);
    assert.equal(
      manager.resourceLockSnapshot().length,
      2,
      "independent workspaces must not block each other",
    );
    manager.cancel(parallel.jobId);
    await waitForTerminal(manager, parallel.jobId, 15_000);
  } finally {
    manager.cancel(first.jobId);
    await waitForTerminal(manager, first.jobId, 15_000);
  }
  // Once the first job is terminal its lock must be free again.
  assert.equal(manager.resourceLockSnapshot().length, 0);
  manager.close();
}

/** Cancel and timeout must both release the lock, not strand it. */
async function testLockReleasedOnCancelAndTimeout(): Promise<void> {
  const manager = new BackgroundJobManager(stateDir);
  const job = await manager.start({
    workspaceId: "ws_lock2",
    workspaceRoot: holderRoot,
    workingDirectory: holderRoot,
    runner: "npm",
    // A long-running npm invocation that we cancel.
    args: ["run", "hold"],
    timeoutSeconds: 60,
  });
  assert.equal(manager.resourceLockSnapshot().length, 1);
  assert.equal(manager.resourceLockSnapshot()[0].jobId, job.jobId);
  manager.cancel(job.jobId);
  await waitUntil(() => manager.resourceLockSnapshot().length === 0, 20_000);
  assert.equal(
    manager.resourceLockSnapshot().length,
    0,
    "a cancelled job must not keep its resource lock",
  );

  // A job that hits its timeout must release just the same.
  const timingOut = await manager.start({
    workspaceId: "ws_lock3",
    workspaceRoot: holderRoot,
    workingDirectory: holderRoot,
    runner: "npm",
    args: ["run", "hold"],
    timeoutSeconds: 1,
  });
  assert.equal(manager.resourceLockSnapshot().length, 1);
  await waitForTerminal(manager, timingOut.jobId, 30_000);
  await waitUntil(() => manager.resourceLockSnapshot().length === 0, 20_000);
  assert.equal(
    manager.resourceLockSnapshot().length,
    0,
    "a timed-out job must not keep its resource lock",
  );

  // And a subsequent job in the same workspace must be accepted again.
  const after = await manager.start({
    workspaceId: "ws_lock2",
    workspaceRoot: holderRoot,
    workingDirectory: holderRoot,
    runner: "dotnet",
    args: ["build"],
    timeoutSeconds: 30,
  });
  assert.ok(after.jobId);
  await waitForTerminal(manager, after.jobId, 60_000);
  assert.equal(manager.resourceLockSnapshot().length, 0);
  manager.close();
}

/** A job that never starts must not leave a lock behind. */
function testLockReleasedOnSpawnFailure(): void {
  const locks = new JobResourceLocks();
  const requests = JobResourceLocks.requestsFor({
    runner: "dotnet",
    workspaceRoot: root,
  });
  locks.acquire({ jobId: "job_x", runner: "dotnet", workspaceRoot: root, requests });
  assert.equal(locks.heldByJob("job_x").length, 1);
  const released = locks.release("job_x");
  assert.equal(released, 1);
  assert.equal(locks.heldByJob("job_x").length, 0);
  // Releasing twice is harmless.
  assert.equal(locks.release("job_x"), 0);
}

/**
 * The declared-task path and the background-job path must contend for the same
 * workspace: a project_task build racing a job (or a Phase 20 performance run)
 * would silently invalidate both.
 */
async function testTaskRunnerContendsWithJobs(): Promise<void> {
  mkdirSync(join(holderRoot, ".devspace"), { recursive: true });
  writeFileSync(
    join(holderRoot, ".devspace", "tasks.yaml"),
    `version: 1
tasks:
  hold:
    mode: run
    runtime: system
    timeout_seconds: 60
    command: ["node", "-e", "setTimeout(() => {}, 20000)"]
`,
  );
  // The job path holds the workspace first.
  const manager = new BackgroundJobManager(stateDir);
  const job = await manager.start({
    workspaceId: "ws_cross",
    workspaceRoot: holderRoot,
    workingDirectory: holderRoot,
    runner: "npm",
    args: ["run", "hold"],
    timeoutSeconds: 60,
  });
  try {
    const taskRunner = new TaskRunner();
    await assert.rejects(
      taskRunner.runTask({
        workspaceId: "ws_cross",
        workspaceRoot: holderRoot,
        taskId: "hold",
        params: {},
        additionalRoots: [],
      }),
      (error: unknown) => {
        assert.match(
          error instanceof Error ? error.message : String(error),
          /TASK_WORKSPACE_BUSY/,
          `a declared task must not run while a job holds the workspace, got ${String(error)}`,
        );
        return true;
      },
    );
  } finally {
    manager.cancel(job.jobId);
    await waitForTerminal(manager, job.jobId, 20_000);
    manager.close();
  }
  // Once the job is terminal the task must be accepted again.
  await waitUntil(() => sharedResourceLocks.snapshot().length === 0, 10_000);
  assert.equal(sharedResourceLocks.snapshot().length, 0);
  rmSync(join(holderRoot, ".devspace"), { recursive: true, force: true });
}

/** The persisted status column is never trusted; disk + Git decide. */
async function testAuditClassification(): Promise<void> {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  // A clean checkout with no mainline divergence is a candidate.
  const clean = await auditWorkspace({
    workspaceId: "ws_clean",
    root: repo,
    mode: "checkout",
    managed: false,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: false,
    activeJobIds: [],
  });
  assert.equal(clean.lifecycle, "checkout");
  assert.equal(clean.dirtyFileCount, 0);
  assert.equal(clean.untrackedFileCount, 0);
  assert.equal(clean.unmergedCommitCount, 0);
  assert.deepEqual(clean.risks, []);
  // A normal checkout is never a reclamation candidate, however clean it is.
  // The verdict is what the lifecycle plan reports; `reclaimable` follows it.
  assert.equal(clean.verdict, "BLOCKED_NOT_MANAGED");
  assert.equal(clean.reclaimable, false);

  // A dirty tree is never reclaimable, whatever the caller wants.
  writeFileSync(join(repo, "a.txt"), "two\n");
  const dirty = await auditWorkspace({
    workspaceId: "ws_clean",
    root: repo,
    mode: "checkout",
    managed: false,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: false,
    activeJobIds: [],
  });
  assert.equal(dirty.dirtyFileCount, 1);
  assert.equal(dirty.reclaimable, false);
  assert.ok(dirty.risks.some((risk) => risk.code === "uncommitted_changes"));
  assert.ok(dirty.blockedReasons.some((reason) => /uncommitted/.test(reason)));
  git(repo, ["checkout", "--", "a.txt"]);

  // Untracked files block too.
  writeFileSync(join(repo, "untracked.txt"), "x\n");
  const untracked = await auditWorkspace({
    workspaceId: "ws_clean",
    root: repo,
    mode: "checkout",
    managed: false,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: false,
    activeJobIds: [],
  });
  assert.equal(untracked.untrackedFileCount, 1);
  assert.equal(untracked.reclaimable, false);
  rmSync(join(repo, "untracked.txt"));

  // Unmerged commits block.
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "b.txt"), "feature\n");
  git(repo, ["add", "b.txt"]);
  git(repo, ["commit", "-q", "-m", "feature work"]);
  const unmerged = await auditWorkspace({
    workspaceId: "ws_feature",
    root: repo,
    mode: "checkout",
    managed: false,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: false,
    activeJobIds: [],
  });
  assert.equal(unmerged.unmergedCommitCount, 1);
  assert.equal(unmerged.reclaimable, false);
  assert.ok(unmerged.risks.some((risk) => risk.code === "unmerged_commits"));

  // An active session or job blocks even a pristine tree.
  git(repo, ["checkout", "-q", "main"]);
  const busy = await auditWorkspace({
    workspaceId: "ws_busy",
    root: repo,
    mode: "checkout",
    managed: false,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: true,
    activeJobIds: ["job_1"],
  });
  assert.equal(busy.reclaimable, false);
  assert.ok(busy.risks.some((risk) => risk.code === "active_session"));
  assert.ok(busy.risks.some((risk) => risk.code === "active_job"));

  // A vanished directory is reported, never silently treated as clean.
  const missing = await auditWorkspace({
    workspaceId: "ws_gone",
    root: join(root, "does-not-exist"),
    mode: "worktree",
    managed: true,
    createdAt: null,
    lastUsedAt: null,
    hasActiveSession: false,
    activeJobIds: [],
  });
  assert.equal(missing.lifecycle, "missing_directory");
  assert.equal(missing.resumable, false);
  assert.equal(missing.reclaimable, false);
}

/** Directories on disk with no record must be discoverable. */
function testWorktreeDirectoryScan(): void {
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(join(worktreeRoot, "known-one"), { recursive: true });
  mkdirSync(join(worktreeRoot, "orphan-two"), { recursive: true });
  mkdirSync(join(worktreeRoot, ".hidden"), { recursive: true });
  const scan = scanWorktreeDirectories(worktreeRoot, [
    join(worktreeRoot, "known-one"),
  ]);
  assert.equal(scan.directories.length, 2);
  // The scan canonicalises every directory so a record and a directory listing
  // that spell the same path differently (macOS `/var` vs `/private/var`) still
  // compare equal, which is what stops a live worktree being reported as an
  // orphan. Compare canonical spellings here too.
  assert.deepEqual(scan.orphaned, [
    realpathSync(join(worktreeRoot, "orphan-two")),
  ]);

  // The listing is read-only: nothing was removed by scanning.
  assert.equal(existsSync(join(worktreeRoot, "orphan-two")), true);
  assert.equal(existsSync(join(worktreeRoot, "known-one")), true);
}

/** Registered-worktree detection must be usable for a whole root at once. */
async function testRegisteredWorktreeListing(): Promise<void> {
  const repo = join(root, "wt-listing");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const linked = join(root, "wt-listing-linked");
  git(repo, ["worktree", "add", "-q", linked, "-b", "side"]);

  const registered = await listRegisteredWorktrees(repo);
  assert.ok(registered, "the worktree listing must be readable");
  // Git reports canonical paths; compare canonically on both sides.
  assert.equal(registered.has(realpathSync(repo)), true);
  assert.equal(
    registered.has(realpathSync(linked)),
    true,
    `linked worktree must be listed, saw ${JSON.stringify([...registered])}`,
  );
  // An unrelated directory is not registered.
  assert.equal(registered.has(join(root, "retention-")), false);
  // Nothing was removed by listing.
  assert.equal(existsSync(linked), true);
}

/**
 * Job retention must protect everything that carries meaning: running jobs,
 * jobs awaiting process cleanup, failure forensics, and records whose ownership
 * cannot be established. Only settled successful runs may ever be proposed.
 */
function testJobRetentionClassification(): void {
  const jobsDir = mkdtempSync(join(root, "retention-"));
  const now = new Date("2026-10-10T00:00:00Z");
  const write = (id: string, body: Record<string, unknown>) => {
    writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify(body));
    writeFileSync(join(jobsDir, `${id}.log`), "x".repeat(100));
  };
  write("job_running", { jobId: "job_running", status: "running", startedAt: "2026-10-09T00:00:00Z" });
  write("job_pending", {
    jobId: "job_pending",
    status: "failed",
    endedAt: "2020-01-01T00:00:00Z",
    processCleanupPending: true,
  });
  write("job_failed", { jobId: "job_failed", status: "failed", endedAt: "2020-01-01T00:00:00Z" });
  write("job_timeout", { jobId: "job_timeout", status: "timed_out", endedAt: "2020-01-01T00:00:00Z" });
  write("job_cancel", { jobId: "job_cancel", status: "cancelled", endedAt: "2020-01-01T00:00:00Z" });
  write("job_old_ok", { jobId: "job_old_ok", status: "succeeded", endedAt: "2020-01-01T00:00:00Z" });
  write("job_new_ok", { jobId: "job_new_ok", status: "succeeded", endedAt: "2026-10-09T00:00:00Z" });
  writeFileSync(join(jobsDir, "job_corrupt.json"), "{not json");
  writeFileSync(join(jobsDir, "job_corrupt.log"), "y".repeat(50));

  const preview = previewJobRetention({ jobsDirectory: jobsDir, now });
  const byId = Object.fromEntries(
    preview.records.map((entry) => [entry.jobId, entry.classification]),
  );
  assert.equal(preview.records.length, 8, "every record must be classified");

  assert.equal(byId.job_running, "running");
  assert.equal(byId.job_pending, "recovery_pending");
  // Failure forensics are never eligible, however old they are.
  assert.equal(byId.job_failed, "failure_evidence");
  assert.equal(byId.job_timeout, "failure_evidence");
  assert.equal(byId.job_cancel, "failure_evidence");
  assert.equal(byId.job_corrupt, "unattributed");
  assert.equal(byId.job_new_ok, "expirable");
  assert.equal(byId.job_old_ok, "expirable");

  // Only the settled, successful, out-of-window record is a candidate.
  assert.deepEqual(
    preview.expirableCandidates.map((entry) => entry.jobId),
    ["job_old_ok"],
  );
  assert.equal(preview.policy.deletesAnything, false);
  assert.equal(preview.policy.outcome, "preview_only");
  assert.equal(preview.policy.succeededRetentionDays, 30);
  assert.equal(preview.totalRecords, 8);
  assert.ok(preview.totalBytes > 0);
  assert.equal(preview.byClass.failure_evidence.count, 3);
  assert.equal(preview.byClass.unattributed.count, 1);
  assert.ok(
    preview.notes.some((note) => /does not delete/.test(note)),
    "the preview must state that it deletes nothing",
  );

  // A wider window removes the only candidate.
  const wide = previewJobRetention({
    jobsDirectory: jobsDir,
    now,
    succeededRetentionDays: 3650,
  });
  assert.deepEqual(wide.expirableCandidates, []);

  // A missing directory is reported, not treated as an error.
  const absent = previewJobRetention({
    jobsDirectory: join(root, "no-such-jobs-dir"),
    now,
  });
  assert.equal(absent.totalRecords, 0);
  assert.ok(absent.notes.length > 0);
}

/** Scope, expiry and revocation on branch grants. */
function testBranchAuthorization(): void {
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const now = new Date("2026-10-10T00:00:00Z");
  const base = {
    approvedDestinationBranches: ["devspace/integration/one"],
    repositoryRoot: repoA,
    now,
  };

  // The static list still works.
  assert.equal(
    authorizeDestinationBranch({
      ...base,
      destinationBranch: "devspace/integration/one",
      authorizations: [],
    }).authorized,
    true,
  );

  // A branch nobody authorized is refused.
  const refused = authorizeDestinationBranch({
    ...base,
    destinationBranch: "feat/anything",
    authorizations: [],
  });
  assert.equal(refused.authorized, false);
  assert.match(
    refused.authorized === false ? refused.reason : "",
    /GIT_DESTINATION_BRANCH_NOT_APPROVED/,
  );

  // `main` is never reachable through the static list, even if listed.
  const mainStatic = authorizeDestinationBranch({
    approvedDestinationBranches: ["main"],
    repositoryRoot: repoA,
    destinationBranch: "main",
    authorizations: [],
    now,
  });
  assert.equal(mainStatic.authorized, false);
  assert.match(
    mainStatic.authorized === false ? mainStatic.reason : "",
    /protected default branch/,
  );

  const active: GitBranchAuthorization = {
    branch: "main",
    repositoryRoot: repoA,
    grantedAt: "2026-10-09T00:00:00Z",
    expiresAt: "2026-10-11T00:00:00Z",
    grantedBy: "operator",
  };
  // An active, correctly scoped grant opens main.
  assert.equal(
    authorizeDestinationBranch({
      approvedDestinationBranches: [],
      repositoryRoot: repoA,
      destinationBranch: "main",
      authorizations: [active],
      now,
    }).authorized,
    true,
  );
  // Scope: the same grant must not work in another repository.
  assert.equal(
    authorizeDestinationBranch({
      approvedDestinationBranches: [],
      repositoryRoot: repoB,
      destinationBranch: "main",
      authorizations: [active],
      now,
    }).authorized,
    false,
  );
  // Expiry: no operator action required for the grant to lapse.
  assert.equal(
    authorizeDestinationBranch({
      approvedDestinationBranches: [],
      repositoryRoot: repoA,
      destinationBranch: "main",
      authorizations: [active],
      now: new Date("2026-10-12T00:00:00Z"),
    }).authorized,
    false,
  );
  // Revocation: explicit and auditable.
  assert.equal(
    authorizeDestinationBranch({
      approvedDestinationBranches: [],
      repositoryRoot: repoA,
      destinationBranch: "main",
      authorizations: [{ ...active, revokedAt: "2026-10-09T12:00:00Z" }],
      now,
    }).authorized,
    false,
  );
  // A grant must not be usable without a parseable grant time.
  assert.equal(
    authorizeDestinationBranch({
      approvedDestinationBranches: [],
      repositoryRoot: repoA,
      destinationBranch: "main",
      authorizations: [{ ...active, grantedAt: "not-a-date" }],
      now,
    }).authorized,
    false,
  );

  const described = describeAuthorizations(
    [active, { ...active, branch: "main", revokedAt: "2026-10-09T12:00:00Z" }].map(
      (entry, index) => ({ ...entry, branch: index === 0 ? "main" : "release" }),
    ),
    now,
  );
  assert.equal(described[0].state, "active");

  // Branch-name hygiene.
  for (const bad of ["", "..", "a..b", "a b", "a~b", "a:b", "a?b", "a*b", "a\\b", "a.lock"]) {
    assert.equal(
      isSafeAuthorizationBranch(bad),
      false,
      `${JSON.stringify(bad)} must not be authorizable`,
    );
  }
  for (const good of ["main", "feat/x", "devspace/integration/y"]) {
    assert.equal(isSafeAuthorizationBranch(good), true);
  }
  assert.equal(isProtectedDefaultBranch("main"), true);
  assert.equal(isProtectedDefaultBranch("master"), true);
  assert.equal(isProtectedDefaultBranch("feat/x"), false);
}

/** A standing default-branch grant must be rejected at config load. */
function testProtectedDefaultBranchConfig(): void {
  const dir = mkdtempSync(join(root, "cfg-"));
  const configPath = join(dir, "config.json");
  const repoRoot = realpathSync(root);
  const base = {
    allowedRoots: [repoRoot],
    gitRemoteWrite: {
      enabled: true,
      approvedRemotes: ["origin"],
      approvedDestinationBranches: ["devspace/integration/x"],
      approvedRepositoryRoots: [repoRoot],
      approvedRemoteUrls: { origin: ["https://example.com/repo"] },
    },
  };
  writeFileSync(configPath, JSON.stringify(base));
  const loaded = loadConfig({ DEVSPACE_CONFIG_DIR: dir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough" } as NodeJS.ProcessEnv);
  assert.deepEqual(loaded.gitRemoteWrite.approvedDestinationBranches, [
    "devspace/integration/x",
  ]);
  assert.deepEqual(loaded.gitRemoteWrite.branchAuthorizations, []);

  // `main` in the static list is a hard configuration error.
  writeFileSync(
    configPath,
    JSON.stringify({
      ...base,
      gitRemoteWrite: {
        ...base.gitRemoteWrite,
        approvedDestinationBranches: ["main"],
      },
    }),
  );
  assert.throws(
    () => loadConfig({ DEVSPACE_CONFIG_DIR: dir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough" } as NodeJS.ProcessEnv),
    /must not contain the protected default branch/,
  );

  // A scoped, expiring authorization is the sanctioned path.
  writeFileSync(
    configPath,
    JSON.stringify({
      ...base,
      gitRemoteWrite: {
        ...base.gitRemoteWrite,
        branchAuthorizations: [
          {
            branch: "main",
            repositoryRoot: repoRoot,
            grantedAt: "2026-10-10T00:00:00Z",
            expiresAt: "2026-10-11T00:00:00Z",
            grantedBy: "operator",
          },
        ],
      },
    }),
  );
  const withGrant = loadConfig({
    DEVSPACE_CONFIG_DIR: dir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough",
  } as NodeJS.ProcessEnv);
  assert.equal(withGrant.gitRemoteWrite.branchAuthorizations.length, 1);

  // Malformed authorizations must fail loudly rather than be dropped.
  for (const bad of [
    { branch: "main" }, // no root / grant time
    { branch: "bad name", repositoryRoot: repoRoot, grantedAt: "2026-10-10T00:00:00Z" },
    { branch: "x", repositoryRoot: "/not/approved", grantedAt: "2026-10-10T00:00:00Z" },
    { branch: "x", repositoryRoot: repoRoot, grantedAt: "nope" },
    { branch: "x", repositoryRoot: repoRoot, grantedAt: "2026-10-10T00:00:00Z", expiresAt: "nope" },
  ]) {
    writeFileSync(
      configPath,
      JSON.stringify({
        ...base,
        gitRemoteWrite: { ...base.gitRemoteWrite, branchAuthorizations: [bad] },
      }),
    );
    assert.throws(
      () => loadConfig({ DEVSPACE_CONFIG_DIR: dir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough" } as NodeJS.ProcessEnv),
      /branchAuthorizations|uthoriz/,
      `must reject ${JSON.stringify(bad)}`,
    );
  }
}

/** The operator's live config must not carry a standing default-branch grant. */
async function testLiveConfigHasNoStandingMainGrant(): Promise<void> {
  const livePath = "/Users/liz/.devspace/config.json";
  if (!existsSync(livePath)) return;
  let parsed: { gitRemoteWrite?: { approvedDestinationBranches?: string[] } };
  try {
    parsed = JSON.parse(readFileSync(livePath, "utf8"));
  } catch {
    return;
  }
  const branches = parsed.gitRemoteWrite?.approvedDestinationBranches ?? [];
  assert.equal(
    branches.includes("main"),
    false,
    "main must not be a standing approved destination branch",
  );
  assert.equal(branches.includes("master"), false);
}

async function waitForTerminal(
  manager: BackgroundJobManager,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.poll(jobId);
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
        snapshot.status,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
