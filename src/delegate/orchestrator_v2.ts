import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  GlobalState,
  RunState,
  ConversationEntry,
  DelegateContract,
  StopConditions,
  VerdictType,
  SystemStatus,
  ActorRole,
  AutonomyMode,
} from "./schemas.js";
import {
  validateState,
  validateRunState,
  createDefaultRunState,
  createConversationEntry,
} from "./validators.js";
import { readDelegateContract, readStopConditions } from "./handoff.js";
import {
  checkPermission,
  shouldTriggerNeedUser,
  shouldTriggerSafetyStop,
  getNextStatus,
} from "./permissions.js";
import type {
  ExecutorProvider,
  ExecutorConfig,
  ExecutionResult,
  CoachReviewProvider,
  CoachReview,
} from "./providers/types.js";
import { UserProxyAgent } from "./user_proxy.js";

const DELEGATE_DIR = ".devspace";
const RUNS_DIR = ".devspace/runs";

export interface OrchestratorConfig {
  mode: AutonomyMode;
  max_rounds: number;
  max_failures: number;
  max_runtime_seconds: number;
  max_file_changes: number;
}

export class LocalOrchestratorV2 {
  private config: OrchestratorConfig;
  private state: GlobalState;
  private contract: DelegateContract | null;
  private stopConditions: StopConditions | null;
  private executor: ExecutorProvider;
  private coachReview: CoachReviewProvider;
  private userProxy: UserProxyAgent | null;
  private consecutiveFailures: number = 0;
  private startTime: number;
  private running: boolean = false;

  constructor(
    executor: ExecutorProvider,
    coachReview: CoachReviewProvider,
    config: Partial<OrchestratorConfig> = {},
  ) {
    this.executor = executor;
    this.coachReview = coachReview;

    this.config = {
      mode: config.mode || "delegate",
      max_rounds: config.max_rounds || 10,
      max_failures: config.max_failures || 3,
      max_runtime_seconds: config.max_runtime_seconds || 3600,
      max_file_changes: config.max_file_changes || 50,
    };

    this.state = this.loadState();
    this.contract = readDelegateContract();
    this.stopConditions = readStopConditions();
    this.startTime = Date.now();

    if (this.contract) {
      this.userProxy = new UserProxyAgent({
        contract: this.contract,
        mode: this.config.mode,
        state: this.state,
        consecutive_failures: 0,
      });
    } else {
      this.userProxy = null;
    }
  }

  private loadState(): GlobalState {
    const statePath = join(DELEGATE_DIR, "state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      if (validateState(state)) {
        return state;
      }
    }
    return {
      mode: "manual",
      current_run_id: null,
      status: "BRAINSTORM",
      autonomy_level: "manual",
      active_task_id: null,
      stop_reason: null,
    };
  }

  private saveState(): void {
    const statePath = join(DELEGATE_DIR, "state.json");
    writeFileSync(statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private logConversation(
    role: ActorRole,
    type: ConversationEntry["type"],
    title: string,
    status: VerdictType | null = null,
    contentFile: string | null = null,
  ): void {
    const entry = createConversationEntry(
      this.state.current_run_id || "no-run",
      role,
      type,
      title,
      status,
      contentFile,
    );

    const conversationPath = join(DELEGATE_DIR, "conversation.jsonl");
    appendFileSync(conversationPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  private checkStopConditions(): {
    shouldStop: boolean;
    reason: string | null;
    status: VerdictType | null;
  } {
    const budgetCheck = this.checkBudget();
    if (budgetCheck.exceeded) {
      return {
        shouldStop: true,
        reason: budgetCheck.reason,
        status: "BUDGET_STOP",
      };
    }

    if (
      this.consecutiveFailures >=
      (this.stopConditions?.budget_stop.max_failures || 3)
    ) {
      return {
        shouldStop: true,
        reason: "Max consecutive failures exceeded",
        status: "BUDGET_STOP",
      };
    }

    return { shouldStop: false, reason: null, status: null };
  }

  private checkBudget(): { exceeded: boolean; reason: string | null } {
    const elapsed = (Date.now() - this.startTime) / 1000;

    if (this.stopConditions) {
      const budget = this.stopConditions.budget_stop;

      if (this.state.current_run_id) {
        const runState = this.loadRunState(this.state.current_run_id);
        if (runState && runState.round > budget.max_rounds) {
          return {
            exceeded: true,
            reason: `Max rounds (${budget.max_rounds}) exceeded`,
          };
        }
      }

      if (this.consecutiveFailures >= budget.max_failures) {
        return {
          exceeded: true,
          reason: `Max consecutive failures (${budget.max_failures}) exceeded`,
        };
      }

      if (elapsed > budget.max_runtime_seconds) {
        return {
          exceeded: true,
          reason: `Max runtime (${budget.max_runtime_seconds}s) exceeded`,
        };
      }
    }

    return { exceeded: false, reason: null };
  }

  private loadRunState(runId: string): RunState | null {
    const runDir = join(RUNS_DIR, runId);
    const runStatePath = join(runDir, "run_state.json");

    if (existsSync(runStatePath)) {
      const state = JSON.parse(readFileSync(runStatePath, "utf-8"));
      if (validateRunState(state)) {
        return state;
      }
    }
    return null;
  }

  private saveRunState(runState: RunState): void {
    const runDir = join(RUNS_DIR, runState.run_id);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }

    const runStatePath = join(runDir, "run_state.json");
    writeFileSync(runStatePath, JSON.stringify(runState, null, 2), "utf-8");
  }

  private readCurrentTask(): string | null {
    const taskPath = join(DELEGATE_DIR, "current_task.md");
    const firstTaskPath = join(DELEGATE_DIR, "ceo", "first_task.md");

    if (existsSync(taskPath)) {
      return readFileSync(taskPath, "utf-8");
    } else if (existsSync(firstTaskPath)) {
      return readFileSync(firstTaskPath, "utf-8");
    }

    return null;
  }

  private writeNextTask(taskContent: string): void {
    const taskPath = join(DELEGATE_DIR, "current_task.md");
    writeFileSync(taskPath, taskContent, "utf-8");
  }

  async executeSingleTask(): Promise<ExecutionResult> {
    const taskContent = this.readCurrentTask();

    if (!taskContent) {
      return {
        success: false,
        status: "BLOCKED",
        summary: "No task file found",
        files_changed: [],
        test_results: "",
        errors: ["No current_task.md or first_task.md found"],
      };
    }

    if (this.config.mode === "manual") {
      this.logConversation(
        "user",
        "decision",
        "Manual mode: waiting for user confirmation",
      );
      return {
        success: false,
        status: "NEED_USER",
        summary: "Manual mode: waiting for user confirmation",
        files_changed: [],
        test_results: "",
        errors: [],
      };
    }

    if (this.config.mode === "guided") {
      this.logConversation(
        "local_orchestrator",
        "task",
        "Guided mode: task ready for execution",
      );
    }

    if (this.config.mode === "delegate" && this.userProxy) {
      const proxyDecision = this.userProxy.evaluateTask(taskContent);

      if (proxyDecision.action === "escalate") {
        this.state.status = "NEED_USER";
        this.saveState();
        this.logConversation(
          "user_proxy",
          "question",
          `Escalating to user: ${proxyDecision.reason}`,
          "NEED_USER",
        );

        return {
          success: false,
          status: "NEED_USER",
          summary: `User Proxy escalated: ${proxyDecision.reason}`,
          files_changed: [],
          test_results: "",
          errors: [proxyDecision.reason],
        };
      }

      if (proxyDecision.action === "reject") {
        return {
          success: false,
          status: "NEEDS_FIX",
          summary: `User Proxy rejected: ${proxyDecision.reason}`,
          files_changed: [],
          test_results: "",
          errors: [proxyDecision.reason],
        };
      }
    }

    const runId = `run-${Date.now()}`;
    const runState = createDefaultRunState(
      "current-task",
      this.config.max_rounds,
    );
    runState.run_id = runId;
    this.saveRunState(runState);

    this.state.current_run_id = runId;
    this.state.active_task_id = "current-task";
    this.state.status = "LOCAL_EXECUTING";
    this.saveState();

    this.logConversation(
      "local_orchestrator",
      "task",
      "Task execution started",
      null,
    );

    const executorConfig: ExecutorConfig = {
      max_execution_time: this.config.max_runtime_seconds,
      allowed_changes: this.contract?.can_do || [],
      forbidden_changes: this.contract?.cannot_do || [],
      required_tests: [],
    };

    try {
      const result = await this.executor.execute(taskContent, executorConfig);

      this.state.status = "LOCAL_REPORTED";
      this.saveState();

      this.logConversation(
        "executor",
        "report",
        "Execution completed",
        result.status,
      );

      if (result.success) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }

      return result;
    } catch (error) {
      this.consecutiveFailures++;
      this.state.status = "LOCAL_REPORTED";
      this.saveState();

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logConversation(
        "executor",
        "report",
        "Execution failed",
        "NEEDS_FIX",
      );

      return {
        success: false,
        status: "NEEDS_FIX",
        summary: `Execution error: ${errorMessage}`,
        files_changed: [],
        test_results: "",
        errors: [errorMessage],
      };
    }
  }

  async runAutoLoop(): Promise<void> {
    this.running = true;
    this.state.status = "DELEGATE_RUNNING";
    this.saveState();

    let round = 0;

    while (this.running) {
      round++;

      if (round > this.config.max_rounds) {
        this.state.status = "BUDGET_STOP";
        this.state.stop_reason = `Max rounds (${this.config.max_rounds}) exceeded`;
        this.saveState();
        this.generateBudgetStopReport();
        this.logConversation(
          "local_orchestrator",
          "status",
          `Budget stop: max rounds exceeded`,
          "BUDGET_STOP",
        );
        break;
      }

      const taskContent = this.readCurrentTask();
      if (!taskContent) {
        this.state.status = "DONE";
        this.state.stop_reason = "No more tasks";
        this.saveState();
        this.logConversation(
          "local_orchestrator",
          "status",
          "No more tasks",
          "DONE",
        );
        break;
      }

      const result = await this.executeSingleTask();

      this.generateLocalReport(result, taskContent);

      if (result.status === "NEED_USER") {
        this.state.status = "NEED_USER";
        this.saveState();
        this.logConversation(
          "user_proxy",
          "question",
          "Need user decision",
          "NEED_USER",
        );
        break;
      }

      if (result.status === "SAFETY_STOP") {
        this.state.status = "SAFETY_STOP";
        this.saveState();
        this.logConversation(
          "local_orchestrator",
          "status",
          "Safety stop triggered",
          "SAFETY_STOP",
        );
        break;
      }

      const review = await this.coachReview.review(result, taskContent);

      this.generateCoachReview(review);

      this.logConversation(
        "coach_gpt",
        "review",
        `Coach review: ${review.verdict}`,
        review.verdict,
      );

      if (review.verdict === "DONE") {
        this.state.status = "DONE";
        this.saveState();
        this.generateFinalReport(review);
        this.logConversation(
          "local_orchestrator",
          "status",
          "All tasks completed",
          "DONE",
        );
        break;
      } else if (review.verdict === "BLOCKED") {
        this.state.status = "BLOCKED";
        this.saveState();
        this.generateBlockedReport(review);
        this.logConversation(
          "local_orchestrator",
          "status",
          "Blocked",
          "BLOCKED",
        );
        break;
      } else if (review.verdict === "NEED_USER") {
        this.state.status = "NEED_USER";
        this.saveState();
        this.generateUserQuestion(review);
        this.logConversation(
          "coach_gpt",
          "question",
          "Coach requests user decision",
          "NEED_USER",
        );
        break;
      } else if (review.verdict === "SAFETY_STOP") {
        this.state.status = "SAFETY_STOP";
        this.saveState();
        this.logConversation(
          "local_orchestrator",
          "status",
          "Safety stop triggered",
          "SAFETY_STOP",
        );
        break;
      } else if (review.verdict === "BUDGET_STOP") {
        this.state.status = "BUDGET_STOP";
        this.saveState();
        this.logConversation(
          "local_orchestrator",
          "status",
          "Budget stop triggered",
          "BUDGET_STOP",
        );
        break;
      } else if (
        review.verdict === "PASS" ||
        review.verdict === "PASS_WITH_WARNINGS"
      ) {
        if (!review.next_task) {
          this.state.status = "BLOCKED";
          this.state.stop_reason =
            "Coach Review PASS but no next_task provided";
          this.saveState();
          this.generateBlockedReport(review);
          this.logConversation(
            "local_orchestrator",
            "status",
            "BLOCKED: No next_task from Coach",
            "BLOCKED",
          );
          break;
        }

        this.writeNextTask(review.next_task.content);
        this.logConversation(
          "coach_gpt",
          "task",
          `Next task: ${review.next_task.title}`,
        );
      } else if (review.verdict === "NEEDS_FIX") {
        if (review.next_task) {
          this.writeNextTask(review.next_task.content);
          this.logConversation(
            "coach_gpt",
            "task",
            `Fix task: ${review.next_task.title}`,
          );
        } else {
          this.writeNextTask(review.next_action || "Fix previous task issues");
          this.logConversation(
            "coach_gpt",
            "task",
            "Fix task from Coach Review",
          );
        }
      }

      if (this.config.mode !== "free") {
        break;
      }
    }
  }

  private generateFinalReport(review: CoachReview): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const report = `# Final Report

## Task ID
${review.reviewed_task}

## Verdict
${review.verdict}

## Summary
${review.reasoning_summary}

## Decision
${review.decision}

## Evidence Checked
${review.evidence_checked.map((e) => `- ${e}`).join("\n")}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "final_report.md"), report, "utf-8");
  }

  private generateBlockedReport(review: CoachReview): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const report = `# Blocked Report

## Task ID
${review.reviewed_task}

## Verdict
BLOCKED

## Reason
${review.reasoning_summary}

## Blocking Issues
${review.blocking_issues.map((i) => `- ${i}`).join("\n")}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "blocked_report.md"), report, "utf-8");
  }

  private generateUserQuestion(review: CoachReview): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const question = `# User Question

## Task ID
${review.reviewed_task}

## Reason
${review.reasoning_summary}

## Decision Required
${review.decision}

## Options
${review.blocking_issues.map((i) => `- ${i}`).join("\n")}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "user_question.md"), question, "utf-8");
  }

  private generateBudgetStopReport(): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const report = `# Budget Stop Report

## Task ID
${this.state.active_task_id || "unknown"}

## Verdict
BUDGET_STOP

## Reason
${this.state.stop_reason || "Max rounds exceeded"}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "budget_stop_report.md"), report, "utf-8");
  }

  private generateLocalReport(
    result: ExecutionResult,
    taskContent: string,
  ): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const report = `# Local Execution Report

## Task ID
${this.state.active_task_id || "unknown"}

## Status
${result.status}

## Summary
${result.summary}

## Files Changed
${result.files_changed.length > 0 ? result.files_changed.map((f) => `- ${f}`).join("\n") : "- None"}

## Test Results
${result.test_results || "No test results"}

## Errors
${result.errors.length > 0 ? result.errors.map((e) => `- ${e}`).join("\n") : "- None"}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "local_report.md"), report, "utf-8");
  }

  private generateCoachReview(review: CoachReview): void {
    if (!this.state.current_run_id) return;
    const runDir = join(RUNS_DIR, this.state.current_run_id);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const report = `# Coach Review

## Task ID
${review.reviewed_task}

## Verdict
${review.verdict}

## Reasoning Summary
${review.reasoning_summary}

## Decision
${review.decision}

## Next Action
${review.next_action || "None"}

## Blocking Issues
${review.blocking_issues.length > 0 ? review.blocking_issues.map((i) => `- ${i}`).join("\n") : "- None"}

## Non-blocking Issues
${review.non_blocking_issues.length > 0 ? review.non_blocking_issues.map((i) => `- ${i}`).join("\n") : "- None"}

## Generated At
${new Date().toISOString()}
`;
    writeFileSync(join(runDir, "coach_review.md"), report, "utf-8");
  }

  stop(): void {
    this.running = false;
    this.state.status = "DONE";
    this.state.stop_reason = "User stopped";
    this.saveState();
    this.logConversation("user", "decision", "Delegate stopped");
  }

  pause(): void {
    this.running = false;
    this.state.status = "READY_TO_DELEGATE";
    this.saveState();
    this.logConversation("user", "decision", "Delegate paused");
  }

  resume(): void {
    this.state.status = "DELEGATE_RUNNING";
    this.saveState();
    this.logConversation("user", "decision", "Delegate resumed");
    this.runAutoLoop();
  }

  getStatus(): GlobalState {
    return { ...this.state };
  }

  getRunStatus(): RunState | null {
    if (this.state.current_run_id) {
      return this.loadRunState(this.state.current_run_id);
    }
    return null;
  }
}
