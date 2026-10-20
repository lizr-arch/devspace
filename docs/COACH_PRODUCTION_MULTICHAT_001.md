# COACH-PRODUCTION-MULTICHAT-001 — controlled permanent repair

Date 2026-10-20. Source: clean DevSpace main baseline `34c1dda0fc1308f23c689203179597b407c8452e`, fast-forwarded in a **separate managed worktree** to approved Sidecar/Chrome multi-worktree candidate `bcfb54a21126efc6805fc408cf7b2728f95a3dee`. Subsequent local patch narrows uncertain Chrome sends to their individual workspace and releases candidate Chrome v0.3.9. No uncommitted changes in the dirty production main are reset, overwritten or cleaned.

## Precisely reproduced missing-notification diagnosis

- WebGPT TriaRegna plan `tria-battle-llm-duel003-webgpt-currentchat-20261020`, workspace `ws_329c9705-0da2-457d-80a4-77f563c47184`, event `#142`, native Codex `COMPLETED` and immutable evidence `VERIFIED` (exit 0).
- Production Sidecar (port 8765) bound to `ws_9adc027a-b6e2-4003-8e5c-31c1e8840ed4` (DevSpace checkout). Runtime build still exposes old one-workspace `/events` filtering.
- There is **no** verified Chrome `dom_submitted` receipt for event #142. Another WebGPT reviewer has since written a `REVIEW_BLOCKED` verdict; the persisted plan is BLOCKED, no longer `AWAITING_WEBGPT`. Never replay event #142 as an automatic new notification.
- This bug is caused by **runtime deployment and workspace authorization mismatch**, not by native Codex failing to emit an event.

## Isolated fix and verification

1. Server: explicit bounded allowlist of up to 8 workspace IDs, persisted and revalidated at restart. Sidecar reads union of allowed-workspace events and preserves exact event/workspace/operation identity. Unauthorized selectors fail closed. Delivery receipts are scoped to the original workspace ID.
2. Browser: route `workspaceId → authorized canonical ChatGPT conversation URL`, one workspace per chat, durable ledger and unique-tab match on browser restart. Native Messaging handoff requires the fixed allowlisted extension ID and owner-only files; only user authorization permits first binding.
3. Browser v0.3.9 fix: one workspace with uncertain/unconfirmed DOM result blocks **only its own** pending deliveries, not the rest of the author's concurrent Coach conversations. Legacy unknown-scope outcomes still block matching exact operation/event identities. This new negative regression is in `src/coach-auto-delivery.test.cjs`.
4. Test gates: clean isolated `npm ci` PASS, `npm run typecheck` PASS, `npm run test:coach:mac` PASS, `npm run build` PASS. The new isolation patch received `npm run test:coach:observer` PASS (66/66 tests) prior to release-version bump; rerun exact v0.3.9 test after version changes before closing.

## Why production is not silently restarted

- Current production main has unrelated tracked changes and nearly a thousand untracked files. Git integration is prepared in a clean worktree only; **do not modify main until the owners resolve their work**.
- Current runtime has other Codex tasks/plans, so service restart could terminate in-flight guardians. **Do not interrupt them**; preflight `coach_realtime_status`, native agent status and live leases before a controlled restart.
- Chrome Browser connector has no working control channel in Chat mode (NOT_FOUND), so neither browser extension upgrade nor Native Messaging first-time Chrome user permission can be completed from this conversation. Do not assert an unobserved extension upgrade or send.

## Required controlled rollout when safe

1. Preserve the currently installed extension ID `bapcebjlgncogfpgbhllioaichcldkbl`. Copy validated v0.3.9 extension source into the **existing installed unpacked extension directory with backup**, rather than adding a second unpacked directory (which changes the extension ID). Inspect `chrome://extensions` locally to identify the actual installed path; never guess.
2. Integrate tested commits into a clean DevSpace production checkout while preserving existing uncommitted owner changes, build exact release, schedule restart only when no native Codex operations are running and recoverable. Verify schema, boot ID, Sidecar scope and old-session persistence after restart.
3. Run the approved one-time `node scripts/install-coach-native-host.mjs` from a reviewed release tree with the exact `DEVSPACE_STATE_DIR`; this registers a stable, owner-only Chrome Native Messaging host and must be explicitly allowed in Chrome. It never prints the bearer.
4. Start/reconfigure Sidecar from the **upgraded** MCP tool with `authorizedWorkspaceIds` containing exact currently approved Coach workspaces, including primary workspace and `ws_329c9705-0da2-457d-80a4-77f563c47184`. New worktrees require explicit scope renewal; max simultaneous scope is 8 in this release.
5. Bind each ChatGPT conversation URL to its exact DevSpace workspace ID, enable it once, verify distinct A/B real event delivery receipts and exact `coach_webgpt_submit_review` receipts. Do not conflate `dom_submitted` with Web GPT acceptance.
6. Test Chrome restart, token rotation, duplicate/missing tabs, revoked authority and uncertain delivery of one workspace while another still sends. If any live check fails, restore previous extension/runtime without touching other worktrees or misrouting notifications.

Operational limits: the Sidecar feed and Chrome client intentionally fail closed when >50 pending events appear in the authorized union; no pagination is implemented in this release. Browser shutdown and expired ChatGPT login stop browser-dependent Web GPT review. These limitations must be disclosed until fixed.

Final approval levels (not interchangeable): code/build tests; Chrome identity and native host; live bounded multiworktree Sidecar; real A/B browser DOM receipts; reviewer persisted decisions; unattended next-stage dispatch. Production is not PASS until all live gates pass.
