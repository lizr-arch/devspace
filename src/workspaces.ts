import { randomUUID } from "node:crypto";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, opendir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import type {
  ProjectMemoryAccessObservation,
  ProjectMemoryActiveState,
  ProjectMemoryPreflightView,
} from "./project-memory.js";
import { ProjectMemoryController } from "./project-memory.js";
import {
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
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
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
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
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  task?: string;
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

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef, options.task);
    }

    return this.openCheckoutWorkspace(options.path, options.task);
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
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
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
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [
      workspace.root,
    ]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
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
  ): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    await mkdir(root, { recursive: true });

    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout", task });
  }

  private async openWorktreeWorkspace(
    path: string,
    baseRef: string | undefined,
    task: string | undefined,
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
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
    task?: string;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
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

    return { workspace, agentsFiles, availableAgentsFiles, projectMemory };
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
