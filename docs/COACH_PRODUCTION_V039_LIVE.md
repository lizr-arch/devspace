# COACH-PRODUCTION-MULTICHAT-001 · Production rollout (2026-10-20)

## Deployment state

- User explicitly authorized service and browser upgrade, accepting possible interruption of concurrent Codex operations.
- Release source: managed clean worktree `/Users/liz/.devspace/worktrees/devspace-95b138a0`, commit `d87890889434280f75144f84595d9610399d83b3`.
- Original production main HEAD: `34c1dda0fc1308f23c689203179597b407c8452e`; 3 unrelated user-modified tracked files (`AGENTS.md`, `package.json`, `src/server/express-routes.ts`) and hundreds of existing untracked files were **preserved**. Only scoped release paths were copied. No reset or cleaning.
- Production checkout `npm run typecheck`: PASS, exit 0. `npm run test:coach:mac`: PASS, exit 0 (64 browser tests). `npm run build`: PASS, exit 0.
- `launchctl` verified label `com.liz.devspace` and working root `/Users/liz/agy/devspace`. Service restart was requested via validated launchd command; new DevSpace boot ID is `aefbf602-9057-4c09-9c50-885851b5af70` and observed new schema suffix `+coach-sidecar-scope-v1`. This verifies **new code is running**, not merely copied.
- Sidecar restarted on `127.0.0.1:8765` with *exactly three* explicit authorized workspaces: DevSpace main `ws_9adc027a-b6e2-4003-8e5c-31c1e8840ed4`, TriaRegna battle `ws_329c9705-0da2-457d-80a4-77f563c47184`, TriaRegna AI training `ws_662d43ae-a193-4c67-8d83-10548753a8f6`. Authenticated real HTTP `/events`: 200, 26 historic pending events, all workspace IDs inside that consent set. The old event #142 already has `REVIEW_BLOCKED` and must not be blindly re-sent.
- State directory permissions: 0700; current token handoff file: 0600. Stable macOS Chrome Native Messaging host installed with exact extension allowlist `bapcebjlgncogfpgbhllioaichcldkbl`. An actual length-framed native-host protocol call returned a valid 8765 pairing for this ID, rejected a forged extension ID and **never logged bearer bytes**.
- The existing Chrome extension's Secure Preferences entry points to `/Users/liz/agy/devspace/coach-browser-extension`. Manifest at that exact path is now **v0.3.9**. Chrome `chrome://restart` request was accepted by macOS `open -a`, but ChatGPT Browser connector is unavailable, so active popup/runtime version and real DOM receipts **could not be read independently**. Do not claim live ChatGPT automatic delivery is already verified.
- Scoped Chrome uncertainty isolation was validated in the release worktree: `npm run test:coach:observer` 66/66 PASS.

## Outstanding user-controlled browser step

After Chrome reload, inspect the existing extension (do not install a second copy or change its ID). In its popup confirm version 0.3.9, select **From this device** once if Native Messaging consent is not yet recorded, and for each intended Web GPT conversation explicitly bind the correct DevSpace workspace ID and enable automatic send once. No pairing secret should be copied manually. A route must not be inferred from the current/most-recent tab.

Then run a fresh controlled two-conversation Codex smoke, check real `dom_submitted` receipts per workspace, inspect the correct Web GPT review writeback and next stage. Browser closed/login expired is not supported.

## Recoverability and limits

- On daemon restart, existing explicit Sidecar feed consent is persisted and revalidated; manual stop revokes auto-recovery.
- Auto routing refuses duplicate canonical chat URLs, unknown workspaces, uncertain duplicate sends and mismatched identities. More than 50 pending events fail closed; per-Sidecar scope is limited to 8 explicitly approved workspaces, and adding a future worktree requires explicit scope reconfiguration.
- Restart did interrupt TriaRegna AI training plan `tria-ai-r9-10k-autocontinue-v7`, now `BLOCKED / agent_INTERRUPTED_requires_review`. This needs its own normal recovery/review, never silent automatic approval.
- Controlled rollback: restore prior source from Git base `34c1dda0fc1308f23c689203179597b407c8452e` without overwriting unrelated in-flight modifications, rebuild, restart the validated launchd service, and restore previous Chrome extension source only after confirming installed path/ID.

Release judgement: `SERVER_PRODUCTION_RUNNING=PASS`, `SIDECAR_MULTI_WORKSPACE=PASS`, `NATIVE_HOST_REAL_PROTOCOL=PASS`, `CHROME_V039_FILES_AND_RESTART_REQUEST=PASS`, `CHROME_ACTIVE_RUNTIME_AND_DOM_DELIVERY=NOT_VERIFIED`, `UNATTENDED_MULTI_WEBGPT_E2E=NOT_VERIFIED`.
