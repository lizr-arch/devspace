import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import * as prompts from "@clack/prompts";
import { runCurrentTaskCommand, runReportCommand } from "./run-commands.js";

export async function runHandoffCommand(args: string[]): Promise<void> {
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

export async function runHandoffInit(): Promise<void> {
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

export async function runHandoffImport(filePath?: string): Promise<void> {
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

export async function runHandoffValidate(): Promise<void> {
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

export async function runHandoffShow(): Promise<void> {
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

export async function runDelegateCommand(args: string[]): Promise<void> {
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

export async function runDelegateStart(): Promise<void> {
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

export async function runDelegateRun(args: string[]): Promise<void> {
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

export async function runDelegateStatus(): Promise<void> {
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

export async function runDelegatePause(): Promise<void> {
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

export async function runDelegateResume(): Promise<void> {
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

export async function runDelegateStop(): Promise<void> {
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

export async function runRunCommand(args: string[]): Promise<void> {
  const [subcommand] = args;

  if (!subcommand || subcommand === "current") {
    await runCurrentTaskCommand(args.slice(1));
    return;
  }

  if (subcommand === "report") {
    runReportCommand();
    return;
  }

  throw new Error(
    `Unknown run command: ${subcommand}. Use 'current' or 'report'.`,
  );
}

export async function runMcpCommand(args: string[]): Promise<void> {
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

export async function runTimelineCommand(_args: string[]): Promise<void> {
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
