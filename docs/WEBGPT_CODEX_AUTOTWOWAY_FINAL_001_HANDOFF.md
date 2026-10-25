# WEBGPT_CODEX_AUTOTWOWAY_FINAL_001 cold-read handoff

Task v1 SHA-256: `67cdef5276fa140aecf253da0c5eef53c6162e5f6d68a07ebc633299887e1c1d`.
Execution workspace: `ws_7931b287-111e-4428-80a4-ab1357f9d316`.
Operation/stage: `webgpt-codex-autotwoway-final-20261025-s0-r1` / `automated-loop`.
Base: `33b9519e30700f750397bdd046d23f0f04e3aeb3`.

Overall acceptance is **BLOCKED**. The source implementation and offline protocol checks are available for independent review. No production deployment, restart, browser automation, real model smoke, review writeback, or GUI writer-lock manipulation occurred. This implementing CLI did not acknowledge a real Web GPT turn.

The code commit was also blocked: automatic approval rejected the explicit `git_stage_paths` call because the tool requires approval while policy is `never`. No Git metadata workaround was attempted. HEAD remains the base above and the index is empty. `implementation.patch` contains all eighteen implementation/test/handoff files, including new files, for review or a later authorized commit. Project Memory preflight was separately rejected by the same automatic approval policy.

The machine-readable report is `.devspace/coach/tasks/WEBGPT_CODEX_AUTOTWOWAY_FINAL_001/results/webgpt-codex-autotwoway-final-20261025-s0-r1.json`. All evidence for this operation is under `reports/evidence/WEBGPT_CODEX_AUTOTWOWAY_FINAL_001/webgpt-codex-autotwoway-final-20261025-s0-r1/`. Its `source-inventory.json` pins source hashes and Git state; `test-runs.json` preserves every actual child command, exit code, duration and raw-log SHA, including initial failures. The report's test claims require independent verification.

## Assessment of WHY

The inspected historical JSONL has SHA `85ced413a5708de2268a3b62a33cad2eb970e80a6ebe5e6001ab4e84fdd7b8e6`, thread `01a16eed-1a2c-7473-92c2-1e8ffb92d43f`, one `turn.completed` and exact final message `WEBGPT_CODEX_CLI_AUTOWAKE_READY`. The supported evidence tool returns a custom packet without `finalFingerprint`; the managed status tool returns `CODEX_OPERATION_NOT_FOUND`. `CoachReviewGate.packet()` necessarily rejects that packet. A synthetic legacy packet test reproduces the rejection and preserves its BLOCKED decision. Actual event 240 was only inspected through read-only tools; it was never re-published, patched, resumed, or reviewed again.

The native runner already supports bounded Git/non-Git snapshots, durable identities and verified same-thread resume. The scheduler already supports bounded Web GPT REWORK. Keeping this runner avoids an import/DB-injection architecture and avoids broadening the large-root snapshot budget. No task assumption requires PLAN_CONFLICT.

Source inspection also found that the independent-worker Coach client lacked browser-claim IPC even though the API exposed the claim tool, and the extension rejected any queue longer than fifty despite the paginated server feed. Both paths are implemented here.

## Implemented chain and trust boundaries

1. `NativeCodexAgentRunner.run()` canonicalizes the execution root and freezes the request identity before the durable run claim. Optional `delivery: {workspaceId, nonce}` refers only to a previously successful one-click browser claim. The start MCP tool validates both workspace registrations; the runner checks the stored nonce. It cannot accept an arbitrary URL, socket path, or an unfrozen task.
2. The runner captures the existing bounded fingerprint before and after execution. New packets include canonical `sourceRoot`, runner module SHA, native thread ID, actual exit, event types, stream hashes, and bounded exact agent messages with hashes for delivery-enabled runs. A delivery-enabled completion without an agent message fails closed. The evidence store computes/verifies immutable packet hashes and rejects replacement.
3. The event feed selects by the separately claimed delivery workspace and current nonce while preserving the original execution `workspace_id`, operation and event ID. The browser must hold that exact route nonce. Notifications contain short event identities and safe metadata; Web GPT fetches the original packet through MCP.
4. Browser receipts retain the original execution identity and require the paired bearer, extension origin, matching event/operation and current scoped grant. The worker supports the browser-claim RPC without changing daemon ownership or launch behavior.
5. `coach_webgpt_acknowledge_turn` records a separate reviewer MCP acknowledgment only after the authenticated DOM receipt and exact evidence hash exist. `coach_delivery_receipt` exposes both records. An acknowledgment is an authenticated reviewer assertion, **not ChatGPT platform attestation**: another host with the same MCP authority could invoke the tool. Actual new-turn acceptance must therefore be independently observed in the authorized Web GPT conversation; this operation provides no such live proof.
6. Delivery-enabled REWORK/APPROVED require that acknowledgment, a completed matching managed run, the canonical source root and current fingerprint. APPROVED retains the existing approved deterministic-test gate. The existing supported verdict tools and scheduler are reused. Delivery grants propagate through same-session rework and bounded development continuations. BLOCKED and final APPROVED dispatch no rework.
7. The extension accumulates at most eight pages / 400 pending events, rejecting cursor loops, duplicate valid identities and changing totals. Busy chats back off for sixty seconds while other authorized conversations proceed. Uncertain submissions block their delivery route, survive worker restart, and never automatically replay. Pairing secrets remain session-only; rotation invalidates the old bearer. Source extension version is 0.3.15; this is not a claim about the installed extension.

## Verification and remaining acceptance

The existing native runner, frozen-task/manifest/proof safety tests, signed review gate, Web GPT scheduler and tool-catalog checks passed. The new full protocol test passes with `node --import tsx src/coach-cli-delivery.integration.test.ts --in-process-http`: fake CLI child processes, real SQLite and MCP tool handlers, simulated browser receipt, in-process HTTP request transport, one bounded same-thread REWORK, second callback, duplicate/replay, wrong workspace/root/nonce, hash tamper, dirty fingerprint, missing receipt/ack, handmade unmanaged packet and token rotation. It explicitly does **not** prove real Codex or Chrome acceptance.

The final browser suite covers exact route grants, execution/delivery separation, pagination, uncertain delivery, duplicate suppression and busy-chat isolation. Typecheck and the full build pass after a workspace-local dependency-link directory gives Vite a writable local temporary directory; installed source-checkout dependencies were not modified. Initial failed checks and the subsequent fixes remain in the evidence index.

Real TCP tests cannot listen on `127.0.0.1` in this sandbox (`EPERM`, exit 1). The worker test passes its fencing/quarantine checks but explicitly reports its private Unix socket lifecycle NOT RUN for the same restriction. Those portions remain unverified. The original TCP integration mode remains available for an independently authorized environment.

Live inspection reports no automatic plan for this execution workspace and no running sidecar entry under this workspace ID; that response says nothing about other workspace services. No fresh one-click nonce for this task, actual new-turn receipt, independent Web GPT verdict or genuine two-round session was available. The frozen task explicitly allows retaining BLOCKED when these prerequisites are absent. No real smoke was started without them.

After independent source review and separate deployment authorization, the reviewer must use a fresh one-click claim for the intended delivery workspace, a frozen scoped read-only smoke task and approved deterministic test, then start a **new** managed operation with that delivery grant. Register `coach_webgpt_register` with `reviewerMode=webgpt`, one stage and `maxReworks=1`. In the actual notification-triggered Web GPT turn, fetch original evidence, confirm the DOM receipt, call the acknowledgment tool, inspect source/test evidence and submit the actual supported MCP verdict. Verify the second completion uses the same thread and a new operation/event, receives its own DOM receipt and actual new Web GPT turn, then independently approve or block. Never reuse event 240 or its operations.

No APPROVED verdict for this implementation is implied by this handoff.
