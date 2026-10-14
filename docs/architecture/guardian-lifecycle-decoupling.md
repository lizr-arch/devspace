# Independent task: decouple Codex Guardian lifecycle from DevSpace MCP

Task ID: `DEVSPACE-WORKER-LIFECYCLE-001`

Status: design only; not part of the connection-reliability deployment.

## Problem

Today the Codex Guardian and Codex child process are owned by the DevSpace server process. The Guardian watches an owner socket and terminates its process group when that socket closes. This prevents orphaned work, but it also makes an HTTP/MCP restart capable of terminating a valid task. A live Coach feed can likewise be hosted by the service process and have connected browser clients.

## Proposed shape

Run task supervision in a separate, user-scoped worker service. The MCP server submits a durable operation record and returns its ID; the worker claims the operation with a lease, records state and native events, and owns the child process group. Closing or upgrading the MCP listener must not signal active workers. Explicit cancellation remains an operation-level request.

Use the existing SQLite state and `operationId` / request-hash semantics where applicable. Persist the worker PID, process group, process start identity, lease owner, operation state, heartbeat, and bounded event cursor. On worker recovery, reconcile the process identity and durable event store before marking work `RECOVERING`, `COMPLETED`, or `FAILED`; never infer failure from an HTTP disconnect.

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

This remains a design and independent follow-up. No worker framework or runtime lifecycle refactor was added to this release.
