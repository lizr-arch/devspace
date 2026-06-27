import type {
  ExecutorProvider,
  ExecutorConfig,
  ExecutionResult,
  CoachReviewProvider,
  CoachReview,
} from "./types.js";
import type { VerdictType } from "../schemas.js";

export interface OpenAIConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAICompatibleExecutorProvider implements ExecutorProvider {
  name = "openai_compatible";
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = { timeoutMs: 30000, ...config };
  }

  async execute(
    task: string,
    config: ExecutorConfig,
  ): Promise<ExecutionResult> {
    const prompt = this.buildPrompt(task, config);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(
        `${this.config.apiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a local code executor. Execute tasks and return structured results.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.1,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      const output = data.choices?.[0]?.message?.content || "";
      return this.parseOutput(output);
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isTimeout =
        errorMessage.includes("abort") || errorMessage.includes("AbortError");
      const isUnavailable =
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("fetch failed") ||
        isTimeout;

      return {
        success: false,
        status: "BLOCKED",
        summary: isTimeout
          ? "Provider timeout"
          : isUnavailable
            ? `Provider unavailable: ${errorMessage}`
            : `Execution error: ${errorMessage}`,
        files_changed: [],
        test_results: "",
        errors: [isTimeout ? "Provider timeout" : errorMessage],
      };
    }
  }

  private buildPrompt(task: string, config: ExecutorConfig): string {
    return `Execute the following task:

TASK:
${task}

ALLOWED CHANGES:
${config.allowed_changes.join("\n")}

FORBIDDEN CHANGES:
${config.forbidden_changes.join("\n")}

REQUIRED TESTS:
${config.required_tests.join("\n")}

OUTPUT FORMAT:
## Status
[PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED]

## Summary
[brief summary]

## Files Modified
- [file paths]

## Test Results
[test output]

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

export class OpenAICompatibleCoachReviewProvider implements CoachReviewProvider {
  name = "openai_compatible";
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = { timeoutMs: 30000, ...config };
  }

  async review(
    executionResult: ExecutionResult,
    taskContent: string,
  ): Promise<CoachReview> {
    const prompt = this.buildPrompt(executionResult, taskContent);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(
        `${this.config.apiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a Coach reviewing code execution results. Provide structured review.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.1,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      const output = data.choices?.[0]?.message?.content || "";
      return this.parseOutput(output, taskContent);
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isTimeout =
        errorMessage.includes("abort") || errorMessage.includes("AbortError");
      const isUnavailable =
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("fetch failed") ||
        isTimeout;

      return {
        reviewed_task: "unknown",
        verdict: "BLOCKED",
        reasoning_summary: isTimeout
          ? "Provider timeout"
          : isUnavailable
            ? `Provider unavailable: ${errorMessage}`
            : `Review error: ${errorMessage}`,
        evidence_checked: [],
        blocking_issues: [isTimeout ? "Provider timeout" : errorMessage],
        non_blocking_issues: [],
        decision: "Provider error, cannot continue",
        next_action: "Check provider availability",
        next_task: null,
      };
    }
  }

  private buildPrompt(result: ExecutionResult, task: string): string {
    return `Review the following execution result:

TASK:
${task}

EXECUTION RESULT:
Status: ${result.status}
Summary: ${result.summary}
Files Changed: ${result.files_changed.join(", ")}
Test Results: ${result.test_results}
Errors: ${result.errors.join(", ")}

OUTPUT FORMAT:
## Verdict
[PASS/PASS_WITH_WARNINGS/NEEDS_FIX/BLOCKED/DONE/NEED_USER]

## Reasoning Summary
[explanation]

## Next Action
[next task description or DONE]

## Issues
### Blocking
- [issues]
### Non-blocking
- [issues]
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

    const nextActionMatch = output.match(/## Next Action\n([\s\S]*?)(?=##|$)/);
    const nextAction = nextActionMatch?.[1]?.trim() || "";

    const nextTaskMatch = output.match(
      /## Next Task\n([\s\S]*?)(?=## Blocking|$)/,
    );
    const nextTaskContent = nextTaskMatch?.[1]?.trim() || "";

    const blockingMatch = output.match(
      /## Blocking Issues\n([\s\S]*?)(?=##|$)/,
    );
    const blocking = blockingMatch
      ? blockingMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    const nonBlockingMatch = output.match(
      /## Non-blocking Issues\n([\s\S]*?)(?=##|$)/,
    );
    const nonBlocking = nonBlockingMatch
      ? nonBlockingMatch[1]
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.substring(2))
      : [];

    return {
      reviewed_task: task.substring(0, 50),
      verdict,
      reasoning_summary: reasoning,
      evidence_checked: ["execution report", "test results"],
      blocking_issues: verdictStr
        ? blocking
        : ["Invalid response: missing verdict"],
      non_blocking_issues: nonBlocking,
      decision: verdictStr
        ? verdict === "PASS"
          ? "Task completed"
          : "Fix required"
        : "Invalid response from provider",
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
