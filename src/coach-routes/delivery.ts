/** Trusted transport boundary and durable external-submit owner.
 * No HTTP discovery, credentials, allow/revoke, browser control or fallback target.
 * Host supplies an authenticated bridge connection and a verified WebGPT principal.
 * Without BOTH, real E2E is blocked. sender labels never confer authority.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { MultiRouteStore } from "../coach-multiroute.js";
import { encodeFrame, readFrames, ensureSafeDirectory } from "./durable-queue.js";
import { MESSAGE_ID_RE, SHA256_RE, RouteError, sha256Hex, type RouteRecord, type RouteEnvelope } from "./protocol.js";

export interface BridgeSession { sessionId: string; allowed: boolean; running: boolean; }
export interface BridgeRequest {
  requestId: string; sessionId: string; rpcId: string; state: string;
  accepted: boolean; claimed: boolean; seenUser: boolean; truncated?: boolean;
  messages: { seq: number; text: string }[];
}
export interface BridgeTransport {
  /** Authenticated local bridge lookup, never a caller-supplied receipt object. */
  session(sessionId: string): Promise<BridgeSession | undefined>;
  receipt(requestId: string): Promise<string | undefined>;
  request(requestId: string): Promise<BridgeRequest | undefined>;
  wait(requestId: string): Promise<BridgeRequest | undefined>;
  send(input: { sessionId: string; requestId: string; sender: "webgpt-coach"; text: string }): Promise<BridgeRequest>;
  /** Verify host-provided MCP invocation context, NEVER a field from the tool body. */
  authorizeWebGpt(context: unknown, route: Readonly<RouteRecord>): Promise<boolean>;
}
export type DispatchState = "PREPARED" | "SUBMITTING" | "ACCEPTED" | "COMPLETED" | "UNCERTAIN";
export interface DispatchRecord {
  routeId: string; sessionId: string; consentRevision: number; messageId: string;
  inReplyTo: string; contentSha256: string; requestId: string; state: DispatchState;
}
export interface TrustedReply {
  routeId: string; sessionId: string; consentRevision: number; messageId: string;
  inReplyTo: string; content: string;
}

const activeDispatches = new WeakMap<MultiRouteStore, Set<string>>();
export class RouteBridgeDelivery {
  private readonly busy: Set<string>;
  constructor(private readonly store: MultiRouteStore, private readonly transport: BridgeTransport,
    private readonly sessionScope: () => readonly string[], private readonly workspaceScope: () => readonly string[]) {
    this.busy = activeDispatches.get(store) ?? new Set<string>();
    activeDispatches.set(store, this.busy);
  }

  private route(routeId: string, sessionId?: string, revision?: number): RouteRecord {
    const route = this.store.route(routeId);
    if (!route || route.state !== "active") throw new RouteError("ROUTE_REVOKED");
    if (!this.workspaceScope().includes(route.workspaceId)) throw new RouteError("ROUTE_WORKSPACE_NOT_AUTHORIZED");
    if (!this.sessionScope().includes(route.dshSessionId) || (sessionId !== undefined && sessionId !== route.dshSessionId))
      throw new RouteError("ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    if (revision !== undefined && revision !== route.consentRevision) throw new RouteError("ROUTE_CONSENT_REVISION_MISMATCH");
    return { ...route };
  }
  private async live(route: RouteRecord): Promise<BridgeSession> {
    const session = await this.transport.session(route.dshSessionId);
    // Recheck durable authorization after every asynchronous boundary.
    this.route(route.routeId, route.dshSessionId, route.consentRevision);
    if (!session || session.sessionId !== route.dshSessionId || session.allowed !== true)
      throw new RouteError("ROUTE_DSH_SESSION_NOT_AUTHORIZED");
    return session;
  }

  async ingest(input: { routeId: string; sessionId: string; consentRevision: number;
    requestId: string; seq: number; receiptSha256: string; operationId: string }) {
    const route = this.route(input.routeId, input.sessionId, input.consentRevision);
    if (!MESSAGE_ID_RE.test(input.requestId) || !SHA256_RE.test(input.receiptSha256) ||
        !Number.isSafeInteger(input.seq) || input.seq < 1) throw new RouteError("ROUTE_INVALID_INPUT");
    await this.live(route);
    const raw = await this.transport.receipt(input.requestId);
    this.route(route.routeId, route.dshSessionId, route.consentRevision);
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024 || sha256Hex(raw) !== input.receiptSha256)
      throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    let receipt: BridgeRequest;
    try { receipt = JSON.parse(raw) as BridgeRequest; } catch { throw new Error("BRIDGE_SOURCE_UNVERIFIED"); }
    if (!receipt || typeof receipt !== "object") throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    // Public bridge record is trusted ONLY through the injected authenticated lookup.
    // Its sender is deliberately ignored. A bare from=dsh body has none of these receipts.
    if (receipt.requestId !== input.requestId || receipt.sessionId !== route.dshSessionId ||
        receipt.rpcId !== "dsh-bridge:" + input.requestId || receipt.state !== "completed" ||
        receipt.claimed !== true || receipt.accepted !== true || receipt.seenUser !== true ||
        receipt.truncated === true || !Array.isArray(receipt.messages)) throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    const messages = receipt.messages.filter((message) => message.seq === input.seq);
    if (messages.length !== 1 || typeof messages[0].text !== "string" || !messages[0].text) throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    await this.live(route);
    const messageId = "dsh-" + sha256Hex(JSON.stringify([route.routeId, input.requestId, input.seq])).slice(0, 48);
    return this.store.enqueueDshNotify({ routeId: route.routeId, dshSessionId: route.dshSessionId,
      messageId, eventId: input.seq, operationId: input.operationId,
      sourceContentSha256: input.receiptSha256, sourceRequestId: input.requestId, sourceBody: messages[0].text });
  }

  async claimBrowser(routeId: string) {
    const route = this.route(routeId);
    const session = await this.live(route);
    if (!session.running) return []; // Can ingest/queue while stopped; never pick another session.
    return this.store.claimTrustedBrowserDeliveries(routeId);
  }

  async reply(input: TrustedReply, context: unknown) {
    const route = this.route(input.routeId, input.sessionId, input.consentRevision);
    if (!(await this.transport.authorizeWebGpt(context, route))) throw new Error("BRIDGE_WEBGPT_PRINCIPAL_UNVERIFIED");
    this.route(route.routeId, input.sessionId, input.consentRevision);
    await this.live(route);
    const target = this.store.listMessages({ routeId: route.routeId, limit: 50 });
    // Exact lookup also handles queues longer than one page without guessing.
    let source = target.find((message) => message.messageId === input.inReplyTo);
    let afterSeq = target.at(-1)?.seq ?? 0;
    while (!source && target.length) {
      const page = this.store.listMessages({ routeId: route.routeId, afterSeq, limit: 50 });
      if (!page.length) break;
      source = page.find((message) => message.messageId === input.inReplyTo);
      afterSeq = page.at(-1)!.seq;
    }
    if (source?.kind !== "DSH_MESSAGE_NOTIFY") throw new Error("BRIDGE_REPLY_SOURCE_UNVERIFIED");
    const result = this.store.enqueueReply(input);
    return { ...result, dispatch: await this.dispatch(input.routeId, result.envelope) };
  }

  private identity(route: RouteRecord, message: RouteEnvelope): Omit<DispatchRecord, "state"> {
    if (message.routeId !== route.routeId || message.dshSessionId !== route.dshSessionId ||
        message.origination !== "webgpt" || !("inReplyTo" in message.data)) throw new Error("BRIDGE_REPLY_IDENTITY_MISMATCH");
    const base = { routeId: route.routeId, sessionId: route.dshSessionId, consentRevision: route.consentRevision,
      messageId: message.messageId, inReplyTo: message.data.inReplyTo, contentSha256: message.contentSha256 };
    return { ...base, requestId: "gpt-" + sha256Hex(JSON.stringify(base)) };
  }
  private path(routeId: string): string {
    return join(ensureSafeDirectory(join(this.store.stateDir, "routes", routeId)), "bridge.blocks");
  }
  private latest(identity: Omit<DispatchRecord, "state">): DispatchRecord | undefined {
    const log = readFrames(this.path(identity.routeId));
    // A torn outbound state cannot prove non-submission. Never repair it into a resend.
    if (log.halfTailBytes) throw new Error("BRIDGE_JOURNAL_UNCERTAIN");
    let last: DispatchRecord | undefined;
    for (const frame of log.frames) {
      const record = frame.object as DispatchRecord;
      if (record.messageId !== identity.messageId) continue;
      const { state, ...base } = record;
      if (JSON.stringify(base) !== JSON.stringify(identity) ||
          !["PREPARED", "SUBMITTING", "ACCEPTED", "COMPLETED", "UNCERTAIN"].includes(state)) throw new Error("BRIDGE_JOURNAL_CONFLICT");
      last = record;
    }
    return last;
  }
  private save(identity: Omit<DispatchRecord, "state">, state: DispatchState): DispatchRecord {
    const record = { ...identity, state };
    const path = this.path(identity.routeId);
    const fd = openSync(path, "a", 0o600);
    try {
      const bytes = encodeFrame(record);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const dir = openSync(join(this.store.stateDir, "routes", identity.routeId), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return record;
  }
  private reconcile(identity: Omit<DispatchRecord, "state">, receipt: BridgeRequest | undefined): DispatchRecord {
    if (!receipt || receipt.requestId !== identity.requestId || receipt.sessionId !== identity.sessionId ||
        receipt.rpcId !== "dsh-bridge:" + identity.requestId) return this.save(identity, "UNCERTAIN");
    if (receipt.state === "completed" && receipt.accepted && receipt.claimed && receipt.seenUser)
      return this.save(identity, "COMPLETED");
    if (["accepted", "executing"].includes(receipt.state) && receipt.accepted) return this.save(identity, "ACCEPTED");
    return this.save(identity, "UNCERTAIN");
  }
  private async dispatch(routeId: string, message: RouteEnvelope): Promise<DispatchRecord> {
    const route = this.route(routeId);
    const identity = this.identity(route, message);
    if (this.busy.has(identity.requestId)) throw new Error("BRIDGE_DISPATCH_IN_PROGRESS");
    this.busy.add(identity.requestId);
    try {
      const prior = this.latest(identity);
      if (prior?.state === "COMPLETED") return prior;
      if (prior && prior.state !== "PREPARED") {
        // Reconcile only; even request-not-found does not authorize another POST.
        let receipt: BridgeRequest | undefined;
        try {
          receipt = await this.transport.request(identity.requestId);
          if (receipt && ["accepted", "executing"].includes(receipt.state)) receipt = await this.transport.wait(identity.requestId);
        } catch { return this.save(identity, "UNCERTAIN"); }
        this.route(routeId, route.dshSessionId, route.consentRevision);
        return this.reconcile(identity, receipt);
      }
      const session = await this.live(route);
      if (!prior) this.save(identity, "PREPARED");
      if (!session.running) return { ...identity, state: "PREPARED" };
      this.route(routeId, route.dshSessionId, route.consentRevision);
      this.save(identity, "SUBMITTING"); // fsync BEFORE the only external non-idempotent call
      let receipt: BridgeRequest;
      try {
        receipt = await this.transport.send({ sessionId: route.dshSessionId, requestId: identity.requestId,
          sender: "webgpt-coach", text: message.content });
      } catch { return this.save(identity, "UNCERTAIN"); }
      return this.reconcile(identity, receipt); // fsync AFTER response; DOM ACK is never used here
    } finally { this.busy.delete(identity.requestId); }
  }
}
