# DevSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,  
or another MCP-capable host can operate directly on this machine's approved  
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host  
should call tools that read files, edit files, search code, and run shell  
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding  
primitives such as read, edit, write, grep, find, ls, and bash. DevSpace wraps  
those primitives behind a remote Streamable HTTP MCP interface, suitable for use  
through a Cloudflare Tunnel.

The model-facing workflow is workspace based. MCP clients should call  
`open_workspace` once per local project directory or worktree, then reuse the  
returned `workspaceId` for subsequent tool calls in that same folder. Do not  
call `open_workspace` again for the same folder unless the `workspaceId` is  
rejected as unknown, the client switches folders/worktrees or checkout/worktree  
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned  
automatically by `open_workspace` and by later tool calls when the requested path  
enters a directory with instructions that have not been loaded for that  
workspace.

Reliability and Idempotency Guidelines:

- **Idempotent Mutations**: Pass `operationId` on mutating tool calls (`write_file`,  
  `edit_file`, `project_task`). If a network interruption occurs, replaying the  
  request with the same `operationId` safely returns the cached result without  
  side-effects.
- **Network Recovery**: If an operation status is uncertain after a timeout or  
  transport reset, call `query_operation` with the `operationId` before retrying.
- **Actionable Self-Healing**: When a tool call returns an error, follow the  
  provided `recoveryHint` and `nextRecommendedTools` instead of blindly retrying  
  the identical payload.

Core constraints:

- Treat this as remote access to the local machine; security is part of the  
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP  
  clients before adding UI or workflow features.
