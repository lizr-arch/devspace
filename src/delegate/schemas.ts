export type AutonomyMode = "manual" | "guided" | "delegate" | "free";

export type SystemStatus =
  | "BRAINSTORM"
  | "FREEZE_HANDOFF"
  | "READY_TO_DELEGATE"
  | "DELEGATE_RUNNING"
  | "LOCAL_EXECUTING"
  | "LOCAL_REPORTED"
  | "COACH_REVIEWING"
  | "NEXT_TASK_CREATED"
  | "NEED_USER"
  | "BLOCKED"
  | "DONE"
  | "SAFETY_STOP"
  | "BUDGET_STOP";

export type ActorRole =
  "coach_gpt" | "user_proxy" | "local_orchestrator" | "executor" | "user";

export type ConversationType =
  "task" | "report" | "review" | "question" | "decision" | "status";

export type VerdictType =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "NEEDS_FIX"
  | "BLOCKED"
  | "DONE"
  | "NEED_USER"
  | "SAFETY_STOP"
  | "BUDGET_STOP";

export interface GlobalState {
  mode: AutonomyMode;
  current_run_id: string | null;
  status: SystemStatus;
  autonomy_level: AutonomyMode;
  active_task_id: string | null;
  stop_reason: string | null;
}

export interface RunState {
  run_id: string;
  task_id: string;
  status: SystemStatus;
  round: number;
  max_rounds: number;
  created_at: string;
  updated_at: string;
  last_actor: ActorRole;
  next_actor: ActorRole;
}

export interface ConversationEntry {
  timestamp: string;
  run_id: string;
  role: ActorRole;
  type: ConversationType;
  status: VerdictType | null;
  title: string;
  content_file: string | null;
}

export interface DelegateContract {
  can_do: string[];
  cannot_do: string[];
  must_trigger_need_user: string[];
  acceptable_risk_level: "low" | "medium" | "high";
  max_auto_scope: string;
}

export interface StopConditions {
  done_conditions: string[];
  blocked_conditions: string[];
  need_user_conditions: string[];
  safety_stop_conditions: string[];
  budget_stop: {
    max_rounds: number;
    max_failures: number;
    max_runtime_seconds: number;
    max_file_changes: number;
  };
}

export interface HandoffPackage {
  brainstorm_summary: string;
  user_intent: string;
  architecture_decision: string;
  ceo_charter: string;
  delegate_contract: DelegateContract;
  autonomy_policy: AutonomyMode;
  review_policy: string;
  stop_conditions: StopConditions;
  task_plan: string;
  first_task: string;
}
