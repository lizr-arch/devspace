# COACH-008.2 independent release audit R2

## Verdict: ACCEPTED_FOR_DEPLOY

No P0/P1 defect remains evident in the current full diff and key new files, subject to the outstanding Chrome GUI gate below. The operator-reported typecheck, audit/observer/mac regression, and build results are consistent with the inspected implementation; I did not rerun tests.

## R1 disposition

- **Native item pairing fixed.** `src/agent-observer.ts:32-52` preserves a validated native `item.id` as `actionId` for the private audit path. `src/codex-agent-runner.ts:430-439` uses that for `AuditTrace`; the observer cursor remains only evidence location. `src/agent-efficiency-audit.ts:74-92` therefore pairs one native item across started/completed events and reports interrupted items correctly.
- **Repeated inputs and mutation boundaries fixed.** `src/agent-observer.ts:43-49` hashes only bounded command input in memory and marks completed file changes; `src/codex-agent-runner.ts:430-439` supplies both to the analyzer; `src/agent-efficiency-audit.ts:104-128` detects recurrence conservatively and clears prior inputs at observed mutation boundaries. Raw commands are not exported.
- **No raw command/prompt leak found.** `AgentObserverStore.emit` at `src/agent-observer.ts:53-71` copies only the allowlisted public fields, dropping `actionId` and `inputHash`; the audit snapshot/evidence projection at `src/agent-efficiency-audit.ts:146-168` contains only bounded metadata. The inspected integration fixture also asserts the secret command and prompt do not persist.
- **SQLite integrity and retention addressed.** `src/coach-review-events.ts:115-147` enforces a 48 KiB row limit, stores a SHA-256 digest, verifies it on reopen/read, and retains at most 512 audit rows. `src/managed-coach-sidecar.ts:158-177` independently verifies size, digest, identity, and version. The tested tamper case (JSON changed without a matching digest) is rejected by both paths.
- **Authorization and exact tool path addressed.** `src/server/tools-agent-audit.ts:5-19` registers the read-only exact MCP tool and authorizes the workspace before the parameterized `(workspaceId, operationId)` lookup. The sidecar gates `/agent/audit` behind explicit `observeAllNativeAgents` at `src/managed-coach-sidecar.ts:153-154`, then requires loopback Host, bearer token, origin, GET, exact query keys, and scoped identity. The default sidecar does not grant cross-worktree access.
- **Persistent panel result fixed.** `coach-browser-extension/panel.js:20-65` renders bounded audit state into dedicated summary/findings/evidence nodes, while polling updates only `#note` at `panel.js:121-132`; the result is not overwritten on the next 1.5-second poll. `coach-browser-extension/manifest.json:14` adds an explicit CSP, and `worker.js:74-108` checks MIME, response size, v1 identity, status, and array bounds. DOM output uses `textContent`/created nodes.

## Functional/security limitations accepted

The audit is intentionally loss-based: `agent_intent_unavailable`, redacted tool results, and unobserved external side effects remain normal coverage gaps. Trace truncation is explicitly reported at `src/agent-efficiency-audit.ts:65-68,94-103`; counts are not claimed as whole-run totals. SHA-256 detects accidental or one-sided row tampering but is not a MAC against an attacker who can write both the JSON and digest; the design documentation explicitly states this limitation, and the database is protected by the private state directory/file permissions. `sourceChange` is a workspace fingerprint delta, not proof of correctness or Git quality. These are honest P2/product limitations, not release-blocking defects for this bounded local audit.

## Outstanding gate

The remaining acceptance item is a real Chrome GUI smoke check, not covered by VM tests: reload the extension, pair it with the newly started sidecar, launch a new DevSpace native task, click **查看审计**, verify the findings remain visible across a real poll, and confirm the same snapshot is available through MCP after service/sidecar restart and re-pairing. Until that check is performed, do not claim complete browser release validation; it does not change this code-review verdict.
