# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace doctor --live
npx @waishnav/devspace doctor --public
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace config set toolMode full
```

## Core Environment Variables

| Variable                                      | Purpose                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `HOST`                                        | Local bind host. Defaults to `127.0.0.1`.                                                                  |
| `PORT`                                        | Local port. Defaults to `7676`.                                                                            |
| `DEVSPACE_ALLOWED_ROOTS`                      | Comma-separated local roots that workspaces may open.                                                      |
| `DEVSPACE_PUBLIC_BASE_URL`                    | Public origin for the MCP endpoint and built-in OAuth pages, without `/mcp`.                               |
| `DEVSPACE_ALLOWED_HOSTS`                      | Optional Host header allowlist override.                                                                   |
| `DEVSPACE_TOOL_MODE`                          | `minimal` (default) or `full`; full exposes dedicated grep, glob, and ls tools.                            |
| `DEVSPACE_TRUST_PROXY`                        | Set to `1` only when DevSpace is behind one local tunnel/reverse-proxy hop.                                |
| `DEVSPACE_OAUTH_OWNER_TOKEN`                  | Owner password for OAuth approval. Must be at least 16 characters.                                         |
| `DEVSPACE_READ_ONLY`                          | Set to `1` to expose a read-only MCP surface with no mutation, publication, Runner, or game-session tools. |
| `DEVSPACE_WORKTREE_ROOT`                      | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`.                                  |
| `DEVSPACE_STATE_DIR`                          | Directory for SQLite state. Defaults to `~/.local/share/devspace`.                                         |
| `DEVSPACE_MCP_TRANSPORT_MODE`                 | `stateless` (default) or `stateful`. Stateless avoids retaining one server per client session.             |
| `DEVSPACE_MCP_SESSION_IDLE_TTL_SECONDS`       | Stateful idle transport lifetime. Defaults to `300`; allowed range `30-3600`.                              |
| `DEVSPACE_MCP_SESSION_MAX_SESSIONS`           | Maximum retained MCP transports. Defaults to `64`; allowed range `8-1024`.                                 |
| `DEVSPACE_MCP_SESSION_SWEEP_INTERVAL_SECONDS` | Stateful idle-session sweep interval. Defaults to `30`; allowed range `5-300`.                             |

The transport mode can be persisted as `mcpTransportMode`; stateful limits are
persisted under `mcpSessions` in `~/.devspace/config.json`. Set them with:

```bash
devspace config set mcpTransportMode stateless
devspace config set mcpSessionIdleTtlSeconds 300
devspace config set mcpSessionMaxSessions 64
devspace config set mcpSessionSweepIntervalSeconds 30
```

Stateless mode creates and closes one MCP server per HTTP POST and returns 405
for GET/DELETE, matching the SDK's stateless Streamable HTTP pattern. Use
stateful mode only when a client requires server-sent event streams. In stateful
mode, the sweep interval must not exceed the idle TTL, and the capacity limit is
a hard safety boundary.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable                                   | Default                           |
| ------------------------------------------ | --------------------------------- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS`  | `3600`                            |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000`                         |
| `DEVSPACE_OAUTH_SCOPES`                    | `devspace`                        |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS`    | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

`DEVSPACE_PUBLIC_BASE_URL` becomes the OAuth issuer and base URL for DevSpace's
built-in Owner password flow. The user's browser must be able to reach that
origin during OAuth approval.

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value    | Behavior                                                       |
| -------- | -------------------------------------------------------------- |
| `short`  | Default. Uses `read`, `edit`, `bash`, and related names.       |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value     | Behavior                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal` | Default. Disables dedicated search and list tools. Clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for inspection. |
| `full`    | Enables dedicated `grep`, `glob`, and `ls` tools.                                                                                        |

The persisted equivalent is `"toolMode": "minimal"` or
`"toolMode": "full"` in `~/.devspace/config.json`. An environment variable
overrides the persisted value.

For a tunnel agent that connects to loopback, `"trustProxy": true` trusts
exactly one proxy hop so OAuth rate limiting can use the forwarded client IP.
Leave it false when clients connect directly.

`DEVSPACE_READ_ONLY=1` switches DevSpace into a read-only profile. In that
mode, DevSpace exposes diagnostics, workspace discovery/recovery,
`open_workspace`, `read`, `grep`, `glob`, `ls`, artifact inspection, and local
Git inspection, and disables file mutation,
shell, and background-job tools. Dedicated read/search tools stay enabled even
when `DEVSPACE_TOOL_MODE=minimal`, because the shell fallback is intentionally
unavailable in read-only mode.

### Safe Git remote policy

`git_fetch` and `git_merge` are registered only in full, non-read-only mode.
`git_push` is additionally registered only when `gitRemoteWrite.enabled` is
true. Configure exact repository roots, remote names, remote URLs, and
destination branches in `~/.devspace/config.json`; see
[Safe Git Integration](safe-git-integration.md).

These environment variables can override the non-secret list fields:

- `DEVSPACE_GIT_REMOTE_WRITE_ENABLED`
- `DEVSPACE_GIT_APPROVED_REMOTES`
- `DEVSPACE_GIT_APPROVED_DESTINATION_BRANCHES`
- `DEVSPACE_GIT_APPROVED_REPOSITORY_ROOTS`

Exact `approvedRemoteUrls` remain in the operator-owned config file. Enabling
remote write without URL bindings fails closed.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

Persist it with `devspace config set widgets <mode>` or override it for one
process with the environment variable.

| Value         | Behavior                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`         | Disables Workspace App metadata for every tool.                                                                                            |
| `changes`     | Enables the aggregate `show_changes` tool and attaches widget UI to workspace context, Project Memory, and `show_changes`.                 |
| `review_only` | Recommended for production. Attaches the Workspace App only to the centralized diff, artifact, media, model, and capture review allowlist. |
| `full`        | Compatibility default. Attaches the Workspace App to every tool definition that supports it.                                               |

## Skills

| Variable               | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `DEVSPACE_SKILLS`      | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR`   | Defaults to `~/.codex`.                        |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories.    |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
npx @waishnav/devspace serve
```

## Runner Registry

Background runners are code-owned policies. The private `config.json` may
enable/disable a built-in runner, select its absolute executable, or lower its
timeout and concurrency caps:

```json
{
  "runners": {
    "godot-mono": {
      "executable": "/Applications/Godot_mono.app/Contents/MacOS/Godot",
      "enabled": true,
      "maxTimeoutSeconds": 1800,
      "maxConcurrent": 1
    },
    "hython": {
      "executable": "/trusted/houdini/bin/hython",
      "enabled": true,
      "maxTimeoutSeconds": 1800,
      "maxConcurrent": 1
    },
    "hbatch": {
      "executable": "/trusted/houdini/bin/hbatch",
      "enabled": true,
      "maxTimeoutSeconds": 1800,
      "maxConcurrent": 1
    }
  }
}
```

The MCP client cannot provide executable paths. Invalid override entries are
reported by `devspace_info` without preventing the service from starting. See
[Runner Registry](runner-registry.md) and
[Houdini runners](houdini-runners.md) for the policy and containment contract.

## Workspace Python Bootstrap

Ordinary `project_task` entries with `runtime: workspace-python` require an
existing healthy `.venv` or `venv` and never fall back to an operator or system
Python. Operators may opt into the one-purpose bootstrap runtime with an exact
absolute interpreter path:

```json
{
  "taskExecution": {
    "operatorPythonExecutable": "/usr/bin/python3"
  }
}
```

`DEVSPACE_OPERATOR_PYTHON` overrides the JSON value. Repository manifests
cannot supply or parameterize that path. The only accepted bootstrap form is:

```yaml
version: 1
tasks:
  bootstrap-python:
    mode: run
    runtime: operator-python-bootstrap
    command: ["-m", "venv", ".venv"]
```

The target is fixed to workspace-relative `.venv` or `venv`. Bootstrap tasks
cannot be sessions and accept no caller parameters. DevSpace serializes creation
per workspace target, quarantines incomplete environments with a marker,
requires `pyvenv.cfg` plus a healthy interpreter whose `sys.prefix` matches the
target, and removes or leaves quarantined any failed creation.

## Project Memory SHADOW Preflight

Project Memory integration is opt-in and operator configured in
`~/.devspace/config.json`. Each repository mapping must name an exact trusted
root and the fixed Worldwright Project Memory command:

```json
{
  "allowedRoots": ["F:\\Code\\GIT\\worldwright-project-memory-m2"],
  "projectMemory": {
    "repositories": [
      {
        "root": "F:\\Code\\GIT\\worldwright-project-memory-m2",
        "command": [
          "rtk",
          "proxy",
          "py",
          "-3.11",
          "scripts/manage_project_memory.py"
        ],
        "mode": "SHADOW",
        "timeoutMs": 30000,
        "maxOutputBytes": 1048576
      }
    ]
  }
}
```

Repository-owned configuration cannot declare or replace this command. DevSpace
rejects roots outside `allowedRoots`, commands other than the fixed command,
duplicate roots, non-SHADOW modes, and limits outside the supported ranges.

Pass the current task to `open_workspace`, or call
`project_memory_preflight` when the task changes. The first response returns the
bounded bundle and a `projectMemoryReceiptId`; pass that receipt ID on later
workspace tool calls. In SHADOW, missing, stale, or would-deny receipts are
recorded but never block existing read, edit, write, or shell tools.

## Logging

| Variable                      | Default |
| ----------------------------- | ------- |
| `DEVSPACE_LOG_LEVEL`          | `info`  |
| `DEVSPACE_LOG_FORMAT`         | `json`  |
| `DEVSPACE_LOG_REQUESTS`       | `1`     |
| `DEVSPACE_LOG_ASSETS`         | `0`     |
| `DEVSPACE_LOG_TOOL_CALLS`     | `1`     |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0`     |
| `DEVSPACE_TRUST_PROXY`        | `0`     |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_READ_ONLY="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
