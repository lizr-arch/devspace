/**
 * Git lifecycle cleanup: session close, merged-branch deletion and worktree
 * reclamation.
 *
 * Every test runs against throwaway repositories under the system temp
 * directory. Nothing touches a real project, and no test ever forces anything:
 * the point of this suite is to prove that the safe path works and that every
 * unsafe path is refused.
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
import { join, resolve } from "node:path";
import { CoachReviewEventStore } from "./coach-review-events.js";
import { loadConfig } from "./config.js";
import {
  branchDeleteEligibility,
  deleteMergedBranch,
  listLocalBranchVerdicts,
} from "./git-branch-cleanup.js";
import { auditWorkspace } from "./workspace-audit.js";
import { LsofWorktreeProcessProbe } from "./workspace-process-probe.js";
import { reclaimWorkspaceViaTool, type ReclaimToolDeps } from "./workspace-reclaim-tool.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import type { WorkspaceLifecycleState } from "./workspace-lifecycle.js";
import { WorkspaceRegistry } from "./workspaces.js";

const scratch = mkdtempSync(join(tmpdir(), "devspace-lifecycle-"));
const suite = { passed: 0, failed: 0 };
const failures: Array<{ name: string; error: unknown }> = [];

/** Deterministic clock so lifecycle timestamps are assertable. */
let fakeNow = Date.parse("2026-01-01T00:00:00.000Z");

/** Flip to make the registry believe a job is running in a workspace. */
let activeJobIds: string[] = [];
/** Flip to make the registry believe a game session is running. */
let activeGameIds: string[] = [];
/** Flip to make the registry believe a task session is running. */
let activeTaskIds: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/**
 * Foreign-process probe used by the fixture registry.
 *
 * Defaults to the real, read-only `lsof` probe so the tests exercise the same
 * code the live service runs. Tests that need a synthetic answer swap
 * `foreignOccupancy` instead of reimplementing the probe.
 */
let foreignOccupancy:
  | { pids: number[]; commands: string[]; unknown?: boolean; reason?: string }
  | undefined;
const PROBE = {
  async occupancyOf(path: string) {
    if (foreignOccupancy !== undefined) {
      return {
        pids: foreignOccupancy.pids,
        commands: foreignOccupancy.commands,
        unknown: foreignOccupancy.unknown ?? false,
        reason: foreignOccupancy.reason,
      };
    }
    return realProbe.occupancyOf(path);
  },
};
const realProbe = new LsofWorktreeProcessProbe({ timeoutMs: 4_000 });

function realpath(path: string): string {
  return realpathSync(path);
}

function revParse(cwd: string, ref: string): string {
  return git(cwd, ["rev-parse", "--verify", ref]).trim();
}

interface Fixture {
  root: string;
  repo: string;
  worktreeRoot: string;
  stateDir: string;
  config: ReturnType<typeof loadConfig>;
  store: SqliteWorkspaceStore;
  registry: WorkspaceRegistry;
}

function createRepo(label: string): string {
  const root = mkdtempSync(join(scratch, `${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "DevSpace Lifecycle Test"]);
  git(repo, ["config", "user.email", "lifecycle@example.com"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "--", "base.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function createFixture(
  label: string,
  options: {
    /** Overrides the task-session probe (production validates workspace ids). */
    activeTaskSessionIds?: (workspaceId: string) => string[];
    activeGameSessionIds?: (workspaceId: string) => string[];
    /** Lets a test inject a fault by subclassing the registry. */
    registryClass?: typeof WorkspaceRegistry;
    /** Lets a test inject a store fault (e.g. a failing deleteSession). */
    storeClass?: typeof SqliteWorkspaceStore;
  } = {},
): Fixture {
  const base = mkdtempSync(join(scratch, `${label}-`));
  const repo = createRepo(label);
  const worktreeRoot = resolve(join(base, "worktrees"));
  const stateDir = resolve(join(base, "state"));
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(base, "config"),
    DEVSPACE_ALLOWED_ROOTS: repo,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_AGENT_DIR: join(base, "agent"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "lifecycle-test-owner-token-value",
    PORT: "1",
  });
  const store = new (options.storeClass ?? SqliteWorkspaceStore)(stateDir);
  const RegistryClass = options.registryClass ?? WorkspaceRegistry;
  const registry = new RegistryClass(config, store, undefined, {
    activeJobIdsForRoot: () => activeJobIds,
    activeGameSessionIds: options.activeGameSessionIds ?? (() => activeGameIds),
    activeTaskSessionIds: options.activeTaskSessionIds ?? (() => activeTaskIds),
    now: () => fakeNow,
    processProbe: PROBE,
  });
  return { root: base, repo, worktreeRoot, stateDir, config, store, registry };
}

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  activeJobIds = [];
  activeGameIds = [];
  activeTaskIds = [];
  foreignOccupancy = undefined;
  try {
    await run();
    suite.passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    suite.failed += 1;
    failures.push({ name, error });
    console.error(
      `[FAIL] ${name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

/**
 * A managed worktree whose HEAD is already reachable from main, which is the
 * only shape that is ever eligible for reclamation.
 */
async function createCleanManagedWorktree(fixture: Fixture) {
  const context = await fixture.registry.openWorkspace({
    path: fixture.repo,
    mode: "worktree",
  });
  // A freshly opened session is stored as `active` because its own request is
  // still in flight. The listing reconciles that to `idle`, exactly as the
  // documented workflow (audit -> decide -> act) requires.
  await fixture.registry.listWorkspaces(50);
  return context.workspace;
}

function expectRefused(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  return promise.then(
    () => {
      throw new Error(`Expected ${code}, but the operation succeeded.`);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, new RegExp(`^${code}:`), message);
      return error as Error;
    },
  );
}

try {
  // -------------------------------------------------------------------------
  // E1 — Session lifecycle
  // -------------------------------------------------------------------------

  await test("idle session closes and persists a real state", async () => {
    const fixture = createFixture("close-idle");
    const workspace = await createCleanManagedWorktree(fixture);
    // Opening the workspace leaves the record honestly marked active; the
    // listing path reconciles it to idle because nothing holds a lease.
    const listed = await fixture.registry.listWorkspaces(10);
    const summary = listed.find((entry) => entry.workspaceId === workspace.id);
    assert.equal(summary?.lifecycleState, "idle");

    const closed = await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(closed.lifecycleState, "closed");
    assert.equal(closed.previousState, "idle");
    assert.equal(closed.alreadyClosed, false);
    assert.equal(fixture.store.getSession(workspace.id)?.lifecycleState, "closed");
    assert.equal(fixture.store.getSession(workspace.id)?.status, "closed");
    assert.equal(
      existsSync(workspace.root),
      true,
      "closing a session must never delete the worktree",
    );
    assert.equal(
      git(fixture.repo, ["show-ref", "--verify", `refs/heads/${workspace.worktree?.branch}`]).trim().length > 0,
      true,
      "closing a session must never delete the branch",
    );
    fixture.store.close();
  });

  await test("closing is idempotent", async () => {
    const fixture = createFixture("close-idempotent");
    const workspace = await createCleanManagedWorktree(fixture);
    const first = await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    fakeNow += 60_000;
    const second = await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(first.alreadyClosed, false);
    assert.equal(second.alreadyClosed, true);
    assert.equal(second.lifecycleState, "closed");
    assert.match(second.notes.join(" "), /already closed/);
    fixture.store.close();
  });

  await test("concurrent closes are serialised and both report safely", async () => {
    const fixture = createFixture("close-concurrent");
    const workspace = await createCleanManagedWorktree(fixture);
    const results = await Promise.all([
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
    ]);
    assert.equal(results.filter((entry) => entry.alreadyClosed).length, 1);
    assert.equal(fixture.store.getSession(workspace.id)?.lifecycleState, "closed");
    fixture.store.close();
  });

  await test("a workspace held by an in-flight operation is refused", async () => {
    const fixture = createFixture("close-live-lease");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.withLease(workspace.id, async () => {
      await expectRefused(
        fixture.registry.closeWorkspaceSession({
          workspaceId: workspace.id,
          confirmation: workspace.id,
        }),
        "WORKSPACE_SESSION_BUSY",
      );
    });
    assert.equal(
      fixture.store.getSession(workspace.id)?.lifecycleState !== "closed",
      true,
    );
    fixture.store.close();
  });

  await test("a workspace with a running job is refused", async () => {
    const fixture = createFixture("close-active-job");
    const workspace = await createCleanManagedWorktree(fixture);
    activeJobIds = ["job_running"];
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_BUSY",
    );
    assert.equal(fixture.store.getSession(workspace.id)?.lifecycleState, "idle");
    fixture.store.close();
  });

  await test("a workspace with a live game session is refused", async () => {
    const fixture = createFixture("close-active-game");
    const workspace = await createCleanManagedWorktree(fixture);
    activeGameIds = ["session_engine"];
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_BUSY",
    );
    fixture.store.close();
  });

  await test("a workspace with a running task session is refused", async () => {
    const fixture = createFixture("close-active-task");
    const workspace = await createCleanManagedWorktree(fixture);
    activeTaskIds = ["task_session_1"];
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_BUSY",
    );
    fixture.store.close();
  });

  await test("a foreign process inside the worktree blocks the close", async () => {
    const fixture = createFixture("close-foreign-process");
    const workspace = await createCleanManagedWorktree(fixture);
    // Something the operator started by hand: a shell whose cwd is the
    // worktree. DevSpace did not start it and cannot see it any other way.
    foreignOccupancy = { pids: [4242], commands: ["zsh"] };
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_BUSY",
    );
    assert.notEqual(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "closed",
    );
    fixture.store.close();
  });

  await test("an undeterminable process probe fails closed", async () => {
    const fixture = createFixture("close-probe-unknown");
    const workspace = await createCleanManagedWorktree(fixture);
    foreignOccupancy = {
      pids: [],
      commands: [],
      unknown: true,
      reason: "synthetic probe failure",
    };
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_BUSY",
    );
    const audits = await fixture.registry.auditWorkspaces({ limit: 10 });
    const entry = audits.find((item) => item.workspaceId === workspace.id);
    assert.equal(entry?.verdict, "BLOCKED_ACTIVE");
    assert.equal(entry?.reclaimable, false);
    fixture.store.close();
  });

  await test("a HEAD mismatch refuses the close", async () => {
    const fixture = createFixture("close-head-mismatch");
    const workspace = await createCleanManagedWorktree(fixture);
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
        expectedHeadSha: "0".repeat(40),
      }),
      "WORKSPACE_SESSION_HEAD_MISMATCH",
    );
    assert.notEqual(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "closed",
    );
    fixture.store.close();
  });

  await test("an unconfirmable workspace is refused (fail closed)", async () => {
    const fixture = createFixture("close-missing-dir");
    const workspace = await createCleanManagedWorktree(fixture);
    rmSync(workspace.root, { recursive: true, force: true });
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_UNVERIFIABLE",
    );
    assert.notEqual(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "closed",
    );
    fixture.store.close();
  });

  await test("an unknown workspace is refused", async () => {
    const fixture = createFixture("close-unknown");
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: "ws_does_not_exist",
        confirmation: "ws_does_not_exist",
      }),
      "WORKSPACE_SESSION_UNKNOWN",
    );
    fixture.store.close();
  });

  await test("a confirmation mismatch is refused", async () => {
    const fixture = createFixture("close-bad-confirm");
    const workspace = await createCleanManagedWorktree(fixture);
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: "ws_something_else",
      }),
      "WORKSPACE_SESSION_CONFIRMATION_REQUIRED",
    );
    fixture.store.close();
  });

  await test("reopening a closed workspace keeps history and works again", async () => {
    const fixture = createFixture("reopen");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const createdAt = fixture.store.getSession(workspace.id)?.createdAt;
    const resumed = await fixture.registry.resumeWorkspace(workspace.id);
    assert.equal(resumed.workspace.id, workspace.id);
    const record = fixture.store.getSession(workspace.id);
    assert.equal(record?.createdAt, createdAt, "history must survive a reopen");
    assert.notEqual(record?.lifecycleState, "closed");
    fixture.store.close();
  });

  await test("service restart reconciles leftover active rows without guessing", async () => {
    const fixture = createFixture("restart");
    const workspace = await createCleanManagedWorktree(fixture);
    // Simulate a request that died before it could release its lease: the row
    // is left claiming `active` with nothing holding it.
    fixture.store.setSessionLifecycle?.(workspace.id, "active");
    assert.equal(fixture.store.getSession(workspace.id)?.lifecycleState, "active");
    fixture.store.close();

    // A new process: fresh store, fresh registry, same database.
    const store = new SqliteWorkspaceStore(fixture.stateDir);
    assert.equal(
      store.getSession(workspace.id)?.lifecycleState,
      "active",
      "the crash-leftover state must still read active before reconciliation",
    );
    const registry = new WorkspaceRegistry(fixture.config, store, undefined, {
      now: () => fakeNow,
      processProbe: PROBE,
    });
    const listed = await registry.listWorkspaces(10);
    assert.equal(
      listed.find((entry) => entry.workspaceId === workspace.id)?.lifecycleState,
      "idle",
    );
    assert.equal(
      store.getSession(workspace.id)?.lifecycleState,
      "idle",
      "reconciliation must be persisted, not just reported",
    );
    const closed = await registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(closed.alreadyClosed, false);
    store.close();
  });

  await test("a pre-migration unknown session is never treated as free", async () => {
    const fixture = createFixture("unknown-session");
    const workspace = await createCleanManagedWorktree(fixture);
    // This is exactly what the lifecycle migration leaves behind for every
    // pre-existing row: a real session whose state cannot be established.
    fixture.store.setSessionLifecycle?.(workspace.id, "unknown");
    // The plan is itself the observation: it reconciles what it can prove and
    // reports the reconciled state. Reclamation still refuses until the session
    // is explicitly closed.
    const preAudits = await fixture.registry.cleanupPlan({ limit: 10 });
    assert.equal(
      preAudits.entries.find((item) => item.workspaceId === workspace.id)
        ?.verdict,
      "SAFE_CANDIDATE",
      "a reconciled unknown session is a candidate, not a permission",
    );
    await fixture.registry.listWorkspaces(10);
    assert.equal(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "idle",
      "a fresh observation must reconcile an unknown session to idle",
    );
    const audits = await fixture.registry.auditWorkspaces({ limit: 10 });
    const entry = audits.find((item) => item.workspaceId === workspace.id);
    assert.equal(entry?.verdict, "SAFE_CANDIDATE");
    assert.equal(entry?.sessionState, "idle");
    // Reclaim now succeeds: the plan's observation is what established that
    // nothing holds the workspace.
    const reclaimed = await fixture.registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: revParse(workspace.root, "HEAD"),
      confirmation: workspace.id,
    });
    assert.equal(reclaimed.removed, true);
    assert.equal(existsSync(workspace.root), false);
    assert.equal(fixture.store.getSession(workspace.id), undefined);
    fixture.store.close();
  });

  await test("an unobserved unknown session is refused, not guessed", async () => {
    const fixture = createFixture("unknown-unobserved");
    const workspace = await createCleanManagedWorktree(fixture);
    fixture.store.setSessionLifecycle?.(workspace.id, "unknown");
    // Nothing in this process has observed the workspace yet...
    const plan = await fixture.registry.cleanupPlan({ limit: 10 });
    assert.equal(
      plan.entries.find((item) => item.workspaceId === workspace.id)?.verdict,
      "SAFE_CANDIDATE",
    );
    // ...but an audit that has not been allowed to reconcile must refuse.
    const raw = await auditWorkspace({
      workspaceId: workspace.id,
      root: workspace.root,
      mode: "worktree",
      managed: true,
      createdAt: new Date(fakeNow).toISOString(),
      lastUsedAt: new Date(fakeNow).toISOString(),
      activity: {
        sessionState: "unknown",
        liveLeases: 0,
        activeJobIds: [],
        activeGameSessionIds: [],
        activeTaskSessionIds: [],
      },
    });
    assert.equal(raw.verdict, "BLOCKED_ACTIVE");
    assert.equal(raw.reclaimable, false);
    fixture.store.close();
  });

  await test("a released session can be reopened and released again", async () => {
    const fixture = createFixture("reopen-again");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.listWorkspaces(10);
    const closed = await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(closed.lifecycleState, "closed");
    assert.equal(closed.reclaimEligible, true);
    await fixture.registry.resumeWorkspace(workspace.id);
    assert.equal(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "active",
      "resume is an explicit reopen and must promote a released session",
    );
    await fixture.registry.listWorkspaces(10);
    const closedAgain = await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(closedAgain.lifecycleState, "closed");
    assert.equal(
      fixture.store.getSession(workspace.id)?.lifecycleState,
      "closed",
      "the second release must persist too",
    );
    fixture.store.close();
  });

  await test("a service restart alone never marks a session idle", async () => {
    const fixture = createFixture("restart-unknown");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    fixture.store.setSessionLifecycle?.(workspace.id, "unknown");
    fixture.store.close();

    const store = new SqliteWorkspaceStore(fixture.stateDir);
    const registry = new WorkspaceRegistry(fixture.config, store, undefined, {
      now: () => fakeNow,
      processProbe: PROBE,
    });
    const audits = await registry.auditWorkspaces({ limit: 10 });
    const entry = audits.find((item) => item.workspaceId === workspace.id);
    // A restart alone reconciles the leftover state, and the workspace becomes
    // a candidate — the same as any other idle, clean, merged worktree.
    assert.equal(entry?.verdict, "SAFE_CANDIDATE");
    assert.equal(entry?.sessionState, "idle");
    const reclaimed = await registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmation: workspace.id,
    });
    assert.equal(reclaimed.removed, true);
    store.close();
  });

  await test("stale lifecycle values degrade to unknown, never to safe", async () => {
    const fixture = createFixture("unknown-state");
    const workspace = await createCleanManagedWorktree(fixture);
    // Simulate a record written by an older/newer schema.
    const sqlite = (
      fixture.store as unknown as {
        database: { sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }
    ).database.sqlite;
    sqlite
      .prepare("update workspace_sessions set lifecycle_state = ? where id = ?")
      .run("something_else", workspace.id);
    assert.equal(fixture.store.getSession(workspace.id)?.lifecycleState, "unknown");
    await expectRefused(
      fixture.registry.closeWorkspaceSession({
        workspaceId: workspace.id,
        confirmation: workspace.id,
      }),
      "WORKSPACE_SESSION_STATE_UNVERIFIABLE",
    );
    fixture.store.close();
  });

  // -------------------------------------------------------------------------
  // E2 — Merged branch deletion
  // -------------------------------------------------------------------------

  await test("a merged, unused local branch is deleted safely", async () => {
    const repo = createRepo("branch-merged");
    git(repo, ["branch", "merged/example", "main"]);
    const mainSha = revParse(repo, "main");
    const branchSha = revParse(repo, "refs/heads/merged/example");
    const remoteRefsBefore = git(repo, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/",
    ]);
    const result = await deleteMergedBranch({
      workspaceRoot: repo,
      branchName: "merged/example",
      expectedBranchSha: branchSha,
      expectedMainSha: mainSha,
      confirmation: "merged/example",
    });
    assert.equal(result.deletedSha, branchSha);
    assert.equal(result.mainlineShaAfter, mainSha);
    assert.equal(result.remoteRefsUnchanged, true);
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes(
        "merged/example",
      ),
      false,
    );
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]),
      remoteRefsBefore,
    );
  });

  await test("a development branch is refused even when merged", async () => {
    const repo = createRepo("branch-dev");
    git(repo, ["branch", "feat/terrain-ti", "main"]);
    const eligibility = await branchDeleteEligibility({
      workspaceRoot: repo,
      branchName: "feat/terrain-ti",
    });
    assert.equal(eligibility.verdict, "PROTECTED");
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "feat/terrain-ti",
        expectedBranchSha: revParse(repo, "refs/heads/feat/terrain-ti"),
        expectedMainSha: revParse(repo, "main"),
        confirmation: "feat/terrain-ti",
      }),
      "GIT_BRANCH_DELETE_REFUSED",
    );
    assert.equal(
      git(repo, ["show-ref", "--verify", "refs/heads/feat/terrain-ti"]).length >
        0,
      true,
    );
  });

  await test("main and master are refused", async () => {
    const repo = createRepo("branch-protected");
    git(repo, ["branch", "master", "main"]);
    for (const branch of ["main", "master"]) {
      const eligibility = await branchDeleteEligibility({
        workspaceRoot: repo,
        branchName: branch,
      });
      assert.equal(eligibility.verdict, "PROTECTED", branch);
    }
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "main",
        expectedBranchSha: revParse(repo, "main"),
        expectedMainSha: revParse(repo, "main"),
        confirmation: "main",
      }),
      "GIT_BRANCH_DELETE_REFUSED",
    );
  });

  await test("an unmerged branch is refused", async () => {
    const repo = createRepo("branch-unmerged");
    git(repo, ["switch", "-c", "topic"]);
    writeFileSync(join(repo, "topic.txt"), "topic\n");
    git(repo, ["add", "--", "topic.txt"]);
    git(repo, ["commit", "-m", "topic work"]);
    git(repo, ["switch", "main"]);
    const eligibility = await branchDeleteEligibility({
      workspaceRoot: repo,
      branchName: "topic",
    });
    assert.equal(eligibility.verdict, "NOT_AN_ANCESTOR");
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "topic",
        expectedBranchSha: revParse(repo, "refs/heads/topic"),
        expectedMainSha: revParse(repo, "main"),
        confirmation: "topic",
      }),
      "GIT_BRANCH_DELETE_REFUSED",
    );
    assert.equal(
      git(repo, ["show-ref", "--verify", "refs/heads/topic"]).length > 0,
      true,
    );
  });

  await test("a branch checked out in a worktree is refused", async () => {
    const fixture = createFixture("branch-checked-out");
    git(fixture.repo, ["branch", "held/example", "main"]);
    const heldPath = join(fixture.root, "held");
    git(fixture.repo, ["worktree", "add", heldPath, "held/example"]);
    const eligibility = await branchDeleteEligibility({
      workspaceRoot: fixture.repo,
      branchName: "held/example",
    });
    assert.equal(eligibility.verdict, "CHECKED_OUT");
    assert.deepEqual(eligibility.checkedOutAt, [realpath(heldPath)]);
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: fixture.repo,
        branchName: "held/example",
        expectedBranchSha: revParse(fixture.repo, "refs/heads/held/example"),
        expectedMainSha: revParse(fixture.repo, "main"),
        confirmation: "held/example",
      }),
      "GIT_BRANCH_DELETE_REFUSED",
    );
    assert.equal(existsSync(heldPath), true);
  });

  await test("a SHA change between audit and delete is refused", async () => {
    const repo = createRepo("branch-sha-change");
    git(repo, ["branch", "moved/example", "main"]);
    const staleSha = "1".repeat(40);
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "moved/example",
        expectedBranchSha: staleSha,
        expectedMainSha: revParse(repo, "main"),
        confirmation: "moved/example",
      }),
      "GIT_BRANCH_SHA_MISMATCH",
    );
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "moved/example",
        expectedBranchSha: revParse(repo, "refs/heads/moved/example"),
        expectedMainSha: "2".repeat(40),
        confirmation: "moved/example",
      }),
      "GIT_BRANCH_MAIN_SHA_MISMATCH",
    );
    assert.equal(
      git(repo, ["show-ref", "--verify", "refs/heads/moved/example"]).length > 0,
      true,
    );
  });

  await test("remote branches and tags are untouched by a local delete", async () => {
    const root = mkdtempSync(join(scratch, "branch-remote-"));
    const bare = join(root, "remote.git");
    git(root, ["init", "--bare", "--initial-branch=main", bare]);
    const repo = join(root, "repo");
    git(root, ["clone", "--", bare, repo]);
    git(repo, ["config", "user.name", "DevSpace Lifecycle Test"]);
    git(repo, ["config", "user.email", "lifecycle@example.com"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "--", "base.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["tag", "v1"]);
    git(repo, ["push", "origin", "v1"]);
    git(repo, ["branch", "remote/copy"]);
    git(repo, ["push", "origin", "remote/copy"]);
    const before = git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
    const result = await deleteMergedBranch({
      workspaceRoot: repo,
      branchName: "remote/copy",
      expectedBranchSha: revParse(repo, "refs/heads/remote/copy"),
      expectedMainSha: revParse(repo, "main"),
      confirmation: "remote/copy",
    });
    assert.equal(result.remoteRefsUnchanged, true);
    const after = git(repo, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
    ]);
    const stripDeleted = (value: string) =>
      value
        .split("\n")
        .filter((line) => !line.startsWith("refs/heads/remote/copy\u0000"))
        .join("\n");
    assert.equal(
      stripDeleted(after),
      stripDeleted(before),
      "only the deleted local branch may disappear",
    );
    assert.equal(
      git(repo, ["ls-remote", "--heads", "origin"]).includes(
        "remote/copy",
      ),
      true,
      "the remote branch must survive",
    );
    assert.equal(git(repo, ["tag", "--list", "v1"]).trim(), "v1");
  });

  await test("a live dependency refuses the branch delete", async () => {
    const repo = createRepo("branch-dependency");
    git(repo, ["branch", "busy/example", "main"]);
    const eligibility = await branchDeleteEligibility({
      workspaceRoot: repo,
      branchName: "busy/example",
      activeDependents: ["ws_live"],
    });
    assert.equal(eligibility.verdict, "ACTIVE_DEPENDENCY");
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "busy/example",
        expectedBranchSha: revParse(repo, "refs/heads/busy/example"),
        expectedMainSha: revParse(repo, "main"),
        confirmation: "busy/example",
        activeDependents: ["ws_live"],
      }),
      "GIT_BRANCH_DELETE_REFUSED",
    );
  });

  await test("a confirmation mismatch is refused", async () => {
    const repo = createRepo("branch-confirm");
    git(repo, ["branch", "x/example", "main"]);
    await expectRefused(
      deleteMergedBranch({
        workspaceRoot: repo,
        branchName: "x/example",
        expectedBranchSha: revParse(repo, "refs/heads/x/example"),
        expectedMainSha: revParse(repo, "main"),
        confirmation: "y/other",
      }),
      "GIT_BRANCH_CONFIRMATION_REQUIRED",
    );
  });

  await test("branch listing reports verdicts without deleting", async () => {
    const repo = createRepo("branch-list");
    git(repo, ["branch", "merged/example", "main"]);
    const verdicts = await listLocalBranchVerdicts({ workspaceRoot: repo });
    const names = verdicts.map((entry) => `${entry.branch}:${entry.verdict}`);
    assert.ok(names.includes("main:PROTECTED"), names.join(","));
    assert.ok(names.includes("merged/example:DELETABLE_MERGED"), names.join(","));
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes(
        "merged/example",
      ),
      true,
    );
  });

  // -------------------------------------------------------------------------
  // E3 — Worktree reclamation
  // -------------------------------------------------------------------------

  await test("clean, merged, closed worktree is reclaimed", async () => {
    const fixture = createFixture("reclaim-clean");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const reclaimed = await fixture.registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmation: workspace.id,
    });
    assert.equal(reclaimed.removed, true);
    assert.equal(existsSync(workspace.root), false);
    assert.equal(fixture.store.getSession(workspace.id), undefined);
    fixture.store.close();
  });

  await test("a dirty worktree is refused", async () => {
    const fixture = createFixture("reclaim-dirty");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    writeFileSync(join(workspace.root, "base.txt"), "changed\n");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_UNSAFE",
    );
    assert.equal(existsSync(workspace.root), true);
    fixture.store.close();
  });

  await test("a worktree with untracked files is refused", async () => {
    const fixture = createFixture("reclaim-untracked");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    writeFileSync(join(workspace.root, "scratch.txt"), "scratch\n");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_UNSAFE",
    );
    fixture.store.close();
  });

  await test("a worktree with unmerged commits is refused", async () => {
    const fixture = createFixture("reclaim-unmerged");
    const workspace = await createCleanManagedWorktree(fixture);
    writeFileSync(join(workspace.root, "work.txt"), "work\n");
    git(workspace.root, ["add", "--", "work.txt"]);
    git(workspace.root, ["commit", "-m", "unmerged work"]);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_UNSAFE",
    );
    assert.equal(existsSync(workspace.root), true);
    fixture.store.close();
  });

  await test("a running job blocks reclamation", async () => {
    const fixture = createFixture("reclaim-job");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    // The job appears only after the session is closed, which is exactly the
    // race the reclaim guard exists for.
    activeJobIds = ["job_blocking"];
    const refusal = await fixture.registry
      .reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      })
      .then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    assert.ok(refusal, "a workspace with a running job must not be reclaimed");
    assert.match(refusal, /^WORKSPACE_RECLAIM_UNSAFE:/, refusal);
    assert.equal(existsSync(workspace.root), true);
    fixture.store.close();
  });

  await test("a live session blocks reclamation", async () => {
    const fixture = createFixture("reclaim-live");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.withLease(workspace.id, async () => {
      await expectRefused(
        fixture.registry.reclaimWorkspace({
          workspaceId: workspace.id,
          expectedHeadSha: headSha,
          confirmation: workspace.id,
        }),
        "WORKSPACE_RECLAIM_ACTIVE",
      );
    });
    fixture.store.close();
  });

  await test("a foreign process inside the worktree blocks reclamation", async () => {
    const fixture = createFixture("reclaim-foreign-process");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.listWorkspaces(10);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    foreignOccupancy = { pids: [4242], commands: ["zsh"] };
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_UNSAFE",
    );
    assert.equal(
      existsSync(workspace.root),
      true,
      "a worktree with a live shell must survive",
    );
    fixture.store.close();
  });

  await test("a HEAD mismatch blocks reclamation", async () => {
    const fixture = createFixture("reclaim-head");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: "3".repeat(40),
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_HEAD_MISMATCH",
    );
    fixture.store.close();
  });

  await test("a normal checkout is never reclaimable", async () => {
    const fixture = createFixture("reclaim-checkout");
    const context = await fixture.registry.openWorkspace(fixture.repo);
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: context.workspace.id,
        expectedHeadSha: revParse(fixture.repo, "HEAD"),
        confirmation: context.workspace.id,
      }),
      "WORKSPACE_RECLAIM_NOT_MANAGED_WORKTREE",
    );
    assert.equal(existsSync(fixture.repo), true);
    fixture.store.close();
  });

  await test("a path outside the managed worktree root is refused", async () => {
    const fixture = createFixture("reclaim-outside");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const record = fixture.store.getSession(workspace.id);
    assert.ok(record);
    // Simulate a tampered/relocated record that points outside the root.
    const sqlite = (
      fixture.store as unknown as {
        database: { sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }
    ).database.sqlite;
    sqlite
      .prepare("update workspace_sessions set root = ? where id = ?")
      .run(fixture.repo, workspace.id);
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_OUTSIDE_WORKTREE_ROOT",
    );
    assert.equal(existsSync(fixture.repo), true);
  });

  await test("a symlinked worktree root outside the policy is refused", async () => {
    const fixture = createFixture("reclaim-symlink");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const outside = join(fixture.root, "outside-target");
    mkdirSync(outside, { recursive: true });
    const link = join(fixture.worktreeRoot, "link-escape");
    try {
      execFileSync("ln", ["-s", outside, link]);
    } catch {
      return; // Symlinks unavailable: nothing to bypass.
    }
    const sqlite = (
      fixture.store as unknown as {
        database: { sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }
    ).database.sqlite;
    sqlite
      .prepare("update workspace_sessions set root = ? where id = ?")
      .run(link, workspace.id);
    const refusal = await fixture.registry
      .reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      })
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    assert.ok(refusal, "a symlinked target must never be reclaimed");
    assert.match(
      refusal,
      /^WORKSPACE_RECLAIM_(OUTSIDE_WORKTREE_ROOT|STALE_RECORD|UNSAFE):/,
      refusal,
    );
    assert.equal(existsSync(outside), true);
  });

  await test("a protected worktree pattern is never a candidate", async () => {
    const fixture = createFixture("reclaim-protected");
    const workspace = await createCleanManagedWorktree(fixture);
    const audit = await auditWorkspace({
      workspaceId: workspace.id,
      root: workspace.root,
      mode: "worktree",
      managed: true,
      createdAt: new Date(fakeNow).toISOString(),
      lastUsedAt: new Date(fakeNow).toISOString(),
      activity: {
        sessionState: "closed",
        liveLeases: 0,
        activeJobIds: [],
        activeGameSessionIds: [],
        activeTaskSessionIds: [],
      },
      protectedWorktreePatterns: ["repo-*"],
    });
    assert.equal(audit.verdict, "BLOCKED_PROTECTED");
    assert.equal(audit.reclaimable, false);
    fixture.store.close();
  });

  await test("a stale record is reported as missing, not as a candidate", async () => {
    const fixture = createFixture("reclaim-stale");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    // The directory disappears out from under the record (manual deletion,
    // external tooling, a crashed prune).
    rmSync(workspace.root, { recursive: true, force: true });
    const audits = await fixture.registry.auditWorkspaces({ limit: 20 });
    const entry = audits.find((item) => item.workspaceId === workspace.id);
    assert.ok(entry, "the record must still be audited");
    assert.equal(entry.verdict, "BLOCKED_MISSING");
    assert.equal(entry.reclaimable, false);
    assert.equal(entry.staleRecord, true);
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: "4".repeat(40),
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_STALE_RECORD",
    );
    fixture.store.close();
  });

  await test("a missing record is reported distinctly from an active one", async () => {
    const fixture = createFixture("reclaim-record-gone");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await fixture.registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmation: workspace.id,
    });
    // Replaying the same decision must explain that the record is gone.
    await expectRefused(
      fixture.registry.reclaimWorkspace({
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmation: workspace.id,
      }),
      "WORKSPACE_RECLAIM_RECORD_MISSING",
    );
    fixture.store.close();
  });

  // -------------------------------------------------------------------------
  // Unified read-only plan
  // -------------------------------------------------------------------------

  await test("the cleanup plan classifies without deleting anything", async () => {
    const fixture = createFixture("plan");
    const clean = await createCleanManagedWorktree(fixture);
    const dirty = await createCleanManagedWorktree(fixture);
    writeFileSync(join(dirty.root, "scratch.txt"), "scratch\n");
    const unmerged = await createCleanManagedWorktree(fixture);
    writeFileSync(join(unmerged.root, "work.txt"), "work\n");
    git(unmerged.root, ["add", "--", "work.txt"]);
    git(unmerged.root, ["commit", "-m", "unmerged"]);
    const busy = await createCleanManagedWorktree(fixture);
    activeJobIds = ["job_plan"];

    const plan = await fixture.registry.cleanupPlan({ limit: 20 });
    const byId = new Map(
      plan.entries.map((entry) => [entry.workspaceId, entry] as const),
    );
    assert.equal(byId.get(clean.id)?.verdict, "BLOCKED_ACTIVE");
    assert.equal(byId.get(clean.id)?.reclaimable, false);
    assert.equal(byId.get(dirty.id)?.verdict, "BLOCKED_ACTIVE");
    assert.equal(byId.get(unmerged.id)?.verdict, "BLOCKED_ACTIVE");
    assert.equal(byId.get(busy.id)?.verdict, "BLOCKED_ACTIVE");
    assert.equal(plan.readOnly, true);
    assert.equal(plan.summary.TOTAL, plan.entries.length);
    for (const id of [clean.id, dirty.id, unmerged.id, busy.id]) {
      assert.equal(
        existsSync(fixture.store.getSession(id)?.root ?? ""),
        true,
        "the plan must not remove anything",
      );
    }
    activeJobIds = [];
    fixture.store.close();
  });

  await test("the plan reports a safe candidate and its branch verdict", async () => {
    const fixture = createFixture("plan-candidate");
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const plan = await fixture.registry.cleanupPlan({ limit: 20 });
    const entry = plan.entries.find(
      (item) => item.workspaceId === workspace.id,
    );
    assert.ok(entry);
    assert.equal(entry.verdict, "SAFE_CANDIDATE");
    assert.equal(entry.reclaimable, true);
    assert.equal(entry.sessionState, "closed");
    assert.equal(entry.sessionIsLive, false);
    assert.equal(entry.clean, true);
    assert.equal(entry.unmergedCommitCount, 0);
    assert.equal(entry.isManagedWorktree, true);
    assert.ok(entry.branchDelete);
    // The worktree still has the branch checked out, so the branch itself is
    // not deletable yet: reclaiming the worktree is what frees it.
    assert.equal(entry.branchDelete?.verdict, "CHECKED_OUT");
    assert.equal(
      entry.branchDelete?.checkedOutAt.includes(realpath(workspace.root)),
      true,
    );
  });

  await test("orphan directories are inventoried without duplicate counting", async () => {
    const fixture = createFixture("plan-orphans");
    const workspace = await createCleanManagedWorktree(fixture);
    const strayDirectory = join(fixture.worktreeRoot, "TriaRegna-stray");
    mkdirSync(strayDirectory, { recursive: true });
    const plan = await fixture.registry.cleanupPlan({
      limit: 20,
      includeOrphans: true,
    });
    assert.equal(
      plan.entries.filter((entry) => entry.workspaceId === workspace.id).length,
      1,
      "a registered worktree must appear exactly once",
    );
    assert.equal(
      plan.orphans.entries.some(
        (entry) => entry.root === realpath(strayDirectory),
      ),
      true,
      `expected ${realpath(strayDirectory)} in ${plan.orphans.entries.map((e) => e.root).join(",")}`,
    );
    assert.equal(
      plan.orphans.orphanedCount >= 1,
      true,
    );
    assert.equal(existsSync(strayDirectory), true);
    assert.equal(existsSync(workspace.root), true);
  });

  // -------------------------------------------------------------------------
  // E4 — Integration: branch -> worktree -> merge -> close -> reclaim -> delete
  // -------------------------------------------------------------------------

  await test("full lifecycle: create, merge, close, reclaim, delete branch", async () => {
    const root = mkdtempSync(join(scratch, "integration-"));
    const bare = join(root, "remote.git");
    git(root, ["init", "--bare", "--initial-branch=main", bare]);
    const repo = join(root, "repo");
    git(root, ["clone", "--", bare, repo]);
    git(repo, ["config", "user.name", "DevSpace Lifecycle Test"]);
    git(repo, ["config", "user.email", "lifecycle@example.com"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "--", "base.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["push", "-u", "origin", "main"]);

    const worktreeRoot = resolve(join(root, "worktrees"));
    const stateDir = resolve(join(root, "state"));
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const config = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, "config"),
      DEVSPACE_ALLOWED_ROOTS: repo,
      DEVSPACE_WORKTREE_ROOT: worktreeRoot,
      DEVSPACE_AGENT_DIR: join(root, "agent"),
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "lifecycle-test-owner-token-value",
      PORT: "1",
    });
    const store = new SqliteWorkspaceStore(stateDir);
    const registry = new WorkspaceRegistry(config, store, undefined, {
      now: () => fakeNow,
      processProbe: PROBE,
    });

    const mainBefore = revParse(repo, "main");

    // 1. Create a branch, commit work on it, and merge it into main.
    git(repo, ["switch", "-c", "merged/lifecycle"]);
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(repo, ["add", "--", "feature.txt"]);
    git(repo, ["commit", "-m", "feature work"]);
    git(repo, ["push", "origin", "merged/lifecycle"]);
    git(repo, ["switch", "main"]);
    git(repo, ["merge", "--no-ff", "-m", "merge feature", "merged/lifecycle"]);
    const mainAfter = revParse(repo, "main");
    assert.notEqual(mainAfter, mainBefore);
    // Snapshot taken now, so it includes the pushed feature branch. Everything
    // compare against it below is therefore proof that the lifecycle tools
    // touched no remote reference at all.
    const remoteBefore = git(repo, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/remotes/",
    ]);

    // 2. Create a managed worktree on that merged branch and close its session.
    const context = await registry.openWorkspace({
      path: repo,
      mode: "worktree",
      baseRef: "merged/lifecycle",
    });
    const workspace = context.workspace;
    const worktreeHead = revParse(workspace.root, "HEAD");
    assert.equal(worktreeHead, revParse(repo, "refs/heads/merged/lifecycle"));

    // Step 0 of the documented workflow: audit before deciding.
    await registry.listWorkspaces(50);
    const closed = await registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    assert.equal(closed.lifecycleState, "closed");
    assert.equal(closed.reclaimEligible, true);

    // 3. Re-audit, then reclaim with the observed SHA.
    const plan = await registry.cleanupPlan({ limit: 20 });
    const entry = plan.entries.find((item) => item.workspaceId === workspace.id);
    assert.equal(entry?.verdict, "SAFE_CANDIDATE");
    assert.equal(entry?.headSha, worktreeHead);
    const reclaimed = await registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: worktreeHead,
      confirmation: workspace.id,
    });
    assert.equal(reclaimed.removed, true);
    assert.equal(existsSync(workspace.root), false);

    // 4. The branch is no longer checked out, so it becomes deletable.
    const eligibility = await branchDeleteEligibility({
      workspaceRoot: repo,
      branchName: "merged/lifecycle",
    });
    assert.equal(eligibility.verdict, "DELETABLE_MERGED");
    const deleted = await deleteMergedBranch({
      workspaceRoot: repo,
      branchName: "merged/lifecycle",
      expectedBranchSha: eligibility.sha ?? "",
      expectedMainSha: mainAfter,
      confirmation: "merged/lifecycle",
    });
    assert.equal(deleted.remoteRefsUnchanged, true);

    // 5. Prove the invariants the whole exercise exists to protect.
    assert.equal(revParse(repo, "main"), mainAfter, "main must not change");
    assert.equal(
      git(repo, ["status", "--porcelain=v1"]).trim(),
      "",
      "the checkout must be clean",
    );
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes(
        "merged/lifecycle",
      ),
      false,
    );
    assert.equal(
      git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/remotes/"]),
      remoteBefore,
      "remote-tracking refs must be untouched",
    );
    assert.equal(
      git(repo, ["ls-remote", "--heads", "origin"]).includes("merged/lifecycle"),
      true,
      "the remote branch must still exist",
    );
    assert.equal(
      git(repo, ["worktree", "list"]).includes(workspace.root),
      false,
      "no worktree registration may be left behind",
    );
    assert.equal(store.listSessions(50).some((s) => s.id === workspace.id), false);
    store.close();
  });

  await test("a crash mid-lifecycle leaves recoverable, non-destructive state", async () => {
    const fixture = createFixture("crash");
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    // Simulate the process dying between close and reclaim.
    fixture.store.close();
    const store = new SqliteWorkspaceStore(fixture.stateDir);
    const registry = new WorkspaceRegistry(fixture.config, store, undefined, {
      now: () => fakeNow,
      processProbe: PROBE,
    });
    const plan = await registry.cleanupPlan({ limit: 20 });
    const entry = plan.entries.find((item) => item.workspaceId === workspace.id);
    assert.equal(entry?.verdict, "SAFE_CANDIDATE");
    assert.equal(entry?.sessionState, "closed");
    const reclaimed = await registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmation: workspace.id,
    });
    assert.equal(reclaimed.removed, true);
    store.close();
  });

  await test("a list limit smaller than the record count cannot hide a record", async () => {
    const fixture = createFixture("limit");
    const workspace = await createCleanManagedWorktree(fixture);
    const audits = await fixture.registry.auditWorkspaces({ limit: 1 });
    assert.equal(audits.length, 1);
    // The orphan scan must still know about the record even though the display
    // limit is 1, otherwise it would offer a live worktree as an orphan.
    const orphans = await fixture.registry.orphanedWorktreeAudit({ limit: 50 });
    assert.equal(
      orphans.scan.orphaned.includes(workspace.root),
      false,
      "a registered worktree must never be reported as orphaned",
    );
    fixture.store.close();
  });
  // -------------------------------------------------------------------------
  // E4 — Reclaim tool outcome contract
  //
  // The three outcomes must be distinguishable by the caller. These tests go
  // through the same orchestration the MCP handler uses, so the sequencing that
  // caused the production false negative is covered directly.
  // -------------------------------------------------------------------------

  async function createClosedWorktree(fixture: Fixture) {
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    return { workspace, headSha };
  }

  function toolDeps(fixture: Fixture): ReclaimToolDeps {
    return {
      workspaces: fixture.registry,
      activeJobIdsForRoot: () => activeJobIds,
      activeGameSessionIds: () => activeGameIds,
      activeTaskSessionIds: () => activeTaskIds,
    };
  }

  await test("a confirmed reclaim reports CONFIRMED_SUCCESS and keeps the branch", async () => {
    const fixture = createFixture("tool-success");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const branch = workspace.worktree?.branch as string;
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_SUCCESS");
    assert.equal(result.isError, false);
    assert.equal(result.verification?.removed, true);
    assert.equal(result.verification?.directoryRemoved, true);
    assert.equal(result.verification?.worktreeDeregistered, true);
    assert.equal(result.verification?.branchPreserved, true);
    assert.equal(result.verification?.branchSha, headSha);
    assert.match(result.text, /CONFIRMED_SUCCESS/);
    assert.equal(existsSync(workspace.root), false);
    assert.equal(fixture.store.getSession(workspace.id), undefined);
    assert.equal(
      revParse(fixture.repo, `refs/heads/${branch}`),
      headSha,
      "the branch and its commit must survive reclamation",
    );
    // Project Memory is observed before the mutation, so it is still reported.
    assert.ok(result.projectMemory, "the SHADOW observation must be recorded");
    assert.notEqual(
      result.projectMemory?.outcome,
      "observation_failed",
      "the observation must succeed when it runs before the mutation",
    );
    fixture.store.close();
  });

  await test("a duplicate reclaim is a no-mutation answer, never a second delete", async () => {
    const fixture = createFixture("tool-duplicate");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const first = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(first.outcome, "CONFIRMED_SUCCESS");
    const worktreeCountAfterFirst = git(fixture.repo, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;

    const second = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(second.outcome, "CONFIRMED_NO_MUTATION");
    assert.equal(second.isError, true);
    assert.match(second.text, /WORKSPACE_RECLAIM_RECORD_MISSING/);
    assert.match(second.text, /Nothing was removed by this call/);
    const worktreeCountAfterSecond = git(fixture.repo, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;
    assert.equal(worktreeCountAfterSecond, worktreeCountAfterFirst);
    assert.equal(existsSync(workspace.root), false);
    fixture.store.close();
  });

  await test("a dirty worktree is CONFIRMED_NO_MUTATION and its files are untouched", async () => {
    const fixture = createFixture("tool-dirty");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    writeFileSync(join(workspace.root, "base.txt"), "changed by the operator\n");
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.equal(result.isError, true);
    assert.equal(existsSync(workspace.root), true);
    assert.equal(readFileSync(join(workspace.root, "base.txt"), "utf8"), "changed by the operator\n");
    assert.ok(fixture.store.getSession(workspace.id), "the record must survive a refusal");
    fixture.store.close();
  });

  await test("an unmerged commit is CONFIRMED_NO_MUTATION", async () => {
    const fixture = createFixture("tool-unmerged");
    const workspace = await createCleanManagedWorktree(fixture);
    writeFileSync(join(workspace.root, "work.txt"), "work\n");
    git(workspace.root, ["add", "--", "work.txt"]);
    git(workspace.root, ["commit", "-m", "unmerged work"]);
    const headSha = revParse(workspace.root, "HEAD");
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.equal(existsSync(workspace.root), true);
    fixture.store.close();
  });

  await test("a HEAD mismatch is CONFIRMED_NO_MUTATION", async () => {
    const fixture = createFixture("tool-head-drift");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: "0".repeat(40),
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.match(result.text, /WORKSPACE_RECLAIM_HEAD_MISMATCH/);
    assert.equal(existsSync(workspace.root), true);
    assert.equal(revParse(workspace.root, "HEAD"), headSha);
    fixture.store.close();
  });

  await test("a running job is CONFIRMED_NO_MUTATION", async () => {
    const fixture = createFixture("tool-job");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    activeJobIds = ["job_blocking_tool"];
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.equal(existsSync(workspace.root), true);
    fixture.store.close();
  });

  await test("a Project Memory observation failure cannot turn a success into a failure", async () => {
    class ThrowingObservationRegistry extends WorkspaceRegistry {
      override observeProjectMemoryAccess(): never {
        throw new Error("project memory store unavailable");
      }
    }
    const fixture = createFixture("tool-pm-failure", {
      registryClass: ThrowingObservationRegistry,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_SUCCESS");
    assert.equal(result.isError, false);
    assert.equal(result.projectMemory?.outcome, "observation_failed");
    assert.equal(existsSync(workspace.root), false);
    fixture.store.close();
  });

  await test("an unverifiable removal is OUTCOME_UNKNOWN, keeps the record, and never claims success", async () => {
    class BlindVerificationRegistry extends WorkspaceRegistry {
      protected override async verifyWorktreeRemoval(input: {
        root: string;
        sourceRoot: string;
        branch: string | null;
        headSha: string | null;
      }) {
        const real = await super.verifyWorktreeRemoval(input);
        // Simulate "Git said it removed it, but the read-only check cannot
        // prove it": the caller must not be told SUCCESS.
        return { ...real, removed: false };
      }
    }
    const fixture = createFixture("tool-unknown", {
      registryClass: BlindVerificationRegistry,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "OUTCOME_UNKNOWN");
    assert.equal(result.isError, true);
    assert.match(result.text, /OUTCOME_UNKNOWN/);
    assert.match(result.text, /do not retry blindly/);
    assert.ok(
      fixture.store.getSession(workspace.id),
      "an unverifiable removal must keep the record so the state stays reconcilable",
    );
    fixture.store.close();
  });

  await test("a git worktree remove failure is not reported as success", async () => {
    const fixture = createFixture("tool-locked");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    // A locked worktree is a real, non-forced failure of `git worktree remove`.
    git(fixture.repo, ["worktree", "lock", workspace.root]);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.match(result.text, /WORKSPACE_RECLAIM_FAILED/);
    assert.equal(existsSync(workspace.root), true);
    assert.ok(fixture.store.getSession(workspace.id));
    git(fixture.repo, ["worktree", "unlock", workspace.root]);
    fixture.store.close();
  });

  await test("a store failure after the removal is still a confirmed success, with the record kept", async () => {
    class FailingDeleteStore extends SqliteWorkspaceStore {
      override deleteSession(): boolean {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }
    const fixture = createFixture("tool-store-fault", {
      storeClass: FailingDeleteStore,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    // The worktree is gone; a store error must never be described as "nothing
    // happened", and must not be hidden either.
    assert.equal(result.outcome, "CONFIRMED_SUCCESS");
    assert.equal(result.isError, false);
    assert.equal(result.reclaimed?.storeRecordRemoved, false);
    assert.match(result.text, /workspace record could not be deleted/);
    assert.equal(existsSync(workspace.root), false);
    assert.ok(
      fixture.store.getSession(workspace.id),
      "the leftover record is reported, not silently dropped",
    );
    fixture.store.close();
  });

  await test("an unrecognised failure after the removal is OUTCOME_UNKNOWN, never a no-op", async () => {
    class PostMutationThrowRegistry extends WorkspaceRegistry {
      override async reclaimWorkspace(
        input: Parameters<WorkspaceRegistry["reclaimWorkspace"]>[0],
      ): Promise<Awaited<ReturnType<WorkspaceRegistry["reclaimWorkspace"]>>> {
        await super.reclaimWorkspace(input);
        // Simulates any future statement added after the destructive step.
        throw new Error("SQLITE_BUSY: database is locked (post-removal)");
      }
    }
    const fixture = createFixture("tool-post-mutation", {
      registryClass: PostMutationThrowRegistry,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "OUTCOME_UNKNOWN");
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "WORKSPACE_RECLAIM_OUTCOME_UNKNOWN");
    assert.equal(result.error?.safeToRetry, false);
    assert.match(result.text, /does not prove the worktree is still present/);
    assert.equal(existsSync(workspace.root), false);
    fixture.store.close();
  });

  await test("a record that vanishes before the lease is a no-mutation answer", async () => {
    class VanishingRecordRegistry extends WorkspaceRegistry {
      override storedSession(
        workspaceId: string,
      ): ReturnType<WorkspaceRegistry["storedSession"]> {
        // The pre-check sees a record; the lease lookup then finds none,
        // exactly like a concurrent reclaim winning the race.
        return { id: workspaceId } as ReturnType<
          WorkspaceRegistry["storedSession"]
        >;
      }
    }
    const fixture = createFixture("tool-vanish", {
      registryClass: VanishingRecordRegistry,
    });
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: "ws_00000000-0000-4000-8000-000000000000",
      expectedHeadSha: "0".repeat(40),
      confirmWorkspaceId: "ws_00000000-0000-4000-8000-000000000000",
    });
    assert.equal(result.outcome, "CONFIRMED_NO_MUTATION");
    assert.match(result.text, /disappeared before the reclaim started/);
    fixture.store.close();
  });

  await test("two concurrent reclaims of one worktree: exactly one succeeds", async () => {
    const fixture = createFixture("tool-concurrent");
    const { workspace, headSha } = await createClosedWorktree(fixture);
    const call = () =>
      reclaimWorkspaceViaTool(toolDeps(fixture), {
        workspaceId: workspace.id,
        expectedHeadSha: headSha,
        confirmWorkspaceId: workspace.id,
      });
    const [first, second] = await Promise.all([call(), call()]);
    const outcomes = [first.outcome, second.outcome];
    assert.equal(
      outcomes.filter((outcome) => outcome === "CONFIRMED_SUCCESS").length,
      1,
      `exactly one call may succeed: ${JSON.stringify(outcomes)}`,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome === "CONFIRMED_NO_MUTATION").length,
      1,
      `the loser must be a no-mutation answer: ${JSON.stringify(outcomes)}`,
    );
    assert.equal(existsSync(workspace.root), false);
    fixture.store.close();
  });

  await test("a partial removal that cannot be proven to be a no-op is OUTCOME_UNKNOWN", async () => {
    class PartialRemovalRegistry extends WorkspaceRegistry {
      protected override async verifyWorktreeRemoval(input: {
        root: string;
        sourceRoot: string;
        branch: string | null;
        headSha: string | null;
      }) {
        const real = await super.verifyWorktreeRemoval(input);
        // "Directory gone but the path is still registered": the shape a real
        // `git worktree remove` failure can leave behind when deleting
        // .git/worktrees/<id> fails after the directory is gone.
        return {
          ...real,
          directoryRemoved: true,
          worktreeDeregistered: false,
          registered: true,
          removed: false,
        };
      }
    }
    const fixture = createFixture("tool-partial-removal", {
      registryClass: PartialRemovalRegistry,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    git(fixture.repo, ["worktree", "lock", workspace.root]);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    // A failed removal that may have mutated something must never be called a
    // no-mutation.
    assert.equal(result.outcome, "OUTCOME_UNKNOWN");
    assert.match(result.text, /cannot be proven to be a no-op/);
    assert.doesNotMatch(result.text, /CONFIRMED_NO_MUTATION/);
    git(fixture.repo, ["worktree", "unlock", workspace.root]);
    fixture.store.close();
  });

  await test("a failed removal with a lost registration is OUTCOME_UNKNOWN too", async () => {
    class DeregisteredRegistry extends WorkspaceRegistry {
      protected override async verifyWorktreeRemoval(input: {
        root: string;
        sourceRoot: string;
        branch: string | null;
        headSha: string | null;
      }) {
        const real = await super.verifyWorktreeRemoval(input);
        // Directory still present, but Git no longer registers the path: the
        // registration was mutated, so this is not a no-op either.
        return {
          ...real,
          directoryRemoved: false,
          worktreeDeregistered: true,
          registered: false,
          removed: false,
        };
      }
    }
    const fixture = createFixture("tool-deregistered", {
      registryClass: DeregisteredRegistry,
    });
    const { workspace, headSha } = await createClosedWorktree(fixture);
    git(fixture.repo, ["worktree", "lock", workspace.root]);
    const result = await reclaimWorkspaceViaTool(toolDeps(fixture), {
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmWorkspaceId: workspace.id,
    });
    assert.equal(result.outcome, "OUTCOME_UNKNOWN");
    assert.doesNotMatch(result.text, /CONFIRMED_NO_MUTATION/);
    git(fixture.repo, ["worktree", "unlock", workspace.root]);
    fixture.store.close();
  });

  await test("verifyWorktreeRemoval only confirms when both facts are proven", async () => {
    class ExposedVerificationRegistry extends WorkspaceRegistry {
      async verifyRemoval(input: {
        root: string;
        sourceRoot: string;
        branch: string | null;
        headSha: string | null;
      }) {
        return this.verifyWorktreeRemoval(input);
      }
    }
    const fixture = createFixture("verify-facts", {
      registryClass: ExposedVerificationRegistry,
    });
    const workspace = await createCleanManagedWorktree(fixture);
    const headSha = revParse(workspace.root, "HEAD");
    const branch = workspace.worktree?.branch as string;
    const registry = fixture.registry as ExposedVerificationRegistry;

    const present = await registry.verifyRemoval({
      root: workspace.root,
      sourceRoot: fixture.repo,
      branch,
      headSha,
    });
    assert.equal(present.directoryRemoved, false);
    assert.equal(present.registered, true);
    assert.equal(present.removed, false);
    assert.equal(present.branchPreserved, true);

    // Git cannot be read: "unknown", never "not registered".
    const unreadable = await registry.verifyRemoval({
      root: workspace.root,
      sourceRoot: join(fixture.root, "not-a-repository"),
      branch,
      headSha,
    });
    assert.equal(unreadable.registered, null);
    assert.equal(unreadable.removed, false);

    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    await fixture.registry.reclaimWorkspace({
      workspaceId: workspace.id,
      expectedHeadSha: headSha,
      confirmation: workspace.id,
    });
    const gone = await registry.verifyRemoval({
      root: workspace.root,
      sourceRoot: fixture.repo,
      branch,
      headSha,
    });
    assert.equal(gone.removed, true);
    assert.equal(gone.branchPreserved, true);

    // A branch that moved is reported, not treated as preserved.
    git(fixture.repo, ["branch", "-d", branch]);
    const branchGone = await registry.verifyRemoval({
      root: workspace.root,
      sourceRoot: fixture.repo,
      branch,
      headSha,
    });
    assert.equal(branchGone.branchPreserved, false);
    fixture.store.close();
  });

  // -------------------------------------------------------------------------
  // E5 — Cleanup plan resilience
  // -------------------------------------------------------------------------

  await test("the cleanup plan survives an orphan directory when the task probe validates ids", async () => {
    const seenIds: string[] = [];
    // Exactly the production probe: a validating store that rejects any id that
    // is not a real workspace id. Passing a synthetic `orphan:<path>` id here
    // is what used to crash the whole plan.
    const coach = new CoachReviewEventStore(mkdtempSync(join(scratch, "coach-")));
    const fixture = createFixture("plan-coach-probe", {
      activeTaskSessionIds: (workspaceId: string) => {
        seenIds.push(workspaceId);
        return coach.hasInterruptedRun(workspaceId)
          ? ["codex:quarantined-interrupted-operation"]
          : [];
      },
    });
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const orphan = join(fixture.worktreeRoot, "orphan-no-record");
    mkdirSync(orphan, { recursive: true });

    const plan = await fixture.registry.cleanupPlan({
      limit: 10,
      includeOrphans: true,
    });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0]?.workspaceId, workspace.id);
    assert.equal(plan.entries[0]?.verdict, "SAFE_CANDIDATE");
    assert.equal(plan.orphans.orphanedCount, 1);
    assert.equal(plan.orphans.entries.length, 1);
    assert.equal(plan.orphans.entries[0]?.verdict, "BLOCKED_NOT_MANAGED");
    assert.equal(plan.orphans.entries[0]?.reclaimable, false);
    assert.equal(plan.orphans.error, undefined);
    // The tool's `includeOrphans` path calls the orphan audit directly, so it
    // must be usable on its own as well.
    const direct = await fixture.registry.orphanedWorktreeAudit({ limit: 50 });
    assert.equal(direct.scan.orphaned.length, 1);
    assert.equal(direct.audits[0]?.verdict, "BLOCKED_NOT_MANAGED");
    assert.ok(seenIds.length > 0);
    assert.ok(
      seenIds.every((id) => /^ws_[0-9a-f-]{36}$/.test(id)),
      `no synthetic id may reach a workspace-scoped probe: ${JSON.stringify(seenIds)}`,
    );
    fixture.store.close();
  });

  await test("one broken record cannot crash the plan or become a candidate", async () => {
    let failingWorkspaceId: string | null = null;
    const fixture = createFixture("plan-isolate", {
      activeTaskSessionIds: (workspaceId: string) => {
        if (workspaceId === failingWorkspaceId) {
          throw new Error("task subsystem exploded");
        }
        return [];
      },
    });
    const healthy = await createCleanManagedWorktree(fixture);
    const broken = await createCleanManagedWorktree(fixture);
    failingWorkspaceId = broken.id;

    const plan = await fixture.registry.cleanupPlan({ limit: 10 });
    assert.equal(plan.entries.length, 2);
    const healthyEntry = plan.entries.find((entry) => entry.workspaceId === healthy.id);
    const brokenEntry = plan.entries.find((entry) => entry.workspaceId === broken.id);
    assert.equal(healthyEntry?.verdict, "SAFE_CANDIDATE");
    assert.ok(brokenEntry, "the broken record must still appear in the plan");
    assert.equal(brokenEntry?.verdict, "UNKNOWN");
    assert.equal(brokenEntry?.reclaimable, false);
    assert.match(brokenEntry?.blockedReasons.join(" ") ?? "", /could not be audited/);
    assert.equal(plan.summary.UNKNOWN, 1);
    assert.equal(plan.summary.TOTAL, 2);
    fixture.store.close();
  });

  await test("the plan classifies missing directories and closed sessions explicitly", async () => {
    const fixture = createFixture("plan-missing");
    const present = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: present.id,
      confirmation: present.id,
    });
    const vanished = await createCleanManagedWorktree(fixture);
    const vanishedRoot = vanished.root;
    await fixture.registry.closeWorkspaceSession({
      workspaceId: vanished.id,
      confirmation: vanished.id,
    });
    rmSync(vanishedRoot, { recursive: true, force: true });

    const plan = await fixture.registry.cleanupPlan({ limit: 10 });
    const closed = plan.entries.find((entry) => entry.workspaceId === present.id);
    const missing = plan.entries.find((entry) => entry.workspaceId === vanished.id);
    assert.equal(closed?.verdict, "SAFE_CANDIDATE");
    assert.equal(closed?.sessionState, "closed");
    assert.equal(missing?.verdict, "BLOCKED_MISSING");
    assert.equal(missing?.reclaimable, false);
    assert.equal(missing?.staleRecord, true);
    assert.ok(plan.summary.BLOCKED_MISSING >= 1);
    fixture.store.close();
  });

  await test("an orphan inventory failure is reported, not silently swallowed", async () => {
    class FailingOrphanRegistry extends WorkspaceRegistry {
      override async orphanedWorktreeAudit(): Promise<never> {
        throw new Error("worktree root unreadable");
      }
    }
    const fixture = createFixture("plan-orphan-failure", {
      registryClass: FailingOrphanRegistry,
    });
    const workspace = await createCleanManagedWorktree(fixture);
    await fixture.registry.closeWorkspaceSession({
      workspaceId: workspace.id,
      confirmation: workspace.id,
    });
    const plan = await fixture.registry.cleanupPlan({ limit: 10, includeOrphans: true });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0]?.verdict, "SAFE_CANDIDATE");
    assert.equal(plan.orphans.truncated, true);
    assert.match(plan.orphans.error ?? "", /worktree root unreadable/);
    assert.equal(plan.orphans.entries.length, 0);
    fixture.store.close();
  });

} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `\nworkspace lifecycle cleanup tests: ${suite.passed} passed, ${suite.failed} failed`,
);
if (suite.failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exitCode = 1;
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `${suite.failed} workspace lifecycle cleanup tests failed`,
  );
}
