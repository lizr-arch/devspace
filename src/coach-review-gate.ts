import { createHash } from "node:crypto";
import { JobResourceLocks, sharedResourceLocks } from "./job-resource-locks.js";
import { captureCodexFingerprint } from "./codex-agent-runner.js";
import type { CoachReviewEventStore } from "./coach-review-events.js";
import type { TaskRunner, TaskRunResult } from "./task-runner.js";

export type ReviewDecision = "APPROVED" | "REWORK" | "BLOCKED";
export interface VerifiedTestProof { taskId: string; sessionId: string; testedFingerprint: string; outputSha256: string; }
export interface ReviewGateOptions {
  events: CoachReviewEventStore;
  tasks: TaskRunner;
  locks?: JobResourceLocks;
  fingerprint?: (root: string) => Promise<{ sha: string; gitSummary: string | null }>;
}

const sha = /^[a-f0-9]{64}$/;
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class CoachReviewGate {
  private readonly locks: JobResourceLocks;
  private readonly fingerprint: NonNullable<ReviewGateOptions["fingerprint"]>;
  constructor(private readonly options: ReviewGateOptions) {
    this.locks = options.locks ?? sharedResourceLocks;
    this.fingerprint = options.fingerprint ?? captureCodexFingerprint;
  }

  async verifyTest(input: { workspaceId: string; workspaceRoot: string; eventId: number; taskId: string; }): Promise<VerifiedTestProof> {
    const packet = this.packet(input.workspaceId, input.eventId);
    if (packet.workspaceId !== input.workspaceId) throw new Error("COACH_REVIEW_WORKSPACE_MISMATCH");
    const previous = this.options.events.getVerifiedTest(input.eventId);
    if (previous) {
      if (previous.workspace_id !== input.workspaceId || previous.task_id !== input.taskId ||
          previous.tested_fingerprint !== packet.finalFingerprint)
        throw new Error("COACH_TEST_PROOF_CONFLICT");
      const current=await this.fingerprint(input.workspaceRoot);
      if (current.sha !== packet.finalFingerprint) throw new Error("COACH_REVIEW_STALE_EVIDENCE");
      return {taskId:previous.task_id,sessionId:previous.session_id,
        testedFingerprint:previous.tested_fingerprint,outputSha256:previous.output_sha256};
    }
    const before = await this.fingerprint(input.workspaceRoot);
    if (before.sha !== packet.finalFingerprint) throw new Error("COACH_REVIEW_STALE_EVIDENCE");
    const result = await this.options.tasks.runTask({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, taskId: input.taskId, params: {}, additionalRoots: [] });
    const after = await this.fingerprint(input.workspaceRoot);
    const task = result as TaskRunResult;
    if (task.status !== "succeeded" || task.exitCode !== 0 || before.sha !== after.sha)
      throw new Error("COACH_REVIEW_TEST_NOT_VERIFIED");
    const proof = { taskId: task.taskId, sessionId: task.sessionId, testedFingerprint: after.sha,
      outputSha256: digest(JSON.stringify({ stdout: task.stdout, stderr: task.stderr })) };
    this.options.events.recordVerifiedTest({ eventId: input.eventId, workspaceId: input.workspaceId, ...proof });
    return proof;
  }

  async submit(input: { workspaceId: string; workspaceRoot: string; operationId: string; eventId: number; decision: ReviewDecision; evidenceSha256: string; }): Promise<unknown> {
    if (!sha.test(input.evidenceSha256)) throw new TypeError("COACH_REVIEW_INVALID_EVIDENCE_SHA");
    const lease = `coach-review:${input.workspaceId}:${input.operationId}`;
    this.locks.acquire({ jobId: lease, runner: "sidecar", workspaceRoot: input.workspaceRoot, requests: [{ kind: "workspace", value: input.workspaceRoot }] });
    try {
      const packet = this.packet(input.workspaceId, input.eventId);
      if (packet.operationId !== input.operationId || packet.evidenceSha256 !== input.evidenceSha256) throw new Error("COACH_REVIEW_EVIDENCE_MISMATCH");
      if ((await this.fingerprint(input.workspaceRoot)).sha !== packet.finalFingerprint) throw new Error("COACH_REVIEW_STALE_EVIDENCE");
      if (input.decision === "APPROVED") {
        const proof=this.options.events.getVerifiedTest(input.eventId);
        if (!proof || proof.workspace_id !== input.workspaceId ||
            proof.tested_fingerprint !== packet.finalFingerprint)
          throw new Error("COACH_REVIEW_TEST_REQUIRED");
      }
      return this.options.events.submitReview({ workspaceId: input.workspaceId, eventId: input.eventId, decision: input.decision, evidenceSha256: input.evidenceSha256 });
    } finally { this.locks.release(lease); }
  }

  private packet(workspaceId: string, eventId: number): Record<string, any> {
    const row = this.options.events.getEvidenceByEvent(workspaceId, eventId) as Record<string, any> | undefined;
    if (!row || typeof row.finalFingerprint !== "string") throw new Error("COACH_REVIEW_EVIDENCE_NOT_FOUND");
    return row;
  }
}
