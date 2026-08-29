import {
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  statSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import {
  CEO_DIR,
  safePath,
  safeRead,
  readJsonSafe,
  verifyRunToken,
} from "./handlers-common.js";
import {
  handlePreviewDelegateRun,
  handleStartDelegateRun,
  handlePauseDelegateRun,
  handleResumeDelegateRun,
  handleStopDelegateRun,
  handleAnswerNeedUser,
  handleRecoverStaleLock,
} from "./handlers-runs.js";
import {
  handleCreateHandoffFromWebgpt,
  handleSubmitCoachReview,
  handleCreateNextTask,
  handleApproveNextRun,
  handleStartGatedLoop,
  handleGetGatedLoopStatus,
  handleRunOrchestratorStep,
} from "./handlers-workflow.js";

export {
  handlePreviewDelegateRun,
  handleStartDelegateRun,
  handlePauseDelegateRun,
  handleResumeDelegateRun,
  handleStopDelegateRun,
  handleAnswerNeedUser,
  handleRecoverStaleLock,
} from "./handlers-runs.js";

export {
  handleCreateHandoffFromWebgpt,
  handleSubmitCoachReview,
  handleCreateNextTask,
  handleApproveNextRun,
  handleStartGatedLoop,
  handleGetGatedLoopStatus,
  handleRunOrchestratorStep,
} from "./handlers-workflow.js";

// ===== Read-only handlers =====

export function handleGetDelegateStatus(): unknown {
  const result = readJsonSafe("state.json");
  if (!result.ok) {
    return {
      mode: null,
      current_run_id: null,
      status: "NO_STATE",
      autonomy_level: null,
      active_task_id: null,
      stop_reason: null,
    };
  }
  return result.data;
}

export function handleReadDelegateTimeline(args: { limit?: number }): unknown {
  const safe = safePath("conversation.jsonl");
  if (!safe || !existsSync(safe))
    return { error: "No conversation history", entries: [] };

  const limit = args.limit || 50;

  try {
    const stat = statSync(safe);
    const maxBytes = Math.min(stat.size, limit * 2000); // ~2KB per entry estimate
    const startPos = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(maxBytes);
    const fd = openSync(safe, "r");
    readSync(fd, buf, 0, maxBytes, startPos);
    closeSync(fd);

    const content = buf.toString("utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());
    const lines = startPos > 0 ? allLines.slice(1) : allLines;
    const entries = lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line.substring(0, 200) };
      }
    });

    return {
      entries,
      total_estimate: stat.size > maxBytes ? `>${lines.length}` : lines.length,
    };
  } catch (e) {
    return {
      error: `Read error: ${e instanceof Error ? e.message : String(e)}`,
      entries: [],
    };
  }
}

export function handleReadCurrentTask(): unknown {
  const current = safeRead("current_task.md");
  if (current.ok)
    return { source: "current_task.md", content: current.content };
  const first = safeRead("ceo/first_task.md");
  if (first.ok) return { source: "ceo/first_task.md", content: first.content };
  return { error: "No task file found", source: null, content: null };
}

export function handleReadHandoffSummary(): unknown {
  const files = [
    "ceo/delegate_contract.md",
    "ceo/stop_conditions.md",
    "ceo/autonomy_policy.md",
    "ceo/first_task.md",
  ];
  const summary: Record<string, string | null> = {};
  for (const f of files) {
    const result = safeRead(f);
    summary[f] = result.ok ? result.content!.substring(0, 500) : null;
  }
  return { files: summary };
}

export function handleReadRunArtifacts(args: { run_id: string }): unknown {
  if (!args.run_id) return { error: "run_id required" };
  const runDir = join("runs", args.run_id);
  const safe = safePath(runDir);
  if (!safe) return { error: "Invalid run_id (path traversal)" };
  if (!existsSync(safe)) return { error: `Run not found: ${args.run_id}` };

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

  const artifacts: Record<string, string | null> = {};
  for (const name of artifactNames) {
    const result = safeRead(join(runDir, name));
    artifacts[name] = result.ok ? result.content! : null;
  }
  return { run_id: args.run_id, artifacts };
}

export async function handleValidateHandoff(): Promise<unknown> {
  try {
    const { validateHandoffPackage } = await import("../delegate/handoff.js");
    const result = validateHandoffPackage();
    return result;
  } catch {
    const contractPath = join(CEO_DIR, "delegate_contract.md");
    const stopPath = join(CEO_DIR, "stop_conditions.md");
    const errors: string[] = [];
    if (!existsSync(contractPath)) errors.push("Missing delegate_contract.md");
    if (!existsSync(stopPath)) errors.push("Missing stop_conditions.md");
    return { valid: errors.length === 0, errors, warnings: [] };
  }
}

export function handleListRuns(): unknown {
  const safe = safePath("runs");
  if (!safe || !existsSync(safe)) return { runs: [] };
  try {
    const dirs = readdirSync(safe, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .slice(-20)
      .map((d) => {
        const runState = readJsonSafe(join("runs", d.name, "run_state.json"));
        return {
          run_id: d.name,
          state: runState.ok ? runState.data : null,
        };
      });
    return { runs: dirs };
  } catch {
    return { runs: [] };
  }
}

// ===== Dispatch =====

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "get_delegate_status":
      return handleGetDelegateStatus();
    case "read_delegate_timeline":
      return handleReadDelegateTimeline(args as { limit?: number });
    case "read_current_task":
      return handleReadCurrentTask();
    case "read_handoff_summary":
      return handleReadHandoffSummary();
    case "read_run_artifacts":
      return handleReadRunArtifacts(args as { run_id: string });
    case "validate_handoff":
      return await handleValidateHandoff();
    case "list_runs":
      return handleListRuns();
    case "preview_delegate_run":
      return handlePreviewDelegateRun(args as any);
    case "start_delegate_run":
      return handleStartDelegateRun(args as any);
    case "pause_delegate_run":
      return handlePauseDelegateRun(args as any);
    case "resume_delegate_run":
      return handleResumeDelegateRun(args as any);
    case "stop_delegate_run":
      return handleStopDelegateRun(args as any);
    case "answer_need_user":
      return handleAnswerNeedUser(args as { answer: string; decision: string });
    case "create_handoff_from_webgpt":
      return handleCreateHandoffFromWebgpt(args as any);
    case "submit_coach_review":
      return handleSubmitCoachReview(args as any);
    case "create_next_task":
      return handleCreateNextTask(args as any);
    case "approve_next_run":
      return handleApproveNextRun(args as any);
    case "start_gated_loop":
      return handleStartGatedLoop(args as any);
    case "get_gated_loop_status":
      return handleGetGatedLoopStatus();
    case "recover_stale_lock":
      return handleRecoverStaleLock(
        args as {
          ttl_seconds?: number;
          force?: boolean;
          allow_force_recovery?: boolean;
        },
      );
    case "verify_run_token":
      return verifyRunToken(args as { run_token: string });
    case "run_orchestrator_step":
      return await handleRunOrchestratorStep(args as any);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
