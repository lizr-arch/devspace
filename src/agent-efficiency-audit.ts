import { createHash } from "node:crypto";

/**
 * Offline, evidence-limited audit. Never receives source text, prompts,
 * command output, model reasoning, or raw arguments.
 */
export const AUDIT_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TRACE = 512;
const MAX_EVIDENCE = 120;
const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

export type AuditTrace = {
  /** Stable within a run; useful for locating this event in the observer stream. */
  id: string;
  /** Native item identity is for matching start/completion, never an event ID. */
  actionId?: string;
  kind: string;
  at: string;
  phase?: string;
  status?: string;
  tool?: string;
  /** In-process only: SHA256 of the bounded tool input; not exported. */
  inputHash?: string;
  sourceMutation?: boolean;
};

export type AuditFinding = {
  id: string;
  category: string;
  severity: "info" | "warning";
  confidence: "high" | "medium" | "low";
  evidenceLevel: string;
  evidenceEventIds: string[];
  claim: string;
  recommendation: string;
};

export type AgentEfficiencySnapshot = {
  version: 1;
  identity: { workspaceId: string; operationId: string };
  status: string;
  start: string;
  finish: string;
  elapsedMs: number;
  timestamps: { first: string; last: string };
  countsByEventKind: Record<string, number>;
  confirmedToolStarts: number;
  confirmedToolCompletions: number;
  tokenUsage: Record<string, number>;
  sourceChange: "yes" | "no" | "unknown";
  observations: AuditFinding[];
  evidenceTimeline: Array<{ id: string; kind: string; phase?: string; tool?: string; at: string }>;
  dataCoverage: { traceEvents: number; truncated: boolean; complete: boolean; missingEvidence: string[] };
};

export function auditId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
export function stableInputHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new TypeError("AUDIT_INVALID_HASH_INPUT");
  return createHash("sha256").update(serialized.slice(0, 4096)).digest("hex");
}

export function analyzeAgentEfficiency(input: {
  workspaceId: string;
  operationId: string;
  status: string;
  start: string;
  finish: string;
  tokenUsage?: unknown;
  sourceChange?: boolean;
  trace: AuditTrace[];
}): AgentEfficiencySnapshot {
  if (!auditId(input.workspaceId) || !auditId(input.operationId)) {
    throw new TypeError("AUDIT_INVALID_ID");
  }
  const truncated = input.trace.length > MAX_TRACE;
  const trace = input.trace.slice(0, MAX_TRACE);
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const started = new Map<string, AuditTrace>();
  const finished = new Set<string>();
  const missing = new Set<string>([
    "agent_intent_unavailable",
    "tool_results_redacted",
    "external_side_effects_unobserved",
  ]);
  if (!trace.length) missing.add("native_trace");
  if (truncated) missing.add("trace_truncated");
  if (!input.tokenUsage) missing.add("token_usage");
  if (input.sourceChange === undefined) missing.add("workspace_state_change_unknown");
  const observations: AuditFinding[] = [];

  for (const e of trace) {
    if (!/^[a-z-]{1,32}$/.test(e.kind)) continue;
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (!e.tool) continue;
    if (!e.actionId) {
      if (e.phase === "item.started" || e.phase === "item.completed") missing.add("native_item_id_unavailable");
      continue;
    }
    if (e.phase === "item.started" && !started.has(e.actionId)) started.set(e.actionId, e);
    if (e.phase === "item.completed") finished.add(e.actionId);
  }
  const incomplete = [...started].filter(([id]) => !finished.has(id));
  if (input.status !== "COMPLETED") {
    observations.push({
      id: "unfinished-task", category: "completion", severity: "warning",
      confidence: "high", evidenceLevel: "runner-final-state",
      evidenceEventIds: trace.slice(-3).map(e => e.id),
      claim: "The native runner did not verify successful completion.",
      recommendation: "Inspect the failure or stop reason before retrying.",
    });
  }
  if (incomplete.length && !truncated) {
    observations.push({
      id: "unfinished-steps", category: "completion", severity: "warning",
      confidence: "medium", evidenceLevel: "native-item-correlation",
      evidenceEventIds: incomplete.slice(0, 8).map(([, e]) => e.id),
      claim: "Some observed tool starts lack a corresponding completed event.",
      recommendation: "Check interruption, timeout, or trace gaps before retrying.",
    });
  }
  if (truncated) {
    observations.push({
      id: "partial-trace", category: "coverage", severity: "warning",
      confidence: "high", evidenceLevel: "bounded-capture",
      evidenceEventIds: [], claim: "The audit captured only the first 512 normalized events.",
      recommendation: "Do not interpret the event counts as totals for this run.",
    });
  }

  // Repetition is an observation about identical *inputs*, not proof of waste.
  // Only command starts with an actual observed inputHash participate. A native
  // file_change completion invalidates all previously seen hashes. Commands can
  // have unobservable side effects, hence low confidence.
  const seen = new Map<string, AuditTrace>();
  const repeatedPairs: Array<[AuditTrace, AuditTrace]> = [];
  for (const e of trace) {
    if (e.sourceMutation) seen.clear();
    if (e.phase !== "item.started" || !e.tool || !e.inputHash) continue;
    const key = e.tool + ":" + e.inputHash;
    const prior = seen.get(key);
    if (prior) repeatedPairs.push([prior, e]);
    seen.set(key, e);
  }
  if (repeatedPairs.length) {
    observations.push({
      id: "possibly-repeated-input", category: "efficiency", severity: "info",
      confidence: "low", evidenceLevel: "bounded-in-process-input-digest",
      evidenceEventIds: repeatedPairs.slice(0, 4).flatMap(pair => pair.map(x => x.id)),
      claim: "Identical tool inputs recurred without an observed file-change event between them.",
      recommendation: "Compare the actual tool results before deciding whether the repetition was necessary.",
    });
  }

  const usage: Record<string, number> = {};
  if (input.tokenUsage && typeof input.tokenUsage === "object" && !Array.isArray(input.tokenUsage)) {
    const values = input.tokenUsage as Record<string, unknown>;
    for (const key of TOKEN_FIELDS) {
      const value = values[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    }
  }
  const startMs = Date.parse(input.start), finishMs = Date.parse(input.finish);
  const elapsedMs = Number.isFinite(startMs) && Number.isFinite(finishMs)
    ? Math.max(0, finishMs - startMs) : 0;

  // Retain compact event evidence for later MCP-based inspection after a
  // service restart, including any older events referenced by findings.
  const refs = new Set(observations.flatMap(f => f.evidenceEventIds));
  const recent = trace.slice(-90);
  const evidence = [...trace.filter(e => refs.has(e.id)), ...recent];
  const unique = new Map(evidence.map(e => [e.id, e]));
  const evidenceTimeline = [...unique.values()].slice(-MAX_EVIDENCE).map(e => ({
    id: String(e.id).slice(0, 32),
    kind: /^[a-z-]{1,32}$/.test(e.kind) ? e.kind : "status",
    ...(typeof e.phase === "string" && /^[a-z.]{1,40}$/.test(e.phase) ? { phase: e.phase } : {}),
    ...(typeof e.tool === "string" && /^[a-z-]{1,32}$/.test(e.tool) ? { tool: e.tool } : {}),
    at: Number.isFinite(Date.parse(e.at)) ? e.at : input.start,
  }));

  return {
    version: 1,
    identity: { workspaceId: input.workspaceId, operationId: input.operationId },
    status: ["COMPLETED", "FAILED", "STOPPED", "INTERRUPTED"].includes(input.status) ? input.status : "UNKNOWN",
    start: input.start, finish: input.finish, elapsedMs,
    timestamps: { first: trace[0]?.at ?? input.start, last: trace.at(-1)?.at ?? input.finish },
    countsByEventKind: counts,
    confirmedToolStarts: started.size,
    confirmedToolCompletions: [...started.keys()].filter(x => finished.has(x)).length,
    tokenUsage: usage,
    sourceChange: input.sourceChange === undefined ? "unknown" : input.sourceChange ? "yes" : "no",
    observations, evidenceTimeline,
    dataCoverage: { traceEvents: trace.length, truncated, complete: missing.size === 0, missingEvidence: [...missing] },
  };
}
