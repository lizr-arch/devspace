export interface ExecutionReport {
  status: ReportStatus;
  taskId: string;
  startTime: string;
  endTime: string;
  duration: string;
  modifiedFiles: string;
  testResults: string;
  gitDiff: string;
  problems: string[];
  incompleteParts: string[];
  suggestedNextSteps: string[];
  notes: string;
}

export type ReportStatus = "已完成" | "部分完成" | "失败" | "待执行";

export function generateReport(report: ExecutionReport): string {
  return `# 执行报告

## 状态
${report.status}

## 任务ID
${report.taskId}

## 执行时间
- 开始：${report.startTime}
- 结束：${report.endTime}
- 耗时：${report.duration}

## 修改文件列表
\`\`\`bash
$ git diff --stat
${report.modifiedFiles}
\`\`\`

## 测试结果
\`\`\`bash
${report.testResults}
\`\`\`

## git diff
\`\`\`diff
${report.gitDiff}
\`\`\`

## 遇到的问题
${report.problems.map((p, i) => `${i + 1}. ${p}`).join("\n") || "无"}

## 未完成部分
${report.incompleteParts.map((p, i) => `${i + 1}. ${p}`).join("\n") || "无"}

## 建议下一步
${report.suggestedNextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "无"}

## 备注
${report.notes || "无"}
`;
}

export function parseReport(content: string): ExecutionReport {
  const lines = content.split("\n");
  const report: Partial<ExecutionReport> = {
    problems: [],
    incompleteParts: [],
    suggestedNextSteps: [],
  };

  let currentSection = "";
  let inCodeBlock = false;
  let codeBlockContent = "";
  let codeBlockType = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        if (codeBlockType === "bash" && currentSection === "modifiedFiles") {
          report.modifiedFiles = codeBlockContent;
        } else if (
          codeBlockType === "bash" &&
          currentSection === "testResults"
        ) {
          report.testResults = codeBlockContent;
        } else if (codeBlockType === "diff" && currentSection === "gitDiff") {
          report.gitDiff = codeBlockContent;
        }
        codeBlockContent = "";
        codeBlockType = "";
      } else {
        inCodeBlock = true;
        codeBlockType = line.substring(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += line + "\n";
      continue;
    }

    if (line.startsWith("## 状态")) {
      currentSection = "status";
      continue;
    }
    if (line.startsWith("## 任务ID")) {
      currentSection = "taskId";
      continue;
    }
    if (line.startsWith("## 执行时间")) {
      currentSection = "time";
      continue;
    }
    if (line.startsWith("## 修改文件列表")) {
      currentSection = "modifiedFiles";
      continue;
    }
    if (line.startsWith("## 测试结果")) {
      currentSection = "testResults";
      continue;
    }
    if (line.startsWith("## git diff")) {
      currentSection = "gitDiff";
      continue;
    }
    if (line.startsWith("## 遇到的问题")) {
      currentSection = "problems";
      report.problems = [];
      continue;
    }
    if (line.startsWith("## 未完成部分")) {
      currentSection = "incompleteParts";
      report.incompleteParts = [];
      continue;
    }
    if (line.startsWith("## 建议下一步")) {
      currentSection = "suggestedNextSteps";
      report.suggestedNextSteps = [];
      continue;
    }
    if (line.startsWith("## 备注")) {
      currentSection = "notes";
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    switch (currentSection) {
      case "status":
        report.status = trimmed as ReportStatus;
        break;
      case "taskId":
        report.taskId = trimmed;
        break;
      case "time":
        if (trimmed.startsWith("- 开始：")) {
          report.startTime = trimmed.substring(5);
        } else if (trimmed.startsWith("- 结束：")) {
          report.endTime = trimmed.substring(5);
        } else if (trimmed.startsWith("- 耗时：")) {
          report.duration = trimmed.substring(5);
        }
        break;
      case "problems":
        if (trimmed.match(/^\d+\./)) {
          report.problems!.push(trimmed);
        }
        break;
      case "incompleteParts":
        if (trimmed.match(/^\d+\./)) {
          report.incompleteParts!.push(trimmed);
        }
        break;
      case "suggestedNextSteps":
        if (trimmed.match(/^\d+\./)) {
          report.suggestedNextSteps!.push(trimmed);
        }
        break;
      case "notes":
        report.notes = (report.notes || "") + trimmed + " ";
        break;
    }
  }

  return {
    status: report.status || "待执行",
    taskId: report.taskId || "",
    startTime: report.startTime || "",
    endTime: report.endTime || "",
    duration: report.duration || "",
    modifiedFiles: report.modifiedFiles || "",
    testResults: report.testResults || "",
    gitDiff: report.gitDiff || "",
    problems: report.problems || [],
    incompleteParts: report.incompleteParts || [],
    suggestedNextSteps: report.suggestedNextSteps || [],
    notes: (report.notes || "").trim(),
  };
}
