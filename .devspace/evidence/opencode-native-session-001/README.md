# OpenCode Native Session adapter acceptance evidence

Status: end-to-end acceptance passed on the isolated local test instance; no production service was changed.

- OpenCode: `2.2.7`, background service `http://127.0.0.1:49374` (PID `50609`).
- Authorized test directory: `/Users/liz/agy/projects/DEVSPACE-OPENCODE-NATIVE-SESSION-001`.
- Authorized Session: `ses_e3566c1f3ffeCFWoDxZB8A9EUz`.
- Current Session identity from the official API: agent `build`, provider `openai`, model `gpt-6-luna`, variant `medium`; location matches the authorized directory.
- The TUI was launched with `opencode --session ses_e3566c1f3ffeCFWoDxZB8A9EUz /Users/liz/agy/projects/DEVSPACE-OPENCODE-NATIVE-SESSION-001`; its live Terminal window title contains the Session ID. `00-session-attached-window.png` is a capture of that specific Terminal window; the screen shows the model/variant and worktree path.
- `openapi.json` is the live 2.2.7 OpenAPI document retrieved from the running service.
- The isolated DevSpace instance listened only at `http://127.0.0.1:49375`, with a unique state directory and the task worktree as its only allowed root. OAuth used dynamic registration, a PKCE authorization-code flow, Owner authorization, and an access token held only in process memory. Evidence `oauth-mcp-acceptance-redacted.json` records exact issuer/resource/redirect/scope and successful registration (201), authorize (302), token exchange (200), MCP initialize (200), tools/list (200), and test-tool registration. No password, client secret, authorization code, or token is recorded.
- `mcp-open-workspace-redacted.json` contains the read-only `open_workspace` call. `turn1-*` and `turn2-*` record the first two completed MCP turns. Because the TUI needed to be live while the visibility criterion was captured, the `live-tui-turn1-*` and `live-tui-turn2-*` pair are the acceptance pair: both were sent to the same authorized Session while its TUI was open. The first turn ran a shell command creating `live-tui-execution-proof.txt`; the second independently recalled its exact marker and path. `02-live-two-turns-tui-window.png` shows the command/result and both turns in that TUI; the adjacent terminal text is a textual capture.
- `session-messages-after-two-turns.json` is the native API message listing after the four recorded user/assistant turns (two initial test turns plus the live-TUI acceptance pair). Session and model IDs match throughout. The native TUI screenshot is the evidence for the actual shell execution; the on-disk proof file independently verifies the result.
- Negative MCP tool responses are preserved in `negative-wrong-directory-redacted.json`, `negative-wrong-session-redacted.json`, and `negative-unapproved-session-redacted.json`. Each was rejected before any OpenCode prompt POST. The wrong-location Session fixture remains untouched.
- OAuth/MCP evidence and MCP tool definitions are redacted/sanitized; the bearer token, Owner password, client secret, and authorization code were never written to evidence or logs.
- One setup mistake is intentionally retained as a negative isolation fixture: an initial `POST /api/session` omitted the body `location` and created `ses_e3566fc25ffesLKNtg891uDT54` in `/Users/liz`. It has never received a prompt and is not authorized. The corrected request specified both the directory header and body `location`; it created the authorized Session above.

The isolated instance was stopped after capture. Evidence does not imply production deployment or a merge. Local code changes remain on the dedicated feature branch pending review.
