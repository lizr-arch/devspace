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
  ActorRole,
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

const DELEGATE_DIR = ".devspace";
const RUNS_DIR = ".devspace/runs";

export interface OrchestratorConfig {
  ollama_url: string;
  model: string;
  max_rounds: number;
  max_failures: number;
  max_runtime_seconds: number;
  max_file_changes: number;
}

export interface ExecutionResult {
  success: boolean;
  status: VerdictType;
  summary: string;
  files_changed: string[];
  test_results: string;
  errors: string[];
}

export class LocalOrchestrator {
  private config: OrchestratorConfig;
  private state: GlobalState;
  private contract: DelegateContract | null;
  private stopConditions: StopConditions | null;
  private consecutiveFailures: number = 0;
  private startTime: number;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = {
      ollama_url: config.ollama_url || "http://localhost:11434",
      model: config.model || "llama3",
      max_rounds: config.max_rounds || 10,
      max_failures: config.max_failures || 3,
      max_runtime_seconds: config.max_runtime_seconds || 3600,
      max_file_changes: config.max_file_changes || 50,
    };

    this.state = this.loadState();
    this.contract = readDelegateContract();
    this.stopConditions = readStopConditions();
    this.startTime = Date.now();
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

  async executeCurrentTask(): Promise<ExecutionResult> {
    const taskPath = join(DELEGATE_DIR, "current_task.md");
    const firstTaskPath = join(DELEGATE_DIR, "ceo", "first_task.md");

    let taskContent: string | null = null;
    if (existsSync(taskPath)) {
      taskContent = readFileSync(taskPath, "utf-8");
    } else if (existsSync(firstTaskPath)) {
      taskContent = readFileSync(firstTaskPath, "utf-8");
    }

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

    const budgetCheck = this.checkBudget();
    if (budgetCheck.exceeded) {
      this.state.status = "BUDGET_STOP";
      this.state.stop_reason = budgetCheck.reason;
      this.saveState();
      this.logConversation(
        "local_orchestrator",
        "status",
        "Budget exceeded",
        "BUDGET_STOP",
      );

      return {
        success: false,
        status: "BUDGET_STOP",
        summary: budgetCheck.reason || "Budget exceeded",
        files_changed: [],
        test_results: "",
        errors: [budgetCheck.reason || "Budget exceeded"],
      };
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
      taskPath,
    );

    try {
      const result = await this.callLocalModel(taskContent);

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

  private async callLocalModel(taskContent: string): Promise<ExecutionResult> {
    const prompt = this.buildPrompt(taskContent);

    try {
      const response = await fetch(`${this.config.ollama_url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const data = await response.json();
      const output = data.response;

      return this.processModelOutput(output);
    } catch (error) {
      return {
        success: false,
        status: "NEEDS_FIX",
        summary: "Failed to call local model",
        files_changed: [],
        test_results: "",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private buildPrompt(taskContent: string): string {
    return `You are a local code executor. Your task is to:

1. Read the task description below
2. Make the necessary code changes
3. Run the required tests
4. Generate a report

TASK:
${taskContent}

IMPORTANT RULES:
- Only modify files listed in "Allowed" section
- Never modify files listed in "Forbidden" section
- Always run the required validation commands
- If you cannot complete the task, explain why

OUTPUT FORMAT:
Please provide your output in this format:

## Changes Made
- [list of changes]

## Files Modified
- [file paths]

## Test Results
[test output]

## Status
[PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED]

## Summary
[brief summary]

## Issues (if any)
- [list of issues]
`;
  }

  private processModelOutput(output: string): ExecutionResult {
    const statusMatch = output.match(/## Status\n(.+)/);
    const status = (statusMatch?.[1]?.trim() || "NEEDS_FIX") as VerdictType;

    const summaryMatch = output.match(/## Summary\n(.+)/);
    const summary = summaryMatch?.[1]?.trim() || "No summary provided";

    const filesMatch = output.match(/## Files Modified\n([\s\S]*?)(?=##|$)/);
    const files_changed = filesMatch
      ? filesMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    const testMatch = output.match(/## Test Results\n([\s\S]*?)(?=##|$)/);
    const test_results = testMatch?.[1]?.trim() || "";

    const issuesMatch = output.match(/## Issues[\s\S]*?([\s\S]*?)(?=##|$)/);
    const errors = issuesMatch
      ? issuesMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    return {
      success: status === "PASS" || status === "PASS_WITH_WARNINGS",
      status,
      summary,
      files_changed,
      test_results,
      errors,
    };
  }

  submitCoachReview(verdict: VerdictType, reviewContent: string): void {
    this.state.status = getNextStatus(this.state.status, "review", verdict);
    this.saveState();

    this.logConversation(
      "coach_gpt",
      "review",
      `Coach review: ${verdict}`,
      verdict,
    );

    if (this.state.current_run_id) {
      const runDir = join(RUNS_DIR, this.state.current_run_id);
      const reviewPath = join(runDir, "coach_review.md");
      writeFileSync(reviewPath, reviewContent, "utf-8");
    }
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

  pause(): void {
    this.state.status = "READY_TO_DELEGATE";
    this.saveState();
    this.logConversation("user", "decision", "Delegate paused");
  }

  resume(): void {
    this.state.status = "DELEGATE_RUNNING";
    this.saveState();
    this.logConversation("user", "decision", "Delegate resumed");
  }

  stop(reason: string = "User stopped"): void {
    this.state.status = "DONE";
    this.state.stop_reason = reason;
    this.saveState();
    this.logConversation("user", "decision", `Delegate stopped: ${reason}`);
  }
}
