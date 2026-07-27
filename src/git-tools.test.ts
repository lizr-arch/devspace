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
  await git(["config", "core.autocrlf", "input"]);
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

  // === M2: Safe Git attributes — built-in attributes should succeed ===

  // Test: * text=auto staging Markdown succeeds
  await writeFile(join(root, ".gitattributes"), "* text=auto\n");
  await writeFile(join(root, "README.md"), "# Hello\n");
  await stageGitPaths(root, ["README.md"]);
  const mdStatus = await inspectGitStatus(root);
  assert.ok(mdStatus.staged.includes("README.md"));
  await git(["restore", "--staged", "README.md"]);
  await rm(join(root, "README.md"));
  await rm(join(root, ".gitattributes"));

  // Test: *.py text eol=lf staging Python succeeds
  await writeFile(join(root, ".gitattributes"), "*.py text eol=lf\n");
  await writeFile(join(root, "script.py"), "print('hello')\n");
  await stageGitPaths(root, ["script.py"]);
  const pyStatus = await inspectGitStatus(root);
  assert.ok(pyStatus.staged.includes("script.py"));
  await git(["restore", "--staged", "script.py"]);
  await rm(join(root, "script.py"));
  await rm(join(root, ".gitattributes"));

  // Test: *.bat text eol=crlf staging BAT succeeds
  await writeFile(join(root, ".gitattributes"), "*.bat text eol=crlf\n");
  await writeFile(join(root, "build.bat"), "@echo off\n");
  await stageGitPaths(root, ["build.bat"]);
  const batStatus = await inspectGitStatus(root);
  assert.ok(batStatus.staged.includes("build.bat"));
  await git(["restore", "--staged", "build.bat"]);
  await rm(join(root, "build.bat"));
  await rm(join(root, ".gitattributes"));

  // Test: *.png binary staging PNG succeeds
  await writeFile(join(root, ".gitattributes"), "*.png binary\n");
  await writeFile(join(root, "image.png"), "fake PNG content");
  await stageGitPaths(root, ["image.png"]);
  const pngStatus = await inspectGitStatus(root);
  assert.ok(pngStatus.staged.includes("image.png"));
  await git(["restore", "--staged", "image.png"]);
  await rm(join(root, "image.png"));
  await rm(join(root, ".gitattributes"));

  // Test: -text attribute succeeds
  await writeFile(join(root, ".gitattributes"), "*.dat -text\n");
  await writeFile(join(root, "data.dat"), "binary stuff");
  await stageGitPaths(root, ["data.dat"]);
  const datStatus = await inspectGitStatus(root);
  assert.ok(datStatus.staged.includes("data.dat"));
  await git(["restore", "--staged", "data.dat"]);
  await rm(join(root, "data.dat"));
  await rm(join(root, ".gitattributes"));

  // Test: -diff and -merge attributes succeed
  await writeFile(join(root, ".gitattributes"), "*.gen -diff -merge\n");
  await writeFile(join(root, "output.gen"), "generated\n");
  await stageGitPaths(root, ["output.gen"]);
  const genStatus = await inspectGitStatus(root);
  assert.ok(genStatus.staged.includes("output.gen"));
  await git(["restore", "--staged", "output.gen"]);
  await rm(join(root, "output.gen"));
  await rm(join(root, ".gitattributes"));

  // Test: nested .gitattributes resolution
  await mkdir(join(root, "subdir"));
  await writeFile(join(root, "subdir", ".gitattributes"), "*.nested text=auto\n");
  await writeFile(join(root, "subdir", "file.nested"), "nested content\n");
  await stageGitPaths(root, ["subdir/file.nested"]);
  const nestedStatus = await inspectGitStatus(root);
  assert.ok(nestedStatus.staged.includes("subdir/file.nested"));
  await git(["restore", "--staged", "subdir/file.nested"]);
  await rm(join(root, "subdir", "file.nested"));
  await rm(join(root, "subdir", ".gitattributes"));
  await rm(join(root, "subdir"), { recursive: true });

  // Test: .git/info/attributes resolution
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "attributes"), "*.info text=auto\n");
  await writeFile(join(root, "notes.info"), "info content\n");
  await stageGitPaths(root, ["notes.info"]);
  const infoStatus = await inspectGitStatus(root);
  assert.ok(infoStatus.staged.includes("notes.info"));
  await git(["restore", "--staged", "notes.info"]);
  await rm(join(root, "notes.info"));
  await rm(join(root, ".git", "info", "attributes"));

  // === M2: Safe Git attributes — filter rejection tests ===

  // Test: filter=myfilter is rejected
  const m2FilterMarker = join(root, "m2-filter-ran");
  const m2Filter = join(root, "m2-filter");
  await writeFile(m2Filter, `#!/bin/sh\nprintf bad > '${m2FilterMarker}'\ncat\n`);
  await chmod(m2Filter, 0o755);
  await writeFile(join(root, ".gitattributes"), "*.filtered filter=m2test\n");
  await git(["config", "filter.m2test.clean", m2Filter]);
  await writeFile(join(root, "dangerous.filtered"), "filtered content\n");
  await assert.rejects(
    stageGitPaths(root, ["dangerous.filtered"]),
    /GIT_FILTER_REJECTED/,
  );
  await assert.rejects(readFile(m2FilterMarker));
  // Verify filter was NOT executed
  await git(["config", "--unset", "filter.m2test.clean"]);
  await rm(m2Filter);
  await rm(join(root, "dangerous.filtered"));
  await rm(join(root, ".gitattributes"));

  // Test: filter unset does not false-reject
  // Configure a filter but unset it via -filter attribute
  const unsetFilterMarker = join(root, "unset-filter-ran");
  const unsetFilter = join(root, "unset-filter");
  await writeFile(unsetFilter, `#!/bin/sh\nprintf bad > '${unsetFilterMarker}'\ncat\n`);
  await chmod(unsetFilter, 0o755);
  await git(["config", "filter.unsettest.clean", unsetFilter]);
  await writeFile(join(root, ".gitattributes"), "*.unset -filter\n");
  await writeFile(join(root, "normal.unset"), "safe content\n");
  await stageGitPaths(root, ["normal.unset"]);
  // Verify filter was NOT executed
  await assert.rejects(readFile(unsetFilterMarker));
  await git(["restore", "--staged", "normal.unset"]);
  await rm(join(root, "normal.unset"));
  await git(["config", "--unset", "filter.unsettest.clean"]);
  await rm(unsetFilter);
  await rm(join(root, ".gitattributes"));

  // Test: multi-path batch with one real filter fails closed
  const batchFilterMarker = join(root, "batch-filter-ran");
  const batchFilter = join(root, "batch-filter");
  await writeFile(batchFilter, `#!/bin/sh\nprintf bad > '${batchFilterMarker}'\ncat\n`);
  await chmod(batchFilter, 0o755);
  await writeFile(join(root, ".gitattributes"), "*.dangerous filter=batchtest\n");
  await git(["config", "filter.batchtest.clean", batchFilter]);
  await writeFile(join(root, "safe.txt"), "i am safe\n");
  await writeFile(join(root, "evil.dangerous"), "i am dangerous\n");
  await assert.rejects(
    stageGitPaths(root, ["safe.txt", "evil.dangerous"]),
    /GIT_FILTER_REJECTED/,
  );
  // Verify neither file was staged (fail closed)
  const batchStatus = await inspectGitStatus(root);
  assert.ok(!batchStatus.staged.includes("safe.txt"));
  assert.ok(!batchStatus.staged.includes("evil.dangerous"));
  // Verify filter was NOT executed
  await assert.rejects(readFile(batchFilterMarker));
  await git(["config", "--unset", "filter.batchtest.clean"]);
  await rm(batchFilter);
  await rm(join(root, "safe.txt"));
  await rm(join(root, "evil.dangerous"));
  await rm(join(root, ".gitattributes"));

  // Test: no clean/smudge execution during detection
  const detectionFilterMarker = join(root, "detection-filter-ran");
  const detectionFilter = join(root, "detection-filter");
  await writeFile(detectionFilter, `#!/bin/sh\nprintf bad > '${detectionFilterMarker}'\ncat\n`);
  await chmod(detectionFilter, 0o755);
  await writeFile(join(root, ".gitattributes"), "*.trigger filter=detectiontest\n");
  await git(["config", "filter.detectiontest.clean", detectionFilter]);
  await git(["config", "filter.detectiontest.smudge", detectionFilter]);
  await writeFile(join(root, "test.trigger"), "trigger content\n");
  await assert.rejects(
    stageGitPaths(root, ["test.trigger"]),
    /GIT_FILTER_REJECTED/,
  );
  // Verify clean/smudge were NOT executed
  await assert.rejects(readFile(detectionFilterMarker));
  await git(["config", "--unset", "filter.detectiontest.clean"]);
  await git(["config", "--unset", "filter.detectiontest.smudge"]);
  await rm(detectionFilter);
  await rm(join(root, "test.trigger"));
  await rm(join(root, ".gitattributes"));

  // Test: staged diff normal with built-in attributes
  await writeFile(join(root, ".gitattributes"), "*.rst text=auto\n");
  await writeFile(join(root, "docs.rst"), "Documentation\n");
  await stageGitPaths(root, ["docs.rst"]);
  const docStatus = await inspectGitStatus(root);
  assert.ok(docStatus.staged.includes("docs.rst"));
  const docDiff = await inspectGitDiff({
    workspaceRoot: root,
    scope: "staged",
    paths: ["docs.rst"],
  });
  assert.ok(docDiff.patch.includes("Documentation"));
  await git(["restore", "--staged", "docs.rst"]);
  await rm(join(root, "docs.rst"));
  await rm(join(root, ".gitattributes"));

  // Test: unstage normal with built-in attributes
  await writeFile(join(root, ".gitattributes"), "*.cfg text eol=lf\n");
  await writeFile(join(root, "app.cfg"), "key=value\n");
  const cfgStageStatus = await stageGitPaths(root, ["app.cfg"]);
  assert.ok(cfgStageStatus.staged.includes("app.cfg"));
  const cfgUnstageStatus = await unstageGitPaths(root, ["app.cfg"]);
  assert.ok(!cfgUnstageStatus.staged.includes("app.cfg"));
  await rm(join(root, "app.cfg"));
  await rm(join(root, ".gitattributes"));

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
