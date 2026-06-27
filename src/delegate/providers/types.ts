import type { VerdictType } from "../schemas.js";

export interface ExecutionResult {
  success: boolean;
  status: VerdictType;
  summary: string;
  files_changed: string[];
  test_results: string;
  errors: string[];
}

export interface ExecutorConfig {
  max_execution_time: number;
  allowed_changes: string[];
  forbidden_changes: string[];
  required_tests: string[];
}

export interface ExecutorProvider {
  name: string;
  execute(task: string, config: ExecutorConfig): Promise<ExecutionResult>;
}

export interface NextTask {
  task_id: string;
  title: string;
  content: string;
}

export interface CoachReview {
  reviewed_task: string;
  verdict: VerdictType;
  reasoning_summary: string;
  evidence_checked: string[];
  blocking_issues: string[];
  non_blocking_issues: string[];
  decision: string;
  next_action: string;
  next_task: NextTask | null;
}

export interface CoachReviewProvider {
  name: string;
  review(
    executionResult: ExecutionResult,
    taskContent: string,
  ): Promise<CoachReview>;
}

export function validateCoachReview(review: unknown): review is CoachReview {
  if (!review || typeof review !== "object") return false;
  const r = review as Record<string, unknown>;

  const validVerdicts = [
    "PASS",
    "PASS_WITH_WARNINGS",
    "NEEDS_FIX",
    "BLOCKED",
    "DONE",
    "NEED_USER",
    "SAFETY_STOP",
    "BUDGET_STOP",
  ];
  if (typeof r.verdict !== "string" || !validVerdicts.includes(r.verdict))
    return false;

  if (r.next_task !== null && r.next_task !== undefined) {
    if (typeof r.next_task !== "object") return false;
    const nt = r.next_task as Record<string, unknown>;
    if (
      typeof nt.task_id !== "string" ||
      typeof nt.title !== "string" ||
      typeof nt.content !== "string"
    )
      return false;
  }

  return true;
}

export function validateExecutionResult(
  result: unknown,
): result is ExecutionResult {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;

  const validVerdicts = [
    "PASS",
    "PASS_WITH_WARNINGS",
    "NEEDS_FIX",
    "BLOCKED",
    "DONE",
    "NEED_USER",
    "SAFETY_STOP",
    "BUDGET_STOP",
  ];
  if (typeof r.status !== "string" || !validVerdicts.includes(r.status))
    return false;
  if (typeof r.success !== "boolean") return false;
  if (typeof r.summary !== "string") return false;

  return true;
}
