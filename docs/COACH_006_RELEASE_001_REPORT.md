# COACH-006-RELEASE-001 — Integration and Safety Gates

Date: 2026-10-11
Source: isolated managed worktree `/Users/liz/.devspace/worktrees/devspace-f50dc711`
Before merge: `main` / `origin/main` baseline locally at `c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1`.

## Code verdict
**RELEASE_CODE_AND_INTEGRATION_GATES_PASS. LIVE SERVICE CUTOVER NOT YET AUTHORIZED AS PASS.**

### Exclusive DevSpace state ownership
- New `src/devspace-instance-lock.ts` uses a separate SQLite database with a long-lived `BEGIN EXCLUSIVE` OS-managed lock. A second independent process, even with the same Unix account, receives `DEVSPACE_INSTANCE_ALREADY_RUNNING`.
- `createServer()` acquires before any stateful service constructor, notably BEFORE `coachReviewEvents.reconcileInterruptedRuns()`. Constructor errors release the lock.
- Graceful shutdown drains native Codex runner and coach sidecar, closes native event storage, then releases the instance lock. CLI SIGINT/SIGTERM awaits this shutdown instead of exiting prematurely.
- No PID-file deletion, arbitrary lock-file unlink, or kill of other processes.
- A real OS test confirms concurrent second lock refusal, separate Node lock-owner `SIGKILL` auto-unlock, actual duplicate `createServer()` rejection without corrupting RUNNING job, and safe restarted interrupted reconciliation.

### Repeatable gates
- `npm run build`: PASS, exit 0 (Vite app assets, Web GPT test host, production TypeScript), minor existing large-chunk optimization warning only.
- `npm run test:unit`: PASS, exit 0. Reviewed and corrected explicit `doctor.test.ts` Schema pin and 75-tool count/readonly allowlist assertions; failures were not suppressed.
- `npm run test:mcp`: PASS, exit 0, including gated-loop 16/16, Web GPT full-loop 30/30 and mock real-provider 20/20.
- `npm run test:coach:mac`: PASS, exit 0, native instance lock, trusted events, session secret redaction, actual createServer, resource mutex, Sidecar, Codex Runner, actual MCP calls, review verification, 5-cycle loop and Chrome extension tests.
- `npm run test:coach:mac:os`: PASS, exit 0, guardian normal exit, actual isolated owner `SIGKILL`, no surviving descendant, guardian identity/birth checks, old SQLite v3→v4 safe migration.
- Prior real Codex CLI `exec` and `exec resume` on same UUIDv7 thread via the guardian: PASS, as recorded in `docs/COACH_006B3_OS_GPT_REVIEW.md`.

### Explicit staged-file policy
Only `src/` production code and scoped test files, production `coach-browser-extension` v0.2 assets, `package.json` integration scripts and key review/release documents belong in the release commit.

Always EXCLUDE `.devspace/tasks.yaml`, development `COACH_*_SPEC.md`, `node_modules` symlink, Chromium scratch automation `src/coach-browser-real-chromium.py`, unreviewed generated captures and intermediate development logs.

### Release boundaries / rollback
- Merge requires the checked clean main HEAD and source commit SHA (fast-forward only), and retain old main SHA for rollback reference.
- This code is not automatically loaded into the already-running older DevSpace process. Real live switch requires knowledge of the actual managed service process owner/service launch mechanism, validation of a clean stop, `npm run build` in the canonical main checkout, then startup and authenticated `devspace_info`/MCP health verification, followed by Chrome v0.2 pairing.
- Do not start two services on port 7676 or attempt to use the production OAuth tokens in scratch fixtures. The currently active old version does NOT implement the new instance lock, so code-level exclusivity alone does not authorize simultaneous running during cutover.
- Chrome extension never sends messages into ordinary ChatGPT chats automatically. The human copy-and-send workflow remains the proven review trigger.
- No claim of 24-hour soak, host power-failure test, signed-in Chrome pairing, live MCP schema re-sync, public tunnel changeover, remote push or successful production cutover.
- Rollback must be made using the retained pre-release SHA and the known service manager; never reset blindly over concurrent work.

**Decision:** Local source integration is ready after all gates. Live rollout is a distinct handover/verification gate.
