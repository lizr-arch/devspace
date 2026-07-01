import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  generateReport,
  parseReport,
  type ReportStatus,
} from "./collaboration/report_generator.js";
import { parseTask } from "./collaboration/task_parser.js";
import { readAutonomyPolicy } from "./delegate/handoff.js";
import { LocalOrchestratorV2 } from "./delegate/orchestrator_v2.js";
import {
  MockCoachReviewProvider,
  MockExecutorProvider,
} from "./delegate/providers/mock.js";
import {
  OllamaCoachReviewProvider,
  OllamaExecutorProvider,
} from "./delegate/providers/ollama.js";
import {
  OpenAICompatibleCoachReviewProvider,
  OpenAICompatibleExecutorProvider,
} from "./delegate/providers/openai.js";
import type {
  CoachReviewProvider,
  ExecutorProvider,
} from "./delegate/providers/types.js";
import type { GlobalState, VerdictType } from "./delegate/schemas.js";

const DEVSPACE_DIR = ".devspace";
const RUNS_DIR = join(DEVSPACE_DIR, "runs");

interface RunCurrentOptions {
  provider: string;
  executorProvider: string;
  coachProvider: string;
  maxRounds: number;
  timeoutSeconds: number;
  mode: string;
}

interface LocalReportSnapshot {
  status: VerdictType | null;
  summary: string;
  filesChanged: string[];
  testResults: string;
  errors: string[];
  raw: string | null;
}

export async function runCurrentTaskCommand(args: string[]): Promise<void> {
  const options = parseRunCurrentArgs(args);
  const taskPath = findCurrentTaskPath();
  if (!taskPath) {
    throw new Error(
      "No current task found. Create .devspace/current_task.md or .devspace/ceo/first_task.md first.",
    );
  }

  const taskContent = readFileSync(taskPath, "utf-8");
  const task = parseTask(taskContent);
  const startedAt = new Date();
  const executor = createExecutorProvider(
    options.executorProvider,
    options.timeoutSeconds,
  );
  const coachReview = createCoachProvider(
    options.coachProvider,
    options.maxRounds,
    options.timeoutSeconds,
  );

  const orchestrator = new LocalOrchestratorV2(executor, coachReview, {
    mode: normalizeMode(options.mode),
    max_rounds: options.maxRounds,
    max_runtime_seconds: options.timeoutSeconds,
  });

  await orchestrator.runAutoLoop();

  const endedAt = new Date();
  const state = orchestrator.getStatus();
  const reportPath = join(DEVSPACE_DIR, "execution_report.md");
  mkdirSync(DEVSPACE_DIR, { recursive: true });

  const localReport = loadLocalReportSnapshot(state.current_run_id);
  const modifiedFiles = fallbackIfEmpty(
    safeGitOutput(["diff", "--stat"])?.trim(),
    localReport.filesChanged.length > 0
      ? localReport.filesChanged.join("\n")
      : "No tracked file changes captured.",
  );
  const gitDiff = fallbackIfEmpty(
    safeGitOutput(["diff", "--"])?.trim(),
    localReport.filesChanged.length > 0
      ? [
          "Git diff unavailable or empty.",
          "",
          "Executor reported changed files:",
          ...localReport.filesChanged.map((file) => `- ${file}`),
        ].join("\n")
      : "Git diff unavailable or empty.",
  );

  const report = generateReport({
    status: mapReportStatus(localReport.status, state.status),
    taskId: task.id || task.title,
    startTime: startedAt.toISOString(),
    endTime: endedAt.toISOString(),
    duration: formatDuration(endedAt.getTime() - startedAt.getTime()),
    modifiedFiles,
    testResults: localReport.testResults || "No test results recorded.",
    gitDiff,
    problems: summarizeProblems(localReport, state),
    incompleteParts: summarizeIncompleteParts(localReport, state),
    suggestedNextSteps: summarizeNextSteps(state),
    notes: [
      `Task source: ${taskPath}`,
      `Run ID: ${state.current_run_id ?? "not created"}`,
      `Mode: ${normalizeMode(options.mode)}`,
      `Executor Provider: ${options.executorProvider}`,
      `Coach Provider: ${options.coachProvider}`,
      localReport.summary ? `Summary: ${localReport.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  writeFileSync(reportPath, report, "utf-8");

  console.log(`Current task executed: ${task.id || task.title}`);
  console.log(`Status: ${state.status}`);
  console.log(`Run ID: ${state.current_run_id ?? "n/a"}`);
  console.log(`Execution report: ${reportPath}`);
}

export function runReportCommand(): void {
  const executionReportPath = join(DEVSPACE_DIR, "execution_report.md");
  const state = readGlobalState();
  const latestRunId = findLatestRunId();

  if (!existsSync(executionReportPath) && !latestRunId) {
    throw new Error(
      "No run report found. Run `devspace run current` first.",
    );
  }

  const parsedReport = existsSync(executionReportPath)
    ? parseReport(readFileSync(executionReportPath, "utf-8"))
    : null;

  console.log("=== DevSpace Run Report ===");
  console.log("");
  console.log(`Latest Run: ${latestRunId ?? "n/a"}`);
  console.log(`State: ${state?.status ?? "unknown"}`);

  if (parsedReport) {
    console.log(`Task ID: ${parsedReport.taskId || "n/a"}`);
    console.log(`Report Status: ${parsedReport.status}`);
    console.log(`Duration: ${parsedReport.duration || "n/a"}`);
  }

  console.log(`Execution Report: ${executionReportPath}`);

  if (latestRunId) {
    const artifactPaths = listExistingArtifactPaths(latestRunId);
    if (artifactPaths.length > 0) {
      console.log("Artifacts:");
      for (const artifactPath of artifactPaths) {
        console.log(`  - ${artifactPath}`);
      }
    }
  }
}

function parseRunCurrentArgs(args: string[]): RunCurrentOptions {
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const provider = getArg("--provider") || "mock";
  const mode = getArg("--mode") || readAutonomyPolicy();

  return {
    provider,
    executorProvider: getArg("--executor-provider") || provider,
    coachProvider: getArg("--coach-provider") || provider,
    maxRounds: parsePositiveInteger(getArg("--max-rounds"), 1),
    timeoutSeconds: parsePositiveInteger(getArg("--timeout"), 60),
    mode,
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeMode(mode: string): "manual" | "guided" | "delegate" | "free" {
  if (mode === "manual" || mode === "guided" || mode === "free") return mode;
  return "delegate";
}

function createExecutorProvider(
  type: string,
  timeoutSeconds: number,
): ExecutorProvider {
  const timeoutMs = timeoutSeconds * 1000;
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
        timeoutMs,
      });
    default:
      throw new Error(
        `Unknown executor provider: ${type}. Use 'mock', 'ollama', or 'openai'.`,
      );
  }
}

function createCoachProvider(
  type: string,
  maxRounds: number,
  timeoutSeconds: number,
): CoachReviewProvider {
  const timeoutMs = timeoutSeconds * 1000;
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
        timeoutMs,
      });
    default:
      throw new Error(
        `Unknown coach provider: ${type}. Use 'mock', 'ollama', or 'openai'.`,
      );
  }
}

function findCurrentTaskPath(): string | null {
  const currentTaskPath = join(DEVSPACE_DIR, "current_task.md");
  if (existsSync(currentTaskPath)) return currentTaskPath;

  const firstTaskPath = join(DEVSPACE_DIR, "ceo", "first_task.md");
  if (existsSync(firstTaskPath)) return firstTaskPath;

  return null;
}

function loadLocalReportSnapshot(runId: string | null): LocalReportSnapshot {
  if (!runId) {
    return {
      status: null,
      summary: "",
      filesChanged: [],
      testResults: "",
      errors: ["No run ID recorded."],
      raw: null,
    };
  }

  const localReportPath = join(RUNS_DIR, runId, "local_report.md");
  if (!existsSync(localReportPath)) {
    return {
      status: null,
      summary: "",
      filesChanged: [],
      testResults: "",
      errors: [`Missing ${localReportPath}`],
      raw: null,
    };
  }

  const raw = readFileSync(localReportPath, "utf-8");
  const filesChanged = sectionLines(raw, "Files Changed")
    .map((line) => line.replace(/^- /, "").trim())
    .filter((line) => line && line !== "None");
  const errors = sectionLines(raw, "Errors")
    .map((line) => line.replace(/^- /, "").trim())
    .filter((line) => line && line !== "None");
  const status = sectionValue(raw, "Status") as VerdictType | null;

  return {
    status,
    summary: sectionValue(raw, "Summary"),
    filesChanged,
    testResults: sectionValue(raw, "Test Results"),
    errors,
    raw,
  };
}

function readGlobalState(): GlobalState | null {
  const statePath = join(DEVSPACE_DIR, "state.json");
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as GlobalState;
  } catch {
    return null;
  }
}

function findLatestRunId(): string | null {
  if (!existsSync(RUNS_DIR)) return null;

  const runIds = readdirSync(RUNS_DIR).filter((entry) =>
    existsSync(join(RUNS_DIR, entry, "run_state.json")),
  );
  if (runIds.length === 0) return null;

  runIds.sort((left, right) => {
    const leftTime = statSync(join(RUNS_DIR, left, "run_state.json")).mtimeMs;
    const rightTime = statSync(join(RUNS_DIR, right, "run_state.json")).mtimeMs;
    return leftTime - rightTime;
  });

  return runIds.at(-1) ?? null;
}

function listExistingArtifactPaths(runId: string): string[] {
  const artifactNames = [
    "run_state.json",
    "local_report.md",
    "coach_review.md",
    "next_task.md",
    "final_report.md",
    "blocked_report.md",
    "budget_stop_report.md",
    "user_question.md",
  ];

  return artifactNames
    .map((name) => join(RUNS_DIR, runId, name))
    .filter((artifactPath) => existsSync(artifactPath));
}

function sectionValue(content: string, heading: string): string {
  const match = content.match(
    new RegExp(`## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  return match?.[1]?.trim() || "";
}

function sectionLines(content: string, heading: string): string[] {
  const value = sectionValue(content, heading);
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeGitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fallbackIfEmpty(value: string | null | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

function mapReportStatus(
  verdict: VerdictType | null,
  stateStatus: GlobalState["status"],
): ReportStatus {
  if (verdict === "PASS" || verdict === "PASS_WITH_WARNINGS" || verdict === "DONE") {
    return "已完成";
  }

  if (verdict === "NEED_USER" || stateStatus === "NEED_USER") {
    return "部分完成";
  }

  if (verdict === "BUDGET_STOP" || stateStatus === "BUDGET_STOP") {
    return "部分完成";
  }

  if (verdict === "BLOCKED" || stateStatus === "BLOCKED") {
    return "部分完成";
  }

  if (verdict === "SAFETY_STOP" || verdict === "NEEDS_FIX") {
    return "失败";
  }

  if (stateStatus === "DONE") {
    return "已完成";
  }

  return "部分完成";
}

function summarizeProblems(
  localReport: LocalReportSnapshot,
  state: GlobalState,
): string[] {
  const problems = [...localReport.errors];
  if (state.stop_reason) {
    problems.push(state.stop_reason);
  }
  return problems.length > 0 ? problems : ["无"];
}

function summarizeIncompleteParts(
  localReport: LocalReportSnapshot,
  state: GlobalState,
): string[] {
  if (state.status === "DONE") return ["无"];
  if (state.status === "NEED_USER") {
    return ["等待用户决策后继续执行。"];
  }
  if (state.status === "BLOCKED") {
    return [state.stop_reason || "存在阻塞问题，尚未继续。"];
  }
  if (state.status === "BUDGET_STOP") {
    return [state.stop_reason || "达到预算停止条件。"];
  }
  if (localReport.errors.length > 0) {
    return localReport.errors;
  }
  return ["仍需人工确认最终结果。"];
}

function summarizeNextSteps(state: GlobalState): string[] {
  if (state.status === "DONE") {
    return ["查看 .devspace/execution_report.md 和最新 run artifact。"];
  }
  if (state.status === "NEED_USER") {
    return ["补充用户决策后重新运行 `devspace run current`。"];
  }
  if (state.status === "BLOCKED") {
    return ["先解决阻塞问题，再重新运行 `devspace run current`。"];
  }
  if (state.status === "BUDGET_STOP") {
    return ["提高预算或缩小任务范围后重新运行。"];
  }
  return ["查看最新报告并决定是否继续下一轮。"];
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
}
