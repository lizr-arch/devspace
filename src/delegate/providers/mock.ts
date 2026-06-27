import type {
  ExecutorProvider,
  ExecutorConfig,
  ExecutionResult,
  CoachReviewProvider,
  CoachReview,
} from "./types.js";

export class MockExecutorProvider implements ExecutorProvider {
  name = "mock";
  private mockResult: ExecutionResult;

  constructor(mockResult?: Partial<ExecutionResult>) {
    this.mockResult = {
      success: true,
      status: "PASS",
      summary: "Mock execution completed successfully",
      files_changed: ["src/example.ts"],
      test_results: "All tests passed",
      errors: [],
      ...mockResult,
    };
  }

  async execute(
    task: string,
    config: ExecutorConfig,
  ): Promise<ExecutionResult> {
    return { ...this.mockResult };
  }
}

export class MockCoachReviewProvider implements CoachReviewProvider {
  name = "mock";
  private mockReview: CoachReview;
  private callCount: number = 0;
  private maxRounds: number;

  constructor(mockReview?: Partial<CoachReview>, maxRounds: number = 10) {
    this.maxRounds = maxRounds;
    this.mockReview = {
      reviewed_task: "mock-task",
      verdict: "PASS",
      reasoning_summary: "Mock review passed",
      evidence_checked: ["test results", "code changes"],
      blocking_issues: [],
      non_blocking_issues: [],
      decision: "Task completed successfully",
      next_action: "Continue to next task",
      next_task: {
        task_id: `task-${Date.now()}`,
        title: "Next Task",
        content:
          "# Next Task\n\n## Objective\nContinue development\n\n## Status\n待执行\n",
      },
      ...mockReview,
    };
  }

  async review(
    executionResult: ExecutionResult,
    taskContent: string,
  ): Promise<CoachReview> {
    this.callCount++;

    if (this.callCount >= this.maxRounds) {
      return {
        ...this.mockReview,
        verdict: "DONE",
        decision: "All rounds completed",
        next_action: "DONE",
        next_task: null,
      };
    }

    return { ...this.mockReview };
  }
}
