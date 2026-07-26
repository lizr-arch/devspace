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
import {
  commitGit,
  inspectGitDiff,
  inspectGitStatus,
  manageGitBranch,
  stageGitPaths,
  unstageGitPaths,
} from "./git-tools.js";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-git-tools-"));
try {
  await git(["init"]);
  await git(["config", "user.email", "devspace@example.com"]);
  await git(["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "tracked.txt"), "one\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-m", "initial"]);
  assert.equal((await inspectGitStatus(root)).clean, true);

  await writeFile(join(root, "tracked.txt"), "two\n");
  const diff = await inspectGitDiff({ workspaceRoot: root });
  assert.match(diff.patch, /-one/);
  let status = await stageGitPaths(root, ["tracked.txt"]);
  const reviewedHash = status.stagedDiffSha256;
  await writeFile(join(root, "other.txt"), "other\n");
  status = await stageGitPaths(root, ["other.txt"]);
  await assert.rejects(
    commitGit({
      workspaceRoot: root,
      message: "stale",
      expectedStagedDiffSha256: reviewedHash,
    }),
    /GIT_STALE_INDEX/,
  );
  status = await unstageGitPaths(root, ["other.txt"]);

  const marker = join(root, "hook-ran");
  const postCommitMarker = join(root, "post-commit-hook-ran");
  const hook = join(root, ".git", "hooks", "pre-commit");
  const postCommitHook = join(root, ".git", "hooks", "post-commit");
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await writeFile(hook, `#!/bin/sh\nprintf bad > '${marker}'\nexit 1\n`);
  await writeFile(
    postCommitHook,
    `#!/bin/sh\nprintf bad > '${postCommitMarker}'\n`,
  );
  await chmod(hook, 0o755);
  await chmod(postCommitHook, 0o755);
  const committed = await commitGit({
    workspaceRoot: root,
    message: "safe local commit",
    expectedStagedDiffSha256: status.stagedDiffSha256,
  });
  assert.match(committed.headSha, /^[0-9a-f]{40,64}$/);
  await assert.rejects(readFile(marker));
  await assert.rejects(readFile(postCommitMarker));

  const configuredHooks = join(root, "configured-hooks");
  const configuredMarker = join(root, "configured-post-commit-ran");
  await mkdir(configuredHooks);
  await writeFile(
    join(configuredHooks, "post-commit"),
    `#!/bin/sh\nprintf bad > '${configuredMarker}'\n`,
  );
  await chmod(join(configuredHooks, "post-commit"), 0o755);
  await git(["config", "core.hooksPath", configuredHooks]);
  await writeFile(join(root, "tracked.txt"), "three\n");
  const configuredStatus = await stageGitPaths(root, ["tracked.txt"]);
  await commitGit({
    workspaceRoot: root,
    message: "configured hooks remain disabled",
    expectedStagedDiffSha256: configuredStatus.stagedDiffSha256,
  });
  await assert.rejects(readFile(configuredMarker));
  await git(["config", "--unset", "core.hooksPath"]);
  await rm(configuredHooks, { recursive: true });

  const fsmonitorMarker = join(root, "fsmonitor-ran");
  const fsmonitor = join(root, "fsmonitor");
  await writeFile(
    fsmonitor,
    `#!/bin/sh\nprintf bad > '${fsmonitorMarker}'\nexit 1\n`,
  );
  await chmod(fsmonitor, 0o755);
  await git(["config", "core.fsmonitor", fsmonitor]);
  await inspectGitStatus(root);
  await assert.rejects(readFile(fsmonitorMarker));
  await git(["config", "--unset", "core.fsmonitor"]);
  await rm(fsmonitor);

  const filterMarker = join(root, "filter-ran");
  const filter = join(root, "filter");
  await writeFile(filter, `#!/bin/sh\nprintf bad > '${filterMarker}'\ncat\n`);
  await chmod(filter, 0o755);
  await writeFile(join(root, ".gitattributes"), "tracked.txt filter=unsafe\n");
  await git(["config", "filter.unsafe.clean", filter]);
  await writeFile(join(root, "tracked.txt"), "filter attempt\n");
  await assert.rejects(
    stageGitPaths(root, ["tracked.txt"]),
    /GIT_FILTER_REJECTED/,
  );
  await assert.rejects(readFile(filterMarker));
  await git(["config", "--unset", "filter.unsafe.clean"]);
  await rm(filter);
  await rm(join(root, ".gitattributes"));
  await git(["restore", "tracked.txt"]);

  const branches = await manageGitBranch({
    workspaceRoot: root,
    action: "create",
    name: "local-only",
  });
  assert.ok(branches.branches.includes("local-only"));
  await rm(join(root, "other.txt"));
  await manageGitBranch({
    workspaceRoot: root,
    action: "switch",
    name: "local-only",
  });
  assert.equal((await inspectGitStatus(root)).branch, "local-only");
  console.log("git tool tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(args: string[]): Promise<void> {
  await run("git", args, { cwd: root });
}
