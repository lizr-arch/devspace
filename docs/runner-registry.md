# Runner Registry

DevSpace background jobs use a code-owned Runner Registry. MCP clients select a
registered name and submit an argument array; they cannot submit an executable
path, a shell command string, a regular expression policy, or a validation
script.

## Trust model

The current build reports project-code runners as `trusted_local`. DevSpace
checks runner names, arguments, paths, working directories, concurrency,
timeouts, output volume, and process termination, but it does not provide an
OS-level sandbox. Package scripts, compiler build scripts, Godot scripts, and
later Blender Python scripts can perform operations allowed to the local user.

This is intentionally different from `strict` containment.

## Built-in runners

The V2-compatible registry contains:

```text
npm
pnpm
yarn
bun
dotnet
cargo
pytest
godot
godot-mono
blender
```

Each code-owned definition specifies:

- supported platforms;
- a named argument policy;
- workspace-only working-directory policy;
- default and maximum timeout;
- per-runner concurrency;
- output cap;
- network-policy metadata;
- containment classification;
- a fixed version probe;
- declared-workspace-root artifact policy.

`devspace_info` reports every definition, whether it is enabled, whether its
executable is available, its version when the bounded probe succeeds, its
limits, its containment level, and non-fatal configuration diagnostics. It does
not return environment variables, OAuth material, or tunnel credentials.

## Local configuration

Operational overrides live in the owner's private `~/.devspace/config.json`.
Only built-in names are accepted. Overrides can select an absolute executable,
disable a runner, or lower its timeout/concurrency within the code-owned global
caps:

```json
{
  "runners": {
    "godot-mono": {
      "executable": "/Applications/Godot_mono.app/Contents/MacOS/Godot",
      "enabled": true,
      "maxTimeoutSeconds": 1800,
      "maxConcurrent": 1
    }
  }
}
```

An invalid runner entry does not stop DevSpace from starting. It is ignored and
reported under `devspace_info.runnerRegistry.diagnostics`. A configured
executable that is missing or not executable makes only that runner
unavailable.

Configuration cannot define a new runner or replace its argument policy. Adding
a future runner such as Aseprite, FFmpeg, or ImageMagick requires a
reviewed code-owned policy.

## Blender policy

The Blender runner is single-concurrency, background-only, and reports
`networkPolicy: offline_requested` plus `containment: trusted_local`. The V1
policy allows factory startup, one workspace-local Python script,
Python-exit-code handling, bounded render options, a workspace-local `.blend`
input, and a conservative render-format/engine set.

It rejects `--python-expr`, text-block/console execution, system-Python
environment access, automatic add-on or extension commands, autoexec enabling,
unknown switches, external paths, and symlink escape. Recommended jobs include
`--offline-mode` and `--disable-autoexec` explicitly; these are command-line
requests to Blender, not an OS firewall or sandbox.

## Execution checks

Before spawn, DevSpace:

1. resolves a registered, enabled, platform-supported runner;
2. validates the action and argument array;
3. rejects shell-control characters, absolute paths, parent traversal, and
   unsafe package-script names;
4. canonicalizes the workspace, working directory, and existing argument path
   ancestors to reject symlink escape;
5. applies the per-runner timeout and concurrency caps;
6. launches with `shell: false`;
7. captures bounded output and persists job state;
8. terminates the POSIX process group on timeout, cancellation, or shutdown.

Supported project commands remain trusted code. `networkPolicy: inherited`
describes the current runtime honestly; it is metadata, not a firewall.

## Stable errors

Runner failures use these prefixes:

```text
RUNNER_UNAVAILABLE
RUNNER_ARGUMENT_REJECTED
RUNNER_CONFIG_INVALID
WORKSPACE_ESCAPE
```

Later Game Art Production milestones extend the same registry and Job lifecycle;
they do not introduce a second Blender-specific process manager.
