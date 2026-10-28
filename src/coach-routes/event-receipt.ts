/**
 * P5 pure-logic prototype: event-scoped browser receipt challenge.
 *
 * This module is intentionally NOT wired into the Sidecar, Chrome extension,
 * MCP tools or DSH delivery. It models the narrow security contract only:
 *
 *   a PAIRED EXTENSION BACKGROUND + local Sidecar transport may, for one exact
 *   review event and revision, obtain a server challenge and later submit one
 *   bounded "browser-local review receipt".
 *
 * Guarantees distinguish three layers explicitly:
 *   1. browser-local authorization: the receipt came through the trusted
 *      extension-background transport for an exact binding (this prototype).
 *   2. reviewer provenance: NOT proven. A DOM/model/user role can be spoofed;
 *      the receipt is evidence, not a cryptographic model signature.
 *   3. real automated E2E: NOT implemented/run.
 *
 * Therefore a receipt NEVER grants automatic dispatch/APPROVED execution. It
 * always carries `reviewerVerified:false` and `requiresUserDispatchAuthorization:true`.
 *
 * This prototype is in-memory only. It is not restart-durable and cannot prove
 * cross-process atomic consumption; the report describes the required durable
 * journal design. In-memory tests must not be presented as restart-safe.
 */
import { randomBytes } from "node:crypto";
import {
  DSH_SESSION_RE, MESSAGE_ID_RE, ROUTE_ID_RE, SHA256_RE,
  canonicalChatUrl, isRecord,
} from "./protocol.js";

export type ReviewDecision = "APPROVED" | "REWORK" | "BLOCKED";
export type ReviewerProvenance = "BROWSER_LOCAL_UNVERIFIED";

const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const MAX_TTL_MS = 120_000;
const DECISIONS = new Set<ReviewDecision>(["APPROVED", "REWORK", "BLOCKED"]);

export type ReceiptErrorCode =
  | "EXTENSION_UNAUTHORIZED"
  | "BINDING_INVALID"
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_MISMATCH"
  | "CHALLENGE_ALREADY_CONSUMED"
  | "EVENT_ALREADY_REVIEWED"
  | "ROUTE_UNAVAILABLE"
  | "REVISION_STALE"
  | "CHALLENGE_LIMIT";

export class ReceiptError extends Error {
  readonly code: ReceiptErrorCode;
  constructor(code: ReceiptErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ReceiptError";
    this.code = code;
  }
}

/** Only the extension background can construct this transport context. */
export interface ExtensionBackgroundContext {
  kind: "extension-background";
  extensionId: string;
  pairingToken: string;
}

/** Content scripts, pages and MCP callers must never be accepted as this. */
export interface UntrustedCallerContext {
  kind: "content-script" | "page" | "mcp" | "unknown";
}

export interface EventBinding {
  routeId: string;
  consentRevision: number;
  eventId: number;
  messageId: string;
  evidenceSha256: string;
  workspaceId: string;
  dshSessionId: string;
  tabId: number;
  canonicalChatUrl: string;
}

export interface RouteRevisionSnapshot {
  active: boolean;
  consentRevision: number;
  workspaceId: string;
  dshSessionId: string;
  tabId: number;
  canonicalChatUrl: string;
}

export type RouteRevisionResolver = (routeId: string) => RouteRevisionSnapshot | undefined;

export interface Challenge {
  challengeId: string;
  nonce: string;
  decision: ReviewDecision;
  binding: EventBinding;
  idempotencyKey: string;
  issuedAt: number;
  expiresAt: number;
}

export interface Receipt {
  receiptId: string;
  challengeId: string;
  binding: EventBinding;
  decision: ReviewDecision;
  provenance: ReviewerProvenance;
  browserAuthorized: true;
  reviewerVerified: false;
  requiresUserDispatchAuthorization: true;
  acceptedAt: number;
}

export interface ReceiptSubmission {
  challengeId: string;
  nonce: string;
  binding: EventBinding;
  decision: ReviewDecision;
  idempotencyKey: string;
}

export interface SubmitResult {
  accepted: boolean;
  duplicate: boolean;
  receipt: Receipt;
}

export interface EventReceiptAuthorityOptions {
  trustedExtensionId: string;
  pairingToken: string;
  resolveRoute: RouteRevisionResolver;
  now?: () => number;
  challengeTtlMs?: number;
  maxPendingChallenges?: number;
}

function assertCount(value: unknown, label: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new ReceiptError("BINDING_INVALID", label + " is invalid");
  return value as number;
}

function assertString(value: unknown, label: string, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value))
    throw new ReceiptError("BINDING_INVALID", label + " is invalid");
  return value;
}

function normalizedUrl(value: unknown): string {
  const canonical = canonicalChatUrl(value);
  if (!canonical) throw new ReceiptError("BINDING_INVALID", "canonicalChatUrl is invalid");
  return canonical;
}

function validateBinding(input: unknown): EventBinding {
  if (!isRecord(input)) throw new ReceiptError("BINDING_INVALID", "binding is required");
  return {
    routeId: assertString(input.routeId, "routeId", ROUTE_ID_RE),
    consentRevision: assertCount(input.consentRevision, "consentRevision", 1),
    eventId: assertCount(input.eventId, "eventId", 1),
    messageId: assertString(input.messageId, "messageId", MESSAGE_ID_RE),
    evidenceSha256: assertString(input.evidenceSha256, "evidenceSha256", SHA256_RE),
    workspaceId: assertString(input.workspaceId, "workspaceId", /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    dshSessionId: assertString(input.dshSessionId, "dshSessionId", DSH_SESSION_RE),
    tabId: assertCount(input.tabId, "tabId", 1),
    canonicalChatUrl: normalizedUrl(input.canonicalChatUrl),
  };
}

function sameBinding(a: EventBinding, b: EventBinding): boolean {
  return a.routeId === b.routeId &&
    a.consentRevision === b.consentRevision &&
    a.eventId === b.eventId &&
    a.messageId === b.messageId &&
    a.evidenceSha256 === b.evidenceSha256 &&
    a.workspaceId === b.workspaceId &&
    a.dshSessionId === b.dshSessionId &&
    a.tabId === b.tabId &&
    a.canonicalChatUrl === b.canonicalChatUrl;
}

function assertDecision(value: unknown): ReviewDecision {
  if (typeof value !== "string" || !DECISIONS.has(value as ReviewDecision))
    throw new ReceiptError("BINDING_INVALID", "decision is not an allowed enum");
  return value as ReviewDecision;
}

export class EventReceiptAuthority {
  private readonly trustedExtensionId: string;
  private readonly pairingToken: string;
  private readonly resolveRoute: RouteRevisionResolver;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;
  private readonly maxPendingChallenges: number;
  private readonly challenges = new Map<string, Challenge>();
  private readonly consumedEvents = new Map<string, Receipt>();
  private readonly idempotency = new Map<string, { payload: string; receipt: Receipt }>();
  private consumedChallenges = new Map<string, Receipt>();

  constructor(options: EventReceiptAuthorityOptions) {
    if (!options || !EXTENSION_ID_RE.test(options.trustedExtensionId))
      throw new ReceiptError("EXTENSION_UNAUTHORIZED", "trusted extension id is invalid");
    if (typeof options.pairingToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.pairingToken))
      throw new ReceiptError("EXTENSION_UNAUTHORIZED", "pairing token is invalid");
    if (typeof options.resolveRoute !== "function")
      throw new ReceiptError("ROUTE_UNAVAILABLE", "route resolver is required");
    this.trustedExtensionId = options.trustedExtensionId;
    this.pairingToken = options.pairingToken;
    this.resolveRoute = options.resolveRoute;
    this.now = options.now ?? Date.now;
    this.challengeTtlMs = Math.min(options.challengeTtlMs ?? 60_000, MAX_TTL_MS);
    this.maxPendingChallenges = options.maxPendingChallenges ?? 128;
  }

  /** Trusted background transport only; never a tool argument or content script. */
  private requireBackground(context: unknown): ExtensionBackgroundContext {
    if (!isRecord(context) || context.kind !== "extension-background" ||
        context.extensionId !== this.trustedExtensionId ||
        context.pairingToken !== this.pairingToken)
      throw new ReceiptError("EXTENSION_UNAUTHORIZED", "trusted extension background is required");
    return context as unknown as ExtensionBackgroundContext;
  }

  private routeAvailable(binding: EventBinding): void {
    const route = this.resolveRoute(binding.routeId);
    if (!route || !route.active) throw new ReceiptError("ROUTE_UNAVAILABLE", "route is not active");
    if (route.consentRevision !== binding.consentRevision)
      throw new ReceiptError("REVISION_STALE", "consent revision is stale");
    if (route.workspaceId !== binding.workspaceId || route.dshSessionId !== binding.dshSessionId ||
        route.tabId !== binding.tabId || route.canonicalChatUrl !== binding.canonicalChatUrl)
      throw new ReceiptError("CHALLENGE_MISMATCH", "route binding does not match");
  }

  issueChallenge(context: unknown, input: {
    binding: EventBinding;
    decision: ReviewDecision;
    idempotencyKey: string;
  }): Challenge {
    this.requireBackground(context);
    const binding = validateBinding(input?.binding);
    const decision = assertDecision(input?.decision);
    const idempotencyKey = assertString(input?.idempotencyKey, "idempotencyKey", IDEMPOTENCY_RE);
    this.routeAvailable(binding);
    if (this.challenges.size >= this.maxPendingChallenges)
      throw new ReceiptError("CHALLENGE_LIMIT", "too many pending challenges");
    const now = this.now();
    const challenge: Challenge = {
      challengeId: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      decision,
      binding,
      idempotencyKey,
      issuedAt: now,
      expiresAt: now + this.challengeTtlMs,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return { ...challenge, binding: { ...challenge.binding } };
  }

  /** Synchronous compare-and-consume; callers cannot usefully interleave it. */
  submitReceipt(context: unknown, submission: ReceiptSubmission): SubmitResult {
    this.requireBackground(context);
    if (!isRecord(submission))
      throw new ReceiptError("CHALLENGE_NOT_FOUND", "challenge is required");
    const challengeId = assertString(submission.challengeId, "challengeId", CHALLENGE_ID_RE);
    const nonce = assertString(submission.nonce, "nonce", CHALLENGE_ID_RE);
    const binding = validateBinding(submission.binding);
    const decision = assertDecision(submission.decision);
    const idempotencyKey = assertString(submission.idempotencyKey, "idempotencyKey", IDEMPOTENCY_RE);
    const canonicalPayload = JSON.stringify({
      challengeId, nonce, binding, decision, idempotencyKey,
    });
    // Consumed challenges are retained for exact ACK-loss retries before the
    // live map lookup (the live challenge is deleted on consumption).
    const priorConsumed = this.consumedChallenges.get(challengeId);
    if (priorConsumed) {
      // ACK-loss retry with the exact same payload is idempotent and has no
      // second side effect. Any different payload is a duplicate attack.
      const prior = this.idempotency.get(idempotencyKey);
      if (prior && prior.payload === canonicalPayload)
        return { accepted: false, duplicate: true, receipt: prior.receipt };
      throw new ReceiptError("CHALLENGE_ALREADY_CONSUMED", "challenge was already consumed");
    }
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new ReceiptError("CHALLENGE_NOT_FOUND", "no such challenge");
    if (this.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      throw new ReceiptError("CHALLENGE_EXPIRED", "challenge expired");
    }
    if (challenge.nonce !== nonce || challenge.decision !== decision ||
        challenge.idempotencyKey !== idempotencyKey || !sameBinding(challenge.binding, binding))
      throw new ReceiptError("CHALLENGE_MISMATCH", "submission does not match the issued challenge");
    this.routeAvailable(binding);
    const eventKey = [binding.routeId, binding.consentRevision, binding.eventId].join("\0");
    if (this.consumedEvents.has(eventKey))
      throw new ReceiptError("EVENT_ALREADY_REVIEWED", "event revision was already reviewed");
    const receipt: Receipt = {
      receiptId: randomBytes(32).toString("base64url"),
      challengeId,
      binding: { ...binding },
      decision,
      provenance: "BROWSER_LOCAL_UNVERIFIED",
      browserAuthorized: true,
      reviewerVerified: false,
      requiresUserDispatchAuthorization: true,
      acceptedAt: this.now(),
    };
    this.challenges.delete(challengeId);
    this.consumedChallenges.set(challengeId, receipt);
    this.consumedEvents.set(eventKey, receipt);
    this.idempotency.set(idempotencyKey, { payload: canonicalPayload, receipt });
    return { accepted: true, duplicate: false, receipt };
  }

  /** Test/ops visibility only; contains no page content or credentials. */
  pendingChallengeCount(): number { return this.challenges.size; }
  consumedEventCount(): number { return this.consumedEvents.size; }
}
