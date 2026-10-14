# Independent task: decouple Codex Guardian lifecycle from DevSpace MCP

Task ID: `DEVSPACE-WORKER-LIFECYCLE-001`

Status: implementation in progress on `feat/devspace-reliability-002`; not production deployed or lifecycle-accepted.

## Problem

Today the Codex Guardian and Codex child process are owned by the DevSpace server process. The Guardian watches an owner socket and terminates its process group when that socket closes. This prevents orphaned work, but it also makes an HTTP/MCP restart capable of terminating a valid task. A live Coach feed can likewise be hosted by the service process and have connected browser clients.

## Proposed shape

Run task supervision in a separate, user-scoped Worker service. The MCP server retains OAuth and Workspace authorization and submits bounded structured requests over a private Unix socket; the Worker owns the runner, Guardian, Codex child process group, and durable run journal. `devspace codex-worker` starts the Worker. Set `DEVSPACE_CODEX_WORKER_SOCKET` for the API to use its `CodexWorkerClient`; unset it to retain the legacy in-process adapter during controlled rollout. API close on the Worker path deliberately does not call stop or close on the independent Worker.

Use the existing SQLite state and `(workspaceId, operationId, requestSha256)` identity. Schema v5 records Worker PID/UID/start identity and generation lease, per-run generation and heartbeat, cancellation timestamp, and event cursor. Claims, per-run heartbeats, and finalization are fenced by the active Worker generation. The UDS and random secret file are mode `0600`; state directory is mode `0700`; only configured allowed roots are accepted; malformed or unauthenticated calls fail closed. Process identity uses PID, UID, and macOS `lstart`, never PID alone. Same-ID/same-fingerprint retries return the saved state without a second spawn; changed fingerprints are rejected. No automatic replay of an uncertain side effect is allowed.

Current recovery policy is intentionally conservative: if an old Worker is proven dead, all of its active Guardian identities and process groups must also be verified gone before a replacement acquires a new generation. Missing, live, PID-reused, or unreadable Guardian identity blocks takeover; no signal is sent to an uncertain PID. After verified cleanup, terminal evidence can be recovered, otherwise the run becomes `INTERRUPTED` and is never replayed. Live Guardian reattachment is not implemented, so an abnormal Worker loss quarantines rather than resumes work.

The redacted Native Agent Observer now uses a bounded SQLite journal with monotonic global cursor and explicit gap/reset behavior, shared by API and Worker generations. Coach Feed is hosted inside that independent Worker process: API restart leaves the listener and existing token alive; Worker restart reloads the protected token and exact saved workspace/scope. This keeps the service boundary small, though Worker and Coach share a process failure domain.

## Required rollout protocol

1. Add an explicit admission gate for new side-effecting work and expose a `DRAINING` readiness state.
2. Keep existing workers and Coach feed clients alive while new work is rejected or routed to the next server generation.
3. Wait for MCP requests to drain; query durable job and agent registries and verify child process identities.
4. Restart only the API/MCP process while worker and feed services remain available.
5. Reopen admission after health, OAuth, schema, tunnel, workspace, and persisted-result checks pass.
6. Provide bounded rollback and stale-lease recovery; never use PID alone as proof of process identity.

## Acceptance criteria for the separate task

- API process restart does not terminate a running Codex task, background Job, or connected Coach feed.
- Reconnect after restart can observe prior operation IDs, native event cursors, results, and explicit cancellation state.
- Duplicate requests with the same `operationId` and request hash do not repeat side effects; mismatched hashes are rejected.
- Drain blocks new side-effecting operations without disabling read-only status and recovery tools.
- Failure injection covers worker restart, API restart, stale lease, client disconnect, completion-before-response, and process identity reuse.
- Deployment tooling refuses restart if workers cannot prove durable recovery state.

## Unfinished acceptance items

- Add a user LaunchAgent plist/install and rollback path for the Worker; validate launchd boot/login behavior.
- The Worker and real API restart E2E currently cover Native Codex operations. Existing `BackgroundJobManager.close()` still marks running jobs interrupted and terminates their groups; move that ownership to the Worker or prove a deploy drain waits safely for those jobs.
- Add deployment `SERVING`/`DRAINING`/`RESTARTING` admission integration and keep read-only recovery calls available during drain.
- Prove UDS auth, Worker shutdown/restart, real PID identity, API restart with a real Codex CLI task, event cursor continuity, and no duplicate side effects on an authorized macOS test host.
- Validate Coach restart, browser reconnect, and exact-scope recovery in a real browser; the current automated browser surface timed out.
- Inject client abort, failed HTTP response write, tool timeout, completion-before-response-loss, and explicit cancellation; the current diagnostics unit test exercises classification only.
- Run public Cloudflare 100 sequential/20 concurrent calls with injected transport failures and finish the E01–E16 recovery matrix before production deployment.

Local UDS and loopback HTTP lifecycle tests now run and pass on macOS. The production Worker/Coach service is not installed; no production service was changed or restarted.
