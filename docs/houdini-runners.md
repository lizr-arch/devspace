# Houdini runners

DevSpace exposes Houdini as two code-owned, bounded background runners:
`hython` for one workspace-local Python file and `hbatch` for one
workspace-local HIP file plus one constrained `source` command. Both reuse the
normal persistent Job lifecycle and Artifact Ledger. They are
`trusted_local`, not an OS sandbox.

## Discovery and configuration

DevSpace checks an operator override first, then known SideFX installation
layouts on macOS, Linux, and Windows, then `PATH`. MCP clients cannot select or
submit an executable. Private operator configuration may bind either built-in:

```json
{
  "runners": {
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

Overrides cannot add runners, replace argument policies, raise global caps, or
come from a workspace.

## License-safe inspection

`houdini_info` reports only:

- detected hython/hbatch executable paths;
- Houdini version and host/executable architecture when proven;
- a safe edition category;
- `available`, `unavailable`, or `unknown` license status;
- hython/hbatch availability;
- a bounded, sanitized diagnostic.

When hython exists, the tool runs a fixed, read-only `hou` import probe without
a shell. It may acquire an already configured license in the same way a normal
headless Houdini process does. It never logs in, accepts an EULA, activates or
changes a product, invokes license-administration commands, reads license
files, or returns raw process output, environment variables, license keys,
accounts, server strings, or credentials.

Executable discovery alone does not prove a license or headless cook. A missing
executable leaves runner availability false and license status unknown. A
failed probe distinguishes a recognizable license-unavailable result from an
unknown failure without returning potentially sensitive diagnostics.

The edition label is operational evidence, not legal advice. Commercial and
Indie use remains subject to the operator's actual SideFX terms and pipeline
compatibility. Apprentice/non-commercial and Education outputs must not be
presented as commercial-production proof. DevSpace never converts source file
editions or bypasses their restrictions.

## Argument policies

Example hython job:

```json
{
  "runner": "hython",
  "args": ["tools/houdini/build_wall.py", "outputs/wall_manifest.json"],
  "artifactRoots": ["outputs/houdini"],
  "timeoutSeconds": 1800
}
```

The first argument must be one existing workspace-local `.py` file. Inline
code, module execution, interactive/stdin execution, absolute paths, parent
traversal, shell controls, redirection, pipes, command substitution, and
symlink escape are rejected. Remaining arguments are still subject to the
shared workspace path and shell-control policy.

Example hbatch job:

```json
{
  "runner": "hbatch",
  "args": [
    "-j",
    "4",
    "-c",
    "source tools/houdini/cook_wall.hscript",
    "source_assets/wall.hip"
  ],
  "artifactRoots": ["outputs/houdini"],
  "timeoutSeconds": 1800
}
```

The V1 hbatch policy accepts one existing `.hip`, `.hiplc`, or `.hipnc` file,
one command exactly shaped as `source <relative .cmd or .hscript>`, and an
optional `-j 1..256`. Arbitrary hscript expressions, extra commands, license
selection/administration flags, and unknown switches are rejected. The sourced
workspace script is trusted project code and can exercise the local user's
authority; path validation is not strict containment.

Both runners are single-concurrency by default, have bounded runtime and
2 MiB captured-output caps, spawn with `shell: false`, persist Job state, and
use verified process-group cancellation and recovery.

## Houdini artifacts

Declared artifact roots recognize:

```text
HIP HIPLC HIPNC HDA HDALC HDANC BGEO.SC ABC USD USDA USDC
GLB JSON PNG JPEG LOG TXT
```

`.bgeo.sc` is matched as a compound extension. Houdini source and digital asset
files are registered and published only as attachment downloads through the
existing path, symlink, size, hash, short-lived-token, and no-sniff gates; they
are never executed during download. Opaque Houdini formats must be non-empty,
while Alembic Ogawa/HDF5 and USD variants receive bounded header checks.

## Real smoke boundary

Unit tests use fake executables to cover installed/missing discovery, version
and license classification, path and injection rejection, timeout, output cap,
artifact discovery, compound extensions, cancellation, concurrency,
credential redaction, registration, and schema identity.

Those tests do not prove that Houdini is installed, licensed, architecture
compatible, or able to cook on the deployment machine. A real smoke requires
operator-provided Houdini and a legal active license, followed by actual
`houdini_info`, hython Job, hbatch Job, artifact, and lifecycle evidence.
