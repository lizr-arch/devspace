import type { WorkspaceMode } from "./workspace-store.js";
import type { EffectiveAdditionalRoot, AdditionalRoot } from "./roots.js";
import type { ResolvedWorkspacePath } from "./workspace-paths.js";
import type { ApprovedTasks } from "./task-manifest.js";
import type { LoadedSkills, SkillReadResolution } from "./skills.js";
import type {
  ProjectMemoryActiveState,
  ProjectMemoryPreflightView,
} from "./project-memory.js";

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
  reused?: boolean;
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

export function emptyAdditionalRootsAuthorization(): AdditionalRootsAuthorization {
  return {
    requestedAdditionalRoots: [],
    effectiveAdditionalRoots: [],
    rejectedAdditionalRoots: [],
    additionalRootsScope: "in_memory_session",
    additionalRootsPersisted: false,
  };
}
