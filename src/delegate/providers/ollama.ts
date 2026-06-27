import type {
  ExecutorProvider,
  ExecutorConfig,
  ExecutionResult,
  CoachReviewProvider,
  CoachReview,
} from "./types.js";
import type { VerdictType } from "../schemas.js";

export interface OllamaConfig {
  url: string;
  model: string;
}

export class OllamaExecutorProvider implements ExecutorProvider {
  name = "ollama";
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async execute(
    task: string,
    config: ExecutorConfig,
  ): Promise<ExecutionResult> {
    const prompt = this.buildPrompt(task, config);

    try {
      const response = await fetch(`${this.config.url}/api/generate`, {
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
      return this.parseOutput(data.response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isUnavailable =
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("timeout");

      return {
        success: false,
        status: isUnavailable ? "BLOCKED" : "NEEDS_FIX",
        summary: isUnavailable
          ? `Provider unavailable: ${errorMessage}`
          : `Execution error: ${errorMessage}`,
        files_changed: [],
        test_results: "",
        errors: [errorMessage],
      };
    }
  }

  private buildPrompt(task: string, config: ExecutorConfig): string {
    return `You are a local code executor. Execute the following task:

TASK:
${task}

ALLOWED CHANGES:
${config.allowed_changes.join("\n")}

FORBIDDEN CHANGES:
${config.forbidden_changes.join("\n")}

REQUIRED TESTS:
${config.required_tests.join("\n")}

OUTPUT FORMAT:
## Changes Made
- [list changes]

## Files Modified
- [file paths]

## Test Results
[test output]

## Status
[PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED]

## Summary
[brief summary]

## Issues (if any)
- [list issues]
`;
  }

  private parseOutput(output: string): ExecutionResult {
    const statusMatch = output.match(/## Status\n(.+)/);
    const status = (statusMatch?.[1]?.trim() || "NEEDS_FIX") as VerdictType;

    const summaryMatch = output.match(/## Summary\n(.+)/);
    const summary = summaryMatch?.[1]?.trim() || "No summary";

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
}

export class OllamaCoachReviewProvider implements CoachReviewProvider {
  name = "ollama";
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async review(
    executionResult: ExecutionResult,
    taskContent: string,
  ): Promise<CoachReview> {
    const prompt = this.buildPrompt(executionResult, taskContent);

    try {
      const response = await fetch(`${this.config.url}/api/generate`, {
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
      return this.parseOutput(data.response, taskContent);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isUnavailable =
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("timeout");

      return {
        reviewed_task: "unknown",
        verdict: isUnavailable ? "BLOCKED" : "NEEDS_FIX",
        reasoning_summary: isUnavailable
          ? `Provider unavailable: ${errorMessage}`
          : `Review error: ${errorMessage}`,
        evidence_checked: [],
        blocking_issues: [errorMessage],
        non_blocking_issues: [],
        decision: isUnavailable
          ? "Provider unavailable, cannot continue"
          : "Fix required",
        next_action: isUnavailable ? "Check provider availability" : "Retry",
        next_task: null,
      };
    }
  }

  private buildPrompt(result: ExecutionResult, task: string): string {
    return `You are a Coach reviewing code execution results. Provide a verdict.

TASK:
${task}

EXECUTION RESULT:
Status: ${result.status}
Summary: ${result.summary}
Files Changed: ${result.files_changed.join(", ")}
Test Results: ${result.test_results}
Errors: ${result.errors.join(", ")}

OUTPUT FORMAT:
## Reviewed Task
[task id]

## Verdict
[PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED/DONE/NEED_USER]

## Reasoning Summary
[explanation]

## Evidence Checked
- [evidence]

## Issues Found
### Blocking
- [issues]
### Non-blocking
- [issues]

## Decision
[decision]

## Next Action
[action]
`;
  }

  private parseOutput(output: string, task: string): CoachReview {
    const verdictMatch = output.match(/## Verdict\n(.+)/);
    const verdictStr = verdictMatch?.[1]?.trim();

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
    const verdict =
      verdictStr && validVerdicts.includes(verdictStr)
        ? (verdictStr as VerdictType)
        : "BLOCKED";

    const reasoningMatch = output.match(
      /## Reasoning Summary\n([\s\S]*?)(?=##|$)/,
    );
    const reasoning =
      reasoningMatch?.[1]?.trim() ||
      (verdictStr ? "" : "Invalid response: missing verdict");

    const blockingMatch = output.match(/### Blocking\n([\s\S]*?)(?=###|$)/);
    const blocking = blockingMatch
      ? blockingMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    const nonBlockingMatch = output.match(
      /### Non-blocking\n([\s\S]*?)(?=##|$)/,
    );
    const nonBlocking = nonBlockingMatch
      ? nonBlockingMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    const decisionMatch = output.match(/## Decision\n([\s\S]*?)(?=##|$)/);
    const decision =
      decisionMatch?.[1]?.trim() ||
      (verdictStr ? "" : "Invalid response from provider");

    const nextActionMatch = output.match(/## Next Action\n([\s\S]*?)(?=##|$)/);
    const nextAction = nextActionMatch?.[1]?.trim() || "";

    const nextTaskMatch = output.match(/## Next Task\n([\s\S]*?)(?=##|$)/);
    const nextTaskContent = nextTaskMatch?.[1]?.trim() || "";

    return {
      reviewed_task: task.substring(0, 50),
      verdict,
      reasoning_summary: reasoning,
      evidence_checked: ["execution report", "test results"],
      blocking_issues: verdictStr
        ? blocking
        : ["Invalid response: missing verdict"],
      non_blocking_issues: nonBlocking,
      decision,
      next_action: nextAction,
      next_task: nextTaskContent
        ? {
            task_id: `task-${Date.now()}`,
            title: `Task from review`,
            content: nextTaskContent,
          }
        : null,
    };
  }
}
