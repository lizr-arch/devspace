import {
  LocalOrchestrator,
  type OrchestratorConfig,
  type ExecutionResult,
} from "./orchestrator.js";
import { parseCoachReview, getNextActionFromVerdict } from "./coach_review.js";
import type { VerdictType } from "./schemas.js";

export interface FreeModeConfig extends OrchestratorConfig {
  auto_review: boolean;
  pause_on_need_user: boolean;
  pause_on_safety_stop: boolean;
}

export interface FreeModeResult {
  completed: boolean;
  reason: string;
  rounds_executed: number;
  final_status: string;
}

export class FreeModeRunner {
  private orchestrator: LocalOrchestrator;
  private config: FreeModeConfig;
  private running: boolean = false;

  constructor(config: Partial<FreeModeConfig> = {}) {
    this.config = {
      ollama_url: config.ollama_url || "http://localhost:11434",
      model: config.model || "llama3",
      max_rounds: config.max_rounds || 10,
      max_failures: config.max_failures || 3,
      max_runtime_seconds: config.max_runtime_seconds || 3600,
      max_file_changes: config.max_file_changes || 50,
      auto_review: config.auto_review ?? false,
      pause_on_need_user: config.pause_on_need_user ?? true,
      pause_on_safety_stop: config.pause_on_safety_stop ?? true,
    };

    this.orchestrator = new LocalOrchestrator(this.config);
  }

  async start(): Promise<FreeModeResult> {
    this.running = true;
    let roundsExecuted = 0;

    while (this.running) {
      const result = await this.orchestrator.executeCurrentTask();
      roundsExecuted++;

      if (this.shouldStop(result.status)) {
        return {
          completed: false,
          reason: `Stopped due to: ${result.status}`,
          rounds_executed: roundsExecuted,
          final_status: result.status,
        };
      }

      if (result.status === "PASS" || result.status === "PASS_WITH_WARNINGS") {
        const status = this.orchestrator.getStatus();
        if (status.status === "DONE") {
          return {
            completed: true,
            reason: "All tasks completed",
            rounds_executed: roundsExecuted,
            final_status: "DONE",
          };
        }
      }

      if (this.config.auto_review) {
        const mockReview = this.generateAutoReview(result);
        this.orchestrator.submitCoachReview(
          mockReview.verdict,
          mockReview.content,
        );

        if (mockReview.verdict === "DONE") {
          return {
            completed: true,
            reason: "Auto review determined DONE",
            rounds_executed: roundsExecuted,
            final_status: "DONE",
          };
        }
      } else {
        break;
      }
    }

    return {
      completed: false,
      reason: "Free mode paused or stopped",
      rounds_executed: roundsExecuted,
      final_status: this.orchestrator.getStatus().status,
    };
  }

  stop(): void {
    this.running = false;
    this.orchestrator.stop("Free mode stopped by user");
  }

  private shouldStop(status: VerdictType): boolean {
    if (status === "BUDGET_STOP" || status === "BLOCKED") {
      return true;
    }

    if (status === "NEED_USER" && this.config.pause_on_need_user) {
      this.orchestrator.pause();
      return true;
    }

    if (status === "SAFETY_STOP" && this.config.pause_on_safety_stop) {
      this.orchestrator.pause();
      return true;
    }

    return false;
  }

  private generateAutoReview(result: ExecutionResult): {
    verdict: VerdictType;
    content: string;
  } {
    if (result.success) {
      return {
        verdict: "PASS",
        content: `# Auto Review

## Reviewed Task
Auto-generated

## Verdict
PASS

## Reasoning Summary
Execution completed successfully with status: ${result.status}

## Evidence Checked
- Test results: ${result.test_results ? "Pass" : "N/A"}
- Files changed: ${result.files_changed.length}

## Issues Found

### Blocking
- None

### Non-blocking
- None

## Decision
Task completed successfully

## Next Action
Continue to next task
`,
      };
    }

    return {
      verdict: "NEEDS_FIX",
      content: `# Auto Review

## Reviewed Task
Auto-generated

## Verdict
NEEDS_FIX

## Reasoning Summary
Execution failed with errors

## Evidence Checked
- Errors: ${result.errors.join(", ")}

## Issues Found

### Blocking
${result.errors.map((e) => `- ${e}`).join("\n")}

### Non-blocking
- None

## Decision
Fix required

## Next Action
Retry with fixes
`,
    };
  }
}
