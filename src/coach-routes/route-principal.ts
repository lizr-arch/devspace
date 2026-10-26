/**
 * Per-route access control for MCP/HTTP route surfaces.
 *
 * The verifier is a HOST-injected function: it must derive the caller identity
 * from authenticated transport metadata (MCP authInfo/session or an explicit
 * operator grant), never from tool arguments. Tool arguments such as chatId,
 * url, workspaceId, routeId, from or sender are unverified data.
 *
 * Modes:
 *  - enforced: every sensitive action requires a verified principal. No
 *    verifier => deny (fail closed). This is the production/server default.
 *  - legacy: pre-existing V1/offline compatibility for direct local use and
 *    tests; no principal is required. It is NOT a real authorization mode and
 *    must never be enabled for a live ChatGPT/MCP transport.
 */
import { CHAT_ID_RE, RouteError, type LegacyRouteRecord, type PendingReviewWake, type RouteRecord, type StoreSnapshot } from "./protocol.js";

export type RouteAccessMode = "enforced" | "legacy";
export type RouteAccessAction =
  | "snapshot"
  | "inbox"
  | "classify_legacy"
  | "claim_delivery"
  | "ack"
  | "resolve"
  | "revoke"
  | "migrate_legacy"
  | "enqueue_wake"
  | "reply"
  | "trusted_reply"
  | "claim_browser_route"
  | "claim_browser_route_exact";

export interface RoutePrincipalTarget {
  routeId: string;
  workspaceId: string;
  chatId: string;
  state?: string;
}

export type RoutePrincipal =
  | { kind: "owner"; chatId: string; workspaceId?: string }
  | { kind: "operator"; workspaceId?: string };

/** Host verifier. Must ignore all tool-supplied identity fields. */
export type RoutePrincipalVerifier = (
  context: unknown,
  target?: Readonly<RoutePrincipalTarget>,
) => Promise<RoutePrincipal | undefined> | RoutePrincipal | undefined;

/** Owner-chat actions: exactly the route owner's own conversation. */
const OWNER_ACTIONS = new Set<RouteAccessAction>(["snapshot", "inbox", "trusted_reply"]);
/** Actions a verified operator (explicit admin grant) may perform. */
const OPERATOR_ACTIONS = new Set<RouteAccessAction>([
  "snapshot", "inbox", "classify_legacy", "claim_delivery", "ack", "resolve",
  "revoke", "migrate_legacy", "enqueue_wake", "reply", "trusted_reply",
  "claim_browser_route", "claim_browser_route_exact",
]);

export class RoutePrincipalError extends RouteError {
  constructor(code: "ROUTE_PRINCIPAL_REQUIRED" | "ROUTE_PRINCIPAL_FORBIDDEN" | "ROUTE_PRINCIPAL_INVALID", message: string) {
    super(code, message);
    this.name = "RoutePrincipalError";
  }
}

export interface RouteAccessOptions {
  mode?: RouteAccessMode;
  verifier?: RoutePrincipalVerifier;
}

export class RouteAccessController {
  private mode: RouteAccessMode;
  private verifier?: RoutePrincipalVerifier;

  constructor(options: RouteAccessOptions = {}) {
    this.mode = options.mode ?? "legacy";
    this.verifier = options.verifier;
  }

  configure(options: RouteAccessOptions): void {
    if (options.mode !== undefined) {
      if (options.mode !== "enforced" && options.mode !== "legacy")
        throw new RoutePrincipalError("ROUTE_PRINCIPAL_INVALID", "invalid route access mode");
      this.mode = options.mode;
    }
    if (options.verifier !== undefined) this.verifier = options.verifier;
  }

  getMode(): RouteAccessMode { return this.mode; }

  private validate(principal: unknown): RoutePrincipal {
    if (!principal || typeof principal !== "object") throw new RoutePrincipalError("ROUTE_PRINCIPAL_INVALID", "verifier returned no principal");
    const item = principal as Record<string, unknown>;
    if (item.kind !== "owner" && item.kind !== "operator")
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_INVALID", "verifier returned an invalid principal kind");
    if (item.kind === "owner" && (typeof item.chatId !== "string" || !CHAT_ID_RE.test(item.chatId)))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_INVALID", "owner principal requires a trusted chat id");
    if (item.workspaceId !== undefined && (typeof item.workspaceId !== "string" || !item.workspaceId))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_INVALID", "principal workspace id is invalid");
    return item as RoutePrincipal;
  }

  /** Verify the caller for one action/target. Throws fail-closed on mismatch. */
  async authorize(action: RouteAccessAction, context: unknown, target?: RoutePrincipalTarget): Promise<RoutePrincipal> {
    if (this.mode === "legacy") return { kind: "operator" };
    if (!this.verifier) throw new RoutePrincipalError("ROUTE_PRINCIPAL_REQUIRED", "no trusted route principal verifier is configured");
    const principal = this.validate(await this.verifier(context, target));
    if (principal.kind === "operator") {
      if (!OPERATOR_ACTIONS.has(action)) throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "operator action is not allowed");
      // A workspace-scoped operator is not a global administrator. It may act
      // only on an exact target in its own workspace.
      if (principal.workspaceId !== undefined) {
        // Snapshot is allowed without a single target; projection enforces the scope.
        if (action === "snapshot" && target === undefined) return principal;
        if (!target) throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "workspace-scoped operator requires an exact route target");
        if (target.workspaceId !== principal.workspaceId)
          throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "route belongs to a different workspace");
      }
      return principal;
    }
    if (!OWNER_ACTIONS.has(action))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "owner chat cannot perform this operator action");
    // Snapshot is route-list visibility, filtered to the owner's own routes.
    if (action === "snapshot" && target === undefined) return principal;
    if (!target) throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "owner chat requires an exact route");
    if (target.state !== undefined && target.state !== "active")
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "owner chat cannot access a non-active route");
    if (principal.chatId !== target.chatId || (principal.workspaceId !== undefined && principal.workspaceId !== target.workspaceId))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "route belongs to a different chat/workspace");
    return principal;
  }

  /**
   * Binding/claim authorization. The claimed URL is caller-supplied data, so it
   * is compared to the HOST-verified owner chat id; an operator may bind explicitly.
   */
  async authorizeClaim(
    action: "claim_browser_route" | "claim_browser_route_exact",
    context: unknown,
    input: { workspaceId: string; chatId: string },
  ): Promise<RoutePrincipal> {
    if (this.mode === "legacy") return { kind: "operator" };
    if (!this.verifier) throw new RoutePrincipalError("ROUTE_PRINCIPAL_REQUIRED", "no trusted route principal verifier is configured");
    const principal = this.validate(await this.verifier(context));
    if (principal.kind === "operator") {
      if (principal.workspaceId !== undefined && principal.workspaceId !== input.workspaceId)
        throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "claim workspace does not match the operator scope");
      return principal;
    }
    if (!input.chatId || !CHAT_ID_RE.test(input.chatId))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "claimed chat identity is invalid");
    if (principal.chatId !== input.chatId)
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "claim must be for the verified owner chat");
    if (principal.workspaceId !== undefined && principal.workspaceId !== input.workspaceId)
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "claim workspace does not match the verified principal");
    return principal;
  }

  /** Snapshot visibility: owner sees only its own chat's routes; operator sees all. */
  /**
   * Non-route-scoped admin actions (legacy classification/migration) still need
   * a workspace target. A scoped operator may only act inside its own workspace;
   * a global operator only exists when the host explicitly granted no scope.
   */
  async authorizeWorkspaceAction(
    action: Extract<RouteAccessAction, "classify_legacy" | "migrate_legacy">,
    context: unknown,
    workspaceId?: string,
  ): Promise<RoutePrincipal> {
    if (this.mode === "legacy") return { kind: "operator" };
    if (!this.verifier) throw new RoutePrincipalError("ROUTE_PRINCIPAL_REQUIRED", "no trusted route principal verifier is configured");
    const principal = this.validate(await this.verifier(context));
    if (principal.kind === "owner")
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "owner chat cannot perform legacy administration");
    if (!OPERATOR_ACTIONS.has(action))
      throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "operator action is not allowed");
    if (principal.workspaceId !== undefined) {
      if (workspaceId === undefined)
        throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "workspace-scoped operator requires a workspace target");
      if (workspaceId !== principal.workspaceId)
        throw new RoutePrincipalError("ROUTE_PRINCIPAL_FORBIDDEN", "workspace target is outside the operator scope");
    }
    return principal;
  }

  /**
   * Explicit response projection for coach_route_state snapshot. Never rely on
   * spread-plus-override: queues/legacy/global counters are projected per caller.
   */
  projectSnapshot(
    principal: RoutePrincipal,
    snapshot: StoreSnapshot,
    pendingReviews: readonly PendingReviewWake[],
  ): { snapshot: StoreSnapshot; pendingReviews: PendingReviewWake[] } {
    const globalOperator = principal.kind === "operator" && principal.workspaceId === undefined;
    const routes = this.visibleRoutes(principal, snapshot.routes);
    const visibleIds = new Set(routes.map((route) => route.routeId));
    const legacy: LegacyRouteRecord[] = principal.kind === "operator"
      ? snapshot.legacy.filter((record) => globalOperator || record.workspaceId === principal.workspaceId)
      : [];
    const queues: StoreSnapshot["queues"] = {};
    for (const routeId of Object.keys(snapshot.queues)) {
      if (visibleIds.has(routeId)) queues[routeId] = { ...snapshot.queues[routeId] };
    }
    const pending = pendingReviews.filter((wake) => {
      if (!visibleIds.has(wake.routeId)) return false;
      return principal.kind === "operator"
        ? (globalOperator || wake.workspaceId === principal.workspaceId)
        // A trusted host may provide only the exact chat id; only compare a
        // workspace when the principal actually carries one (R3 review P2).
        : (principal.workspaceId === undefined || wake.workspaceId === principal.workspaceId);
    });
    return {
      snapshot: {
        // Global counters are hidden unless the host granted a global operator.
        consentRevision: globalOperator ? snapshot.consentRevision : 0,
        routes: routes.map((route) => ({ ...route })),
        legacy: legacy.map((record) => ({ ...record })),
        pendingProposals: globalOperator ? snapshot.pendingProposals : 0,
        queues,
      },
      pendingReviews: pending.map((wake) => ({ ...wake })),
    };
  }

  visibleRoutes<R extends Pick<RouteRecord, "chatId" | "workspaceId" | "state">>(principal: RoutePrincipal, routes: readonly R[]): R[] {
    if (principal.kind === "operator") {
      return principal.workspaceId === undefined
        ? [...routes]
        : routes.filter((route) => route.workspaceId === principal.workspaceId);
    }
    return routes.filter((route) =>
      route.state === "active" &&
      route.chatId === principal.chatId &&
      (principal.workspaceId === undefined || route.workspaceId === principal.workspaceId));
  }

  /** Owner may see only its own pending review wakes; operator sees all. */
  canSeeRoute(principal: RoutePrincipal, route: Pick<RouteRecord, "chatId" | "workspaceId">): boolean {
    if (principal.kind === "operator")
      return principal.workspaceId === undefined || route.workspaceId === principal.workspaceId;
    return route.chatId === principal.chatId &&
      (principal.workspaceId === undefined || route.workspaceId === principal.workspaceId);
  }
}
