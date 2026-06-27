export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  goal: string;
  background: string;
  allowedChanges: string[];
  forbiddenChanges: string[];
  acceptanceCriteria: string[];
  requiredTests: string[];
  reportFormat: string[];
  failureHandling: string[];
  priority: Priority;
  deadline?: string;
  dependencies?: string[];
}

export type TaskStatus = "待执行" | "执行中" | "待审核" | "已完成" | "已拒绝";
export type Priority = "P0" | "P1" | "P2";

export function parseTask(content: string): Task {
  const lines = content.split("\n");
  const task: Partial<Task> = {};

  let currentSection = "";
  let inCodeBlock = false;
  let codeBlockContent = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        if (currentSection === "requiredTests") {
          task.requiredTests = codeBlockContent
            .split("\n")
            .filter((l) => l.trim());
        }
        codeBlockContent = "";
      } else {
        inCodeBlock = true;
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
      currentSection = "id";
      continue;
    }
    if (line.startsWith("## 目标")) {
      currentSection = "goal";
      continue;
    }
    if (line.startsWith("## 背景")) {
      currentSection = "background";
      continue;
    }
    if (line.startsWith("## 允许修改范围")) {
      currentSection = "allowedChanges";
      task.allowedChanges = [];
      continue;
    }
    if (line.startsWith("## 禁止修改范围")) {
      currentSection = "forbiddenChanges";
      task.forbiddenChanges = [];
      continue;
    }
    if (line.startsWith("## 验收标准")) {
      currentSection = "acceptanceCriteria";
      task.acceptanceCriteria = [];
      continue;
    }
    if (line.startsWith("## 必须运行的测试")) {
      currentSection = "requiredTests";
      continue;
    }
    if (line.startsWith("## 报告格式要求")) {
      currentSection = "reportFormat";
      task.reportFormat = [];
      continue;
    }
    if (line.startsWith("## 失败时如何处理")) {
      currentSection = "failureHandling";
      task.failureHandling = [];
      continue;
    }
    if (line.startsWith("## 优先级")) {
      currentSection = "priority";
      continue;
    }
    if (line.startsWith("## 截止时间")) {
      currentSection = "deadline";
      continue;
    }
    if (line.startsWith("## 依赖")) {
      currentSection = "dependencies";
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    switch (currentSection) {
      case "status":
        task.status = trimmed as TaskStatus;
        break;
      case "id":
        task.id = trimmed.replace(/`/g, "");
        break;
      case "goal":
        task.goal = trimmed;
        break;
      case "background":
        task.background = (task.background || "") + trimmed + " ";
        break;
      case "allowedChanges":
        if (trimmed.startsWith("- ")) {
          task.allowedChanges!.push(trimmed.substring(2));
        }
        break;
      case "forbiddenChanges":
        if (trimmed.startsWith("- ")) {
          task.forbiddenChanges!.push(trimmed.substring(2));
        }
        break;
      case "acceptanceCriteria":
        if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- [x]")) {
          task.acceptanceCriteria!.push(trimmed);
        }
        break;
      case "reportFormat":
        if (trimmed.match(/^\d+\./)) {
          task.reportFormat!.push(trimmed);
        }
        break;
      case "failureHandling":
        if (trimmed.match(/^\d+\./)) {
          task.failureHandling!.push(trimmed);
        }
        break;
      case "priority":
        task.priority = trimmed as Priority;
        break;
      case "deadline":
        if (trimmed !== "[可选]") {
          task.deadline = trimmed;
        }
        break;
    }
  }

  const titleMatch = content.match(/^# 任务：(.+)$/m);
  task.title = titleMatch ? titleMatch[1] : "Untitled";

  return {
    id: task.id || "",
    title: task.title,
    status: task.status || "待执行",
    goal: task.goal || "",
    background: (task.background || "").trim(),
    allowedChanges: task.allowedChanges || [],
    forbiddenChanges: task.forbiddenChanges || [],
    acceptanceCriteria: task.acceptanceCriteria || [],
    requiredTests: task.requiredTests || [],
    reportFormat: task.reportFormat || [],
    failureHandling: task.failureHandling || [],
    priority: task.priority || "P1",
    deadline: task.deadline,
    dependencies: task.dependencies,
  };
}

export function isTaskPending(task: Task): boolean {
  return task.status === "待执行";
}

export function isTaskInProgress(task: Task): boolean {
  return task.status === "执行中";
}

export function isTaskPendingReview(task: Task): boolean {
  return task.status === "待审核";
}

export function isTaskCompleted(task: Task): boolean {
  return task.status === "已完成";
}

export function isTaskRejected(task: Task): boolean {
  return task.status === "已拒绝";
}
