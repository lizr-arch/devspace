import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";

import {
  DELEGATE_DIR,
  CEO_DIR,
  RUNS_DIR,
  APPROVALS_DIR,
  MAX_HANDOFF,
  MAX_REVIEW,
  MAX_TASK,
  checkSize,
  safePath,
  safeRead,
  readJsonSafe,
  verifyRunToken,
} from "./handlers-common.js";
import {
  acquireRunLock,
  getRunLock,
} from "./handlers-runs.js";

export function handleCreateHandoffFromWebgpt(args: {
  contract_md?: string;
  stop_conditions_md?: string;
  autonomy_policy_md?: string;
  first_task_md?: string;
}): unknown {
  if (!args.contract_md && !args.stop_conditions_md && !args.first_task_md) {
    return {
      error:
        "At least one of contract_md, stop_conditions_md, or first_task_md required",
      status: "REJECTED",
    };
  }

  const sizeErr =
    checkSize(args.contract_md, MAX_HANDOFF, "contract_md") ||
    checkSize(args.stop_conditions_md, MAX_HANDOFF, "stop_conditions_md") ||
    checkSize(args.autonomy_policy_md, MAX_HANDOFF, "autonomy_policy_md") ||
    checkSize(args.first_task_md, MAX_TASK, "first_task_md");
  if (sizeErr) return { error: sizeErr, status: "REJECTED" };

  if (!existsSync(CEO_DIR)) mkdirSync(CEO_DIR, { recursive: true });

  const files: string[] = [];
  if (args.contract_md) {
    writeFileSync(
      join(CEO_DIR, "delegate_contract.md"),
      args.contract_md,
      "utf-8",
    );
    files.push("delegate_contract.md");
  }
  if (args.stop_conditions_md) {
    writeFileSync(
      join(CEO_DIR, "stop_conditions.md"),
      args.stop_conditions_md,
      "utf-8",
    );
    files.push("stop_conditions.md");
  }
  if (args.autonomy_policy_md) {
    writeFileSync(
      join(CEO_DIR, "autonomy_policy.md"),
      args.autonomy_policy_md,
      "utf-8",
    );
    files.push("autonomy_policy.md");
  }
  if (args.first_task_md) {
    writeFileSync(join(CEO_DIR, "first_task.md"), args.first_task_md, "utf-8");
    files.push("first_task.md");
  }

  const contractExists = existsSync(join(CEO_DIR, "delegate_contract.md"));
  const stopExists = existsSync(join(CEO_DIR, "stop_conditions.md"));
  const errors: string[] = [];
  if (!contractExists) errors.push("Missing delegate_contract.md");
  if (!stopExists) errors.push("Missing stop_conditions.md");

  if (errors.length > 0) {
    return { status: "INVALID", errors, files_written: files };
  }

  return { status: "OK", files_written: files };
}

export function handleSubmitCoachReview(args: {
  verdict: string;
  reasoning_summary?: string;
  next_task_content?: string;
  blocking_issues?: string[];
  non_blocking_issues?: string[];
  run_token?: string;
}): unknown {
  if (!args.verdict) {
    return { error: "verdict is required", status: "REJECTED" };
  }

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
  if (!validVerdicts.includes(args.verdict)) {
    return {
      error: `Invalid verdict. Must be: ${validVerdicts.join(", ")}`,
      status: "REJECTED",
    };
  }

  if (args.verdict === "PASS" && !args.next_task_content) {
    return {
      error: "PASS verdict requires next_task_content",
      status: "REJECTED",
    };
  }

  const reviewSizeErr =
    checkSize(args.reasoning_summary, MAX_REVIEW, "reasoning_summary") ||
    checkSize(args.next_task_content, MAX_TASK, "next_task_content");
  if (reviewSizeErr) return { error: reviewSizeErr, status: "REJECTED" };

  const stateResult = readJsonSafe("state.json");
  const runId =
    stateResult.ok && stateResult.data
      ? (stateResult.data as any).current_run_id
      : null;
  let reviewId: string | null = null;

  if (runId) {
    const runDir = join(RUNS_DIR, runId);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const lockPath = join(DELEGATE_DIR, "run.lock");
    if (!existsSync(lockPath)) {
      return {
        error: "Run token expired. Run was stopped.",
        status: "REJECTED",
      };
    }
    let lockData: Record<string, unknown> = {};
    try {
      lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    } catch {
      return {
        error: "Run token expired. Run was stopped.",
        status: "REJECTED",
      };
    }
    const storedHash = lockData.run_token_hash as string | undefined;
    if (storedHash && args.run_token) {
      const providedHash = createHash("sha256")
        .update(args.run_token)
        .digest("hex")
        .substring(0, 16);
      if (providedHash !== storedHash) {
        return { error: "Invalid run_token", status: "REJECTED" };
      }
    } else if (storedHash && !args.run_token) {
      return { error: "Invalid run_token", status: "REJECTED" };
    }

    if (args.verdict === "DONE") {
      const report = `# Final Report\n\n## Verdict\nDONE\n\n## Reasoning\n${args.reasoning_summary || "Completed"}\n\n## Generated At\n${new Date().toISOString()}\n`;
      writeFileSync(join(runDir, "final_report.md"), report, "utf-8");
    } else if (args.verdict === "BLOCKED") {
      const report = `# Blocked Report\n\n## Verdict\nBLOCKED\n\n## Reasoning\n${args.reasoning_summary || "Blocked"}\n\n## Blocking Issues\n${(args.blocking_issues || []).map((i) => `- ${i}`).join("\n") || "- None"}\n\n## Generated At\n${new Date().toISOString()}\n`;
      writeFileSync(join(runDir, "blocked_report.md"), report, "utf-8");
    } else if (args.verdict === "NEED_USER") {
      const report = `# User Question\n\n## Reason\n${args.reasoning_summary || "Decision needed"}\n\n## Generated At\n${new Date().toISOString()}\n`;
      writeFileSync(join(runDir, "user_question.md"), report, "utf-8");
    }

    reviewId = randomUUID();
    const reviewMeta = {
      review_id: reviewId,
      run_id: runId,
      created_at: new Date().toISOString(),
      verdict: args.verdict,
      task_hash: createHash("sha256")
        .update(args.next_task_content || "")
        .digest("hex")
        .substring(0, 16),
    };
    writeFileSync(
      join(runDir, "review_meta.json"),
      JSON.stringify(reviewMeta, null, 2),
      "utf-8",
    );
  }

  if (args.next_task_content) {
    writeFileSync(
      join(DELEGATE_DIR, "next_task_pending.md"),
      args.next_task_content,
      "utf-8",
    );
  }

  return {
    status: "OK",
    verdict: args.verdict,
    run_id: runId,
    review_id: reviewId,
  };
}

export function handleCreateNextTask(args: {
  task_content: string;
  source?: string;
  review_id?: string;
}): unknown {
  if (!args.task_content) {
    return { error: "task_content is required", status: "REJECTED" };
  }

  const taskSizeErr = checkSize(args.task_content, MAX_TASK, "task_content");
  if (taskSizeErr) return { error: taskSizeErr, status: "REJECTED" };

  const stateResult = readJsonSafe("state.json");
  const hasActiveRun =
    stateResult.ok &&
    stateResult.data &&
    (stateResult.data as any).current_run_id;

  if (!hasActiveRun && args.source !== "user_approved") {
    return {
      error:
        "No active run. Only user_approved tasks can be created without an active run.",
      status: "REJECTED",
    };
  }

  if (!args.review_id && args.source !== "user_approved") {
    return { error: "review_id required", status: "REJECTED" };
  }

  if (args.review_id && hasActiveRun) {
    const runId = (stateResult.data as any).current_run_id as string;
    const reviewMetaPath = join("runs", runId, "review_meta.json");
    const metaResult = readJsonSafe(reviewMetaPath);
    if (!metaResult.ok) {
      return {
        error: "review_meta.json not found for active run",
        status: "REJECTED",
      };
    }
    const meta = metaResult.data as Record<string, unknown>;
    if (meta.review_id !== args.review_id) {
      return { error: "review_id mismatch", status: "REJECTED" };
    }
    const taskHash = createHash("sha256")
      .update(args.task_content)
      .digest("hex")
      .substring(0, 16);
    if (meta.task_hash && meta.task_hash !== taskHash) {
      return { error: "task_hash mismatch with review", status: "REJECTED" };
    }
  }

  writeFileSync(
    join(DELEGATE_DIR, "current_task.md"),
    args.task_content,
    "utf-8",
  );

  const pendingPath = join(DELEGATE_DIR, "next_task_pending.md");
  if (existsSync(pendingPath)) {
    try {
      unlinkSync(pendingPath);
    } catch {
      /* ignore */
    }
  }

  return {
    status: "OK",
    file: "current_task.md",
    review_id: args.review_id || null,
  };
}

export function handleApproveNextRun(args: {
  run_id?: string;
  task_hash?: string;
  provider?: string;
  mode?: string;
  max_rounds?: number;
  timeout?: number;
  scope?: string;
  approved_by?: string;
  approval_reason?: string;
}): unknown {
  const taskResult = safeRead("current_task.md");
  const taskContent = taskResult.ok ? taskResult.content! : "";
  const taskHash = createHash("sha256")
    .update(taskContent)
    .digest("hex")
    .substring(0, 16);

  if (args.task_hash && args.task_hash !== taskHash) {
    return {
      error: "Task has changed since approval. Re-approve.",
      status: "REJECTED",
      current_hash: taskHash,
    };
  }

  if (!existsSync(APPROVALS_DIR)) mkdirSync(APPROVALS_DIR, { recursive: true });

  const approval = {
    approval_id: randomUUID(),
    created_at: new Date().toISOString(),
    used: false,
    used_at: null,
    task_hash: taskHash,
    provider: args.provider || "mock",
    mode: args.mode || "delegate",
    max_rounds: args.max_rounds ?? 1,
    timeout: args.timeout ?? 30,
    scope: args.scope || "any",
    approved_by: args.approved_by || "user",
    approval_reason: args.approval_reason || "",
  };

  const approvalPath = join(APPROVALS_DIR, `approval_${taskHash}.json`);
  writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf-8");

  return {
    status: "OK",
    approval_id: approval.approval_id,
    task_hash: taskHash,
  };
}

export function handleStartGatedLoop(args: {
  provider?: string;
  max_rounds?: number;
  timeout?: number;
  mode?: string;
  allow_free_mode?: boolean;
  allow_real_provider?: boolean;
  allow_real_free_mode?: boolean;
}): unknown {
  const provider = args.provider || "mock";
  const maxRounds = args.max_rounds || 1;
  const timeout = args.timeout || 30;
  const mode = args.mode || "delegate";

  if (mode === "free" && !args.allow_free_mode) {
    return {
      error: "Free mode requires allow_free_mode: true",
      status: "REJECTED",
    };
  }

  const isReal = provider === "ollama" || provider === "openai";
  if (isReal && !args.allow_real_provider) {
    return {
      error: `Real provider '${provider}' requires allow_real_provider: true`,
      status: "REJECTED",
    };
  }

  if (mode === "free" && isReal && !args.allow_real_free_mode) {
    return {
      error: "Real provider + free mode requires allow_real_free_mode: true",
      status: "REJECTED",
    };
  }

  if (isReal && maxRounds > 2) {
    return { error: "Real provider max_rounds cap: 2", status: "REJECTED" };
  }
  if (isReal && timeout > 30) {
    return { error: "Real provider timeout cap: 30s", status: "REJECTED" };
  }
  if (mode === "free" && isReal && maxRounds !== 1) {
    return {
      error: "Real provider + free mode requires max_rounds: 1",
      status: "REJECTED",
    };
  }

  if (!existsSync(join(CEO_DIR, "delegate_contract.md"))) {
    return { error: "Missing delegate_contract.md", status: "REJECTED" };
  }
  if (!existsSync(join(CEO_DIR, "stop_conditions.md"))) {
    return { error: "Missing stop_conditions.md", status: "REJECTED" };
  }

  if (isReal || maxRounds > 1) {
    const taskResult = safeRead("current_task.md");
    const taskContent = taskResult.ok ? taskResult.content! : "";
    const taskHash = createHash("sha256")
      .update(taskContent)
      .digest("hex")
      .substring(0, 16);
    const approvalsDir = join(DELEGATE_DIR, "approvals");
    const approvalPath = join(approvalsDir, `approval_${taskHash}.json`);
    if (!existsSync(approvalPath)) {
      return {
        error: "Real provider requires approval. Call approve_next_run first.",
        status: "REJECTED",
      };
    }
    const approval = JSON.parse(readFileSync(approvalPath, "utf-8"));
    if (approval.used) {
      return {
        error: "Approval already used. Call approve_next_run again.",
        status: "REJECTED",
      };
    }
    if (approval.provider && approval.provider !== provider) {
      return {
        error: `Approval provider mismatch: approved ${approval.provider}, requested ${provider}`,
        status: "REJECTED",
      };
    }
    if (approval.mode && approval.mode !== mode) {
      return {
        error: `Approval mode mismatch: approved ${approval.mode}, requested ${mode}`,
        status: "REJECTED",
      };
    }
    approval.used = true;
    approval.used_at = new Date().toISOString();
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf-8");
  }

  const runId = `run-gated-${Date.now()}`;
  const lockResult = acquireRunLock(runId, mode, provider);
  if (!lockResult.ok) {
    return { error: "Another run is active", status: "REJECTED" };
  }

  const state = {
    mode,
    current_run_id: runId,
    status: "DELEGATE_RUNNING",
    autonomy_level: mode,
    active_task_id: null,
    stop_reason: null,
  };
  if (!existsSync(DELEGATE_DIR)) mkdirSync(DELEGATE_DIR, { recursive: true });
  writeFileSync(
    join(DELEGATE_DIR, "state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );

  const runDir = join(RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run_state.json"),
    JSON.stringify(
      {
        run_id: runId,
        task_id: "gated-loop",
        status: "DELEGATE_RUNNING",
        round: 0,
        max_rounds: maxRounds,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_actor: "user",
        next_actor: "local_orchestrator",
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    status: "STARTED",
    run_id: runId,
    provider,
    max_rounds: maxRounds,
    timeout,
    mode,
    run_token: lockResult.run_token,
    run_token_hash: lockResult.run_token_hash,
  };
}

export function handleGetGatedLoopStatus(): unknown {
  const stateResult = readJsonSafe("state.json");
  const lockInfo = getRunLock();

  let pendingApprovals = 0;
  if (existsSync(APPROVALS_DIR)) {
    try {
      const files = readdirSync(APPROVALS_DIR).filter((f) =>
        f.endsWith(".json"),
      );
      for (const file of files) {
        const data = JSON.parse(
          readFileSync(join(APPROVALS_DIR, file), "utf-8"),
        );
        if (!data.used) pendingApprovals++;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    state: stateResult.ok ? stateResult.data : null,
    lock: lockInfo,
    pending_approvals: pendingApprovals,
  };
}

export async function handleRunOrchestratorStep(args: {
  run_id?: string;
  run_token?: string;
  provider?: string;
  executor_provider?: string;
  coach_provider?: string;
  timeout?: number;
  max_rounds?: number;
  allow_real_provider?: boolean;
}): Promise<unknown> {
  const stateResult = readJsonSafe("state.json");
  if (!stateResult.ok) {
    return { error: "No state.json found", status: "REJECTED" };
  }
  const state = stateResult.data as Record<string, unknown>;
  if (
    state.status !== "DELEGATE_RUNNING" &&
    state.status !== "READY_TO_DELEGATE"
  ) {
    return {
      error: `Invalid state for orchestrator step: ${state.status}`,
      status: "REJECTED",
    };
  }

  if (args.run_token) {
    const tokenResult = verifyRunToken({ run_token: args.run_token });
    if (!tokenResult.valid) {
      return { error: "Invalid run_token", status: "REJECTED" };
    }
  }

  const taskResult = safeRead("current_task.md");
  if (!taskResult.ok) {
    const firstTaskResult = safeRead("ceo/first_task.md");
    if (!firstTaskResult.ok) {
      return {
        error: "No current_task.md or first_task.md found",
        status: "REJECTED",
      };
    }
  }

  const executorProviderName =
    args.executor_provider || args.provider || "mock";
  const coachProviderName = args.coach_provider || args.provider || "mock";

  const isRealOrchProvider =
    executorProviderName === "openai" ||
    executorProviderName === "ollama" ||
    coachProviderName === "openai" ||
    coachProviderName === "ollama";
  if (isRealOrchProvider && !args.allow_real_provider) {
    return {
      error: `Real provider requires allow_real_provider: true`,
      status: "REJECTED",
    };
  }

  const { MockExecutorProvider, MockCoachReviewProvider } =
    await import("../delegate/providers/mock.js");
  const {
    OpenAICompatibleExecutorProvider,
    OpenAICompatibleCoachReviewProvider,
  } = await import("../delegate/providers/openai.js");

  let executorProvider;
  if (executorProviderName === "openai") {
    const apiUrl = process.env.OPENAI_API_URL || "";
    const apiKey = process.env.OPENAI_API_KEY || "";
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!apiUrl || !apiKey) {
      return {
        error:
          "OPENAI_API_URL and OPENAI_API_KEY env vars required for openai provider",
        status: "REJECTED",
      };
    }
    executorProvider = new OpenAICompatibleExecutorProvider({
      apiUrl,
      apiKey,
      model,
    });
  } else {
    executorProvider = new MockExecutorProvider();
  }

  let coachProvider;
  if (coachProviderName === "openai") {
    const apiUrl = process.env.OPENAI_API_URL || "";
    const apiKey = process.env.OPENAI_API_KEY || "";
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!apiUrl || !apiKey) {
      return {
        error:
          "OPENAI_API_URL and OPENAI_API_KEY env vars required for openai provider",
        status: "REJECTED",
      };
    }
    coachProvider = new OpenAICompatibleCoachReviewProvider({
      apiUrl,
      apiKey,
      model,
    });
  } else {
    coachProvider = new MockCoachReviewProvider();
  }

  const { LocalOrchestratorV2 } =
    await import("../delegate/orchestrator_v2.js");
  const orchestrator = new LocalOrchestratorV2(
    executorProvider,
    coachProvider,
    {
      mode: "delegate",
      max_rounds: args.max_rounds || 1,
      max_runtime_seconds: args.timeout || 30,
    },
  );

  const runId =
    args.run_id || (state.current_run_id as string) || `run-orch-${Date.now()}`;

  try {
    await orchestrator.runAutoLoop();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      error: `Orchestrator error: ${errorMessage}`,
      status: "ERROR",
      run_id: runId,
    };
  }

  const updatedStateResult = readJsonSafe("state.json");
  const updatedState = updatedStateResult.ok
    ? (updatedStateResult.data as Record<string, unknown>)
    : state;
  const finalRunId = (updatedState.current_run_id as string) || runId;

  const artifacts: Record<string, string | null> = {};
  const safeRunDir = safePath(join("runs", finalRunId));
  if (safeRunDir && existsSync(safeRunDir)) {
    const artifactNames = [
      "run_state.json",
      "local_report.md",
      "coach_review.md",
      "final_report.md",
      "blocked_report.md",
      "budget_stop_report.md",
      "user_question.md",
    ];
    for (const name of artifactNames) {
      const result = safeRead(join("runs", finalRunId, name));
      artifacts[name] = result.ok ? result.content! : null;
    }
  }

  return {
    status: "COMPLETED",
    run_id: finalRunId,
    orchestrator_status: updatedState.status,
    stop_reason: updatedState.stop_reason || null,
    artifacts,
  };
}
