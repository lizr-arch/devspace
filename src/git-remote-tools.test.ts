import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fetchGit, mergeGit, pushGit } from "./git-tools.js";

const execFileAsync = promisify(execFile);
const GIT_USER_NAME = "DevSpace Remote Test";
const GIT_USER_EMAIL = "devspace-remote-test@example.com";

interface RemoteFixture {
  root: string;
  bare: string;
  producer: string;
  client: string;
  cleanup(): Promise<void>;
}

interface LocalFixture {
  root: string;
  cleanup(): Promise<void>;
}

interface RepositorySnapshot {
  head: string;
  branch: string;
  indexTree: string;
  status: string;
  diff: string;
}

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

const tests: TestCase[] = [];

function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

test("git_fetch updates tracking refs without changing HEAD, index, or worktree", async () => {
  const fixture = await createRemoteFixture("fetch-normal");
  try {
    const before = await snapshotRepository(fixture.client);
    const remoteBefore = await revParse(
      fixture.client,
      "refs/remotes/origin/main",
    );
    const remoteAfter = await commitFile(
      fixture.producer,
      "producer.txt",
      "remote update\n",
      "remote update",
    );
    await git(fixture.producer, ["push", "origin", "main"]);

    const result = await fetchGit({
      workspaceRoot: fixture.client,
      approvedRemotes: ["origin"],
      remote: "origin",
      prune: true,
      expectedHeadSha: before.head,
    });

    assert.equal(result.remote, "origin");
    assert.equal(result.prune, true);
    assert.equal(result.headSha, before.head);
    assert.equal(result.branch, "main");
    assert.deepEqual(result.updatedRefs, [
      {
        ref: "refs/remotes/origin/HEAD",
        before: remoteBefore,
        after: remoteAfter,
      },
      {
        ref: "refs/remotes/origin/main",
        before: remoteBefore,
        after: remoteAfter,
      },
    ]);
    assert.deepEqual(result.createdRefs, []);
    assert.deepEqual(result.deletedRefs, []);
    assert.equal(result.refsAfter["refs/remotes/origin/main"], remoteAfter);
    assert.deepEqual(await snapshotRepository(fixture.client), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_fetch prune reports deleted remote-tracking refs", async () => {
  const fixture = await createRemoteFixture("fetch-prune");
  try {
    await git(fixture.producer, ["switch", "-c", "obsolete"]);
    const obsoleteSha = await commitFile(
      fixture.producer,
      "obsolete.txt",
      "obsolete\n",
      "obsolete branch",
    );
    await git(fixture.producer, ["push", "-u", "origin", "obsolete"]);
    await fetchGit({
      workspaceRoot: fixture.client,
      approvedRemotes: ["origin"],
      prune: false,
    });
    assert.equal(
      await revParse(fixture.client, "refs/remotes/origin/obsolete"),
      obsoleteSha,
    );

    await git(fixture.producer, ["switch", "main"]);
    await git(fixture.producer, ["push", "origin", "--delete", "obsolete"]);
    const before = await snapshotRepository(fixture.client);
    const result = await fetchGit({
      workspaceRoot: fixture.client,
      approvedRemotes: ["origin"],
      prune: true,
      expectedHeadSha: before.head,
    });

    assert.deepEqual(result.deletedRefs, [
      {
        ref: "refs/remotes/origin/obsolete",
        before: obsoleteSha,
      },
    ]);
    await assert.rejects(
      git(fixture.client, [
        "rev-parse",
        "--verify",
        "refs/remotes/origin/obsolete",
      ]),
    );
    assert.deepEqual(await snapshotRepository(fixture.client), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_fetch rejects stale HEAD, unapproved/missing remotes, and remote injection", async () => {
  const fixture = await createRemoteFixture("fetch-policy");
  try {
    const head = await revParse(fixture.client, "HEAD");
    const before = await snapshotRepository(fixture.client);

    await expectCode(
      fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        expectedHeadSha: "0".repeat(40),
      }),
      "GIT_EXPECTED_HEAD_MISMATCH",
    );
    await expectCode(
      fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: [],
        remote: "origin",
        expectedHeadSha: head,
      }),
      "GIT_REMOTE_NOT_APPROVED",
    );
    await expectCode(
      fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["missing"],
        remote: "missing",
        expectedHeadSha: head,
      }),
      "GIT_REMOTE_NOT_FOUND",
    );

    for (const remote of [
      "-u",
      "origin/main",
      "https://example.invalid/repo.git",
      "origin\n--upload-pack=evil",
      "origin:refs/heads/main",
    ]) {
      await expectCode(
        fetchGit({
          workspaceRoot: fixture.client,
          approvedRemotes: [remote],
          remote,
          expectedHeadSha: head,
        }),
        "GIT_REMOTE_INVALID",
      );
    }
    assert.deepEqual(await snapshotRepository(fixture.client), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_fetch rejects credential-bearing URLs without echoing credentials", async () => {
  const fixture = await createRemoteFixture("fetch-credentials");
  try {
    const secret = "TEST_ONLY_REMOTE_SECRET";
    await git(fixture.client, [
      "remote",
      "add",
      "credentialed",
      `https://user:${secret}@example.invalid/repo.git`,
    ]);
    const error = await expectCode(
      fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["credentialed"],
        remote: "credentialed",
      }),
      "GIT_REMOTE_UNSAFE",
    );
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(error.message, /user:/);
  } finally {
    await fixture.cleanup();
  }
});

test("git_fetch and git_push reject an exact remote URL binding mismatch before remote I/O", async () => {
  const fixture = await createRemoteFixture("remote-url-binding");
  try {
    const trackingBefore = await revParse(
      fixture.client,
      "refs/remotes/origin/main",
    );
    const remoteSha = await commitFile(
      fixture.producer,
      "producer.txt",
      "remote update\n",
      "remote update",
    );
    await git(fixture.producer, ["push", "origin", "main"]);
    const mismatchedBinding = {
      origin: [join(fixture.root, "different-remote.git")],
    };

    await expectCode(
      fetchGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedRemoteUrls: mismatchedBinding,
        remote: "origin",
      }),
      "GIT_REMOTE_URL_MISMATCH",
    );
    assert.equal(
      await revParse(fixture.client, "refs/remotes/origin/main"),
      trackingBefore,
      "URL mismatch must be rejected before fetch updates tracking refs",
    );

    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "local update\n",
      "local update",
    );
    const remoteHookMarker = join(fixture.root, "url-mismatch-hook-ran");
    await installRemoteHook(
      fixture,
      `#!/bin/sh\nprintf bad > ${shellQuote(remoteHookMarker)}\nexit 1\n`,
    );
    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedRemoteUrls: mismatchedBinding,
        approvedDestinationBranches: ["main"],
        remote: "origin",
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_REMOTE_URL_MISMATCH",
    );
    await assert.rejects(
      readFile(remoteHookMarker),
      "URL mismatch must be rejected before the remote pre-receive hook runs",
    );
    assert.equal(
      await revParse(fixture.client, "refs/remotes/origin/main"),
      trackingBefore,
      "URL mismatch must be rejected before push performs its internal fetch",
    );
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge ff_only fast-forwards cleanly", async () => {
  const fixture = await createLocalFixture("merge-ff");
  try {
    const headBefore = await revParse(fixture.root, "HEAD");
    await git(fixture.root, ["switch", "-c", "feature"]);
    const sourceSha = await commitFile(
      fixture.root,
      "feature.txt",
      "feature\n",
      "feature",
    );
    await git(fixture.root, ["switch", "main"]);

    const result = await mergeGit({
      workspaceRoot: fixture.root,
      sourceRef: "feature",
      mode: "ff_only",
      expectedHeadSha: headBefore,
      expectedSourceSha: sourceSha,
    });

    assert.equal(result.branch, "main");
    assert.equal(result.headBefore, headBefore);
    assert.equal(result.headAfter, sourceSha);
    assert.equal(result.sourceSha, sourceSha);
    assert.equal(result.fastForwardPossible, true);
    assert.equal(result.createdMergeCommit, false);
    assert.equal(result.mergeCommitSha, undefined);
    assert.deepEqual(result.changedFiles, ["feature.txt"]);
    assert.equal(result.statusAfter.clean, true);
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge resolves repository state paths against the target repository", async () => {
  const fixture = await createLocalFixture("merge-state-path-root");
  const unrelatedCwd = await mkdtemp(
    join(tmpdir(), "devspace-unrelated-merge-state-"),
  );
  const originalCwd = process.cwd();
  try {
    await mkdir(join(unrelatedCwd, ".git"));
    for (const name of [
      "MERGE_HEAD",
      "MERGE_MSG",
      "MERGE_MODE",
      "AUTO_MERGE",
    ]) {
      await writeFile(join(unrelatedCwd, ".git", name), "unrelated\n");
    }
    const head = await revParse(fixture.root, "HEAD");
    process.chdir(unrelatedCwd);
    const result = await mergeGit({
      workspaceRoot: fixture.root,
      sourceRef: "HEAD",
      mode: "ff_only",
      expectedHeadSha: head,
      expectedSourceSha: head,
    });
    assert.equal(result.headBefore, head);
    assert.equal(result.headAfter, head);
  } finally {
    process.chdir(originalCwd);
    await rm(unrelatedCwd, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("git_merge ff_only rejects diverged history without changing the repository", async () => {
  const fixture = await createDivergedFixture("merge-ff-reject");
  try {
    const before = await snapshotRepository(fixture.root);
    await expectCode(
      mergeGit({
        workspaceRoot: fixture.root,
        sourceRef: "feature",
        mode: "ff_only",
        expectedHeadSha: before.head,
      }),
      "GIT_FF_NOT_POSSIBLE",
    );
    assert.deepEqual(await snapshotRepository(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge no_ff creates a two-parent merge commit", async () => {
  const fixture = await createDivergedFixture("merge-no-ff");
  try {
    const headBefore = await revParse(fixture.root, "HEAD");
    const sourceSha = await revParse(fixture.root, "feature");
    const result = await mergeGit({
      workspaceRoot: fixture.root,
      sourceRef: "feature",
      mode: "no_ff",
      commitMessage: "safe no-ff merge",
      expectedHeadSha: headBefore,
      expectedSourceSha: sourceSha,
    });

    assert.equal(result.createdMergeCommit, true);
    assert.equal(result.mergeCommitSha, result.headAfter);
    assert.deepEqual(result.parents, [headBefore, sourceSha]);
    assert.deepEqual(result.changedFiles, ["feature.txt"]);
    assert.equal(result.statusAfter.clean, true);
    assert.equal(await revParse(fixture.root, "HEAD"), result.headAfter);
  } finally {
    await fixture.cleanup();
  }
});

for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
  test(`git_merge rejects a ${dirtyKind} workspace`, async () => {
    const fixture = await createLocalFixture(`merge-dirty-${dirtyKind}`);
    try {
      await git(fixture.root, ["switch", "-c", "feature"]);
      await commitFile(fixture.root, "feature.txt", "feature\n", "feature");
      await git(fixture.root, ["switch", "main"]);
      const head = await revParse(fixture.root, "HEAD");
      if (dirtyKind === "untracked") {
        await writeFile(join(fixture.root, "untracked.txt"), "untracked\n");
      } else {
        await writeFile(join(fixture.root, "base.txt"), `${dirtyKind}\n`);
        if (dirtyKind === "staged") {
          await git(fixture.root, ["add", "--", "base.txt"]);
        }
      }
      await expectCode(
        mergeGit({
          workspaceRoot: fixture.root,
          sourceRef: "feature",
          mode: "ff_only",
          expectedHeadSha: head,
        }),
        "GIT_WORKSPACE_NOT_CLEAN",
      );
      assert.equal(await revParse(fixture.root, "HEAD"), head);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("git_merge rejects detached HEAD", async () => {
  const fixture = await createLocalFixture("merge-detached");
  try {
    await git(fixture.root, ["switch", "-c", "feature"]);
    await commitFile(fixture.root, "feature.txt", "feature\n", "feature");
    await git(fixture.root, ["switch", "--detach", "main"]);
    const head = await revParse(fixture.root, "HEAD");
    await expectCode(
      mergeGit({
        workspaceRoot: fixture.root,
        sourceRef: "feature",
        mode: "ff_only",
        expectedHeadSha: head,
      }),
      "GIT_DETACHED_HEAD",
    );
    assert.equal(await revParse(fixture.root, "HEAD"), head);
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge rejects revision expressions, URLs, and argument-like refs", async () => {
  const fixture = await createLocalFixture("merge-invalid-ref");
  try {
    const head = await revParse(fixture.root, "HEAD");
    for (const sourceRef of [
      "--upload-pack=evil",
      "main..feature",
      "HEAD@{1}",
      "main:file.txt",
      "feature^",
      "https://example.invalid/repo.git",
      "missing",
    ]) {
      await expectCode(
        mergeGit({
          workspaceRoot: fixture.root,
          sourceRef,
          mode: "ff_only",
          expectedHeadSha: head,
        }),
        "GIT_SOURCE_REF_INVALID",
      );
      assert.equal(await revParse(fixture.root, "HEAD"), head);
      assert.equal((await snapshotRepository(fixture.root)).status, "");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge reports conflicts and atomically restores HEAD, index, and worktree", async () => {
  const fixture = await createLocalFixture("merge-conflict");
  try {
    await git(fixture.root, ["switch", "-c", "feature"]);
    await commitFile(
      fixture.root,
      "base.txt",
      "feature version\n",
      "feature conflict",
    );
    const sourceSha = await revParse(fixture.root, "HEAD");
    await git(fixture.root, ["switch", "main"]);
    await commitFile(
      fixture.root,
      "base.txt",
      "main version\n",
      "main conflict",
    );
    const before = await snapshotRepository(fixture.root);
    const contentBefore = await readFile(
      join(fixture.root, "base.txt"),
      "utf8",
    );

    const error = await expectCode(
      mergeGit({
        workspaceRoot: fixture.root,
        sourceRef: "feature",
        mode: "no_ff",
        commitMessage: "conflicting merge",
        expectedHeadSha: before.head,
        expectedSourceSha: sourceSha,
      }),
      "GIT_MERGE_CONFLICT",
    );

    assert.match(error.message, /base\.txt/);
    assert.match(error.message, new RegExp(sourceSha));
    assert.deepEqual(await snapshotRepository(fixture.root), before);
    assert.equal(
      await readFile(join(fixture.root, "base.txt"), "utf8"),
      contentBefore,
    );
    await assert.rejects(
      git(fixture.root, ["rev-parse", "--verify", "MERGE_HEAD"]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge disables local hooks and GPG signing", async () => {
  const fixture = await createDivergedFixture("merge-hooks");
  try {
    const hooksDir = join(fixture.root, ".git", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookMarker = join(fixture.root, ".git", "merge-hook-ran");
    for (const hookName of ["pre-merge-commit", "post-merge"]) {
      const hookPath = join(hooksDir, hookName);
      await writeExecutable(
        hookPath,
        `#!/bin/sh\nprintf bad > ${shellQuote(hookMarker)}\nexit 1\n`,
      );
    }
    const gpgMarker = join(fixture.root, ".git", "gpg-ran");
    const gpgPath = join(fixture.root, ".git", "fake-gpg");
    await writeExecutable(
      gpgPath,
      `#!/bin/sh\nprintf bad > ${shellQuote(gpgMarker)}\nexit 1\n`,
    );
    await git(fixture.root, ["config", "commit.gpgSign", "true"]);
    await git(fixture.root, ["config", "gpg.program", gpgPath]);

    const head = await revParse(fixture.root, "HEAD");
    const result = await mergeGit({
      workspaceRoot: fixture.root,
      sourceRef: "feature",
      mode: "no_ff",
      commitMessage: "hooks and signing disabled",
      expectedHeadSha: head,
    });
    assert.equal(result.createdMergeCommit, true);
    await assert.rejects(readFile(hookMarker));
    await assert.rejects(readFile(gpgMarker));
  } finally {
    await fixture.cleanup();
  }
});

test("git_merge rejects custom merge drivers before executing them", async () => {
  const fixture = await createDivergedFixture("merge-driver");
  try {
    const marker = join(fixture.root, ".git", "merge-driver-ran");
    const driver = join(fixture.root, ".git", "evil-merge-driver");
    await writeExecutable(
      driver,
      `#!/bin/sh\nprintf bad > ${shellQuote(marker)}\nexit 1\n`,
    );
    await git(fixture.root, [
      "config",
      "merge.evil.driver",
      `${driver} %O %A %B`,
    ]);
    const before = await snapshotRepository(fixture.root);
    await expectCode(
      mergeGit({
        workspaceRoot: fixture.root,
        sourceRef: "feature",
        mode: "no_ff",
        commitMessage: "must not run custom driver",
        expectedHeadSha: before.head,
      }),
      "GIT_MERGE_DRIVER_REJECTED",
    );
    await assert.rejects(readFile(marker));
    assert.deepEqual(await snapshotRepository(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push performs an exact fast-forward push and verifies the remote", async () => {
  const fixture = await createRemoteFixture("push-ff");
  try {
    const remoteBefore = await revParse(
      fixture.client,
      "refs/remotes/origin/main",
    );
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    const before = await snapshotRepository(fixture.client);
    const result = await pushGit({
      workspaceRoot: fixture.client,
      approvedRemotes: ["origin"],
      approvedDestinationBranches: ["main"],
      remote: "origin",
      sourceRef: "HEAD",
      destinationBranch: "main",
      expectedLocalSha: localSha,
      expectedRemoteSha: remoteBefore,
    });

    assert.equal(result.remoteShaBefore, remoteBefore);
    assert.equal(result.localSha, localSha);
    assert.equal(result.pushAttempted, true);
    assert.equal(result.pushSucceeded, true);
    assert.equal(result.remoteShaAfter, localSha);
    assert.equal(result.remoteContainsLocal, true);
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), localSha);
    assert.equal(
      await revParse(fixture.client, "refs/remotes/origin/main"),
      localSha,
    );
    assert.deepEqual(await snapshotRepository(fixture.client), before);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push rejects remote SHA mismatch before pushing", async () => {
  const fixture = await createRemoteFixture("push-remote-mismatch");
  try {
    const remoteBefore = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: localSha,
      }),
      "GIT_REMOTE_CHANGED",
    );
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push rejects non-fast-forward history before push", async () => {
  const fixture = await createRemoteFixture("push-nff");
  try {
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    const remoteSha = await commitFile(
      fixture.producer,
      "producer.txt",
      "producer update\n",
      "producer update",
    );
    await git(fixture.producer, ["push", "origin", "main"]);

    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_PUSH_NON_FAST_FORWARD",
    );
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push enforces approved remote and destination branch policy", async () => {
  const fixture = await createRemoteFixture("push-policy");
  try {
    const remoteSha = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: [],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_REMOTE_NOT_APPROVED",
    );
    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["release"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_DESTINATION_BRANCH_NOT_APPROVED",
    );
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
  test(`git_push rejects a ${dirtyKind} workspace`, async () => {
    const fixture = await createRemoteFixture(`push-dirty-${dirtyKind}`);
    try {
      const remoteSha = await revParse(fixture.bare, "refs/heads/main");
      const localSha = await commitFile(
        fixture.client,
        "client.txt",
        "client update\n",
        "client update",
      );
      if (dirtyKind === "untracked") {
        await writeFile(join(fixture.client, "untracked.txt"), "untracked\n");
      } else {
        await writeFile(join(fixture.client, "base.txt"), `${dirtyKind}\n`);
        if (dirtyKind === "staged") {
          await git(fixture.client, ["add", "--", "base.txt"]);
        }
      }
      await expectCode(
        pushGit({
          workspaceRoot: fixture.client,
          approvedRemotes: ["origin"],
          approvedDestinationBranches: ["main"],
          destinationBranch: "main",
          expectedLocalSha: localSha,
          expectedRemoteSha: remoteSha,
        }),
        "GIT_WORKSPACE_NOT_CLEAN",
      );
      assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("git_push rejects detached HEAD", async () => {
  const fixture = await createRemoteFixture("push-detached");
  try {
    const remoteSha = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    await git(fixture.client, ["switch", "--detach", "HEAD"]);
    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_DETACHED_HEAD",
    );
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push surfaces remote hook rejection and disables local pre-push hooks", async () => {
  const fixture = await createRemoteFixture("push-hook-reject");
  try {
    const remoteSha = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    const remoteMarker = join(fixture.root, "remote-hook-ran");
    await installRemoteHook(
      fixture,
      `#!/bin/sh\nprintf ran > ${shellQuote(remoteMarker)}\nprintf '%s\\n' 'remote policy denied update' >&2\nexit 1\n`,
    );
    const localMarker = join(fixture.root, "local-pre-push-ran");
    await writeExecutable(
      join(fixture.client, ".git", "hooks", "pre-push"),
      `#!/bin/sh\nprintf bad > ${shellQuote(localMarker)}\nexit 1\n`,
    );

    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_PUSH_REJECTED",
    );
    assert.equal(await readFile(remoteMarker, "utf8"), "ran");
    await assert.rejects(readFile(localMarker));
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push times out a delayed remote rejection without updating the remote", async () => {
  const fixture = await createRemoteFixture("push-timeout");
  try {
    const remoteSha = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    await installRemoteHook(
      fixture,
      "#!/bin/sh\nsleep 1\nprintf '%s\\n' 'delayed rejection' >&2\nexit 1\n",
    );

    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
        timeoutMs: 100,
      }),
      "GIT_TIMEOUT",
    );
    await delay(1_200);
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push kills a delayed accepting remote process group on timeout", async () => {
  const fixture = await createRemoteFixture("push-timeout-accept");
  try {
    const remoteSha = await revParse(fixture.bare, "refs/heads/main");
    const localSha = await commitFile(
      fixture.client,
      "client.txt",
      "client update\n",
      "client update",
    );
    await installRemoteHook(fixture, "#!/bin/sh\nsleep 1\nexit 0\n");

    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: ["main"],
        destinationBranch: "main",
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
        timeoutMs: 100,
      }),
      "GIT_TIMEOUT",
    );
    await delay(1_200);
    assert.equal(await revParse(fixture.bare, "refs/heads/main"), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("remote operations in linked worktrees are serialized by their common Git directory", async () => {
  const fixture = await createRemoteFixture("common-dir-mutex");
  try {
    const remoteBase = await revParse(fixture.bare, "refs/heads/main");
    await git(fixture.producer, [
      "push",
      "origin",
      "main:refs/heads/serial-a",
      "main:refs/heads/serial-b",
    ]);
    await fetchGit({
      workspaceRoot: fixture.client,
      approvedRemotes: ["origin"],
      approvedRemoteUrls: { origin: [fixture.bare] },
    });

    const worktreeA = join(fixture.root, "worktree-a");
    const worktreeB = join(fixture.root, "worktree-b");
    await git(fixture.client, [
      "worktree",
      "add",
      "-b",
      "worktree-a",
      worktreeA,
      "refs/remotes/origin/serial-a",
    ]);
    await git(fixture.client, [
      "worktree",
      "add",
      "-b",
      "worktree-b",
      worktreeB,
      "refs/remotes/origin/serial-b",
    ]);
    await configureIdentity(worktreeA);
    await configureIdentity(worktreeB);
    const localA = await commitFile(
      worktreeA,
      "worktree-a.txt",
      "worktree A\n",
      "worktree A update",
    );
    const localB = await commitFile(
      worktreeB,
      "worktree-b.txt",
      "worktree B\n",
      "worktree B update",
    );

    const commonDirA = (
      await git(worktreeA, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim();
    const commonDirB = (
      await git(worktreeB, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim();
    assert.equal(commonDirA, commonDirB);

    const orderLog = join(fixture.root, "remote-operation-order.log");
    await installRemoteHook(
      fixture,
      [
        "#!/bin/sh",
        "while read old_sha new_sha ref_name; do",
        `  printf 'start %s\\n' \"$ref_name\" >> ${shellQuote(orderLog)}`,
        "  sleep 0.75",
        `  printf 'end %s\\n' \"$ref_name\" >> ${shellQuote(orderLog)}`,
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );

    const [resultA, resultB] = await Promise.all([
      pushGit({
        workspaceRoot: worktreeA,
        approvedRemotes: ["origin"],
        approvedRemoteUrls: { origin: [fixture.bare] },
        approvedDestinationBranches: ["serial-a", "serial-b"],
        destinationBranch: "serial-a",
        expectedLocalSha: localA,
        expectedRemoteSha: remoteBase,
      }),
      pushGit({
        workspaceRoot: worktreeB,
        approvedRemotes: ["origin"],
        approvedRemoteUrls: { origin: [fixture.bare] },
        approvedDestinationBranches: ["serial-a", "serial-b"],
        destinationBranch: "serial-b",
        expectedLocalSha: localB,
        expectedRemoteSha: remoteBase,
      }),
    ]);

    assert.equal(resultA.pushSucceeded, true);
    assert.equal(resultB.pushSucceeded, true);
    assert.equal(await revParse(fixture.bare, "refs/heads/serial-a"), localA);
    assert.equal(await revParse(fixture.bare, "refs/heads/serial-b"), localB);
    const order = (await readFile(orderLog, "utf8")).trim().split("\n");
    assert.equal(order.length, 4);
    const firstStart = /^start (refs\/heads\/serial-[ab])$/.exec(order[0]);
    assert.ok(firstStart, `Unexpected first hook entry: ${order[0]}`);
    assert.equal(order[1], `end ${firstStart[1]}`);
    const secondStart = /^start (refs\/heads\/serial-[ab])$/.exec(order[2]);
    assert.ok(secondStart, `Unexpected third hook entry: ${order[2]}`);
    assert.notEqual(secondStart[1], firstStart[1]);
    assert.equal(order[3], `end ${secondStart[1]}`);
  } finally {
    await fixture.cleanup();
  }
});

const failures: Array<{ name: string; error: unknown }> = [];
for (const candidate of tests) {
  try {
    await candidate.run();
    console.log(`[PASS] ${candidate.name}`);
  } catch (error) {
    failures.push({ name: candidate.name, error });
    console.error(
      `[FAIL] ${candidate.name}\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  }
}

if (failures.length > 0) {
  throw new AggregateError(
    failures.map(({ error }) => error),
    `${failures.length}/${tests.length} safe Git integration tests failed`,
  );
}

console.log(`git remote tool tests passed (${tests.length}/${tests.length})`);

async function createRemoteFixture(label: string): Promise<RemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), `devspace-${label}-`));
  const bare = join(root, "remote.git");
  const producer = join(root, "producer");
  const client = join(root, "client");
  await mkdir(producer);
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await initializeRepository(producer);
  await writeFile(join(producer, "base.txt"), "base\n");
  await git(producer, ["add", "--", "base.txt"]);
  await git(producer, ["commit", "-m", "initial"]);
  await git(producer, ["remote", "add", "origin", bare]);
  await git(producer, ["push", "-u", "origin", "main"]);
  await git(root, ["clone", "--branch", "main", "--", bare, client]);
  await configureIdentity(client);
  return {
    root,
    bare,
    producer,
    client,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createLocalFixture(label: string): Promise<LocalFixture> {
  const root = await mkdtemp(join(tmpdir(), `devspace-${label}-`));
  await initializeRepository(root);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "--", "base.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createDivergedFixture(label: string): Promise<LocalFixture> {
  const fixture = await createLocalFixture(label);
  await git(fixture.root, ["switch", "-c", "feature"]);
  await commitFile(fixture.root, "feature.txt", "feature\n", "feature change");
  await git(fixture.root, ["switch", "main"]);
  await commitFile(fixture.root, "main.txt", "main\n", "main change");
  return fixture;
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, ["init", "--initial-branch=main"]);
  await configureIdentity(root);
}

async function configureIdentity(root: string): Promise<void> {
  await git(root, ["config", "user.name", GIT_USER_NAME]);
  await git(root, ["config", "user.email", GIT_USER_EMAIL]);
}

async function commitFile(
  root: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(root, path), content);
  await git(root, ["add", "--", path]);
  await git(root, ["commit", "-m", message]);
  return revParse(root, "HEAD");
}

async function snapshotRepository(root: string): Promise<RepositorySnapshot> {
  return {
    head: await revParse(root, "HEAD"),
    branch: (await git(root, ["branch", "--show-current"])).trim(),
    indexTree: (await git(root, ["write-tree"])).trim(),
    status: await git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    diff: await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "HEAD",
      "--",
    ]),
  };
}

async function installRemoteHook(
  fixture: RemoteFixture,
  content: string,
): Promise<void> {
  await writeExecutable(join(fixture.bare, "hooks", "pre-receive"), content);
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function revParse(root: string, ref: string): Promise<string> {
  return (await git(root, ["rev-parse", "--verify", ref])).trim();
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    assert.ok(
      error instanceof Error,
      `Expected ${code}, received ${String(error)}`,
    );
    assert.match(error.message, new RegExp(`^${escapeRegex(code)}:`));
    return error;
  }
  assert.fail(`Expected ${code}, but the operation succeeded`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
