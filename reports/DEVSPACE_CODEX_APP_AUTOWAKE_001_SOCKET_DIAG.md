# DEVSPACE-CODEX-APP-AUTOWAKE-001 — Native Codex App control-path diagnostic

Date: 2026-10-24
Status: READY_TO_DISPATCH_BLOCKED_APP

## User confirmation
The user confirmed that the macOS ChatGPT desktop App is open to a real Codex development conversation. Do not ask again whether this is a normal ChatGPT chat.

## Read-only evidence
- DevSpaceMac 1.1.0 MCP responding; production Coach Sidecar `ws_9adc027a-b6e2-4003-8e5c-31c1e8840ed4` running on 127.0.0.1:8765.
- `codex_app_shared_status`: `connected=false, error=CODEX_APP_SHARED_SOCKET_UNAVAILABLE`.
- Expected alias `~/.codex/app-server-control/app-server-control.sock`: lstat ENOENT.
- Parent `~/.codex/app-server-control/` exists, user-owned and privately permissioned, contains one regular file, no socket alias.
- Private daemon directory `/private/tmp/codex-daemon-<current uid>/` exists, user-owned and privately permissioned. Exactly one entry with a 64-hex name is a user-owned, owner-private Unix Socket; another entry is a regular file. No filenames, token or contents printed.
- A read-only WebSocket upgrade probe against that single private socket failed `CLOSED_BEFORE_HANDSHAKE`. The actual `sharedAppStatus(socketPath)` from the project code was cross-checked and failed `CODEX_APP_SOCKET_CLOSED`. Thus a blind alias reconstruction/fallback is NOT safe or sufficient until a compatible live control endpoint is confirmed.
- Tests were run only by `npm run diagnose:codex-app-socket` in isolated worktree via DevSpace start_job/wait_job; no App restart, socket mutation, ~/.codex edit, takeover or new local Codex CLI.
- Isolated diagnostic files: `scripts/diagnose-native-codex-socket.mjs` and one package.json script. This diagnostic is deliberately read-only and should NOT be treated as a production fix.

## Follow-up after user restarted ChatGPT App

- User explicitly confirmed quitting and reopening the macOS ChatGPT App into the native Codex development view.
- Recheck showed identical state: expected alias ENOENT, one private user-owned opaque Unix socket, `sharedAppStatus(opaqueSocket)` => CODEX_APP_SOCKET_CLOSED, WebSocket upgrade => CLOSED_BEFORE_HANDSHAKE.
- Independent repository document `docs/COACH_CODEX_APP_SHARED_BRIDGE_001.md` identifies the previously successful bridge as an **experimental, opt-in launch** using `CODEX_APP_SERVER_WS_URL=ws+unix://localhost<shared-socket>:/rpc`. The companion script `scripts/launch-chatgpt-shared-codex.mjs` only launches when App is not running AND a valid, pre-existing alias is already available. Therefore a normal App restart does not reenable this bridge, and the script is currently blocked by its own socket prerequisite. Neither recreating the alias blindly nor invoking the launch script in the live App's state is safe.
- Do not tell user to repeat an ordinary restart as the fix. First restore a protocol-compatible, authorized App shared control endpoint by a reviewed path; treat it as a separate connection bootstrap task.

## Conclusion and continuation
Desktop App UI visibility does not imply its shared control socket is available. At time of inspection, there is no live, protocol-compatible App control endpoint available through DevSpace. The AUTOWAKE v1 frozen TASK is present at `.devspace/coach/tasks/DEVSPACE-CODEX-APP-AUTOWAKE-001/TASK.md`, SHA-256 `f0a781d00f87137d4e06c8a6885da606d8ebc044b1ff328140e1a2f86bf9f7c0`, worktree `/Users/liz/.devspace/worktrees/devspace-8c228250`, workspace `ws_93dcc2dc-a050-4bb0-801f-dd978d5ce41b`. It has not been sent to Codex. Do not substitute Codex CLI.
After App control service becomes available, dispatch to new native App thread in that exact worktree with the frozen TASK reference; do not replay old R1/R2 turns or change production main. Validate App↔Coach automatic delivery separately after implementation.
