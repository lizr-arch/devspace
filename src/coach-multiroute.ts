/** Public API compatible coordinator. Registry and journals own their own state. */
import { DevSpaceInstanceLock } from "./devspace-instance-lock.js";
import type { MultiRouteStoreOptions } from "./coach-routes/protocol.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RouteRegistry } from "./coach-routes/registry.js";
import { RouteQueue, ensureSafeDirectory, type QueueStats } from "./coach-routes/durable-queue.js";
import { RouteError, ROUTE_ID_RE, MESSAGE_ID_RE, OPERATION_ID_RE, SHA256_RE,
 assertString, assertSafeInteger, sha256Hex, buildReviewWakeInstruction, buildDshNotifyInstruction, safeReason,
 type RouteRecord, type RouteEnvelope, type EnqueuedEnvelope, type ClaimedEnvelope,
 type RouteOrigination, type AckResult, type AmbiguousOutcome, type PendingReviewWake,
 type StoreSnapshot } from "./coach-routes/protocol.js";
export * from "./coach-routes/protocol.js";
export class MultiRouteStore extends RouteRegistry {
  private queues = new Map<string, RouteQueue>();
  private readonly ownership: DevSpaceInstanceLock;
  constructor(options: MultiRouteStoreOptions) {
    if (!options || typeof options.stateDir !== "string" || !options.stateDir)
      throw new RouteError("ROUTE_INVALID_INPUT", "stateDir is required");
    // Acquire OS-backed ownership before reading or repairing any route files.
    const ownership = new DevSpaceInstanceLock(ensureSafeDirectory(options.stateDir));
    try { super(options); } catch (error) { ownership.release(); throw error; }
    this.ownership = ownership;
  }
  private queue(routeId: string): RouteQueue {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    if (!ROUTE_ID_RE.test(routeId)) throw new RouteError("ROUTE_INVALID_INPUT", "routeId is invalid");
    let queue = this.queues.get(routeId);
    if (!queue) {
      queue = new RouteQueue(this, routeId, join(this.stateDir, "routes", routeId));
      this.queues.set(routeId, queue);
    }
    return queue;
  }

  // -- queue ----------------------------------------------------------------

  private requireActiveRoute(routeId: string): RouteRecord {
    const route = this.routes.get(routeId);
    if (!route) throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    if (route.state !== "active") throw new RouteError("ROUTE_REVOKED", "route is not active");
    return route;
  }

  /**
   * Enqueue one durable DSH->WebGPT fixed review wake. The payload is built by
   * this module from immutable identity; callers cannot inject free text.
   */
  enqueueReviewWake(input: { routeId: string; messageId: string; eventId: number; operationId: string }): EnqueuedEnvelope {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    const route = this.requireActiveRoute(routeId);
    const messageId = assertString(input?.messageId, "messageId", MESSAGE_ID_RE);
    const eventId = assertSafeInteger(input?.eventId, "eventId", 1, Number.MAX_SAFE_INTEGER);
    const operationId = assertString(input?.operationId, "operationId", OPERATION_ID_RE);
    const content = buildReviewWakeInstruction({ routeId, messageId, eventId, operationId, workspaceId: route.workspaceId });
    if (Buffer.byteLength(content, "utf8") > this.maxMessageBytes) throw new RouteError("ROUTE_INVALID_INPUT", "review wake is too large");
    return this.appendEnvelope({
      routeId, workspaceId: route.workspaceId, dshSessionId: route.dshSessionId, chatId: route.chatId,
      messageId, contentSha256: sha256Hex(content), kind: "REVIEW_WAKE", origination: "dsh",
      content, data: { eventId, operationId },
    });
  }

  /** Called by the trusted receipt adapter after independent source lookup. */
  enqueueDshNotify(input: { routeId: string; messageId: string; eventId: number; operationId: string;
    dshSessionId: string; sourceContentSha256: string; sourceRequestId: string; sourceBody: string }): EnqueuedEnvelope {
    const route = this.requireActiveRoute(assertString(input.routeId, "routeId", ROUTE_ID_RE));
    if (input.dshSessionId !== route.dshSessionId) throw new RouteError("ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    assertString(input.messageId, "messageId", MESSAGE_ID_RE);
    assertString(input.sourceRequestId, "sourceRequestId", MESSAGE_ID_RE);
    assertString(input.sourceContentSha256, "sourceContentSha256", SHA256_RE);
    assertString(input.operationId, "operationId", OPERATION_ID_RE);
    assertSafeInteger(input.eventId, "eventId", 1, Number.MAX_SAFE_INTEGER);
    if (typeof input.sourceBody !== "string" || Buffer.byteLength(input.sourceBody) > this.maxMessageBytes)
      throw new RouteError("ROUTE_QUEUE_LIMIT");
    const content = buildDshNotifyInstruction({ ...input, workspaceId: route.workspaceId });
    return this.appendEnvelope({ routeId: route.routeId, workspaceId: route.workspaceId,
      dshSessionId: route.dshSessionId, chatId: route.chatId, messageId: input.messageId,
      contentSha256: sha256Hex(content), kind: "DSH_MESSAGE_NOTIFY", origination: "dsh", content,
      data: { eventId: input.eventId, operationId: input.operationId,
        sourceContentSha256: input.sourceContentSha256, sourceRequestId: input.sourceRequestId, sourceBody: input.sourceBody } });
  }

  /** Enqueue one WebGPT->DSH reply. It is message data, never a browser instruction. */
  enqueueReply(input: { routeId: string; messageId: string; content: string; inReplyTo: string }): EnqueuedEnvelope {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    const route = this.requireActiveRoute(routeId);
    const messageId = assertString(input?.messageId, "messageId", MESSAGE_ID_RE);
    const inReplyTo = assertString(input?.inReplyTo, "inReplyTo", MESSAGE_ID_RE);
    if (typeof input?.content !== "string" || input.content.length < 1) throw new RouteError("ROUTE_INVALID_INPUT", "reply content is required");
    if (Buffer.byteLength(input.content, "utf8") > this.maxMessageBytes) throw new RouteError("ROUTE_QUEUE_LIMIT", "reply content is too large");
    const queue = this.queue(routeId);
    const target = queue.get(inReplyTo);
    if (!target || target.origination !== "dsh") throw new RouteError("ROUTE_NOT_FOUND", "inReplyTo does not reference a review wake on this route");
    return this.appendEnvelope({
      routeId, workspaceId: route.workspaceId, dshSessionId: route.dshSessionId, chatId: route.chatId,
      messageId, contentSha256: sha256Hex(input.content), kind: "MESSAGE", origination: "webgpt",
      content: input.content, data: { inReplyTo },
    });
  }

  private appendEnvelope(base: Omit<RouteEnvelope, "seq" | "state" | "createdAt" | "updatedAt">): EnqueuedEnvelope {
    const queue = this.queue(base.routeId);
    const now = this.isoIso(this.nowMs());
    const envelope: RouteEnvelope = {
      ...base, seq: queue.nextSeq(), state: "queued", createdAt: now, updatedAt: now,
    };
    const result = queue.enqueue(envelope);
    if (!result.duplicate) {
      this.audit({
        event: "message.enqueued", routeId: base.routeId, messageId: base.messageId,
        seq: result.envelope.seq, contentSha256: base.contentSha256, kind: base.kind,
        origination: base.origination,
      });
    }
    return result;
  }

  claimDeliveries(input: { routeId: string; origination: RouteOrigination; limit?: number }): ClaimedEnvelope[] {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    this.requireActiveRoute(routeId);
    if (input?.origination !== "dsh" && input.origination !== "webgpt") throw new RouteError("ROUTE_INVALID_INPUT", "origination is invalid");
    const limit = input.limit === undefined ? 1 : assertSafeInteger(input.limit, "limit", 1, 8);
    return this.queue(routeId).claim(input.origination, limit, this.deliveryLeaseMs, (envelope) => envelope.kind !== "DSH_MESSAGE_NOTIFY");
  }

  /** Bridge adapter checks live authorization immediately before this synchronous claim. */
  claimTrustedBrowserDeliveries(routeId: string): ClaimedEnvelope[] {
    this.requireActiveRoute(assertString(routeId, "routeId", ROUTE_ID_RE));
    return this.queue(routeId).claim("dsh", 1, this.deliveryLeaseMs);
  }

  recordDeliveryOutcome(input: {
    routeId: string; messageId: string; seq: number; contentSha256: string;
    outcome: AckResult | "not_submitted" | AmbiguousOutcome; reason?: string;
  }): RouteEnvelope {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    this.requireActiveRoute(routeId);
    const messageId = assertString(input?.messageId, "messageId", MESSAGE_ID_RE);
    const seq = assertSafeInteger(input?.seq, "seq", 1, Number.MAX_SAFE_INTEGER);
    const contentSha256 = assertString(input?.contentSha256, "contentSha256", SHA256_RE);
    const allowed = ["dom_submitted", "manual_sent", "acked", "not_submitted", "uncertain", "timeout", "existing_draft", "page_busy", "navigation_mismatch"];
    if (typeof input?.outcome !== "string" || !allowed.includes(input.outcome)) throw new RouteError("ROUTE_INVALID_INPUT", "outcome is invalid");
    const envelope = this.queue(routeId).record(input.outcome, messageId, seq, contentSha256, input.reason);
    this.audit({
      event: "message.outcome", routeId, messageId, seq, outcome: input.outcome, state: envelope.state,
      ...(safeReason(input.reason) ? { reason: safeReason(input.reason) } : {}),
    });
    return envelope;
  }

  resolveAttention(input: { routeId: string; messageId: string; seq: number; contentSha256: string; action: "retry" | "mark_sent"; reason?: string }): RouteEnvelope {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    this.requireActiveRoute(routeId);
    if (input?.action !== "retry" && input.action !== "mark_sent") throw new RouteError("ROUTE_INVALID_INPUT", "action is invalid");
    const envelope = this.queue(routeId).resolve(
      assertString(input?.messageId, "messageId", MESSAGE_ID_RE),
      assertSafeInteger(input?.seq, "seq", 1, Number.MAX_SAFE_INTEGER),
      assertString(input?.contentSha256, "contentSha256", SHA256_RE),
      input.action, input.reason,
    );
    this.audit({ event: "message.resolved", routeId, messageId: input.messageId, action: input.action, state: envelope.state });
    return envelope;
  }

  listMessages(input: { routeId: string; origination?: RouteOrigination; afterSeq?: number; limit?: number }): RouteEnvelope[] {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    if (!this.routes.has(routeId)) throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    if (input?.origination !== undefined && input.origination !== "dsh" && input.origination !== "webgpt") throw new RouteError("ROUTE_INVALID_INPUT", "origination is invalid");
    const afterSeq = input?.afterSeq === undefined ? 0 : assertSafeInteger(input.afterSeq, "afterSeq", 0, Number.MAX_SAFE_INTEGER);
    const limit = input?.limit === undefined ? 50 : assertSafeInteger(input.limit, "limit", 1, 50);
    return this.queue(routeId).list(input?.origination, afterSeq, limit);
  }

  queueStats(routeId: string): QueueStats {
    if (!ROUTE_ID_RE.test(routeId)) throw new RouteError("ROUTE_INVALID_INPUT", "routeId is invalid");
    if (!this.routes.has(routeId)) throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    if (!existsSync(join(this.stateDir, "routes", routeId))) {
      return { queued: 0, delivering: 0, needsAttention: 0, domSubmitted: 0, manualSent: 0, acked: 0, ackedThroughSeq: 0, lastSeq: 0 };
    }
    return this.queue(routeId).stats();
  }

  pendingReviewWakes(routeId?: string): PendingReviewWake[] {
    if (routeId !== undefined && !this.routes.has(assertString(routeId, "routeId", ROUTE_ID_RE))) {
      throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    }
    const ids = routeId !== undefined ? [routeId] : [...this.routes.keys()];
    return ids.flatMap((id) => {
      if (!existsSync(join(this.stateDir, "routes", id))) return [];
      return this.queue(id).pendingReviewWakes();
    });
  }

  snapshot(): StoreSnapshot {
    const queues: StoreSnapshot["queues"] = {};
    for (const routeId of this.routes.keys()) queues[routeId] = this.queueStats(routeId);
    return {
      consentRevision: this.consentRevision,
      routes: this.allRoutes().map((route) => ({ ...route })),
      legacy: this.legacyRoutes().map((record) => ({ ...record })),
      pendingProposals: this.pendingProposalCount(),
      queues,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.queues.values()) queue.close();
    this.queues.clear();
    this.ownership.release();
  }
}
