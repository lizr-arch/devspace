/* Durable queue owner: framed append, cursor and delivery state. */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
 readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_STORE_BYTES, MAX_FRAME_HEADER, RouteError, sha256Hex, isRecord, MESSAGE_ID_RE,
 SHA256_RE, safeReason, type RouteEnvelope, type Transition, type RouteMessageState,
 type EnqueuedEnvelope, type RouteOrigination, type ClaimedEnvelope, type AckResult,
 type AmbiguousOutcome, type PendingReviewWake, type RouteWakeData } from "./protocol.js";
export interface QueueContext {
 maxMessageBytes: number; maxQueuedPerRoute: number;
 nowMs(): number; isoNow(): string; audit(record: Record<string, unknown>): void;
}
interface DecodedFrame { payload: Buffer; object: unknown; sha: string; }
interface DecodedLog { frames: DecodedFrame[]; completeBytes: number; halfTailBytes: number; }

/**
 * Create/verify one state directory and return its canonical path. The final
 * path component must never be a symlink; resolving ancestor symlinks (e.g.
 * macOS /var -> /private/var) is expected and keeps every derived path stable.
 */
export function ensureSafeDirectory(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RouteError("ROUTE_STORE_CORRUPT", "route state directory is unsafe");
  return realpathSync(path);
}

export function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  ensureSafeDirectory(dir);
  const text = JSON.stringify(value);
  const tmp = path + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let offset = 0;
    const bytes = Buffer.from(text, "utf8");
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

export function readFrames(path: string, maxPayload = MAX_STORE_BYTES): DecodedLog {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { frames: [], completeBytes: 0, halfTailBytes: 0 };
    throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal is unreadable");
  }
  const frames: DecodedFrame[] = [];
  let position = 0;
  while (position < bytes.length) {
    const headerEnd = bytes.indexOf(0x0a, position);
    if (headerEnd < 0) {
      // A crash can tear a header; the torn tail is never a message.
      if (bytes.length - position > MAX_FRAME_HEADER + 32) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal header is corrupt");
      break;
    }
    const header = bytes.subarray(position, headerEnd).toString("utf8");
    const headerMatch = /^BEGIN 1 ([0-9]{1,7})$/.exec(header);
    if (!headerMatch) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal frame header is corrupt");
    const length = Number(headerMatch[1]);
    if (!Number.isSafeInteger(length) || length < 1 || length > maxPayload) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal frame length is invalid");
    }
    const payloadStart = headerEnd + 1;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 1 > bytes.length) break;
    if (bytes[payloadEnd] !== 0x0a) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal frame separator is corrupt");
    const trailerEnd = bytes.indexOf(0x0a, payloadEnd + 1);
    if (trailerEnd < 0) break;
    const trailer = bytes.subarray(payloadEnd + 1, trailerEnd).toString("utf8");
    const trailerMatch = /^END ([a-f0-9]{64})$/.exec(trailer);
    if (!trailerMatch) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal frame trailer is corrupt");
    const payload = bytes.subarray(payloadStart, payloadEnd);
    const digest = sha256Hex(payload);
    if (digest !== trailerMatch[1]) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal frame checksum mismatch");
    let object: unknown;
    try {
      object = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal payload is not JSON");
    }
    frames.push({ payload, object, sha: digest });
    position = trailerEnd + 1;
  }
  return { frames, completeBytes: position, halfTailBytes: bytes.length - position };
}

export function encodeFrame(object: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(object), "utf8");
  if (payload.length < 1 || payload.length > MAX_STORE_BYTES) throw new RouteError("ROUTE_INVALID_INPUT", "frame payload is too large");
  const digest = sha256Hex(payload);
  return Buffer.concat([
    Buffer.from("BEGIN 1 " + payload.length + "\n", "utf8"),
    payload,
    Buffer.from("\nEND " + digest + "\n", "utf8"),
  ]);
}

/** Append-only writer that refuses to write past an externally changed size. */
class FrameWriter {
  private fd?: number;
  private currentSize = 0;
  constructor(private readonly path: string) {}
  open(expectedSize: number): void {
    ensureSafeDirectory(dirname(this.path));
    try {
      this.fd = openSync(this.path, "a+", 0o600);
    } catch {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal is not writable");
    }
    const actual = statSync(this.path).size;
    if (actual !== expectedSize) {
      closeSync(this.fd);
      this.fd = undefined;
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal size changed outside the store");
    }
    this.currentSize = actual;
    fsyncSync(this.fd);
  }
  append(object: unknown): void {
    if (this.fd === undefined) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal writer is closed");
    const frame = encodeFrame(object);
    if (statSync(this.path).size !== this.currentSize) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal size changed outside the store");
    }
    try {
      let offset = 0;
      while (offset < frame.length) offset += writeSync(this.fd, frame, offset, frame.length - offset);
      fsyncSync(this.fd);
    } catch {
      // A torn append is not a message. Fail closed; the next open truncates
      // the incomplete tail after an END+SHA check.
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal append failed");
    }
    this.currentSize += frame.length;
    if (statSync(this.path).size !== this.currentSize) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal append was not durable");
    }
  }
  /** Truncate a torn tail. Only ever called while opening a route journal. */
  repair(expectedSize: number): void {
    if (!existsSync(this.path)) return;
    const actual = statSync(this.path).size;
    if (actual > expectedSize) {
      const fd = openSync(this.path, "r+");
      try { ftruncateSync(fd, expectedSize); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  close(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
  }
}

export function readJsonRecord(path: string): unknown {
  try {
    if (statSync(path).size > MAX_STORE_BYTES) throw new RouteError("ROUTE_STORE_CORRUPT", "route state file is too large");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof RouteError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new RouteError("ROUTE_STORE_CORRUPT", "route state file is corrupt");
  }
}

// ---------------------------------------------------------------------------
// Per-route durable queue
// ---------------------------------------------------------------------------

export interface QueueStats {
  queued: number; delivering: number; needsAttention: number;
  domSubmitted: number; manualSent: number; acked: number;
  ackedThroughSeq: number; lastSeq: number;
}

export class RouteQueue {
  readonly dir: string;
  private readonly queuePath: string;
  private readonly statePath: string;
  private readonly cursorPath: string;
  private queueWriter: FrameWriter;
  private stateWriter: FrameWriter;
  private envelopes = new Map<string, RouteEnvelope>();
  private order: string[] = [];
  private transitions = new Map<string, Transition[]>();
  private lastSeq = 0;
  private ackedThroughSeq = 0;
  private poisoned = false;

  constructor(private readonly store: QueueContext, readonly routeId: string, dir: string) {
    this.dir = dir;
    this.queuePath = join(dir, "queue.blocks");
    this.statePath = join(dir, "state.blocks");
    this.cursorPath = join(dir, "cursor.json");
    this.queueWriter = new FrameWriter(this.queuePath);
    this.stateWriter = new FrameWriter(this.statePath);
    this.open();
  }

  private open(): void {
    if (this.poisoned) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route queue is unusable");
    ensureSafeDirectory(this.dir);
    const queueLog = readFrames(this.queuePath, this.store.maxMessageBytes + 4096);
    const stateLog = readFrames(this.statePath, 4096);
    let repaired = false;
    if (queueLog.halfTailBytes > 0) { this.queueWriter.repair(queueLog.completeBytes); repaired = true; }
    if (stateLog.halfTailBytes > 0) { this.stateWriter.repair(stateLog.completeBytes); repaired = true; }
    for (const frame of queueLog.frames) {
      const envelope = this.validateEnvelope(frame.object);
      if (envelope.routeId !== this.routeId) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal contains a foreign route payload");
      if (this.envelopes.has(envelope.messageId)) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal contains a duplicate messageId");
      this.envelopes.set(envelope.messageId, envelope);
      this.order.push(envelope.messageId);
      if (envelope.seq !== this.lastSeq + 1) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route journal sequence is not contiguous");
      this.lastSeq = envelope.seq;
    }
    for (const frame of stateLog.frames) this.pushTransition(frame.object as Transition);
    this.queueWriter.open(queueLog.completeBytes);
    this.stateWriter.open(stateLog.completeBytes);
    const cursor = this.readCursor();
    const rebuilt = this.computeAckedThrough();
    this.ackedThroughSeq = rebuilt;
    if (!cursor || cursor.routeId !== this.routeId || cursor.ackedThroughSeq !== rebuilt || cursor.lastSeq !== this.lastSeq) {
      this.writeCursor();
    }
    if (repaired) this.store.audit({ event: "queue.repaired-truncated-tail", routeId: this.routeId });
  }

  private validateEnvelope(value: unknown): RouteEnvelope {
    if (!isRecord(value)) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route envelope is not an object");
    const envelope = value as unknown as RouteEnvelope;
    if (envelope.routeId !== this.routeId) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route envelope routeId mismatch");
    for (const key of ["messageId", "contentSha256", "createdAt", "updatedAt", "kind", "origination", "state", "content"] as const) {
      if (typeof (envelope as unknown as Record<string, unknown>)[key] !== "string") {
        throw new RouteError("ROUTE_QUEUE_CORRUPT", "route envelope field is invalid");
      }
    }
    if (!MESSAGE_ID_RE.test(envelope.messageId) || !SHA256_RE.test(envelope.contentSha256) ||
        !Number.isSafeInteger(envelope.seq) || envelope.seq < 1 ||
        (!["REVIEW_WAKE", "CODEX_REVIEW_WAKE", "DSH_MESSAGE_NOTIFY", "MESSAGE"].includes(envelope.kind)) ||
        (envelope.origination !== "dsh" && envelope.origination !== "webgpt") ||
        sha256Hex(envelope.content) !== envelope.contentSha256) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route envelope identity is invalid");
    }
    return envelope;
  }

  private readCursor(): { routeId?: string; ackedThroughSeq?: number; lastSeq?: number } | undefined {
    let raw: unknown;
    try {
      raw = readJsonRecord(this.cursorPath);
    } catch {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route cursor is corrupt");
    }
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route cursor is corrupt");
    const routeId = raw.routeId;
    const ackedThroughSeq = raw.ackedThroughSeq;
    const lastSeq = raw.lastSeq;
    if (typeof routeId !== "string" || !Number.isSafeInteger(ackedThroughSeq) || !Number.isSafeInteger(lastSeq) || (lastSeq as number) < 0 || (ackedThroughSeq as number) < 0) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route cursor is corrupt");
    }
    return { routeId, ackedThroughSeq: ackedThroughSeq as number, lastSeq: lastSeq as number };
  }

  private writeCursor(): void {
    atomicWriteJson(this.cursorPath, {
      routeId: this.routeId,
      ackedThroughSeq: this.ackedThroughSeq,
      lastSeq: this.lastSeq,
      updatedAt: this.store.isoNow(),
    });
  }

  private pushTransition(transition: Transition): void {
    if (!isRecord(transition) || typeof transition.messageId !== "string" || !Number.isSafeInteger(transition.seq)) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route state transition is invalid");
    }
    const envelope = this.envelopes.get(transition.messageId);
    if (!envelope || envelope.seq !== transition.seq || envelope.contentSha256 !== transition.contentSha256) {
      throw new RouteError("ROUTE_QUEUE_CORRUPT", "route state transition does not match a queued message");
    }
    const list = this.transitions.get(transition.messageId) ?? [];
    list.push(transition);
    this.transitions.set(transition.messageId, list);
  }

  /** Validate a live transition against the folded state before it is durable. */
  private validateTransition(transition: Transition): void {
    if (!isRecord(transition) || typeof transition.messageId !== "string" || !Number.isSafeInteger(transition.seq)) {
      throw new RouteError("ROUTE_INVALID_INPUT", "route state transition is invalid");
    }
    const envelope = this.envelopes.get(transition.messageId);
    if (!envelope || envelope.seq !== transition.seq || envelope.contentSha256 !== transition.contentSha256) {
      throw new RouteError("ROUTE_ACK_CONFLICT", "transition identity does not match the queued message");
    }
    const current = this.foldState(transition.messageId);
    const allowed: Record<RouteMessageState, RouteMessageState[]> = {
      queued: ["delivering", "dom_submitted", "manual_sent", "acked", "needs_attention"],
      delivering: ["delivering", "dom_submitted", "manual_sent", "acked", "needs_attention", "queued"],
      needs_attention: ["queued", "manual_sent"],
      dom_submitted: [], manual_sent: [], acked: [],
    };
    if (!allowed[current].includes(transition.state)) {
      throw new RouteError("ROUTE_STATE_TRANSITION_DENIED", `illegal transition ${current} -> ${transition.state}`);
    }
  }

  private appendTransition(transition: Transition): void {
    this.validateTransition(transition);
    this.stateWriter.append(transition);
    this.pushTransition(transition);
    this.ackedThroughSeq = this.computeAckedThrough();
    this.writeCursor();
  }

  private foldState(messageId: string): RouteMessageState {
    const envelope = this.envelopes.get(messageId);
    if (!envelope) throw new RouteError("ROUTE_NOT_FOUND", "route message not found");
    const list = this.transitions.get(messageId);
    return list && list.length ? list[list.length - 1].state : envelope.state;
  }

  private latestTransition(messageId: string): Transition | undefined {
    const list = this.transitions.get(messageId);
    return list && list.length ? list[list.length - 1] : undefined;
  }

  private view(envelope: RouteEnvelope): RouteEnvelope {
    const last = this.latestTransition(envelope.messageId);
    return { ...envelope, data: structuredClone(envelope.data), state: last?.state ?? envelope.state, updatedAt: last?.at ?? envelope.updatedAt };
  }

  get(messageId: string): RouteEnvelope | undefined {
    const envelope = this.envelopes.get(messageId);
    return envelope ? this.view(envelope) : undefined;
  }

  nextSeq(): number { return this.lastSeq + 1; }

  enqueue(envelope: RouteEnvelope): EnqueuedEnvelope {
    const existing = this.envelopes.get(envelope.messageId);
    if (existing) {
      if (existing.contentSha256 !== envelope.contentSha256 || existing.kind !== envelope.kind ||
          existing.origination !== envelope.origination || existing.dshSessionId !== envelope.dshSessionId ||
          JSON.stringify(existing.data) !== JSON.stringify(envelope.data)) {
        throw new RouteError("ROUTE_PAYLOAD_CONFLICT", "messageId already exists with a different payload");
      }
      return { envelope: this.view(existing), duplicate: true };
    }
    if (this.envelopes.size >= this.store.maxQueuedPerRoute) {
      throw new RouteError("ROUTE_QUEUE_LIMIT", "route queue is full");
    }
    if (envelope.seq !== this.lastSeq + 1) throw new RouteError("ROUTE_QUEUE_CORRUPT", "route sequence is not monotonic");
    try {
      this.queueWriter.append(envelope);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    this.envelopes.set(envelope.messageId, envelope);
    this.order.push(envelope.messageId);
    this.lastSeq = envelope.seq;
    this.writeCursor();
    return { envelope: this.view(envelope), duplicate: false };
  }

  claim(origination: RouteOrigination, limit: number, leaseMs: number, eligible: (envelope: RouteEnvelope) => boolean = () => true): ClaimedEnvelope[] {
    const now = this.store.nowMs();
    const out: ClaimedEnvelope[] = [];
    for (const messageId of this.order) {
      if (out.length >= limit) break;
      const envelope = this.envelopes.get(messageId)!;
      if (envelope.origination !== origination || !eligible(envelope)) continue;
      const state = this.foldState(messageId);
      const last = this.latestTransition(messageId);
      let claimable = state === "queued";
      if (state === "delivering") claimable = (last?.leaseUntil ?? 0) <= now;
      if (!claimable) continue;
      // Attempts are counted from durable delivery attempts, never reset by an
      // operator retry or a crash recovery.
      const attempt = (this.transitions.get(messageId) ?? []).filter((entry) => entry.state === "delivering").length + 1;
      const leaseUntil = now + leaseMs;
      this.appendTransition({
        messageId, seq: envelope.seq, contentSha256: envelope.contentSha256,
        state: "delivering", at: this.store.isoNow(), attempt, leaseUntil,
      });
      out.push({ ...this.view(envelope), attempt, leaseUntil });
    }
    return out;
  }

  record(outcome: AckResult | "not_submitted" | AmbiguousOutcome, messageId: string, seq: number, contentSha256: string, reason?: string): RouteEnvelope {
    const envelope = this.envelopes.get(messageId);
    if (!envelope) throw new RouteError("ROUTE_NOT_FOUND", "route message not found");
    if (envelope.seq !== seq || envelope.contentSha256 !== contentSha256) {
      throw new RouteError("ROUTE_ACK_CONFLICT", "ack identity does not match the queued message");
    }
    const current = this.foldState(messageId);
    if (terminal(current)) {
      const last = this.latestTransition(messageId);
      const same = last && ((last.result ?? last.state) === outcome || last.state === outcome);
      if (same) return this.view(envelope);
      throw new RouteError("ROUTE_ACK_CONFLICT", "message already reached a different terminal state");
    }
    if (current === "needs_attention") {
      throw new RouteError("ROUTE_ACK_CONFLICT", "message requires explicit resolution before any further ack");
    }
    const cleanReason = safeReason(reason);
    if (outcome === "dom_submitted" || outcome === "manual_sent" || outcome === "acked") {
      this.appendTransition({ messageId, seq, contentSha256, state: outcome, at: this.store.isoNow(), result: outcome, ...(cleanReason ? { reason: cleanReason } : {}) });
    } else if (outcome === "not_submitted") {
      this.appendTransition({ messageId, seq, contentSha256, state: "queued", at: this.store.isoNow(), result: "not_submitted", ...(cleanReason ? { reason: cleanReason } : {}) });
    } else {
      this.appendTransition({ messageId, seq, contentSha256, state: "needs_attention", at: this.store.isoNow(), outcome, ...(cleanReason ? { reason: cleanReason } : {}) });
    }
    return this.view(envelope);
  }

  resolve(messageId: string, seq: number, contentSha256: string, action: "retry" | "mark_sent", reason?: string): RouteEnvelope {
    const envelope = this.envelopes.get(messageId);
    if (!envelope) throw new RouteError("ROUTE_NOT_FOUND", "route message not found");
    if (envelope.seq !== seq || envelope.contentSha256 !== contentSha256) {
      throw new RouteError("ROUTE_ACK_CONFLICT", "resolution identity does not match the queued message");
    }
    if (this.foldState(messageId) !== "needs_attention") {
      throw new RouteError("ROUTE_STATE_TRANSITION_DENIED", "only needs_attention messages may be resolved");
    }
    const cleanReason = safeReason(reason);
    if (action === "retry") {
      this.appendTransition({ messageId, seq, contentSha256, state: "queued", at: this.store.isoNow(), ...(cleanReason ? { reason: cleanReason } : {}) });
    } else {
      this.appendTransition({ messageId, seq, contentSha256, state: "manual_sent", at: this.store.isoNow(), result: "manual_sent", ...(cleanReason ? { reason: cleanReason } : {}) });
    }
    return this.view(envelope);
  }

  list(origination?: RouteOrigination, afterSeq = 0, limit = 50): RouteEnvelope[] {
    const out: RouteEnvelope[] = [];
    for (const messageId of this.order) {
      const envelope = this.envelopes.get(messageId)!;
      if (envelope.seq <= afterSeq) continue;
      if (origination && envelope.origination !== origination) continue;
      out.push(this.view(envelope));
      if (out.length >= limit) break;
    }
    return out;
  }

  stats(): QueueStats {
    let queued = 0, delivering = 0, needsAttention = 0, domSubmitted = 0, manualSent = 0, acked = 0;
    for (const messageId of this.order) {
      switch (this.foldState(messageId)) {
        case "queued": queued++; break;
        case "delivering": delivering++; break;
        case "needs_attention": needsAttention++; break;
        case "dom_submitted": domSubmitted++; break;
        case "manual_sent": manualSent++; break;
        case "acked": acked++; break;
      }
    }
    return { queued, delivering, needsAttention, domSubmitted, manualSent, acked, ackedThroughSeq: this.ackedThroughSeq, lastSeq: this.lastSeq };
  }

  computeAckedThrough(): number {
    let through = 0;
    for (const messageId of this.order) {
      const envelope = this.envelopes.get(messageId)!;
      if (envelope.seq !== through + 1) break;
      if (!terminal(this.foldState(messageId))) break;
      through = envelope.seq;
    }
    return through;
  }

  /** Messages whose browser DOM submission has no corresponding GPT reply yet. */
  pendingReviewWakes(): PendingReviewWake[] {
    const replied = new Set<string>();
    for (const messageId of this.order) {
      const envelope = this.envelopes.get(messageId)!;
      if (envelope.origination === "webgpt" && isRecord(envelope.data) && typeof (envelope.data as { inReplyTo?: unknown }).inReplyTo === "string") {
        replied.add((envelope.data as { inReplyTo: string }).inReplyTo);
      }
    }
    const out: PendingReviewWake[] = [];
    for (const messageId of this.order) {
      const envelope = this.envelopes.get(messageId)!;
      if (envelope.origination !== "dsh") continue;
      const state = this.foldState(messageId);
      if (state !== "dom_submitted" && state !== "manual_sent") continue;
      if (replied.has(messageId)) continue;
      const data = envelope.data as RouteWakeData;
      const last = this.latestTransition(messageId);
      out.push({
        routeId: this.routeId, messageId, seq: envelope.seq,
        eventId: data.eventId, operationId: data.operationId, workspaceId: envelope.workspaceId,
        state, submittedAt: last?.at ?? envelope.updatedAt,
      });
    }
    return out;
  }

  close(): void {
    this.queueWriter.close();
    this.stateWriter.close();
  }
}

function terminal(state: RouteMessageState): boolean {
  return state === "dom_submitted" || state === "manual_sent" || state === "acked";
}

