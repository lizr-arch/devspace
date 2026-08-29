import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";

import {
  DELEGATE_DIR,
  CEO_DIR,
  RUNS_DIR,
  USER_ANSWERS_DIR,
  safeRead,
  isPidAlive,
} from "./handlers-common.js";

export function handlePreviewDelegateRun(args: {
  provider?: string;
  max_rounds?: number;
  timeout?: number;
  mode?: string;
}): unknown {
  const provider = args.provider || "mock";
  const maxRounds = args.max_rounds || 1;
  const timeout = args.timeout || 30;
  const mode = args.mode || "delegate";

  const checks: Record<string, { ok: boolean; detail: string }> = {};

  const contractResult = safeRead("ceo/delegate_contract.md");
  checks.handoff_contract = {
    ok: contractResult.ok,
    detail: contractResult.ok ? "Found" : "Missing delegate_contract.md",
  };

  const stopResult = safeRead("ceo/stop_conditions.md");
  checks.stop_conditions = {
    ok: stopResult.ok,
    detail: stopResult.ok ? "Found" : "Missing stop_conditions.md",
  };

  checks.task_file = {
    ok: !!(safeRead("current_task.md").ok || safeRead("ceo/first_task.md").ok),
    detail: safeRead("current_task.md").ok
      ? "current_task.md"
      : safeRead("ceo/first_task.md").ok
        ? "ceo/first_task.md"
        : "No task found",
  };

  const isReal = provider === "ollama" || provider === "openai";
  checks.provider = {
    ok: true,
    detail: isReal
      ? `Real provider: ${provider} (requires allow_real_provider)`
      : `Mock provider`,
  };

  checks.mode = {
    ok: true,
    detail:
      mode === "free"
        ? "Free mode (requires allow_free_mode)"
        : `Mode: ${mode}`,
  };

  const lockExists = existsSync(join(DELEGATE_DIR, "run.lock"));
  checks.run_lock = {
    ok: !lockExists,
    detail: lockExists
      ? "Run lock exists - another run may be active"
      : "No run lock",
  };

  const allOk = Object.values(checks).every((c) => c.ok);

  return {
    would_run: allOk,
    provider,
    max_rounds: maxRounds,
    timeout,
    mode,
    checks,
  };
}

export function acquireRunLock(
  runId: string,
  mode: string,
  provider: string,
): { ok: boolean; run_token?: string; run_token_hash?: string } {
  const lockPath = join(DELEGATE_DIR, "run.lock");
  if (!existsSync(DELEGATE_DIR)) mkdirSync(DELEGATE_DIR, { recursive: true });

  try {
    const run_token = randomUUID();
    const run_token_hash = createHash("sha256")
      .update(run_token)
      .digest("hex")
      .substring(0, 16);
    const fd = openSync(lockPath, "wx");
    const lockData = JSON.stringify({
      run_id: runId,
      created_at: new Date().toISOString(),
      pid: process.pid,
      mode,
      provider,
      run_token_hash,
    });
    const buf = Buffer.from(lockData, "utf-8");
    writeFileSync(fd, buf);
    closeSync(fd);
    return { ok: true, run_token, run_token_hash };
  } catch {
    return { ok: false };
  }
}

export function releaseRunLock(): void {
  const lockPath = join(DELEGATE_DIR, "run.lock");
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

export function getRunLock(): { locked: boolean; lock?: Record<string, unknown> } {
  const lockPath = join(DELEGATE_DIR, "run.lock");
  if (!existsSync(lockPath)) return { locked: false };
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    return { locked: true, lock: data };
  } catch {
    return { locked: true, lock: undefined };
  }
}

export function handleStartDelegateRun(args: {
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

  if (isReal || maxRounds > 1) {
    const taskPath = join(DELEGATE_DIR, "current_task.md");
    const taskContent = existsSync(taskPath)
      ? readFileSync(taskPath, "utf-8")
      : "";
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

  if (!existsSync(join(CEO_DIR, "delegate_contract.md"))) {
    return {
      error: "Missing delegate_contract.md. Run handoff init first.",
      status: "REJECTED",
    };
  }
  if (!existsSync(join(CEO_DIR, "stop_conditions.md"))) {
    return {
      error: "Missing stop_conditions.md. Run handoff init first.",
      status: "REJECTED",
    };
  }

  const runId = `run-mcp-${Date.now()}`;
  const lockResult = acquireRunLock(runId, mode, provider);
  if (!lockResult.ok) {
    return {
      error: "Another run is active. Stop it first.",
      status: "REJECTED",
    };
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
        task_id: "mcp-started",
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

export function handlePauseDelegateRun(args: {
  run_token?: string;
  admin_override?: boolean;
  allow_admin_override?: boolean;
  reason?: string;
}): unknown {
  const statePath = join(DELEGATE_DIR, "state.json");
  if (!existsSync(statePath)) {
    return { error: "No active delegate", status: "NO_STATE" };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));

  if (args.run_token) {
    const lockPath = join(DELEGATE_DIR, "run.lock");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (lock.run_token_hash) {
        const hash = createHash("sha256")
          .update(args.run_token)
          .digest("hex")
          .substring(0, 16);
        if (hash !== lock.run_token_hash) {
          return { error: "Invalid run_token", status: "REJECTED" };
        }
      }
    }
  } else if (!args.admin_override || !args.allow_admin_override) {
    return {
      error: "run_token required (or admin_override + allow_admin_override)",
      status: "REJECTED",
    };
  }

  if (
    state.status !== "DELEGATE_RUNNING" &&
    state.status !== "LOCAL_EXECUTING"
  ) {
    return {
      error: `Cannot pause from state: ${state.status}`,
      status: "INVALID_STATE",
    };
  }

  const previousStatus = state.status;
  state.status = "READY_TO_DELEGATE";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  const response: Record<string, unknown> = {
    status: "PAUSED",
    previous_status: previousStatus,
  };
  if (args.admin_override) {
    response.safety_flags = ["admin_override"];
  }
  return response;
}

export function handleResumeDelegateRun(args: {
  run_token?: string;
  admin_override?: boolean;
  allow_admin_override?: boolean;
  reason?: string;
}): unknown {
  const statePath = join(DELEGATE_DIR, "state.json");
  if (!existsSync(statePath)) {
    return { error: "No active delegate", status: "NO_STATE" };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));

  if (args.run_token) {
    const lockPath = join(DELEGATE_DIR, "run.lock");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (lock.run_token_hash) {
        const hash = createHash("sha256")
          .update(args.run_token)
          .digest("hex")
          .substring(0, 16);
        if (hash !== lock.run_token_hash) {
          return { error: "Invalid run_token", status: "REJECTED" };
        }
      }
    }
  } else if (!args.admin_override || !args.allow_admin_override) {
    return {
      error: "run_token required (or admin_override + allow_admin_override)",
      status: "REJECTED",
    };
  }

  if (state.status !== "READY_TO_DELEGATE") {
    return {
      error: `Cannot resume from state: ${state.status}`,
      status: "INVALID_STATE",
    };
  }

  state.status = "DELEGATE_RUNNING";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  const response: Record<string, unknown> = { status: "RESUMED" };
  if (args.admin_override) {
    response.safety_flags = ["admin_override"];
  }
  return response;
}

export function handleStopDelegateRun(args: {
  run_token?: string;
  admin_override?: boolean;
  allow_admin_override?: boolean;
  reason?: string;
}): unknown {
  const statePath = join(DELEGATE_DIR, "state.json");
  if (!existsSync(statePath)) {
    return { error: "No active delegate", status: "NO_STATE" };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));

  if (args.run_token) {
    const lockPath = join(DELEGATE_DIR, "run.lock");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (lock.run_token_hash) {
        const hash = createHash("sha256")
          .update(args.run_token)
          .digest("hex")
          .substring(0, 16);
        if (hash !== lock.run_token_hash) {
          return { error: "Invalid run_token", status: "REJECTED" };
        }
      }
    }
  } else if (!args.admin_override || !args.allow_admin_override) {
    return {
      error: "run_token required (or admin_override + allow_admin_override)",
      status: "REJECTED",
    };
  }

  const previousStatus = state.status;
  state.status = "DONE";
  state.stop_reason = args.reason || "Stopped by MCP";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  releaseRunLock();

  const response: Record<string, unknown> = {
    status: "STOPPED",
    previous_status: previousStatus,
  };
  if (args.admin_override) {
    response.safety_flags = ["admin_override"];
  }
  return response;
}

export function handleAnswerNeedUser(args: {
  answer: string;
  decision: string;
}): unknown {
  if (!args.answer || !args.decision) {
    return {
      error: "answer and decision are required",
      status: "INVALID_INPUT",
    };
  }

  const validDecisions = ["continue", "skip", "abort"];
  if (!validDecisions.includes(args.decision)) {
    return {
      error: `Invalid decision. Must be: ${validDecisions.join(", ")}`,
      status: "INVALID_DECISION",
    };
  }

  if (!existsSync(USER_ANSWERS_DIR))
    mkdirSync(USER_ANSWERS_DIR, { recursive: true });
  const answerFile = join(USER_ANSWERS_DIR, `answer-${Date.now()}.json`);
  writeFileSync(
    answerFile,
    JSON.stringify(
      {
        time: new Date().toISOString(),
        answer: args.answer,
        decision: args.decision,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return { status: "ANSWERED", file: answerFile };
}

export function handleRecoverStaleLock(args: {
  ttl_seconds?: number;
  force?: boolean;
  allow_force_recovery?: boolean;
}): unknown {
  const lockPath = join(DELEGATE_DIR, "run.lock");

  if (!existsSync(lockPath)) {
    return { status: "NO_LOCK", message: "No run.lock found" };
  }

  let lockData: Record<string, unknown> = {};
  try {
    lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    if (args.force) {
      if (!args.allow_force_recovery) {
        return {
          error: "Force recovery requires allow_force_recovery: true",
          status: "REJECTED",
        };
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return { status: "RECOVERED", reason: "corrupt_lock_file", forced: true };
    }
    return {
      error: "Lock file is corrupt. Use force: true to remove.",
      status: "REJECTED",
    };
  }

  const pid = lockData.pid as number | undefined;
  const createdAt = lockData.created_at as string | undefined;

  if (args.force) {
    if (!args.allow_force_recovery) {
      return {
        error: "Force recovery requires allow_force_recovery: true",
        status: "REJECTED",
      };
    }
    const old_lock_summary = {
      run_id: lockData.run_id,
      pid: lockData.pid,
      provider: lockData.provider,
    };
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return {
      status: "RECOVERED",
      reason: "forced",
      lock: lockData,
      forced: true,
      safety_flags: ["force_recovery"],
      old_lock_summary,
    };
  }

  const ttlSeconds = Math.max(args.ttl_seconds ?? 300, 60);
  let reason: string | null = null;

  if (pid && !isPidAlive(pid)) {
    reason = "pid_dead";
  }

  if (!reason && createdAt) {
    const lockAge = (Date.now() - new Date(createdAt).getTime()) / 1000;
    if (lockAge > ttlSeconds) {
      reason = "ttl_expired";
    }
  }

  if (reason) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return { status: "RECOVERED", reason, lock: lockData };
  }

  return {
    error: "Lock is still active. Use force: true to override.",
    status: "REJECTED",
    lock: lockData,
    pid_alive: pid ? isPidAlive(pid) : undefined,
  };
}
