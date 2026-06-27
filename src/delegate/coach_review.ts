import type { VerdictType } from "./schemas.js";

export interface CoachReview {
  reviewed_task: string;
  verdict: VerdictType;
  reasoning_summary: string;
  evidence_checked: string[];
  blocking_issues: string[];
  non_blocking_issues: string[];
  decision: string;
  next_action: string;
}

export function parseCoachReview(content: string): CoachReview {
  const taskMatch = content.match(/## Reviewed Task\n(.+)/);
  const verdictMatch = content.match(/## Verdict\n(.+)/);
  const reasoningMatch = content.match(
    /## Reasoning Summary\n([\s\S]*?)(?=##|$)/,
  );
  const evidenceMatch = content.match(
    /## Evidence Checked\n([\s\S]*?)(?=##|$)/,
  );
  const blockingMatch = content.match(/### Blocking\n([\s\S]*?)(?=###|$)/);
  const nonBlockingMatch = content.match(
    /### Non-blocking\n([\s\S]*?)(?=##|$)/,
  );
  const decisionMatch = content.match(/## Decision\n([\s\S]*?)(?=##|$)/);
  const nextActionMatch = content.match(/## Next Action\n([\s\S]*?)(?=##|$)/);

  const extractList = (text: string | undefined): string[] => {
    if (!text) return [];
    return text
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().substring(2));
  };

  return {
    reviewed_task: taskMatch?.[1]?.trim() || "",
    verdict: (verdictMatch?.[1]?.trim() || "NEEDS_FIX") as VerdictType,
    reasoning_summary: reasoningMatch?.[1]?.trim() || "",
    evidence_checked: extractList(evidenceMatch?.[1]),
    blocking_issues: extractList(blockingMatch?.[1]),
    non_blocking_issues: extractList(nonBlockingMatch?.[1]),
    decision: decisionMatch?.[1]?.trim() || "",
    next_action: nextActionMatch?.[1]?.trim() || "",
  };
}

export function generateCoachReview(review: CoachReview): string {
  return `# Coach Review

## Reviewed Task
${review.reviewed_task}

## Verdict
${review.verdict}

## Reasoning Summary
${review.reasoning_summary}

## Evidence Checked
${review.evidence_checked.map((e) => `- ${e}`).join("\n")}

## Issues Found

### Blocking
${review.blocking_issues.length > 0 ? review.blocking_issues.map((i) => `- ${i}`).join("\n") : "- None"}

### Non-blocking
${review.non_blocking_issues.length > 0 ? review.non_blocking_issues.map((i) => `- ${i}`).join("\n") : "- None"}

## Decision
${review.decision}

## Next Action
${review.next_action}
`;
}

export function getNextActionFromVerdict(verdict: VerdictType): string {
  switch (verdict) {
    case "PASS":
      return "Generate next_task.md or DONE";
    case "PASS_WITH_WARNINGS":
      return "Generate next_task.md with warnings noted";
    case "NEEDS_FIX":
      return "Generate fix task";
    case "BLOCKED":
      return "Generate blocked_report.md";
    case "DONE":
      return "Generate final_report.md";
    case "NEED_USER":
      return "Generate user_question.md";
    case "SAFETY_STOP":
      return "Stop immediately, generate safety_report.md";
    case "BUDGET_STOP":
      return "Stop and generate budget_report.md";
    default:
      return "Unknown";
  }
}
