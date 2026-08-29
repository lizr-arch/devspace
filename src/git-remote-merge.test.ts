import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGit, mergeGit } from "./git-tools.js";
import {
  TestSuite,
  createRemoteFixture,
  createLocalFixture,
  createDivergedFixture,
  commitFile,
  snapshotRepository,
  writeExecutable,
  revParse,
  git,
  expectCode,
  shellQuote,
} from "./git-test-helpers.js";

const suite = new TestSuite();
const test = suite.test.bind(suite);

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

await suite.runAll("git remote merge and fetch tests");
