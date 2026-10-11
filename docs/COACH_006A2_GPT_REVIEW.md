# COACH-006-A.2 — Independent Web GPT Review

Review date: 2026-10-11
Verdict: COACH006A2_CODE_AND_TARGETED_GATES_PASS
Production activation: NOT APPROVED / NOT DEPLOYED

## Reviewer's verified scope

1. Inspected original main source and found requestsForCommand applied the conservative workspace exclusive lock to all declared project_task tasks. Confirmed A.1 sidecar resource key policy and that it is not invoked by normal project_task.
2. Independently read Codex's new manager, tool adapter and tests, discovered authentication mismatch, schema envelope and race failures, corrected them, and wrote adversarial tests.
3. Verified real in-process HTTP request/response, readonly SQLite feed with no payloads, fixed loopback, bearer token, paired extension Origin, Host, no data write request, symlink rejection, and bounded result / accurate count.
4. Verified actual TaskRunner code task proceeds while an active managed sidecar occupies same workspace; a second code writer still contends for the workspace lock.
5. Verified actual MCP SDK Client+Server linked transport: start/status/stop, unowned workspace denied with consumable error, and readonly config advertises status ONLY.
6. Verified manager start failure, external port conflict, startup/stop races, idempotent stop, shutdown and token rotation without process spawning or orphan.
7. Ran targeted project tests and compiled TypeScript successfully. Workspace lifecycle tests 50/50; security attack suite 49/49 with pre-existing raw-secret session-output warning.

## Explicit limitations

- In-process service not isolated by OS user or sandbox; database connection is readonly and handler has no arbitrary execution/write API, which is a narrower security claim.
- The service is not self-starting on boot; once DevSpace restarts, the sidecar is stopped and requires explicit authorized start. This intentionally avoids unsafe recovery/replay.
- This is not the browser Wake-Up solution. Ordinary Web GPT cannot yet initiate itself after a completed turn.
- The live DevSpace process still runs the previous built artifact from the operator's earlier checkout. No new MCP tools will be visible until a separate controlled build/restart.
- Current Chrome extension needs pairing with the new bearer token and native event storage. Not integrated in this milestone.

## Recommendation

Keep worktree uncommitted until controlled integration planning. Proceed with a separate A.3 security + pairing/event schema gate, or an explicit reviewed release preparation. Do not restart production merely to expose these new tools before the auth/pairing plan is ready.
