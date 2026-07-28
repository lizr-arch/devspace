# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

When a tunnel or reverse proxy runs locally and forwards to the loopback-bound
server, enable `trustProxy`. DevSpace then trusts exactly one proxy hop. Do not
enable it when the server is directly reachable from untrusted networks.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

The DevSpaceMac Cloudflare surface does not restore shell access for remote Git
integration. Its safe Git tools accept no command, URL, caller refspec, force,
delete, tag, mirror, or arbitrary argument fields. Remote operations require
exact operator repository, remote, URL, and branch bindings. See
[Safe Git Integration](safe-git-integration.md).

## Background Validation Jobs

Background jobs do not accept a shell command string. They select a code-owned
runner policy, validate its action and path-like arguments, resolve only a
locally configured or fixed executable, spawn without a shell, and cap
concurrency, runtime, and captured output. Job state and logs are stored under
the private DevSpace state directory.

Repository-owned build or test scripts can still execute code as the local
user. Only run jobs in trusted approved repositories, and use `cancel_job` when
a process behaves unexpectedly.

Blender, Houdini, Godot, package, compiler, and test runners are classified
`trusted_local`, not `strict`: workspace/argument checks do not prevent trusted
project code from using the local user's filesystem or network authority.
`devspace_info` reports this containment level and runner availability
explicitly.

`houdini_info` uses a fixed bounded probe and returns only safe product/license
classification, executable availability, version/architecture evidence, and a
sanitized diagnostic. It does not call license administration, log in, accept
an EULA, activate a product, read license files, or return raw license output.

When a job declares narrow `artifactRoots`, DevSpace snapshots and scans those
workspace-relative directories, rejects symbolic-link escape, validates
supported file signatures, calculates SHA-256, and stores metadata outside the
repository. Failed, cancelled, timed-out, and interrupted jobs retain discovered
partial artifacts with an `incomplete` label. See
[Artifact Security](artifact-security.md).

Publishing is a separate gate. It accepts only a registered artifact version,
revalidates canonical path, signature, size, and SHA-256 on every access, and
uses a 256-bit short-lived bearer token kept only in memory. Raster images are
served with `nosniff`, `no-store`, sandboxed CSP, and safe disposition headers;
active formats are not inlined. A restart invalidates every publication URL.

## Project Memory SHADOW Boundary

Project Memory commands come only from the operator's DevSpace configuration.
DevSpace does not execute a command declared by the opened repository. A mapping
must use an exact trusted repository root and the fixed command
`rtk proxy py -3.11 scripts/manage_project_memory.py`.

The current task is sent to that command over stdin and may appear in the
one-time bounded bundle returned to the MCP client. DevSpace does not store the
raw task or bundle. SQLite stores the task SHA-256, validated receipt, active
decision, sanitized denial codes, bundle-delivery timestamp, access events, and
one-time privilege authorization state. Receipt validation rejects malformed
bindings, unsafe owner paths, task-hash mismatches, and bundle-hash mismatches.

This release is SHADOW-only. Missing, expired, mismatched, or would-deny receipts
produce audit observations but do not block existing tools, including raw shell
access. NORMAL, AUDIT, and UPDATE enforcement are not enabled by this
configuration. Project Memory constrains only DevSpace's MCP tool layer; it is
not a sandbox for other local processes or direct filesystem access.

## Workspace Python Bootstrap Boundary

The operator Python interpreter is an operator-owned absolute configuration
value. It is never accepted from a repository manifest or MCP task parameter.
The `operator-python-bootstrap` runtime is not a general Python executor: it
accepts only a run-mode `python -m venv` operation targeting `.venv` or `venv`
inside the workspace.

Ordinary `workspace-python` tasks resolve only a healthy workspace environment.
They reject incomplete markers, symbolic-link environment roots, missing
`pyvenv.cfg`, interpreters that cannot start, and interpreters whose real
`sys.prefix` does not match the selected workspace environment. Failed,
cancelled, or timed-out bootstrap operations remove their newly created target
or leave it quarantined so later tasks cannot mistake it for a valid runtime.
The operator interpreter path is replaced in task output and is not returned as
the task runtime identity.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

Managed worktrees use a unique attached `devspace/integration/...` branch so a
bounded merge can run without touching a dirty source checkout. Merge never
auto-stashes, cleans, resets, or ignores untracked files.

`git_merge` and `git_push` enforce this workflow boundary: ordinary checkout,
detached, unmanaged, or unapproved-source workspaces are rejected before a Git
mutation runs. Their preflight probes Git live, so stale persisted
creation-time branch metadata cannot authorize a detached worktree or falsely
deny a worktree that has since been attached. Remote Git calls use a separate
POSIX process group so timeout termination also stops local Git descendants
before the repository lock is released.

Additional roots are explicit, in-memory workspace-session grants. DevSpace
canonicalizes each existing directory before use, rejects conflicting access
modes, and applies a requested set atomically: if any requested root is
rejected, none of the requested changes partially take effect. An explicit
empty array clears the grants. SQLite does not persist them, and tool results
state the requested, effective, and rejected sets so a caller can distinguish
an active grant from a rejected or expired one.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
