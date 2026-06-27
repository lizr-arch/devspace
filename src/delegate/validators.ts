import type {
  GlobalState,
  RunState,
  ConversationEntry,
  DelegateContract,
  StopConditions,
  AutonomyMode,
  SystemStatus,
  ActorRole,
  ConversationType,
  VerdictType,
} from "./schemas.js";

const VALID_MODES: AutonomyMode[] = ["manual", "guided", "delegate", "free"];
const VALID_STATUSES: SystemStatus[] = [
  "BRAINSTORM",
  "FREEZE_HANDOFF",
  "READY_TO_DELEGATE",
  "DELEGATE_RUNNING",
  "LOCAL_EXECUTING",
  "LOCAL_REPORTED",
  "COACH_REVIEWING",
  "NEXT_TASK_CREATED",
  "NEED_USER",
  "BLOCKED",
  "DONE",
  "SAFETY_STOP",
  "BUDGET_STOP",
];
const VALID_ROLES: ActorRole[] = [
  "coach_gpt",
  "user_proxy",
  "local_orchestrator",
  "executor",
  "user",
];
const VALID_TYPES: ConversationType[] = [
  "task",
  "report",
  "review",
  "question",
  "decision",
  "status",
];
const VALID_VERDICTS: VerdictType[] = [
  "PASS",
  "PASS_WITH_WARNINGS",
  "NEEDS_FIX",
  "BLOCKED",
  "DONE",
  "NEED_USER",
  "SAFETY_STOP",
  "BUDGET_STOP",
];

export function validateState(state: unknown): state is GlobalState {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;

  if (
    typeof s.mode !== "string" ||
    !VALID_MODES.includes(s.mode as AutonomyMode)
  )
    return false;
  if (s.current_run_id !== null && typeof s.current_run_id !== "string")
    return false;
  if (
    typeof s.status !== "string" ||
    !VALID_STATUSES.includes(s.status as SystemStatus)
  )
    return false;
  if (
    typeof s.autonomy_level !== "string" ||
    !VALID_MODES.includes(s.autonomy_level as AutonomyMode)
  )
    return false;
  if (s.active_task_id !== null && typeof s.active_task_id !== "string")
    return false;
  if (s.stop_reason !== null && typeof s.stop_reason !== "string") return false;

  return true;
}

export function validateRunState(state: unknown): state is RunState {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;

  if (typeof s.run_id !== "string") return false;
  if (typeof s.task_id !== "string") return false;
  if (
    typeof s.status !== "string" ||
    !VALID_STATUSES.includes(s.status as SystemStatus)
  )
    return false;
  if (typeof s.round !== "number" || s.round < 0) return false;
  if (typeof s.max_rounds !== "number" || s.max_rounds < 1) return false;
  if (typeof s.created_at !== "string") return false;
  if (typeof s.updated_at !== "string") return false;
  if (
    typeof s.last_actor !== "string" ||
    !VALID_ROLES.includes(s.last_actor as ActorRole)
  )
    return false;
  if (
    typeof s.next_actor !== "string" ||
    !VALID_ROLES.includes(s.next_actor as ActorRole)
  )
    return false;

  return true;
}

export function validateConversationEntry(
  entry: unknown,
): entry is ConversationEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;

  if (typeof e.timestamp !== "string") return false;
  if (typeof e.run_id !== "string") return false;
  if (typeof e.role !== "string" || !VALID_ROLES.includes(e.role as ActorRole))
    return false;
  if (
    typeof e.type !== "string" ||
    !VALID_TYPES.includes(e.type as ConversationType)
  )
    return false;
  if (e.status !== null && typeof e.status !== "string") return false;
  if (typeof e.title !== "string") return false;
  if (e.content_file !== null && typeof e.content_file !== "string")
    return false;

  return true;
}

export function validateDelegateContract(
  contract: unknown,
): contract is DelegateContract {
  if (!contract || typeof contract !== "object") return false;
  const c = contract as Record<string, unknown>;

  if (!Array.isArray(c.can_do)) return false;
  if (!Array.isArray(c.cannot_do)) return false;
  if (!Array.isArray(c.must_trigger_need_user)) return false;
  if (!["low", "medium", "high"].includes(c.acceptable_risk_level as string))
    return false;
  if (typeof c.max_auto_scope !== "string") return false;

  return true;
}

export function validateStopConditions(
  conditions: unknown,
): conditions is StopConditions {
  if (!conditions || typeof conditions !== "object") return false;
  const c = conditions as Record<string, unknown>;

  if (!Array.isArray(c.done_conditions)) return false;
  if (!Array.isArray(c.blocked_conditions)) return false;
  if (!Array.isArray(c.need_user_conditions)) return false;
  if (!Array.isArray(c.safety_stop_conditions)) return false;

  if (!c.budget_stop || typeof c.budget_stop !== "object") return false;
  const budget = c.budget_stop as Record<string, unknown>;
  if (typeof budget.max_rounds !== "number" || budget.max_rounds < 1)
    return false;
  if (typeof budget.max_failures !== "number" || budget.max_failures < 1)
    return false;
  if (
    typeof budget.max_runtime_seconds !== "number" ||
    budget.max_runtime_seconds < 1
  )
    return false;
  if (
    typeof budget.max_file_changes !== "number" ||
    budget.max_file_changes < 1
  )
    return false;

  return true;
}

export function createDefaultState(): GlobalState {
  return {
    mode: "manual",
    current_run_id: null,
    status: "BRAINSTORM",
    autonomy_level: "manual",
    active_task_id: null,
    stop_reason: null,
  };
}

export function createDefaultRunState(
  taskId: string,
  maxRounds: number = 10,
): RunState {
  const now = new Date().toISOString();
  return {
    run_id: `run-${Date.now()}`,
    task_id: taskId,
    status: "LOCAL_EXECUTING",
    round: 1,
    max_rounds: maxRounds,
    created_at: now,
    updated_at: now,
    last_actor: "user",
    next_actor: "local_orchestrator",
  };
}

export function createConversationEntry(
  runId: string,
  role: ActorRole,
  type: ConversationType,
  title: string,
  status: VerdictType | null = null,
  contentFile: string | null = null,
): ConversationEntry {
  return {
    timestamp: new Date().toISOString(),
    run_id: runId,
    role,
    type,
    status,
    title,
    content_file: contentFile,
  };
}
