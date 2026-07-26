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
  const hook = join(root, ".git", "hooks", "pre-commit");
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await writeFile(hook, `#!/bin/sh\nprintf bad > '${marker}'\nexit 1\n`);
  await chmod(hook, 0o755);
  const committed = await commitGit({
    workspaceRoot: root,
    message: "safe local commit",
    expectedStagedDiffSha256: status.stagedDiffSha256,
  });
  assert.match(committed.headSha, /^[0-9a-f]{40,64}$/);
  await assert.rejects(readFile(marker));

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
