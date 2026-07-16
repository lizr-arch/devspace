import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";
import type {
  ProjectMemoryConfig,
  ProjectMemoryRepositoryConfig,
} from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type ProjectMemoryDecision =
  | "allow"
  | "observe_would_deny"
  | "deny";

export interface ProjectMemoryActiveState {
  receiptId?: string;
  decision: string;
  wouldDeny: boolean;
  denialReasons: string[];
  bundleDeliveredAt?: string;
  updatedAt: string;
}

export interface ProjectMemoryPreflightView {
  status: "ready" | "unconfigured" | "error";
  receiptId?: string;
  decision?: ProjectMemoryDecision;
  wouldDeny: boolean;
  denialReasons: string[];
  bundle?: unknown;
  error?: string;
}

export interface ProjectMemoryAccessObservation {
  mode: "SHADOW";
  receiptId?: string;
  outcome:
    | "receipt_match"
    | "receipt_missing"
    | "receipt_mismatch"
    | "receipt_expired"
    | "preflight_missing"
    | "preflight_without_receipt";
  wouldDeny: boolean;
}

interface GatewayReceipt extends Record<string, unknown> {
  schema_version: number;
  receipt_id: string;
  mode: "SHADOW";
  issued_at: string;
  expires_at: string;
  task_sha256: string;
  repository_head: string;
  catalog_sha256: string;
  policy_sha256: string;
  selected_owners: Array<Record<string, unknown>>;
  query_iterations: Array<Record<string, unknown>>;
  bundle_sha256: string;
}

interface GatewayPreflightPayload {
  schema_version: 1;
  mode: "SHADOW";
  policy_mode: "SHADOW" | "NORMAL";
  decision: ProjectMemoryDecision;
  would_deny: boolean;
  denial_reasons: string[];
  bundle: unknown | null;
  receipt: GatewayReceipt | null;
}

export type ProjectMemoryCommandRunner = (
  repository: ProjectMemoryRepositoryConfig,
  task: string,
) => Promise<unknown>;

export class ProjectMemoryStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  savePreflight(
    workspaceId: string,
    payload: GatewayPreflightPayload,
  ): ProjectMemoryActiveState {
    const now = new Date().toISOString();
    const receipt = payload.receipt;
    const transaction = this.database.sqlite.transaction(() => {
      if (receipt) {
        this.database.sqlite
          .prepare(
            `insert into project_memory_receipts (
               receipt_id, workspace_session_id, mode, task_sha256,
               receipt_json, expires_at, created_at
             ) values (?, ?, ?, ?, ?, ?, ?)
             on conflict(receipt_id) do nothing`,
          )
          .run(
            receipt.receipt_id,
            workspaceId,
            receipt.mode,
            receipt.task_sha256,
            JSON.stringify(receipt),
            receipt.expires_at,
            now,
          );
      }

      this.upsertActiveState({
        workspaceId,
        receiptId: receipt?.receipt_id,
        decision: payload.decision,
        wouldDeny: payload.would_deny,
        denialReasons: payload.denial_reasons,
        now,
      });
      this.insertEvent({
        workspaceId,
        receiptId: receipt?.receipt_id,
        eventType: "preflight",
        outcome: payload.decision,
        details: {
          wouldDeny: payload.would_deny,
          denialReasons: payload.denial_reasons,
        },
        now,
      });
    });
    transaction.immediate();
    return this.getActiveState(workspaceId)!;
  }

  saveUnavailableState(
    workspaceId: string,
    decision: "unconfigured" | "error",
  ): ProjectMemoryActiveState {
    const now = new Date().toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      this.upsertActiveState({
        workspaceId,
        decision,
        wouldDeny: false,
        denialReasons: [],
        now,
      });
      this.insertEvent({
        workspaceId,
        eventType: "preflight",
        outcome: decision,
        details: {},
        now,
      });
    });
    transaction.immediate();
    return this.getActiveState(workspaceId)!;
  }

  markBundleDelivered(workspaceId: string, receiptId?: string): void {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update project_memory_active_state
           set bundle_delivered_at = ?, updated_at = ?
         where workspace_session_id = ?
           and bundle_delivered_at is null
           and (receipt_id = ? or (receipt_id is null and ? is null))`,
      )
      .run(now, now, workspaceId, receiptId ?? null, receiptId ?? null);
    if (result.changes === 0) return;
    this.insertEvent({
      workspaceId,
      receiptId,
      eventType: "bundle_delivery",
      outcome: "delivered",
      details: {},
      now,
    });
  }

  getActiveState(workspaceId: string): ProjectMemoryActiveState | undefined {
    const row = this.database.sqlite
      .prepare(
        `select receipt_id, decision, would_deny, denial_reasons_json,
                bundle_delivered_at, updated_at
           from project_memory_active_state
          where workspace_session_id = ?`,
      )
      .get(workspaceId) as
      | {
          receipt_id: string | null;
          decision: string;
          would_deny: number;
          denial_reasons_json: string;
          bundle_delivered_at: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      receiptId: row.receipt_id ?? undefined,
      decision: row.decision,
      wouldDeny: row.would_deny === 1,
      denialReasons: parseStringArray(row.denial_reasons_json),
      bundleDeliveredAt: row.bundle_delivered_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  observeAccess(
    workspaceId: string,
    toolName: string,
    suppliedReceiptId: string | undefined,
    now = new Date(),
  ): ProjectMemoryAccessObservation {
    const active = this.getActiveState(workspaceId);
    let outcome: ProjectMemoryAccessObservation["outcome"];
    if (!active) {
      outcome = "preflight_missing";
    } else if (!active.receiptId) {
      outcome = "preflight_without_receipt";
    } else if (!suppliedReceiptId) {
      outcome = "receipt_missing";
    } else if (suppliedReceiptId !== active.receiptId) {
      outcome = "receipt_mismatch";
    } else if (this.receiptExpired(active.receiptId, now)) {
      outcome = "receipt_expired";
    } else {
      outcome = "receipt_match";
    }

    this.insertEvent({
      workspaceId,
      receiptId: active?.receiptId,
      eventType: "tool_access",
      toolName,
      outcome,
      details: { suppliedReceipt: Boolean(suppliedReceiptId) },
      now: now.toISOString(),
    });
    return {
      mode: "SHADOW",
      receiptId: active?.receiptId,
      outcome,
      wouldDeny: active?.wouldDeny ?? false,
    };
  }

  createPrivilegeAuthorization(input: {
    workspaceId: string;
    taskSha256: string;
    mode: "AUDIT" | "UPDATE";
    ttlSeconds?: number;
    now?: Date;
  }): string {
    assertSha256(input.taskSha256, "taskSha256");
    const ttlSeconds = input.ttlSeconds ?? 900;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
      throw new Error("Project Memory privilege TTL must be between 1 and 900 seconds");
    }
    const now = input.now ?? new Date();
    const authorizationId = `pma_${randomUUID()}`;
    this.database.sqlite
      .prepare(
        `insert into project_memory_privilege_authorizations (
           authorization_id, workspace_session_id, task_sha256, mode,
           expires_at, consumed_at, created_at
         ) values (?, ?, ?, ?, ?, null, ?)`,
      )
      .run(
        authorizationId,
        input.workspaceId,
        input.taskSha256,
        input.mode,
        new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        now.toISOString(),
      );
    return authorizationId;
  }

  consumePrivilegeAuthorization(input: {
    authorizationId: string;
    workspaceId: string;
    taskSha256: string;
    mode: "AUDIT" | "UPDATE";
    now?: Date;
  }): boolean {
    const now = input.now ?? new Date();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite
        .prepare(
          `select workspace_session_id, task_sha256, mode, expires_at, consumed_at
             from project_memory_privilege_authorizations
            where authorization_id = ?`,
        )
        .get(input.authorizationId) as
        | {
            workspace_session_id: string;
            task_sha256: string;
            mode: string;
            expires_at: string;
            consumed_at: string | null;
          }
        | undefined;
      if (
        !row ||
        row.workspace_session_id !== input.workspaceId ||
        row.task_sha256 !== input.taskSha256 ||
        row.mode !== input.mode ||
        row.consumed_at !== null ||
        Date.parse(row.expires_at) <= now.getTime()
      ) {
        return false;
      }
      const updated = this.database.sqlite
        .prepare(
          `update project_memory_privilege_authorizations
              set consumed_at = ?
            where authorization_id = ? and consumed_at is null`,
        )
        .run(now.toISOString(), input.authorizationId);
      return updated.changes === 1;
    });
    return transaction.immediate();
  }

  listTableNames(): string[] {
    return (
      this.database.sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name like 'project_memory_%' order by name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  close(): void {
    this.database.close();
  }

  private upsertActiveState(input: {
    workspaceId: string;
    receiptId?: string;
    decision: string;
    wouldDeny: boolean;
    denialReasons: string[];
    now: string;
  }): void {
    this.database.sqlite
      .prepare(
        `insert into project_memory_active_state (
           workspace_session_id, receipt_id, decision, would_deny,
           denial_reasons_json, bundle_delivered_at, updated_at
         ) values (?, ?, ?, ?, ?, null, ?)
         on conflict(workspace_session_id) do update set
           receipt_id = excluded.receipt_id,
           decision = excluded.decision,
           would_deny = excluded.would_deny,
           denial_reasons_json = excluded.denial_reasons_json,
           bundle_delivered_at = null,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.workspaceId,
        input.receiptId ?? null,
        input.decision,
        input.wouldDeny ? 1 : 0,
        JSON.stringify(input.denialReasons),
        input.now,
      );
  }

  private receiptExpired(receiptId: string, now: Date): boolean {
    const row = this.database.sqlite
      .prepare(
        "select expires_at from project_memory_receipts where receipt_id = ?",
      )
      .get(receiptId) as { expires_at: string } | undefined;
    return !row || Date.parse(row.expires_at) <= now.getTime();
  }

  private insertEvent(input: {
    workspaceId: string;
    receiptId?: string;
    eventType: string;
    toolName?: string;
    outcome: string;
    details: Record<string, unknown>;
    now: string;
  }): void {
    this.database.sqlite
      .prepare(
        `insert into project_memory_access_events (
           id, workspace_session_id, receipt_id, event_type, tool_name,
           outcome, details_json, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `pme_${randomUUID()}`,
        input.workspaceId,
        input.receiptId ?? null,
        input.eventType,
        input.toolName ?? null,
        input.outcome,
        JSON.stringify(input.details),
        input.now,
      );
  }
}

export class ProjectMemoryController {
  private readonly store: ProjectMemoryStore;

  constructor(
    private readonly config: ProjectMemoryConfig,
    stateDir: string,
    private readonly runner: ProjectMemoryCommandRunner =
      runProjectMemoryCommand,
  ) {
    this.store = new ProjectMemoryStore(stateDir);
  }

  async preflight(input: {
    workspaceId: string;
    root: string;
    task: string;
  }): Promise<ProjectMemoryPreflightView> {
    const task = normalizeTask(input.task);
    const repository = this.repositoryFor(input.root);
    if (!repository) {
      this.store.saveUnavailableState(input.workspaceId, "unconfigured");
      return {
        status: "unconfigured",
        wouldDeny: false,
        denialReasons: [],
      };
    }

    let payload: GatewayPreflightPayload;
    try {
      payload = validatePreflightPayload(await this.runner(repository, task), task);
    } catch {
      this.store.saveUnavailableState(input.workspaceId, "error");
      return {
        status: "error",
        wouldDeny: false,
        denialReasons: [],
        error: "Project Memory SHADOW preflight failed.",
      };
    }

    const active = this.store.savePreflight(input.workspaceId, payload);
    const view: ProjectMemoryPreflightView = {
      status: "ready",
      receiptId: active.receiptId,
      decision: payload.decision,
      wouldDeny: payload.would_deny,
      denialReasons: payload.denial_reasons,
      bundle: payload.bundle ?? undefined,
    };
    if (payload.bundle !== null) {
      this.store.markBundleDelivered(input.workspaceId, active.receiptId);
    }
    return view;
  }

  getActiveState(workspaceId: string): ProjectMemoryActiveState | undefined {
    return this.store.getActiveState(workspaceId);
  }

  observeAccess(
    workspaceId: string,
    toolName: string,
    suppliedReceiptId: string | undefined,
  ): ProjectMemoryAccessObservation {
    return this.store.observeAccess(workspaceId, toolName, suppliedReceiptId);
  }

  close(): void {
    this.store.close();
  }

  private repositoryFor(root: string): ProjectMemoryRepositoryConfig | undefined {
    const key = pathKey(resolve(root));
    return this.config.repositories.find(
      (repository) => pathKey(repository.root) === key,
    );
  }
}

export async function runProjectMemoryCommand(
  repository: ProjectMemoryRepositoryConfig,
  task: string,
): Promise<unknown> {
  const [executable, ...configuredArgs] = repository.command;
  const args = [
    ...configuredArgs,
    "preflight",
    "--mode",
    repository.mode,
    "--task-file",
    "-",
    "--format",
    "json",
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: repository.root,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > repository.maxOutputBytes) {
        child.kill();
        finish(new Error("Project Memory output exceeded operator limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect([], chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Project Memory preflight exited with code ${String(code)}`));
        return;
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(stdout),
        );
        finish(undefined, JSON.parse(decoded));
      } catch {
        finish(new Error("Project Memory preflight returned invalid UTF-8 JSON"));
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Project Memory preflight exceeded operator timeout"));
    }, repository.timeoutMs);
    child.stdin.end(task);
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function validatePreflightPayload(
  value: unknown,
  task: string,
): GatewayPreflightPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Project Memory preflight payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schema_version !== 1 ||
    payload.mode !== "SHADOW" ||
    !["SHADOW", "NORMAL"].includes(String(payload.policy_mode)) ||
    !["allow", "observe_would_deny", "deny"].includes(
      String(payload.decision),
    ) ||
    typeof payload.would_deny !== "boolean" ||
    !Array.isArray(payload.denial_reasons) ||
    !payload.denial_reasons.every(
      (reason) =>
        typeof reason === "string" &&
        reason.length <= 256 &&
        /^[A-Za-z0-9_.:-]+$/.test(reason),
    )
  ) {
    throw new Error("Invalid Project Memory preflight contract");
  }
  const bundle = payload.bundle ?? null;
  const receipt =
    payload.receipt === null
      ? null
      : validateReceipt(payload.receipt, normalizeTask(task));
  if ((receipt === null) !== (bundle === null)) {
    throw new Error("Project Memory bundle and receipt must both be present or absent");
  }
  if (receipt && sha256(canonicalJson(bundle)) !== receipt.bundle_sha256) {
    throw new Error("Project Memory receipt bundle hash mismatch");
  }
  return {
    schema_version: 1,
    mode: "SHADOW",
    policy_mode: payload.policy_mode as "SHADOW" | "NORMAL",
    decision: payload.decision as ProjectMemoryDecision,
    would_deny: payload.would_deny,
    denial_reasons: payload.denial_reasons as string[],
    bundle,
    receipt,
  };
}

function validateReceipt(value: unknown, task: string): GatewayReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project Memory receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const required = [
    "schema_version",
    "receipt_id",
    "mode",
    "issued_at",
    "expires_at",
    "task_sha256",
    "repository_head",
    "catalog_sha256",
    "policy_sha256",
    "selected_owners",
    "query_iterations",
    "bundle_sha256",
  ];
  if (
    !hasExactKeys(receipt, required) ||
    receipt.schema_version !== 1 ||
    receipt.mode !== "SHADOW" ||
    !Array.isArray(receipt.selected_owners) ||
    !Array.isArray(receipt.query_iterations)
  ) {
    throw new Error("Invalid Project Memory receipt contract");
  }
  for (const field of [
    "receipt_id",
    "task_sha256",
    "catalog_sha256",
    "policy_sha256",
    "bundle_sha256",
  ]) {
    assertSha256(String(receipt[field]), field);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(receipt.repository_head))) {
    throw new Error("Invalid Project Memory repository HEAD");
  }
  if (receipt.task_sha256 !== sha256(task)) {
    throw new Error("Project Memory receipt task hash mismatch");
  }
  const expiresAt = Date.parse(String(receipt.expires_at));
  const issuedAt = Date.parse(String(receipt.issued_at));
  if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= issuedAt) {
    throw new Error("Invalid Project Memory receipt timestamps");
  }
  for (const owner of receipt.selected_owners as Array<Record<string, unknown>>) {
    if (
      !owner ||
      typeof owner !== "object" ||
      Array.isArray(owner) ||
      !hasExactKeys(owner, [
        "kind",
        "id",
        "source",
        "source_sha256",
        "owner_schema_version",
        "safety_tier",
      ]) ||
      !["feature", "contract", "trap"].includes(String(owner.kind)) ||
      typeof owner.id !== "string" ||
      !owner.id ||
      owner.id.length > 512 ||
      ![1, 2, null].includes(owner.owner_schema_version as 1 | 2 | null) ||
      !["critical", "standard", "legacy"].includes(String(owner.safety_tier))
    ) {
      throw new Error("Invalid Project Memory selected owner contract");
    }
    const source = String(owner.source ?? "");
    if (!source || isPortableAbsolutePath(source) || hasParentSegment(source)) {
      throw new Error("Project Memory receipt contains an unsafe owner path");
    }
    assertSha256(String(owner.source_sha256), "owner source_sha256");
  }
  if ((receipt.query_iterations as Array<Record<string, unknown>>).length === 0) {
    throw new Error("Project Memory receipt has no query iterations");
  }
  for (const iteration of receipt.query_iterations as Array<
    Record<string, unknown>
  >) {
    if (
      !iteration ||
      typeof iteration !== "object" ||
      Array.isArray(iteration) ||
      !hasExactKeys(iteration, [
        "iteration",
        "engine",
        "selector_sha256",
        "max_tokens",
      ]) ||
      !Number.isInteger(iteration.iteration) ||
      Number(iteration.iteration) < 1 ||
      iteration.engine !== "v2" ||
      !Number.isInteger(iteration.max_tokens) ||
      Number(iteration.max_tokens) < 512 ||
      Number(iteration.max_tokens) > 4000
    ) {
      throw new Error("Invalid Project Memory query iteration contract");
    }
    assertSha256(String(iteration.selector_sha256), "selector_sha256");
  }
  const unsigned = { ...receipt };
  delete unsigned.receipt_id;
  if (sha256(canonicalJson(unsigned)) !== receipt.receipt_id) {
    throw new Error("Project Memory receipt signature mismatch");
  }
  const serialized = JSON.stringify(receipt);
  if (task.length >= 4 && serialized.includes(task)) {
    throw new Error("Project Memory receipt contains raw task text");
  }
  return receipt as GatewayReceipt;
}

function normalizeTask(task: string): string {
  const normalized = task.trim();
  if (!normalized) throw new Error("Project Memory task must not be empty");
  if (Buffer.byteLength(normalized, "utf8") > 262_144) {
    throw new Error("Project Memory task exceeds 262144 UTF-8 bytes");
  }
  return normalized;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function hasParentSegment(path: string): boolean {
  return normalize(path)
    .split(/[\\/]/)
    .some((part) => part === "..");
}

function isPortableAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid Project Memory ${label}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
