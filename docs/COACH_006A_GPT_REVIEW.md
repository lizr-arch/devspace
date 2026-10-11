# COACH-006-A.1 — Web GPT Independent Review of Real DevSpace Source

Date: 2026-10-11
Review verdict: **RESOURCE_FOUNDATION_PASS**
Deployment/production verdict: **NOT DEPLOYED / MANAGED_SERVICE_PENDING**

## Checkout and isolation
- Actual authorized source: `/Users/liz/agy/devspace`
- Main HEAD before & during work: `c8e97b97bf23f6bcaffce65c8c6f9d8932ce17c1`; `main` clean
- Isolated managed worktree: `/Users/liz/.devspace/worktrees/devspace-f50dc711`
- Worktree branch: `devspace/integration/devspace-devspace-f50dc711`
- No commit, merge, push or production process restart.
- Current live DevSpace continues to execute the old source build (according to previous verified service arrangement); no code has been deployed.

## Root cause found in real code
- `src/task-runner.ts` calls `requestsForCommand` for all non-bootstrap declared tasks, including a long-running readonly bridge launched through `project_task`.
- `src/job-resource-locks.ts` correctly defaults arbitrary tasks to an exclusive `workspace:<real root>` lock. Existing behavior is conservative and protects builds.
- Running such a bridge as `project_task` keeps the workspace locked, preventing a second task. Replacing or bypassing this global lock for arbitrary manifest commands would be unsafe.

## Actual code change
Codex CLI (request: `gpt-5.6-luna`, `model_reasoning_effort=none`) implemented a narrow TypeScript resource foundation. Web GPT then reviewed and hardened it.

Changed:
- `src/job-resource-locks.ts`: added two typed key domains `sidecar-service` and `sidecar-endpoint`; strict service-name/port/endpoint validation; resource owner type permits true `sidecar`, and acquisition metadata is added ONLY for sidecars to preserve current ordinary job snapshots.
- `src/job-resource-locks-sidecar.test.ts`: conflict/no-conflict, malformed name/endpoint/port, atomic failure, unchanged arbitrary `project_task` workspace serialization, provenance, release idempotence.
- `docs/COACH_006A_RESOURCE_FOUNDATION.md`: design note and corrected test record.

Observed Codex execution: 36.65 seconds, cumulative 305331 input tokens (272896 cached), 3052 output tokens. Codex sandbox `tsx` attempts saw EPERM creating an IPC pipe; its `tsc --noEmit` completed. Web GPT tests, not agent claims, are authoritative.

### Independent tests (all final statuses exit=0)
- `verify-resource-unit` — PASS, exact message `sidecar resource lock tests passed`.
- `verify-typecheck` — PASS.
- `verify-existing-workspace-gates` — PASS, exact message `worktree and git governance tests passed`.
- `verify-background-jobs-with-path` — PASS, exact message `background job tests passed`.
- Main baseline `compare-baseline-background-jobs` — PASS with the exact same per-task PATH and unmodified source.
- Initial background-jobs failure traced to `/usr/bin/env node` in the fake Blender fixture, because DevSpace server task PATH lacked `/Users/liz/.local/bin`. This is NOT caused by the resource-key diff. Only the scoped test-process PATH was adjusted; no global settings changed.
- Two final tests (unit and typecheck) rerun after last source formatting changes: exit 0.

## Diff evidence
- Tracked code patch `src/job-resource-locks.ts`, SHA-256: `f931eb6cc839d665e3ec2620da5cecc047d4bb87d3523d8bd6b3068dc7a6bb5f` at final validation.
- Test/doc additions are currently untracked and therefore do not appear in the tracked Git diff SHA. Review exact file contents when staging.
- Working-tree-only bootstrap artifacts `.devspace/tasks.yaml`, `COACH_006A_NATIVE_SPEC.md`, and `node_modules` symlink are NOT intended for production staging/merge.
- No full `test:unit` or deployment smoke run was claimed.

## Remaining blockers and specific next stage
This is a **foundation only**, not yet the user's same-workspace browser bridge fix:
1. Implement `COACH-006-A.2` as a separately authorized, managed readonly-sidecar lifecycle. DO NOT let arbitrary `project_task` manifests opt out of workspace locking.
2. Enforce loopback-only network binding and read-only actual data access, not a trust-me flag in user YAML. Use an internal typed/capability-checked entrypoint and fixed approved executable or in-process HTTP handler.
3. Bind managed-service claims to actual start/status/stop lifetime; ensure clean shutdown, failure rollback, health checks, idempotent start, restart reconciliation, logs bounded, and no orphan/replayed process.
4. Verify an authenticated loopback endpoint in the SAME workspace while normal `project_task` succeeds; ordinary overlapping code-mutating tasks must continue to conflict.
5. Only then consider staging explicit approved code paths, integration and finally restart from `/Users/liz/agy/devspace` with a rollback plan and connector revalidation.

## Safety and status
`main` remains unchanged/clean. Production DevSpace is **not restarted**. TriaRegna untouched. No Git commit/push/merge.
