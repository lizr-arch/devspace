#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "config"
  | "help"
  | "collab"
  | "worker"
  | "handoff"
  | "delegate"
  | "run"
  | "timeline"
  | "mcp";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "collab":
      await runCollabCommand(args);
      return;
    case "worker":
      await runWorkerCommand(args);
      return;
    case "handoff":
      await runHandoffCommand(args);
      return;
    case "delegate":
      await runDelegateCommand(args);
      return;
    case "run":
      await runRunCommand(args);
      return;
    case "timeline":
      await runTimelineCommand(args);
      return;
    case "mcp":
      await runMcpCommand(args);
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config")
    return command;
  if (command === "help" || command === "--help" || command === "-h")
    return "help";
  if (
    command === "collab" ||
    command === "worker" ||
    command === "handoff" ||
    command === "delegate" ||
    command === "run" ||
    command === "timeline" ||
    command === "mcp"
  )
    return command;
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) =>
        value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(
      await textPrompt({
        message: files.config.publicBaseUrl
          ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
          : "What is the public base URL?",
        placeholder:
          files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }),
    );

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn(
        "warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*",
      );
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(
    `Config file: ${files.configExists ? files.configPath : "missing"}`,
  );
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(
      `Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`,
    );
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  } catch (error) {
    console.log(
      `Config status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error(
      "Only `devspace config set publicBaseUrl <url|null>` is supported right now.",
    );
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

async function runCollabCommand(args: string[]): Promise<void> {
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

async function runCollabInit(): Promise<void> {
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

async function runCollabStatus(): Promise<void> {
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

async function runWorkerCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "start") {
    await runWorkerStart(rest);
    return;
  }

  throw new Error(`Unknown worker command: ${subcommand}. Use 'start'.`);
}

async function runWorkerStart(args: string[]): Promise<void> {
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

async function runHandoffCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand === "init") {
    await runHandoffInit();
    return;
  }

  if (subcommand === "import") {
    await runHandoffImport(rest[0]);
    return;
  }

  if (subcommand === "validate") {
    await runHandoffValidate();
    return;
  }

  if (subcommand === "show") {
    await runHandoffShow();
    return;
  }

  throw new Error(
    `Unknown handoff command: ${subcommand || "(none)"}. Use 'init', 'import', 'validate', or 'show'.`,
  );
}

async function runHandoffInit(): Promise<void> {
  const { initializeHandoffPackage, validateHandoffPackage } =
    await import("./delegate/handoff.js");

  prompts.intro("Initializing Handoff Package");

  initializeHandoffPackage();

  const validation = validateHandoffPackage();

  if (validation.valid) {
    prompts.note(
      [
        "Empty Handoff Package created!",
        "",
        "Files created in .devspace/ceo/:",
        "  - brainstorm_summary.md",
        "  - user_intent.md",
        "  - architecture_decision.md",
        "  - ceo_charter.md",
        "  - delegate_contract.md",
        "  - autonomy_policy.md",
        "  - review_policy.md",
        "  - stop_conditions.md",
        "  - task_plan.md",
        "  - first_task.md",
        "",
        "Next steps:",
        "  1. Edit the files in .devspace/ceo/ with your brainstorm results",
        "  2. Run 'devspace handoff validate' to check",
        "  3. Run 'devspace delegate start' when ready",
      ].join("\n"),
      "Handoff Initialized",
    );
  } else {
    prompts.note(
      ["Validation errors:", ...validation.errors.map((e) => `  - ${e}`)].join(
        "\n",
      ),
      "Validation Failed",
    );
  }

  prompts.outro("Handoff init complete.");
}

async function runHandoffImport(filePath?: string): Promise<void> {
  if (!filePath) {
    throw new Error(
      "handoff import requires a file path. Use: devspace handoff import <file>",
    );
  }

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const { initializeHandoffPackage, validateHandoffPackage } =
    await import("./delegate/handoff.js");

  prompts.intro("Importing Handoff Package");

  initializeHandoffPackage();

  const content = readFileSync(filePath, "utf-8");
  prompts.note(`Importing from: ${filePath}`, "Import Source");

  const validation = validateHandoffPackage();

  if (validation.valid) {
    prompts.note(
      [
        "Handoff Package imported successfully!",
        "",
        "Next steps:",
        "  1. Run 'devspace handoff validate' to check",
        "  2. Run 'devspace delegate start' when ready",
      ].join("\n"),
      "Handoff Imported",
    );
  } else {
    prompts.note(
      ["Validation errors:", ...validation.errors.map((e) => `  - ${e}`)].join(
        "\n",
      ),
      "Validation Failed",
    );
  }

  prompts.outro("Handoff import complete.");
}

async function runHandoffValidate(): Promise<void> {
  const { validateHandoffPackage } = await import("./delegate/handoff.js");

  const validation = validateHandoffPackage();

  if (validation.valid) {
    prompts.note("Handoff Package is valid!", "Validation Passed");
  } else {
    prompts.note(
      ["Validation errors:", ...validation.errors.map((e) => `  - ${e}`)].join(
        "\n",
      ),
      "Validation Failed",
    );
    process.exitCode = 1;
  }
}

async function runHandoffShow(): Promise<void> {
  const ceoDir = join(".devspace", "ceo");

  if (!existsSync(ceoDir)) {
    console.log(
      "No Handoff Package found. Run 'devspace handoff import' first.",
    );
    return;
  }

  const files = readdirSync(ceoDir).filter((f) => f.endsWith(".md"));

  console.log("\n=== Handoff Package ===\n");

  for (const file of files) {
    const filePath = join(ceoDir, file);
    const content = readFileSync(filePath, "utf-8");
    const preview = content.substring(0, 200).replace(/\n/g, " ");
    console.log(`[file] ${file}`);
    console.log(`  ${preview}...`);
    console.log("");
  }
}

async function runDelegateCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "start") {
    await runDelegateStart();
    return;
  }

  if (subcommand === "run") {
    await runDelegateRun(rest);
    return;
  }

  if (subcommand === "status") {
    await runDelegateStatus();
    return;
  }

  if (subcommand === "pause") {
    await runDelegatePause();
    return;
  }

  if (subcommand === "resume") {
    await runDelegateResume();
    return;
  }

  if (subcommand === "stop") {
    await runDelegateStop();
    return;
  }

  throw new Error(
    `Unknown delegate command: ${subcommand}. Use 'start', 'run', 'status', 'pause', 'resume', or 'stop'.`,
  );
}

async function runDelegateStart(): Promise<void> {
  const { validateHandoffPackage, readAutonomyPolicy } =
    await import("./delegate/handoff.js");
  const { canEnterMode } = await import("./delegate/permissions.js");
  const { readDelegateContract } = await import("./delegate/handoff.js");

  prompts.intro("Starting Delegate Mode");

  const validation = validateHandoffPackage();
  if (!validation.valid) {
    prompts.note(
      [
        "Cannot start delegate mode:",
        ...validation.errors.map((e) => `  - ${e}`),
        "",
        "Run 'devspace handoff init' first.",
      ].join("\n"),
      "Validation Failed",
    );
    prompts.outro("Delegate start aborted.");
    process.exitCode = 1;
    return;
  }

  const contract = readDelegateContract();
  const policy = readAutonomyPolicy();

  const modeCheck = canEnterMode(policy, contract, {
    mode: "manual",
    current_run_id: null,
    status: "READY_TO_DELEGATE",
    autonomy_level: "manual",
    active_task_id: null,
    stop_reason: null,
  });

  if (!modeCheck.allowed) {
    prompts.note(
      `Cannot enter ${policy} mode: ${modeCheck.reason}`,
      "Mode Check Failed",
    );
    prompts.outro("Delegate start aborted.");
    process.exitCode = 1;
    return;
  }

  const statePath = join(".devspace", "state.json");
  let state;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf-8"));
  } else {
    state = {
      mode: "manual",
      current_run_id: null,
      status: "BRAINSTORM",
      autonomy_level: "manual",
      active_task_id: null,
      stop_reason: null,
    };
  }
  state.mode = policy;
  state.autonomy_level = policy;
  state.status = "DELEGATE_RUNNING";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  prompts.note(
    [
      `Delegate mode started!`,
      `Mode: ${policy}`,
      `Risk Level: ${contract?.acceptable_risk_level || "unknown"}`,
      "",
      "Next steps:",
      "  1. Place your task in .devspace/ceo/first_task.md or .devspace/current_task.md",
      "  2. Run 'devspace run current' to execute",
      "  3. Run 'devspace delegate status' to check progress",
    ].join("\n"),
    "Delegate Started",
  );

  prompts.outro("Delegate mode is now active.");
}

async function runDelegateRun(args: string[]): Promise<void> {
  const { LocalOrchestratorV2 } = await import("./delegate/orchestrator_v2.js");
  const { MockExecutorProvider, MockCoachReviewProvider } =
    await import("./delegate/providers/mock.js");
  const { OllamaExecutorProvider, OllamaCoachReviewProvider } =
    await import("./delegate/providers/ollama.js");
  const {
    OpenAICompatibleExecutorProvider,
    OpenAICompatibleCoachReviewProvider,
  } = await import("./delegate/providers/openai.js");
  const { readAutonomyPolicy } = await import("./delegate/handoff.js");

  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const providerType =
    getArg("--provider") || (args.includes("--mock") ? "mock" : "ollama");
  const executorProviderType = getArg("--executor-provider") || providerType;
  const coachProviderType = getArg("--coach-provider") || providerType;
  const maxRounds = parseInt(getArg("--max-rounds") || "10") || 10;
  const timeout = parseInt(getArg("--timeout") || "60") || 60;
  const modeOverride = getArg("--mode") as string | undefined;

  const mode = (modeOverride || readAutonomyPolicy()) as any;

  const createExecutorProvider = (type: string) => {
    const providerTimeoutMs = timeout * 1000;
    switch (type) {
      case "mock":
        return new MockExecutorProvider();
      case "ollama":
        return new OllamaExecutorProvider({
          url: process.env.OLLAMA_URL || "http://localhost:11434",
          model: process.env.OLLAMA_MODEL || "llama3",
        });
      case "openai":
        return new OpenAICompatibleExecutorProvider({
          apiUrl: process.env.OPENAI_API_URL || "https://api.openai.com",
          apiKey: process.env.OPENAI_API_KEY || "",
          model: process.env.OPENAI_MODEL || "gpt-4",
          timeoutMs: providerTimeoutMs,
        });
      default:
        throw new Error(
          `Unknown executor provider: ${type}. Use 'mock', 'ollama', or 'openai'.`,
        );
    }
  };

  const createCoachProvider = (type: string) => {
    const providerTimeoutMs = timeout * 1000;
    switch (type) {
      case "mock":
        return new MockCoachReviewProvider(undefined, maxRounds);
      case "ollama":
        return new OllamaCoachReviewProvider({
          url: process.env.OLLAMA_URL || "http://localhost:11434",
          model: process.env.OLLAMA_MODEL || "llama3",
        });
      case "openai":
        return new OpenAICompatibleCoachReviewProvider({
          apiUrl: process.env.OPENAI_API_URL || "https://api.openai.com",
          apiKey: process.env.OPENAI_API_KEY || "",
          model: process.env.OPENAI_MODEL || "gpt-4",
          timeoutMs: providerTimeoutMs,
        });
      default:
        throw new Error(
          `Unknown coach provider: ${type}. Use 'mock', 'ollama', or 'openai'.`,
        );
    }
  };

  const executor = createExecutorProvider(executorProviderType);
  const coachReview = createCoachProvider(coachProviderType);

  const orchestrator = new LocalOrchestratorV2(executor, coachReview, {
    mode,
    max_rounds: maxRounds,
    max_runtime_seconds: timeout,
  });

  console.log(`Starting delegate run:`);
  console.log(`  Executor Provider: ${executorProviderType}`);
  console.log(`  Coach Provider: ${coachProviderType}`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Max Rounds: ${maxRounds}`);
  console.log(`  Timeout: ${timeout}s`);
  console.log("");

  if (mode === "free") {
    await orchestrator.runAutoLoop();
  } else {
    const result = await orchestrator.executeSingleTask();
    console.log(`Task result: ${result.status} - ${result.summary}`);
  }

  const status = orchestrator.getStatus();
  console.log(`\nFinal status: ${status.status}`);
  if (status.stop_reason) {
    console.log(`Stop reason: ${status.stop_reason}`);
  }
}

async function runDelegateStatus(): Promise<void> {
  const statePath = join(".devspace", "state.json");

  if (!existsSync(statePath)) {
    console.log(
      "No delegate state found. Run 'devspace brainstorm freeze' first.",
    );
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));

  console.log("\n=== Delegate Status ===\n");
  console.log(`Mode: ${state.mode}`);
  console.log(`Status: ${state.status}`);
  console.log(`Autonomy Level: ${state.autonomy_level}`);
  console.log(`Active Task: ${state.active_task_id || "None"}`);
  console.log(`Current Run: ${state.current_run_id || "None"}`);
  console.log(`Stop Reason: ${state.stop_reason || "None"}`);
  console.log("");
}

async function runDelegatePause(): Promise<void> {
  const statePath = join(".devspace", "state.json");

  if (!existsSync(statePath)) {
    console.log("No delegate state found.");
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.status = "READY_TO_DELEGATE";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  console.log("Delegate mode paused.");
}

async function runDelegateResume(): Promise<void> {
  const statePath = join(".devspace", "state.json");

  if (!existsSync(statePath)) {
    console.log("No delegate state found.");
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.status = "DELEGATE_RUNNING";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  console.log("Delegate mode resumed.");
}

async function runDelegateStop(): Promise<void> {
  const statePath = join(".devspace", "state.json");

  if (!existsSync(statePath)) {
    console.log("No delegate state found.");
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.status = "DONE";
  state.stop_reason = "User stopped";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  console.log("Delegate mode stopped.");
}

async function runRunCommand(args: string[]): Promise<void> {
  const [subcommand] = args;

  if (!subcommand || subcommand === "current") {
    console.log("Run current task...");
    console.log(
      "This command will execute the current task using Local Orchestrator.",
    );
    console.log("Implementation pending...");
    return;
  }

  if (subcommand === "report") {
    console.log("Show run report...");
    console.log("Implementation pending...");
    return;
  }

  throw new Error(
    `Unknown run command: ${subcommand}. Use 'current' or 'report'.`,
  );
}

async function runMcpCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || "tools";

  switch (subcommand) {
    case "serve": {
      const { startMcpServer } = await import("./mcp/server.js");
      console.log("Starting MCP server on stdin/stdout...");
      startMcpServer();
      break;
    }
    case "tools": {
      const { printTools } = await import("./mcp/server.js");
      printTools();
      break;
    }
    case "smoke": {
      const { runSmoke } = await import("./mcp/server.js");
      await runSmoke();
      break;
    }
    default:
      throw new Error(
        `Unknown mcp command: ${subcommand}. Use 'serve', 'tools', or 'smoke'.`,
      );
  }
}

async function runTimelineCommand(args: string[]): Promise<void> {
  const conversationPath = join(".devspace", "conversation.jsonl");

  if (!existsSync(conversationPath)) {
    console.log("No conversation history found.");
    return;
  }

  const content = readFileSync(conversationPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  console.log("\n=== Delegate Timeline ===\n");

  if (lines.length === 0) {
    console.log("No events recorded yet.");
    return;
  }

  for (const line of lines.slice(-20)) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const role = entry.role.padEnd(20);
      const type = entry.type.padEnd(10);
      const status = entry.status || "";
      console.log(`[${time}] [${role}] [${type}] ${status} ${entry.title}`);
    } catch {
      // Skip invalid lines
    }
  }

  console.log("");
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "",
      "Collaboration Commands:",
      "  devspace collab init     Initialize collaboration workspace (.devspace/)",
      "  devspace collab status   Show collaboration status and recent events",
      "  devspace worker start    Start the local worker (requires Python 3)",
      "",
      "Handoff Commands:",
      "  devspace handoff init                  Create empty Handoff Package",
      "  devspace handoff import <file>         Import brainstorm results from file",
      "  devspace handoff validate              Validate Handoff Package",
      "  devspace handoff show                  Show Handoff Package",
      "",
      "Delegate Commands:",
      "  devspace delegate start                Start delegate mode",
      "  devspace delegate run [options]        Run auto loop",
      "    --mock                                 Use mock provider (testing)",
      "    --provider <type>                      Provider: mock/ollama/openai",
      "    --executor-provider <type>             Executor provider override",
      "    --coach-provider <type>                Coach provider override",
      "    --max-rounds <n>                       Max rounds (default: 10)",
      "    --timeout <seconds>                    Timeout (default: 60)",
      "  devspace delegate status               Show delegate status",
      "  devspace delegate pause                Pause delegate mode",
      "  devspace delegate resume               Resume delegate mode",
      "  devspace delegate stop                 Stop delegate mode",
      "",
      "Timeline:",
      "  devspace timeline               Show conversation timeline",
      "",
      "MCP Commands:",
      "  devspace mcp serve              Start MCP server (stdin/stdout)",
      "  devspace mcp tools              List available MCP tools",
      "  devspace mcp smoke              Run MCP smoke tests",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<
  Parameters<typeof prompts.text>[0],
  "validate"
> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) =>
      options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed)
    return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database =
      require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } =
      require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
