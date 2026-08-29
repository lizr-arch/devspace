import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import * as prompts from "@clack/prompts";

export async function runCollabCommand(args: string[]): Promise<void> {
  const [subcommand] = args;

  if (!subcommand || subcommand === "init") {
    await runCollabInit();
    return;
  }

  if (subcommand === "status") {
    await runCollabStatus();
    return;
  }

  throw new Error(
    `Unknown collab command: ${subcommand}. Use 'init' or 'status'.`,
  );
}

export async function runCollabInit(): Promise<void> {
  const devspaceDir = ".devspace";

  if (existsSync(devspaceDir)) {
    prompts.log.info(
      `Collaboration workspace already exists at ${devspaceDir}`,
    );
    prompts.log.info("Run `devspace collab status` to check status.");
    return;
  }

  prompts.intro("Initializing collaboration workspace");

  mkdirSync(join(devspaceDir, "task_history"), { recursive: true });

  writeFileSync(
    join(devspaceDir, "context.md"),
    `# 项目背景

## 项目名称
[项目名称]

## 项目简介
[项目是做什么的]

## 技术栈
[使用的技术]

## 当前阶段
[正在做什么]

## 重要约束
[有什么限制]
`,
  );

  writeFileSync(
    join(devspaceDir, "current_task.md"),
    `# 当前任务

## 状态
待执行

## 任务ID
\`task-${new Date().toISOString().split("T")[0]}-001\`

## 目标
[一句话描述要做什么]

## 背景
[为什么要做这个]

## 允许修改范围
- src/*

## 禁止修改范围
- .devspace/*
- package.json

## 验收标准
- [ ] 所有现有测试通过
- [ ] 无 TypeScript 类型错误

## 必须运行的测试
\`\`\`bash
npm test
npm run typecheck
\`\`\`

## 报告格式要求
执行报告必须包含：
1. 修改了哪些文件（git diff --stat）
2. 测试结果
3. 遇到的问题和解决方案
4. 未完成的部分及原因

## 失败时如何处理
如果无法完成，必须说明：
1. 卡在哪里
2. 尝试了什么
3. 需要什么帮助

## 优先级
P1
`,
  );

  writeFileSync(
    join(devspaceDir, "execution_report.md"),
    `# 执行报告

## 状态
待执行

## 任务ID
[对应的任务ID]

## 执行时间
[开始时间] - [结束时间]

## 修改文件列表
\`\`\`bash
git diff --stat
\`\`\`

## 测试结果
[测试输出]

## git diff
\`\`\`diff
[diff 内容]
\`\`\`

## 遇到的问题
[问题描述]

## 未完成部分
[未完成的内容及原因]

## 建议下一步
[建议]
`,
  );

  writeFileSync(
    join(devspaceDir, "review.md"),
    `# 审核意见

## 任务ID
[对应的任务ID]

## 审核结果
待审核

## 详细评审

### 代码质量
- [ ] 代码风格符合规范
- [ ] 无明显性能问题
- [ ] 错误处理完善

### 测试覆盖
- [ ] 单元测试充分
- [ ] 边界情况覆盖
- [ ] 集成测试通过

### 边界遵守
- [ ] 未修改禁止范围的文件
- [ ] 未引入新的依赖（除非任务允许）

## 具体问题
1. [问题1描述]

## 改进建议
1. [建议1]

## 下一步
- [ ] 继续当前任务
- [ ] 创建修复任务
- [ ] 进入下一阶段
`,
  );

  writeFileSync(
    join(devspaceDir, "decision.md"),
    `# 最终裁决

## 任务ID
[对应的任务ID]

## 裁决结果
待裁决

## 裁决理由
[为什么做出这个决定]

## 后续行动
[下一步做什么]

## 裁决人
Web GPT / 用户

## 裁决时间
[时间]
`,
  );

  writeFileSync(
    join(devspaceDir, "next_task.md"),
    `# 下一轮任务

## 状态
待创建

## 基于
[基于哪个任务的结果]

## 目标
[下一轮要做什么]

## 优先级
[P0/P1/P2]
`,
  );

  writeFileSync(join(devspaceDir, "events.jsonl"), "");
  writeFileSync(
    join(devspaceDir, "state.json"),
    JSON.stringify(
      {
        current_phase: "idle",
        active_tasks: [],
        completed_tasks: [],
        blocked_tasks: [],
      },
      null,
      2,
    ),
  );

  prompts.note(
    [
      "Directory structure created:",
      `  ${devspaceDir}/`,
      "  ├── context.md           # Project background",
      "  ├── current_task.md      # Current task",
      "  ├── execution_report.md  # Execution report",
      "  ├── review.md            # Review feedback",
      "  ├── decision.md          # Final decision",
      "  ├── next_task.md         # Next task",
      "  ├── events.jsonl         # Event stream",
      "  ├── state.json           # State file",
      "  └── task_history/        # Task archive",
    ].join("\n"),
    "Collaboration workspace initialized",
  );

  prompts.outro("Run `devspace worker start` to start the local worker.");
}

export async function runCollabStatus(): Promise<void> {
  const devspaceDir = ".devspace";

  if (!existsSync(devspaceDir)) {
    throw new Error(
      "Collaboration workspace not found. Run `devspace collab init` first.",
    );
  }

  console.log("\n=== DevSpace Collaboration Status ===\n");

  const stateFile = join(devspaceDir, "state.json");
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    console.log("Current Phase:", state.current_phase);
    console.log(
      "Active Tasks:",
      state.active_tasks.length > 0 ? state.active_tasks.join(", ") : "None",
    );
    console.log(
      "Completed Tasks:",
      state.completed_tasks.length > 0
        ? state.completed_tasks.join(", ")
        : "None",
    );
    console.log(
      "Blocked Tasks:",
      state.blocked_tasks.length > 0 ? state.blocked_tasks.join(", ") : "None",
    );
  }

  const taskFile = join(devspaceDir, "current_task.md");
  if (existsSync(taskFile)) {
    const content = readFileSync(taskFile, "utf-8");
    const statusMatch = content.match(/## 状态\n(.+)/);
    if (statusMatch) {
      console.log("\nCurrent Task Status:", statusMatch[1]);
    }
  }

  const eventsFile = join(devspaceDir, "events.jsonl");
  if (existsSync(eventsFile)) {
    const events = readFileSync(eventsFile, "utf-8")
      .split("\n")
      .filter(Boolean);
    if (events.length > 0) {
      console.log("\nRecent Events:");
      events.slice(-5).forEach((event) => {
        const e = JSON.parse(event);
        console.log(`  [${e.ts}] ${e.event} - ${e.task_id}`);
      });
    }
  }

  const historyDir = join(devspaceDir, "task_history");
  if (existsSync(historyDir)) {
    const files = readdirSync(historyDir).filter((f) => f.endsWith(".md"));
    console.log(
      "\nTask History:",
      files.length > 0 ? `${files.length} archived tasks` : "No archived tasks",
    );
  }

  console.log("");
}

export async function runWorkerCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "start") {
    await runWorkerStart(rest);
    return;
  }

  throw new Error(`Unknown worker command: ${subcommand}. Use 'start'.`);
}

export async function runWorkerStart(args: string[]): Promise<void> {
  const configIndex = args.indexOf("--config");
  const configPath =
    configIndex !== -1 && args[configIndex + 1]
      ? args[configIndex + 1]
      : "devspace_worker_config.yaml";

  const workerScript = join("scripts", "devspace_worker.py");

  if (!existsSync(workerScript)) {
    throw new Error(`Worker script not found at ${workerScript}`);
  }

  try {
    execSync("python3 --version", { stdio: "ignore" });
  } catch {
    try {
      execSync("python --version", { stdio: "ignore" });
    } catch {
      throw new Error(
        "Python is required to run the worker. Install Python 3.x first.",
      );
    }
  }

  console.log("Starting DevSpace Worker...");
  console.log(`Config: ${configPath}`);
  console.log("Press Ctrl+C to stop.\n");

  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const worker = spawn(pythonCmd, [workerScript, "--config", configPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  worker.on("error", (error) => {
    console.error(`Failed to start worker: ${error.message}`);
    process.exitCode = 1;
  });

  worker.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`Worker exited with code ${code}`);
    }
  });

  process.on("SIGINT", () => {
    worker.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    worker.kill("SIGTERM");
  });
}
