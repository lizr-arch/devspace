import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchGit, pushGit } from "./git-tools.js";
import {
  TestSuite,
  createRemoteFixture,
  commitFile,
  snapshotRepository,
  installRemoteHook,
  writeExecutable,
  revParse,
  git,
  configureIdentity,
  expectCode,
  shellQuote,
  delay,
  TEST_DESTINATION_BRANCH,
} from "./git-test-helpers.js";

const suite = new TestSuite();
const test = suite.test.bind(suite);

test("git_fetch and git_push reject an exact remote URL binding mismatch before remote I/O", async () => {
  const fixture = await createRemoteFixture("remote-url-binding");
  try {
    const trackingBefore = await revParse(
      fixture.client,
      `refs/remotes/origin/${TEST_DESTINATION_BRANCH}`,
    );
    const remoteSha = await commitFile(
      fixture.producer,
      "producer.txt",
      "remote update\n",
      "remote update",
    );
    await git(fixture.producer, ["push", "origin", `main:refs/heads/${TEST_DESTINATION_BRANCH}`]);
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
      await revParse(fixture.client, `refs/remotes/origin/${TEST_DESTINATION_BRANCH}`),
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        remote: "origin",
        destinationBranch: TEST_DESTINATION_BRANCH,
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
      await revParse(fixture.client, `refs/remotes/origin/${TEST_DESTINATION_BRANCH}`),
      trackingBefore,
      "URL mismatch must be rejected before push performs its internal fetch",
    );
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push performs an exact fast-forward push and verifies the remote", async () => {
  const fixture = await createRemoteFixture("push-ff");
  try {
    const remoteBefore = await revParse(
      fixture.client,
      `refs/remotes/origin/${TEST_DESTINATION_BRANCH}`,
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
      approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
      remote: "origin",
      sourceRef: "HEAD",
      destinationBranch: TEST_DESTINATION_BRANCH,
      expectedLocalSha: localSha,
      expectedRemoteSha: remoteBefore,
    });

    assert.equal(result.remoteShaBefore, remoteBefore);
    assert.equal(result.localSha, localSha);
    assert.equal(result.pushAttempted, true);
    assert.equal(result.pushSucceeded, true);
    assert.equal(result.remoteShaAfter, localSha);
    assert.equal(result.remoteContainsLocal, true);
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), localSha);
    assert.equal(
      await revParse(fixture.client, `refs/remotes/origin/${TEST_DESTINATION_BRANCH}`),
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
    const remoteBefore = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: localSha,
      }),
      "GIT_REMOTE_CHANGED",
    );
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteBefore);
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
    await git(fixture.producer, ["push", "origin", `main:refs/heads/${TEST_DESTINATION_BRANCH}`]);

    await expectCode(
      pushGit({
        workspaceRoot: fixture.client,
        approvedRemotes: ["origin"],
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_PUSH_NON_FAST_FORWARD",
    );
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push enforces approved remote and destination branch policy", async () => {
  const fixture = await createRemoteFixture("push-policy");
  try {
    const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
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
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_DESTINATION_BRANCH_NOT_APPROVED",
    );
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
  test(`git_push rejects a ${dirtyKind} workspace`, async () => {
    const fixture = await createRemoteFixture(`push-dirty-${dirtyKind}`);
    try {
      const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
          approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
          destinationBranch: TEST_DESTINATION_BRANCH,
          expectedLocalSha: localSha,
          expectedRemoteSha: remoteSha,
        }),
        "GIT_WORKSPACE_NOT_CLEAN",
      );
      assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("git_push rejects detached HEAD", async () => {
  const fixture = await createRemoteFixture("push-detached");
  try {
    const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_DETACHED_HEAD",
    );
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push surfaces remote hook rejection and disables local pre-push hooks", async () => {
  const fixture = await createRemoteFixture("push-hook-reject");
  try {
    const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
      }),
      "GIT_PUSH_REJECTED",
    );
    assert.equal(await readFile(remoteMarker, "utf8"), "ran");
    await assert.rejects(readFile(localMarker));
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push times out a delayed remote rejection without updating the remote", async () => {
  const fixture = await createRemoteFixture("push-timeout");
  try {
    const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
        timeoutMs: 100,
      }),
      "GIT_TIMEOUT",
    );
    await delay(1_200);
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("git_push kills a delayed accepting remote process group on timeout", async () => {
  const fixture = await createRemoteFixture("push-timeout-accept");
  try {
    const remoteSha = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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
        approvedDestinationBranches: [TEST_DESTINATION_BRANCH],
        destinationBranch: TEST_DESTINATION_BRANCH,
        expectedLocalSha: localSha,
        expectedRemoteSha: remoteSha,
        timeoutMs: 100,
      }),
      "GIT_TIMEOUT",
    );
    await delay(1_200);
    assert.equal(await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`), remoteSha);
  } finally {
    await fixture.cleanup();
  }
});

test("remote operations in linked worktrees are serialized by their common Git directory", async () => {
  const fixture = await createRemoteFixture("common-dir-mutex");
  try {
    const remoteBase = await revParse(fixture.bare, `refs/heads/${TEST_DESTINATION_BRANCH}`);
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

await suite.runAll("git remote push tools tests");
