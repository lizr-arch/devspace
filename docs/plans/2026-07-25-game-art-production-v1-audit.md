# Game Art Production V1 implementation audit

Date: 2026-07-25

Branch: `feat/game-art-production-v1`

Baseline: `370568ee7f7dc6ececab809b28bb95eb9bff5eb0`

## Current implementation

- DevSpace is a TypeScript/Node.js 20+ HTTP MCP server built with Express,
  `@modelcontextprotocol/sdk`, Zod, SQLite/Drizzle, and Pi coding primitives.
- MCP tools and their Zod input/output schemas are registered in
  `src/server.ts`. The running schema fingerprint is also derived there.
- `start_job`, `poll_job`, and `cancel_job` use the single lifecycle in
  `src/background-jobs.ts`.
- The baseline runner list is a compile-time tuple. Executables are selected
  from fixed candidates and then a fixed-name login-shell lookup. Argument
  validation rejects absolute/parent paths and restricts package/build actions.
- Jobs are launched with `spawn(..., { shell: false })`, in a workspace-scoped
  working directory. The process is detached into a process group on POSIX.
  Cancellation sends `SIGTERM`, followed by `SIGKILL` after three seconds.
- Baseline limits are two concurrent jobs, a one-hour timeout ceiling, a
  2 MiB output ceiling, and bounded incremental polling.
- Job JSON and logs are persisted under the private DevSpace state directory.
  Jobs that were running across a service restart are marked `interrupted`.
- Workspace sessions are persisted in SQLite. `list_workspaces` filters them
  through the current allowed-root policy; `resume_workspace` reloads project
  instructions, skills, and optional Project Memory state.
- Managed worktrees live under the configured managed-worktree root and retain
  their source-root association. Missing worktrees are reported as unavailable
  and are not silently recreated.
- `devspace_info` reports build/boot/schema/tool/workspace policy and the
  baseline global job limits, but does not probe individual runner
  availability or versions.
- Tests use executable TypeScript unit files plus MCP JSON-RPC/OAuth integration
  flows. The clean V2 baseline passed `npm run test:all` on a retry; one earlier
  doctor run had a transient external-probe timing failure and then passed in
  isolation and in the full rerun.
- The HTTP server has UI resource endpoints and OAuth endpoints, but the
  production workspace server has no registered-artifact ledger, short-lived
  artifact URL, or general attachment/file-serving route.
- A legacy delegate subsystem has run-report artifacts, but it is a separate
  workflow and is not a safe production-artifact publication mechanism.

## Local production environment

- Blender: `/Applications/Blender.app/Contents/MacOS/Blender`, version
  `5.2.0 LTS`.
- Godot Mono: `/Applications/Godot_mono.app/Contents/MacOS/Godot`, version
  `4.7.1.stable.mono`.
- Blender's local `--help` confirms the planned background, scene, render,
  engine, Python-script, Python-exit-code, factory-startup, disable-autoexec,
  and offline-mode switches. It also confirms that argument order affects
  execution.
- The Blender manual documents `--python-expr`, add-on/extension operations,
  and system-Python environment access. These remain outside the default V1
  policy.

## Directly reusable

- The existing Job state machine, persistence format, bounded polling, output
  truncation, timeout handling, and process-group termination.
- Workspace ID ownership, allowed-root checks, managed-worktree persistence,
  and `resume_workspace`.
- The no-shell spawn model and argument-array MCP contract.
- OAuth, public base URL, request logging, and schema fingerprint machinery.
- Existing `import_png` validation patterns for hashing, MIME/signature checks,
  atomic writes, and symlink-aware workspace containment.

## Must change

- Replace the hard-coded runner resolver/condition chain with a validated
  registry whose policies remain code-owned while safe operational overrides
  are local-configuration-owned.
- Add per-runner availability/version diagnostics, timeout/concurrency/output
  caps, containment/network metadata, and non-fatal configuration diagnostics.
- Add the Blender policy and real Blender fixture.
- Extend Job declarations with bounded artifact roots and persist versioned
  artifact manifests outside the repository.
- Add `list_artifacts` and `publish_artifact`.
- Add expiring, high-entropy, artifact-only HTTP publication with strict MIME,
  size, containment, and audit checks.
- Add a generic `.devspace/captures/<profile>.json` contract that delegates
  scene behavior to the project while retaining runner and artifact policy in
  DevSpace.
- Add stable machine-readable error codes and restart/recovery tests.

## Explicitly unchanged

- Existing tool names and the core semantics of all 16 V2 tools.
- OAuth owner approval, workspace authorization, Project Memory SHADOW mode,
  Pi-backed file tools, and managed-worktree creation semantics.
- Project-specific modeling, art direction, scene composition, and quality
  rules.
- Blender GUI control, remote desktop/video streaming, arbitrary executable
  execution, arbitrary shell-string background jobs, and a browser 3D viewer.
- Three Countries scene names or business rules; production integration uses a
  generic capture contract and isolated fixtures.

## Main security risks

- Blender Python, Godot scripts, package scripts, compilers, and build scripts
  can execute trusted project code. Without an OS sandbox, working-directory
  and argument checks do not provide strict write or network containment.
- Executable overrides are a local-administrator trust boundary. The client
  must never provide executable paths or arbitrary argument policies.
- Relative paths can escape through symlinks unless canonical containment is
  checked both when a job starts and when artifacts are discovered/published.
- Artifact publication can become a local-file disclosure primitive unless
  publication is limited to immutable ledger records, checked again at access
  time, MIME constrained, size bounded, and short lived.
- Manifest scans can become denial-of-service paths unless roots, file counts,
  metadata size, hashing volume, and response size are capped.
- Job logs and `devspace_info` must not expose process environments, OAuth
  material, tunnel credentials, or configuration secrets.

## Containment claim

V1 classifies project-code runners as `trusted_local`. DevSpace applies
best-effort path, argument, workspace, process, timeout, output, artifact, and
publication controls, but does not claim an OS-level sandbox or strict write
containment.
