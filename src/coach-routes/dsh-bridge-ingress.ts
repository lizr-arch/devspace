/**
 * P6 minimal one-way wiring: authenticated DSH Session Bridge completion
 * receipt -> existing RouteBridgeDelivery.ingest -> durable route queue.
 *
 * It deliberately does NOT add a second queue, a second DOM inserter, a WebGPT
 * owner/principal substitute, or any automatic reply. The existing Chrome
 * autoMultiPump already consumes the route queue once the Sidecar is running.
 *
 * Trust boundary:
 *  - only the local bridge's loopback HTTP API (127.0.0.1, private auth file,
 *    no redirects/proxy) supplies the raw request/receipt;
 *  - RouteBridgeDelivery independently re-fetches and hashes that receipt;
 *  - DSH message text remains queue data; the fixed review prompt is built by
 *    enqueueDshNotify and cannot be changed by DSH text;
 *  - completed + accepted + claimed + seenUser + non-truncated is required;
 *  - uncertain/stopped/rejected are never re-sent and never ingested as a wake.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { BridgeRequest, BridgeSession, BridgeTransport, RouteBridgeDelivery } from "./delivery.js";
import { MESSAGE_ID_RE, RouteError, sha256Hex } from "./protocol.js";
import type { EnqueuedEnvelope } from "./protocol.js";

const ID_RE = /^[A-Za-z0-9_-]{8,96}$/;
const MAX_BODY_BYTES = 1024 * 1024;

export interface DshBridgeConnection {
  token: string;
  port: number;
}

export interface DshBridgeTransportOptions {
  stateDir: string;
  timeoutMs?: number;
  /** Test seam only; production uses node:http directly (no proxy/redirect). */
  requestText?: (connection: DshBridgeConnection, path: string, timeoutMs: number) => Promise<string>;
}

function readPrivateJson(path: string): unknown {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("DSH_BRIDGE_STATE_UNSAFE");
  const real = realpathSync(path);
  if (real !== path) throw new Error("DSH_BRIDGE_STATE_UNSAFE");
  if (process.getuid && st.uid !== process.getuid()) throw new Error("DSH_BRIDGE_STATE_UNSAFE");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("DSH_BRIDGE_STATE_UNSAFE");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Real loopback HTTP lookup for the DSH Session Bridge (no CLI spawn). */
export class DshBridgeHttpTransport implements BridgeTransport {
  private readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly requestTextImpl: NonNullable<DshBridgeTransportOptions["requestText"]>;

  constructor(options: DshBridgeTransportOptions) {
    if (!options || typeof options.stateDir !== "string" || !options.stateDir.startsWith("/"))
      throw new Error("DSH_BRIDGE_STATE_DIR_REQUIRED");
    this.stateDir = options.stateDir;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.requestTextImpl = options.requestText ?? ((connection, path, timeoutMs) =>
      defaultRequestText(connection, path, timeoutMs));
  }

  private connection(): DshBridgeConnection {
    const auth = readPrivateJson(join(this.stateDir, "auth.json"));
    const runtime = readPrivateJson(join(this.stateDir, "runtime.json"));
    if (!auth || typeof auth !== "object" || typeof (auth as { token?: unknown }).token !== "string" ||
        !/^[0-9a-f]{64}$/i.test((auth as { token: string }).token)) throw new Error("DSH_BRIDGE_AUTH_INVALID");
    if (!runtime || typeof runtime !== "object") throw new Error("DSH_BRIDGE_RUNTIME_INVALID");
    const r = runtime as { protocolVersion?: unknown; host?: unknown; port?: unknown; pid?: unknown; instanceId?: unknown; startedAt?: unknown };
    if (r.protocolVersion !== 1 || r.host !== "127.0.0.1" || !Number.isSafeInteger(r.port) ||
        (r.port as number) < 1 || (r.port as number) > 65535 || !Number.isSafeInteger(r.pid) ||
        typeof r.instanceId !== "string" || !r.instanceId || typeof r.startedAt !== "string" ||
        !Number.isFinite(Date.parse(r.startedAt))) throw new Error("DSH_BRIDGE_RUNTIME_INVALID");
    return { token: (auth as { token: string }).token, port: r.port as number };
  }

  private async get(path: string): Promise<string> {
    return this.requestTextImpl(this.connection(), path, this.timeoutMs);
  }

  async session(sessionId: string): Promise<BridgeSession | undefined> {
    if (!ID_RE.test(sessionId)) return undefined;
    const raw = await this.get("/v1/sessions");
    const body = JSON.parse(raw) as { sessions?: { sessionId?: unknown; running?: unknown; allowed?: unknown }[] };
    if (!Array.isArray(body.sessions)) throw new Error("DSH_BRIDGE_RESPONSE_INVALID");
    const found = body.sessions.find((item) => item.sessionId === sessionId);
    if (!found) return undefined;
    return { sessionId, allowed: found.allowed === true, running: found.running === true };
  }

  async receipt(requestId: string): Promise<string | undefined> {
    if (!ID_RE.test(requestId)) return undefined;
    try { return await this.get("/v1/requests/" + encodeURIComponent(requestId)); }
    catch { return undefined; }
  }

  async request(requestId: string): Promise<BridgeRequest | undefined> {
    const raw = await this.receipt(requestId);
    if (raw === undefined) return undefined;
    return parseBridgeRecord(raw);
  }

  async wait(requestId: string): Promise<BridgeRequest | undefined> {
    const terminal = new Set(["completed", "stopped", "rejected", "uncertain"]);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const record = await this.request(requestId);
      if (!record || terminal.has(record.state) || Date.now() >= deadline) return record;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** P6 is one-way DSH->WebGPT; no external reply/submit path is exposed. */
  async send(): Promise<BridgeRequest> {
    throw new Error("BLOCKED_P6_ONE_WAY_NO_REPLY");
  }

  /** No WebGPT owner/principal is implied by a DSH completion. */
  async authorizeWebGpt(): Promise<boolean> { return false; }
}

function parseBridgeRecord(raw: string): BridgeRequest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("DSH_BRIDGE_RESPONSE_INVALID"); }
  if (!value || typeof value !== "object") throw new Error("DSH_BRIDGE_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return {
    requestId: String(record.requestId ?? ""),
    sessionId: String(record.sessionId ?? ""),
    rpcId: String(record.rpcId ?? ""),
    state: String(record.state ?? ""),
    accepted: record.accepted === true,
    claimed: record.claimed === true,
    seenUser: record.seenUser === true,
    ...(record.truncated === true ? { truncated: true } : {}),
    messages: messages.filter((item): item is { seq: number; text: string } =>
      Boolean(item) && typeof item === "object" &&
      Number.isSafeInteger((item as { seq?: unknown }).seq) &&
      typeof (item as { text?: unknown }).text === "string")
      .map((item) => ({ seq: item.seq, text: item.text })),
  };
}

function defaultRequestText(connection: DshBridgeConnection, path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!path.startsWith("/v1/")) return reject(new Error("DSH_BRIDGE_PATH_INVALID"));
    let settled = false;
    const finish = (error: Error | undefined, value?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value ?? "");
    };
    const req = httpRequest({
      hostname: "127.0.0.1", port: connection.port, path, method: "GET", agent: false,
      headers: { Authorization: "Bearer " + connection.token, Accept: "application/json" },
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(new Error("DSH_BRIDGE_HTTP_" + res.statusCode));
        return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { req.destroy(); finish(new Error("DSH_BRIDGE_RESPONSE_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => finish(new Error("DSH_BRIDGE_RESPONSE_ERROR")));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(new Error("DSH_BRIDGE_TIMEOUT")); });
    req.on("error", () => finish(new Error("DSH_BRIDGE_NETWORK_ERROR")));
    req.end();
  });
}

/** Structural subset used by both RouteBridgeDelivery and a live Sidecar. */
export type DshIngestSink = Pick<RouteBridgeDelivery, "ingest">;

export interface DshBridgeIngressOptions {
  delivery: DshIngestSink;
  transport: BridgeTransport;
  routeId: string;
  sessionId: string;
  consentRevision: number;
}

export interface DshBridgeIngressResult {
  state: string;
  enqueued: boolean;
  duplicate?: boolean;
  envelope?: EnqueuedEnvelope["envelope"];
}

/**
 * Polls one already-issued bridge request and, only on a complete trusted
 * receipt, calls the existing durable ingest. It never POSTs a replacement or
 * retries an uncertain request.
 */
export class DshBridgeIngress {
  private readonly delivery: DshIngestSink;
  private readonly transport: BridgeTransport;
  private readonly routeId: string;
  private readonly sessionId: string;
  private readonly consentRevision: number;

  constructor(options: DshBridgeIngressOptions) {
    if (!options || typeof options.delivery !== "object" || typeof options.transport !== "object" ||
        !MESSAGE_ID_RE.test(options.routeId) || !ID_RE.test(options.sessionId) ||
        !Number.isSafeInteger(options.consentRevision) || options.consentRevision < 1)
      throw new RouteError("ROUTE_INVALID_INPUT", "P6 ingress identity is invalid");
    this.delivery = options.delivery;
    this.transport = options.transport;
    this.routeId = options.routeId;
    this.sessionId = options.sessionId;
    this.consentRevision = options.consentRevision;
  }

  async ingest(requestId: string): Promise<DshBridgeIngressResult> {
    if (!ID_RE.test(requestId)) throw new RouteError("ROUTE_INVALID_INPUT", "requestId is invalid");
    const record = await this.transport.request(requestId);
    if (!record) return { state: "not_found", enqueued: false };
    if (record.state !== "completed") return { state: record.state, enqueued: false };
    if (record.requestId !== requestId || record.sessionId !== this.sessionId ||
        record.rpcId !== "dsh-bridge:" + requestId || record.accepted !== true ||
        record.claimed !== true || record.seenUser !== true || record.truncated === true ||
        !Array.isArray(record.messages) || record.messages.length === 0)
      throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    const raw = await this.transport.receipt(requestId);
    if (typeof raw !== "string") throw new Error("BRIDGE_SOURCE_UNVERIFIED");
    const receiptSha256 = sha256Hex(raw);
    const seq = record.messages.at(-1)!.seq;
    const enqueued = await this.delivery.ingest({
      routeId: this.routeId,
      sessionId: this.sessionId,
      consentRevision: this.consentRevision,
      requestId,
      seq,
      receiptSha256,
      operationId: requestId,
    });
    return { state: "completed", enqueued: true, duplicate: enqueued.duplicate, envelope: enqueued.envelope };
  }

  /** Bounded wait only; no automatic resend of the bridge message. */
  async waitAndIngest(requestId: string, timeoutMs = 60_000): Promise<DshBridgeIngressResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let last: DshBridgeIngressResult = { state: "pending", enqueued: false };
    for (;;) {
      last = await this.ingest(requestId);
      if (last.enqueued || ["completed", "stopped", "rejected", "uncertain", "not_found"].includes(last.state)) return last;
      if (Date.now() >= deadline) return { state: "timeout", enqueued: false };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Exposed only for diagnostics/tests: one-way SHA already validated by ingest. */
export function receiptDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
