# COACH-UNATTENDED-RELEASE-001 — Independent release gate

Date: 2026-10-20. Candidate: Chrome v0.3.8 + DevSpace Sidecar authorized multi-worktree scope, based on `4c56e8590f168ea0340bd3c636073fb746dae9cd` in managed worktree `/Users/liz/.devspace/worktrees/devspace-226ba59a`.

## Verified in this turn

1. Mac DevSpace production control plane is still running the previous stable build: boot `68acaa28-074e-4c8e-b388-70fa6f3c8e94`, 86 MCP tools, current live Sidecar on 127.0.0.1:8765, extension ID `bapcebjlgncogfpgbhllioaichcldkbl`. No production deploy or service restart occurred.
2. Git `main` at `34c1dda0fc1308f23c689203179597b407c8452e` contains unrelated existing edits to `AGENTS.md`, `package.json`, and `src/server/express-routes.ts`, plus other untracked files. None was modified.
3. Security review identified a release-blocking native host installer issue: pointing Chrome at the mutable managed worktree's source, which would break after cleanup. Changed to copy `src/coach-native-pairing-host.mjs` into an owner-only, stable `~/Library/Application Support/DevSpace/CoachNativeHost/host.mjs`; the launcher references this stable copy. The installer refuses a symlinked/foreign-owned file or unsafe directory and atomically replaces owned regular files. It exposes no token in stdout or a web endpoint.
4. Real Mac test `npm run test:coach:observer` **PASS: 65/65** (including native host executable protocol, fixed extension-ID allowlist, owner-only stable-path installation, and preexisting symlink rejection). First attempt's symlinked macOS `/var` fixture was corrected to canonical `/private/var` with no relaxation of installer safety.
5. Official isolated production `npm run build` **PASS: exit 0** (Vite app, Vite WebGPT local test host, TypeScript production emit), with only Vite size warnings.
6. Previously on the same candidate: `npm run typecheck` PASS, real native SQLite Sidecar MCP tests PASS, Worker lifecycle/restart/port collision tests PASS, non-Worker API create/close/create restart and explicit stop test PASS, `test:coach:mac` PASS, browser tests 64/64 PASS. Candidate's bounded explicitly authorized multi-worktree feed is tested, not yet running in production.
7. The connected Browser tab interface returned `NOT_FOUND: Unable to invoke the connected browser`. No supported control is available in this ChatGPT conversation to load the Chrome extension, approve Native Messaging, or restart the macOS launchd daemon safely.

## Release decisions

- `CODE_AND_ISOLATED_BUILD = PASS`
- `RELEASE_HARDENING = PASS_FOR_SCOPED_LOCAL_TESTS`
- `NATIVE_HOST_MAC_FILESYSTEM_INSTALL = NOT_RUN`
- `CHROME_V038_REAL_EXTENSION_ID = NOT_VERIFIED`
- `NATIVE_PAIRING_REAL_BROWSER = NOT_VERIFIED`
- `BROWSER_RESTART_CROSS_PROJECT_ROUTING = NOT_VERIFIED`
- `PRODUCTION_DEPLOY = BLOCKED_PENDING_REAL_CHROME_AND_SAFE_MAIN_INTEGRATION`
- `UNATTENDED_FULL_PASS = NOT_VERIFIED`

## Controlled next steps

1. Integrate the candidate into the currently installed **same extension directory** after other owners have cleared the dirty `main` worktree. Loading unpacked v0.3.8 from a different directory may alter its Chrome extension ID; if it does, stop rather than assume pairing to the existing fixed ID.
2. Register the stable Native Messaging host with `node scripts/install-coach-native-host.mjs` once from the approved and integrated code base, and explicitly approve the browser extension permission. Do not expose the bearer in chat.
3. Restart/reload the exact installed extension and conduct a real Chrome probe: current loopback health, binding two **different** workspaces to two **different** ChatGPT conversation URLs, a controlled Codex review event per workspace, browser `dom_submitted` receipts and corresponding approved DevSpace decisions.
4. Check service/browser restart, token rotation, duplicate tabs, missing tabs, explicit revoke and crash/uncertain sends. Fail closed for every ambiguity; browser closed/expired login is not expected to work autonomously.
5. After a live, explicit permission grant and validated deployment, run a 3-stage autonomous real Codex plan with at least one REWORK, two independent Web GPT chat routes, and event-level evidence. Only then set `UNATTENDED_FULL_PASS`.

No unattended background job, automatic installation, or unseen Chrome operation is claimed.
