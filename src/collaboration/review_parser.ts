export interface Review {
  taskId: string;
  result: ReviewResult;
  reviewTime: string;
  codeQuality: ChecklistItem[];
  testCoverage: ChecklistItem[];
  boundaryCompliance: ChecklistItem[];
  architectureDesign: ChecklistItem[];
  specificIssues: Issue[];
  improvementSuggestions: string[];
  nextSteps: string[];
  conditionalPassConditions?: string;
}

export type ReviewResult = "✅ 通过" | "⚠️ 有条件通过" | "❌ 不通过" | "待审核";

export interface ChecklistItem {
  text: string;
  checked: boolean;
  needsImprovement?: boolean;
}

export interface Issue {
  title: string;
  location?: string;
  severity?: "高" | "中" | "低";
  suggestion?: string;
}

export function parseReview(content: string): Review {
  const lines = content.split("\n");
  const review: Partial<Review> = {
    codeQuality: [],
    testCoverage: [],
    boundaryCompliance: [],
    architectureDesign: [],
    specificIssues: [],
    improvementSuggestions: [],
    nextSteps: [],
  };

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.startsWith("## 任务ID")) {
      currentSection = "taskId";
      continue;
    }
    if (line.startsWith("## 审核结果")) {
      currentSection = "result";
      continue;
    }
    if (line.startsWith("## 审核时间")) {
      currentSection = "reviewTime";
      continue;
    }
    if (line.startsWith("### 代码质量")) {
      currentSection = "codeQuality";
      continue;
    }
    if (line.startsWith("### 测试覆盖")) {
      currentSection = "testCoverage";
      continue;
    }
    if (line.startsWith("### 边界遵守")) {
      currentSection = "boundaryCompliance";
      continue;
    }
    if (line.startsWith("### 架构设计")) {
      currentSection = "architectureDesign";
      continue;
    }
    if (line.startsWith("## 具体问题")) {
      currentSection = "specificIssues";
      continue;
    }
    if (line.startsWith("## 改进建议")) {
      currentSection = "improvementSuggestions";
      continue;
    }
    if (line.startsWith("## 下一步")) {
      currentSection = "nextSteps";
      continue;
    }
    if (line.startsWith("## 有条件通过条件")) {
      currentSection = "conditionalPassConditions";
      continue;
    }

    if (!trimmed) continue;

    switch (currentSection) {
      case "taskId":
        review.taskId = trimmed;
        break;
      case "result":
        review.result = trimmed as ReviewResult;
        break;
      case "reviewTime":
        review.reviewTime = trimmed;
        break;
      case "codeQuality":
      case "testCoverage":
      case "boundaryCompliance":
      case "architectureDesign":
        if (trimmed.startsWith("- [x]") || trimmed.startsWith("- [ ]")) {
          const checked = trimmed.startsWith("- [x]");
          const text = trimmed.substring(5).trim();
          const needsImprovement = text.includes("←");
          review[currentSection]!.push({ text, checked, needsImprovement });
        }
        break;
      case "specificIssues":
        if (trimmed.match(/^\d+\.\s*\*\*.*\*\*/)) {
          const titleMatch = trimmed.match(/\*\*(.+)\*\*/);
          review.specificIssues!.push({
            title: titleMatch ? titleMatch[1] : trimmed,
          });
        } else if (
          trimmed.startsWith("- 位置：") &&
          review.specificIssues!.length > 0
        ) {
          review.specificIssues!.slice(-1)[0].location = trimmed.substring(4);
        } else if (
          trimmed.startsWith("- 严重程度：") &&
          review.specificIssues!.length > 0
        ) {
          const severity = trimmed.substring(6) as "高" | "中" | "低";
          review.specificIssues!.slice(-1)[0].severity = severity;
        } else if (
          trimmed.startsWith("- 建议：") &&
          review.specificIssues!.length > 0
        ) {
          review.specificIssues!.slice(-1)[0].suggestion = trimmed.substring(4);
        }
        break;
      case "improvementSuggestions":
        if (trimmed.match(/^\d+\./)) {
          review.improvementSuggestions!.push(trimmed);
        }
        break;
      case "nextSteps":
        if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- [x]")) {
          review.nextSteps!.push(trimmed);
        }
        break;
      case "conditionalPassConditions":
        review.conditionalPassConditions =
          (review.conditionalPassConditions || "") + trimmed + " ";
        break;
    }
  }

  return {
    taskId: review.taskId || "",
    result: review.result || "待审核",
    reviewTime: review.reviewTime || "",
    codeQuality: review.codeQuality || [],
    testCoverage: review.testCoverage || [],
    boundaryCompliance: review.boundaryCompliance || [],
    architectureDesign: review.architectureDesign || [],
    specificIssues: review.specificIssues || [],
    improvementSuggestions: review.improvementSuggestions || [],
    nextSteps: review.nextSteps || [],
    conditionalPassConditions: review.conditionalPassConditions?.trim(),
  };
}

export function isReviewApproved(review: Review): boolean {
  return review.result === "✅ 通过";
}

export function isReviewConditionallyApproved(review: Review): boolean {
  return review.result === "⚠️ 有条件通过";
}

export function isReviewRejected(review: Review): boolean {
  return review.result === "❌ 不通过";
}

export function isReviewPending(review: Review): boolean {
  return review.result === "待审核";
}
