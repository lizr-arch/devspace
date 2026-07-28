import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { inspectGitStatus } from "./git-tools.js";
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

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
  branch?: string;
}

export interface AdditionalRootRejection extends AdditionalRoot {
  code:
    | "ADDITIONAL_ROOT_NOT_FOUND"
    | "ADDITIONAL_ROOT_NOT_DIRECTORY"
    | "ADDITIONAL_ROOT_ACCESS_CONFLICT";
  message: string;
}

export interface AdditionalRootsAuthorization {
  requestedAdditionalRoots: AdditionalRoot[];
  effectiveAdditionalRoots: EffectiveAdditionalRoot[];
  rejectedAdditionalRoots: AdditionalRootRejection[];
  additionalRootsScope: "in_memory_session";
  additionalRootsPersisted: false;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  additionalRoots: EffectiveAdditionalRoot[];
  additionalRootsAuthorization: AdditionalRootsAuthorization;
  approvedTasks?: ApprovedTasks;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
  projectMemory?: ProjectMemoryActiveState;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  projectMemory?: ProjectMemoryPreflightView;
  additionalRootsAuthorization: AdditionalRootsAuthorization;
}

export interface WorkspaceSessionSummary {
  workspaceId: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  additionalRoots: EffectiveAdditionalRoot[];
  requestedAdditionalRoots: AdditionalRoot[];
  effectiveAdditionalRoots: EffectiveAdditionalRoot[];
  rejectedAdditionalRoots: AdditionalRootRejection[];
  additionalRootsScope: "in_memory_session";
  additionalRootsPersisted: false;
  managed: boolean;
  detached?: boolean;
  branch?: string;
  status: string;
  createdAt: string;
  lastUsedAt: string;
  resumable: boolean;
  unavailableReason?: string;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  rootPath: string;
  rootKind: "workspace" | "additional";
  access: "read_only" | "read_write";
  relativePath: string;
  skillRead?: SkillReadResolution;
}

export type WorkspaceResolvedPath = ResolvedWorkspacePath & {
  rootPath: string;
  rootKind: "workspace" | "additional";
  access: "read_only" | "read_write";
};

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  task?: string;
  additionalRoots?: AdditionalRoot[];
}

export async function refreshWorkspaceGitAttachment(
  workspace: Workspace,
): Promise<void> {
  if (workspace.mode !== "worktree" || !workspace.worktree) return;
  const gitStatus = await inspectGitStatus(workspace.root);
  workspace.worktree.detached = !gitStatus.branch;
  workspace.worktree.branch = gitStatus.branch;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
    private readonly projectMemory?: ProjectMemoryController,
  ) {}

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
        .map((workspace) => ({
          id: workspace.id,
          root: workspace.root,
          status: "active",
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
      const activeWorkspace = this.workspaces.get(session.id);
      const additionalRootsAuthorization =
        activeWorkspace?.additionalRootsAuthorization ??
        emptyAdditionalRootsAuthorization();
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

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
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
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

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
        path: root.path,
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
      worktree: input.worktree,
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
    this.workspaces.set(workspace.id, workspace);
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

function emptyAdditionalRootsAuthorization(): AdditionalRootsAuthorization {
  return {
    requestedAdditionalRoots: [],
    effectiveAdditionalRoots: [],
    rejectedAdditionalRoots: [],
    additionalRootsScope: "in_memory_session",
    additionalRootsPersisted: false,
  };
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
