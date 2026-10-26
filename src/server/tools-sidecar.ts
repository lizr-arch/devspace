import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resultOutputSchema, type ServerContext } from "./server-types.js";
import { registerAppTool, textBlock } from "./server-helpers.js";
import { canonicalChatUrl, chatIdFromCanonical } from "../coach-multiroute.js";

const workspaceIdSchema = z.string().min(1);
const portSchema = z.number().int().min(1).max(65535);
const extensionIdSchema = z.string().regex(/^[a-p]{32}$/).optional();
/** Unguessable exact route identity: never derivable from workspace/tab/session. */
const routeIdSchema = z.string().regex(/^rt_[A-Za-z0-9_-]{43}$/);
const dshSessionIdSchema = z.string().regex(/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const routeNonceSchema = z.string().regex(/^[a-f0-9]{32}$/);
const routeMessageIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const routeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const legacyRouteIdSchema = z.string().regex(/^legacy-[a-f0-9]{24}$/);
const routeOriginationSchema = z.enum(["dsh", "webgpt"]);
const routeOutcomeSchema = z.enum([
  "dom_submitted", "manual_sent", "acked", "not_submitted", "uncertain", "timeout",
  "existing_draft", "page_busy", "navigation_mismatch",
]);

// The shared tool wrapper returns {result,error} on rejection. Every output
// schema must accept that envelope so a denied request remains a readable MCP
// error instead of producing a second client-side schema failure.
const optionalError = z.unknown().optional();

export function registerSidecarTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  const { config, workspaces, managedCoachSidecar } = ctx;

  if (!config.readOnly) {
    registerAppTool(
      server,
      "start_coach_sidecar",
      {
        title: "Start coach feed",
        description:
          "Start loopback read-only coach feed. Optional adminObserverScope=all_native_worktrees explicitly grants the paired extension access to redacted native Codex events across THIS DevSpace instance; default is disabled. The pairing token is returned only on successful start.",
        inputSchema: {
          workspaceId: workspaceIdSchema,
          port: portSchema,
          pairedExtensionId: extensionIdSchema,
          // Explicit elevated scope. Existing v0.2 starts default to off.
          adminObserverScope: z.literal("all_native_worktrees").optional(),
          // Explicit, bounded event scope. Never discover or authorize all
          // registered worktrees automatically.
          authorizedWorkspaceIds: z.array(workspaceIdSchema).min(1).max(8).optional(),
          // Explicit per-start consent for exact multi-route DSH sessions.
          // Never persisted implicitly; a Sidecar restart without it fails exact
          // claims closed while already-bound routes keep their durable queues.
          authorizedDshSessionIds: z.array(dshSessionIdSchema).min(1).max(8).optional(),
        },
        outputSchema: resultOutputSchema({
          sidecar: z.unknown().optional(),
          token: z.string().optional(),
          error: optionalError,
        }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, port, pairedExtensionId, adminObserverScope,authorizedWorkspaceIds,authorizedDshSessionIds }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const ids=authorizedWorkspaceIds??[workspaceId];
        if(!ids.includes(workspaceId)||new Set(ids).size!==ids.length)
          throw new Error("COACH_FEED_SCOPE_INVALID");
        // Each additional workspace requires the same explicit MCP-approved
        // root validation as the original workspace.
        for(const id of ids)workspaces.getWorkspace(id);
        const consent={workspaceId,workspaceRoot:workspace.root,port,pairedExtensionId,
          observeAllNativeAgents:adminObserverScope==="all_native_worktrees",
          authorizedWorkspaceIds:ids,
          ...(authorizedDshSessionIds?{authorizedDshSessionIds}:{})};
        const started = await managedCoachSidecar.start(consent);
        try{ctx.coachReviewEvents.saveCoachFeedConfig(consent);}
        catch(error){await managedCoachSidecar.stop(workspaceId);throw error;}
        const { token, ...sidecar } = started;
        const result =
          "Started coach-feed on 127.0.0.1:" +
          sidecar.port +
          ". A one-time bearer token is returned for explicit browser pairing.";
        return {
          content: [textBlock(result)],
          structuredContent: { result, sidecar, token },
        };
      },
    );

    registerAppTool(
      server,
      "stop_coach_sidecar",
      {
        title: "Stop coach feed",
        description:
          "Stop a managed event feed for an authorized workspace. Safe to call repeatedly.",
        inputSchema: { workspaceId: workspaceIdSchema },
        outputSchema: resultOutputSchema({ error: optionalError }),
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId }) => {
        workspaces.getWorkspace(workspaceId);
        await managedCoachSidecar.stop(workspaceId);
        const saved=ctx.coachReviewEvents.coachFeedConfig();
        if(saved?.workspaceId===workspaceId)ctx.coachReviewEvents.clearCoachFeedConfig();
        const result = "Coach feed stopped.";
        return {
          content: [textBlock(result)],
          structuredContent: { result },
        };
      },
    );
  }

  registerAppTool(
    server,
    "coach_delivery_receipt",
    {
      title: "Inspect Chrome Coach delivery evidence",
      description: "Read one browser-submitted, bearer-authenticated event receipt after exact Sidecar event identity verification. A DOM submission receipt is not proof ChatGPT accepted the message or completed a review.",
      inputSchema: {workspaceId:workspaceIdSchema,eventId:z.number().int().positive()},
      outputSchema: resultOutputSchema({receipt:z.unknown().optional(),error:optionalError}),
      _meta:{},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },
    async ({workspaceId,eventId})=>{
      workspaces.getWorkspace(workspaceId);
      if(!managedCoachSidecar.getDeliveryReceipt)throw new Error("COACH_RECEIPT_READER_NOT_SUPPORTED");
      const receipt=await managedCoachSidecar.getDeliveryReceipt(workspaceId,eventId);
      const result=receipt?"Browser DOM submission receipt found.":"No verified browser receipt exists for this event.";
      return {content:[textBlock(result)],structuredContent:{result,...(receipt?{receipt}:{})}};
    }
  );

  // Read-only exact-route state. Legacy workspace-only routes are reported as
  // UNROUTABLE with an explicit migration hint; this tool never mutates routing.
  registerAppTool(
    server,
    "coach_route_state",
    {
      title: "Inspect exact Coach multi-route state",
      description:
        "Read exact per-route queue/cursor/ACK state. action=snapshot lists exact routes, legacy UNROUTABLE routes and pending review wakes (a DOM submission is NOT a completed GPT review); action=inbox lists route messages for one exact route; action=classify_legacy marks an old workspace-only record UNROUTABLE and never guesses a target.",
      inputSchema: {
        action: z.enum(["snapshot", "inbox", "classify_legacy"]),
        workspaceId: workspaceIdSchema.optional(),
        routeId: routeIdSchema.optional(),
        origination: routeOriginationSchema.optional(),
        afterSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        legacyId: legacyRouteIdSchema.optional(),
        messageId: routeMessageIdSchema.optional(),
      },
      outputSchema: resultOutputSchema({ snapshot: z.unknown().optional(), messages: z.unknown().optional(), classification: z.unknown().optional(), pendingReviews: z.unknown().optional(), error: optionalError }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const { action, workspaceId, routeId, origination, afterSeq, limit, legacyId, messageId } = args;
      if (!managedCoachSidecar.routeSnapshot) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
      const snapshot = managedCoachSidecar.routeSnapshot();
      const requireRoute = () => {
        if (!routeId) throw new Error("ROUTE_INVALID_INPUT: routeId is required");
        const route = snapshot.routes.find((item) => item.routeId === routeId);
        if (!route) throw new Error("ROUTE_NOT_FOUND");
        if (workspaceId && route.workspaceId !== workspaceId) throw new Error("ROUTE_WORKSPACE_MISMATCH");
        return route;
      };
      if (action === "snapshot") {
        // Host-verified principal, never the optional workspaceId argument.
        const principal = await managedCoachSidecar.authorizeRouteAction("snapshot", extra);
        const visible = managedCoachSidecar.visibleRoutesForPrincipal(principal, snapshot.routes);
        const routes = workspaceId ? visible.filter((route) => route.workspaceId === workspaceId) : visible;
        const visibleIds = new Set(routes.map((route) => route.routeId));
        const pendingReviews = (managedCoachSidecar.pendingReviewWakes?.() ?? [])
          .filter((wake) => visibleIds.has(wake.routeId))
          .filter((wake) => !workspaceId || wake.workspaceId === workspaceId);
        const legacy = principal.kind === "operator" ? snapshot.legacy : [];
        const result = "Exact routes=" + routes.length + " legacy=" + legacy.length + " pendingReviews=" + pendingReviews.length + ".";
        return { content: [textBlock(result)], structuredContent: { result, snapshot: { ...snapshot, routes, legacy }, pendingReviews } };
      }
      if (action === "inbox") {
        const route = requireRoute();
        await managedCoachSidecar.authorizeRouteAction("inbox", extra, route);
        if (!managedCoachSidecar.listRouteMessages) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        const messages = managedCoachSidecar.listRouteMessages({
          routeId: route.routeId,
          ...(origination ? { origination } : {}),
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const result = "Route inbox messages=" + messages.length + ".";
        return { content: [textBlock(result)], structuredContent: { result, messages } };
      }
      await managedCoachSidecar.authorizeRouteAction("classify_legacy", extra);
      if (!managedCoachSidecar.classifyLegacyMessage) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
      const classification = managedCoachSidecar.classifyLegacyMessage({
        ...(legacyId ? { legacyId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(messageId ? { messageId } : {}),
      });
      const result = "Legacy message classification=" + classification.state + " (" + classification.reason + ").";
      return { content: [textBlock(result)], structuredContent: { result, classification } };
    },
  );

  if (!config.readOnly) {
  // The browser challenge is created only by a user clicking the extension in
  // one concrete ChatGPT tab. This MCP action proves which DevSpace workspace
  // that exact conversation is reviewing, without reading chat history.
  registerAppTool(
    server,
    "coach_webgpt_claim_browser_route",
    {
      title:"Claim a one-click Coach browser binding",
      description:"Use only after receiving a binding request in THIS ChatGPT conversation. Read its exact nonce and canonical chat URL and identify the DevSpace workspace this conversation actually owns. Never guess an active or most-recent workspace. Claims expire and are scoped to the browser's authenticated Sidecar.",
      inputSchema:{workspaceId:workspaceIdSchema,nonce:z.string().regex(/^[a-f0-9]{32}$/),url:z.string().url().max(400)},
      outputSchema:resultOutputSchema({claimed:z.boolean().optional(),error:optionalError}),
      _meta:{},
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },
    async ({workspaceId,nonce,url}, extra)=>{
      workspaces.getWorkspace(workspaceId);
      const canonical = canonicalChatUrl(url);
      if (!canonical) throw new Error("ROUTE_INVALID_INPUT: url is not a canonical ChatGPT conversation");
      await managedCoachSidecar.authorizeRouteClaim("claim_browser_route", extra, { workspaceId, chatId: chatIdFromCanonical(canonical) });
      if(!managedCoachSidecar.claimBrowserRoute)throw new Error("COACH_BIND_NOT_SUPPORTED");
      const claimed=managedCoachSidecar.claimBrowserRoute(workspaceId,nonce,url,(nextScope)=>{
        const saved=ctx.coachReviewEvents.coachFeedConfig();
        if(!saved || !nextScope.includes(saved.workspaceId) ||
           nextScope.length>8 || new Set(nextScope).size!==nextScope.length)
          throw new Error("COACH_BIND_SCOPE_PERSISTENCE_DENIED");
        ctx.coachReviewEvents.saveCoachFeedConfig({...saved,authorizedWorkspaceIds:nextScope});
      });
      const result=claimed?"Exact browser route claimed; browser may finish the one-click authorization.":"Binding request expired, mismatched, duplicated, or unauthorized.";
      return {content:[textBlock(result)],structuredContent:{result,claimed}};
    },
  );

  }

  if (!config.readOnly) {
  // Precise multi-route binding: the legacy workspace-only tool above keeps its
  // exact old semantics; this tool additionally proves the exact unguessable
  // routeId, DSH session id, one-time browser nonce and canonical chat URL.
  registerAppTool(
    server,
    "coach_webgpt_claim_browser_route_exact",
    {
      title: "Claim an exact Coach multi-route binding",
      description:
        "Use only after the Paired Chrome extension sends a binding request in THIS ChatGPT conversation. Read its exact routeId, nonce and canonical chat URL, and supply the exact DSH session id that is explicitly authorized on this machine. One chat keeps exactly one DSH route; switching requires replaceRouteId + expectedConsentRevision after an explicit revoke/rebind. Never guess a routeId, session id or workspace.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        routeId: routeIdSchema,
        dshSessionId: dshSessionIdSchema,
        nonce: routeNonceSchema,
        url: z.string().url().max(2048),
        replaceRouteId: routeIdSchema.optional(),
        expectedConsentRevision: z.number().int().min(1).optional(),
      },
      outputSchema: resultOutputSchema({ claimed: z.boolean().optional(), route: z.unknown().optional(), code: z.string().optional(), error: optionalError }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, routeId, dshSessionId, nonce, url, replaceRouteId, expectedConsentRevision }, extra) => {
      workspaces.getWorkspace(workspaceId);
      const canonical = canonicalChatUrl(url);
      if (!canonical) throw new Error("ROUTE_INVALID_INPUT: url is not a canonical ChatGPT conversation");
      await managedCoachSidecar.authorizeRouteClaim("claim_browser_route_exact", extra, { workspaceId, chatId: chatIdFromCanonical(canonical) });
      if (!managedCoachSidecar.claimExactBrowserRoute) throw new Error("COACH_EXACT_ROUTE_BIND_NOT_SUPPORTED");
      const claimed = await managedCoachSidecar.claimExactBrowserRoute({
        workspaceId, routeId, dshSessionId, nonce, url,
        ...(replaceRouteId ? { replaceRouteId } : {}),
        ...(expectedConsentRevision !== undefined ? { expectedConsentRevision } : {}),
        persistScope: (nextScope) => {
          const saved = ctx.coachReviewEvents.coachFeedConfig();
          if (!saved || !nextScope.includes(saved.workspaceId) || nextScope.length > 8 ||
              new Set(nextScope).size !== nextScope.length)
            throw new Error("COACH_ROUTE_SCOPE_PERSISTENCE_DENIED");
          ctx.coachReviewEvents.saveCoachFeedConfig({ ...saved, authorizedWorkspaceIds: nextScope });
        },
      });
      const result = claimed.claimed
        ? "Exact route claimed: chat now owns exactly one DSH route."
        : "Exact route claim rejected (" + (claimed.code || "unknown") + "); no authority was granted.";
      return {
        content: [textBlock(result)],
        structuredContent: {
          result, claimed: claimed.claimed,
          ...(claimed.route ? { route: claimed.route } : {}),
          ...(claimed.code ? { code: claimed.code } : {}),
        },
      };
    },
  );

  registerAppTool(
    server,
    "coach_route_admin",
    {
      title: "Durable exact-route queue operations",
      description:
        "Write side of the exact multi-route contract. revoke requires an explicit routeId (and optional expectedConsentRevision) and never auto-rebinds. enqueue_wake stores a fixed review wake generated from routeId/messageId/event identity; reply stores legacy message data only. trusted_reply requires exact sessionId/revision and host-verified WebGPT principal; it dispatches and reconciles the stable bridge requestId, fail closed when unavailable. claim_delivery/reply ack/resolve operate on exact (messageId,seq,contentSha256); timeout/draft/busy/navigation outcomes become needs_attention and are never retried blindly. A DOM submission is never a completed review.",
      inputSchema: {
        action: z.enum(["revoke", "enqueue_wake", "reply", "trusted_reply", "claim_delivery", "ack", "resolve", "migrate_legacy"]),
        workspaceId: workspaceIdSchema.optional(),
        routeId: routeIdSchema.optional(),
        legacyId: legacyRouteIdSchema.optional(),
        targetRouteId: routeIdSchema.optional(),
        expectedConsentRevision: z.number().int().min(1).optional(),
        messageId: routeMessageIdSchema.optional(),
        inReplyTo: routeMessageIdSchema.optional(),
        sessionId: dshSessionIdSchema.optional(),
        content: z.string().min(1).max(48 * 1024).optional(),
        eventId: z.number().int().positive().optional(),
        operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
        origination: routeOriginationSchema.optional(),
        limit: z.number().int().min(1).max(8).optional(),
        seq: z.number().int().min(1).optional(),
        contentSha256: routeSha256Schema.optional(),
        outcome: routeOutcomeSchema.optional(),
        resolveAction: z.enum(["retry", "mark_sent"]).optional(),
        reason: z.string().max(160).optional(),
      },
      outputSchema: resultOutputSchema({ route: z.unknown().optional(), message: z.unknown().optional(), messages: z.unknown().optional(), legacy: z.unknown().optional(), code: z.string().optional(), error: optionalError }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const { action, routeId, workspaceId, reason } = args;
      if (!managedCoachSidecar.routeSnapshot) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
      const requireRoute = () => {
        if (!routeId) throw new Error("ROUTE_INVALID_INPUT: routeId is required");
        const route = managedCoachSidecar.routeSnapshot!().routes.find((item) => item.routeId === routeId);
        if (!route) throw new Error("ROUTE_NOT_FOUND");
        if (workspaceId && route.workspaceId !== workspaceId) throw new Error("ROUTE_WORKSPACE_MISMATCH");
        return route;
      };
      if (action === "revoke") {
        const route = requireRoute();
        await managedCoachSidecar.authorizeRouteAction("revoke", extra, route);
        if (!managedCoachSidecar.revokeBrowserRoute) throw new Error("COACH_ROUTE_REVOKE_NOT_SUPPORTED");
        const revoked = managedCoachSidecar.revokeBrowserRoute({
          routeId: routeId!, ...(args.expectedConsentRevision !== undefined ? { expectedConsentRevision: args.expectedConsentRevision } : {}),
          ...(reason ? { reason } : {}),
        });
        const result = revoked.claimed ? "Exact route revoked; it never auto-rebinds." : "Route revoke rejected (" + (revoked.code || "unknown") + ").";
        return { content: [textBlock(result)], structuredContent: { result, ...(revoked.route ? { route: revoked.route } : {}), ...(revoked.code ? { code: revoked.code } : {}) } };
      }
      if (action === "migrate_legacy") {
        await managedCoachSidecar.authorizeRouteAction("migrate_legacy", extra);
        if (!managedCoachSidecar.migrateLegacyRoute) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        if (!args.legacyId || !args.targetRouteId) throw new Error("ROUTE_INVALID_INPUT: legacyId and targetRouteId are required");
        const legacy = managedCoachSidecar.migrateLegacyRoute({
          legacyId: args.legacyId, targetRouteId: args.targetRouteId,
          ...(args.expectedConsentRevision !== undefined ? { expectedConsentRevision: args.expectedConsentRevision } : {}),
        });
        const result = "Legacy route explicitly migrated; prior messages remain UNROUTABLE history.";
        return { content: [textBlock(result)], structuredContent: { result, legacy } };
      }
      const route = requireRoute();
      const actionAuth: Record<string, "enqueue_wake" | "trusted_reply" | "reply" | "claim_delivery" | "ack" | "resolve"> = {
        enqueue_wake: "enqueue_wake", trusted_reply: "trusted_reply", reply: "reply",
        claim_delivery: "claim_delivery", ack: "ack", resolve: "resolve",
      };
      const authorizedAction = actionAuth[action];
      if (!authorizedAction) throw new Error("ROUTE_INVALID_INPUT: unknown action");
      await managedCoachSidecar.authorizeRouteAction(authorizedAction, extra, route);
      if (action === "enqueue_wake") {
        if (!managedCoachSidecar.enqueueRouteReviewWake) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        if (!args.messageId || args.eventId === undefined || !args.operationId) throw new Error("ROUTE_INVALID_INPUT: messageId,eventId,operationId are required");
        const enqueued = managedCoachSidecar.enqueueRouteReviewWake({
          routeId: routeId!, messageId: args.messageId, eventId: args.eventId, operationId: args.operationId,
        });
        const result = enqueued.duplicate ? "Review wake already existed (idempotent)." : "Review wake durably enqueued at seq " + enqueued.envelope.seq + ".";
        return { content: [textBlock(result)], structuredContent: { result, message: enqueued.envelope } };
      }
      if (action === "trusted_reply") {
        if (!managedCoachSidecar.submitTrustedRouteReply || !args.messageId || !args.sessionId ||
            args.expectedConsentRevision === undefined || !args.inReplyTo || !args.content)
          throw new Error("BRIDGE_TRUSTED_REPLY_INPUT_REQUIRED");
        const reply = await managedCoachSidecar.submitTrustedRouteReply({ routeId: routeId!,
          sessionId: args.sessionId, consentRevision: args.expectedConsentRevision,
          messageId: args.messageId, inReplyTo: args.inReplyTo, content: args.content }, extra);
        const result = "Trusted reply dispatch=" + reply.dispatch.state + "; only bridge receipt confirms completion.";
        return { content: [textBlock(result)], structuredContent: { result, message: reply } };
      }
      if (action === "reply") {
        if (!managedCoachSidecar.enqueueRouteReply) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        if (!args.messageId || !args.inReplyTo || !args.content) throw new Error("ROUTE_INVALID_INPUT: messageId,inReplyTo,content are required");
        const enqueued = managedCoachSidecar.enqueueRouteReply({
          routeId: routeId!, messageId: args.messageId, content: args.content, inReplyTo: args.inReplyTo,
        });
        const result = enqueued.duplicate ? "Reply already existed (idempotent)." : "WebGPT reply durably enqueued at seq " + enqueued.envelope.seq + ".";
        return { content: [textBlock(result)], structuredContent: { result, message: enqueued.envelope } };
      }
      if (action === "claim_delivery") {
        if (!managedCoachSidecar.claimRouteDeliveries) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        const messages = managedCoachSidecar.claimRouteDeliveries({
          routeId: routeId!, origination: args.origination ?? "webgpt",
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        const result = "Claimed " + messages.length + " durable message(s).";
        return { content: [textBlock(result)], structuredContent: { result, messages } };
      }
      if (action === "ack" || action === "resolve") {
        if (!args.messageId || args.seq === undefined || !args.contentSha256) throw new Error("ROUTE_INVALID_INPUT: messageId,seq,contentSha256 are required");
        if (action === "ack") {
          if (!args.outcome) throw new Error("ROUTE_INVALID_INPUT: outcome is required");
          if (!managedCoachSidecar.recordRouteOutcome) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
          const message = managedCoachSidecar.recordRouteOutcome({
            routeId: routeId!, messageId: args.messageId, seq: args.seq, contentSha256: args.contentSha256,
            outcome: args.outcome, ...(reason ? { reason } : {}),
          });
          const result = "Message state=" + message.state + " (dom_submitted is a browser receipt, not a completed review).";
          return { content: [textBlock(result)], structuredContent: { result, message } };
        }
        if (!args.resolveAction) throw new Error("ROUTE_INVALID_INPUT: resolveAction is required");
        if (!managedCoachSidecar.resolveRouteAttention) throw new Error("COACH_ROUTE_STORE_NOT_SUPPORTED");
        const message = managedCoachSidecar.resolveRouteAttention({
          routeId: routeId!, messageId: args.messageId, seq: args.seq, contentSha256: args.contentSha256,
          action: args.resolveAction, ...(reason ? { reason } : {}),
        });
        const result = "Explicit operator resolution applied: state=" + message.state + ".";
        return { content: [textBlock(result)], structuredContent: { result, message } };
      }
      throw new Error("ROUTE_INVALID_INPUT: unknown action");
    },
  );

  }

  registerAppTool(
    server,
    "coach_sidecar_status",
    {
      title: "Coach feed status",
      description:
        "Inspect a managed local event feed; the bearer token is never included.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema: resultOutputSchema({
        sidecar: z.unknown().optional(),
        error: optionalError,
      }),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      workspaces.getWorkspace(workspaceId);
      const sidecar = await managedCoachSidecar.status(workspaceId);
      const result = sidecar ? "Coach feed is running." : "Coach feed is stopped.";
      return {
        content: [textBlock(result)],
        structuredContent: { result, ...(sidecar ? { sidecar } : {}) },
      };
    },
  );
}
