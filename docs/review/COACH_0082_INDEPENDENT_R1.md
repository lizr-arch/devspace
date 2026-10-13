# COACH-008.2 independent audit R1

## Verdict: NO-GO

P1 defects remain in the core audit result. Release is not acceptable until the gates below pass.

## Findings

- **P1 — item correlation is incorrect and produces pseudo-findings.** `src/codex-agent-runner.ts:430-433` assigns each projected event the observer cursor as `AuditTrace.id`; `src/agent-observer.ts:20-35` drops the native `item.id`; `src/agent-efficiency-audit.ts:18-23` matches starts/completions by that ID. A normal `item.started` and `item.completed` receive different cursors, so a completed item is reported as unfinished. Reproduce with one item having the same native `item.id`: `analyzeAgentEfficiency` receives IDs `10` and `11`, yielding `unfinished-steps`. Preserve/validate Codex `item.id` for correlation and use cursor only as evidence location.

- **P1 — repeated-operation detection is not wired to real input evidence.** `stableInputHash` exists at `src/agent-efficiency-audit.ts:15`, but the runner never supplies `inputHash` or `sourceMutation` (`src/codex-agent-runner.ts:430-433,606-612`); normalization also has no redacted input projection (`src/agent-observer.ts:20-35`). Thus the repeated-actions path at `src/agent-efficiency-audit.ts:24-26` cannot fire for production operations. Do not claim coverage until hashes are derived from bounded, redacted tool inputs and mutation boundaries are evidenced.

- **P1 — the audit is stored durably but not integrity-authenticated.** `src/coach-review-events.ts:120-130` stores mutable JSON and checks only identity/version on read; `src/managed-coach-sidecar.ts:155-160` repeats only the identity check. A same-scope snapshot can be altered without detection. Add a durable digest/MAC or derive the snapshot from authenticated event records, and test tamper detection plus migration from pre-v4 databases.

- **P2 — JSONL boundedness is incomplete at the audit boundary.** The runner caps parsed lines at 4000 (`src/codex-agent-runner.ts:422`) and the analyzer truncates the trace to 512 (`src/agent-efficiency-audit.ts:18`), but `countsByEventKind` then describes only the truncated trace and there is no explicit truncation/missing-evidence marker. The 48 KiB DB check (`src/coach-review-events.ts:120-123`) is a late failure that silently changes runner reason (`src/codex-agent-runner.ts:606-613`). Add explicit truncation evidence and a tested failure/coverage contract.

- **P2 — click result is injected into the polling status note.** `src/coach-browser-extension/panel.js:6-8` writes the result into `#note`, while `render` overwrites that same node every 1.5 seconds at `panel.js:47`. The clicked result therefore disappears on the next poll and is not a persistent result view. Use a separate bounded result element/state and test click, poll, and visibility retention.

- **P2 — end-to-end evidence is missing.** The new test (`src/agent-efficiency-audit.test.ts:1-9`) is pure analyzer coverage. Existing observer integration coverage is observer/sidecar-only (`src/agent-observer.integration.test.ts:20-32`); no test proves runner → SQLite → MCP audit tool → sidecar → extension worker → panel. There is also no test for the new MCP tool registration, native audit table migration, tampered JSON, CSP/MIME behavior, or the click/poll UI path.

- **P2 — browser/HTTP hardening evidence is incomplete.** The sidecar gates cross-worktree feeds behind `observeAllNativeAgents` (`src/managed-coach-sidecar.ts:144-158`) and checks loopback host/token/origin, but the extension accepts any version-1 snapshot (`coach-browser-extension/worker.js:68`) and the manifest has no explicit CSP (`coach-browser-extension/manifest.json`). Add strict snapshot schema/size validation, explicit CSP, trusted MIME enforcement, and tests for cross-worktree authorization, malformed requests, oversized responses, and origin/host confusion.

No raw prompt, thought, command, output, or tool arguments are projected by the current normalizer (`src/agent-observer.ts:10-12,20-35`); retain that property in the acceptance tests.

## Minimal acceptance gates

1. Correlation test with one native `item.id` across started/completed events proves zero false unfinished findings; interrupted item proves one finding with native ID plus observer evidence cursor.
2. Production trace test proves bounded redacted `inputHash`/mutation evidence and a real repeated-operation finding; truncation is explicitly marked incomplete.
3. SQLite migration, WAL/reopen durability, tamper/integrity, and malformed/oversized snapshot tests pass.
4. One automated runner → DB → MCP → sidecar → worker → panel test proves cross-worktree authorization and result remains visible across at least one 1.5-second poll.
5. Extension security tests prove strict schema/size, trusted JSON MIME, explicit CSP, valid host/origin/token, and absence of raw prompts/thoughts.
