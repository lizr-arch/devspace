# DEVSPACE-COACH-CONTRACT-001 — Production Release Gate

Status: **CANDIDATE READY, PRODUCTION NOT DEPLOYED**. This file is an operational preflight, not proof of completion.

## Immutable inputs and owners

- Clean integration candidate: `devspace/integration/devspace-devspace-cbf837ee` @ `85901a2c4adfb3233f1b534f44fe4322ba064798` (based on production main `f1334e8455033d64af79423d6d68c265fdb0cb7f`).
- TASK source implementation `6ec4ed3d74c084131d567a3e58120c29e23d54d1`; bounded R1 repair `ce9ff80c21a272ea03942ed7a31fbafb79399446`.
- Production `/Users/liz/agy/devspace` main has **12 uncommitted tracked files**, including one-click pairing and separate Gemini tool compatibility changes, plus hundreds of untracked files. Do not reset, stash, overwrite, merge into dirty checkout, or commit those files as if owned by this project.
- User's existing Sidecar port 8765 and extension pairing must be preserved. No service changes until current task owners reconcile those modifications.

## Evidence already observed

- Original R1 isolated worktree: independent `npm run test:coach:contract` exit 0, `npm run typecheck` exit 0. R1 native operation `devspace-coach-contract-001-r1-targeted-20261021` verified at immutable evidence event 236 with SHA `93736f52774ecad4e83c58e0270a39465560f6bec8d857732ebaa81528de2d97`.
- Original R1 tests covered parser gate, changed task/security evidence, 28 native-proof scenarios, status routing, 72 Chrome tests.
- New isolated clean merge candidate is conflict-free but **does not have installed node_modules**; its direct `npm run test:coach:contract` currently exits 1 because package `tsx` is missing. Do not call this a source regression. The current validated R1 branch is not proof that clean merge has deployed.
- Isolated Sidecar socket test encountered `listen EPERM 127.0.0.1` in sandbox. It must be run in a host environment that permits loopback before declaring a live-network PASS.

## Required release steps

1. **Ownership preflight:** record Git status, live Codex/Coach jobs, dirty-file ownership, source SHA and current boot/schema. Have the existing one-click/Gemini task owner commit or safely reconcile their own main changes; never assume these 12 files are disposable. Re-check main because it may change while release is prepared.
2. **Refresh integration candidate:** derive an isolated integration branch from the clean newest main. Merge contract source with pinned expected SHAs. Use normal merge/conflict resolution to preserve both the one-click authentication feature and independent Gemini changes; review all overlaps (managed-coach-sidecar, sidecar tools, Chrome workers, package.json).
3. **Dependency bootstrap in isolation:** install exact package-lock versions through a security-approved package installation path (do not bypass DevSpace's controlled runner restrictions). Verify package integrity and correct native better-sqlite3 binary compatibility.
4. **Targeted tests:** run `npm run typecheck`, `npm run build`, `npm run test:coach:contract`, and one-click specific controlled tests. Check nonzero exits without weakening the gate. On a permitted loopback host run genuine Sidecar socket test and verify no secret disclosure.
5. **Deployment safety:** verify no active job or pending native task can be interrupted, backup service/extension config and existing pairing state; record rollback commit. Only then build and activate the verified version, preserving owner-only secrets; do not rotate pair token unexpectedly.
6. **Live post-deploy smoke:** `devspace_info` should expose `codex_task_freeze` and `coach_webgpt_claim_browser_route`; refresh/reconnect ChatGPT plugin schema if stale. Have the user click one-click binding again (old nonce challenges expire on restart). Use exact authorized workspaceId, URL and new nonce; accept only `claimed=true`.
7. **Document-driven E2E:** Web GPT writes a small complete nine-section TASK, freezes through server-computed SHA, verifies no-doc negative, launches inexpensive controlled Codex task, gets genuine valid RESULT, checks continuing vs review feed, and submits signed review. No cross-tab leakage or fabricated evidence.

## Release verdict

- **READY_FOR_DEPLOYMENT** only after main owner reconciliation + latest clean integration build/tests and live Sidecar network positive.
- **APPROVED** only after post-deploy tool catalog, fresh one-click claim and genuine document-driven Web GPT ↔ Codex ↔ Web GPT flow.
- **BLOCKED / DO_NOT_DEPLOY** while dirty main is owner-unreconciled, service upgrade path unsafe, tool remains unavailable, or real E2E has not run.

This document is a release checklist. Keep production running unchanged until all preconditions are satisfied.

## 2026-10-21 consolidated integration update

- An **exact preservation checkpoint** of the production working tree's 12 tracked modifications plus 4 relevant new source/doc files is committed only on isolated `devspace/integration/devspace-devspace-8022c89e` @ `5d5b8506608b0bcfd31ba8e15ec2b2b652382af9`. Both working trees' tracked diff SHA-256 matched: `57736ceffe2f9da2c3a80bc4bfdf8dd09679adb6122bf77da3fdec9395115f13`. This is a preservation checkpoint, **not owner approval** or a passing product release.
- The snapshot was merged into this integration branch conflict-free at `94be121a73ecf6163a367d3cf4a7d1ccd1fdb60f`. The current production main checkout has **not** been committed or altered.
- Isolated `npm ci` with pinned lockfile (via explicitly approved DevSpace task) exited 0, installed 370 packages. The temporary task manifest must not be committed.
- Combined **`npm run typecheck` 0; `npm run build` 0; `npm run test:coach:contract` 0; `npm run test:coach:0310` 0 (59/59); `npm run test:coach:0310:sidecar` 0 (real localhost listener)**.
- An actual Gemini integration regression was caught: the old test expected full Gemini catalog and shared bearer tokens could incorrectly classify ChatGPT stateful sessions. The fix prioritizes explicit session identity over stateless token fingerprint. The updated integration test using the **same bearer token** now confirms Gemini bounded catalog **39 tools**, regular ChatGPT **84 tools**. `npm run test:gemini-tools` exited 0. Stateless clients sharing the same bearer still require distinct credentials to avoid ambiguity.
- Build and all targeted tests passing in this isolated candidate do **not** mean the production server has been upgraded. Verify dirty main owner reconciliation, session/plan quiescence, service reload/rollback and live one-click claim before marking APPROVED.

