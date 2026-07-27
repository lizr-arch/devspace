# Houdini Runner R1/R2 Production Deployment Report

Date: 2026-07-28  
Verdict: PASS  
Canonical branch merge: not performed  
Push: not performed

## Deployed source

- Worktree:
  `/Users/liz/.devspace/worktrees/devspace-houdini-runner-integration-r2`
- Branch: `integration/houdini-runner-r1-r2`
- Base: `51914eeb6e11782fbcd87052056214bcd2f1b43b`
- Reviewed source:
  `f8ef2471bcfc792debd4fb32decf5e41b3e63ed4`
- No-FF merge:
  `704c2ba62db911951487767344bd219d56afa11d`
- Integration/report commit deployed at service boot:
  `0a48fc411aeaed7fe8e8db24a5220c5bec017e29`
- LaunchAgent: `com.liz.devspace`
- Deployed LaunchAgent working directory:
  `/Users/liz/.devspace/worktrees/devspace-houdini-runner-integration-r2`
- Program:
  `/Users/liz/.hermes/node/bin/node dist/cli.js serve`

The production build was regenerated from the deployed worktree immediately
before the service change. The integration source worktree was clean at
deployment.

## Old and new production identity

| Field | Old production | Deployed production |
| --- | --- | --- |
| Source | `c04329dcf6542aedcd99c3d003bbfdce0c322456` | `0a48fc411aeaed7fe8e8db24a5220c5bec017e29` |
| Version | `1.1.0` | `1.1.0` |
| Boot ID | `ebff385b-dc12-43fa-947f-29d0ff3eb698` | `30b32ee8-9f02-4b00-8fb7-ed92d321c28a` |
| Schema | `devspacemac-workspace-app-telemetry-v1.2026-07-27` | `devspacemac-houdini-runner-v1.2026-07-27` |
| Fingerprint | `c434eb97c5b4ce093923060dc32df08bf7d0fb955f87290ce043e7cf45bf01e8` | `c577621983f22bb1ed2408ed445767b5a781659dd265a390cd38d8b091f4d299` |
| Tools | 44 | 49 |
| MCP transport | stateless | stateless |
| Active jobs | 0 | 0 |
| Active MCP sessions | 0 | 0 |

The old source worktree and its built `dist/` tree remain intact.

## Reload failure, verified recovery, and successful retry

The first reload used `launchctl bootout` followed by `launchctl bootstrap`.
Both the new-service bootstrap and the automatic old-service bootstrap returned:

```text
Bootstrap failed: 5: Input/output error
```

The rollback had already restored the original plist content, but the old
service was temporarily unregistered. No Git state, Cloudflare route, tunnel
token, OAuth configuration, state database, or old build was changed.

Recovery then used the existing LaunchAgent plist with:

```text
launchctl load -w ~/Library/LaunchAgents/com.liz.devspace.plist
```

Recovery PASS evidence:

- recovery Boot ID:
  `8dec46b8-66f7-4874-b33b-ad5da3ece183`;
- old schema restored:
  `devspacemac-workspace-app-telemetry-v1.2026-07-27`;
- old fingerprint restored:
  `c434eb97c5b4ce093923060dc32df08bf7d0fb955f87290ce043e7cf45bf01e8`;
- old tool count restored: 44;
- `127.0.0.1:7676/healthz`: PASS.

After old-service recovery, the deployment was retried once using the
LaunchAgent-compatible `unload` / `load -w` path. The new service reached Ready
with the deployed schema and remains running. This retry did not modify the
Cloudflare LaunchAgent, route, token, OAuth state, or public hostname.

## Rollback point

Rollback plist:

```text
/Users/liz/Library/LaunchAgents/com.liz.devspace.pre-houdini-r2-retry-20260728T001840.plist
```

The rollback plist points to:

```text
/Users/liz/.codex/worktrees/devspace-live-monitor
```

That old worktree remains at:

```text
c04329dcf6542aedcd99c3d003bbfdce0c322456
```

Verified rollback procedure:

1. Copy the rollback plist over
   `~/Library/LaunchAgents/com.liz.devspace.plist`.
2. Run `launchctl unload` for the active plist; tolerate only the expected
   already-unloaded condition.
3. Run `launchctl load -w` for the restored plist.
4. Wait for `http://127.0.0.1:7676/healthz`.
5. Confirm a new Boot ID with the old schema and fingerprint.
6. Confirm `DevSpaceMac Cloudflare` `devspace_info` returns the old identity.

No credential value is stored in this report.

## Production doctor and public Workspace App

All production checks ran from the deployed integration checkout.

- `node dist/cli.js doctor --live`: PASS
- `node dist/cli.js doctor --public`: PASS
- `node dist/cli.js doctor --public --full-loop`: PASS

The real public full-loop verified:

- public health through Cloudflare;
- OAuth protected-resource and authorization metadata;
- dynamic client registration;
- Owner approval and token exchange;
- external stateless MCP initialize;
- external `tools/list`;
- versioned Workspace App URI;
- Workspace App template, entry JavaScript, and stylesheet;
- CORS and CORP headers;
- Workspace App build fingerprint;
- bounded Workspace App telemetry;
- MCP `devspace_info`;
- `open_workspace`, `list_workspaces`, and `resume_workspace`.

Deployed Workspace App:

- URI: `ui://devspace/workspace-app-bb41910715dd9406.html`
- build fingerprint:
  `bb41910715dd940647cf56b7fc96d4f531a5324ea81e0d9ae4ac139d86b95a6b`

The `com.liz.cloudflared-devspace` LaunchAgent remained running throughout the
successful retry and final validation.

## Real Connector and Houdini preflight

`DevSpaceMac Cloudflare` `devspace_info` returned:

- Boot ID: `30b32ee8-9f02-4b00-8fb7-ed92d321c28a`;
- schema:
  `devspacemac-houdini-runner-v1.2026-07-27`;
- fingerprint:
  `c577621983f22bb1ed2408ed445767b5a781659dd265a390cd38d8b091f4d299`;
- tools: 49;
- registered Runner list includes `hython` and `hbatch`;
- both Houdini runners are unavailable on this host.

A fresh external OAuth/MCP client called `houdini_info` through the real
Cloudflare public endpoint. The call returned HTTP 200 and passed the sanitized
structured-response gate:

```text
hostArchitecture=arm64
version=null
executableArchitecture=null
productEdition=unknown
licenseStatus=unknown
hythonAvailable=false
hbatchAvailable=false
detectedExecutable=null
diagnostic=Houdini executables were not found in trusted discovery locations or operator configuration.
```

No login, activation, EULA action, license administration, license-file read,
or credential output occurred. Houdini not being installed is an expected
operator checkpoint, not a DevSpace integration or deployment failure.

The reviewed API exposes `hythonAvailable`, `hbatchAvailable`,
`licenseStatus`, and `diagnostic`; it does not expose a separate
`status=not_installed` property.

## 48-tool test instance versus 49-tool production

The isolated temporary test instance reported 48 tools and fingerprint
`3c7f7521b33e63f82c2c04ff0835f1b4df944cdb3592207b99d5e57e9b965568`.
It intentionally used an empty temporary config and therefore did not enable
production `gitRemoteWrite`; the conditionally registered `git_push` tool was
absent.

Production uses the operator-owned safe Git policy with
`gitRemoteWrite.enabled=true`, so `git_push` is registered and the tool count is
49. The schema fingerprint hashes the package/schema revision, exposed tools,
tool mode, widgets, capability map, runner names, safe Git policy, and Workspace
App identity. The differing fingerprint is therefore expected configuration
identity, not mixed code, a stale server, or a partial deployment.

Compared with the old 44-tool production service, the new public tool set
removes no tool. It adds:

```text
houdini_info
poll_task
project_task
stop_task
approve_task_manifest
```

The four task tools come from the current canonical base; `houdini_info` comes
from the reviewed Houdini source commit.

## Old-tool probes

Real `DevSpaceMac Cloudflare` calls after deployment passed for:

- `list_workspaces`;
- `read` on `AGENTS.md`;
- `git_status`;
- `list_artifacts`.

The public full-loop also passed `open_workspace`, `list_workspaces`, and
`resume_workspace`. Together with the exact 44-to-49 tool-set comparison, this
supports that no old production tool was lost.

## Final state

- `devspace_integration=PASS`
- `devspace_deployment=PASS`
- `connector_schema_verification=PASS`
- `houdini_installation=BLOCKED` because Houdini is not installed
- `houdini_license=BLOCKED` because no installed executable can query a license
- no Houdini smoke or Three Countries V8.4D work is authorized from this gate
- integration branch is not merged to `main`
- integration branch is not pushed
