// ---------------------------------------------------------------------------
// Structured task errors
// ---------------------------------------------------------------------------

export type TaskErrorCode =
  | "TASK_MANIFEST_NOT_FOUND"
  | "TASK_MANIFEST_YAML_INVALID"
  | "TASK_MANIFEST_SCHEMA_ERROR"
  | "TASK_ID_UNKNOWN"
  | "TASK_EXECUTOR_UNSUPPORTED"
  | "TASK_EXECUTABLE_UNRESOLVED"
  | "TASK_PARAMETER_SCHEMA_INVALID"
  | "TASK_APPROVAL_REQUIRED"
  | "TASK_APPROVAL_PENDING_USER_CONFIRMATION"
  | "TASK_APPROVAL_STALE"
  | "TASK_CAPABILITY_CHANGED"
  | "TASK_HEAD_CHANGED"
  | "TASK_WORKTREE_DIRTY"
  | "TASK_STAGED_CHANGES_PRESENT"
  | "TASK_CONFLICTS_PRESENT"
  | "TASK_ROOT_NOT_APPROVED"
  | "TASK_SECRET_UNRESOLVED"
  | "TASK_SECRET_NOT_AUTHORIZED"
  | "TASK_ENVIRONMENT_UNAVAILABLE"
  | "TASK_ARTIFACT_ROOT_INVALID"
  | "TASK_TIMEOUT"
  | "TASK_PROCESS_FAILED";

export class TaskError extends Error {
  public readonly code: TaskErrorCode;
  public readonly manifestPath: string;
  public readonly taskId?: string;
  public readonly field?: string;
  public readonly recoverable: boolean;

  constructor(input: {
    code: TaskErrorCode;
    manifestPath?: string;
    taskId?: string;
    field?: string;
    message: string;
    recoverable?: boolean;
  }) {
    super(input.message);
    this.name = "TaskError";
    this.code = input.code;
    this.manifestPath = input.manifestPath ?? ".devspace/tasks.yaml";
    this.taskId = input.taskId;
    this.field = input.field;
    this.recoverable = input.recoverable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      manifestPath: this.manifestPath,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      ...(this.field ? { field: this.field } : {}),
      message: this.message,
      recoverable: this.recoverable,
    };
  }
}
