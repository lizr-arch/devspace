import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { inspectGitStatus, runGit } from "./git-tools.js";
import type {
  ProjectMemoryAccessObservation,
  ProjectMemoryActiveState,
  ProjectMemoryPreflightView,
} from "./project-memory.js";
import {
  type AdditionalRoot,
  type EffectiveAdditionalRoot,
  AccessDeniedError,
  assertAllowedPath,
  assertWriteAllowed,
  canonicalRootPath,
  effectiveAdditionalRootAccess,
  expandHomePath,
  isPathInsideAnyRoot,
  isPathInsideRoot,
  normalizeAdditionalRoots,
  resolveAllowedPath,
} from "./roots.js";
import {
  type ResolvedWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-paths.js";
import { ProjectMemoryController } from "./project-memory.js";
import {
  type ApprovedTasks,
  computeManifestSha256,
  loadTaskManifest,
} from "./task-manifest.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

import {
  type LoadedAgentsFile,
  type AvailableAgentsFile,
  type WorkspaceWorktree,
  type AdditionalRootRejection,
  type AdditionalRootsAuthorization,
  type Workspace,
  type WorkspaceContext,
  type WorkspaceSessionSummary,
  type WorkspaceCleanupPlanEntry,
  type WorkspaceReadPath,
  type WorkspaceResolvedPath,
  type OpenWorkspaceInput,
  emptyAdditionalRootsAuthorization,
} from "./workspace-types.js";
import {
  auditWorkspace,
  canonicalPath,
  hasAnyOccupancy,
  hasLiveActivity,
  isSettledSessionState,
  listRegisteredWorktrees,
  matchesAnyPattern,
  scanWorktreeDirectories,
  type WorkspaceAudit,
  type WorkspaceSessionActivity,
  type WorktreeDirectoryScan,
} from "./workspace-audit.js";
import {
  normalizeWorkspaceLifecycleState,
  type WorkspaceCleanupVerdict,
  type WorkspaceLifecycleState,
} from "./workspace-lifecycle.js";
import {
  branchDeleteEligibility,
  type BranchCleanupPolicy,
  type BranchDeleteEligibility,
} from "./git-branch-cleanup.js";

export type {
  LoadedAgentsFile,
  AvailableAgentsFile,
  WorkspaceWorktree,
  AdditionalRootRejection,
  AdditionalRootsAuthorization,
  Workspace,
  WorkspaceContext,
  WorkspaceSessionSummary,
  WorkspaceCleanupPlanEntry,
  WorkspaceReadPath,
  WorkspaceResolvedPath,
  OpenWorkspaceInput,
};

/** Narrow a worktree factory result to the fields the workspace type declares. */
function worktreeAttachment(worktree: {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
  branch?: string;
}): WorkspaceWorktree {
  return {
    path: worktree.path,
    baseRef: worktree.baseRef,
    baseSha: worktree.baseSha,
    dirtySource: worktree.dirtySource,
    detached: worktree.detached,
    managed: worktree.managed,
    branch: worktree.branch,
  };
}

function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The shared Git object directory for a repository or any of its worktrees.
 *
 * Two paths belong to the same repository exactly when this value matches, so
 * it is the identity used to decide whether a workspace could depend on a
 * branch that lives in another worktree.
 */
async function gitCommonDir(path: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return realpathOf(stdout.trim());
  } catch {
    return null;
  }
}

export async function refreshWorkspaceGitAttachment(
  workspace: Workspace,
): Promise<void> {
  if (workspace.mode !== "worktree" || !workspace.worktree) return;
  try {
    const gitStatus = await inspectGitStatus(workspace.root);
    workspace.worktree.detached = !gitStatus.branch;
    workspace.worktree.branch = gitStatus.branch;
  } catch {
    // Gracefully handle uninitialized git directory or transient git errors
  }
}

export interface WorkspaceLifecycleProbes {
  /** Non-terminal background jobs rooted at this workspace path. */
  activeJobIdsForRoot?: (workspaceRoot: string) => string[];
  /** Non-terminal game/engine sessions bound to this workspace. */
  activeGameSessionIds?: (workspaceId: string, workspaceRoot: string) => string[];
  /** Non-terminal task sessions bound to this workspace. */
  activeTaskSessionIds?: (workspaceId: string, workspaceRoot: string) => string[];
  /** Wall-clock source, injectable for deterministic tests. */
  now?: () => number;
  /**
   * Read-only probe for processes DevSpace did not start whose working
   * directory is a managed worktree. Without it, a worktree with a live shell
   * in it would look free.
   */
  processProbe?: {
    occupancyOf(path: string): Promise<{
      pids: number[];
      commands: string[];
      unknown: boolean;
      reason?: string;
    }>;
  };
  /** Whether a missing probe blocks candidates (default) or is tolerated. */
  requireNoForeignProcess?: boolean;
}

/**
 * One workspace held in memory.
 *
 * `leases` is the only thing that makes a session genuinely `active`. A cached
 * entry with zero leases is idle: it exists so repeated tool calls do not
 * re-read skills and instructions from disk, not because anyone is using it.
 */
interface WorkspaceSessionEntry {
  workspace: Workspace;
  /** In-flight DevSpace operations holding this workspace. */
  leases: number;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceSessionEntry>();
  /**
   * Serialises lifecycle transitions per workspace so two concurrent closes (or
   * a close racing an open) cannot interleave their checks and writes.
   */
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
    private readonly projectMemory?: ProjectMemoryController,
    private readonly probes: WorkspaceLifecycleProbes = {},
  ) {}

  private now(): string {
    return new Date(this.probes.now?.() ?? Date.now()).toISOString();
  }

  /** The cached workspace object, without creating a session or a lease. */
  private cachedWorkspace(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId)?.workspace;
  }

  /**
   * Run `operation` while holding a real, observable lease on the workspace.
   *
   * The lease is what the lifecycle audit and `close_workspace_session` read to
   * decide whether a workspace is busy. Without it a concurrent close could
   * succeed while a git merge is mid-flight.
   */
  async withLease<T>(
    workspaceId: string,
    operation: (workspace: Workspace) => Promise<T> | T,
  ): Promise<T> {
    const workspace = this.getWorkspace(workspaceId);
    this.workspaces.get(workspaceId)!.leases += 1;
    try {
      return await operation(workspace);
    } finally {
      this.releaseLease(workspaceId);
    }
  }

  /**
   * Lease a workspace for one MCP tool call.
   *
   * The tool wrapper calls this so *every* workspace tool call is observable as
   * an in-flight holder. It deliberately does not hand the workspace object to
   * the caller: the tool resolves it itself through `getWorkspace`, and the only
   * thing this method contributes is the honest occupancy signal.
   */
  async leaseForToolCall(
    workspaceId: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    return this.withLease(workspaceId, run);
  }

  /**
   * Lease that does not count itself as a blocker.
   *
   * `close_workspace_session` and `reclaim_workspace` must run while holding a
   * lease (so nobody else can take one unnoticed) but must not report their own
   * hold as "someone is using this workspace". The provided `others` reader
   * returns the in-flight count excluding this call.
   */
  async withExclusiveLease<T>(
    workspaceId: string,
    operation: (
      workspace: Workspace,
      others: () => number,
    ) => Promise<T> | T,
  ): Promise<T> {
    const workspace = this.getWorkspace(workspaceId);
    const entry = this.workspaces.get(workspaceId)!;
    entry.leases += 1;
    try {
      return await operation(workspace, () =>
        Math.max(0, this.liveLeases(workspaceId) - 1),
      );
    } finally {
      this.releaseLease(workspaceId);
    }
  }

  private releaseLease(workspaceId: string): void {
    const entry = this.workspaces.get(workspaceId);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    // A session that has been closed must not linger as a live cache entry,
    // even if a straggling request still holds a lease.
    if (
      entry.leases === 0 &&
      this.store?.getSession(workspaceId)?.lifecycleState === "closed"
    ) {
      this.workspaces.delete(workspaceId);
    }
  }

  /**
   * In-flight leases for one workspace. Exposed so the audit and the close tool
   * can report the precise holder instead of a boolean.
   */
  liveLeases(workspaceId: string): number {
    return this.workspaces.get(workspaceId)?.leases ?? 0;
  }

  /**
   * Live runtime activity for one persisted record.
   *
   * Never infers activity from `lastUsedAt`: a workspace used an hour ago by a
   * finished request must not look busy, and a workspace with a running job but
   * no open session must not look free.
   */
  sessionActivityFor(
    session: {
      id: string;
      root: string;
      lifecycleState: WorkspaceLifecycleState;
    },
    overrides: { liveLeases?: number } = {},
  ): WorkspaceSessionActivity {
    return {
      sessionState: session.lifecycleState,
      liveLeases: overrides.liveLeases ?? this.liveLeases(session.id),
      activeJobIds: this.probes.activeJobIdsForRoot?.(session.root) ?? [],
      activeGameSessionIds:
        this.probes.activeGameSessionIds?.(session.id, session.root) ?? [],
      activeTaskSessionIds:
        this.probes.activeTaskSessionIds?.(session.id, session.root) ?? [],
    };
  }

  /**
   * Same as `sessionActivityFor`, plus a read-only operating-system probe for
   * processes DevSpace did not start.
   *
   * When no probe is configured at all, the answer is reported as `unknown`
   * rather than `free`, unless the operator explicitly opted out — a worktree
   * must never look available merely because nobody checked.
   */
  private async sessionActivityWithProcesses(session: {
    id: string;
    root: string;
    lifecycleState: WorkspaceLifecycleState;
  }): Promise<WorkspaceSessionActivity> {
    const activity = this.sessionActivityFor(session);
    const requireProbe = this.probes.requireNoForeignProcess ?? true;
    const probe = this.probes.processProbe;
    // The probe walks a directory tree, so it is only worth running where a
    // reclamation could ever happen. A plain checkout is never reclaimable.
    if (!this.isInsideWorktreeRoot(session.root)) {
      return activity;
    }
    if (!probe) {
      return requireProbe
        ? {
            ...activity,
            foreignProcesses: {
              pids: [],
              commands: [],
              unknown: true,
              reason: "no process probe is configured",
            },
          }
        : activity;
    }
    try {
      const occupancy = await probe.occupancyOf(session.root);
      return { ...activity, foreignProcesses: occupancy };
    } catch (error) {
      return {
        ...activity,
        foreignProcesses: {
          pids: [],
          commands: [],
          unknown: true,
          reason: `the process probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  /**
   * Serialise lifecycle mutations for one workspace. Every transition re-reads
   * state inside the critical section, so a stale decision cannot be applied.
   */
  private async withLifecycleLock<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.lifecycleTails.set(workspaceId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleTails.get(workspaceId) === queued) {
        this.lifecycleTails.delete(workspaceId);
      }
    }
  }

  /**
   * Persist a transition, mirroring the legacy `status` column. Returns the
   * stored session after the write so callers never report a state they did not
   * observe.
   */
  private transition(
    workspaceId: string,
    state: WorkspaceLifecycleState,
    options: { closedReason?: string; touch?: boolean } = {},
  ): void {
    this.store?.setSessionLifecycle?.(workspaceId, state, options);
  }

  async openWorkspace(
    input: string | OpenWorkspaceInput,
  ): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";
    const additionalRootsAuthorization =
      await this.resolveAdditionalRootsAuthorization(
        options.additionalRoots ?? [],
        [],
      );

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(
        options.path,
        options.baseRef,
        options.task,
        additionalRootsAuthorization,
      );
    }

    return this.openCheckoutWorkspace(
      options.path,
      options.task,
      additionalRootsAuthorization,
    );
  }

  async resumeWorkspace(
    workspaceId: string,
    task?: string,
    additionalRoots?: AdditionalRoot[],
  ): Promise<WorkspaceContext> {
    // Resuming is an explicit statement that the workspace is in use again, so
    // it is the one read path that reopens a deliberately closed session.
    this.reopenClosedSession(workspaceId);
    const workspace = this.getWorkspace(workspaceId);
    const rootStats = await stat(workspace.root).catch(() => undefined);
    if (!rootStats?.isDirectory()) {
      throw new Error(
        `Stored workspace is no longer available: ${workspace.root}`,
      );
    }
    await refreshWorkspaceGitAttachment(workspace);

    if (additionalRoots !== undefined) {
      const authorization = await this.resolveAdditionalRootsAuthorization(
        additionalRoots,
        workspace.additionalRoots,
      );
      workspace.additionalRoots = authorization.effectiveAdditionalRoots;
      workspace.additionalRootsAuthorization = authorization;
    }

    const agentsFiles = this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(
      workspace.root,
      agentsFiles,
    );
    const projectMemory = task
      ? await this.preflightProjectMemory(workspace.id, task)
      : undefined;

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      projectMemory,
      additionalRootsAuthorization: workspace.additionalRootsAuthorization,
    };
  }

  async listWorkspaces(limit = 20): Promise<WorkspaceSessionSummary[]> {
    const sessions =
      this.store?.listSessions(limit) ??
      Array.from(this.workspaces.values())
        .slice(-limit)
        .reverse()
        .map(({ workspace }) => ({
          id: workspace.id,
          root: workspace.root,
          status: "active",
          lifecycleState: "idle" as WorkspaceLifecycleState,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          baseRef: workspace.worktree?.baseRef,
          baseSha: workspace.worktree?.baseSha,
          managed: workspace.worktree?.managed ?? false,
          createdAt: "",
          lastUsedAt: "",
        }));
    const summaries: WorkspaceSessionSummary[] = [];

    for (const session of sessions) {
      try {
        this.assertWorkspaceRootAllowed(
          session.root,
          session.mode,
          session.sourceRoot,
        );
      } catch {
        // Do not disclose sessions whose roots are outside the current policy.
        continue;
      }

      const rootStats = await stat(session.root).catch(() => undefined);
      const resumable = Boolean(rootStats?.isDirectory());
      const activeWorkspace = this.cachedWorkspace(session.id);
      const additionalRootsAuthorization =
        activeWorkspace?.additionalRootsAuthorization ??
        emptyAdditionalRootsAuthorization();
      // Persisted `active` is a claim, not a fact. At most one in-flight
      // operation can hold a lease, so a stored `active` seen by the listing
      // path with zero leases is the leftover of a restart or a crash. Demote
      // it exactly once instead of reporting it as live forever.
      const lifecycleState = await this.reconcileSessionLifecycle(session);
      let detached: boolean | undefined;
      let branch: string | undefined;
      if (resumable && session.mode === "worktree") {
        try {
          if (activeWorkspace) {
            await refreshWorkspaceGitAttachment(activeWorkspace);
            detached = activeWorkspace.worktree?.detached;
            branch = activeWorkspace.worktree?.branch;
          } else {
            const gitStatus = await inspectGitStatus(session.root);
            detached = !gitStatus.branch;
            branch = gitStatus.branch;
          }
        } catch {
          // Never return persisted creation-time attachment metadata as if it
          // were current. A later resume will surface the live Git error.
        }
      }
      summaries.push({
        workspaceId: session.id,
        root: session.root,
        mode: session.mode,
        sourceRoot: session.sourceRoot,
        additionalRoots: additionalRootsAuthorization.effectiveAdditionalRoots,
        ...additionalRootsAuthorization,
        managed: session.managed,
        detached,
        branch,
        status: session.status,
        lifecycleState,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        resumable,
        unavailableReason: resumable
          ? undefined
          : "Workspace directory is missing or inaccessible.",
      });
    }

    return summaries;
  }

  /**
   * Reconcile a persisted lifecycle state with observable reality.
   *
   * Only two demotions happen here, both strictly one-way and both requiring
   * positive evidence:
   *   - `active` with zero leases is demoted to `idle`. A live operation always
   *     holds a lease, so `active` + no lease can only be a leftover.
   *   - a record whose directory is gone becomes `stale`.
   *
   * Nothing is ever promoted by this method. Promotion to `active` requires a
   * real lease, and `closed` is cleared only by an explicit reopen.
   */
  private async reconcileSessionLifecycle(session: {
    id: string;
    root: string;
    lifecycleState: WorkspaceLifecycleState;
  }): Promise<WorkspaceLifecycleState> {
    if (!this.store?.setSessionLifecycle) return session.lifecycleState;
    if (
      session.lifecycleState === "active" ||
      session.lifecycleState === "unknown"
    ) {
      // Only demote when nothing at all is holding the workspace. A running
      // job, task or engine keeps the state honest at `active` even though it
      // holds no in-process lease.
      //
      // `unknown` is the state the lifecycle migration leaves on every
      // pre-existing row, so it has to be reconcilable; otherwise those
      // sessions could never be released at all. The observation that promotes
      // it to `idle` is a fresh, positive check made by the running process.
      const activity = await this.sessionActivityWithProcesses({
        id: session.id,
        root: session.root,
        lifecycleState: session.lifecycleState,
      });
      if (hasAnyOccupancy(activity)) {
        this.transition(session.id, "active");
        return "active";
      }
      this.transition(session.id, "idle");
      return "idle";
    }
    if (session.lifecycleState === "closing") {
      // A close that did not finish (crash, interrupted request). Do not guess:
      // leave it for the close tool to reconcile, but never call it idle.
      return "closing";
    }
    return session.lifecycleState;
  }

  /**
   * Read-only lifecycle audit for every listed workspace.
   *
   * The store's legacy `status` column was written `"active"` at creation and
   * never updated, so it cannot be trusted; this derives the real state from
   * the filesystem, Git and live runtime activity, and refuses to call anything
   * reclaimable unless every precondition is positively proven.
   */
  async auditWorkspaces(input: {
    limit?: number;
    /** Roots that currently have a non-terminal background job. */
    activeJobRoots?: (workspaceRoot: string) => string[];
    protectedWorktreePatterns?: readonly string[];
  }): Promise<WorkspaceAudit[]> {
    const summaries = await this.listWorkspaces(input.limit ?? 50);
    const registered = await listRegisteredWorktrees(this.config.worktreeRoot)
      .then((set) => set ?? undefined)
      .catch(() => undefined);
    const audits: WorkspaceAudit[] = [];
    for (const summary of summaries) {
      const stored = this.store?.getSession(summary.workspaceId);
      const activity: WorkspaceSessionActivity =
        await this.sessionActivityWithProcesses(
          stored ?? {
            id: summary.workspaceId,
            root: summary.root,
            lifecycleState: summary.lifecycleState,
          },
        );
      audits.push(
        await auditWorkspace({
          workspaceId: summary.workspaceId,
          root: summary.root,
          mode: summary.mode,
          managed: summary.managed,
          createdAt: summary.createdAt,
          lastUsedAt: summary.lastUsedAt,
          activity: {
            ...activity,
            activeJobIds:
              activity.activeJobIds.length > 0
                ? activity.activeJobIds
                : (input.activeJobRoots?.(summary.root) ?? []),
          },
          registeredWorktrees: registered,
          protectedWorktreePatterns:
            input.protectedWorktreePatterns ??
            this.config.worktreeCleanup?.protectedWorktreePatterns,
        }),
      );
    }
    return audits;
  }

  /**
   * Read-only inventory of directories under the managed worktree root that no
   * workspace record mentions. These are invisible to every existing tool: they
   * are neither listed nor removable.
   *
   * Nothing here deletes anything. The result exists so an operator can decide,
   * with evidence, whether a directory still holds Git references, uncommitted
   * work, unmerged commits, or is in use by another session.
   */
  async orphanedWorktreeAudit(input: {
    limit?: number;
    activeJobRoots?: (workspaceRoot: string) => string[];
    registeredWorktrees?: Set<string> | null;
  }): Promise<{
    scan: WorktreeDirectoryScan;
    audits: WorkspaceAudit[];
    truncated: boolean;
  }> {
    const limit = Math.min(input.limit ?? 50, 200);
    // The listing is capped, so a record outside the window would make a
    // live worktree look orphaned and duplicate it in the report. Ask the store
    // for every record instead of reusing the display limit.
    const summaries = await this.listWorkspaces(
      this.store ? Math.max(limit, 500) : 100,
    );
    // Directory scans can return a symlinked spelling, so both the recorded
    // roots and the Git listing are canonicalised before they are compared.
    const knownRoots = summaries
      .map((summary) => canonicalPath(summary.root));
    const scan = scanWorktreeDirectories(this.config.worktreeRoot, knownRoots);    const registered =
      input.registeredWorktrees !== undefined
        ? input.registeredWorktrees
        : await listRegisteredWorktrees(this.config.worktreeRoot);
    const audits: WorkspaceAudit[] = [];
    const targets = scan.orphaned.slice(0, limit);
    for (const directory of targets) {
      audits.push(
        await auditWorkspace({
          workspaceId: null,
          root: directory,
          mode: "worktree",
          managed: false,
          createdAt: null,
          lastUsedAt: null,
          activity: {
            ...(await this.sessionActivityWithProcesses({
              id: `orphan:${directory}`,
              root: directory,
              lifecycleState: null as unknown as WorkspaceLifecycleState,
            })),
            sessionState: null,
            liveLeases: 0,
            activeJobIds: input.activeJobRoots?.(directory) ?? [],
            activeGameSessionIds: [],
            activeTaskSessionIds: [],
          },
          registeredWorktrees: registered ?? undefined,
          protectedWorktreePatterns:
            this.config.worktreeCleanup?.protectedWorktreePatterns,
        }),
      );
    }
    return {
      scan,
      audits,
      truncated: scan.orphaned.length > targets.length,
    };
  }

  /**
   * Remove one managed Git worktree.
   *
   * Safety rules, all enforced here rather than trusted to the caller:
   *   - only managed worktrees created by DevSpace are eligible; a normal
   *     checkout is never removed;
   *   - the audit is re-run immediately before acting, and any risk refuses;
   *   - the caller must echo the exact current HEAD SHA, so a worktree that
   *     moved since it was inspected cannot be removed by a stale decision;
   *   - removal goes through `git worktree remove` WITHOUT `--force`, so Git
   *     itself refuses a dirty worktree as a second line of defence. No
   *     `git clean`, no reset, no recursive directory delete.
   *
   * The record lookup and the audit read the SAME store the audit plan read.
   * When the record disappeared between the two calls the tool reports a
   * distinct, actionable error instead of a bare "unknown workspace", and when
   * the directory disappeared it reports a stale record.
   */
  async reclaimWorkspace(input: {
    workspaceId: string;
    expectedHeadSha: string;
    confirmation: string;
    /**
     * Resolved lazily from the stored session's root. Passing job ids directly
     * is not enough: the caller would have to look the workspace up first, and
     * that lookup itself attaches a live session, which the active-session
     * guard below then (correctly) refuses.
     */
    activeJobIdsForRoot?: (workspaceRoot: string) => string[];
    /** Resolved lazily for the same reason as the job probe. */
    activeGameSessionIds?: (workspaceId: string, root: string) => string[];
    activeTaskSessionIds?: (workspaceId: string, root: string) => string[];
    protectedWorktreePatterns?: readonly string[];
    /**
     * In-flight operations other than this call. Supplied by the caller when
     * the reclaim itself holds a lease, so the guard does not reject the very
     * request performing it.
     */
    othersHolding?: () => number;
  }): Promise<{
    workspaceId: string;
    root: string;
    removed: true;
    branch: string | null;
    headSha: string;
    storeRecordRemoved: boolean;
    lifecycleState: WorkspaceLifecycleState;
  }> {
    if (input.confirmation !== input.workspaceId) {
      throw new Error(
        "WORKSPACE_RECLAIM_CONFIRMATION_REQUIRED: confirmation must exactly equal the workspaceId being reclaimed.",
      );
    }
    const cacheEntry = this.cachedWorkspace(input.workspaceId);
    const session = this.store?.getSession(input.workspaceId);
    if (!session) {
      const knownOnlyInMemory =
        cacheEntry !== undefined &&
        !this.store?.getSession(input.workspaceId);
      throw new Error(
        knownOnlyInMemory
          ? `WORKSPACE_RECLAIM_NO_RECORD: ${input.workspaceId} exists only in this process and has no persisted record, so it cannot be reclaimed through the audit plan. Re-run list_workspaces(audit=true) to get current ids.`
          : `WORKSPACE_RECLAIM_RECORD_MISSING: No persisted record exists for ${input.workspaceId}. It was already reclaimed or removed; re-run list_workspaces(audit=true).`,
      );
    }
    const othersHolding =
      input.othersHolding ?? (() => this.liveLeases(input.workspaceId));
    if (othersHolding() > 0) {
      throw new Error(
        "WORKSPACE_RECLAIM_ACTIVE: A live DevSpace operation is holding this workspace. Wait for it to finish, then re-audit.",
      );
    }
    if (session.mode !== "worktree" || session.managed !== true) {
      throw new Error(
        "WORKSPACE_RECLAIM_NOT_MANAGED_WORKTREE: Only DevSpace-managed worktrees can be reclaimed. Normal checkouts are never removed.",
      );
    }
    if (!isSettledSessionState(session.lifecycleState)) {
      throw new Error(
        `WORKSPACE_RECLAIM_SESSION_NOT_CLOSED: Workspace session state is "${session.lifecycleState}", which does not prove DevSpace has released it. Close the session with close_workspace_session, or reconcile it with list_workspaces(audit=true), before reclaiming.`,
      );
    }
    const worktreeRoot = this.config.worktreeRoot;
    const registered = await listRegisteredWorktrees(
      session.sourceRoot ?? worktreeRoot,
    );
    const probed = await this.sessionActivityWithProcesses(session);
    const audit = await auditWorkspace({
      workspaceId: session.id,
      root: session.root,
      mode: session.mode,
      managed: session.managed,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      activity: {
        // Self-holds are excluded: this very call is an in-flight operation on
        // the session, and counting it would make every reclaim impossible.
        ...probed,
        sessionState: session.lifecycleState,
        liveLeases: 0,
        activeJobIds:
          probed.activeJobIds.length > 0
            ? probed.activeJobIds
            : (input.activeJobIdsForRoot?.(session.root) ?? []),
        activeGameSessionIds:
          probed.activeGameSessionIds.length > 0
            ? probed.activeGameSessionIds
            : (input.activeGameSessionIds?.(session.id, session.root) ?? []),
        activeTaskSessionIds:
          probed.activeTaskSessionIds.length > 0
            ? probed.activeTaskSessionIds
            : (input.activeTaskSessionIds?.(session.id, session.root) ?? []),
      },
      registeredWorktrees: registered ?? undefined,
      protectedWorktreePatterns:
        input.protectedWorktreePatterns ??
        this.config.worktreeCleanup?.protectedWorktreePatterns,
    });
    if (audit.verdict === "BLOCKED_MISSING") {
      throw new Error(
        `WORKSPACE_RECLAIM_STALE_RECORD: The record for ${session.id} no longer matches the filesystem or Git (${audit.blockedReasons.join("; ")}). It cannot be reclaimed as a worktree; no file, worktree or branch was removed.`,
      );
    }
    // The containment check runs only after the record has been proved to point
    // at a real, registered worktree. Doing it first would reject a deleted
    // worktree with "outside root" — true but useless — instead of telling the
    // caller the record is stale.
    if (!this.isInsideWorktreeRoot(session.root)) {
      throw new Error(
        "WORKSPACE_RECLAIM_OUTSIDE_WORKTREE_ROOT: Refusing to remove a path outside the managed worktree root.",
      );
    }
    if (!audit.reclaimable) {
      throw new Error(
        `WORKSPACE_RECLAIM_UNSAFE: Refusing to remove ${session.root}. ${audit.blockedReasons.join("; ")}.`,
      );
    }
    if (!audit.headSha || audit.headSha !== input.expectedHeadSha) {
      throw new Error(
        `WORKSPACE_RECLAIM_HEAD_MISMATCH: Expected HEAD ${input.expectedHeadSha}, found ${audit.headSha ?? "unknown"}. Re-inspect before reclaiming.`,
      );
    }

    // `git worktree remove` without --force: Git refuses a dirty or locked
    // worktree, which is exactly the second check we want.
    try {
      await runGit(session.sourceRoot ?? session.root, [
        "worktree",
        "remove",
        session.root,
      ]);
    } catch (error) {
      throw new Error(
        `WORKSPACE_RECLAIM_FAILED: git worktree remove refused ${session.root}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const storeRecordRemoved = this.store?.deleteSession?.(session.id) ?? false;
    this.workspaces.delete(session.id);
    return {
      workspaceId: session.id,
      root: session.root,
      removed: true,
      branch: audit.branch,
      headSha: audit.headSha,
      storeRecordRemoved,
      lifecycleState: session.lifecycleState,
    };
  }

  /**
   * Close a workspace session: release DevSpace's session occupancy and persist
   * the lifecycle transition.
   *
   * This is deliberately NOT a delete. It never removes a worktree, a branch, a
   * file, a log, a job, an agent or a Git ref, and it never resets or cleans
   * anything. Closing and reclaiming are separate operations with separate
   * confirmations, and a close that would be unsafe is refused with the exact
   * reason.
   *
   * Idempotent: closing an already-closed session reports `alreadyClosed`
   * instead of failing, and no state is written twice.
   */
  async closeWorkspaceSession(input: {
    workspaceId: string;
    confirmation: string;
    expectedHeadSha?: string;
    reason?: string;
    /**
     * In-flight operations other than this call. Supplied by the caller so the
     * close can hold a lease for safety without treating itself as a blocker.
     */
    othersHolding?: () => number;
  }): Promise<{
    workspaceId: string;
    root: string;
    lifecycleState: WorkspaceLifecycleState;
    previousState: WorkspaceLifecycleState;
    alreadyClosed: boolean;
    headSha: string | null;
    released: {
      liveLeases: number;
      activeJobIds: string[];
      activeGameSessionIds: string[];
      activeTaskSessionIds: string[];
    };
    reclaimEligible: boolean;
    notes: string[];
  }> {
    if (input.confirmation !== input.workspaceId) {
      throw new Error(
        "WORKSPACE_SESSION_CONFIRMATION_REQUIRED: confirmWorkspaceId must exactly equal workspaceId.",
      );
    }
    const othersHolding =
      input.othersHolding ?? (() => this.liveLeases(input.workspaceId));
    // The lock serialises the read-check-write sequence, so two concurrent
    // closes cannot both observe "open" and both report a fresh transition.
    return this.withLifecycleLock(input.workspaceId, () =>
      this.closeWorkspaceSessionLocked(input, othersHolding),
    );
  }

  private async closeWorkspaceSessionLocked(
    input: {
      workspaceId: string;
      confirmation: string;
      expectedHeadSha?: string;
      reason?: string;
    },
    othersHolding: () => number,
  ): Promise<{
    workspaceId: string;
    root: string;
    lifecycleState: WorkspaceLifecycleState;
    previousState: WorkspaceLifecycleState;
    alreadyClosed: boolean;
    headSha: string | null;
    released: {
      liveLeases: number;
      activeJobIds: string[];
      activeGameSessionIds: string[];
      activeTaskSessionIds: string[];
    };
    reclaimEligible: boolean;
    notes: string[];
  }> {
    {
      const session = this.store?.getSession(input.workspaceId);
      if (!session) {
        throw new Error(
          `WORKSPACE_SESSION_UNKNOWN: No persisted workspace record for ${input.workspaceId}. Re-run list_workspaces(audit=true).`,
        );
      }
      const rootStats = await stat(session.root).catch(() => undefined);
      const directoryExists = Boolean(rootStats?.isDirectory());
      if (!directoryExists) {
        // Fail closed: an identity we cannot confirm is never closed by force.
        throw new Error(
          `WORKSPACE_SESSION_UNVERIFIABLE: The workspace directory no longer exists (${session.root}), so DevSpace cannot confirm the identity of this session. Nothing was changed; reconcile with list_workspaces(audit=true) and reclaim_workspace instead.`,
        );
      }

      const notes: string[] = [];
      let headSha: string | null = null;
      try {
        headSha = (await inspectGitStatus(session.root)).headSha;
      } catch (error) {
        throw new Error(
          `WORKSPACE_SESSION_UNVERIFIABLE: Git state could not be read for ${session.root}: ${
            error instanceof Error ? error.message : String(error)
          }. Possession of this workspace cannot be confirmed, so it was left open.`,
        );
      }
      if (
        input.expectedHeadSha !== undefined &&
        headSha !== input.expectedHeadSha
      ) {
        throw new Error(
          `WORKSPACE_SESSION_HEAD_MISMATCH: Expected HEAD ${input.expectedHeadSha}, found ${headSha}. Re-inspect before closing.`,
        );
      }

      const baseActivity = await this.sessionActivityWithProcesses(session);
      const activity = {
        ...baseActivity,
        liveLeases: othersHolding(),
      };
      const blockers: string[] = [];
      if (activity.liveLeases > 0) {
        blockers.push(
          `${activity.liveLeases} in-flight DevSpace operation(s) hold this workspace`,
        );
      }
      if (activity.activeJobIds.length > 0) {
        blockers.push(`running job(s): ${activity.activeJobIds.join(", ")}`);
      }
      if (activity.activeGameSessionIds.length > 0) {
        blockers.push(
          `live game session(s): ${activity.activeGameSessionIds.join(", ")}`,
        );
      }
      if (activity.activeTaskSessionIds.length > 0) {
        blockers.push(
          `running task session(s): ${activity.activeTaskSessionIds.join(", ")}`,
        );
      }
      const foreign = activity.foreignProcesses;
      if (foreign && foreign.pids.length > 0) {
        blockers.push(
          `process(es) started outside DevSpace with this directory as their working directory: pid ${foreign.pids.join(", ")} (${
            foreign.commands.join(", ") || "unknown command"
          })`,
        );
      } else if (foreign?.unknown) {
        blockers.push(
          `external process occupancy could not be determined: ${
            foreign.reason ?? "the process probe did not run"
          }`,
        );
      }
      if (blockers.length > 0) {
        throw new Error(
          `WORKSPACE_SESSION_BUSY: Refusing to close ${session.id}. ${blockers.join("; ")}. Nothing was changed; stop or wait for the work first.`,
        );
      }

      // Only now, with nothing live, does the persisted state decide.
      //
      // `active` is the state a brand new session carries until a listing
      // reconciles it, and it is also the state a crashed request leaves
      // behind. Neither proves anybody is using the workspace, so it is
      // reported as a conflict and the caller must re-audit — which is exactly
      // the fail-closed behaviour a lifecycle transition needs.
      if (session.lifecycleState === "active") {
        throw new Error(
          `WORKSPACE_SESSION_STATE_CONFLICT: Workspace session state is "active". Either an operation is in flight or a previous one did not finish cleanly. Re-run list_workspaces(audit=true) to reconcile the state, then retry. Nothing was changed.`,
        );
      }
      if (
        session.lifecycleState !== "idle" &&
        session.lifecycleState !== "closed"
      ) {
        throw new Error(
          `WORKSPACE_SESSION_STATE_UNVERIFIABLE: Workspace session state is "${session.lifecycleState}", which does not prove the workspace is free. Re-run list_workspaces(audit=true) to reconcile, then retry. Nothing was changed.`,
        );
      }

      if (session.lifecycleState === "closed") {
        return {
          workspaceId: session.id,
          root: session.root,
          lifecycleState: "closed" as WorkspaceLifecycleState,
          previousState: session.lifecycleState,
          alreadyClosed: true,
          headSha,
          released: {
            liveLeases: 0,
            activeJobIds: [],
            activeGameSessionIds: [],
            activeTaskSessionIds: [],
          },
          reclaimEligible: await this.isReclaimEligible(session),
          notes: ["The session was already closed; no state was written."],
        };
      }

      const previousState = session.lifecycleState;
      this.transition(session.id, "closing", {
        closedReason: input.reason,
      });
      this.transition(session.id, "closed", {
        closedReason: input.reason,
      });
      const cacheEntry = this.workspaces.get(session.id);
      if (cacheEntry && cacheEntry.leases === 0) {
        this.workspaces.delete(session.id);
      } else if (cacheEntry) {
        notes.push(
          "The cached workspace object stays in memory until its last in-flight request finishes; the persisted state is closed.",
        );
      }

      return {
        workspaceId: session.id,
        root: session.root,
        lifecycleState: "closed" as WorkspaceLifecycleState,
        previousState,
        alreadyClosed: false,
        headSha,
        released: {
          liveLeases: activity.liveLeases,
          activeJobIds: activity.activeJobIds,
          activeGameSessionIds: activity.activeGameSessionIds,
          activeTaskSessionIds: activity.activeTaskSessionIds,
        },
        reclaimEligible: await this.isReclaimEligible({
          ...session,
          lifecycleState: "closed",
        }),
        notes,
      };
    }
  }

  /**
   * Whether `reclaim_workspace` would accept this record right now. Read-only:
   * it runs the same audit but never removes anything.
   */
  private async isReclaimEligible(session: {
    id: string;
    root: string;
    mode: WorkspaceMode;
    managed: boolean;
    createdAt: string;
    lastUsedAt: string;
    lifecycleState: WorkspaceLifecycleState;
    sourceRoot?: string;
  }): Promise<boolean> {
    if (session.mode !== "worktree" || !session.managed) return false;
    if (
      !isPathInsideRoot(realpathOf(session.root), realpathOf(this.config.worktreeRoot))
    ) {
      return false;
    }
    const registered = await listRegisteredWorktrees(
      session.sourceRoot ?? this.config.worktreeRoot,
    );
    const probed = await this.sessionActivityWithProcesses(session);
    const audit = await auditWorkspace({
      workspaceId: session.id,
      root: session.root,
      mode: session.mode,
      managed: session.managed,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      activity: {
        ...probed,
        sessionState: session.lifecycleState,
        liveLeases: 0,
      },
      registeredWorktrees: registered ?? undefined,
      protectedWorktreePatterns:
        this.config.worktreeCleanup?.protectedWorktreePatterns,
    });
    return audit.reclaimable;
  }

  /**
   * Unified, strictly read-only cleanup plan.
   *
   * Every workspace gets exactly one verdict plus the local branch's delete
   * eligibility. Nothing in this method deletes anything, and no verdict is
   * ever acted on automatically.
   */
  async cleanupPlan(input: {
    limit?: number;
    includeOrphans?: boolean;
    orphanLimit?: number;
  } = {}): Promise<{
    auditedAt: string;
    entries: WorkspaceCleanupPlanEntry[];
    orphans: {
      worktreeRoot: string;
      directoryCount: number;
      orphanedCount: number;
      truncated: boolean;
      entries: WorkspaceCleanupPlanEntry[];
    };
    summary: Record<WorkspaceCleanupVerdict | "TOTAL", number>;
    readOnly: true;
  }> {
    const limit = input.limit ?? 50;
    const summaries = await this.listWorkspaces(limit);
    const registered = await listRegisteredWorktrees(this.config.worktreeRoot);
    const entries: WorkspaceCleanupPlanEntry[] = [];
    for (const summary of summaries) {
      const stored = this.store?.getSession(summary.workspaceId);
      const lifecycleState =
        stored?.lifecycleState ?? normalizeWorkspaceLifecycleState(undefined);
      const activity: WorkspaceSessionActivity =
        await this.sessionActivityWithProcesses(
          stored ?? {
            id: summary.workspaceId,
            root: summary.root,
            lifecycleState,
          },
        );
      const audit = await auditWorkspace({
        workspaceId: summary.workspaceId,
        root: summary.root,
        mode: summary.mode,
        managed: summary.managed,
        createdAt: summary.createdAt,
        lastUsedAt: summary.lastUsedAt,
        activity,
        registeredWorktrees: registered ?? undefined,
        protectedWorktreePatterns:
          this.config.worktreeCleanup?.protectedWorktreePatterns,
      });
      entries.push(
        await this.toPlanEntry(audit, {
          workspaceId: summary.workspaceId,
          lifecycleState,
          managed: summary.managed,
          registeredWorktrees: registered,
          activity,
        }),
      );
    }

    const orphanResult = await this.orphanedWorktreeAudit({
      limit: input.orphanLimit ?? 50,
      registeredWorktrees: registered,
    });
    const orphanEntries = input.includeOrphans
      ? await Promise.all(
          orphanResult.audits.map((audit) =>
            this.toPlanEntry(audit, {
              workspaceId: null,
              lifecycleState: null,
              managed: false,
              registeredWorktrees: registered,
              activity: {
                sessionState: null,
                liveLeases: 0,
                activeJobIds: audit.activeJobIds,
                activeGameSessionIds: audit.activeGameSessionIds,
                activeTaskSessionIds: audit.activeTaskSessionIds,
              },
            }),
          ),
        )
      : [];

    const summary: Record<WorkspaceCleanupVerdict | "TOTAL", number> = {
      SAFE_CANDIDATE: 0,
      BLOCKED_ACTIVE: 0,
      BLOCKED_DIRTY: 0,
      BLOCKED_UNMERGED: 0,
      BLOCKED_PROTECTED: 0,
      BLOCKED_NOT_MANAGED: 0,
      BLOCKED_MISSING: 0,
      UNKNOWN: 0,
      TOTAL: entries.length,
    };
    for (const entry of entries) summary[entry.verdict] += 1;

    return {
      auditedAt: this.now(),
      entries,
      orphans: {
        worktreeRoot: orphanResult.scan.worktreeRoot,
        directoryCount: orphanResult.scan.directories.length,
        orphanedCount: orphanResult.scan.orphaned.length,
        truncated:
          orphanResult.truncated ||
          (input.includeOrphans === true &&
            orphanEntries.length < orphanResult.scan.orphaned.length),
        entries: orphanEntries,
      },
      summary,
      readOnly: true,
    };
  }

  private async toPlanEntry(
    audit: WorkspaceAudit,
    context: {
      workspaceId: string | null;
      lifecycleState: WorkspaceLifecycleState | null;
      managed: boolean;
      registeredWorktrees: Set<string> | null;
      activity: WorkspaceSessionActivity;
    },
  ): Promise<WorkspaceCleanupPlanEntry> {
    const branchEligibility =
      audit.branch && !audit.detached
        ? await this.branchEligibilityForAudit(audit, context)
        : undefined;
    return {
      workspaceId: context.workspaceId,
      root: audit.root,
      mode: audit.mode,
      managed: context.managed,
      branch: audit.branch,
      detached: audit.detached,
      headSha: audit.headSha,
      clean: audit.dirtyFileCount === 0 && audit.untrackedFileCount === 0,
      dirtyFileCount: audit.dirtyFileCount,
      untrackedFileCount: audit.untrackedFileCount,
      unmergedCommitCount: audit.unmergedCommitCount,
      hasRunningTask:
        audit.activeTaskSessionIds.length > 0 ||
        audit.activeGameSessionIds.length > 0,
      activeJobIds: audit.activeJobIds,
      activeGameSessionIds: audit.activeGameSessionIds,
      activeTaskSessionIds: audit.activeTaskSessionIds,
      sessionState: context.lifecycleState,
      sessionIsLive: audit.hasActiveSession,
      liveLeases: audit.liveLeases,
      staleRecord: audit.staleRecord,
      isManagedWorktree: context.managed && audit.mode === "worktree",
      verdict: audit.verdict,
      reclaimable: audit.reclaimable,
      blockedReasons: audit.blockedReasons,
      risks: audit.risks,
      branchDelete: branchEligibility,
    };
  }

  /**
   * Branch delete eligibility for the plan.
   *
   * Read-only, and never throws: an unreadable repository becomes an `UNKNOWN`
   * branch verdict rather than failing the whole plan, because one broken
   * worktree must not hide the state of the other thirty.
   */
  private async branchEligibilityForAudit(
    audit: WorkspaceAudit,
    context: {
      workspaceId: string | null;
      activity: WorkspaceSessionActivity;
    },
  ): Promise<WorkspaceCleanupPlanEntry["branchDelete"]> {
    if (!audit.branch) return undefined;
    const activeDependents =
      context.workspaceId && hasLiveActivity(context.activity)
        ? [context.workspaceId]
        : [];    try {
      const eligibility = await branchDeleteEligibility({
        // The worktree root is itself a Git repository root, so a branch's
        // merge proof is computed against the same object database.
        workspaceRoot: audit.root,
        branchName: audit.branch,
        policy: this.branchCleanupPolicy(),
        activeDependents,
      });
      return {
        branch: eligibility.branch,
        sha: eligibility.sha,
        verdict: eligibility.verdict,
        reasons: eligibility.reasons,
        checkedOutAt: eligibility.checkedOutAt,
        mainlineRef: eligibility.mainlineRef,
        mainlineSha: eligibility.mainlineSha,
        hasUpstream: eligibility.hasUpstream,
      };
    } catch (error) {
      return {
        branch: audit.branch,
        sha: audit.headSha,
        verdict: "UNKNOWN",
        reasons: [
          `branch eligibility could not be determined: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        checkedOutAt: [],
        mainlineRef: null,
        mainlineSha: null,
        hasUpstream: false,
      };
    }
  }

  /** Cleanup policy, in the shape the branch tool understands. */
  branchCleanupPolicy(): BranchCleanupPolicy {
    const policy = this.config.worktreeCleanup;
    return {
      protectedBranches: policy?.protectedBranches ?? [],
      protectedBranchPatterns: policy?.protectedBranchPatterns ?? [],
      mainlineRefs: policy?.mainlineRefs,
    };
  }

  /**
   * Workspaces with live work (in-flight call, job, task or game session)
   * inside the same Git repository as `repositoryRoot`.
   *
   * Repository identity is the shared Git common directory, so a worktree and
   * its parent checkout are recognised as the same repository. A branch is
   * refused while any of these exist, because the branch could back work that
   * Git cannot see.
   */
  async branchActiveDependents(
    repositoryRoot: string,
    options: { excludeWorkspaceId?: string } = {},
  ): Promise<string[]> {
    const targetCommonDir = await gitCommonDir(repositoryRoot);
    if (!targetCommonDir) return [];
    const dependents: string[] = [];
    const sessions = this.store?.listSessions(Math.max(1, 500)) ?? [];
    for (const session of sessions) {
      // The caller's own in-flight request must not count as a conflicting
      // dependency, or the branch tool could never run at all.
      if (session.id === options.excludeWorkspaceId) continue;
      const activity = await this.sessionActivityWithProcesses(session);
      if (!hasAnyOccupancy(activity)) continue;
      const sessionCommonDir = await gitCommonDir(session.root);
      if (sessionCommonDir && sessionCommonDir === targetCommonDir) {
        dependents.push(session.id);
      }
    }
    return [...new Set(dependents)];
  }

  /**
   * Promote a released or unverified record back to an open one.
   *
   * `closed` means the operator released it; `unknown` means DevSpace cannot
   * prove who holds it (the state the lifecycle migration leaves on every
   * pre-existing row). Both are promoted only by an explicit reopen —
   * `resume_workspace`, or `open_workspace` on a directory with no open record.
   * An audit, a listing or a diagnostic read never does this, because that
   * would silently undo the release the operator asked for.
   */
  private reopenClosedSession(workspaceId: string): void {
    const session = this.store?.getSession(workspaceId);
    if (
      session?.lifecycleState === "closed" ||
      session?.lifecycleState === "unknown"
    ) {
      this.transition(workspaceId, "active");
    }
  }

  /**
   * Whether a path is inside the configured managed worktree root.
   *
   * Both the canonical and the recorded spelling are accepted. A directory that
   * has already been deleted cannot be canonicalised, so `realpath` silently
   * falls back to the logical path; requiring the canonical form alone would
   * make a stale record look like a path-escape attempt.
   */
  private isInsideWorktreeRoot(path: string): boolean {
    const canonicalRoot = realpathOf(this.config.worktreeRoot);
    const logicalRoot = resolve(this.config.worktreeRoot);
    for (const spelling of [path, resolve(path)]) {
      const canonical = realpathOf(spelling);
      if (
        isPathInsideRoot(canonical, canonicalRoot) ||
        isPathInsideRoot(canonical, logicalRoot)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a workspaceId to a usable workspace.
   *
   * A cache hit does NOT make the session active: activity requires an explicit
   * lease (see `withLease`). Reading a workspace so a tool can call Git on it
   * must not, by itself, keep the session marked as in use forever — that was
   * the bug that made every previously-touched worktree look like it had a live
   * session.
   *
   * Reopening a closed session is supported on purpose: the record survives, so
   * history and metadata are not lost, and the state is promoted back to
   * `active` only because a real caller is now using it.
   */
  getWorkspace(workspaceId: string): Workspace {
    const cached = this.workspaces.get(workspaceId);
    if (cached) {
      this.store?.touchSession(workspaceId);
      return cached.workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(
        `Unknown workspaceId: ${workspaceId}. Call open_workspace first.`,
      );
    }

    const root = this.assertWorkspaceRootAllowed(
      session.root,
      session.mode,
      session.sourceRoot,
    );
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      additionalRoots: [],
      additionalRootsAuthorization: emptyAdditionalRootsAuthorization(),
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: session.detached,
              managed: session.managed,
              branch: session.branch,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(),
      projectMemory: this.projectMemory?.getActiveState(session.id),
    };
    this.store?.touchSession(workspaceId);
    // Deliberately NOT promoted here. A closed session is reopened only by
    // `resume_workspace`, or by `open_workspace` on a directory with no open
    // record. Merely resolving a workspaceId so a tool can inspect it must
    // never undo the release the operator asked for.
    this.workspaces.set(restoredWorkspace.id, {
      workspace: restoredWorkspace,
      leases: 0,
    });

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    return this.resolveWorkspacePath(workspace, inputPath, "read").absolutePath;
  }

  resolveWritePath(
    workspace: Workspace,
    inputPath: string,
  ): WorkspaceResolvedPath {
    return this.resolveWorkspacePath(workspace, inputPath, "write");
  }

  resolveWorkspacePath(
    workspace: Workspace,
    inputPath: string,
    requiredAccess: "read" | "write",
  ): WorkspaceResolvedPath {
    const expanded = expandHomePath(inputPath);
    const primaryRoot = canonicalizePathWithExistingAncestor(
      resolve(workspace.root),
    );
    const roots = [
      {
        path: primaryRoot,
        access: (this.config.readOnly ? "read_only" : "read_write") as
          "read_only" | "read_write",
        rootKind: "workspace" as const,
      },
      ...workspace.additionalRoots.map((root) => ({
        path: canonicalRootPath(root.path),
        access:
          root.access === "read_only"
            ? ("read_only" as const)
            : ("read_write" as const),
        rootKind: "additional" as const,
      })),
    ];
    const unresolvedInput = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(primaryRoot, expanded);
    const absoluteInput = canonicalizePathWithExistingAncestor(unresolvedInput);
    const owningRoot = roots
      .filter((root) => isPathInsideRoot(absoluteInput, root.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!owningRoot) {
      throw new AccessDeniedError(
        `Path is outside allowed roots: ${inputPath}`,
      );
    }
    if (requiredAccess === "write" && owningRoot.access !== "read_write") {
      throw new AccessDeniedError(
        `Write denied: path is in a read-only additional root: ${inputPath}`,
      );
    }
    const rootRelative = relative(owningRoot.path, absoluteInput)
      .split("\\")
      .join("/");
    const resolved =
      rootRelative === ""
        ? {
            relativePath: ".",
            absolutePath: owningRoot.path,
            canonicalWorkspaceRoot: owningRoot.path,
          }
        : resolveWorkspacePath(owningRoot.path, rootRelative);
    return {
      ...resolved,
      rootPath: owningRoot.path,
      rootKind: owningRoot.rootKind,
      access: owningRoot.access,
    };
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    const allRoots = [
      workspace.root,
      ...workspace.additionalRoots.map((r) => r.path),
    ];
    const skillRead = resolveSkillReadPath(
      workspace.skills,
      workspace.activatedSkillDirs,
      inputPath,
    );
    if (skillRead) {
      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        rootPath: skillRead.skill.baseDir,
        rootKind: "additional",
        access: "read_only",
        relativePath: relative(skillRead.skill.baseDir, skillRead.absolutePath)
          .split("\\")
          .join("/"),
        skillRead,
      };
    }

    try {
      const resolved = this.resolveWorkspacePath(workspace, inputPath, "read");
      return {
        ...resolved,
        readRoots: allRoots,
      };
    } catch (workspaceError) {
      throw workspaceError;
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(
        workspace.activatedSkillDirs,
        readPath.skillRead.skill,
      );
    }
  }

  resolveWorkingDirectory(
    workspace: Workspace,
    workingDirectory: string | undefined,
  ): string {
    const directory = workingDirectory
      ? this.resolvePath(workspace, workingDirectory)
      : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  async preflightProjectMemory(
    workspaceId: string,
    task: string,
  ): Promise<ProjectMemoryPreflightView> {
    const workspace = this.getWorkspace(workspaceId);
    if (!this.projectMemory) {
      return {
        status: "unconfigured",
        wouldDeny: false,
        denialReasons: [],
      };
    }
    const result = await this.projectMemory.preflight({
      workspaceId,
      root: workspace.root,
      task,
    });
    workspace.projectMemory = this.projectMemory.getActiveState(workspaceId);
    return result;
  }

  observeProjectMemoryAccess(
    workspaceId: string,
    toolName: string,
    receiptId: string | undefined,
  ): ProjectMemoryAccessObservation {
    this.getWorkspace(workspaceId);
    return this.projectMemory
      ? this.projectMemory.observeAccess(workspaceId, toolName, receiptId)
      : {
          mode: "SHADOW",
          outcome: "preflight_missing",
          wouldDeny: false,
        };
  }

  /**
   * Reuse an existing checkout record for the same directory.
   *
   * A session that was deliberately closed is NOT silently resurrected here:
   * only records that are still open (or whose state is unknown) are reused.
   * Closing a workspace must actually release it, or the close would be
   * meaningless for a directory that a later tool call happens to touch.
   */
  private findExistingCheckoutSession(root: string): { id: string } | undefined {
    for (const { workspace } of this.workspaces.values()) {
      if (workspace.mode === "checkout" && workspace.root === root) {
        return { id: workspace.id };
      }
    }
    const stored = this.store?.listSessions();
    if (stored) {
      for (const session of stored) {
        if (
          session.mode === "checkout" &&
          session.root === root &&
          session.lifecycleState !== "closed"
        ) {
          return { id: session.id };
        }
      }
    }
    return undefined;
  }

  private async openCheckoutWorkspace(
    path: string,
    task: string | undefined,
    additionalRootsAuthorization: AdditionalRootsAuthorization,
  ): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    await mkdir(root, { recursive: true });

    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    const existingSession = this.findExistingCheckoutSession(root);
    if (existingSession) {
      const existingWorkspace = this.getWorkspace(existingSession.id);
      if (additionalRootsAuthorization.effectiveAdditionalRoots.length > 0) {
        existingWorkspace.additionalRoots =
          additionalRootsAuthorization.effectiveAdditionalRoots;
        existingWorkspace.additionalRootsAuthorization =
          additionalRootsAuthorization;
      }
      const agentsFiles = this.loadInitialAgentsFiles(existingWorkspace.root);
      const availableAgentsFiles = await this.findAvailableAgentsFiles(
        existingWorkspace.root,
        agentsFiles,
      );
      const projectMemory = task
        ? await this.preflightProjectMemory(existingWorkspace.id, task)
        : undefined;

      return {
        workspace: existingWorkspace,
        agentsFiles,
        availableAgentsFiles,
        projectMemory,
        additionalRootsAuthorization:
          existingWorkspace.additionalRootsAuthorization,
        reused: true,
      };
    }

    return this.createWorkspaceContext({
      root,
      mode: "checkout",
      task,
      additionalRootsAuthorization,
    });
  }

  private async openWorktreeWorkspace(
    path: string,
    baseRef: string | undefined,
    task: string | undefined,
    additionalRootsAuthorization: AdditionalRootsAuthorization,
  ): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
      task,
      additionalRootsAuthorization,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
    task?: string;
    additionalRootsAuthorization: AdditionalRootsAuthorization;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      // Copy only the declared worktree fields. The factory returns a richer
      // object (it also carries `sourceRoot`), and leaking undeclared keys into
      // tool output breaks strict MCP output-schema validation on the client.
      worktree: input.worktree ? worktreeAttachment(input.worktree) : undefined,
      additionalRoots:
        input.additionalRootsAuthorization.effectiveAdditionalRoots,
      additionalRootsAuthorization: input.additionalRootsAuthorization,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
      detached: workspace.worktree?.detached,
      branch: workspace.worktree?.branch,
    });
    this.workspaces.set(workspace.id, { workspace, leases: 0 });
    const agentsFiles = this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(
      workspace.root,
      agentsFiles,
    );
    const projectMemory = input.task
      ? await this.preflightProjectMemory(workspace.id, input.task)
      : undefined;

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      projectMemory,
      additionalRootsAuthorization: workspace.additionalRootsAuthorization,
    };
  }

  private async resolveAdditionalRootsAuthorization(
    requestedRoots: AdditionalRoot[],
    currentEffectiveRoots: EffectiveAdditionalRoot[],
  ): Promise<AdditionalRootsAuthorization> {
    const requestedAdditionalRoots = requestedRoots.map((root) => ({
      path: resolve(expandHomePath(root.path)),
      access: root.access ?? "inherit",
    }));
    const resolved = await Promise.all(
      requestedAdditionalRoots.map(async (root) => {
        let canonicalPath: string;
        try {
          canonicalPath = await realpath(root.path);
        } catch {
          return {
            root,
            rejection: {
              ...root,
              code: "ADDITIONAL_ROOT_NOT_FOUND" as const,
              message: `Additional root does not exist or is inaccessible: ${root.path}`,
            },
          };
        }
        const rootStats = await stat(canonicalPath).catch(() => undefined);
        if (!rootStats?.isDirectory()) {
          return {
            root,
            rejection: {
              ...root,
              code: "ADDITIONAL_ROOT_NOT_DIRECTORY" as const,
              message: `Additional root must be a directory: ${root.path}`,
            },
          };
        }
        return {
          root,
          effective: {
            path: canonicalPath,
            access: effectiveAdditionalRootAccess(
              root.access,
              !this.config.readOnly,
            ),
          },
        };
      }),
    );

    const rejectedAdditionalRoots: AdditionalRootRejection[] = resolved.flatMap(
      (result) => (result.rejection ? [result.rejection] : []),
    );
    const candidates = resolved.flatMap((result) =>
      result.effective ? [result.effective] : [],
    );
    const accessByPath = new Map<string, EffectiveAdditionalRoot["access"]>();
    for (const candidate of candidates) {
      const previousAccess = accessByPath.get(candidate.path);
      if (previousAccess && previousAccess !== candidate.access) {
        for (const requested of resolved.flatMap((result) =>
          result.effective?.path === candidate.path ? [result.root] : [],
        )) {
          rejectedAdditionalRoots.push({
            ...requested,
            code: "ADDITIONAL_ROOT_ACCESS_CONFLICT",
            message: `Additional root was requested with conflicting access modes: ${requested.path}`,
          });
        }
        continue;
      }
      accessByPath.set(candidate.path, candidate.access);
    }

    if (rejectedAdditionalRoots.length > 0) {
      return {
        requestedAdditionalRoots,
        effectiveAdditionalRoots: currentEffectiveRoots.map((root) => ({
          ...root,
        })),
        rejectedAdditionalRoots: dedupeAdditionalRootRejections(
          rejectedAdditionalRoots,
        ),
        additionalRootsScope: "in_memory_session",
        additionalRootsPersisted: false,
      };
    }

    return {
      requestedAdditionalRoots,
      effectiveAdditionalRoots: Array.from(accessByPath, ([path, access]) => ({
        path,
        access,
      })),
      rejectedAdditionalRoots: [],
      additionalRootsScope: "in_memory_session",
      additionalRootsPersisted: false,
    };
  }

  private loadSkillsForWorkspace(
    root: string,
  ): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(
    root: string,
    mode: WorkspaceMode,
    sourceRoot: string | undefined,
  ): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(
          `Stored worktree workspace is missing sourceRoot: ${root}`,
        );
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private loadInitialAgentsFiles(root: string): LoadedAgentsFile[] {
    const agentDir = resolve(this.config.agentDir);

    return loadProjectContextFiles({ cwd: root, agentDir })
      .filter((file) => {
        const path = resolve(file.path);
        if (isPathInsideRoot(path, agentDir)) return true;
        return isPathInsideRoot(path, root) && dirname(path) === root;
      })
      .map((file) => ({
        path: resolve(file.path),
        content: file.content,
      }));
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }

  // -----------------------------------------------------------------------
  // Task manifest approval
  // -----------------------------------------------------------------------

  approveTaskManifest(
    workspaceId: string,
    taskIds: string[],
  ): ApprovedTasks | null {
    const workspace = this.getWorkspace(workspaceId);
    const manifest = loadTaskManifest(workspace.root);
    if (!manifest) return null;

    // Validate that all requested taskIds exist in the manifest
    for (const id of taskIds) {
      if (!manifest.tasks[id]) return null;
    }

    const sha = computeManifestSha256(workspace.root);
    if (!sha) return null;

    const approved: ApprovedTasks = {
      manifestSha256: sha,
      taskIds,
    };
    workspace.approvedTasks = approved;
    return approved;
  }

  getApprovedTasks(workspaceId: string): ApprovedTasks | undefined {
    return this.getWorkspace(workspaceId).approvedTasks;
  }
}


function canonicalizePathWithExistingAncestor(path: string): string {
  let existing = path;
  const missingParts: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missingParts.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...missingParts);
}

function dedupeAdditionalRootRejections(
  rejections: AdditionalRootRejection[],
): AdditionalRootRejection[] {
  const seen = new Set<string>();
  return rejections.filter((rejection) => {
    const key = `${rejection.path}\0${rejection.access}\0${rejection.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CONTEXT_FILE_NAMES = new Set([
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(
  path: string,
  workspaceRoot: string | undefined,
): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

async function walkWorkspace(
  directory: string,
  visit: (
    path: string,
    entry: { name: string; isFile(): boolean; isDirectory(): boolean },
  ) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}
