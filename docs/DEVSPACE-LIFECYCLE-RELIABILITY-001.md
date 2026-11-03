# DEVSPACE-LIFECYCLE-RELIABILITY-001 — reclaim truthfulness and a usable cleanup plan

Status: implementation + tests + local commit only. Not merged, not pushed, not deployed.
Scope: `reclaim_workspace` result reporting and `list_workspaces(cleanupPlan=true)`.
No safety gate was relaxed.

## 1. Defects

### DS-RECLAIM-FALSE-NEGATIVE-001 — a successful removal was reported as a failure

The `reclaim_workspace` handler ran, in this order:

1. `withExclusiveLease(...) → reclaimWorkspace(...)` — removed the worktree with a
   non-forced `git worktree remove` and deleted the workspace record;
2. `observeProjectMemoryAccess(workspaceId, "reclaim_workspace", ...)` — which calls
   `getWorkspace(workspaceId)` internally;
3. the record no longer existed, so `getWorkspace` threw
   `Unknown workspaceId: … Call open_workspace first.`;
4. the tool returned `isError: true` with `WORKSPACE_NOT_FOUND`.

Every one of the three real reclamations in
`TR-WORKSPACE-CONSOLIDATION-001/execution_batch01` hit this. The removal had
succeeded; only the reporting was wrong.

Root cause: the post-mutation response path re-read the record it had just deleted.

### DS-CLEANUPPAN-PLAN-001 — the unified cleanup plan always failed when an orphan directory existed

`cleanupPlan()` always calls `orphanedWorktreeAudit()`, which audited each orphan
directory with a synthetic id:

```ts
id: `orphan:${directory}`
```

That id was passed to the workspace-scoped probes, and the production wiring
includes `coachReviewEvents.hasInterruptedRun(workspaceId)`, whose first line is:

```ts
if (!ID.test(workspaceId)) throw new TypeError("COACH_AGENT_RUN_INVALID");
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
```

`orphan:/Users/...` contains `/`, which the regex rejects, so the probe threw and the
whole plan (and `includeOrphans`) failed with `COACH_AGENT_RUN_INVALID`. Reproduced
with `limit=1`; `audit=true` alone was unaffected because it never audits orphans.

Root cause: a directory with no record has no workspace id, and a synthetic one is
not a valid substitute — validating stores reject it. The bug was invisible to the
existing suite because the test fixture's probe accepted any string.

## 2. Changes

| File | Change |
|---|---|
| `src/workspaces.ts` | `sessionActivityFor` accepts `id: string \| null` and skips workspace-scoped probes when there is no record; orphan audits pass `null`; `cleanupPlan` isolates per-record and per-orphan failures into `UNKNOWN` entries and reports an unreadable orphan inventory via `orphans.error`; `reclaimWorkspace` verifies the removal before deleting the record and returns `outcome` + `verification`; new `storedSession()` read-only accessor; new `verifyWorktreeRemoval()` |
| `src/workspace-reclaim-tool.ts` (new) | The tool-facing sequence: read record → observe Project Memory **before** the mutation → reclaim → build the response from the reclaim's return value only. Classifies every attempt as `CONFIRMED_SUCCESS` / `CONFIRMED_NO_MUTATION` / `OUTCOME_UNKNOWN` |
| `src/server/tools-workspace.ts` | Handler delegates to `reclaimWorkspaceViaTool`; output schema gains `outcome` and `verification` |
| `src/workspace-lifecycle-cleanup.test.ts` | 20 new regression tests (outcome contract, fault injection, plan resilience) |
| `tests/test_mcp_git_lifecycle.ts` | MCP-level proof of the success path and of the duplicate-call answer |

### Three outcomes, and what they mean

| Outcome | Meaning | Caller may |
|---|---|---|
| `CONFIRMED_SUCCESS` | directory absent **and** Git no longer registers the path; record deleted (or its deletion failure reported explicitly) | proceed |
| `CONFIRMED_NO_MUTATION` | a refusal from a closed allowlist of pre-mutation errors; record and files intact | fix the cause and retry |
| `OUTCOME_UNKNOWN` | anything else, including a failure raised after the removal; record kept | verify read-only first; **do not retry blindly** |

The no-mutation verdict is an **allowlist**, not a default: only
`WORKSPACE_RECLAIM_{CONFIRMATION_REQUIRED,RECORD_MISSING,NO_RECORD,ACTIVE,NOT_MANAGED_WORKTREE,SESSION_NOT_CLOSED,STALE_RECORD,OUTSIDE_WORKTREE_ROOT,UNSAFE,HEAD_MISMATCH,FAILED}`
are treated as "nothing happened". An unrecognised error becomes `OUTCOME_UNKNOWN`,
because it may have been raised after the worktree was already removed.

`OUTCOME_UNKNOWN` carries `error.code = "WORKSPACE_RECLAIM_OUTCOME_UNKNOWN"` with
`safeToRetry: false`, so a client can branch on the code instead of parsing text.

If `git worktree remove` succeeds but the store record cannot be deleted, the result is
still `CONFIRMED_SUCCESS` with `storeRecordRemoved: false` and an explicit warning: the
worktree is provably gone, so calling that "nothing happened" would be a lie. The
leftover record shows up as `BLOCKED_MISSING` and needs reconciliation (no tool currently
prunes a record without removing a worktree; that is deliberate — see residual risks).

## 3. What did not change

- SHA pinning, identity checks, owner/lease checks, foreign-process probing, dirty /
  untracked / unmerged refusals: untouched. The reclaim audit is the same call.
- `git worktree remove` is still used **without** `--force`; there is still no
  `rm -rf`, no `git clean`, no reset, no branch deletion.
- `close_workspace_session` semantics are unchanged (its record is never deleted).
- `audit=true` output is unchanged; the plan only adds an `error` field when the
  orphan inventory cannot be produced.
- The `WORKSPACE_RECLAIM_*` error prefixes are preserved, so existing error-code
  mapping behaves as before. New: `WORKSPACE_RECLAIM_OUTCOME_UNKNOWN`.
- A duplicate `reclaim_workspace` now returns `WORKSPACE_RECLAIM_RECORD_MISSING`
  (previously it surfaced `WORKSPACE_NOT_FOUND` from the registry lookup). Both are
  errors; the new one states that nothing was removed.

## 4. Tests

```sh
npx tsx src/workspace-lifecycle-cleanup.test.ts     # 70 passed
npx tsx tests/test_mcp_git_lifecycle.ts             # 14 checks
npm run typecheck
```

Fault injection covers: Project Memory observation failure after a successful
removal (still `CONFIRMED_SUCCESS`), a store failure while deleting the record (still
`CONFIRMED_SUCCESS`, `storeRecordRemoved: false`, record kept), an unrecognised error
raised after the removal (`OUTCOME_UNKNOWN`, never a no-op), a failed removal that
cannot be proven to be a no-op (`OUTCOME_UNKNOWN`), unverifiable removal
(`OUTCOME_UNKNOWN`, record kept), locked worktree (`git worktree remove` fails →
`CONFIRMED_NO_MUTATION`), a record that vanishes before the lease (`CONFIRMED_NO_MUTATION`),
two concurrent reclaims of one worktree (exactly one succeeds), a probe that throws for
one record (that entry `UNKNOWN`, the others unaffected), and a failing orphan inventory
(plan still returns, `orphans.error` set and rendered in the text).

## 5. Residual risks

- `verifyWorktreeRemoval` adds one `git worktree list` and one `git rev-parse` per
  reclaim. If the directory cannot be inspected (EACCES/ELOOP/EMFILE) or the Git
  listing is unreadable, the outcome becomes `OUTCOME_UNKNOWN` rather than a guess.
- **A record left behind by `OUTCOME_UNKNOWN` has no tool-driven prune path.** It is
  visible as `BLOCKED_MISSING` in `list_workspaces(audit=true)`, and a later reclaim
  refuses with `WORKSPACE_RECLAIM_STALE_RECORD`. Reconciliation is deliberate manual
  work; adding a record-only prune is a separate, destructive capability that should
  not ride along with a bug fix.
- The plan now tolerates a broken record by reporting `UNKNOWN`; a caller that only
  counts `SAFE_CANDIDATE` will see fewer candidates, never more.
- `cleanupPlan` still runs one audit per workspace sequentially; unchanged.
- The orphan-inventory failure is surfaced in both `structuredContent.cleanupPlan.orphans.error`
  and the model-readable text; `includeOrphans=true` (a separate call path) still fails
  the whole request if the Git repository itself cannot be read.
