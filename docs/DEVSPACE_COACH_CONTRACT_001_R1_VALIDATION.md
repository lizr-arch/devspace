# DEVSPACE-COACH-CONTRACT-001 R1 validation

Source baseline: `6ec4ed3d74c084131d567a3e58120c29e23d54d1`, isolated branch `devspace/integration/devspace-devspace-a4b09b5f`. Changes are limited to R1 G-01–G-04.

## Failure and repair

The old production runner source at `d8391303268443cea387df906620a61813516768` was exercised with a native fixture child in a disposable Git workspace. The child exited **0**, adding exactly `.devspace/coach/tasks/fixture-task/results/baseline-op.json` and `fixture-test-output.txt`. Native completion failed at **evidence** with **CODEX_EVIDENCE_SENSITIVE_PATH**. The reproduction harness exited **0** after asserting that failure. It did not run a model or modify production.

The real worktree also contained preexisting `results/source.patch`, inventory/result JSON, npm cache and 564 untracked TMPDIR artifacts under the original TASK tree. These are not broadly exempted or removed. The repair permits only the exact own report and validated, explicitly hashed test proofs in `results/<operationId>/`, recording hashes in immutable `operationProofs`. TASK controls, other operations, unlisted files and sensitive names remain protected, including Git-ignored task controls.

Freezing now accepts task ID or exact relative path, computes SHA on the server and returns a full reference. Optional expected hash/version checks and legacy full-reference calls are covered through in-process MCP.

The delivery queue filters frozen report status before counting/pagination. Progress, blocked, missing and invalid reports cannot request Chrome review. PLAN_CONFLICT goes to its bound workspace owner with a distinct revision instruction. Historical event IDs, signed review receipts and the source diff/JSON manifest format remain unchanged.

## Final commands and exit codes

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm run typecheck` | 0 | `typecheck-final.log` |
| `npm run build` | 0 | `build-final.log` |
| `npm run test:coach:contract` | 0 | `contract-final.log` |
| Old production native failure reproduction | 0 | `old-production-reproduction-final.log` |
| `node --import tsx src/managed-coach-sidecar.test.ts` | 1 | `sidecar-socket.log`: `listen EPERM 127.0.0.1` |

Raw logs are retained locally in `/private/tmp/devspace-r1-validation-hmskczf6/`, outside the workspace TASK tree. TMPDIR/npm cache were explicitly redirected there, with Node/tsx compile caches disabled. No generated logs/caches are committed.

The contract command includes task/report security checks, 28 native child Git/non-Git proof scenarios (including ignored controls), handler-level status/pagination/owner/auth/integrity negatives, real fixture Runner/MCP/Coach integration, signed historical review/restart regressions and 72 passing Chrome tests. Proof existence/hashes do not independently verify self-reported command success; the existing signed test gate remains mandatory.

DEV–TEST–FIX was completed. Initial full regression exited 1 on an old empty-diff assertion; a subsequent regression exposed that appending proof JSON broke the existing source manifest format. Proof metadata was moved to its own packet field, the original empty-diff assertion was preserved, and the full regression/typecheck/build were rerun successfully.

## Scope and unresolved validation

The actual `.devspace/coach/tasks` tree had 623 regular files before/after validation, with identical relative paths and SHA-256 values. No TASK, result, old evidence or cache in that tree was changed or removed. Only exact files/directories allocated by this validation run were cleaned. The preexisting untracked R1 task document is left untouched.

The socket test remains blocked by this execution environment's loopback-listen EPERM. Handler-level negatives passed, but this is not a socket or live Chrome/Native Messaging production PASS. Production main, Sidecar and global skills were not modified or restarted; there was no push, merge or deployment. Live adoption of these source changes remains outside this task.

The normal worktree commit is also blocked by environment permissions: the MCP staging tool requires approval while the policy is `never`; local `git add` exits **128** because the shared Git directory cannot create `index.lock` (`Operation not permitted`). No shared index or branch reference was changed. A source-only commit with parent `6ec4ed3` is instead delivered in a separate Git repository under the validation directory on branch `devspace/contract-001-r1`, together with `r1-source.bundle`. This preserves a real, reviewable commit without writing the shared Git metadata. Importing it into the original isolated branch remains outstanding; the original worktree HEAD remains `6ec4ed3`.
