/**
 * Job storage lifecycle and a READ-ONLY cleanup preview.
 *
 * DevSpace never deletes job state on its own. That is deliberate, but it means
 * `jobs/` grows without bound, and an unbounded store is its own failure mode.
 * This module classifies every record so an operator can see what is safe to
 * age out — and, just as importantly, what must never be aged out:
 *
 *   running           a job that has not settled: never touched
 *   recovery_pending  a job whose process group could not be confirmed dead,
 *                     or that was interrupted by a restart: never touched,
 *                     because the pid/token tuple is still needed to reap it
 *   failure_evidence  failed / timed_out / cancelled / interrupted: never
 *                     touched. A failed run IS the evidence of what went wrong;
 *                     expiring it would silently destroy forensics
 *   unattributed      unparseable or missing metadata: never touched, because
 *                     ownership cannot be established
 *   expirable         succeeded, settled, and older than the retention window.
 *                     These are the ONLY records a cleanup could ever consider.
 *
 * The preview reports what a cleanup WOULD do. It does not delete anything, and
 * there is no code path here that does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type JobRetentionClass =
  | "running"
  | "recovery_pending"
  | "failure_evidence"
  | "expirable"
  | "unattributed";

export const JOB_RETENTION_CLASSES: readonly JobRetentionClass[] = [
  "running",
  "recovery_pending",
  "failure_evidence",
  "expirable",
  "unattributed",
];

export interface JobRetentionEntry {
  jobId: string;
  status: string;
  classification: JobRetentionClass;
  endedAt: string | null;
  ageDays: number | null;
  logBytes: number;
  metadataBytes: number;
  reason: string;
}

export interface JobRetentionPreview {
  policy: {
    succeededRetentionDays: number;
    outcome: "preview_only";
    deletesAnything: false;
  };
  jobsDirectory: string;
  totalRecords: number;
  totalBytes: number;
  byClass: Record<JobRetentionClass, { count: number; bytes: number }>;
  /** Every classified record, in jobId order. */
  records: JobRetentionEntry[];
  /**
   * The only records a cleanup could ever consider: succeeded, settled, and
   * already outside the retention window. Empty until the window passes.
   */
  expirableCandidates: JobRetentionEntry[];
  /** Records that must not be removed, with the reason each is protected. */
  protectedRecords: JobRetentionEntry[];
  notes: string[];
}

/**
 * Default window for successful runs. Chosen to be long enough that a normal
 * debugging session never loses the log of the run it is investigating.
 */
export const DEFAULT_SUCCEEDED_RETENTION_DAYS = 30;

interface PersistedJobLike {
  jobId?: unknown;
  status?: unknown;
  endedAt?: unknown;
  startedAt?: unknown;
  processCleanupPending?: unknown;
  errorCode?: unknown;
}

export function previewJobRetention(input: {
  jobsDirectory: string;
  /** Live job state, so a job running right now is never classified as stale. */
  liveStatus?: (jobId: string) => string | undefined;
  /** Jobs whose process group cleanup is still outstanding. */
  needsRecovery?: (jobId: string) => boolean;
  succeededRetentionDays?: number;
  now?: Date;
}): JobRetentionPreview {
  const retentionDays =
    input.succeededRetentionDays ?? DEFAULT_SUCCEEDED_RETENTION_DAYS;
  const now = input.now ?? new Date();
  const byClass: Record<JobRetentionClass, { count: number; bytes: number }> = {
    running: { count: 0, bytes: 0 },
    recovery_pending: { count: 0, bytes: 0 },
    failure_evidence: { count: 0, bytes: 0 },
    expirable: { count: 0, bytes: 0 },
    unattributed: { count: 0, bytes: 0 },
  };
  const entries: JobRetentionEntry[] = [];
  const notes: string[] = [];
  let totalBytes = 0;

  let files: string[] = [];
  try {
    files = readdirSync(input.jobsDirectory);
  } catch {
    return {
      policy: {
        succeededRetentionDays: retentionDays,
        outcome: "preview_only",
        deletesAnything: false,
      },
      jobsDirectory: input.jobsDirectory,
      totalRecords: 0,
      totalBytes: 0,
      byClass,
      records: [],
      expirableCandidates: [],
      protectedRecords: [],
      notes: ["The jobs directory does not exist yet; there is nothing to retain."],
    };
  }

  const metadataFiles = files.filter((name) => name.endsWith(".json"));
  const jobIds = metadataFiles.map((name) => name.slice(0, -".json".length));

  for (const jobId of jobIds) {
    const metadataPath = join(input.jobsDirectory, `${jobId}.json`);
    const logPath = join(input.jobsDirectory, `${jobId}.log`);
    const metadataBytes = sizeOf(metadataPath);
    const logBytes = sizeOf(logPath);
    const bytes = metadataBytes + logBytes;
    totalBytes += bytes;

    let parsed: PersistedJobLike | null = null;
    try {
      parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as PersistedJobLike;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.jobId !== "string") {
      entries.push(
        entry(
          jobId,
          "unknown",
          "unattributed",
          null,
          null,
          logBytes,
          metadataBytes,
          "Metadata is missing or unreadable, so ownership cannot be established.",
        ),
      );
      continue;
    }

    const live = input.liveStatus?.(jobId);
    const status = live ?? String(parsed.status ?? "unknown");
    const endedAt =
      typeof parsed.endedAt === "string"
        ? parsed.endedAt
        : typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : null;
    const ageDays = endedAt ? (now.getTime() - Date.parse(endedAt)) / 86_400_000 : null;

    if (!isTerminalStatus(status)) {
      entries.push(
        entry(
          jobId,
          status,
          "running",
          endedAt,
          ageDays,
          logBytes,
          metadataBytes,
          "The job has not settled; its log is still being written.",
        ),
      );
      continue;
    }
    if (input.needsRecovery?.(jobId) === true || parsed.processCleanupPending === true) {
      entries.push(
        entry(
          jobId,
          status,
          "recovery_pending",
          endedAt,
          ageDays,
          logBytes,
          metadataBytes,
          "Process-group cleanup is still outstanding; the pid/token tuple is required to reap it.",
        ),
      );
      continue;
    }
    if (status !== "succeeded") {
      entries.push(
        entry(
          jobId,
          status,
          "failure_evidence",
          endedAt,
          ageDays,
          logBytes,
          metadataBytes,
          `A ${status} run is the evidence of what went wrong and is retained indefinitely.`,
        ),
      );
      continue;
    }
    if (ageDays === null) {
      entries.push(
        entry(
          jobId,
          status,
          "unattributed",
          endedAt,
          ageDays,
          logBytes,
          metadataBytes,
          "A succeeded job has no usable timestamp, so its age cannot be established.",
        ),
      );
      continue;
    }
    if (ageDays >= retentionDays) {
      entries.push(
        entry(
          jobId,
          status,
          "expirable",
          endedAt,
          ageDays,
          logBytes,
          metadataBytes,
          `Succeeded ${Math.floor(ageDays)} days ago, beyond the ${retentionDays}-day window.`,
        ),
      );
      continue;
    }
    entries.push(
      entry(
        jobId,
        status,
        "expirable",
        endedAt,
        ageDays,
        logBytes,
        metadataBytes,
        `Succeeded ${Math.floor(ageDays)} days ago, still inside the ${retentionDays}-day window.`,
      ),
    );
  }

  for (const item of entries) {
    byClass[item.classification].count += 1;
    byClass[item.classification].bytes += item.logBytes + item.metadataBytes;
  }

  const expirableCandidates = entries.filter(
    (item) => item.classification === "expirable" && isBeyondWindow(item, retentionDays),
  );
  const protectedRecords = entries.filter(
    (item) => item.classification !== "expirable",
  );

  notes.push(
    "This is a preview. DevSpace does not delete job state, and no cleanup runs automatically.",
  );
  if (expirableCandidates.length === 0) {
    notes.push(
      "No record is currently outside the retention window, so no cleanup would be proposed.",
    );
  }
  if (byClass.failure_evidence.count > 0) {
    notes.push(
      `${byClass.failure_evidence.count} failed/timed-out/cancelled record(s) are retained as evidence and are never proposed for removal.`,
    );
  }
  if (byClass.unattributed.count > 0) {
    notes.push(
      `${byClass.unattributed.count} record(s) could not be attributed and must not be removed without operator review.`,
    );
  }

  return {
    policy: {
      succeededRetentionDays: retentionDays,
      outcome: "preview_only",
      deletesAnything: false,
    },
    jobsDirectory: input.jobsDirectory,
    totalRecords: entries.length,
    totalBytes,
    byClass,
    records: [...entries].sort((left, right) =>
      left.jobId.localeCompare(right.jobId),
    ),
    expirableCandidates,
    protectedRecords,
    notes,
  };
}

function entry(
  jobId: string,
  status: string,
  classification: JobRetentionClass,
  endedAt: string | null,
  ageDays: number | null,
  logBytes: number,
  metadataBytes: number,
  reason: string,
): JobRetentionEntry {
  return {
    jobId,
    status,
    classification,
    endedAt,
    ageDays: ageDays === null ? null : Math.round(ageDays * 100) / 100,
    logBytes,
    metadataBytes,
    reason,
  };
}

function isBeyondWindow(
  item: JobRetentionEntry,
  retentionDays: number,
): boolean {
  return item.ageDays !== null && item.ageDays >= retentionDays;
}

function isTerminalStatus(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
    status,
  );
}

function sizeOf(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}
