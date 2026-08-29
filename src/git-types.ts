export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_GIT_PATHS = 100;
export const LOCAL_GIT_TIMEOUT_MS = 30_000;
export const REMOTE_GIT_TIMEOUT_MS = 60_000;
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface GitWorkspaceStatus {
  headSha: string;
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicts: string[];
  stagedDiffSha256: string;
}

export interface GitDiffResult {
  scope: "head" | "staged" | "unstaged";
  patch: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface GitFetchResult {
  remote: string;
  prune: boolean;
  headSha: string;
  branch?: string;
  refsBefore: Record<string, string>;
  refsAfter: Record<string, string>;
  updatedRefs: Array<{ ref: string; before: string; after: string }>;
  createdRefs: Array<{ ref: string; after: string }>;
  deletedRefs: Array<{ ref: string; before: string }>;
}

export interface GitMergeResult {
  branch: string;
  headBefore: string;
  sourceRef: string;
  sourceSha: string;
  mergeBase: string;
  mode: "ff_only" | "no_ff";
  fastForwardPossible: boolean;
  headAfter: string;
  createdMergeCommit: boolean;
  mergeCommitSha?: string;
  parents: string[];
  changedFiles: string[];
  statusAfter: GitWorkspaceStatus;
}

export interface GitPushResult {
  remote: string;
  destinationBranch: string;
  remoteShaBefore: string;
  localSha: string;
  pushAttempted: boolean;
  pushSucceeded: boolean;
  remoteShaAfter: string;
  remoteContainsLocal: boolean;
  statusAfter: GitWorkspaceStatus;
}
