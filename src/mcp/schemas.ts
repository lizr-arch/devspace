export const TOOL_SCHEMAS: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  get_delegate_status: {
    description: "Get current delegate mode status (read-only)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  read_delegate_timeline: {
    description: "Read conversation timeline (read-only)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return" },
      },
      required: [],
    },
  },
  read_current_task: {
    description: "Read current task file (read-only)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  read_handoff_summary: {
    description: "Read handoff package summary (read-only)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  read_run_artifacts: {
    description: "Read artifacts from a specific run (read-only)",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID to read from" },
      },
      required: ["run_id"],
    },
  },
  validate_handoff: {
    description: "Validate handoff package (read-only)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  list_runs: {
    description: "List all delegate runs (read-only)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  preview_delegate_run: {
    description: "Preview what a delegate run would do (read-only)",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
        max_rounds: { type: "number" },
        timeout: { type: "number" },
        mode: { type: "string" },
      },
      required: [],
    },
  },
  start_delegate_run: {
    description: "Start a delegate run (controlled write)",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider: mock/ollama/openai (default: mock)",
        },
        max_rounds: { type: "number", description: "Max rounds (default: 1)" },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30)",
        },
        mode: {
          type: "string",
          description: "Mode: delegate/free (default: delegate)",
        },
        allow_free_mode: {
          type: "boolean",
          description: "Must be true for free mode",
        },
        allow_real_provider: {
          type: "boolean",
          description: "Must be true for ollama/openai",
        },
        allow_real_free_mode: {
          type: "boolean",
          description: "Must be true for real provider + free mode",
        },
      },
      required: [],
    },
  },
  pause_delegate_run: {
    description: "Pause a delegate run",
    inputSchema: {
      type: "object",
      properties: {
        run_token: {
          type: "string",
          description: "Run token for authorization",
        },
        admin_override: {
          type: "boolean",
          description: "Admin override (requires allow_admin_override)",
        },
        allow_admin_override: { type: "boolean" },
        reason: { type: "string" },
      },
      required: [],
    },
  },
  resume_delegate_run: {
    description: "Resume a paused delegate run",
    inputSchema: {
      type: "object",
      properties: {
        run_token: {
          type: "string",
          description: "Run token for authorization",
        },
        admin_override: {
          type: "boolean",
          description: "Admin override (requires allow_admin_override)",
        },
        allow_admin_override: { type: "boolean" },
        reason: { type: "string" },
      },
      required: [],
    },
  },
  stop_delegate_run: {
    description: "Stop a delegate run",
    inputSchema: {
      type: "object",
      properties: {
        run_token: {
          type: "string",
          description: "Run token for authorization",
        },
        admin_override: {
          type: "boolean",
          description: "Admin override (requires allow_admin_override)",
        },
        allow_admin_override: { type: "boolean" },
        reason: { type: "string" },
      },
      required: [],
    },
  },
  answer_need_user: {
    description: "Provide answer when delegate is in NEED_USER state",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "User answer text" },
        decision: {
          type: "string",
          description: "Decision: continue/skip/abort",
        },
      },
      required: ["answer", "decision"],
    },
  },
  create_handoff_from_webgpt: {
    description: "Create handoff package from Web GPT content",
    inputSchema: {
      type: "object",
      properties: {
        contract_md: {
          type: "string",
          description: "Delegate contract markdown",
        },
        stop_conditions_md: {
          type: "string",
          description: "Stop conditions markdown",
        },
        autonomy_policy_md: {
          type: "string",
          description: "Autonomy policy markdown",
        },
        first_task_md: { type: "string", description: "First task markdown" },
      },
      required: [],
    },
  },
  submit_coach_review: {
    description:
      "Submit coach review result (must follow CoachReview contract)",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          description:
            "Verdict: PASS/PASS_WITH_WARNINGS/DONE/BLOCKED/NEED_USER/NEEDS_FIX/SAFETY_STOP/BUDGET_STOP",
        },
        reasoning_summary: { type: "string", description: "Reasoning summary" },
        next_task_content: {
          type: "string",
          description: "Next task content (required for PASS)",
        },
        blocking_issues: {
          type: "array",
          items: { type: "string" },
          description: "Blocking issues",
        },
        non_blocking_issues: {
          type: "array",
          items: { type: "string" },
          description: "Non-blocking issues",
        },
        run_token: {
          type: "string",
          description: "Run token for write verification",
        },
      },
      required: ["verdict"],
    },
  },
  create_next_task: {
    description: "Create next task for delegate",
    inputSchema: {
      type: "object",
      properties: {
        task_content: { type: "string" },
        source: {
          type: "string",
          description: "Source: coach_review|user_approved|manual",
        },
        review_id: {
          type: "string",
          description: "Review ID from submit_coach_review",
        },
      },
      required: ["task_content"],
    },
  },
  approve_next_run: {
    description: "Approve next delegate run (REQUIRED for real providers)",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        task_hash: { type: "string" },
        provider: {
          type: "string",
          description: "Target provider: mock|ollama|openai",
        },
        mode: { type: "string", description: "Target mode: delegate|free" },
        max_rounds: { type: "number", description: "Target max rounds" },
        timeout: { type: "number", description: "Target timeout seconds" },
        scope: {
          type: "string",
          description:
            "Approval scope: delegate_run|gated_loop|orchestrator_step|any",
        },
        approved_by: { type: "string" },
        approval_reason: { type: "string" },
      },
      required: [],
    },
  },
  start_gated_loop: {
    description: "Start gated loop with approval requirement",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider: mock/ollama/openai (default: mock)",
        },
        max_rounds: { type: "number", description: "Max rounds (default: 1)" },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30)",
        },
        mode: {
          type: "string",
          description: "Mode: delegate/free (default: delegate)",
        },
        allow_free_mode: {
          type: "boolean",
          description: "Must be true for free mode",
        },
        allow_real_provider: {
          type: "boolean",
          description: "Must be true for ollama/openai",
        },
        allow_real_free_mode: {
          type: "boolean",
          description: "Must be true for real provider + free mode",
        },
      },
      required: [],
    },
  },
  get_gated_loop_status: {
    description: "Get gated loop status including approvals and lock",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  recover_stale_lock: {
    description: "Recover stale run.lock (pid dead or TTL expired)",
    inputSchema: {
      type: "object",
      properties: {
        ttl_seconds: {
          type: "number",
          description: "Lock TTL in seconds (default: 300)",
        },
        force: {
          type: "boolean",
          description: "Force remove lock regardless of pid/TTL",
        },
        allow_force_recovery: {
          type: "boolean",
          description: "Must be true to allow force recovery",
        },
      },
      required: [],
    },
  },
  verify_run_token: {
    description: "Verify run_token is still valid",
    inputSchema: {
      type: "object",
      properties: {
        run_token: { type: "string", description: "Run token to verify" },
      },
      required: ["run_token"],
    },
  },
  run_orchestrator_step: {
    description: "Execute one orchestrator step (calls real provider)",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        run_token: { type: "string" },
        provider: {
          type: "string",
          description: "Provider: mock|ollama|openai",
        },
        executor_provider: {
          type: "string",
          description: "Executor provider override",
        },
        coach_provider: {
          type: "string",
          description: "Coach provider override",
        },
        timeout: {
          type: "number",
          description: "Timeout seconds (default: 30)",
        },
        max_rounds: { type: "number", description: "Max rounds (default: 1)" },
      },
      required: [],
    },
  },
};

export const ALL_TOOL_NAMES = Object.keys(TOOL_SCHEMAS);
