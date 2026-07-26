# Safe Git Integration

DevSpace exposes three bounded Git integration tools for approved repositories:
`git_fetch`, `git_merge`, and `git_push`. They are intentionally smaller than a
Git CLI and do not restore arbitrary shell access.

## Operator policy

Remote operations are disabled until an operator binds them to exact repository
roots, remote names, remote URLs, and destination branches:

```json
{
  "gitRemoteWrite": {
    "enabled": true,
    "approvedRepositoryRoots": ["/Users/liz/threecountries"],
    "approvedRemotes": ["origin"],
    "approvedRemoteUrls": {
      "origin": ["https://github.com/lizr-arch/threecountries.git"]
    },
    "approvedDestinationBranches": ["main"],
    "allowForce": false,
    "requireCleanWorkspace": true,
    "requireExpectedRemoteSha": true,
    "requireFastForward": true
  }
}
```

The secure booleans cannot be weakened. An enabled policy without every exact
binding is rejected at startup. `devspace_info` reports the enabled state,
approved repository roots, remote names, branches, and fixed safety booleans,
but never reports remote URLs, credentials, tokens, or process environment.

All three tools are absent in read-only mode. Fetch is a network read, but it
also updates remote-tracking refs, so treating it as a pure read would violate
the existing read-only boundary. The current capability metadata classifies all
three as `git.write`; it is descriptive. OAuth's `devspace` scope, tool
registration, and operator policy are the authorization boundary.

## `git_fetch`

```ts
{
  workspaceId: string;
  remote?: string; // origin
  prune?: boolean; // true
  expectedHeadSha?: string;
  projectMemoryReceiptId?: string;
}
```

The caller cannot provide a URL, refspec, upload-pack, tags option, or arbitrary
argument. DevSpace verifies the exact approved URL and generates the only fetch
refspec:

```text
+refs/heads/*:refs/remotes/<approved-remote>/*
```

Tags and `FETCH_HEAD` writes are disabled. The result contains the before/after
remote-tracking ref maps and created, updated, or deleted refs. HEAD, branch,
index, tracked files, untracked files, and conflict state must be unchanged.

## `git_merge`

```ts
{
  workspaceId: string;
  sourceRef: string;
  mode: "ff_only" | "no_ff";
  expectedHeadSha: string;
  commitMessage?: string;
  expectedSourceSha?: string;
  projectMemoryReceiptId?: string;
}
```

The workspace root must equal the Git root, be attached to a branch, and be
fully clean, including untracked files. Expected SHAs are optimistic locks.
Source refs accept only a full object ID, `HEAD`, or a strict ref name; revision
ranges, reflog selectors, path specifications, URLs, leading options, and shell
syntax are rejected.

Only `ff_only` and `no_ff` are supported. `no_ff` requires a message. Hooks,
GPG signing, fsmonitor, executable filters, and custom merge drivers are
disabled or rejected. Rerere, autostash, and recursive submodules are disabled.

On conflict, DevSpace records conflicted paths and merge identity, runs
`git merge --abort`, and verifies the original HEAD, clean index/worktree, and
absence of `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, and `AUTO_MERGE`. Failed
recovery is `GIT_MERGE_ABORT_FAILED`; a repository still in merge state is never
reported as restored.

## `git_push`

```ts
{
  workspaceId: string;
  remote?: string; // origin
  sourceRef?: string; // HEAD
  destinationBranch: string;
  expectedLocalSha: string;
  expectedRemoteSha: string;
  verifyAncestor?: boolean; // true; false is rejected
  projectMemoryReceiptId?: string;
}
```

The source must resolve to the clean workspace HEAD. DevSpace fetches the exact
approved remote, compares its destination with `expectedRemoteSha`, and verifies
that the expected remote commit is an ancestor of `expectedLocalSha`.

Git has no ordinary-push option that atomically compares a previously observed
remote SHA. DevSpace therefore generates an internal exact
`--force-with-lease=<destination>:<expectedRemoteSha>` compare-and-swap while
also requiring the ancestry check and a refspec without `+`. It cannot rewrite
history: it updates only if the remote still equals the expected SHA and the
update is fast-forward. The caller cannot express, disable, or alter the lease.
Any drift is `GIT_REMOTE_CHANGED`.

The only generated refspec is:

```text
<resolved-current-head>:refs/heads/<approved-destination>
```

After push, DevSpace fetches again and verifies the remote contains the exact
local commit. Force fields, deletion, tags, mirror, all, push options, upstream
changes, URLs, arbitrary refspecs, and arbitrary arguments do not exist in the
MCP schema.

## Dirty checkout workflow

Never merge in a dirty primary checkout. Do not stash, clean, reset, or ignore
untracked files.

1. Record the primary checkout branch, HEAD, and status hash.
2. Call `open_workspace` with `mode="worktree"` and
   `baseRef="origin/main"`.
3. DevSpace creates an attached, unique `devspace/integration/...` branch.
4. Call `git_fetch`, then `git_merge` with exact target/source SHAs.
5. Run operator-registered build and test runners.
6. Call `git_push` with the fetched remote SHA.
7. Fetch and verify again, then compare the primary checkout status hash.

The source checkout is never auto-stashed, auto-cleaned, reset, or switched.

## Retrying remote drift

`GIT_REMOTE_CHANGED` and `GIT_PUSH_NON_FAST_FORWARD` are safe stops. Fetch
again, inspect the new history, create a fresh clean worktree if needed, and
repeat the explicit merge and validation. DevSpace never automatically rebases,
merges the drift, or forces a history update.

## Execution containment

Git uses argument arrays, fixed timeouts and output limits, no shell, no
terminal prompt, an empty trusted hooks directory, signing disabled, and
dangerous inherited Git/SSH execution variables removed. Repository-local
credential helpers, SSH commands, upload/receive-pack overrides, URL rewrites,
filters, and merge drivers are rejected. Production remotes are exact
operator-approved HTTPS URLs; local `file://` URLs require an equally exact
operator binding and are intended for isolated tests.
