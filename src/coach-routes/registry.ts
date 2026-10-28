/* Registry owner: consent revisions, routes, proposals, legacy migration. */
import { openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { ensureSafeDirectory, atomicWriteJson, readJsonRecord } from "./durable-queue.js";
import { STORE_VERSION, RouteError, isRecord, redactForLog, ROUTE_ID_RE, WORKSPACE_ID_RE,
 DSH_SESSION_RE, CHAT_ID_RE, SHA256_RE, LEGACY_ID_RE, NONCE_RE, MESSAGE_ID_RE,
 canonicalChatUrl, assertString, assertSafeInteger, mintRouteId, sha256Hex,
 chatIdFromCanonical, safeReason, legacyRouteId,
 type MultiRouteStoreOptions, type RouteRecord, type LegacyRouteRecord, type RouteProposal } from "./protocol.js";
export class RouteRegistry {
  readonly stateDir: string;
  readonly maxRoutes: number;
  readonly maxLegacyRoutes: number;
  readonly maxProposals: number;
  readonly proposalTtlMs: number;
  readonly deliveryLeaseMs: number;
  readonly maxMessageBytes: number;
  readonly maxQueuedPerRoute: number;
  readonly maxTransitions: number;
  private readonly now: () => number;
  private readonly registryPath: string;
  private readonly auditPath: string;
  protected consentRevision = 0;
  protected routes = new Map<string, RouteRecord>();
  protected legacy = new Map<string, LegacyRouteRecord>();
  private proposals = new Map<string, RouteProposal>();
  protected closed = false;

  constructor(options: MultiRouteStoreOptions) {
    if (!options || typeof options.stateDir !== "string" || !options.stateDir) {
      throw new RouteError("ROUTE_INVALID_INPUT", "stateDir is required");
    }
    this.stateDir = ensureSafeDirectory(options.stateDir);
    this.maxRoutes = options.maxRoutes ?? 32;
    this.maxLegacyRoutes = options.maxLegacyRoutes ?? 32;
    this.maxProposals = options.maxProposals ?? 16;
    this.proposalTtlMs = options.proposalTtlMs ?? 600_000;
    this.deliveryLeaseMs = options.deliveryLeaseMs ?? 60_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 48 * 1024;
    this.maxQueuedPerRoute = options.maxQueuedPerRoute ?? 1024;
    this.maxTransitions = options.maxTransitions ?? 8192;
    this.now = options.now ?? Date.now;
    this.registryPath = join(this.stateDir, "routes.json");
    this.auditPath = join(this.stateDir, "audit.jsonl");
    this.load();
  }

  // -- time / audit ---------------------------------------------------------

  nowMs(): number { return this.now(); }
  isoNow(): string { return new Date(this.now()).toISOString(); }

  audit(record: Record<string, unknown>): void {
    if (this.closed) return;
    const line = JSON.stringify({ at: this.isoNow(), ...(redactForLog(record) as Record<string, unknown>) }) + "\n";
    const fd = openSync(this.auditPath, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  // -- persistence ----------------------------------------------------------

  private load(): void {
    const raw = readJsonRecord(this.registryPath);
    if (raw === undefined) { this.save(); return; }
    if (!isRecord(raw) || raw.version !== STORE_VERSION || !Number.isSafeInteger(raw.consentRevision) || (raw.consentRevision as number) < 0) {
      throw new RouteError("ROUTE_STORE_CORRUPT", "route registry header is invalid");
    }
    if (!Array.isArray(raw.routes) || !Array.isArray(raw.legacy)) {
      throw new RouteError("ROUTE_STORE_CORRUPT", "route registry body is invalid");
    }
    this.consentRevision = raw.consentRevision as number;
    for (const item of raw.routes) {
      const route = this.validateRouteRecord(item);
      if (this.routes.has(route.routeId)) throw new RouteError("ROUTE_STORE_CORRUPT", "duplicate routeId in registry");
      this.routes.set(route.routeId, route);
    }
    for (const item of raw.legacy) {
      const record = this.validateLegacyRecord(item);
      if (this.legacy.has(record.legacyId)) throw new RouteError("ROUTE_STORE_CORRUPT", "duplicate legacy route id");
      this.legacy.set(record.legacyId, record);
    }
    this.assertCrossRouteInvariants();
  }

  private save(): void {
    const routes = [...this.routes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.routeId.localeCompare(b.routeId));
    const legacy = [...this.legacy.values()].sort((a, b) => a.legacyId.localeCompare(b.legacyId));
    atomicWriteJson(this.registryPath, { version: STORE_VERSION, consentRevision: this.consentRevision, routes, legacy });
  }

  private validateRouteRecord(value: unknown): RouteRecord {
    if (!isRecord(value)) throw new RouteError("ROUTE_STORE_CORRUPT", "route record is not an object");
    const route = value as unknown as RouteRecord;
    if (!ROUTE_ID_RE.test(String(route.routeId)) || !WORKSPACE_ID_RE.test(String(route.workspaceId)) ||
        !DSH_SESSION_RE.test(String(route.dshSessionId)) || !CHAT_ID_RE.test(String(route.chatId)) ||
        canonicalChatUrl(route.canonicalChatUrl) !== route.canonicalChatUrl ||
        !Number.isSafeInteger(route.exactTabId) || route.exactTabId < 1 ||
        !Number.isSafeInteger(route.consentRevision) || route.consentRevision < 1 ||
        !SHA256_RE.test(String(route.claimNonceSha256)) ||
        (route.state !== "active" && route.state !== "revoked") ||
        typeof route.createdAt !== "string" || typeof route.updatedAt !== "string") {
      throw new RouteError("ROUTE_STORE_CORRUPT", "route record identity is invalid");
    }
    return route;
  }

  private validateLegacyRecord(value: unknown): LegacyRouteRecord {
    if (!isRecord(value)) throw new RouteError("ROUTE_STORE_CORRUPT", "legacy route record is not an object");
    const record = value as unknown as LegacyRouteRecord;
    if (!LEGACY_ID_RE.test(String(record.legacyId)) || !WORKSPACE_ID_RE.test(String(record.workspaceId)) ||
        canonicalChatUrl(record.canonicalChatUrl) !== record.canonicalChatUrl ||
        (record.state !== "legacy" && record.state !== "migrated") ||
        (record.exactTabId !== undefined && (!Number.isSafeInteger(record.exactTabId) || record.exactTabId < 1)) ||
        typeof record.importedAt !== "string") {
      throw new RouteError("ROUTE_STORE_CORRUPT", "legacy route record identity is invalid");
    }
    return record;
  }

  /** Fail closed on any state that would let one chat/tab/session have two routes. */
  private assertCrossRouteInvariants(): void {
    const active = [...this.routes.values()].filter((route) => route.state === "active");
    const chats = new Set<string>(), sessions = new Set<string>(), tabs = new Set<number>();
    for (const route of active) {
      if (chats.has(route.canonicalChatUrl)) throw new RouteError("ROUTE_STORE_CORRUPT", "two active routes share one chat");
      if (sessions.has(route.workspaceId + "\n" + route.dshSessionId)) throw new RouteError("ROUTE_STORE_CORRUPT", "two active routes share one DSH session");
      if (tabs.has(route.exactTabId)) throw new RouteError("ROUTE_STORE_CORRUPT", "two active routes share one browser tab");
      chats.add(route.canonicalChatUrl);
      sessions.add(route.workspaceId + "\n" + route.dshSessionId);
      tabs.add(route.exactTabId);
    }
  }

  // -- identity -------------------------------------------------------------

  activeRoutes(): RouteRecord[] { return [...this.routes.values()].filter((route) => route.state === "active").map(route => ({ ...route })); }
  allRoutes(): RouteRecord[] { return [...this.routes.values()].map(route => ({ ...route })); }
  legacyRoutes(): LegacyRouteRecord[] { return [...this.legacy.values()].map(record => ({ ...record })); }

  route(routeId: string): RouteRecord | undefined {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    const route = this.routes.get(routeId);
    return route ? { ...route } : undefined;
  }

  /**
   * Create a short-lived browser challenge. The browser never supplies a
   * workspaceId or dshSessionId: only the independent Web GPT MCP claim may
   * associate this unguessable routeId with real authority.
   */
  propose(input: { nonce: string; url: string; tabId: number }): RouteProposal {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    const nonce = assertString(input?.nonce, "nonce", NONCE_RE);
    const canonical = canonicalChatUrl(input?.url);
    if (!canonical) throw new RouteError("ROUTE_INVALID_INPUT", "url is not a canonical ChatGPT conversation");
    const tabId = assertSafeInteger(input?.tabId, "tabId", 1, Number.MAX_SAFE_INTEGER);
    this.pruneProposals();
    if (this.proposals.has(nonce)) throw new RouteError("ROUTE_INVALID_INPUT", "binding challenge already exists");
    if (this.pendingProposalCount() >= this.maxProposals) throw new RouteError("ROUTE_LIMIT", "too many pending binding challenges");
    const routeId = mintRouteId();
    const now = this.nowMs();
    const proposal: RouteProposal = {
      nonce, routeId, canonicalChatUrl: canonical, exactTabId: tabId,
      createdAt: now, expiresAt: now + this.proposalTtlMs,
    };
    this.proposals.set(nonce, proposal);
    this.audit({ event: "route.proposed", routeId, tabId, canonicalChatUrl: canonical, nonceSha256: sha256Hex(nonce) });
    return proposal;
  }

  protected pendingProposalCount(): number {
    let count = 0;
    for (const proposal of this.proposals.values()) if (!proposal.claimedRouteId) count++;
    return count;
  }

  proposalByRouteId(routeId: string): RouteProposal | undefined {
    for (const proposal of this.proposals.values()) if (proposal.routeId === routeId) return proposal;
    return undefined;
  }

  /**
   * Test/diagnostics-only read-only view: unclaimed, unexpired proposal metadata
   * copies, oldest first. This is the only way an in-process test bootstrap can
   * observe a proposal that the *user* created by clicking the test extension
   * (`POST /route/propose`); it never creates or claims a proposal itself.
   * Deliberately not exposed over HTTP and never wired into the production
   * server, so no production code path can enumerate binding challenges.
   */
  pendingRouteProposals(): RouteProposal[] {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    const now = this.nowMs();
    return [...this.proposals.values()]
      .filter((proposal) => !proposal.claimedRouteId && proposal.expiresAt >= now)
      .sort((a, b) => a.createdAt - b.createdAt || a.routeId.localeCompare(b.routeId))
      .map((proposal) => ({ ...proposal }));
  }

  private pruneProposals(): void {
    const now = this.nowMs();
    for (const [nonce, proposal] of this.proposals) if (proposal.expiresAt < now) this.proposals.delete(nonce);
  }

  /**
   * Precise binding, called only after the exact ChatGPT conversation proves
   * possession of the one-time challenge over MCP. One chat keeps exactly one
   * active DSH route; switching requires replaceRouteId + expected revision.
   */
  claimExact(input: {
    routeId: string; nonce: string; url: string;
    workspaceId: string; dshSessionId: string;
    authorizedWorkspaceIds: string[];
    authorizedDshSessionIds: string[];
    replaceRouteId?: string;
    expectedConsentRevision?: number;
  }): RouteRecord {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    const nonce = assertString(input?.nonce, "nonce", NONCE_RE);
    const canonical = canonicalChatUrl(input?.url);
    if (!canonical) throw new RouteError("ROUTE_INVALID_INPUT", "url is not a canonical ChatGPT conversation");
    const workspaceId = assertString(input?.workspaceId, "workspaceId", WORKSPACE_ID_RE);
    const dshSessionId = assertString(input?.dshSessionId, "dshSessionId", DSH_SESSION_RE);
    if (!Array.isArray(input?.authorizedWorkspaceIds) || !input.authorizedWorkspaceIds.every((id) => typeof id === "string")) {
      throw new RouteError("ROUTE_INVALID_INPUT", "authorizedWorkspaceIds is required");
    }
    if (!input.authorizedWorkspaceIds.includes(workspaceId)) {
      throw new RouteError("ROUTE_WORKSPACE_NOT_AUTHORIZED", "workspace is not authorized by the local Sidecar");
    }
    if (!Array.isArray(input?.authorizedDshSessionIds) || input.authorizedDshSessionIds.length < 1) {
      throw new RouteError("ROUTE_DSH_SESSION_NOT_AUTHORIZED", "no DSH session was explicitly authorized at Sidecar start");
    }
    if (!input.authorizedDshSessionIds.includes(dshSessionId)) {
      throw new RouteError("ROUTE_DSH_SESSION_NOT_AUTHORIZED", "DSH session is not authorized on this machine");
    }
    const proposal = this.proposals.get(nonce);
    if (!proposal) {
      this.pruneProposals();
      throw new RouteError("ROUTE_PROPOSAL_NOT_FOUND", "binding challenge was never issued");
    }
    if (proposal.expiresAt < this.nowMs()) throw new RouteError("ROUTE_PROPOSAL_EXPIRED", "binding challenge has expired");
    if (proposal.routeId !== routeId) throw new RouteError("ROUTE_PROPOSAL_MISMATCH", "routeId does not match the browser challenge");
    if (proposal.canonicalChatUrl !== canonical) throw new RouteError("ROUTE_PROPOSAL_MISMATCH", "claim URL does not match the browser challenge");
    if (proposal.claimedRouteId) throw new RouteError("ROUTE_PROPOSAL_ALREADY_CLAIMED", "binding challenge was already claimed");
    const active = this.activeRoutes();
    let replaced: RouteRecord | undefined;
    if (input.replaceRouteId !== undefined) {
      if (!ROUTE_ID_RE.test(input.replaceRouteId)) throw new RouteError("ROUTE_INVALID_INPUT", "replaceRouteId is invalid");
      replaced = this.routes.get(input.replaceRouteId);
      if (!replaced || replaced.state !== "active") throw new RouteError("ROUTE_NOT_ACTIVE", "replaceRouteId is not an active route");
      if (replaced.workspaceId !== workspaceId || replaced.canonicalChatUrl !== canonical) {
        throw new RouteError("ROUTE_CHAT_MISMATCH", "replacement route does not own this chat and workspace");
      }
      const expected = assertSafeInteger(input.expectedConsentRevision, "expectedConsentRevision", 1, Number.MAX_SAFE_INTEGER);
      if (replaced.consentRevision !== expected) throw new RouteError("ROUTE_CONSENT_REVISION_MISMATCH", "consent revision is stale");
    }
    for (const route of active) {
      if (route.routeId === replaced?.routeId) continue;
      if (route.canonicalChatUrl === canonical) throw new RouteError("ROUTE_CHAT_ALREADY_BOUND", "this chat already owns exactly one DSH route");
      if (route.workspaceId === workspaceId && route.dshSessionId === dshSessionId) throw new RouteError("ROUTE_SESSION_ALREADY_BOUND", "this DSH session is already bound to a chat");
      if (route.exactTabId === proposal.exactTabId) throw new RouteError("ROUTE_TAB_ALREADY_BOUND", "this browser tab is already bound to another route");
    }
    if (!replaced && this.routes.size >= this.maxRoutes) throw new RouteError("ROUTE_LIMIT", "too many routes on this Sidecar");
    const now = this.nowMs();
    const revision = ++this.consentRevision;
    if (replaced) {
      const revoked: RouteRecord = {
        ...replaced, state: "revoked", consentRevision: revision, updatedAt: this.isoIso(now),
        revokedAt: this.isoIso(now), revokeReason: "explicit rebind",
      };
      this.routes.set(replaced.routeId, revoked);
    }
    const record: RouteRecord = {
      routeId, workspaceId, dshSessionId, chatId: chatIdFromCanonical(canonical),
      canonicalChatUrl: canonical, exactTabId: proposal.exactTabId,
      consentRevision: revision, state: "active", origin: "exact-claim",
      createdAt: this.isoIso(now), updatedAt: this.isoIso(now),
      claimNonceSha256: sha256Hex(nonce),
      ...(replaced ? { replacedRouteId: replaced.routeId } : {}),
    };
    this.routes.set(routeId, record);
    proposal.claimedRouteId = routeId;
    try {
      this.save();
    } catch (error) {
      this.routes.delete(routeId);
      if (replaced) this.routes.set(replaced.routeId, replaced);
      proposal.claimedRouteId = undefined;
      this.consentRevision = revision - 1;
      throw error;
    }
    this.audit({
      event: replaced ? "route.rebound" : "route.claimed",
      routeId, workspaceId, dshSessionId, chatId: record.chatId,
      canonicalChatUrl: canonical, exactTabId: record.exactTabId,
      consentRevision: revision, claimNonceSha256: record.claimNonceSha256,
      ...(replaced ? { replacedRouteId: replaced.routeId } : {}),
    });
    return { ...record };
  }

  protected isoIso(ms: number): string { return new Date(ms).toISOString(); }

  /** Explicit revoke. Never inferred from navigation or a missing tab. */
  revoke(input: { routeId: string; expectedConsentRevision?: number; reason?: string }): RouteRecord {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    const route = this.routes.get(routeId);
    if (!route) throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    if (route.state !== "active") return { ...route };
    if (input.expectedConsentRevision !== undefined) {
      const expected = assertSafeInteger(input.expectedConsentRevision, "expectedConsentRevision", 1, Number.MAX_SAFE_INTEGER);
      if (route.consentRevision !== expected) throw new RouteError("ROUTE_CONSENT_REVISION_MISMATCH", "consent revision is stale");
    }
    const now = this.nowMs();
    const revision = ++this.consentRevision;
    const reason = safeReason(input.reason) ?? "explicit revoke";
    const revoked: RouteRecord = {
      ...route, state: "revoked", consentRevision: revision, updatedAt: this.isoIso(now),
      revokedAt: this.isoIso(now), revokeReason: reason,
    };
    this.routes.set(routeId, revoked);
    try {
      this.save();
    } catch (error) {
      this.routes.set(routeId, route);
      this.consentRevision = revision - 1;
      throw error;
    }
    this.audit({ event: "route.revoked", routeId, workspaceId: route.workspaceId, dshSessionId: route.dshSessionId, consentRevision: revision, reason });
    return { ...revoked };
  }

  /**
   * A browser tab/id must still be the exact bound conversation. Navigation or
   * a different tab is a hard mismatch, never a silent re-bind.
   */
  verifyTab(input: { routeId: string; tabId: number; url: string }): RouteRecord {
    const routeId = assertString(input?.routeId, "routeId", ROUTE_ID_RE);
    const route = this.routes.get(routeId);
    if (!route) throw new RouteError("ROUTE_NOT_FOUND", "route not found");
    if (route.state !== "active") throw new RouteError("ROUTE_REVOKED", "route is not active");
    const tabId = assertSafeInteger(input?.tabId, "tabId", 1, Number.MAX_SAFE_INTEGER);
    if (route.exactTabId !== tabId) throw new RouteError("ROUTE_TAB_MISMATCH", "browser tab no longer matches the bound route");
    if (canonicalChatUrl(input?.url) !== route.canonicalChatUrl) throw new RouteError("ROUTE_CHAT_MISMATCH", "browser tab navigated away from the bound conversation");
    return { ...route };
  }

  workspaceActiveRoutes(workspaceId: string): RouteRecord[] {
    return this.activeRoutes().filter((route) => route.workspaceId === workspaceId);
  }

  // -- legacy compatibility -------------------------------------------------

  /**
   * Preserve an old workspace-only browser route (pre-routeId extension
   * storage). Registration is passive and never activates delivery.
   */
  importLegacyRoutes(records: { workspaceId: string; url: string; tabId?: number }[]): LegacyRouteRecord[] {
    if (this.closed) throw new RouteError("ROUTE_NOT_ACTIVE", "route store is closed");
    if (!Array.isArray(records) || records.length > 64) throw new RouteError("ROUTE_INVALID_INPUT", "legacy route import is invalid");
    const prepared: LegacyRouteRecord[] = [];
    for (const item of records) {
      if (!isRecord(item)) throw new RouteError("ROUTE_INVALID_INPUT", "legacy route record is invalid");
      const workspaceId = assertString(item.workspaceId, "workspaceId", WORKSPACE_ID_RE);
      const canonical = canonicalChatUrl(item.url);
      if (!canonical) throw new RouteError("ROUTE_INVALID_INPUT", "legacy route URL is not canonical");
      const tabId = item.tabId === undefined ? undefined : assertSafeInteger(item.tabId, "tabId", 1, Number.MAX_SAFE_INTEGER);
      const legacyId = legacyRouteId(workspaceId, canonical);
      const existing = this.legacy.get(legacyId);
      if (existing) { prepared.push({ ...existing }); continue; }
      if (this.legacy.size + prepared.length >= this.maxLegacyRoutes) throw new RouteError("ROUTE_LIMIT", "too many legacy routes");
      prepared.push({
        legacyId, workspaceId, canonicalChatUrl: canonical,
        ...(tabId !== undefined ? { exactTabId: tabId } : {}),
        state: "legacy", importedAt: this.isoIso(this.nowMs()),
      });
    }
    const created: string[] = [];
    for (const record of prepared) {
      if (!this.legacy.has(record.legacyId)) created.push(record.legacyId);
      this.legacy.set(record.legacyId, record);
    }
    try { this.save(); } catch (error) { for (const id of created) this.legacy.delete(id); throw error; }
    this.audit({ event: "legacy.imported", count: prepared.length, legacyIds: prepared.map((record) => record.legacyId) });
    return prepared.map((record) => ({ ...record }));
  }

  /**
   * An old workspace-only message has no exact DSH session identity. It is
   * UNROUTABLE by contract: mark it, never guess a target route.
   */
  classifyLegacyMessage(input: { legacyId?: string; workspaceId?: string; messageId?: string }): { state: "UNROUTABLE"; reason: string; legacyId?: string } {
    const messageId = input?.messageId === undefined ? undefined : assertString(input.messageId, "messageId", MESSAGE_ID_RE);
    if (input?.legacyId !== undefined) {
      const legacyId = assertString(input.legacyId, "legacyId", LEGACY_ID_RE);
      const record = this.legacy.get(legacyId);
      if (!record) return { state: "UNROUTABLE", reason: "UNKNOWN_LEGACY_ROUTE", legacyId };
      this.audit({ event: "legacy.unroutable", legacyId, ...(messageId ? { messageId } : {}), reason: "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION" });
      return { state: "UNROUTABLE", reason: "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION", legacyId };
    }
    if (input?.workspaceId !== undefined) {
      const workspaceId = assertString(input.workspaceId, "workspaceId", WORKSPACE_ID_RE);
      const records = this.legacyRoutes().filter((record) => record.workspaceId === workspaceId && record.state === "legacy");
      if (records.length === 0) {
        return { state: "UNROUTABLE", reason: this.workspaceActiveRoutes(workspaceId).length > 0 ? "NO_EXACT_ROUTE_FOR_LEGACY_MESSAGE" : "NO_ROUTE_IDENTITY" };
      }
      this.audit({ event: "legacy.unroutable", workspaceId, ...(messageId ? { messageId } : {}), reason: "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION" });
      return { state: "UNROUTABLE", reason: "LEGACY_WORKSPACE_ONLY_ROUTE_REQUIRES_EXPLICIT_MIGRATION", legacyId: records[0].legacyId };
    }
    throw new RouteError("ROUTE_INVALID_INPUT", "legacyId or workspaceId is required");
  }

  /**
   * Explicit migration of one legacy record onto one exact route. Only an
   * identical workspace + conversation pair may be migrated; history stays
   * UNROUTABLE and is never replayed.
   */
  migrateLegacy(input: { legacyId: string; targetRouteId: string; expectedConsentRevision?: number }): LegacyRouteRecord {
    const legacyId = assertString(input?.legacyId, "legacyId", LEGACY_ID_RE);
    const targetRouteId = assertString(input?.targetRouteId, "targetRouteId", ROUTE_ID_RE);
    const record = this.legacy.get(legacyId);
    if (!record) throw new RouteError("ROUTE_NOT_FOUND", "legacy route not found");
    const target = this.routes.get(targetRouteId);
    if (!target || target.state !== "active") throw new RouteError("ROUTE_NOT_ACTIVE", "migration target is not an active route");
    if (record.workspaceId !== target.workspaceId || record.canonicalChatUrl !== target.canonicalChatUrl) {
      throw new RouteError("ROUTE_LEGACY_MIGRATION_DENIED", "legacy route must migrate to the same workspace and conversation");
    }
    if (input.expectedConsentRevision !== undefined) {
      const expected = assertSafeInteger(input.expectedConsentRevision, "expectedConsentRevision", 1, Number.MAX_SAFE_INTEGER);
      if (target.consentRevision !== expected) throw new RouteError("ROUTE_CONSENT_REVISION_MISMATCH", "consent revision is stale");
    }
    if (record.state === "migrated") {
      if (record.migratedTo === targetRouteId) return { ...record };
      throw new RouteError("ROUTE_LEGACY_MIGRATION_DENIED", "legacy route was already migrated elsewhere");
    }
    const migrated: LegacyRouteRecord = { ...record, state: "migrated", migratedAt: this.isoIso(this.nowMs()), migratedTo: targetRouteId };
    this.legacy.set(legacyId, migrated);
    try { this.save(); } catch (error) { this.legacy.set(legacyId, record); throw error; }
    this.audit({ event: "legacy.migrated", legacyId, targetRouteId, workspaceId: record.workspaceId });
    return { ...migrated };
  }


}
