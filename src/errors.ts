export type DevSpaceErrorLayer =
  | "transport"
  | "tool"
  | "process"
  | "project"
  | "security";

export interface DevSpaceErrorPayload {
  code: string;
  layer: DevSpaceErrorLayer;
  message: string;
  retryable: boolean;
  safeToRetry: boolean;
  recoveryHint: string;
  nextRecommendedTools?: string[];
  details?: Record<string, unknown>;
}

export class DevSpaceError extends Error {
  readonly code: string;
  readonly layer: DevSpaceErrorLayer;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly recoveryHint: string;
  readonly nextRecommendedTools: string[];
  readonly details?: Record<string, unknown>;

  constructor(payload: DevSpaceErrorPayload) {
    super(payload.message);
    this.name = "DevSpaceError";
    this.code = payload.code;
    this.layer = payload.layer;
    this.retryable = payload.retryable;
    this.safeToRetry = payload.safeToRetry;
    this.recoveryHint = payload.recoveryHint;
    this.nextRecommendedTools = payload.nextRecommendedTools ?? [];
    this.details = payload.details;
    Object.setPrototypeOf(this, DevSpaceError.prototype);
  }

  toJSON(): DevSpaceErrorPayload {
    return {
      code: this.code,
      layer: this.layer,
      message: this.message,
      retryable: this.retryable,
      safeToRetry: this.safeToRetry,
      recoveryHint: this.recoveryHint,
      nextRecommendedTools: this.nextRecommendedTools,
      details: this.details,
    };
  }
}

export function isDevSpaceError(error: unknown): error is DevSpaceError {
  return error instanceof DevSpaceError;
}

export function formatErrorRemedy(error: unknown): {
  message: string;
  errorPayload: DevSpaceErrorPayload;
} {
  if (isDevSpaceError(error)) {
    const p = error.toJSON();
    const toolsHint =
      p.nextRecommendedTools && p.nextRecommendedTools.length > 0
        ? ` Next recommended tools: [${p.nextRecommendedTools.join(", ")}].`
        : "";
    const formattedMessage = `[${p.code}] ${p.message}\nRecovery Hint: ${p.recoveryHint}${toolsHint}`;
    return { message: formattedMessage, errorPayload: p };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const derived = inferErrorPayload(rawMessage);
  const toolsHint =
    derived.nextRecommendedTools && derived.nextRecommendedTools.length > 0
      ? ` Next recommended tools: [${derived.nextRecommendedTools.join(", ")}].`
      : "";
  const formattedMessage = `[${derived.code}] ${derived.message}\nRecovery Hint: ${derived.recoveryHint}${toolsHint}`;
  return { message: formattedMessage, errorPayload: derived };
}

function inferErrorPayload(rawMessage: string): DevSpaceErrorPayload {
  if (
    rawMessage.includes("WORKSPACE_NOT_FOUND") ||
    rawMessage.includes("Workspace not found") ||
    rawMessage.includes("Unknown workspace")
  ) {
    return {
      code: "WORKSPACE_NOT_FOUND",
      layer: "tool",
      message: rawMessage,
      retryable: false,
      safeToRetry: true,
      recoveryHint:
        "The workspace session may have expired or DevSpace restarted. Call list_workspaces to inspect active workspaces or open_workspace to open a local project folder.",
      nextRecommendedTools: ["list_workspaces", "open_workspace"],
    };
  }

  if (
    rawMessage.includes("TASK_NOT_APPROVED") ||
    rawMessage.includes("No manifest approved")
  ) {
    return {
      code: "TASK_NOT_APPROVED",
      layer: "project",
      message: rawMessage,
      retryable: false,
      safeToRetry: true,
      recoveryHint:
        "Task requires explicit approval. Call approve_task_manifest with the required task IDs first.",
      nextRecommendedTools: ["approve_task_manifest"],
    };
  }

  if (
    rawMessage.includes("TASK_MANIFEST_CHANGED") ||
    rawMessage.includes("Re-approve required")
  ) {
    return {
      code: "TASK_MANIFEST_CHANGED",
      layer: "project",
      message: rawMessage,
      retryable: false,
      safeToRetry: true,
      recoveryHint:
        "The task manifest changed since it was last approved. Re-inspect .devspace/tasks.yaml and call approve_task_manifest.",
      nextRecommendedTools: ["approve_task_manifest", "read_file", "read"],
    };
  }

  if (
    rawMessage.includes("PATH_EXISTS") ||
    rawMessage.includes("Destination exists")
  ) {
    return {
      code: "PATH_EXISTS",
      layer: "tool",
      message: rawMessage,
      retryable: false,
      safeToRetry: false,
      recoveryHint:
        "Destination already exists. Use edit_file for targeted modifications, or set overwrite=true if a complete rewrite is intended.",
      nextRecommendedTools: ["edit_file", "edit"],
    };
  }

  if (
    rawMessage.includes("PATH_NOT_FOUND") ||
    rawMessage.includes("ENOENT") ||
    rawMessage.includes("not found")
  ) {
    return {
      code: "PATH_NOT_FOUND",
      layer: "tool",
      message: rawMessage,
      retryable: false,
      safeToRetry: true,
      recoveryHint:
        "Target path was not found. Use find_files (glob) or list_directory (ls) to verify the file or directory location.",
      nextRecommendedTools: ["find_files", "list_directory", "glob", "ls"],
    };
  }

  if (
    rawMessage.includes("GIT_DIRTY") ||
    rawMessage.includes("unstaged") ||
    rawMessage.includes("staged")
  ) {
    return {
      code: "GIT_WORKSPACE_DIRTY",
      layer: "project",
      message: rawMessage,
      retryable: false,
      safeToRetry: true,
      recoveryHint:
        "Git workspace is in a dirty state. Call git_status and git_diff to review changes.",
      nextRecommendedTools: ["git_status", "git_diff"],
    };
  }

  return {
    code: "GENERIC_TOOL_ERROR",
    layer: "tool",
    message: rawMessage,
    retryable: false,
    safeToRetry: false,
    recoveryHint:
      "Review the error message details and parameters before retrying.",
  };
}
