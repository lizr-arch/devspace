# Houdini Runner R1/R2 Integration Report

Date: 2026-07-28  
Verdict: PASS for isolated integration and pre-deployment validation  
Push: not performed  
Canonical branch merge: not performed

## Locked Git inputs

- Repository: `/Users/liz/Documents/Codex/2026-07-21/wo-de/work/devspace`
- Canonical development branch: `main`
- Remote canonical ref, verified with `git ls-remote`:
  `51914eeb6e11782fbcd87052056214bcd2f1b43b`
- Local `refs/heads/main` at preflight:
  `51914eeb6e11782fbcd87052056214bcd2f1b43b`
- Source worktree:
  `/Users/liz/.devspace/worktrees/devspace-houdini-runner-r1`
- Source branch: `feat/houdini-runner-r1`
- Source commit:
  `f8ef2471bcfc792debd4fb32decf5e41b3e63ed4`
- Source parent:
  `51914eeb6e11782fbcd87052056214bcd2f1b43b`
- Source worktree status: clean
- Integration worktree:
  `/Users/liz/.devspace/worktrees/devspace-houdini-runner-integration-r2`
- Integration branch: `integration/houdini-runner-r1-r2`
- No-FF merge commit:
  `704c2ba62db911951487767344bd219d56afa11d`
- Merge parents, in order:
  `51914eeb6e11782fbcd87052056214bcd2f1b43b`
  and `f8ef2471bcfc792debd4fb32decf5e41b3e63ed4`

The dirty primary checkout was not modified, staged, stashed, cleaned, reset,
switched, merged, or rebased. At preflight it was on
`codex/import-png-openai-file-p0` at the canonical base commit with zero staged
paths, seven unstaged tracked paths, three untracked paths, zero conflicts, and
status hash
`3c7f64cb5a55359e2f3b7c6b91f39b55da0cbaeac1e2c84e424d408a97367991`.

## Integrated scope

The no-FF merge contains exactly the reviewed source change:

- bounded `hython` and `hbatch` Runner Registry definitions;
- workspace/symlink containment and argument-array policies;
- `shell: false`, timeout, output, concurrency, cancellation, and process-group
  lifecycle controls;
- license-safe, credential-redacted `houdini_info`;
- Houdini artifact discovery and safe download metadata, including compound
  `.bgeo.sc`;
- runner, artifact-ledger, background-job, doctor, server, schema, path, and
  security tests;
- Runner, configuration, security, artifact, and Houdini documentation.

Changed paths:

```text
docs/artifact-security.md
docs/configuration.md
docs/game-art-production.md
docs/houdini-runners.md
docs/runner-registry.md
docs/security.md
package.json
src/artifact-ledger.test.ts
src/artifact-ledger.ts
src/background-jobs.test.ts
src/background-jobs.ts
src/doctor.test.ts
src/doctor.ts
src/houdini.test.ts
src/houdini.ts
src/runner-registry.test.ts
src/runner-registry.ts
src/server.ts
```

No Houdini installation, license activation, account action, EULA action, HIP,
HDA, cache, or Three Countries asset was created by this integration.

## Automated validation

All commands ran in the isolated integration worktree.

| Gate | Command or evidence | Result |
| --- | --- | --- |
| Dependency install | `npm ci --include=dev` | PASS |
| Formatting | `npm run format:check` | PASS |
| Type safety | `npm run typecheck` | PASS |
| Production build | `npm run build` | PASS |
| Unit suite | `npm test` | PASS |
| MCP suite | `npm run test:mcp` | PASS, 90/90 |
| Runner Registry | `src/runner-registry.test.ts` within unit suite | PASS |
| Houdini discovery/redaction | `src/houdini.test.ts` within unit suite | PASS |
| Artifact Ledger / `.bgeo.sc` | `src/artifact-ledger.test.ts` within unit suite | PASS |
| Jobs / cancellation / timeout / concurrency / output | `src/background-jobs.test.ts` within unit suite | PASS |
| Doctor / schema fingerprint | `src/doctor.test.ts` within unit suite | PASS |
| Server / security / path behavior | unit suite plus full-loop test server | PASS |

The build emitted the existing Vite large-chunk warning but exited 0.
`npm ci` reported 15 dependency-audit findings (1 low, 7 moderate, 7 high);
no automatic dependency mutation was authorized or performed.

## Isolated server and MCP proof

An integration build was started as an isolated loopback test instance using
temporary config/state directories and port `17676`; production remained on
`127.0.0.1:7676`.

- Version: `1.1.0`
- Ephemeral test Boot ID:
  `0a39af33-6674-4fc4-bcf9-895b7d03f645`
- Schema revision:
  `devspacemac-houdini-runner-v1.2026-07-27`
- Schema fingerprint:
  `3c7f7521b33e63f82c2c04ff0835f1b4df944cdb3592207b99d5e57e9b965568`
- Registered tools: 48
- MCP transport: stateless
- Active sessions at health probe: 0
- `node dist/cli.js doctor --live`: PASS
- `node dist/cli.js doctor --public --full-loop`: PASS
- OAuth registration, approval, token exchange, MCP initialize, `tools/list`,
  Workspace App template/assets/CORS/CORP/fingerprint, `devspace_info`,
  `open_workspace`, `list_workspaces`, and `resume_workspace`: PASS
- Full-loop doctor called the registered `houdini_info` tool and validated its
  sanitized structured response contract.

Registration evidence:

- `hython` is a code-owned Runner Registry entry.
- `hbatch` is a code-owned Runner Registry entry.
- `houdini_info` is a registered read-only MCP tool.
- The host currently has no discovered `hython` or `hbatch`.

The exact reviewed API uses `hythonAvailable`, `hbatchAvailable`,
`licenseStatus`, and a sanitized `diagnostic`; it does not expose a separate
`status=not_installed` field. With Houdini absent, the intended result is both
availability booleans false, license status `unknown`, and the diagnostic
`Houdini executables were not found in trusted discovery locations or operator configuration.`
This field-name variance is recorded rather than changing the reviewed source
commit during integration.

## Production preflight and rollback lock

Before deployment, the actual production service was recorded as:

- LaunchAgent: `com.liz.devspace`
- Working directory:
  `/Users/liz/.codex/worktrees/devspace-live-monitor`
- Deployed source commit:
  `c04329dcf6542aedcd99c3d003bbfdce0c322456`
- Program:
  `/Users/liz/.hermes/node/bin/node dist/cli.js serve`
- Listener: `127.0.0.1:7676`
- Process ID at preflight: `14289`
- Version: `1.1.0`
- Boot ID: `ebff385b-dc12-43fa-947f-29d0ff3eb698`
- Schema revision:
  `devspacemac-workspace-app-telemetry-v1.2026-07-27`
- Schema fingerprint:
  `c434eb97c5b4ce093923060dc32df08bf7d0fb955f87290ce043e7cf45bf01e8`
- Registered tools: 44
- Active jobs: 0
- Active MCP sessions: 0
- Transport: stateless
- Public connector: `DevSpaceMac Cloudflare`
- Public origin: `https://mcp.workspaceport.com`
- Tunnel backing service: `com.liz.cloudflared-devspace`

Rollback preserves the old worktree and its built `dist/` tree. The controlled
rollback is to restore the original LaunchAgent plist with the old working
directory, reload or kickstart `gui/$(id -u)/com.liz.devspace`, wait for
`127.0.0.1:7676/healthz`, then verify the old Boot/Schema/fingerprint through
local health and `DevSpaceMac Cloudflare` `devspace_info`. No tunnel, OAuth, or
Cloudflare credential changes are part of deployment or rollback.

## Integration conclusion

`devspace_integration=PASS` is supported for the isolated branch and merge
commit. Production deployment and real public Connector verification remain a
separate gate and must record a new production Boot ID plus the actual public
schema/fingerprint before `devspace_deployment` or
`connector_schema_verification` can be marked PASS.
