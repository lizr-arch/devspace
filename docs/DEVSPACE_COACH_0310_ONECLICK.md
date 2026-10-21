# DEVSPACE-COACH-0310 — One-click and three-chat background delivery

Date: 2026-10-21. Source branch: `devspace/integration/devspace-devspace-3e4b5172`.
Production main and the installed Chrome extension have NOT been modified by this isolated development.

## User-facing contract

- A user opens a concrete `chatgpt.com/c/<id>` tab and clicks **一键启用当前 Web GPT Coach** once.
- The extension performs authenticated local Native Messaging pairing when necessary, generates a 128-bit random one-time challenge and sends a binding request into **that exact tab**.
- Web GPT independently resolves the DevSpace workspace it actually controls; it calls `coach_webgpt_claim_browser_route` with exact `workspaceId`, `nonce`, and `url`. No nearest-tab/last-workspace guess is permitted.
- The managed Sidecar verifies the exact expiring browser challenge, its browser origin/bearer on creation, bounded workspace authorization and uniqueness. The original tab URL is checked again when enabling.
- Three independent ChatGPT tabs can click once each while other first-bind requests are still pending. Background polling finishes independent claims. Existing audit messages continue to use V5, and the binding prompt uses an isolated V1 content-script listener.
- The original tab ID is preferred even when duplicates open; when the original is gone and two or more exact tabs remain, fail closed.
- Each workspace can be paused or unbound individually. Unpairing revokes browser routes and pending challenges. Cancel removes only the current chat's pending browser challenge.
- Chrome never reads conversation history. It checks only the composer to avoid overwriting a draft. `dom_submitted` is **not** a Web GPT verdict; review writeback remains separate.

## Scope and security

- A browser request alone never chooses or authorizes a workspace.
- The MCP claim tool is omitted in read-only mode. It validates the caller's exact workspace registration via `workspaces.getWorkspace`.
- Sidecar grants a newly claimed workspace only through the one-time Web GPT MCP claim and a persistScope callback which durably records the expanded explicit allowlist *before* enabling it in memory. At most 8 workspaces per Sidecar.
- Challenges are memory-only, 10-minute TTL, 16 outstanding per Sidecar, nonce- and canonical-URL-bound. Browser has at most 8 outstanding first-bind requests in session storage. Bearer stays in Chrome session storage; never goes to ChatGPT prompts, storage.local or logs.
- Invalid origin, Host, bearer, URL, challenge, scope, duplication, read-only MCP or lost original tab fail closed. No automatic retry of a potentially submitted binding prompt.
- Browser/background send remains sequential on a ~30-second alarm, NOT simultaneous wall-clock submission. Tabs must remain open, logged-in, not discarded, and ChatGPT's composer must be available.
- Known limit retained from v0.3.9: Sidecar union event feed caps at 50 pending items; a larger backlog needs pagination or explicit review cleanup before claiming full unattended reliability.

## Relevant code

- `coach-browser-extension/{auto-worker.js,chatgpt-binding.js,autosend-popup.js,popup.html,worker.js,manifest.json}`
- `src/managed-coach-sidecar.ts`: `/bind/start`, `/bind/status`, `claimBrowserRoute`
- `src/server/tools-sidecar.ts`: `coach_webgpt_claim_browser_route`
- `src/{coach-auto-delivery.test.cjs,managed-coach-sidecar.test.ts}`

## Isolation, verification, and rollout gate

- Isolated worktree base: `f1334e8455033d64af79423d6d68c265fdb0cb7f`.
- Node dependencies were installed only in this isolated worktree using a bounded, approved local task; `.devspace/tasks.yaml` is a test-only untracked file and must **not** enter the commit.
- Gates: `npm run typecheck`, `npm run build`, `npm run test:coach:0310`, `npm run test:coach:0310:sidecar`, `npm run test:coach:observer`.
- Real Chrome one-click, two/three distinct Web GPT acceptance/writeback, and post-restart rehydration are **not verified** by these tests.
- **Do not deploy/restart now without new preflight**: inspect in-flight Codex agents, Coach plans and jobs; preserve unrelated dirty main files; deploy the server and exact installed extension path as a coordinated reviewed release, preserving extension ID `bapcebjlgncogfpgbhllioaichcldkbl`. After the server/tool schema upgrade the client may require connector refresh, and the installed unpacked extension needs one Chrome reload. Never install a second unpacked copy.
- Production rollout is complete only when a real Chrome tab one-clicks, Web GPT claims the exact chat/workspace via MCP, the browser delivers an event to the correct background tab, the reviewer persists a signed verdict, and the expected next stage is dispatched. Three-tab acceptance needs three distinct conversations and workspaces.
