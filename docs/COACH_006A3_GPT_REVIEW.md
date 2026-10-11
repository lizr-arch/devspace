# COACH-006-A.3 — Security / Native Events / Browser Pairing Closure

Date: 2026-10-11
Reviewed by: Web GPT via authenticated DevSpaceMac MCP against actual source and tests
Result: **A3_CODE_AND_TARGETED_GATES_PASS**
Production state: **NOT DEPLOYED; no main merge/push/restart**

## Repo and isolation

- Canonical repo: /Users/liz/agy/devspace; main HEAD c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1, clean.
- Isolated worktree: /Users/liz/.devspace/worktrees/devspace-f50dc711.
- Branch: devspace/integration/devspace-devspace-f50dc711. No staging, commits, push, merge, or service restarts.
- Existing Chrome extension under older scratch project was NOT overwritten, reloaded, or accessed in the signed-in Chrome profile.

## Implemented

### 1. TaskRunner secret stdout/stderr hardening

- File: src/task-runner.ts.
- Detached session close handler now fires after stdout/stderr drains; it permanently scrubs session.stdout and session.stderr using session-scoped secret values BEFORE deleting those values.
- stopSession no longer deletes secret material prematurely; data arriving after stop remains protected until close.
- src/coach-a3-secret-session.test.ts covers a real spawned process, normal exit, stop, getSession(), and listSessions() after completion.
- src/security-attack.test.ts ATK-13 converted from a warning into active assertions for post-exit stdout/stderr and session listing. Previously printed warning has vanished; suite 49/49 PASS.

### 2. DevSpace-native persisted coach event store

- New src/coach-review-events.ts, stateDir/coach-review-events.sqlite, separate schema version 1; directory/file permissions 0700/0600 on non-Windows.
- Event store provides recordCompleted (workspace+operation idempotent), submitReview (workspace-scoped, hash-bound, immutable decision), listPending and close.
- Duplicate completion with mismatched fingerprint conflicts; different workspaces with same operation ID are isolated. Old unauthorized workspace ID cannot approve another's event.
- Server createServer() constructs native store from config.stateDir and supplies its approved, canonical path to ManagedCoachSidecar. The production service reads native coach_review_events/coach_review_decisions, filtering by current workspaceId.
- Legacy COACH005 project-local experimental sqlite remains supported by the manager constructor only for existing isolated compatibility tests; createServer NEVER configures that legacy source.
- Native database is write-enabled only within trusted backend store methods. Sidecar uses an independent readonly:true connection with metadata-only HTTP endpoints; no arbitrary event-injection MCP tool was introduced.
- The native **event producer from future Agent Runner has not yet been connected**. A3 proves persistent write/review/read contracts but does not auto-generate events from real Codex jobs. That is COACH006-B.

### 3. Token-paired Chrome MV3 extension v0.2

- Folder: coach-browser-extension/ (new independent unpacked extension; old installed extension untouched).
- Explicit user gesture pairs local port and one-time bearer value; /health token check before storing. Bearer is kept in chrome.storage.session ONLY, not persisted to local storage.
- Background polls /events with Authorization, maintains event count and copy-to-GPT user action; no content script, ChatGPT permission, auto-send, or output scraping.
- User-facing extension ID allows the authorized MCP start tool to fix pairedExtensionId. Popup status and copy prompt never expose token. Browser restart requires re-pairing.
- Real isolated Chromium with temporary profile loaded v0.2, called real extension pairNow, accessed /health and /events with token, persisted session pair/status and showed badge 1. No ChatGPT contact.

## Executed independent gates

| Gate | Result |
|---|---|
| A3 native event store, persist/reopen, duplicate/evidence mismatch/cross-workspace and readonly SQLite | PASS |
| A3 real process normal exit/stop secret redaction | PASS |
| Security attack suite with enforced ATK-13 | 49/49 PASS; no stale leak warning |
| New paired extension Node tests | 5/5 PASS |
| Actual isolated Chromium worker/token pair/fetch/session/badge | PASS |
| A3 actual createServer() native-store wiring | PASS |
| Native sidecar event read and workspace filtering after review | PASS |
| A2 MCP start/status/stop and actual same-workspace TaskRunner coexistence | PASS |
| TypeScript tsc --noEmit | PASS |
| Existing workspace lifecycle with full /usr/sbin PATH | 50/50 PASS |
| Resource lock sidecar unit | PASS |

All targeted checks above returned exit=0 in approved DevSpace project tasks. No release build or global unit test suite was claimed.

## Git evidence and excluded files

- Tracked source diff SHA-256 at audit: 3b9d4743cfc39bc5b2d93b51013e016fb516e23f9098ec8ce8b68092cde524f3 (tracked diff only; excludes untracked new files).
- True deliverables: src/task-runner.ts; src/security-attack.test.ts; src/coach-review-events.ts; src/coach-review-events.test.ts; src/coach-a3-secret-session.test.ts; src/coach-a3-server-smoke.test.ts; coach-browser-extension/{manifest.json,worker.js,popup.js,popup.html}; plus previously approved A1/A2 resource lock/Sidecar changes and tests.
- Development/test-only: .devspace/tasks.yaml, COACH_006A*_SPEC.md, node_modules symlink, src/coach-browser-real-chromium.py, src/coach-browser-extension.test.cjs. Stage explicitly, do not bulk git add -A.

## Hard release boundaries / next stage

1. COACH006-B trusted Agent Runner must connect real Codex/OpenCode completion callbacks to native recordCompleted using real immutable source/test evidence. No arbitrary caller or extension may fabricate a completion.
2. COACH006-B review RPC must verify workspace authorization, event SHA and evidence snapshot before calling submitReview. It must be idempotent and must not silently approve generated items.
3. Chrome user has not installed or paired extension v0.2. Current v0.1 browser extension uses unauthenticated legacy bridge. Pairing requires deliberate user action after an approved production service start and is not automatic.
4. No legacy event migration or live demo DB import: safe cutover must define exactly which old pending events, if any, are migrated; do not silently copy payload data.
5. The web GPT ordinary chat still cannot automatically awaken after a prior reply finishes. v0.2 only supports human-triggered copy/send.
6. Production main remains clean/unchanged and currently running daemon is NOT restarted. Separate controlled merge/build, MCP schema refresh, real signed-in Chrome pairing test and rollback needed.
7. No 24-hour soak test, browser OS restart persistence test, full unit suite or production deployment acceptance is claimed.

## Conclusion

`COACH006A3_CODE_AND_TARGETED_GATES_PASS` — security and native feed/pairing foundations independently tested.
`PRODUCTION_AUTONOMOUS_COACHING_NOT_READY` — Agent Runner event producer, review RPC, live Chrome pairing and ordinary Web GPT wake-up remain separate gates.
