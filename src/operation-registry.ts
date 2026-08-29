import { createHash } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { openDatabase, type DatabaseHandle, type AppDatabase, type SqliteDatabase } from "./db/client.js";
import { operations, type OperationRow } from "./db/schema.js";

export interface OperationRecord {
  operationId: string;
  workspaceId: string | null;
  toolName: string;
  requestHash: string;
  status: "running" | "succeeded" | "failed";
  sideEffectApplied: boolean;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  completedAt: string | null;
}

export type OperationStartOutcome =
  | { status: "new" }
  | { status: "replay"; result: unknown; record: OperationRecord }
  | { status: "in_progress"; record: OperationRecord }
  | { status: "retry_previous_failure"; record: OperationRecord };

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalizeJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

export function computeRequestHash(toolName: string, input: unknown): string {
  const canonical = canonicalizeJson(input);
  return createHash("sha256")
    .update(`${toolName}:${canonical}`)
    .digest("hex");
}

export class OperationRegistry {
  private readonly handle: DatabaseHandle;
  private readonly db: AppDatabase;
  private readonly sqlite: SqliteDatabase;

  constructor(stateDir: string) {
    this.handle = openDatabase(stateDir);
    this.db = this.handle.db;
    this.sqlite = this.handle.sqlite;
  }

  recordStart(
    operationId: string,
    options: {
      workspaceId?: string;
      toolName: string;
      requestHash: string;
    },
  ): OperationStartOutcome {
    const existing = this.getOperation(operationId);
    if (existing) {
      if (existing.status === "succeeded") {
        return {
          status: "replay",
          result: existing.result,
          record: existing,
        };
      }
      if (existing.status === "running") {
        return {
          status: "in_progress",
          record: existing,
        };
      }
      if (existing.status === "failed") {
        // Reset to running to allow explicit retry
        const now = new Date().toISOString();
        this.db
          .update(operations)
          .set({
            status: "running",
            createdAt: now,
            completedAt: null,
            errorJson: null,
            resultJson: null,
          })
          .where(eq(operations.id, operationId))
          .run();
        return {
          status: "retry_previous_failure",
          record: existing,
        };
      }
    }

    const now = new Date().toISOString();
    this.db
      .insert(operations)
      .values({
        id: operationId,
        workspaceId: options.workspaceId ?? null,
        toolName: options.toolName,
        requestHash: options.requestHash,
        status: "running",
        sideEffectApplied: false,
        createdAt: now,
      })
      .run();

    return { status: "new" };
  }

  recordSuccess(
    operationId: string,
    result: unknown,
    sideEffectApplied = true,
  ): void {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(result);
    this.db
      .update(operations)
      .set({
        status: "succeeded",
        sideEffectApplied,
        resultJson,
        completedAt: now,
      })
      .where(eq(operations.id, operationId))
      .run();
  }

  recordFailure(operationId: string, error: unknown): void {
    const now = new Date().toISOString();
    const errorJson = JSON.stringify(
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : error,
    );
    this.db
      .update(operations)
      .set({
        status: "failed",
        errorJson,
        completedAt: now,
      })
      .where(eq(operations.id, operationId))
      .run();
  }

  getOperation(operationId: string): OperationRecord | null {
    const row = this.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .get();

    if (!row) return null;
    return this.mapRow(row);
  }

  findRecentOperations(
    workspaceId?: string,
    limit = 20,
  ): OperationRecord[] {
    const query = workspaceId
      ? this.db
          .select()
          .from(operations)
          .where(eq(operations.workspaceId, workspaceId))
          .orderBy(desc(operations.createdAt))
          .limit(limit)
      : this.db
          .select()
          .from(operations)
          .orderBy(desc(operations.createdAt))
          .limit(limit);

    return query.all().map((row) => this.mapRow(row));
  }

  close(): void {
    this.handle.close();
  }

  private mapRow(row: OperationRow): OperationRecord {
    let result: unknown;
    let error: unknown;
    if (row.resultJson) {
      try {
        result = JSON.parse(row.resultJson);
      } catch {
        result = row.resultJson;
      }
    }
    if (row.errorJson) {
      try {
        error = JSON.parse(row.errorJson);
      } catch {
        error = row.errorJson;
      }
    }
    return {
      operationId: row.id,
      workspaceId: row.workspaceId,
      toolName: row.toolName,
      requestHash: row.requestHash,
      status: row.status as "running" | "succeeded" | "failed",
      sideEffectApplied: Boolean(row.sideEffectApplied),
      result,
      error,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }
}
